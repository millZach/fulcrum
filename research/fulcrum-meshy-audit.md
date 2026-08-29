# Fulcrum Meshy integration audit

Audited on 2026-08-25 against the live M2 project, Fulcrum's current adapter, Meshcaster at commit `2cdd9729`, and Meshy's official API documentation.

## Executive answer

Fulcrum did not send a text prompt to Meshy for the M2 keeper or bridge. It sent four generated PNG references in this order: front, left, back, right. The prompts existed one stage earlier: Fulcrum used GPT Image to create those four references, then passed only their bytes to Meshy's Multi-Image to 3D endpoint.

The integration uses the correct broad route but wastes credits and loses semantic control:

1. It creates and textures each Meshy candidate in one 30-credit call, before geometry QA.
2. It uses Meshy 6, 2K textures, forced remeshing, and `image_enhancement: false` instead of the current Meshy 7 geometry-first path.
3. It never sends the asset acceptance criteria to the concept-view generator.
4. Its 4,000-character prompt is filled with global world lore before prohibited styles and regeneration instructions, so the important tail is dropped.
5. It has no semantic gate on the reference images before paying Meshy.
6. It budgets Meshy in invented USD reservations even though completed task records already report the real `consumed_credits`.

The bridge failure was principally an input-pipeline failure, not Meshy misunderstanding a good bridge specification. The final source set depicts a counterweight hoist with no deck, route, approach geometry, or controls. Meshy reconstructed what it was shown.

## What Fulcrum actually sent

`AssetGenerationJob` has an `imageInput` field but no prompt field. The Meshy adapter turns one image into `image_url` or the ordered set into `image_urls`; no text prompt reaches Meshy. See [asset-generation.ts](/home/zach/projects/Fulcrum/packages/production/src/asset-generation.ts:70) and [meshy-adapter.ts](/home/zach/projects/Fulcrum/packages/production/src/meshy-adapter.ts:97).

The two M2 heroes used:

| Asset                  | Endpoint          |                   Inputs | Model   | Meshy task cost |
| ---------------------- | ----------------- | -----------------------: | ------- | --------------: |
| Brass Automaton Keeper | Multi-Image to 3D | front, left, back, right | Meshy 6 |      30 credits |
| Counterweighted Bridge | Multi-Image to 3D | front, left, back, right | Meshy 6 |      30 credits |

The submitted settings were `model_type: standard`, `should_texture: true`, PBR enabled, 2K texture, `image_enhancement: false`, forced triangle remeshing to 80% of the class triangle cap, `remove_lighting: true`, and GLB-only output. See [meshy-adapter.ts](/home/zach/projects/Fulcrum/packages/production/src/meshy-adapter.ts:16).

The prompts shown in the artifact documents are GPT Image prompts for creating the references. Each cardinal view is generated independently using the same one-image anchor. Fulcrum does not condition a new view on the other generated views and does not grade the four-image set before Meshy. See [multiview.ts](/home/zach/projects/Fulcrum/packages/creative/src/multiview.ts:99) and [multiview.ts](/home/zach/projects/Fulcrum/packages/creative/src/multiview.ts:405).

## Why the bridge became a hoist

The asset plan had the right requirements:

- a traversable bridge span;
- keeper-scale controls visibly driving heavy counterweighted motion;
- stable authored positions;
- visually distinct pre-storm and post-storm approaches.

Those criteria never enter `compileConceptViewPrompt`. Its input contains only the asset name, global visual tokens, camera role, and an optional regeneration brief. See [multiview.ts](/home/zach/projects/Fulcrum/packages/creative/src/multiview.ts:74).

The resulting bridge prompt was 3,995 characters. It described the entire game's style, palette, storm, camera, optional ruins, and session length, but not the required deck, traversal surface, approaches, or controls. It also omitted every prohibited-style token. The same omission occurred for the keeper's interaction and readability criteria.

The live bridge references confirm the problem:

- The front, left, and right images read as freestanding A-frame hoists.
- The original back image is a materially different circular optical machine.
- The regenerated left, back, and right views are more internally consistent, but still depict a hoist with no bridge deck.

