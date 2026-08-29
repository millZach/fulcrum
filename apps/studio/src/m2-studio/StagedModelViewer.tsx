/**
 * The 3D review viewer for one staged Meshy preview.
 *
 * It is deliberately one long-lived canvas: the model subtree is keyed by the
 * GLB's URL and everything else — camera, controls, lights, shadow catcher —
 * outlives a swap. That is what lets an untextured geometry preview become its
 * textured self without the reviewer losing the angle they were judging it
 * from, which is the whole point of reviewing the same asset twice.
 *
 * Framing is measured, never assumed: every staged GLB is fitted from its own
 * bounding box so a two-metre character and a shoulder-height crate both land
 * at the same size on the mat, standing on the ground plane rather than
 * floating around the origin.
 */
import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas } from "@react-three/fiber";
import {
  ContactShadows,
  OrbitControls,
  useAnimations,
  useGLTF,
} from "@react-three/drei";
import * as THREE from "three";

import type { StagedClip } from "./staged-asset-view.js";

/**
 * Model height on the mat, in world units, against a camera that sees about
 * 2.3. The headroom is not decoration: a bounding box is measured on the bind
 * pose, and a walk cycle swings limbs well outside it — framed tight, an
 * animated model walks its own feet off the bottom of the mat.
 */
const FITTED_HEIGHT = 1.7;

function StagedModel({
  clip,
  onReady,
  uri,
}: {
  clip: StagedClip;
  onReady: (uri: string) => void;
  uri: string;
}) {
  const { animations, scene } = useGLTF(uri);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(animations, group);

  /* Meshy hands back whatever scale the source implied, so the viewer measures
     the mesh instead of trusting it: centre it on x/z, sit its lowest vertex on
     the ground plane, and scale its longest axis to a fixed height. */
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z, 1e-4);
    const scale = FITTED_HEIGHT / longest;
    return {
      scale,
      position: [-centre.x * scale, -box.min.y * scale, -centre.z * scale] as [
        number,
        number,
        number,
      ],
    };
  }, [scene]);

  useEffect(() => {
    onReady(uri);
  }, [onReady, uri]);

  useEffect(() => {
    const action = clip === "none" ? undefined : actions[clip];
    if (!action) {
      for (const candidate of Object.values(actions)) candidate?.stop();
      return;
    }
    action.reset().fadeIn(0.25).play();
    return () => {
      action.fadeOut(0.25);
    };
  }, [actions, clip]);

  return (
    <group position={fit.position} ref={group} scale={fit.scale}>
      <primitive object={scene} />
    </group>
  );
}

/** A viewer that cannot draw is a defect to report, not a blank rectangle. */
class ViewerBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function StagedModelViewer({
  caption,
  clip,
  uri,
}: {
  caption: string;
  clip: StagedClip;
  uri: string;
}) {
  /* Which file the canvas is actually showing. Stored as the URL rather than a
     boolean: a swap is a new file over the same camera, and a boolean reset by
     an effect in this component would race the child effect that sets it —
     React runs the child's first, so the reset would win and the mat would say
     "opening" over a model that had already opened. */
  const [readyUri, setReadyUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ready = readyUri === uri;

  return (
    <figure className="agp-viewer">
      <div className="agp-viewer-mat" data-ready={ready || undefined}>
        {failed ? (
          <p className="agp-viewer-failed">
            This browser could not open the 3D preview. The model file itself is
            still downloadable from the artifact link below.
          </p>
        ) : (
          <ViewerBoundary onError={() => setFailed(true)}>
            <Canvas
              camera={{ fov: 32, position: [2.1, 1.9, 3.2] }}
              dpr={[1, 2]}
              gl={{ alpha: true, antialias: true }}
            >
              {/* Neutral studio light: one key, one cool fill, one warm
                  bounce, so an untextured grey mesh still reads as a form
                  rather than a silhouette. */}
              <hemisphereLight
                args={["#fffdf4", "#cfc7b0", 1.1]}
                position={[0, 4, 0]}
              />
              <ambientLight intensity={0.5} />
              <directionalLight
                color="#fff6e6"
                intensity={2.2}
                position={[3.2, 4.4, 3]}
              />
              <directionalLight
                color="#e8f2ff"
                intensity={0.8}
                position={[-3.4, 2.2, 2.4]}
              />
              <directionalLight
                color="#ffd7a4"
                intensity={0.7}
                position={[-1, 2.6, -3.6]}
              />
              <Suspense fallback={null}>
                <StagedModel
                  clip={clip}
                  key={uri}
                  onReady={setReadyUri}
                  uri={uri}
                />
                <ContactShadows
                  blur={2.4}
                  color="#16161d"
                  far={2.2}
                  frames={Infinity}
                  opacity={0.34}
                  position={[0, -0.01, 0]}
                  resolution={512}
                  scale={6}
                />
              </Suspense>
              <OrbitControls
                enableDamping
                enablePan={false}
                makeDefault
                maxDistance={9}
                maxPolarAngle={Math.PI * 0.52}
                minDistance={1.6}
                target={[0, FITTED_HEIGHT / 2, 0]}
              />
            </Canvas>
          </ViewerBoundary>
        )}
        {!ready && !failed && (
          <span className="agp-viewer-loading">Opening the model…</span>
        )}
      </div>
      <figcaption>
        <span className="agp-viewer-caption">{caption}</span>
        <small>Drag to orbit · scroll to zoom</small>
      </figcaption>
    </figure>
  );
}
