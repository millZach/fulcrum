# Fulcrum Product Specification

## 1. Product contract

Fulcrum accepts a natural-language game brief and develops it into structured, versioned production artifacts. The system is successful when it preserves the human's intent while removing low-leverage production work.

The product has two operating modes:

- **Directed mode:** the user can inspect, redirect, regenerate, or approve important revisions.
- **Autonomous mode:** between approvals, Fulcrum executes bounded production and refinement loops without prompting for trivial decisions.

Every user-visible output must be traceable to the brief, approved creative revisions, provider inputs, and the run that produced it.

### 1.1 Execution roles

Each run selects two execution roles independently:

- **Orchestrator model:** owns planning, task decomposition, worker selection, result review, and workflow decisions.
- **Implementation model:** receives bounded code or content-production tasks from the orchestrator when a milestone contains implementation work.

Claude Code, Codex, Grok Build, and OpenCode are supported subscription execution surfaces. Fulcrum invokes their locally authenticated clients and never asks the user to copy subscription credentials into project configuration. When no signed-in OpenAI subscription is available, Fulcrum selects an OpenAI API execution route and requests its API configuration instead. Concept imaging is a separate optional role with the same preference order: Codex ImageGen through the signed-in OpenAI subscription, GPT Image 2 through the OpenAI API, an explicitly configured OpenAI-compatible image API, or no image model.

## 2. Creative development

### 2.1 Game brief

A project begins with a detailed natural-language request. Fulcrum stores the original brief immutably and derives a structured project revision from it.

The first structured game-design representation includes, when relevant:

- Core fantasy and gameplay loop
- Genre, camera, and target session length
- Player verbs, movement, and combat
- Win and failure conditions
- Level and encounter structure
- Enemy and interaction models
- Controls, difficulty, rewards, and progression
- Narrative expectations
- Visual intent and gameplay-driven visual constraints

### 2.2 Design interrogation

Fulcrum infers reasonable defaults, records them as assumptions, researches discoverable facts, and asks the user only for consequential decisions.

M1 runs Grill Me With Docs as an internal capability. It maps the project as a decision tree, asks the whole currently unblocked frontier with a recommendation for every question, and recomputes the frontier after each answer round. There is no arbitrary question or round limit: interrogation ends only when the frontier is empty and the user explicitly confirms shared understanding. Stable project terminology is recorded in the glossary while only qualifying, hard-to-reverse tradeoffs receive an ADR.

The resulting Game Design Spec records facts and assumptions with their origin. It is immutable; changes create a new revision and invalidate affected descendants.

### 2.3 Visual Director

The Visual Director consumes the game brief, Game Design Spec, reference images, genre expectations, camera perspective, and gameplay constraints. It produces a versioned Visual Bible containing:

- Overall style and prohibited styles
- Shape and silhouette language
- Architecture, characters, and prop language
- Material and texture language
- Canonical palette and contrast hierarchy
- Lighting and atmosphere
- Environment density and visual hierarchy
- Camera language
- VFX language
- Scale references and gameplay readability constraints

The Visual Bible contains structured tokens as well as prose. Downstream modules receive only the portions relevant to their work.

### 2.4 Concept planning and generation

Fulcrum decides which concepts are necessary for the requested slice. Possible categories include hero environment, key gameplay space, player character, enemy, NPC, signature weapon, hero prop, architecture kit, materials, and lighting.

Concept categories are demand-driven, not a fixed checklist. Important 3D assets may receive front, side, rear, and three-quarter concepts when a provider can benefit from consistent multiview inputs.

Each generated concept revision records:

- Source brief, Game Design Spec, and Visual Bible revisions
- Prompt and negative constraints
- Reference artifact hashes
- Provider, model, provider version, and seed when available
- Creation time, cost, and run ID
- Content and licensing metadata available from the provider

### 2.5 Concept approval

Concept approval is an explicit workflow suspension. The user can:

- Approve all proposed concepts
- Select an alternative
- Reject the direction
- Regenerate one concept
- Preserve selected materials while changing architecture
- Apply semantic direction such as “less steampunk” or “more vertical”

Feedback produces new Visual Bible or concept revisions. Approved revisions never mutate in place.

## 3. Production

### 3.1 Asset planning

The Asset Planner converts the approved slice into an explicit dependency graph. Every planned asset has a production strategy:

- **Hero:** close or identity-defining assets receiving the highest-quality path
- **Reusable kit:** modular walls, doors, rocks, furniture, vegetation, and similar repeatable forms
- **Procedural:** grass, debris, fog, particles, terrain variation, rubble, and other high-volume dressing
- **Functional:** collision volumes, triggers, spawn points, interaction zones, and placeholders that do not justify generation cost

The plan records reuse, level ownership, target budgets, required views, animation or rig needs, and approved concept sources.

### 3.2 Asset production

Asset production prefers approved image-to-3D or multiview-to-3D for visually important assets. Text-to-3D remains available when fidelity or lineage does not justify concept generation.

Providers are replaceable behind an internal seam. The workflow asks the Asset Production module for a domain outcome; it does not orchestrate vendor-specific operations such as remeshing, texturing, polling, or file download.