The regeneration loop then compounded the error. Semantic QA correctly reported the missing bridge span as a critical concept-fidelity failure, but `decideRegeneration` prioritizes the first major silhouette/view finding and immediately returns `change-views`. In this run it chose a side-profile legibility fix instead of the critical missing-deck fix. See [regeneration.ts](/home/zach/projects/Fulcrum/packages/production/src/regeneration.ts:143).

That selected correction did not reach GPT Image anyway. `compileConceptViewPrompt` appends the regeneration brief after all positive and prohibited visual tokens. `fitConceptPrompt` stops at the first overflow and drops everything after it. The saved regenerated prompts contain neither `Requested view correction:` nor the prohibited style instructions. See [multiview.ts](/home/zach/projects/Fulcrum/packages/creative/src/multiview.ts:113) and [m1.ts](/home/zach/projects/Fulcrum/packages/creative/src/m1.ts:1213).

## Why the keeper became muddy

The keeper references are recognizably the same character and have strong cardinal consistency. The problem is primarily surface direction and when Fulcrum spends on texture:

- The source images already contain dense patina, abrasion, cloth fibers, dark recesses, and many small same-value mechanisms.
- The prohibited-style guidance was truncated from the concept-view prompt.
- Fulcrum asks Meshy to texture immediately at 2K, so the first semantic review sees an already baked, noisy material treatment.
- There is no geometry-only approval stage and no targeted retexture path when geometry is acceptable but material separation fails.
- Fulcrum uses Meshy 6 even though the current API documents higher-fidelity Meshy 7 geometry and retexturing.

The QA gate was right to reject the finished keeper, but it was grading a problem the pipeline could have caught earlier and corrected for 10 texture credits instead of buying another 30-credit geometry-plus-texture result.

## Credit ledger: the current budget is not real

Meshy prices its API in credits. Standard Meshy 6 or 7 geometry costs 20 credits; 2K or 4K texturing costs 10. Therefore 300 credits buys ten first-pass standard textured assets at 30 credits each. This is ten accepted first-pass assets, not a guarantee of ten QA-passing assets: each additional successful API geometry submission costs another 20 credits. Premium's 12 free retries are a web-app benefit and do not apply to ordinary individual or Studio API calls; Enterprise can negotiate API retry support. See [Meshy API pricing](https://docs.meshy.ai/en/api/pricing) and [Meshy API retry policy](https://help.meshy.ai/en/articles/9992034-does-the-meshy-api-support-retry-for-generations).

Fulcrum currently reads `consumed_credits` from a completed Meshy task, but stores it only in provider metadata. Authorization and project totals use `FULCRUM_MESHY_RESERVE_USD`, `budgetReservedUsd`, `costUsd`, and the repository's dollar budget instead. See [meshy-adapter.ts](/home/zach/projects/Fulcrum/packages/production/src/meshy-adapter.ts:75), [meshy-adapter.ts](/home/zach/projects/Fulcrum/packages/production/src/meshy-adapter.ts:247), [production index.ts](/home/zach/projects/Fulcrum/packages/production/src/index.ts:697), and [project index.ts](/home/zach/projects/Fulcrum/packages/project/src/index.ts:789).

The live M2 database snapshot makes the mismatch concrete:

| Ledger item                                | Recorded value |
| ------------------------------------------ | -------------: |
| Meshy-related submission records           |             22 |
| Submissions with Meshy task IDs            |             20 |
| Ready tasks reporting credits              |             19 |
| Credits reported by those ready tasks      |            570 |
| Pending task without a final credit report |              1 |
| Fake USD reserved across provider tasks    |         $12.00 |

Every completed Meshy task reported 30 consumed credits. The report's `$12.00 live spend` is therefore not a Meshy spend figure. The completed provider work already consumed 570 credits; if the pending task completes at the same cost, the run reaches 600 credits.

## What Meshcaster did better—and what it did not prove

Meshcaster's most reusable design is its spend gate:

1. Create an untextured 20-credit preview.
2. Show the result for approval.
3. Spend 10 credits on 4K PBR texture only after approval.
4. Resize, download, decimate locally with UV awareness, and repair normals.

