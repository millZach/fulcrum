# Fulcrum Architecture

## 1. Architectural objective

Fulcrum is a durable production workflow around versioned creative and technical artifacts. The architecture optimizes for one real end-to-end path first, then deepens that path without coupling project truth to a model provider, DCC tool, workflow framework, or runtime engine.

## 2. Architectural vocabulary

- A **module** owns behavior behind one interface.
- An **interface** includes types, invariants, ordering, error modes, configuration, and performance expectations.
- A **seam** is the location where an implementation can vary.
- An **adapter** satisfies an interface at a seam.
- A module is **deep** when callers receive substantial behavior through a small interface.

Workflow nodes call deep domain modules. They do not reproduce provider procedures, persistence rules, retry policy, or validation logic.

## 3. Sources of truth

Fulcrum separates four forms of state:

```text
Project state
  Mutable pointers to current, approved, best, and stale revisions

Artifact store
  Immutable images, JSON documents, GLBs, renders, builds, and metadata

Run/event log
  Append-only record of operations, decisions, costs, and transitions

Workflow snapshot
  Mastra-owned execution data required to suspend and resume a run
```

Mastra snapshots are never project truth. A workflow may be discarded and reconstructed from project state, the event log, and idempotent operations.

M0 uses SQLite for project state and the event log, plus a local filesystem artifact store. They may share one physical SQLite database initially but must not share workflow-framework tables or interfaces.

## 4. Identity and immutability

Every persisted domain object has a stable logical ID and immutable revision ID. Artifact content is addressed by SHA-256. Mutable project state points to revisions; it never changes revision content.

```ts
type ArtifactRef = {
  artifactId: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
  uri: string;
};

type RevisionRef = {
  entityId: string;
  revisionId: string;
  artifact: ArtifactRef;
  createdAt: string;
  createdByRunId: string;
};
```

Large payloads are artifacts. Project state contains references and compact summaries.

## 5. Core project state

```ts
type ProjectState = {
  schemaVersion: 1;
  projectId: string;
  name: string;
  status: "active" | "awaiting-approval" | "blocked" | "complete";

  orchestratorProvider:
    "claude" | "openai" | "openai-api" | "grok" | "opencode";
  implementationProvider:
    "claude" | "openai" | "openai-api" | "grok" | "opencode";
  imageProvider:
    "openai-subscription" | "openai-gpt-image-2" | "custom-api" | "none";

  brief: RevisionRef;
  gameDesign?: VersionSelection;
  visualBible?: VersionSelection;
  concepts: Record<string, VersionSelection>;
  assetPlan?: VersionSelection;
  assets: Record<string, VersionSelection>;
  scene?: VersionSelection;
  build?: VersionSelection;

  activeIssues: string[];
  activeRunIds: string[];
  updatedAt: string;
};

type VersionSelection = {
  current: RevisionRef;
  approved?: RevisionRef;
  best?: RevisionRef;
  staleReason?: string;
};
```

Schemas are versioned and validated at every process boundary. Migrations are explicit.

## 6. Provenance

Each generated revision records a provenance manifest:

```ts
type Provenance = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceArtifactHashes: string[];
  runId: string;
  operation: string;
  provider?: string;
  model?: string;
  providerVersion?: string;
  seed?: string;
  promptArtifact?: ArtifactRef;
  rights?: {
    sourceOwnershipConfirmed?: boolean;
    providerTermsUrl?: string;
    notes?: string;
  };
  costUsd?: number;
  createdAt: string;
};
```

The dependency graph is derived from provenance. Changing or rejecting an ancestor marks descendants stale; it does not delete them.

## 7. Approvals

Approvals target exact immutable content.

```ts
type ApprovalDecision = {
  approvalId: string;
  projectId: string;
  targetType:
    | "game-design"
    | "visual-direction"
    | "concept"
    | "visual-slice"
    | "major-design-change";
  targetRevisionId: string;
  targetSha256: string;
  decision: "approved" | "rejected" | "changes-requested";
  notes?: string;
  decidedBy: string;
  decidedAt: string;
};
```

