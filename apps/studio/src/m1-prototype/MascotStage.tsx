/**
 * PROTOTYPE — Rusty Rover, the World Forge mascot, in 3D.
 *
 * He is the whole builder now: the flat pixel sprite is retired from variant B
 * and Rusty is mounted once, above the stage, so he survives every screen
 * change. He poofs in on his first appearance, waves once, climbs onto his
 * cream block and settles into the feet-dangling idle — and from then on every
 * decision the user makes sends him down for a block from the pile beside him,
 * which he carries back and hands to the world.
 *
 * On the question screens he does not stand beside the work — he lives inside
 * the build log's little capture window, scaled to the diorama in it, and the
 * block he carries flies out of his hands into the grid and becomes the cube
 * that decision bought. Everything that makes that work is measured off the
 * frame at runtime (see measureDock), because the sidebar's size is the
 * viewport's business, not this file's.
 *
 * Nothing here ever gates the UI: a decision applies the instant it is clicked
 * and only queues a performance. A decision that lands mid-performance waits
 * for the current one to finish, and a backlog collapses to a single run. The
 * diorama, though, does wait for him: the block it gains is the block he put
 * down.
 *
 * Everything comes from public/m1-prototype/rusty-rover.integration.json. The
 * clips already butt together frame-perfectly, so the sequencer never
 * crossfades — it stops one action and starts the next on the same tick.
 */
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, useGLTF } from "@react-three/drei";
import * as THREE from "three";

const mascotModelUrl = "/m1-prototype/rusty-rover.glb";

/* The contract is written in Blender metres; three.js gets (x, y, z) →
   (x, z, -y). Park him at `stand` while Poof and Wave play and at `seat` for
   everything after — ClimbUp's own root track carries him between the two. */
const mascotSeatAnchor: [number, number, number] = [0, 0, 0];
const mascotStandAnchor: [number, number, number] = [0, 0, 0.58];

/* seatBlock: 0.9731 × 0.700 × 0.660 with its top at 0.66 and its centre at
   (0, 0.2962) on the floor plane. */
const plinthSize: [number, number, number] = [0.9731, 0.66, 0.7];
const plinthCentre: [number, number, number] = [0, 0.33, -0.2962];

/* The block, the pile and the crate under it are all the app's: the clips only
   promise that the next block is sitting at `pickup` before the attach marker
   and that it is left at `placement` after the detach one. */
const blockSize = 0.26;
const blockPickup: [number, number, number] = [1.0037, 0.34, 1.2016];
const blockPickupYaw = THREE.MathUtils.degToRad(52);
/** …and where CarryPlace leaves it: 0.94 m straight in front of the seat. */
const blockPlacement: [number, number, number] = [0, 0.34, 0.94];
/** restingSurfaceZ 0.21 — the crate that presents the next block at hand height. */
const crateSize: [number, number, number] = [0.34, 0.21, 0.34];
const attachSeconds = 2.5; // FetchBlock frame 76
const detachSeconds = 3.3; // CarryPlace frame 100

type PileSlot = { position: [number, number, number]; yaw: number };

/**
 * Slot 0 is the crate — the block he actually takes. The rest is the heap,
 * ordered so that the block that leaves is always the outermost one: when a
 * decision empties slot 0 the highest occupied slot slides in to refill it,
 * which keeps the two stacked blocks (5, 6) resting on the two floor blocks
 * (1, 2) for as long as both are there.
 */
const pileSlots: PileSlot[] = [
  { position: blockPickup, yaw: 52 },
  { position: [1.36, 0.13, 1.02], yaw: -22 },
  { position: [1.3, 0.13, 1.42], yaw: 14 },
  { position: [1.42, 0.13, 0.7], yaw: 30 },
  { position: [0.85, 0.13, 1.58], yaw: -8 },
  { position: [1.36, 0.39, 1.02], yaw: 8 },
  { position: [1.3, 0.39, 1.42], yaw: -16 },
];

/* Close enough to the CSS diorama's rotateX(58deg) rotateZ(45deg) to belong in
   the same room, but turned back toward the reader so the wave lands. The
   frame is wide enough — and pushed along the camera's right by 0.6 m — to hold
   the pile as well as the plinth, so a fetch never walks out of shot. */
const mascotView = {
  azimuth: -30,
  elevation: 20,
  target: [0.52, 0.86, 0.4] as [number, number, number],
  viewHeight: 2.5,
  viewWidth: 3.1,
};

/* ---------- living inside the build log's capture window ----------
   On the question screens he moves into the little framed diorama in the
   sidebar, so his performance and the world growing are one picture. That only
   works if he is drawn in the *same* projection as the CSS diorama: its
   rotateX(58deg) is a camera 32° above the floor, its rotateZ(45deg) is an
   azimuth of 45°. Under that view a cube of edge s is exactly 1.414·s wide on
   screen — the same rule the CSS cubes obey — so one number (pixels per metre)
   ties his blocks to theirs. */
const frameView = { azimuth: 45, elevation: 32 };

/** Which kind of frame he has been handed, written on the frame itself. */
type DockMode = "capture" | "panel" | "finale";

/** How big his blocks are next to the diorama's, per frame. 1 would be honest
 *  — and would make him three diorama-blocks tall, which owns the frame — so
 *  he is capped well short of it. The gap is closed by the block itself: it
 *  grows to the diorama's own size on the way in, so the two only ever have to
 *  agree at the moment they become one. */
const frameFit: Record<DockMode, { min: number; max: number }> = {
  capture: { min: 0.38, max: 0.62 },
  panel: { min: 0.4, max: 0.9 },
  finale: { min: 0.22, max: 0.36 },
};

function frameBasis(azimuth: number, elevation: number) {
  const theta = THREE.MathUtils.degToRad(azimuth);
  const phi = THREE.MathUtils.degToRad(elevation);
  return {
    right: new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta)),
    up: new THREE.Vector3(
      -Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
      -Math.sin(phi) * Math.cos(theta),
    ),
  };
}

