import { createHash } from "node:crypto";

import { Document, NodeIO, type Accessor } from "@gltf-transform/core";
import { BoxGeometry, type BufferGeometry, CylinderGeometry } from "three";

import { encodePngRgba } from "./png.js";

/**
 * Viewer-ready placeholder GLBs for the simulated staged asset lifecycle.
 *
 * Meshy is never called in this repo's dev loop, but the whole point of the
 * staged gate is that a human looks at a mesh and decides. A simulation that
 * hands the studio an opaque blob tests nothing, so these are real glTF
 * binaries: a low-poly untextured figure for the geometry review, the same
 * figure with an embedded base-colour texture for the texture review, and a
 * skinned copy with walk and run clips for the rig review.
 *
 * Byte-determinism rule: nothing that varies per run may reach these bytes.
 * The seed is the planned asset's *key* (the half of `assetId` after the
 * project id), the stage, and the round — all of which are stable inputs, not
 * run identity. Two replay projects built from the same plan therefore produce
 * byte-identical artifacts, which is what the replay determinism record
 * compares.
 */

export type StagedGlbVariant = "geometry" | "textured" | "rigged";

export type StagedGlbRequest = {
  /** Stable content seed. Never a projectId, runId, or timestamp. */
  shapeSeed: string;
  variant: StagedGlbVariant;
  /** 1-based attempt within the stage, so a retry genuinely looks different. */
  round: number;
};

/** The half of a planned asset id that carries no project identity. */
export const stagedShapeSeed = (assetId: string): string => {
  const marker = ":planned-asset:";
  const index = assetId.indexOf(marker);
  return index === -1 ? assetId : assetId.slice(index + marker.length);
};

/** A tiny deterministic PRNG seeded from content, not from the clock. */
const seededRandom = (seed: string): (() => number) => {
  const digest = createHash("sha256").update(seed).digest();
  let state = digest.readUInt32BE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
};

type Vec3 = [number, number, number];

type JointSpec = {
  name: string;
  /** Offset from the parent joint, in metres. */
  offset: Vec3;
  parent?: string;
};

const JOINTS: JointSpec[] = [
  { name: "hips", offset: [0, 0.92, 0] },
  { name: "spine", offset: [0, 0.36, 0], parent: "hips" },
  { name: "head", offset: [0, 0.34, 0], parent: "spine" },
  { name: "armL", offset: [-0.26, 0.2, 0], parent: "spine" },
  { name: "armR", offset: [0.26, 0.2, 0], parent: "spine" },
  { name: "legL", offset: [-0.14, -0.06, 0], parent: "hips" },
  { name: "legR", offset: [0.14, -0.06, 0], parent: "hips" },
];

const jointWorldPositions = (): Map<string, Vec3> => {
  const world = new Map<string, Vec3>();
  for (const joint of JOINTS) {
    const parent: Vec3 = joint.parent ? world.get(joint.parent)! : [0, 0, 0];
    world.set(joint.name, [
      parent[0] + joint.offset[0],
      parent[1] + joint.offset[1],
      parent[2] + joint.offset[2],
    ]);
  }
  return world;
};