An approval cannot be transferred to a new revision. The Approval Registry verifies the hash before accepting a decision. M0 conservatively marks every descendant of a superseded approved revision stale. Later milestones may add field-level impact analysis.

## 8. Deep domain modules

The workflow-facing surface is intentionally small.

```ts
interface CreativeDevelopment {
  develop(input: CreativeDevelopmentInput): Promise<CreativeRevisionSet>;
}

interface ConceptProduction {
  ensure(
    request: ConceptProductionRequest,
  ): Promise<ProductionOutcome<ConceptSet>>;
}

interface ApprovalRegistry {
  decide(command: ApprovalCommand): Promise<ApprovalDecision>;
}

interface AssetProduction {
  ensure(
    request: AssetProductionRequest,
  ): Promise<ProductionOutcome<AssetRevision>>;
}

interface AssetQuality {
  evaluate(asset: AssetRevision, policy: AssetPolicy): Promise<AssetEvaluation>;
}

interface SceneAuthoring {
  compose(input: SceneCompositionInput): Promise<SceneRevision>;
}

interface RuntimeBuilder {
  build(scene: SceneRevision, target: RuntimeTarget): Promise<BuildRevision>;
}

interface VisualEvaluation {
  evaluate(input: VisualEvaluationInput): Promise<EvaluationReport>;
}
```

`ensure` is idempotent at the Fulcrum interface. It may return `pending` with a recommended resume time, `ready` with an immutable revision, or `failed` with a typed terminal reason. Repeating a completed request returns its existing revision. Repeating a pending request reconciles its recorded external job.

Every external submission is journaled before and after the provider call. When a provider offers an idempotency mechanism, the adapter forwards Fulcrum's key. When a crash leaves submission status unknowable and the provider has no reconciliation mechanism, the request enters `submission-unknown` and requires user direction; Fulcrum does not automatically risk duplicate spend.

```ts
type ProductionOutcome<T> =
  | { status: "pending"; requestId: string; resumeAfter: string }
  | { status: "ready"; requestId: string; value: T }
  | { status: "failed"; requestId: string; error: ProductionFailure };
```

## 9. External provider seams

Provider ports are internal to the deep modules that own them. Workflow code never imports these ports directly.

```ts
interface StructuredGenerationPort {
  generate<T>(request: StructuredGenerationRequest<T>): Promise<T>;
}

interface ImageGenerationPort {
  generate(
    request: ImageGenerationJob,
    idempotencyKey: string,
  ): Promise<GeneratedImage>;
}

interface AssetGenerationPort {
  submit(
    request: AssetGenerationJob,
    idempotencyKey: string,
  ): Promise<ExternalJobRef>;
  inspect(job: ExternalJobRef): Promise<ExternalJobState>;
  cancel(job: ExternalJobRef): Promise<void>;
}

interface VisionEvaluationPort {
  evaluate(request: VisionRequest): Promise<VisionFindings>;
}
```

The first production adapter and a deterministic replay adapter establish each external seam. Replay adapters use captured, licensed fixtures and make tests fast and offline. A milestone is not complete until its live acceptance test succeeds through a real adapter.

Provider-specific capabilities such as multiview input, remeshing, texture generation, or refinement remain inside provider adapters and routing policy. The workflow requests a domain result rather than a vendor feature.

## 10. Fulcrum Scene Spec v0

The Scene Spec is Fulcrum's authored semantic representation. It is not a universal serialization of every engine feature.

```ts
type FulcrumSceneSpecV0 = {
  schema: "fulcrum.scene";
  version: 0;
  sceneId: string;
  units: "meters";
  coordinates: {
    handedness: "right";
    up: "+Y";
    forward: "-Z";
  };
  environment: EnvironmentSpec;
  camera: CameraSpec;
  lighting: LightSpec[];
  entities: SceneEntity[];
  systems: SystemIntent[];
  navigation: NavigationIntent;
  spawnPoints: SpawnPoint[];
  interactionZones: InteractionZone[];
  extensions?: Record<string, unknown>;
};

type SceneEntity = {
  id: string;
  name: string;
  assetRevisionId?: string;
  transform: {
    position: [number, number, number];
    rotationEulerRadians: [number, number, number];
    scale: [number, number, number];
  };
  tags: string[];
  visual?: Record<string, unknown>;
  gameplay?: Record<string, unknown>;
};
```