/* ---------- staging: turning the rig so the walk points at the world ----------
   Every clip's root motion is a fixed offset from the seat: he fetches from
   `blockPickup` and puts the block down at `blockPlacement`, and no amount of
   re-timing will move either. What *can* move is which way the whole workshop
   is pointing. At a yaw of 0 the walk ends in front of his own plinth with the
   world behind him — the block then has to fly the length of the frame. Turned
   a quarter turn the same root motion carries him up-screen instead, and the
   spot he sets the block down on is the near edge of the grid, a hop from the
   tile it belongs to. -90 is also the only quarter-turn that keeps his stool
   and crate off-square to the 45° camera, so they read as boxes rather than
   flat grey slabs. He works in profile, watching the world he fills in. */
const frameStageYaw = -90;

/** The workshop's screen-space geometry for a given yaw, in metres: x runs
 *  right, y runs *down*, both measured from the seat. Orthographic projection
 *  is linear, so these numbers scale straight to pixels by `zoom`. */
type StageGeometry = {
  /** radians, for the rig group itself. */
  yaw: number;
  /** where CarryPlace leaves the block. */
  place: { x: number; y: number };
  /** the whole workshop, for keeping it inside the canvas. */
  span: { x0: number; x1: number; y0: number; y1: number };
  /** the parts that have to stay clear of the diorama's own silhouette. */
  clear: Array<{ x: number; y: number }>;
};

const stageGeometryCache = new Map<number, StageGeometry>();

function stageGeometry(yawDeg: number): StageGeometry {
  const cached = stageGeometryCache.get(yawDeg);
  if (cached) return cached;
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const { right, up } = frameBasis(frameView.azimuth, frameView.elevation);
  const flat = (x: number, y: number, z: number) => {
    const point = new THREE.Vector3(x * cos + z * sin, y, z * cos - x * sin);
    return { x: point.dot(right), y: -point.dot(up) };
  };
  const boxPoints = (
    centre: [number, number, number],
    half: [number, number, number],
  ) => {
    const points: Array<{ x: number; y: number }> = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          points.push(
            flat(
              centre[0] + sx * half[0],
              centre[1] + sy * half[1],
              centre[2] + sz * half[2],
            ),
          );
        }
      }
    }
    return points;
  };

  /* A five-point stand-in for his seated silhouette. The antenna is left out
     on purpose: 18 cm of aerial crossing the world's front corner reads as
     depth, and paying for it would stand the whole workshop a head lower. */
  const body = [
    flat(0, 1.56, 0.04),
    flat(0.32, 1.35, 0),
    flat(-0.32, 1.35, 0),
    flat(0, 1.12, 0.3),
    flat(0, 0.6, 0.5),
  ];
  const plinth = boxPoints(plinthCentre, [
    plinthSize[0] / 2,
    plinthSize[1] / 2,
    plinthSize[2] / 2,
  ]);
  /* A block turned on its own yaw reaches √2/2 of its edge sideways. */
  const heap = pileSlots.flatMap((slot) =>
    boxPoints(slot.position, [
      blockSize * 0.71,
      blockSize / 2,
      blockSize * 0.71,
    ]),
  );
  const clear = [...body, ...plinth, ...heap];
  const outline = [...clear, flat(0, 1.72, 0), flat(0, 0.1, 0.55)];
  const geometry: StageGeometry = {
    yaw,
    place: flat(...blockPlacement),
    span: {
      x0: Math.min(...outline.map((point) => point.x)),
      x1: Math.max(...outline.map((point) => point.x)),
      y0: Math.min(...outline.map((point) => point.y)),
      y1: Math.max(...outline.map((point) => point.y)),
    },
    clear,
  };
  stageGeometryCache.set(yawDeg, geometry);
  return geometry;
}

type MascotDock = {
  mode: DockMode;
  left: number;
  top: number;
  width: number;
  height: number;
  /** pixels per metre — the whole scale contract with the diorama. */
  zoom: number;
  target: [number, number, number];
  /** the diorama's own block edge in px, so a placed block can match it. */
  unit: number;
  /** how far the rig is turned inside this frame, in radians. */
  yaw: number;
};

/**
 * Measure the capture window and work out where he stands in it.
 *
 * The canvas covers the *whole* frame (it is transparent, and the diorama
 * shows straight through it) rather than just his corner — a block has to be
 * able to fly out of his hands and into the grid without being clipped by the
 * edge of his own canvas.
 */
