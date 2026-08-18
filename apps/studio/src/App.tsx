import {
  ContactShadows,
  Environment,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { WebGLRenderer } from "three";
import { Color } from "three";

import {
  M0_FIXTURE_BRIEF,
  type AssetProvider,
  type ApprovalInput,
  type ConfigurationStatus,
  type ExecutionProvider,
  type FulcrumSceneSpecV0,
  type ImageProvider,
  type ProjectSnapshot,
} from "@fulcrum/domain";

const executionLabels: Record<ExecutionProvider, string> = {
  claude: "Claude Subscription",
  openai: "OpenAI Subscription",
  "openai-api": "OpenAI API",
  grok: "Grok Subscription",
  opencode: "OpenCode Subscription",
};

const imageLabels: Record<ImageProvider, string> = {
  "openai-subscription": "OpenAI Sub · Image",
  "openai-gpt-image-2": "OpenAI API · GPT Image 2",
  "custom-api": "Custom image API",
  none: "No image model",
};

const api = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const payload = (await response.json()) as T & { detail?: string };
  if (!response.ok)
    throw new Error(payload.detail ?? `Request failed (${response.status}).`);
  return payload;
};

const stageOrder = [
  ["creative-development", "Creative"],
  ["visual-direction-approval", "Direction"],
  ["asset-production", "3D Asset"],
  ["asset-quality", "QA"],
  ["scene-composition", "Scene"],
  ["visual-slice-approval", "Review"],
  ["complete", "Complete"],
] as const;

const shortHash = (hash?: string) => (hash ? hash.slice(0, 10) : "—");

function StatusRail({ project }: { project: ProjectSnapshot }) {
  const current = stageOrder.findIndex(
    ([stage]) => stage === project.state.stage,
  );
  return (
    <ol className="status-rail" aria-label="M0 production stages">
      {stageOrder.map(([stage, label], index) => (
        <li
          key={stage}
          className={
            index < current || project.state.stage === "complete"
              ? "done"
              : index === current
                ? "current"
                : ""
          }
        >
          <span />
          {label}
        </li>
      ))}
    </ol>
  );
}

function CameraRig({ scene }: { scene: FulcrumSceneSpecV0 }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(...scene.camera.position);
    camera.lookAt(...scene.camera.target);
    camera.updateProjectionMatrix();
  }, [camera, scene]);
  return null;
}

function Reliquary({ uri, scene }: { uri: string; scene: FulcrumSceneSpecV0 }) {
  const gltf = useGLTF(uri);
  const object = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const transform = scene.entities[0]?.transform;
  return (
    <primitive
      object={object}
      position={transform?.position ?? [0, 0, 0]}
      rotation={transform?.rotationEulerRadians ?? [0, 0, 0]}
      scale={transform?.scale ?? [1, 1, 1]}
    />
  );
}

function ReviewScene({
  project,
  onRenderer,
}: {
  project: ProjectSnapshot;
  onRenderer: (renderer: WebGLRenderer) => void;
}) {
  if (!project.scene || !project.asset) return null;
  const scene = project.scene;
  return (
    <Canvas
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      shadows
      camera={{ fov: scene.camera.fieldOfViewDegrees }}
      onCreated={({ gl }) => onRenderer(gl)}
    >
      <color attach="background" args={[scene.environment.background]} />
      <fog
        attach="fog"
        args={[
          scene.environment.fog.color,
          scene.environment.fog.near,
          scene.environment.fog.far,
        ]}
      />
      <CameraRig scene={scene} />
      <ambientLight color="#7895b0" intensity={0.72} />
      <directionalLight
        color="#ffd0a0"
        intensity={3.2}
        position={[4.5, 7, 4]}
        castShadow
      />
      <pointLight
        color="#5de4e7"
        intensity={14}
        distance={7}
        position={[0, 2, 1.6]}
      />
      <Suspense fallback={null}>
        <Reliquary uri={project.asset.glb.uri} scene={scene} />
        <Environment preset="night" />
      </Suspense>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[scene.environment.ground.radius, 96]} />
        <meshStandardMaterial
          color={scene.environment.ground.color}
          roughness={0.93}
          metalness={0.04}
        />
      </mesh>
      {[3.8, 6.6, 9.5].map((radius) => (
        <mesh
          key={radius}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.018, 0]}
        >
          <ringGeometry args={[radius, radius + 0.035, 96]} />
          <meshBasicMaterial color="#496476" transparent opacity={0.32} />
        </mesh>
      ))}
      <ContactShadows
        position={[0, 0.025, 0]}
        opacity={0.72}
        scale={7}
        blur={2.6}
        far={7}
      />
      <OrbitControls
        makeDefault
        target={scene.camera.target}
        minDistance={4.2}
        maxDistance={16}
        maxPolarAngle={Math.PI / 2.05}
      />
    </Canvas>
  );
}

