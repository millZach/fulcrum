# Fulcrum M1 Implementation Prompt

You are implementing Fulcrum's approved creative-to-concept generalization milestone.

## Read first

Read these files in order before changing code:

1. `VISION.md`
2. `PRODUCT_SPEC.md`
3. `ARCHITECTURE.md`
4. `milestones/M1.md`

`milestones/M1.md` controls current scope. When broader product ambition conflicts with its proof bounds, M1 wins.

## Current objective

Implement this durable workflow while preserving the M0 replay path:

```text
varied game brief
    ↓
dependency-driven Grill Me With Docs interview
    ↓
confirmed and approved Game Design Spec
    ↓
three visual directions → one approved Visual Bible
    ↓
demand-driven concepts with inherited visual tokens
    ↓
approved concept set
```

## Implementation rules

- Keep `grill-with-docs`, `grilling`, and `domain-modeling` bundled and verified in the background. Do not expose skill installation or package names in normal Studio use.
- Ask every question on the currently unblocked decision-tree frontier and include a recommendation for each. Do not impose a question or round limit; completion requires an empty frontier and explicit shared-understanding confirmation.
- Keep project truth in immutable, content-addressed revisions. State stores references and selections, never prompts, image bytes, secrets, or conversational history.
- Record fact and assumption origin, project glossary terms, and only qualifying ADRs.
- Present exactly three directions for M1 acceptance. Permit one unselected replacement, one focused selected-direction change with pinned aspects, and one regeneration per concept slot.
- Compile concept prompts from approved revision references and relevant structured visual tokens. Store ancestor revision IDs and SHA-256 hashes; omit unrelated history.
- Invalidate only descendants of a changed ancestor and never delete superseded revisions.
- Keep M0 routing and persisted projects valid. M1 ends at an approved concept set; do not invoke 3D, scene, or gameplay production.
- Journal and budget every live provider request before submission. Never repeat an ambiguous paid request automatically.
- Keep the Studio focused on the current decision. Prototype three structurally different interactions in replay mode and obtain human selection before promoting one to production.

## Verification

After every slice:

1. Run TypeScript, tests, build, formatting, and diff-integrity checks.
2. Exercise the affected workflow through its real interface.
3. Restart during interrogation and after direction selection to verify durable recovery.
4. Inspect Studio in the collaborative browser at desktop and mobile sizes.
5. Keep the M0 replay regression green.

Ordinary checks remain deterministic and offline. Do not claim M1 completion until the user has selected the production interaction and explicitly authorized a budget-capped live creative-to-concept run.

## Human decisions

Pause only for:

- Selection of the production Studio interaction
- Approval of the Game Design Spec, visual direction, or concept set during the live run
- Missing provider access or explicit authorization for metered live work
- A provider limitation that invalidates an approved M1 decision

At handoff, report what is implemented, replay and live evidence, tests and browser inspection, provider cost and elapsed time, accepted limitations, and every remaining acceptance criterion.
