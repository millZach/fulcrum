# Fulcrum

**From creative intent to playable worlds.**

Fulcrum is an open-source, AI-native game production system. It is designed to let a human act as creative director while coordinated production workflows handle the many lower-level decisions required to turn a game brief into a coherent, polished, playable experience.

The initial north star is to transform a detailed natural-language brief into a visually coherent and genuinely fun 5–10 minute vertical slice with minimal human intervention.

## Core principles

- Keep high-leverage creative decisions with the human.
- Treat approved concepts as persistent visual ground truth.
- Orchestrate production at the macro level and keep specialist loops bounded.
- Represent scenes independently from any one game engine.
- Use deterministic evaluation for measurable facts and visual models for semantic judgment.
- Preserve best-known states and make every important decision traceable.

## First proof

```text
game brief
    ↓
visual bible
    ↓
approved concept image
    ↓
generated and validated 3D asset
    ↓
coherent Three.js scene
```

Fulcrum is currently implementing M0. The deterministic replay path already runs locally from brief to visual-direction approval, generated GLB, QA, Three.js review, captured review image, and final decision. The live model-backed orchestrator + Meshy acceptance run is still required before M0 can be called complete; Tripo is available as an alternate 3D adapter.

## Run M0 locally

Requirements: Node.js 24+ and pnpm 11+.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:4311`, keep **Replay** selected, and begin the fixture run. Replay mode is offline, deterministic, and does not require provider credentials.

For the live path, Fulcrum automatically uses a signed-in OpenAI subscription through Codex when one is available. Otherwise Studio selects the OpenAI API fallback and identifies the required `OPENAI_API_KEY` configuration; Claude Code, Grok Build, and OpenCode subscriptions remain selectable alternatives. Concept imaging follows the same subscription-first rule: Codex ImageGen with GPT Image 2 is the default when available, followed by the GPT Image 2 API, a custom image API, or no image model. Copy `.env.example` to `.env` for API-backed services and a positive M0 cost cap. Meshy is the default 3D provider; Tripo is the alternate.

Quality checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

## Project documents

- [Vision](VISION.md) — enduring product purpose and non-negotiable principles
- [Product specification](PRODUCT_SPEC.md) — intended workflows and behavior
- [Architecture](ARCHITECTURE.md) — state ownership, module interfaces, Scene Spec, and technical decisions
- [Roadmap](ROADMAP.md) — staged path from the first proof to the Gauntlet
- [M0 implementation contract](milestones/M0.md) — the current bounded walking skeleton
- [Implementation prompt](IMPLEMENTATION_PROMPT.md) — the short execution contract for an implementation agent

Implementation begins with M0: one real, immutable lineage from a game brief through an approved concept and generated 3D hero prop into a rendered Three.js review scene.

## License

Fulcrum is released under the [MIT License](LICENSE).