function EmptyState({
  configuration,
  onCreated,
  onExplain,
}: {
  configuration: ConfigurationStatus;
  onCreated: (project: ProjectSnapshot) => void;
  onExplain: () => void;
}) {
  const [brief, setBrief] = useState(
    configuration.fixtureBrief || M0_FIXTURE_BRIEF,
  );
  const [mode, setMode] = useState<"replay" | "live">(
    configuration.defaultMode,
  );
  const [assetProvider, setAssetProvider] = useState<AssetProvider>(
    configuration.defaultAssetProvider,
  );
  const [orchestratorProvider, setOrchestratorProvider] =
    useState<ExecutionProvider>(configuration.defaultOrchestratorProvider);
  const [implementationProvider, setImplementationProvider] =
    useState<ExecutionProvider>(configuration.defaultImplementationProvider);
  const [imageProvider, setImageProvider] = useState<ImageProvider>(
    configuration.defaultImageProvider,
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const assetReadiness = configuration.assetProviders.find(
    ({ provider }) => provider === assetProvider,
  );
  const orchestratorReadiness = configuration.executionProviders.find(
    ({ provider }) => provider === orchestratorProvider,
  );
  const implementationReadiness = configuration.executionProviders.find(
    ({ provider }) => provider === implementationProvider,
  );
  const imageReadiness = configuration.imageProviders.find(
    ({ provider }) => provider === imageProvider,
  );
  const liveBlockers = [
    ...(configuration.m0BudgetUsd ? [] : ["FULCRUM_M0_BUDGET_USD"]),
    ...(orchestratorReadiness?.ready
      ? []
      : [orchestratorReadiness?.detail ?? "Orchestrator is unavailable"]),
    ...(imageReadiness?.missingConfiguration ?? ["Unknown image provider"]),
    ...(assetReadiness?.missingConfiguration ?? ["Unknown 3D provider"]),
  ];
  useEffect(() => {
    if (mode === "live" && liveBlockers.length > 0) setMode("replay");
  }, [
    mode,
    orchestratorProvider,
    imageProvider,
    assetProvider,
    liveBlockers.length,
  ]);
  const createProject = async () => {
    setWorking(true);
    setError("");
    try {
      const project = await api<ProjectSnapshot>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          brief,
          mode,
          assetProvider,
          orchestratorProvider,
          implementationProvider,
          imageProvider,
          budgetUsd: mode === "live" ? (configuration.m0BudgetUsd ?? 1) : 1,
          rightsConfirmed: true,
        }),
      });
      onCreated(project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  return (
    <main className="launch">
      <div className="launch-copy">
        <p className="eyebrow">M0 · walking skeleton</p>
        <h1>
          One idea.
          <br />A traceable world.
        </h1>
        <p>
          Fulcrum carries a creative brief through an immutable concept,
          generated 3D asset, deterministic QA, and a scene you can inspect.
        </p>
        <div
          className="launch-flow"
          aria-label="How an M0 run moves through Studio"
        >
          <span>01 · Brief</span>
          <i>→</i>
          <span>02 · Direction</span>
          <i>→</i>
          <span>03 · 3D review</span>
        </div>
        <button className="text-action" type="button" onClick={onExplain}>
          How Studio works
        </button>
      </div>
      <section className="brief-composer">
        <div className="composer-heading">
          <span>Game brief</span>
          <button type="button" onClick={() => setBrief(M0_FIXTURE_BRIEF)}>
            Use fixture
          </button>
        </div>
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          aria-label="Game brief"
        />
        <div className="mode-picker">
          <button
            type="button"
            className={mode === "replay" ? "selected" : ""}
            onClick={() => setMode("replay")}
          >
            <strong>Replay</strong>
            <small>Offline · deterministic · $0</small>
          </button>
          <button
            type="button"
            className={mode === "live" ? "selected" : ""}
            disabled={liveBlockers.length > 0}
            onClick={() => setMode("live")}
          >
            <strong>Live</strong>
            <small>
              {liveBlockers.length === 0
                ? `${executionLabels[orchestratorProvider]} + ${assetProvider === "meshy" ? "Meshy" : "Tripo"}`
                : "Needs provider setup"}
            </small>
          </button>
        </div>
        <div className="provider-heading">
          <span>Model routing</span>
          <small>Subscription first · API fallback</small>
        </div>
        <div className="model-routing">
          <label>
            <span>Orchestrator</span>
            <select
              aria-label="Orchestrator model provider"
              value={orchestratorProvider}
              onChange={(event) =>
                setOrchestratorProvider(event.target.value as ExecutionProvider)
              }
            >
              {configuration.executionProviders.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {executionLabels[entry.provider]}
                </option>
              ))}
            </select>
            <small className={orchestratorReadiness?.ready ? "ready" : ""}>
              {orchestratorReadiness?.detail}
            </small>
          </label>
          <label>
            <span>Implementation</span>
            <select
              aria-label="Implementation model provider"
              value={implementationProvider}
              onChange={(event) =>
                setImplementationProvider(
                  event.target.value as ExecutionProvider,
                )
              }
            >
              {configuration.executionProviders.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {executionLabels[entry.provider]}
                </option>
              ))}
            </select>
            <small className={implementationReadiness?.ready ? "ready" : ""}>
              {implementationReadiness?.ready
                ? "Ready for later implementation stages"
                : `${implementationReadiness?.detail} · not required by M0`}
            </small>
          </label>
          <label>
            <span>Image</span>
            <select
              aria-label="Optional image model"
              value={imageProvider}
              onChange={(event) =>
                setImageProvider(event.target.value as ImageProvider)
              }
            >
              {configuration.imageProviders.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {imageLabels[entry.provider]}
                </option>
              ))}
            </select>
            <small className={imageReadiness?.ready ? "ready" : ""}>
              {imageReadiness?.detail}
            </small>
          </label>
        </div>
        <div className="provider-heading">
          <span>3D provider</span>
          <small>Used for live runs</small>
        </div>
        <div className="provider-picker" aria-label="3D asset provider">
          <button
            type="button"
            className={assetProvider === "meshy" ? "selected" : ""}
            onClick={() => setAssetProvider("meshy")}
          >
            <strong>Meshy</strong>
            <small>Default · PBR GLB</small>
          </button>
          <button
            type="button"
            className={assetProvider === "tripo" ? "selected" : ""}
            onClick={() => setAssetProvider("tripo")}
          >
            <strong>Tripo</strong>
            <small>Alternate adapter</small>
          </button>
        </div>
        {liveBlockers.length > 0 && (
          <p className="provider-config-note">
            Live setup: {liveBlockers.join(" · ")}
          </p>
        )}
        {error && <p className="error-message">{error}</p>}
        <button
          className="primary-action"
          type="button"
          disabled={working || brief.length < 40}
          onClick={createProject}
        >
          {working ? "Building visual direction…" : "Begin M0 run"}
          <span>→</span>
        </button>
      </section>
    </main>
  );
}