Every live request has a Fulcrum idempotency key and durable submission record, is cancellable when the provider permits it, and is bounded by project policy. If a provider cannot reconcile an ambiguous submission, Fulcrum blocks for user direction instead of silently purchasing a duplicate.

### 3.3 Asset quality

Generated assets cannot enter an approved scene until they pass deterministic gates and receive a semantic evaluation.

Deterministic checks include:

- Valid and parseable file
- Polygon and vertex counts
- Bounding box and scale
- UV, normal, material, texture, component, and animation presence
- Texture resolution and file-size budgets
- Non-manifold or invalid geometry when tooling supports it
- Rig and animation metadata when required

Semantic findings may cover:

- Reference similarity
- Silhouette and proportions
- Material coherence
- Surface quality
- Style consistency
- Missing geometry and visible artifacts

Results are evidence-backed findings, not a single opaque quality score.

### 3.4 Asset refinement

Failed assets can be regenerated, routed to another provider, or refined through Blender or another DCC adapter. Refinement commands are semantic—such as “blade too short” or “roof angle too shallow”—and are translated into structured operations. LLMs do not directly manipulate thousands of vertices.

Blender is a production and inspection backend, not the product architecture. It may provide mesh cleanup, material fixes, rendering, format conversion, rigging hooks, and turntables.

### 3.5 Scene composition

The Scene Composer produces a Fulcrum Scene Spec revision from approved assets and gameplay requirements. It is responsible for environment structure, composition, placement, prop density, lighting, camera, fog, procedural dressing, terrain, and visual hierarchy.

Scene composition must respect deterministic spatial constraints such as encounter spacing, navigation clearance, interaction reach, and camera visibility. Gameplay requirements constrain the scene; visual discoveries that imply new mechanics are proposals to the creative layer, never silent design changes.

### 3.6 Visual evaluation and approval

The Three.js runtime renders the Scene Spec from defined viewpoints. Evaluation first classifies each issue as asset, geometry, material, lighting, camera, composition, environment, density, VFX, or style consistency. The finding is routed to the module that owns the cause.

After bounded improvement, Fulcrum suspends for visual-slice approval. User feedback creates new revisions and invalidates affected descendants.

## 4. Gameplay implementation

After visual-slice approval, the Implementation Planner consumes the Game Design Spec, approved Scene Spec, and approved visual revisions. It plans only the mechanics required for the target slice:

- Player movement, camera, and input
- Interaction and combat
- Enemy behavior
- Objectives, UI, and required progression
- Save or session state when needed
- Audio and VFX hooks

Fulcrum should implement a 5–10 minute experience, not expand automatically into a complete game.

## 5. Gauntlet

The eventual Gauntlet evaluates a playable build across three independent dimensions.

### Visual

Visual coherence, asset quality, lighting, composition, animation presentation, VFX, readability, density, and style consistency.

### Gameplay

Movement and camera feel, responsiveness, combat, enemy behavior, loop clarity, difficulty, pacing, rewards, friction, and fun. Gameplay judgment requires instrumentation and play-capable evaluation; screenshots alone cannot establish it.

### Technical

FPS, frame-time spikes, memory, loading, draw calls, asset size, texture budgets, runtime errors, broken interactions, navigation failures, and regressions.

Gauntlet outputs become versioned findings with evidence, severity, confidence, estimated cost, dependencies, and regression risk. A prioritizer selects the highest-value fixes. Human playtesting remains authoritative for fun until automated gameplay evaluation is demonstrably calibrated.

## 6. Revision and best-state behavior

Fulcrum retains the best-known visual, gameplay, technical, scene, and asset revisions. Comparison uses a vector of gates and rubric dimensions rather than one global score. A human can pin or restore any viable revision.

Repeated reversal of the same parameter or diagnosis is oscillation. On detection, Fulcrum stops the strategy, restores the best-known revision, records the failed approaches, and re-diagnoses.

## 7. Studio experience

The Studio eventually exposes:

- Game brief and Game Design Spec
- Visual Bible and concept revisions
- Approval and invalidation status
- Asset dependency graph and asset previews
- Scene preview and current workflow node
- Evaluation findings, budgets, costs, and active work
- Playable builds and best-known checkpoints

The initial Studio is intentionally small. It must make the real workflow observable and make approval safe; it does not need to expose every future control.

## 8. Observability and operational contract

Every important operation records:

- Node and run identifiers
- Input and output revision references
- Structured routing summary
- Provider and model identifiers
- Tool calls and generated artifacts
- Findings and state changes
- Attempts, elapsed time, and cost when available
- Checkpoint, failure, cancellation, and termination reason

Logs contain concise decision summaries, not hidden model reasoning. Secrets and sensitive provider payloads are redacted.

External failures include timeouts, rate limits, API errors, refusals, corrupt files, missing assets, invalid GLBs, and runtime errors. Retries are bounded. Repeated failure changes strategy or returns an actionable blocked state.

No live run begins without an explicit limit for cost, elapsed time, attempts, and concurrency. Generated artifacts retain provider provenance and available rights metadata.
