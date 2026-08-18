# Fulcrum M0 Implementation Prompt

You are implementing Fulcrum, an open-source AI-native game production system.

## Read first

Read these files in order before changing code:

1. `VISION.md`
2. `PRODUCT_SPEC.md`
3. `ARCHITECTURE.md`
4. `milestones/M0.md`

`VISION.md` explains the enduring intent. `milestones/M0.md` controls current scope. When long-term ambition conflicts with M0 scope, M0 wins.

## Current objective

Implement the complete M0 walking skeleton:

```text
game brief
    ↓
structured creative revision
    ↓
reviewable concept image
    ↓
immutable human approval
    ↓
real image-to-3D job
    ↓
local GLB and deterministic QA
    ↓
Fulcrum Scene Spec
    ↓
rendered Three.js review scene
    ↓
immutable visual-slice decision
```

The default live path uses the user's signed-in OpenAI subscription through Codex for orchestration, Codex ImageGen with GPT Image 2 for concept imaging, and Meshy for image-to-3D. When a subscription capability is unavailable, default to the matching OpenAI API route and request its configuration. Claude, Grok, and OpenCode subscriptions remain selectable execution adapters. The independently selected implementation provider is controlled by the orchestrator and is persisted now, but M0 must not invent an implementation stage that does not yet exist. Concept imaging may also use an explicitly configured OpenAI-compatible image API or no image model. Tripo remains the alternate 3D adapter. Keep provider details behind the internal seams defined in `ARCHITECTURE.md`.

## Implementation rules

- Implement M0 only. Do not begin M1–M7 work.
- Keep project truth independent from Mastra snapshots and conversational history.
- Store large outputs as immutable artifacts and pass references through workflow state.
- Give every external production request a Fulcrum idempotency key, durable submission journal, and budget check. Never auto-resubmit an ambiguous provider call.
- Use deep domain modules. Workflow nodes coordinate modules; they do not reproduce provider procedures.
- Use deterministic code for schemas, persistence, hashes, GLB facts, budget enforcement, and state transitions.
- Use model judgment only for structured creative development and later semantic evaluation.
- Add deterministic replay adapters for ordinary tests, but do not claim M0 completion until the live smoke test succeeds.
- Do not create placeholder graph nodes that report imaginary production.
- Do not build generated characters, rigging, combat, Blender refinement, additional engines, or the Gauntlet.
- Do not create one package per workflow node. Add a package only when it creates a real seam or coherent ownership.
- Preserve provider/model configuration and generated-file rights metadata in provenance without storing credentials.
- Keep the browser UI clean and focused on the current artifact, lineage, state, cost, and approval decision.

## Work sequence

Follow the implementation sequence in `milestones/M0.md`. After every slice:

1. Run the relevant tests and static checks.
2. Start the affected application locally.
3. Exercise the behavior through its real interface.
4. Visually inspect UI or rendered changes in the browser.
5. Keep the repository runnable.

Do not defer visual inspection until the end.

## Decisions that require user input

Ask only when work cannot continue safely without one of the following:

- Missing provider credentials or account access for the live smoke test
- A material change to the M0 product behavior or acceptance criteria
- A provider limitation that invalidates the chosen real path
- Approval of a generated concept or final visual slice
- Authorization for spending beyond the configured project budget

Infer ordinary implementation details, record consequential assumptions, and continue.

## Completion contract

M0 is complete only when every acceptance criterion in `milestones/M0.md` is either demonstrated or explicitly documented as blocked by an external prerequisite. A passing offline test suite alone is insufficient.

At handoff, report:

- What the user can run and see
- Live and replay paths exercised
- Tests and visual checks performed
- Provider cost and elapsed time for the recorded run
- Known limitations and failed approaches
- Exact remaining acceptance criteria, if any
