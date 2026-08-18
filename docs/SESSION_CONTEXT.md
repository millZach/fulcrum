# Fulcrum session context

Written 2026-08-18. This reflects the project state on that date and may be stale; the repository documentation and Git history take precedence wherever they disagree.

## Repository state

- Repository: `millZach/fulcrum`.
- The completed M0 implementation work is captured in [PR #1](https://github.com/millZach/fulcrum/pull/1), merged as commit `691de69`. The pre-squash implementation commit was `e1092d3`.
- Local databases, generated workspace artifacts, and `handoff/HANDOFF.md` are intentionally ignored and must not be committed.

## Canonical project context

Read these before changing scope:

- `README.md` for setup and the current status summary.
- `VISION.md`, `PRODUCT_SPEC.md`, and `ARCHITECTURE.md` for product and system intent.
- `milestones/M0.md` for the active milestone contract and acceptance criteria.
- `IMPLEMENTATION_PROMPT.md` for the bounded implementation contract.
- `ROADMAP.md` for later milestones; do not begin M1 work merely because the M0 skeleton exists.
- `notes.md` for the two non-obvious implementation lessons already discovered.

## What was completed

PR #1 established the M0 workspace, Studio, orchestrator, durable SQLite/artifact state, deterministic replay, provider selectors, subscription-first OpenAI/Codex routes, Meshy and Tripo adapters, review flow, documentation, and tests. Generated databases and workspace artifacts are excluded from Git.

The last full verification passed:

- `pnpm typecheck`
- `pnpm test` — 12 tests
- `pnpm build`
- `pnpm format:check`
- Browser walkthrough of the Studio replay flow

No paid live ImageGen or 3D-provider job was run.

## Decisions and conversational context

- The project name is **Fulcrum** and the repository is MIT licensed. Naming uniqueness is not a concern.
- Meshy is the default 3D provider; Studio exposes Tripo as the alternate.
- Orchestrator and implementation providers are independently selectable subscription clients. Image generation defaults to the signed-in OpenAI/Codex subscription when available and otherwise offers the OpenAI API fallback. Exact behavior is documented in `milestones/M0.md`.
- Replay is intentionally a deterministic reliquary fixture. Its GLB is not regenerated from the user-entered brief, so changing the prompt does not change that model. Zach explicitly said this non-shipping fixture does not need generalization right now; do not spend time replacing it unless he asks.
- Zach prefers clean, visual Studio explanations and browser inspection over dense instructional copy.

## Remaining M0 boundary

M0 is not complete merely because the skeleton merged. Per `milestones/M0.md`, completion still requires one budget-capped live run through a real model-backed creative route and Meshy (or the selected real 3D provider), plus the resulting acceptance evidence and exit artifacts.

Do not initiate a paid provider run without Zach explicitly authorizing the spend and supplying/configuring the required credentials and positive budget cap. Never place credentials in project state, logs, commits, `notes.md`, or session-context documents.

No next implementation objective was selected in this session. Begin the next session by confirming whether Zach wants to perform the live M0 acceptance run, improve Studio clarity, or start a different task.

## Suggested skills

- `browser:control-in-app-browser` — inspect and exercise Studio visually at `http://localhost:4311/` after starting both services.
- `diagnosing-bugs` — use if subscription detection, live provider execution, recovery, or prompt behavior fails.
- `github:yeet` — publish a future completed change set through a reviewed branch and PR.
- `blender-model` — reserve for an explicitly requested Blender asset/refinement task; it is outside M0’s current scope.