The Three.js Runtime Builder validates the spec, resolves approved asset revisions, reports unsupported intent, and produces a browser build. Runtime-specific extensions are namespaced and never required to understand the portable core.

Only the Three.js implementation exists initially. A runtime adapter registry is deferred until a second real runtime exists.

## 11. Evaluation model

Deterministic validators produce gates and measurements. Semantic critics produce findings.

```ts
type EvaluationFinding = {
  findingId: string;
  rubricVersion: string;
  category:
    | "asset"
    | "geometry"
    | "materials"
    | "lighting"
    | "camera"
    | "composition"
    | "environment"
    | "density"
    | "vfx"
    | "style"
    | "gameplay"
    | "technical";
  summary: string;
  evidenceArtifactIds: string[];
  severity: "info" | "minor" | "major" | "critical";
  confidence: number;
  ownerModule: string;
  suggestedAction?: string;
};
```

Evaluators may expose dimension scores for comparison, but no single scalar is authoritative. Best-state selection keeps the entire evaluation vector and supports human pinning.

## 12. Workflow graph

### M0 graph

```text
START
  ↓
ingest_game_brief
  ↓
develop_creative_direction
  ↓
produce_concepts
  ↓
AWAIT VISUAL-DIRECTION APPROVAL
  ↓
plan_hero_asset
  ↓
produce_asset ──────────────┐
  │ pending → suspend       │
  │ retryable failure ──────┘
  ↓
evaluate_asset
  │ gate failure → one bounded regeneration
  ↓
compose_scene
  ↓
build_threejs_scene
  ↓
evaluate_visual_slice
  ↓
AWAIT VISUAL-SLICE APPROVAL
  ↓
COMPLETE M0
```

Each node receives revision references and the minimum required artifact context. Images and meshes never travel inside workflow snapshots.

### M1 creative graph

```text
START M1
  ↓
provision_internal_creative_capabilities
  ↓
interrogate_design_tree ← answer current frontier
  │ frontier remains ───────────────┘
  ↓ frontier empty + human confirms
AWAIT GAME-DESIGN APPROVAL
  ↓
produce_three_visual_directions
  ↓
AWAIT VISUAL-DIRECTION APPROVAL
  │ optional: replace one unselected direction
  │ optional: one focused change preserving pinned tokens
  ↓
plan_and_produce_concept_set
  │ optional: regenerate one revision per slot
  ↓
AWAIT CONCEPT-SET APPROVAL
  ↓
COMPLETE M1
```

M0 and M1 remain separate milestone state machines selected by persisted project milestone. M1 project state stores only revision references, selections, approvals, and proof-bound counters. The creative module owns decision-tree recomputation, visual tokens, prompt inheritance, and immutable creative artifacts; the coordinator owns stages, stale-command guards, approvals, and limits.

### Future macro graph

Future nodes may add multiview generation, asset batches, Blender refinement, gameplay implementation, playable builds, visual/gameplay/technical Gauntlets, prioritization, and improvement loops. Those nodes are added only when their preceding path works with real artifacts.

## 13. Budgets and failure behavior

Every run has:

- Maximum cost in USD
- Maximum elapsed time
- Maximum attempts per operation
- Maximum concurrent external jobs
- Cancellation token and terminal reason

The budget manager reserves estimated cost before submission and reconciles actual cost afterward. A live provider job cannot be submitted without a Fulcrum idempotency key, durable submission intent, and recorded budget reservation.

Failures are typed as retryable, strategy-changing, user-action-required, policy-blocked, or terminal. Retryable failures use bounded backoff. Authentication, missing budget, and rights confirmation failures never retry automatically.

## 14. Context and concurrency

Each workflow node receives a context envelope containing only required revision references, compact summaries, targeted images or crops, applicable policy, and recent relevant findings. Entire project histories, meshes, full scene graphs, and unrelated images are never sent to every model call.