function measureDock(host: HTMLDivElement): MascotDock | null {
  const parent = host.offsetParent as HTMLElement | null;
  if (!parent) return null;
  const frame = parent.querySelector<HTMLElement>("[data-mascot-frame]");
  const world = frame?.querySelector<HTMLElement>(".vx-world");
  if (!frame || !world) return null;
  const mode = (frame.dataset.mascotFrame ?? "capture") as DockMode;
  const unit = Number.parseFloat(
    getComputedStyle(world).getPropertyValue("--u"),
  );
  /* Laid-out geometry, not painted geometry: the stage plays a 0.5 s entrance
     transform on every screen change, and a dock measured off a rectangle that
     is still sliding would land him next to the frame and then have to correct
     itself. offsetLeft walks the same boxes his own `left` resolves against. */
  const box = {
    left: 0,
    top: 0,
    width: frame.offsetWidth,
    height: frame.offsetHeight,
  };
  for (
    let node: HTMLElement | null = frame;
    node && node !== parent;
    node = node.offsetParent as HTMLElement | null
  ) {
    box.left += node.offsetLeft;
    box.top += node.offsetTop;
  }
  if (
    !Number.isFinite(unit) ||
    unit <= 0 ||
    box.width < 40 ||
    box.height < 40
  ) {
    return null;
  }

  /* The near corner of the plate: the front of the world, the lowest thing in
     the frame, and the only edge of the grid he can reach without standing in
     it. Read as a fraction of the *painted* frame so that the stage's 0.5 s
     entrance transform divides back out of a geometry that has to resolve
     against the laid-out boxes his own `left` does. */
  const painted = frame.getBoundingClientRect();
  let front: DOMRect | null = null;
  for (const tile of frame.querySelectorAll(".vx-plate i")) {
    const rect = tile.getBoundingClientRect();
    if (!front || rect.bottom > front.bottom) front = rect;
  }
  if (!front || !painted.width || !painted.height) return null;
  const plate = {
    x:
      ((front.left + front.right) / 2 - painted.left) *
      (box.width / painted.width),
    y: (front.bottom - painted.top) * (box.height / painted.height),
    /* half the diamond on screen: five tiles at (px − py)·cos45. */
    half: unit * 3.5355,
  };

  const stage = stageGeometry(frameStageYaw);
  const fit = frameFit[mode];
  const pad = Math.max(8, unit * 0.2);
  let zoom: number;
  let seatX: number;
  let seatY: number;

  if (mode === "panel") {
    /* The style panel is a shelf, not a stage: the styled world sits in the
       middle of it and he takes the free paper at its right-hand end, sitting
       in profile looking back at it. Nothing is ever built here, so all the
       staging has to do is fit. */
    const strip = box.width - pad - (plate.x + plate.half + unit * 0.35);
    zoom = Math.min(
      (fit.max * unit) / blockSize,
      strip / (stage.span.x1 - stage.span.x0),
      (box.height - pad * 1.2) / (stage.span.y1 - stage.span.y0),
    );
    seatX = box.width - pad - stage.span.x1 * zoom;
    seatY = box.height - pad * 0.4 - stage.span.y1 * zoom;
  } else {
    /* Aim the spot the clips put the block down on at the world's near corner,
       then let his own silhouette say how far short of it he has to stand. The
       diorama's front edges fall away at cos45·cos58 per pixel across, so the
       whole clearance test is one line — and because the walk now runs *along*
       that line, standing further down it costs nothing. */
    zoom = Math.max(
      (fit.min * unit) / blockSize,
      Math.min(
        (fit.max * unit) / blockSize,
        (plate.x - pad) / Math.max(stage.place.x - stage.span.x0, 0.01),
        (box.width - pad - plate.x) /
          Math.max(stage.span.x1 - stage.place.x, 0.01),
      ),
    );
    seatX = plate.x - stage.place.x * zoom;
    const clearance = unit * 0.16;
    seatY = 0;
    for (const point of stage.clear) {
      const away = Math.abs(seatX + point.x * zoom - plate.x);
      if (away >= plate.half) continue;
      seatY = Math.max(
        seatY,
        plate.y - away * 0.5299 + clearance - point.y * zoom,
      );
    }
    seatY = Math.min(seatY, box.height - pad - stage.span.y1 * zoom);
  }
  seatX = Math.min(
    Math.max(seatX, pad - stage.span.x0 * zoom),
    box.width - pad - stage.span.x1 * zoom,
  );

  /* Orthographic projection is linear, so the camera target that puts the seat
     on a given pixel can be written down rather than solved:
     screen(P) = ((P - target)·right, -(P - target)·up) · zoom, and the seat is
     the rig's own origin. */
  const { right, up } = frameBasis(frameView.azimuth, frameView.elevation);
  const target = new THREE.Vector3()
    .addScaledVector(right, -(seatX - box.width / 2) / zoom)
    .addScaledVector(up, (seatY - box.height / 2) / zoom);

  return {
    mode,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    zoom,
    target: [target.x, target.y, target.z],
    unit,
    yaw: stage.yaw,
  };
}

type SnapTarget = {
  x: number;
  y: number;
  scale: number;
  /** the colour of the cube it is about to become. */
  tint: string | null;
};

type MascotClip =
  | "Poof"
  | "Wave"
  | "ClimbUp"
  | "DangleIdle"
  | "HopDown"
  | "FetchBlock"
  | "CarryPlace";

type MascotBeat = {
  clip: MascotClip;
  anchor: [number, number, number];
  loop: THREE.AnimationActionLoopStyles;
  repetitions: number;
};

const dangleBeat: MascotBeat = {
  clip: "DangleIdle",
  anchor: mascotSeatAnchor,
  loop: THREE.LoopRepeat,
  repetitions: Infinity,
};

/** The contract's intro, with a single wave: three rounds read like a loop
 *  rather than a hello. */