It also accounts in Meshy credits instead of converting them to dollars. See the full [Meshcaster review](/home/zach/projects/Fulcrum/research/meshcaster-meshy-review.md).

Meshcaster is not evidence that raw image conditioning already worked better. Its committed 50-asset quality run was Text to 3D, not Image to 3D. That run produced 34 usable, 8 fixable, and 8 garbage previews: 84% usable-plus-fixable for 1,000 credits. Image mode has request tests but no committed live score sheet. It also performs no crop, background cleanup, camera normalization, cross-view consistency check, or use of Meshy's web retry allowance.

## Recommended Fulcrum flow

### 1. Approve the references before buying geometry

Create an asset-specific reference brief from the asset plan's acceptance criteria. Generate a canonical isolated front view first, then generate the remaining views against that isolated asset—not a broad scene anchor. Grade the set for:

- same object and proportions in every image;
- correct front image first;
- required semantic parts visible;
- neutral background, centered crop, and comparable scale;
- no contradictory machinery, characters, or scene elements.

For the bridge, the gate must be able to answer: "Is there a deck a character can cross?" If no, do not call Meshy.

### 2. Fix prompt priority

The protected prompt prefix or tail should contain, in this order:

1. asset identity and asset-specific acceptance criteria;
2. current regeneration correction, if any;
3. prohibited styles and no-extra-object guard;
4. cardinal camera instruction;
5. a small set of relevant material and silhouette tokens.

Global story, session length, optional-ruin state, and unrelated camera lore should not consume the concept-view prompt. Add tests proving the required criteria, prohibitions, and correction survive the 4,000-character cap.

### 3. Split Meshy into geometry and texture stages

Use Meshy 7 Multi-Image to 3D with `should_texture: false` for a 20-credit geometry candidate. Preserve high-fidelity geometry for QA by leaving `should_remesh: false`, or retain `pre_remeshed_glb`. Run local turntable and semantic QA before spending on texture.

If geometry passes, use Meshy 7 Retexture at 4K with PBR and the approved reference images for 10 credits. 4K costs the same as 2K. If only materials fail, retexture for 10 credits rather than regenerating geometry for another 20. Meshy 7's Multi-Image endpoint also supports separate `texture_image_urls`, which Fulcrum does not currently use. See the full [Meshy API review](/home/zach/projects/Fulcrum/research/meshy-api-review.md).

### 4. Make topology an asset-class decision

- Hero assets: standard Meshy 7, high-fidelity geometry first, local UV-aware decimation after semantic acceptance.
- Ordinary props: A/B test Meshy T2 Smart Topology at 5 geometry + 10 texture credits.
- Rigged characters: use the documented A-pose or T-pose control and budget rigging separately.

### 5. Replace the Meshy USD shim with a credit ledger

Introduce Meshy-specific stage estimates and actuals:

- reserve 20 credits before geometry submission;
- reconcile with task `consumed_credits` on completion;
- reserve 10 before 2K/4K Retexture;
- reconcile project balance with `GET /openapi/v1/balance`;
- distinguish zero-cost HTTP/status retries from new paid generation submissions;
- never submit a new paid candidate automatically without a credit guard.

A project may still have an overall dollar budget for other providers, but Meshy authorization and reporting should remain in credits. Do not invent an exchange rate.

## Proposed 300-credit allocation

| Plan                                        | Credits |
| ------------------------------------------- | ------: |
| Ten standard geometry previews              |     200 |
| Texture the ten accepted previews at 4K/PBR |     100 |
| Total                                       |     300 |

That plan leaves no room for rejected paid geometry candidates. If ten QA-passing assets are a hard deliverable rather than ten first-pass assets, Fulcrum needs either a larger retry reserve, cheaper Smart Topology for non-heroes, or fewer fully textured assets. The pipeline should state that tradeoff before it submits the first job.

## Recommended implementation order

1. Credit ledger and geometry-only spending gate.
2. Asset-specific reference acceptance gate.
3. Prompt-priority and regeneration-selection fixes.
4. Meshy 7, 4K Retexture, and texture-reference support.
5. High-fidelity geometry preservation plus local post-processing.
6. Smart Topology and pose/rigging profiles by asset class.

No production code was changed during this audit.