/** Whichever joint the vertex sits closest to. One joint per vertex, weight 1. */
const nearestJoint = (position: Vec3, world: Map<string, Vec3>): number => {
  let best = 0;
  let bestDistance = Infinity;
  JOINTS.forEach((joint, index) => {
    const target = world.get(joint.name)!;
    const distance =
      (position[0] - target[0]) ** 2 +
      (position[1] - target[1]) ** 2 +
      (position[2] - target[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
};

type Part = { name: string; geometry: BufferGeometry };

/**
 * A blocky humanoid, roughly 1.7 m tall and bottom-origin, so it reads at a
 * glance in a viewer and satisfies Meshy's own `origin_at: "bottom"` habit.
 * Proportions wobble with the seed; the topology never does.
 */
const figureParts = (random: () => number): Part[] => {
  const shoulder = 0.42 + random() * 0.18;
  const torsoDepth = 0.2 + random() * 0.1;
  const torsoHeight = 0.52 + random() * 0.12;
  const legLength = 0.86 + random() * 0.1;
  const headSize = 0.2 + random() * 0.06;
  const limbWidth = 0.11 + random() * 0.04;
  const hipY = legLength + 0.06;

  return [
    {
      name: "pelvis",
      geometry: new BoxGeometry(shoulder * 0.8, 0.2, torsoDepth).translate(
        0,
        hipY,
        0,
      ),
    },
    {
      name: "torso",
      geometry: new BoxGeometry(shoulder, torsoHeight, torsoDepth).translate(
        0,
        hipY + torsoHeight / 2 + 0.1,
        0,
      ),
    },
    {
      name: "head",
      geometry: new BoxGeometry(headSize, headSize, headSize).translate(
        0,
        hipY + torsoHeight + headSize / 2 + 0.16,
        0,
      ),
    },
    {
      name: "arm-left",
      geometry: new CylinderGeometry(
        limbWidth * 0.5,
        limbWidth * 0.42,
        torsoHeight + 0.1,
        6,
      ).translate(
        -shoulder / 2 - limbWidth * 0.5,
        hipY + torsoHeight - 0.06,
        0,
      ),
    },
    {
      name: "arm-right",
      geometry: new CylinderGeometry(
        limbWidth * 0.5,
        limbWidth * 0.42,
        torsoHeight + 0.1,
        6,
      ).translate(shoulder / 2 + limbWidth * 0.5, hipY + torsoHeight - 0.06, 0),
    },
    {
      name: "leg-left",
      geometry: new CylinderGeometry(
        limbWidth * 0.62,
        limbWidth * 0.52,
        legLength,
        6,
      ).translate(-shoulder * 0.2, legLength / 2, 0),
    },
    {
      name: "leg-right",
      geometry: new CylinderGeometry(
        limbWidth * 0.62,
        limbWidth * 0.52,
        legLength,
        6,
      ).translate(shoulder * 0.2, legLength / 2, 0),
    },
  ];
};

/** A 16x16 base-colour map. Small enough to embed, obvious enough to see. */
const baseColorPng = (random: () => number): Uint8Array => {
  const size = 16;
  const rgba = new Uint8Array(size * size * 4);
  const warm: Vec3 = [
    120 + Math.floor(random() * 90),
    80 + Math.floor(random() * 70),
    60 + Math.floor(random() * 60),
  ];
  const cool: Vec3 = [
    30 + Math.floor(random() * 40),
    90 + Math.floor(random() * 80),
    110 + Math.floor(random() * 90),
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = (x >> 2) % 2 === (y >> 2) % 2 ? warm : cool;
      const offset = (y * size + x) * 4;
      rgba[offset] = source[0];
      rgba[offset + 1] = source[1];
      rgba[offset + 2] = source[2];
      rgba[offset + 3] = 255;
    }
  }
  return encodePngRgba(size, size, rgba);
};

const rotationKeyframes = (
  phase: number,
  swing: number,
  steps: number,
): Float32Array<ArrayBuffer> => {
  const values = new Float32Array(new ArrayBuffer((steps + 1) * 4 * 4));
  for (let step = 0; step <= steps; step += 1) {
    const angle = Math.sin((step / steps) * Math.PI * 2 + phase) * swing * 0.5;
    values[step * 4] = Math.sin(angle);
    values[step * 4 + 1] = 0;
    values[step * 4 + 2] = 0;
    values[step * 4 + 3] = Math.cos(angle);
  }
  return values;
};

/**
 * Builds one placeholder GLB. Same request in, same bytes out — the buffer is
 * written from a fixed node order and every node name is a literal, so nothing
 * about when or where it ran can leak into the hash. (glTF-Transform stamps its
 * own version into `asset.generator` on write, which is fixed per lockfile.)
 */
export const createStagedPlaceholderGlb = async (
  request: StagedGlbRequest,
): Promise<Uint8Array> => {
  const random = seededRandom(
    `fulcrum-staged-glb:${request.variant}:${request.round}:${request.shapeSeed}`,
  );
  const document = new Document();
  const scene = document.createScene("Fulcrum staged placeholder");
  const buffer = document.createBuffer("staged-buffer");
  const textured = request.variant !== "geometry";
  const rigged = request.variant === "rigged";

  const material = document
    .createMaterial("staged-surface")
    .setBaseColorFactor([
      0.32 + random() * 0.4,
      0.34 + random() * 0.4,
      0.38 + random() * 0.4,
      1,
    ])
    .setMetallicFactor(textured ? 0.15 : 0)
    .setRoughnessFactor(textured ? 0.55 : 0.9);
  if (textured) {
    const texture = document
      .createTexture("staged-base-color")
      .setMimeType("image/png")
      .setImage(baseColorPng(random));
    material.setBaseColorTexture(texture);
  }

  const world = jointWorldPositions();
  const parts = figureParts(random);
  const nodes = parts.map(({ name, geometry }) => {
    geometry.computeVertexNormals();
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const uvs = geometry.getAttribute("uv");
    const primitive = document
      .createPrimitive()
      .setAttribute(
        "POSITION",
        document
          .createAccessor(`${name}:position`, buffer)
          .setType("VEC3")
          .setArray(new Float32Array(positions.array)),
      )
      .setAttribute(
        "NORMAL",
        document
          .createAccessor(`${name}:normal`, buffer)
          .setType("VEC3")
          .setArray(new Float32Array(normals.array)),
      )
      .setMaterial(material);
    if (textured && uvs) {
      primitive.setAttribute(
        "TEXCOORD_0",
        document
          .createAccessor(`${name}:uv`, buffer)
          .setType("VEC2")
          .setArray(new Float32Array(uvs.array)),
      );
    }
    if (geometry.index) {
      primitive.setIndices(
        document
          .createAccessor(`${name}:index`, buffer)
          .setType("SCALAR")
          .setArray(new Uint16Array(geometry.index.array)),
      );
    }
    if (rigged) {
      const count = positions.count;
      const joints = new Uint16Array(count * 4);
      const weights = new Float32Array(count * 4);
      for (let index = 0; index < count; index += 1) {
        joints[index * 4] = nearestJoint(
          [positions.getX(index), positions.getY(index), positions.getZ(index)],
          world,
        );
        weights[index * 4] = 1;
      }
      primitive
        .setAttribute(
          "JOINTS_0",
          document
            .createAccessor(`${name}:joints`, buffer)
            .setType("VEC4")
            .setArray(joints),
        )
        .setAttribute(
          "WEIGHTS_0",
          document
            .createAccessor(`${name}:weights`, buffer)
            .setType("VEC4")
            .setArray(weights),
        );
    }
    geometry.dispose();
    const node = document
      .createNode(name)
      .setMesh(document.createMesh(name).addPrimitive(primitive));
    scene.addChild(node);
    return node;
  });

  if (!rigged) return await new NodeIO().writeBinary(document);

  const jointNodes = new Map(
    JOINTS.map((joint) => [
      joint.name,
      document.createNode(joint.name).setTranslation(joint.offset),
    ]),
  );
  for (const joint of JOINTS) {
    const node = jointNodes.get(joint.name)!;
    if (joint.parent) jointNodes.get(joint.parent)!.addChild(node);
    else scene.addChild(node);
  }
  const inverseBindMatrices = new Float32Array(JOINTS.length * 16);
  JOINTS.forEach((joint, index) => {
    const position = world.get(joint.name)!;
    const offset = index * 16;
    inverseBindMatrices[offset] = 1;
    inverseBindMatrices[offset + 5] = 1;
    inverseBindMatrices[offset + 10] = 1;
    inverseBindMatrices[offset + 12] = -position[0];
    inverseBindMatrices[offset + 13] = -position[1];
    inverseBindMatrices[offset + 14] = -position[2];
    inverseBindMatrices[offset + 15] = 1;
  });
  const skin = document
    .createSkin("staged-skeleton")
    .setSkeleton(jointNodes.get("hips")!)
    .setInverseBindMatrices(
      document
        .createAccessor("staged-ibm", buffer)
        .setType("MAT4")
        .setArray(inverseBindMatrices),
    );
  for (const joint of JOINTS) skin.addJoint(jointNodes.get(joint.name)!);
  for (const node of nodes) node.setSkin(skin);

  const clips: Array<{ name: string; duration: number; swing: number }> = [
    { name: "walk", duration: 1, swing: 0.5 },
    { name: "run", duration: 0.6, swing: 0.95 },
  ];
  const swingJoints: Array<{ joint: string; phase: number }> = [
    { joint: "legL", phase: 0 },
    { joint: "legR", phase: Math.PI },
    { joint: "armL", phase: Math.PI },
    { joint: "armR", phase: 0 },
  ];
  const steps = 4;
  for (const clip of clips) {
    const times = new Float32Array(steps + 1);
    for (let step = 0; step <= steps; step += 1)
      times[step] = (step / steps) * clip.duration;
    const input: Accessor = document
      .createAccessor(`${clip.name}:time`, buffer)
      .setType("SCALAR")
      .setArray(times);
    const animation = document.createAnimation(clip.name);
    for (const { joint, phase } of swingJoints) {
      const sampler = document
        .createAnimationSampler()
        .setInterpolation("LINEAR")
        .setInput(input)
        .setOutput(
          document
            .createAccessor(`${clip.name}:${joint}`, buffer)
            .setType("VEC4")
            .setArray(rotationKeyframes(phase, clip.swing, steps)),
        );
      animation
        .addSampler(sampler)
        .addChannel(
          document
            .createAnimationChannel()
            .setTargetNode(jointNodes.get(joint)!)
            .setTargetPath("rotation")
            .setSampler(sampler),
        );
    }
  }

  return await new NodeIO().writeBinary(document);
};