const mascotIntro: MascotBeat[] = [
  {
    clip: "Poof",
    anchor: mascotStandAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  {
    clip: "Wave",
    anchor: mascotStandAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  {
    clip: "ClimbUp",
    anchor: mascotSeatAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  dangleBeat,
];

/** The contract's perDecision order — 11.0 s from the stool and back. */
const mascotDecision: MascotBeat[] = [
  {
    clip: "HopDown",
    anchor: mascotSeatAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  {
    clip: "FetchBlock",
    anchor: mascotSeatAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  {
    clip: "CarryPlace",
    anchor: mascotSeatAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  {
    clip: "ClimbUp",
    anchor: mascotSeatAnchor,
    loop: THREE.LoopOnce,
    repetitions: 1,
  },
  dangleBeat,
];

/** The per-image review screens take him off the page altogether, so the one
 *  fact that has to outlive the canvas lives out here: he poofs into the world
 *  once and after that always comes back already sitting on his block. */
let mascotArrived = false;

function mascotPrefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Orthographic framing, recomputed whenever the canvas is resized: the
 * diorama next door is isometric, so the mascot gets the same flat projection
 * rather than a lens of his own.
 */
function MascotCamera({
  azimuth,
  elevation,
  target,
  viewHeight,
  viewWidth,
  zoom,
}: {
  azimuth: number;
  elevation: number;
  target: [number, number, number];
  viewHeight: number;
  viewWidth: number;
  /** pixels per metre. Given, the frame stops being a fit and becomes a
   *  contract with the diorama it is standing in. */
  zoom?: number;
}) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  useLayoutEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    const phi = THREE.MathUtils.degToRad(elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    const radius = 14;
    camera.position.set(
      target[0] + radius * Math.cos(phi) * Math.sin(theta),
      target[1] + radius * Math.sin(phi),
      target[2] + radius * Math.cos(phi) * Math.cos(theta),
    );
    camera.lookAt(target[0], target[1], target[2]);
    camera.near = 0.1;
    camera.far = 40;
    camera.zoom =
      zoom ?? Math.min(size.height / viewHeight, size.width / viewWidth);
    camera.updateProjectionMatrix();
  }, [azimuth, camera, elevation, size, target, viewHeight, viewWidth, zoom]);

  return null;
}

/** A cream box with ink edges — the diorama's language, in three dimensions. */
function MascotBox({
  position,
  size,
  yaw = 0,
}: {
  position: [number, number, number];
  size: [number, number, number];
  yaw?: number;
}) {
  const geometry = useMemo(() => new THREE.BoxGeometry(...size), [size]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  useEffect(
    () => () => {
      geometry.dispose();
      edges.dispose();
    },
    [edges, geometry],
  );

  return (
    <group position={position} rotation={[0, yaw, 0]}>
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#cdc7b4" metalness={0} roughness={0.95} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#16161d" opacity={0.5} transparent />
      </lineSegments>
    </group>
  );
}

type BlockTween = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromQuaternion: THREE.Quaternion;
  toQuaternion: THREE.Quaternion;
  fromScale: number;
  toScale: number;
  arc: number;
  elapsed: number;
  duration: number;
  /** the colour it turns into on the way, when it is becoming a tinted cube. */
  fromTint?: THREE.Color;
  toTint?: THREE.Color;
  onDone?: () => void;
};

const blockColour = "#d6d0bd";

/** The finale prop, in the same units as a block so that the one flight
 *  mechanic sizes it: a 1.15-block pole with a 0.55 × 0.36 pennant, which is
 *  the CSS flag on the tower measured in diorama units. */
const flagSize = {
  pole: blockSize * 1.15,
  post: blockSize * 0.085,
  banner: [blockSize * 0.55, blockSize * 0.36] as const,
};

/** …but a block that size is a coin in his hands on the finale, where he is
 *  drawn at a third of the finished world's scale. So he carries the flag at
 *  the size a flag wants to be — a pole a metre over his fist, pennant clear
 *  of his own head — and it settles to the diorama's own on the way up, which
 *  is the block's own trick played backwards. */
const flagCarryScale = 3.5;

type PileBlock = {
  group: THREE.Group;
  faces: THREE.MeshStandardMaterial;
  edges: THREE.LineBasicMaterial;
  /** anything else that has to fade out with it — the flag's pole. */
  extra: THREE.Material[];
  /** slot index, or -1 while he is carrying it, or -2 once it is spent. */
  slot: number;
  tween: BlockTween | null;
  /** 0 → 1 as a placed block dissolves into the diorama; -1 when idle. */
  absorb: number;
  /** true once it has flown into the grid: it dissolves where it landed, at
   *  the size it landed, instead of drifting up off his hands. */
  snapped: boolean;
  /** true when the pile is down to its last block and this one has to come back. */
  restock: boolean;
};

/**
 * The one prop that is not a block: the flag he plants on the finished world.
 *
 * It is built to the same contract as a block — his claws close on the origin,
 * the same place they close on a block — but a flag is held by the foot of its
 * pole rather than round its middle, so the whole prop stands *on* that origin
 * and the summit it flies to is aimed at directly. The pennant is turned 45°
 * in its own right: the rig's
 * yaw is undone on the way in, so that lands it square to the diorama's camera
 * and reaching the same way as the CSS flag it hands over to.
 */
function makeFlagProp(): PileBlock {
  const group = new THREE.Group();
  const banner = new THREE.MeshStandardMaterial({
    color: "#ff7396",
    metalness: 0,
    roughness: 0.9,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const post = new THREE.MeshStandardMaterial({
    color: "#16161d",
    metalness: 0,
    roughness: 0.85,
    transparent: true,
  });
  const outline = new THREE.LineBasicMaterial({
    color: "#16161d",
    opacity: 0.85,
    transparent: true,
  });
  const poleGeometry = new THREE.BoxGeometry(
    flagSize.post,
    flagSize.pole,
    flagSize.post,
  );
  const bannerGeometry = new THREE.BoxGeometry(
    flagSize.banner[0],
    flagSize.banner[1],
    flagSize.post * 0.4,
  );
  const base = 0;
  const swing = new THREE.Group();
  swing.rotation.y = Math.PI / 4;
  const pole = new THREE.Mesh(poleGeometry, post);
  pole.position.y = base + flagSize.pole / 2;
  swing.add(pole);
  const cloth = new THREE.Mesh(bannerGeometry, banner);
  cloth.position.set(
    flagSize.banner[0] / 2,
    base + flagSize.pole - flagSize.banner[1] / 2 - flagSize.post,
    0,
  );
  swing.add(cloth);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(bannerGeometry),
    outline,
  );
  edges.position.copy(cloth.position);
  swing.add(edges);
  group.add(swing);
  group.visible = false;
  return {
    group,
    faces: banner,
    edges: outline,
    extra: [post],
    slot: -2,
    tween: null,
    absorb: -1,
    snapped: false,
    restock: false,
  };
}

function MascotRover({
  flag,
  onClip,
  onPile,
  onPlace,
  pending,
  snapTarget,
  startDelay,
  still,
  yaw,
}: {
  /** true on the completion screen, where the thing he carries is the flag. */
  flag: boolean;
  onClip: (clip: MascotClip) => void;
  /** How many blocks are still in the heap — mirrored onto the dock for tests. */
  onPile: (left: number) => void;
  onPlace: () => void;
  pending: { current: number };
  /** Where in the canvas the block he is putting down belongs, asked for at
   *  the detach frame. null on the screens where he is not standing in a
   *  diorama and the block simply dissolves in his hands. */
  snapTarget: () => SnapTarget | null;
  startDelay: number;
  /** Shelves he is only parked on: he spends the decision without walking, the
   *  way reduced motion does, so a trip can never wander across the panel he
   *  is sitting at the end of. */
  still: boolean;
  /** How far the whole workshop is turned inside the frame he is docked in. */
  yaw: number;
}) {
  const { animations, scene } = useGLTF(mascotModelUrl, false, false);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const root = useRef<THREE.Group>(null);
  const pileRoot = useRef<THREE.Group>(null);
  /* Reduced motion keeps only the last beat: he is simply already sitting on
     his block, breathing. No poof, no climb, no opening pause — and decisions
     move the pile without sending him anywhere. */
  const reduced = useMemo(mascotPrefersReducedMotion, []);
  /* The image-review screens unmount him entirely, so the intro has to be
     remembered somewhere that outlives this component: he only ever poofs into
     the world once, and comes back already sitting on his block. */
  const arrived = useRef(mascotArrived);
  const pause = reduced || arrived.current ? 0 : startDelay;
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const table = new Map<MascotClip, THREE.AnimationAction>();
    for (const beat of [...mascotIntro, ...mascotDecision]) {
      if (table.has(beat.clip)) continue;
      const clip = THREE.AnimationClip.findByName(animations, beat.clip);
      if (clip) table.set(beat.clip, mixer.clipAction(clip));
    }
    return table;
  }, [animations, mixer]);
  const carryNode = useMemo(
    () => scene.getObjectByName("RightHand") ?? null,
    [scene],
  );

  const pile = useMemo(() => {
    const geometry = new THREE.BoxGeometry(blockSize, blockSize, blockSize);
    const edges = new THREE.EdgesGeometry(geometry);
    const items: PileBlock[] = pileSlots.map((slot, index) => {
      const faces = new THREE.MeshStandardMaterial({
        color: blockColour,
        metalness: 0,
        roughness: 0.94,
        transparent: true,
      });
      const lines = new THREE.LineBasicMaterial({
        color: "#16161d",
        opacity: 0.45,
        transparent: true,
      });
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geometry, faces));
      group.add(new THREE.LineSegments(edges, lines));
      group.position.set(...slot.position);
      group.rotation.set(0, THREE.MathUtils.degToRad(slot.yaw), 0);
      return {
        group,
        faces,
        edges: lines,
        extra: [],
        slot: index,
        tween: null,
        absorb: -1,
        snapped: false,
        restock: false,
      } satisfies PileBlock;
    });
    items.push(makeFlagProp());
    return { items, geometry, edges };
  }, []);
  const blocks = pile.items;
  /* Last in the list, never in a slot: the flag only exists on the finale. */
  const flagProp = blocks[blocks.length - 1]!;

  /* The blocks are added by hand rather than rendered: a carried one is
     re-parented onto a bone mid-clip, and React must not be holding an opinion
     about where it lives. */
  useLayoutEffect(() => {
    const parent = pileRoot.current;
    if (!parent) return;
    for (const block of blocks) parent.add(block.group);
    return () => {
      for (const block of blocks) block.group.removeFromParent();
    };
  }, [blocks]);

  useEffect(
    () => () => {
      for (const block of pile.items) {
        block.faces.dispose();
        block.edges.dispose();
        for (const material of block.extra) material.dispose();
      }
      pile.geometry.dispose();
      pile.edges.dispose();
    },
    [pile],
  );

  const plan = useRef<MascotBeat[]>(
    reduced || arrived.current ? [dangleBeat] : mascotIntro,
  );
  const beat = useRef(0);
  const advance = useRef(false);
  const waited = useRef(0);
  const started = useRef(false);
  const carried = useRef<PileBlock | null>(null);
  const report = useRef(onClip);
  report.current = onClip;
  const reportPile = useRef(onPile);
  reportPile.current = onPile;
  const pileSeen = useRef(-1);
  const placed = useRef(onPlace);
  placed.current = onPlace;
  const snapTo = useRef(snapTarget);
  snapTo.current = snapTarget;
  const carryFlag = useRef(flag);
  carryFlag.current = flag;
  const spin = useRef(yaw);
  spin.current = yaw;
  const parked = useRef(still);
  parked.current = still;

  const play = useCallback(
    (index: number) => {
      const next = plan.current[index];
      const action = next && actions.get(next.clip);
      if (!next || !action) return;
      mixer.stopAllAction();
      root.current?.position.set(...next.anchor);
      action.reset();
      action.clampWhenFinished = true;
      action.setLoop(next.loop, next.repetitions);
      action.play();
      /* Snap the skeleton onto frame 0 before this frame is drawn, so he is
         never posted in the bind pose for a tick. */
      mixer.update(0);
      if (root.current) root.current.visible = true;
      if (next.clip === "DangleIdle") {
        arrived.current = true;
        mascotArrived = true;
      }
      report.current(next.clip);
    },
    [actions, mixer],
  );

  useEffect(() => {
    const onFinished = () => {
      advance.current = true;
    };
    mixer.addEventListener("finished", onFinished);
    return () => {
      mixer.removeEventListener("finished", onFinished);
      mixer.stopAllAction();
    };
  }, [mixer]);

  /** Send the outermost block of the heap sliding into the empty crate slot. */
  const restock = useCallback(() => {
    let next: PileBlock | null = null;
    for (const block of blocks) {
      if (block.slot > 0 && (!next || block.slot > next.slot)) next = block;
    }
    if (!next) {
      /* Nothing left to promote — the block he just spent comes back once it
         has dissolved, so the crate is never empty when the user acts again. */
      if (carried.current) carried.current.restock = true;
      return;
    }
    next.slot = 0;
    next.tween = {
      from: next.group.position.clone(),
      to: new THREE.Vector3(...pileSlots[0]!.position),
      fromQuaternion: next.group.quaternion.clone(),
      toQuaternion: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, blockPickupYaw, 0),
      ),
      fromScale: 1,
      toScale: 1,
      arc: 0.16,
      elapsed: 0,
      duration: 0.75,
    };
  }, [blocks]);

  const takeBlock = useCallback(() => {
    /* On the finale the crate presents the flag instead: the clip only
       promises that *something* is sitting at `pickup` when the claws close. */
    const block = carryFlag.current
      ? flagProp
      : blocks.find((item) => item.slot === 0);
    if (!block || !carryNode || !pileRoot.current) return;
    block.tween = null;
    block.group.visible = true;
    block.group.scale.setScalar(carryFlag.current ? flagCarryScale : 1);
    block.group.position.set(...blockPickup);
    block.group.rotation.set(0, blockPickupYaw, 0);
    pileRoot.current.updateMatrixWorld(true);
    carryNode.updateWorldMatrix(true, false);
    /* attach(), not add(): the claws are already closed around the block's
       pickup pose on this exact frame, so keeping its world transform is what
       puts it in his hands rather than through them. */
    carryNode.attach(block.group);
    block.slot = -1;
    carried.current = block;
  }, [blocks, carryNode, flagProp]);

  /** The pixel the diorama is expecting the block at, as a world point about a
   *  metre in front of the workshop — orthographic, so the depth only decides
   *  what it flies over, never how big it looks. */
  const canvasPoint = useCallback(
    (x: number, y: number) => {
      const point = new THREE.Vector3(
        (x / size.width) * 2 - 1,
        -((y / size.height) * 2 - 1),
        -1,
      ).unproject(camera);
      return point.addScaledVector(
        camera.getWorldDirection(new THREE.Vector3()),
        13,
      );
    },
    [camera, size],
  );

  const releaseBlock = useCallback(() => {
    const block = carried.current;
    const parent = pileRoot.current;
    if (!block || !parent) return;
    parent.attach(block.group);
    block.slot = -2;
    if (!carryFlag.current) restock();
    carried.current = null;

    const snap = snapTo.current?.();
    if (!snap) {
      block.snapped = false;
      block.absorb = 0;
      placed.current();
      return;
    }
    /* Into the grid: he sets the block down at the edge of the world and it
       carries on without him, growing to the diorama's own block size on the
       way so that the thing that arrives *is* one of its cubes. The diorama is
       only told to grow when it lands. The flight is worked out in world space
       and then pulled back into the rig's, because the rig is turned to face
       the diorama and the cube it is becoming is not. */
    parent.updateWorldMatrix(true, false);
    const from = block.group.position.clone();
    const to = parent.worldToLocal(canvasPoint(snap.x, snap.y));
    block.tween = {
      from,
      to,
      fromQuaternion: block.group.quaternion.clone(),
      toQuaternion: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, -spin.current, 0),
      ),
      fromScale: block.group.scale.x,
      toScale: snap.scale,
      /* A hop over the world's edge, not a lob across the room: the arc grows
         with the distance so a short snap stays flat and the flag's climb to
         the summit still leaves the ground. */
      arc: Math.min(0.9, Math.max(0.12, from.distanceTo(to) * 0.16)),
      elapsed: 0,
      duration: 0.6,
      ...(snap.tint
        ? {
            fromTint: new THREE.Color(blockColour),
            toTint: new THREE.Color(snap.tint),
          }
        : null),
      onDone: () => {
        block.snapped = true;
        block.absorb = 0;
        placed.current();
      },
    };
  }, [canvasPoint, restock]);

  /** Reduced motion: no trip, but the pile still spends a block per decision. */
  const spendQuietly = useCallback(() => {
    carried.current = null;
    if (carryFlag.current) {
      placed.current();
      return;
    }
    const block = blocks.find((item) => item.slot === 0);
    if (!block) return;
    block.slot = -2;
    block.group.visible = false;
    restock();
    placed.current();
  }, [blocks, restock]);

  useFrame((_state, delta) => {
    const step = Math.min(delta, 0.06);

    /* The opening pause is counted off the render clock rather than a timer, so
       the beat before he lands is a beat of *animation*: if the tab is
       throttled or the frame loop is being stepped, the whole intro stays in
       step. */
    if (!started.current) {
      waited.current += step * 1000;
      if (waited.current < pause) return;
      started.current = true;
      play(0);
    }

    /* The switch is queued rather than done inside the 'finished' handler:
       that event fires from inside mixer.update(), and starting an action there
       mutates the list the mixer is walking. clampWhenFinished holds the last
       pose for the one frame in between, and every boundary closes exactly, so
       the hold is invisible. */
    if (advance.current) {
      advance.current = false;
      const next = beat.current + 1;
      if (next < plan.current.length) {
        beat.current = next;
        play(next);
      }
    }

    /* One decision is picked up per visit to the idle: a click that lands
       mid-fetch waits for him to sit down again, and a backlog of clicks is
       collapsed to a single trip by the counter that feeds this. */
    const current = plan.current[beat.current];
    if (current?.clip === "DangleIdle" && pending.current > 0) {
      pending.current -= 1;
      if (reduced || parked.current) {
        spendQuietly();
      } else {
        plan.current = mascotDecision;
        beat.current = 0;
        play(0);
      }
    }

    mixer.update(step);

    const clip = plan.current[beat.current]?.clip;
    const action = clip ? actions.get(clip) : undefined;
    if (action) {
      if (
        clip === "FetchBlock" &&
        !carried.current &&
        action.time >= attachSeconds
      ) {
        takeBlock();
      }
      if (
        clip === "CarryPlace" &&
        carried.current &&
        action.time >= detachSeconds
      ) {
        releaseBlock();
      }
    }

    for (const block of blocks) {
      const tween = block.tween;
      if (tween) {
        tween.elapsed += step;
        const t = Math.min(1, tween.elapsed / tween.duration);
        const eased = easeInOut(t);
        block.group.position.lerpVectors(tween.from, tween.to, eased);
        block.group.position.y += Math.sin(Math.PI * t) * tween.arc;
        block.group.quaternion
          .copy(tween.fromQuaternion)
          .slerp(tween.toQuaternion, eased);
        block.group.scale.setScalar(
          tween.fromScale + (tween.toScale - tween.fromScale) * eased,
        );
        if (tween.fromTint && tween.toTint) {
          block.faces.color.copy(tween.fromTint).lerp(tween.toTint, eased);
        }
        if (t >= 1) {
          block.tween = null;
          tween.onDone?.();
        }
      }
      if (block.absorb >= 0) {
        /* Two ways to go: dissolving in his hands on the screens without a
           diorama, or landing in one — where it has already arrived, so it
           only has to give one swell and hand over to the CSS cube. */
        const snapped = block.snapped;
        block.absorb = Math.min(
          1,
          block.absorb + step / (snapped ? 0.24 : 0.55),
        );
        const t = block.absorb;
        const fade = 1 - t * t;
        if (snapped) {
          block.group.scale.multiplyScalar(1 + 0.5 * step);
        } else {
          block.group.position.y = 0.34 + t * 0.24;
          block.group.scale.setScalar(1 - 0.75 * t);
          block.group.rotation.set(0, t * 0.6, 0);
        }
        block.faces.opacity = fade;
        block.edges.opacity = 0.45 * fade;
        for (const material of block.extra) material.opacity = fade;
        if (t >= 1) {
          block.absorb = -1;
          block.snapped = false;
          block.group.visible = false;
          block.group.scale.setScalar(1);
          if (block !== flagProp) block.faces.color.set(blockColour);
          block.faces.opacity = 1;
          block.edges.opacity = 0.45;
          for (const material of block.extra) material.opacity = 1;
          if (block.restock) {
            block.restock = false;
            block.slot = 0;
            block.group.visible = true;
            block.group.position.set(...blockPickup);
            block.group.rotation.set(0, blockPickupYaw, 0);
          }
        }
      }
    }

    let left = 0;
    for (const block of blocks) if (block.slot >= 0) left += 1;
    if (left !== pileSeen.current) {
      pileSeen.current = left;
      reportPile.current(left);
    }
  });

  return (
    /* One group for the whole workshop — him, his stool, his crate and his
       heap — because the staging turns all four together: the clips' root
       motion is written relative to the seat, so the only way to point the
       walk at the diorama is to point the room at it. */
    <group rotation={[0, yaw, 0]}>
      <primitive object={scene} ref={root} visible={false} />
      <group ref={pileRoot} />
      <MascotBox
        position={[blockPickup[0], crateSize[1] / 2, blockPickup[2]]}
        size={crateSize}
        yaw={blockPickupYaw}
      />
      <MascotBox position={plinthCentre} size={plinthSize} />
    </group>
  );
}