Independent concept alternatives, assets, deterministic validators, and semantic critics may run in parallel when their inputs are immutable and they do not share an uncommitted dependency. Hidden dependencies force sequential execution. Project concurrency policy and remaining budget cap every parallel fan-out.

## 15. Security and rights

- Provider credentials exist only in runtime configuration and are never stored in project artifacts.
- Logs redact secrets, authorization headers, and provider payload fields designated sensitive.
- Reference uploads require an ownership or usage-rights acknowledgement.
- Provenance records available provider terms and model metadata.
- Local artifacts remain under the project workspace and are deletable by project.
- Remote deletion guarantees are provider-specific and must be surfaced accurately.

## 16. Testing strategy

Tests cross the same module interfaces as production callers.

- Schema and deterministic validator tests are pure and fast.
- Persistence tests use an isolated local SQLite database and temporary artifact store.
- External modules use deterministic replay adapters for normal CI.
- Adapter contract tests validate provider normalization independently.
- Runtime tests load a Scene Spec and assert observable rendered/runtime behavior.
- Live smoke tests are manual or explicitly enabled, budget-capped, and never run in ordinary CI.

Tests assert domain outcomes, persisted revisions, artifacts, and findings. They do not assert internal workflow or provider call sequences unless the sequence is itself an interface invariant.

## 17. Initial technology decisions

- **Language:** TypeScript for product, workflow, schemas, and Three.js integration
- **Workflow:** Mastra for the initial macro graph and human suspend/resume
- **Validation:** Zod schemas at process boundaries
- **Studio:** React and Vite
- **Runtime:** Three.js, wrapped so the Studio can embed the same renderer used by build output
- **Persistence:** SQLite for M0/M1 project and event state with filesystem artifacts
- **3D utilities:** Python only where Blender or geometry tooling makes it the deeper implementation
- **Package management:** pnpm workspace

The default live M0 path uses the user's signed-in OpenAI subscription through Codex for orchestration and Meshy for image-to-3D. If that subscription is unavailable, provider discovery selects the OpenAI API adapter and reports the missing API configuration. Claude Code, Codex, Grok Build, OpenCode, and the OpenAI API are concrete adapters behind one structured-execution interface. Subscription credentials remain owned by their clients; API secrets remain process configuration and are never persisted in project state.

Every run selects two execution roles. The **orchestrator model** owns planning, decomposition, review, and delegation. The independently selected **implementation model** receives bounded implementation tasks from the orchestrator in later milestones; M0 persists this choice but does not invoke it because M0 has no code-production node. This keeps control flow explicit without pretending that unimplemented production occurred.

Concept imaging is a separate optional seam. `openai-subscription` invokes Codex ImageGen with GPT Image 2 through the signed-in OpenAI subscription, `openai-gpt-image-2` uses the OpenAI image API, `custom-api` uses an explicitly configured OpenAI-compatible image endpoint, and `none` uses Fulcrum's deterministic concept renderer. Provider discovery prefers subscription ImageGen and falls back to the OpenAI API route when the capability is unavailable. Meshy and Tripo remain the two concrete Asset Production adapters. Exact selected routes and returned model identifiers are persisted in provenance; deterministic replay adapters keep ordinary tests offline.

Mastra remains an orchestration implementation. Long-running distributed execution may later use its Temporal integration or another durable adapter without changing domain interfaces.

## 18. Initial repository shape

Start with a small number of deep packages:

```text
/apps
  /studio                 browser UI and embedded preview
  /orchestrator           Mastra workflows and worker entrypoint

/packages
  /domain                 schemas, IDs, revisions, approvals, findings
  /project                project repository, artifact store, event log
  /creative               creative development and concept production
  /execution              provider detection and structured execution
  /production             asset planning, production, and quality
  /scene                  Scene Spec, composition, Three.js builder

/milestones
  M0.md
  M1.md

/workspace/projects       ignored local artifacts
```

Logical modules become separate packages only when doing so creates a real seam or independent ownership. Do not create a package for every future graph node.
