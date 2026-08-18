# Fulcrum Vision

## Purpose

Fulcrum is an open-source, AI-native game production system. It turns a relatively small amount of high-level human creative direction into a polished playable game by coordinating game design, visual development, asset production, scene construction, gameplay implementation, and evidence-driven refinement.

Fulcrum is not primarily a Blender agent, a Three.js generator, or a single coding agent. Those are tools and adapters inside a larger production system.

## North star

> Given a detailed natural-language game brief, autonomously produce a visually coherent, genuinely fun, polished 5–10 minute playable vertical slice with minimal human intervention.

Three.js is the first runtime because it enables fast browser iteration, rendering, screenshots, and testing. It is not the permanent architecture. Future runtime targets may include Godot, Unity, and Unreal Engine.

## Human role

The human acts as creative director. The human makes a small number of high-leverage decisions; Fulcrum handles the thousands of production decisions underneath them.

The intended experience is:

```text
Human describes a game
        ↓
Fulcrum identifies consequential uncertainties
        ↓
Game concept and mechanics become explicit
        ↓
Fulcrum proposes visual directions and concepts
        ↓
Human approves or redirects the visual ground truth
        ↓
Fulcrum plans, generates, validates, and refines assets
        ↓
Fulcrum assembles and improves a visual slice
        ↓
Human approves the visual slice
        ↓
Fulcrum implements gameplay
        ↓
Visual, gameplay, and technical evaluation drive iteration
        ↓
Polished vertical slice
```

The human should not need to manually manage asset placement, individual materials, mesh cleanup, implementation tickets, or repeated prompt handoffs between specialist tools.

## Product layers

```text
┌────────────────────────────────────────────┐
│              CREATIVE LAYER                │
│ concept · mechanics · visual direction     │
│ concept images · consequential approvals   │
└──────────────────────┬─────────────────────┘
                       ↓
┌────────────────────────────────────────────┐
│             PRODUCTION LAYER               │
│ visual bible · asset planning · 3D assets  │
│ refinement · scenes · gameplay · runtime   │
└──────────────────────┬─────────────────────┘
                       ↓
┌────────────────────────────────────────────┐
│              GAUNTLET LAYER                │
│ visual · gameplay · technical evaluation   │
│ prioritization · regression · improvement  │
└────────────────────────────────────────────┘
```

Graph engineering coordinates macro production decisions and dependencies. Bounded agent and tool loops perform local specialist work. Tiny implementation actions are never graph nodes.

## Non-negotiable principles

1. Concept-image generation and 3D asset generation are core workflow stages, not deferred integrations.
2. Approved visual concepts are versioned visual ground truth.
3. Important assets prefer approved image-to-3D or multiview-to-3D inputs over text-only generation.
4. Assets are classified as hero, reusable kit, procedural, or functional so production effort matches player impact.
5. Fulcrum owns an engine-independent authored scene specification; runtime adapters compile it for engines.
6. Three.js is the first runtime, not a permanent dependency of the production model.
7. The graph represents macro production decisions; local execution remains inside deep specialist modules.
8. Specialist loops are bounded by attempts, time, cost, and explicit termination conditions.
9. Deterministic tools measure facts; visual models judge semantic qualities.
10. Best-known revisions are retained. Newest does not mean best.
11. Oscillation restores the best revision and triggers re-diagnosis instead of endless reversal.
12. Human interruption is reserved for decisions with high downstream leverage.
13. Game design and visual design are distinct, connected systems with explicit interfaces.
14. The architecture permits future Grill Me-style interrogation and Gauntlet evaluation without coupling current work to them.
15. Fulcrum first optimizes for an exceptional vertical slice, not a complete AAA game.
16. Project truth is structured and persistent; conversational history is never the source of truth.
17. Every artifact and approval has immutable lineage.
18. Every live production loop has an explicit resource budget and can be cancelled safely.
19. Agents are used for open-ended judgment; deterministic modules and tools remain the default.
20. The first proof must use real providers and produce real files. Replay adapters support tests but do not satisfy the live acceptance criteria.

## Long-term outcome

Fulcrum should eventually accept many genres and visual styles, generate modular world kits, assemble gameplay-aware scenes, implement a small game, play and instrument builds, diagnose failures, and autonomously improve the result between a few explicit human approvals.

That destination does not justify building every abstraction today. Each milestone must deepen the proven path and leave behind a working product.