function DirectionReview({
  project,
  onDecision,
}: {
  project: ProjectSnapshot;
  onDecision: (decision: ApprovalInput) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const decide = async (decision: ApprovalInput["decision"]) => {
    setWorking(true);
    try {
      await onDecision({ decision });
    } finally {
      setWorking(false);
    }
  };
  return (
    <main className="review-layout">
      <section className="concept-stage">
        {project.concept && (
          <img
            src={project.concept.image.uri}
            alt="Generated concept for the ancient reliquary"
          />
        )}
        <div className="image-caption">
          <span>Concept 01</span>
          <span>sha256 {shortHash(project.concept?.image.sha256)}</span>
        </div>
      </section>
      <aside className="decision-panel">
        <p className="eyebrow">Visual-direction approval</p>
        <h2>{project.concept?.name}</h2>
        <p className="summary">{project.gameDesign?.coreFantasy}</p>
        <div className="palette" aria-label="Visual bible palette">
          {project.visualBible?.palette.map((color) => (
            <span
              key={color.name}
              title={color.name}
              style={{ background: color.hex }}
            />
          ))}
        </div>
        <dl>
          <div>
            <dt>Shape</dt>
            <dd>{project.visualBible?.shapeLanguage}</dd>
          </div>
          <div>
            <dt>Materials</dt>
            <dd>{project.visualBible?.materials.join(" · ")}</dd>
          </div>
          <div>
            <dt>Concept render</dt>
            <dd>
              {project.concept?.provider} / {project.concept?.model}
            </dd>
          </div>
          <div>
            <dt>Orchestrator</dt>
            <dd>{executionLabels[project.state.orchestratorProvider]}</dd>
          </div>
          <div>
            <dt>Implementation</dt>
            <dd>
              {executionLabels[project.state.implementationProvider]} · reserved
              for later stages
            </dd>
          </div>
          <div>
            <dt>Image route</dt>
            <dd>{imageLabels[project.state.imageProvider]}</dd>
          </div>
          <div>
            <dt>3D route</dt>
            <dd>
              {project.state.mode === "replay"
                ? `Replay fixture · ${project.state.assetProvider} selected for live`
                : project.state.assetProvider}
            </dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>{shortHash(project.state.concept?.artifact.sha256)}</dd>
          </div>
        </dl>
        <div className="decision-actions">
          <button
            className="primary-action"
            disabled={working}
            onClick={() => decide("approved")}
          >
            Approve direction <span>→</span>
          </button>
          <button
            className="quiet-action"
            disabled={working || project.state.conceptReplacementCount >= 1}
            onClick={() => decide("changes-requested")}
          >
            {project.state.conceptReplacementCount >= 1
              ? "Replacement used"
              : "Request replacement"}
          </button>
        </div>
      </aside>
    </main>
  );
}

function SliceReview({
  project,
  onRefresh,
  onDecision,
}: {
  project: ProjectSnapshot;
  onRefresh: (project: ProjectSnapshot) => void;
  onDecision: (input: ApprovalInput) => Promise<void>;
}) {
  const renderer = useRef<WebGLRenderer | null>(null);
  const [working, setWorking] = useState(false);
  const capture = async () => {
    if (!renderer.current) return;
    setWorking(true);
    try {
      const dataUrl = renderer.current.domElement.toDataURL("image/png");
      const snapshot = await api<ProjectSnapshot>(
        `/api/projects/${project.state.projectId}/review-image`,
        {
          method: "POST",
          body: JSON.stringify({ dataUrl }),
        },
      );
      onRefresh(snapshot);
    } finally {
      setWorking(false);
    }
  };
  const qa = project.assetEvaluation?.measurements;
  return (
    <main className="scene-layout">
      <section className="viewport">
        <ReviewScene
          project={project}
          onRenderer={(value) => (renderer.current = value)}
        />
        <div className="viewport-title">
          <span>Interactive review</span>
          <small>Drag to orbit · Scroll to zoom</small>
        </div>
      </section>
      <aside className="scene-panel">
        <p className="eyebrow">Visual-slice approval</p>
        <h2>Ancient Reliquary</h2>
        <p className="summary">
          The approved direction, reconstructed as a measured GLB and composed
          into Fulcrum Scene Spec v0.
        </p>
        <div className="metrics">
          <div>
            <strong>{qa?.triangleCount.toLocaleString()}</strong>
            <span>triangles</span>
          </div>
          <div>
            <strong>{qa?.meshCount}</strong>
            <span>meshes</span>
          </div>
          <div>
            <strong>{qa?.materialCount}</strong>
            <span>materials</span>
          </div>
        </div>
        <div
          className={`gate-summary ${project.assetEvaluation?.passed ? "pass" : ""}`}
        >
          <span>{project.assetEvaluation?.passed ? "✓" : "!"}</span>
          <div>
            <strong>
              Deterministic QA{" "}
              {project.assetEvaluation?.passed ? "passed" : "blocked"}
            </strong>
            <small>
              {
                project.assetEvaluation?.gates.filter((gate) => gate.passed)
                  .length
              }{" "}
              / {project.assetEvaluation?.gates.length} gates
            </small>
          </div>
        </div>
        <dl>
          <div>
            <dt>GLB hash</dt>
            <dd>{shortHash(project.asset?.glb.sha256)}</dd>
          </div>
          <div>
            <dt>3D provider</dt>
            <dd>
              {project.asset?.provider} / {project.asset?.model}
            </dd>
          </div>
          <div>
            <dt>Scene hash</dt>
            <dd>{shortHash(project.state.scene?.artifact.sha256)}</dd>
          </div>
          <div>
            <dt>Cost reserved</dt>
            <dd>
              ${project.state.spentUsd.toFixed(2)} / $
              {project.state.budgetUsd.toFixed(2)}
            </dd>
          </div>
        </dl>
        <div className="decision-actions">
          {!project.state.reviewImage ? (
            <button
              className="primary-action"
              disabled={working}
              onClick={capture}
            >
              {working ? "Capturing…" : "Capture review image"}
              <span>◎</span>
            </button>
          ) : (
            <>
              <div className="capture-ready">
                Review image stored ·{" "}
                {shortHash(project.state.reviewImage.sha256)}
              </div>
              <button
                className="primary-action"
                disabled={working}
                onClick={() => onDecision({ decision: "approved" })}
              >
                Approve slice <span>→</span>
              </button>
              <button
                className="quiet-action"
                disabled={working}
                onClick={() => onDecision({ decision: "rejected" })}
              >
                Reject slice
              </button>
            </>
          )}
        </div>
      </aside>
    </main>
  );
}

function CompleteView({ project }: { project: ProjectSnapshot }) {
  return (
    <main className="complete-view">
      <p className="eyebrow">M0 run recorded</p>
      <h1>
        {project.state.sliceApproval?.decision === "approved"
          ? "Visual slice approved."
          : "Visual slice closed."}
      </h1>
      <p>
        The entire lineage remains inspectable: brief → concept → GLB → QA →
        scene → decision.
      </p>
      <div className="completion-lineage">
        <span>
          Concept <b>{shortHash(project.state.concept?.artifact.sha256)}</b>
        </span>
        <i>→</i>
        <span>
          Asset <b>{shortHash(project.asset?.glb.sha256)}</b>
        </span>
        <i>→</i>
        <span>
          Scene <b>{shortHash(project.state.scene?.artifact.sha256)}</b>
        </span>
      </div>
    </main>
  );
}

function ProductionView({ project }: { project: ProjectSnapshot }) {
  const label =
    project.state.stage === "asset-production"
      ? "Generating and reconciling the 3D asset"
      : "Advancing the M0 lineage";
  return (
    <main className="production-view">
      <div className="production-orbit" aria-hidden="true">
        <span />
        <i />
      </div>
      <p className="eyebrow">{project.state.stage.replaceAll("-", " ")}</p>
      <h1>{label}…</h1>
      <p>
        Fulcrum is preserving the provider job and will reconcile it without
        creating duplicate spend.
      </p>
    </main>
  );
}

function StudioGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="studio-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-guide-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="guide-header">
          <p className="eyebrow">Studio guide</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Studio guide"
          >
            ×
          </button>
        </div>
        <h2 id="studio-guide-title">
          Studio is a production checkpoint, not a chat.
        </h2>
        <p className="guide-intro">
          A run moves artifacts from left to right. Fulcrum automates production
          between checkpoints; you approve the creative decisions that should
          become immutable project truth.
        </p>
        <ol className="guide-steps">
          <li>
            <span>01</span>
            <div>
              <strong>Start from a brief</strong>
              <p>
                Replay proves the workflow locally. Live prefers your OpenAI
                subscription for orchestration and ImageGen, falls back to API
                routes when needed, and uses your selected 3D provider.
              </p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Approve visual direction</strong>
              <p>
                The concept, visual bible, exact revision, and content hash are
                shown together.
              </p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Inspect the visual slice</strong>
              <p>
                The GLB must pass deterministic QA before it appears in the
                interactive scene.
              </p>
            </div>
          </li>
        </ol>
        <div className="guide-resume">
          <strong>Why did Studio open in the middle?</strong>
          <p>
            It automatically resumes the most recently updated local run. Use
            the project selector to switch runs or <em>New run</em> to return to
            the brief.
          </p>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [configuration, setConfiguration] =
    useState<ConfigurationStatus | null>(null);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [guideOpen, setGuideOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      api<ConfigurationStatus>("/api/configuration"),
      api<ProjectSnapshot[]>("/api/projects"),
    ])
      .then(([config, projects]) => {
        setConfiguration(config);
        setProjects(projects);
        setProject(projects[0] ?? null);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  useEffect(() => {
    if (!project || project.state.status !== "active") return;
    const timer = window.setTimeout(() => {
      void api<ProjectSnapshot>(
        `/api/projects/${project.state.projectId}/advance`,
        { method: "POST" },
      )
        .then(setProject)
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [project]);

  const directionDecision = async (input: ApprovalInput) => {
    if (!project) return;
    const updated = await api<ProjectSnapshot>(
      `/api/projects/${project.state.projectId}/approvals/visual-direction`,
      { method: "POST", body: JSON.stringify(input) },
    );
    setProject(updated);
    setProjects((current) =>
      current.map((candidate) =>
        candidate.state.projectId === updated.state.projectId
          ? updated
          : candidate,
      ),
    );
  };
  const sliceDecision = async (input: ApprovalInput) => {
    if (!project) return;
    const updated = await api<ProjectSnapshot>(
      `/api/projects/${project.state.projectId}/approvals/visual-slice`,
      { method: "POST", body: JSON.stringify(input) },
    );
    setProject(updated);
    setProjects((current) =>
      current.map((candidate) =>
        candidate.state.projectId === updated.state.projectId
          ? updated
          : candidate,
      ),
    );
  };

  if (error)
    return (
      <div className="fatal">
        <strong>Fulcrum could not start.</strong>
        <span>{error}</span>
      </div>
    );
  if (!configuration)
    return (
      <div className="boot">
        FULCRUM <span>initializing</span>
      </div>
    );
  if (!project)
    return (
      <>
        <EmptyState
          configuration={configuration}
          onCreated={(created) => {
            setProject(created);
            setProjects((current) => [created, ...current]);
          }}
          onExplain={() => setGuideOpen(true)}
        />
        {guideOpen && <StudioGuide onClose={() => setGuideOpen(false)} />}
      </>
    );

  return (
    <div className="app-shell">
      <header>
        <div className="wordmark">
          <span>F</span>FULCRUM
        </div>
        <StatusRail project={project} />
        <div className="run-meta">
          <span className={`mode ${project.state.mode}`}>
            {project.state.mode}
          </span>
          <select
            aria-label="Current Fulcrum project"
            value={project.state.projectId}
            onChange={(event) => {
              const selected = projects.find(
                ({ state }) => state.projectId === event.target.value,
              );
              if (selected) setProject(selected);
            }}
          >
            {projects.map((candidate) => (
              <option
                key={candidate.state.projectId}
                value={candidate.state.projectId}
              >
                {candidate.state.projectId.slice(0, 8)} ·{" "}
                {candidate.state.stage}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setProject(null)}>
            New run
          </button>
          <button type="button" onClick={() => setGuideOpen(true)}>
            Guide
          </button>
        </div>
      </header>
      {project.state.stage === "visual-direction-approval" && (
        <DirectionReview project={project} onDecision={directionDecision} />
      )}
      {project.state.stage === "visual-slice-approval" && (
        <SliceReview
          project={project}
          onRefresh={setProject}
          onDecision={sliceDecision}
        />
      )}
      {project.state.status === "active" && (
        <ProductionView project={project} />
      )}
      {project.state.stage === "complete" && <CompleteView project={project} />}
      {project.state.stage === "blocked" && (
        <main className="complete-view">
          <p className="eyebrow">Production blocked</p>
          <h1>{project.state.blockedReason?.code}</h1>
          <p>{project.state.blockedReason?.message}</p>
        </main>
      )}
      {guideOpen && <StudioGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