/** The stage's own entrance (vx-stage-in + vx-rise) is done at 615 ms, so the
 *  default pause lets the workshop land and hold for half a beat before he
 *  drops into it. */
export function MascotStage({
  decisions,
  onFlagPlaced,
  onPlace,
  screen,
  startDelay = 1150,
}: {
  /** Monotonic count of decisions taken so far — every rise queues a fetch. */
  decisions: number;
  /** Called once, when the flag he carries lands on the finished world. */
  onFlagPlaced?: () => void;
  onPlace?: () => void;
  /** Which World Forge screen is on: CSS parks him in that screen's free corner. */
  screen: string;
  startDelay?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pending = useRef(0);
  const seen = useRef(decisions);
  const level = useRef(decisions);
  level.current = decisions;
  const [dock, setDock] = useState<MascotDock | null>(null);
  const docked = useRef(dock);
  docked.current = dock;
  const onClip = useCallback((clip: MascotClip) => {
    host.current?.setAttribute("data-clip", clip);
  }, []);
  const onPile = useCallback((left: number) => {
    host.current?.setAttribute("data-pile", String(left));
  }, []);
  const finish = useRef({ place: onPlace, flag: onFlagPlaced });
  finish.current = { place: onPlace, flag: onFlagPlaced };
  const place = useCallback(() => {
    const done = finish.current;
    if (docked.current?.mode === "finale") done.flag?.();
    else done.place?.();
  }, []);

  /* Where the block he is holding belongs. The cube it is about to become is
     already in the DOM as a ghost — the diorama draws two levels ahead — so the
     block can be aimed at the exact tile the next decision lights up. */
  const snapTarget = useCallback((): SnapTarget | null => {
    const dock = docked.current;
    const frame = host.current?.offsetParent?.querySelector<HTMLElement>(
      "[data-mascot-frame]",
    );
    if (!dock || !frame) return null;
    if (dock.mode === "finale") {
      /* The finale aims at the flagpole's own foot on the tallest tower. The
         element is a zero-size point in the scene's 3D space, so its rect is
         that world point — and the prop stands on its own origin, so it wants
         no half-block correction the way the cubes below do. */
      const pin = frame.querySelector<HTMLElement>("[data-mascot-flag]");
      const stage = frame.getBoundingClientRect();
      if (!pin || !stage.width) return null;
      const box = pin.getBoundingClientRect();
      const scale = dock.width / stage.width;
      return {
        x: (box.left + box.width / 2 - stage.left) * scale,
        y: (box.top + box.height / 2 - stage.top) * scale,
        scale: dock.unit / blockSize / dock.zoom,
        tint: null,
      };
    }
    const cubes = frame.querySelectorAll<HTMLElement>(
      `.vx-block[data-at="${level.current}"]`,
    );
    const cube = cubes[cubes.length - 1];
    if (!cube) return null;
    const box = cube.getBoundingClientRect();
    const stage = frame.getBoundingClientRect();
    if (!box.width || !stage.width) return null;
    const scale = dock.width / stage.width;
    const tint = getComputedStyle(cube).getPropertyValue("--tone").trim();
    return {
      /* The cube's own box is its top face; its middle sits half a face-height
         lower. */
      x: (box.left + box.width / 2 - stage.left) * scale,
      y: (box.top + box.height / 2 - stage.top) * scale + dock.unit * 0.42,
      scale: dock.unit / blockSize / dock.zoom,
      tint: tint.startsWith("#") || tint.startsWith("rgb") ? tint : null,
    };
  }, []);

  useEffect(() => {
    if (decisions > seen.current) {
      /* Collapse a backlog: however many decisions land while he is out, he
         only makes one more trip when he gets back. */
      pending.current = 1;
    }
    seen.current = decisions;
  }, [decisions]);

  /* The finale is the one performance nobody clicks for: the moment he is
     standing in the finished world's panel he goes and gets the flag. */
  const flagRun = useRef(false);
  useEffect(() => {
    if (dock?.mode !== "finale" || flagRun.current) return;
    flagRun.current = true;
    pending.current = 1;
  }, [dock?.mode]);

  /* The capture window is inside the keyed stage, so it is a different element
     on every screen — and the sidebar it lives in is sized by the viewport.
     Re-measure on both, rather than writing its geometry down in CSS. */
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () =>
      setDock((current) => {
        const next = measureDock(node);
        if (!next || !current) return next;
        return next.mode === current.mode &&
          next.left === current.left &&
          next.top === current.top &&
          next.width === current.width &&
          next.height === current.height &&
          next.zoom === current.zoom &&
          next.target[0] === current.target[0] &&
          next.target[1] === current.target[1]
          ? current
          : next;
      });
    measure();
    const parent = node.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    const frame = parent.querySelector("[data-mascot-frame]");
    if (frame) observer.observe(frame);
    /* Belt and braces for anything that settles late — a font swap, the
       scrollbar appearing, the stage entrance finishing. */
    parent.addEventListener("animationend", measure);
    return () => {
      parent.removeEventListener("animationend", measure);
      observer.disconnect();
    };
  }, [decisions, screen]);

  /* Moving between a free corner and a diorama frame is a cut, not a slide:
     the two are at different scales and different camera angles, and tweening
     between them only makes the change look like a mistake. Replaying the
     dock's own entrance fade covers it — he is never re-created, so he arrives
     already sitting on his block. */
  const mode = dock?.mode ?? "free";
  const wasMode = useRef(mode);
  useEffect(() => {
    const node = host.current;
    if (!node || wasMode.current === mode) return;
    wasMode.current = mode;
    node.style.animation = "none";
    void node.offsetHeight;
    node.style.animation = "";
  }, [mode]);

  return (
    <div
      aria-hidden="true"
      className="vx-mascot"
      data-clip="load"
      data-dock={mode}
      data-screen={screen}
      ref={host}
      style={
        dock
          ? {
              left: `${dock.left}px`,
              top: `${dock.top}px`,
              right: "auto",
              bottom: "auto",
              width: `${dock.width}px`,
              height: `${dock.height}px`,
              transition: "none",
            }
          : undefined
      }
    >
      <Canvas
        dpr={[1, 2]}
        /* Nothing in here is ever pointed at, and r3f's own event manager
           connects itself from an async continuation of the mount — so on the
           screens he steps off, a canvas that has already been taken out of
           the document tries to attach listeners to a null parent and throws.
           An event manager that never connects is both the honest description
           of a decoration and the end of that race. */
        events={() => ({ enabled: false, priority: 0 })}
        gl={{ alpha: true, antialias: true }}
        orthographic
        camera={{ position: [0, 1, 6], zoom: 200 }}
        /* R3F puts pointer-events:auto on its own wrapper inline, which would
           let the canvas swallow clicks meant for the panel it stands in front
           of. Inline beats the stylesheet, so it has to be undone here. */
        style={{ pointerEvents: "none" }}
      >
        <MascotCamera
          {...mascotView}
          {...(dock
            ? { ...frameView, target: dock.target, zoom: dock.zoom }
            : null)}
        />
        <hemisphereLight
          args={["#fffdf4", "#cfc7b0", 1.15]}
          position={[0, 3, 0]}
        />
        <directionalLight
          color="#fff5e2"
          intensity={2.1}
          position={[2.4, 3.6, 2.8]}
        />
        <directionalLight
          color="#e7f1ff"
          intensity={0.6}
          position={[-2.8, 1.5, 2]}
        />
        <directionalLight
          color="#ffd7a4"
          intensity={0.9}
          position={[-0.8, 2.4, -3.2]}
        />
        <Suspense fallback={null}>
          <MascotRover
            flag={mode === "finale"}
            onClip={onClip}
            onPile={onPile}
            onPlace={place}
            pending={pending}
            snapTarget={snapTarget}
            startDelay={startDelay}
            still={mode === "panel"}
            yaw={dock?.yaw ?? 0}
          />
          {/* y must stay *below* 0: drei renders its blur passes against a
              plane parked at the world origin, so a shadow group sitting on
              or above that origin has the plane behind its own camera and
              every blur pass hands back an empty texture. */}
          <ContactShadows
            blur={2.2}
            color="#16161d"
            far={0.9}
            frames={Infinity}
            opacity={0.42}
            position={[0, -0.01, 0]}
            resolution={512}
            scale={3.6}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

useGLTF.preload(mascotModelUrl, false, false);
