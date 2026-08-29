# Meshcaster's use of Meshy

Reviewed Meshcaster at commit [`2cdd9729`](https://github.com/millZach/Meshcaster/tree/2cdd9729b243aae5224ee04aa464a1abe21146a3). This report covers Meshcaster only. It does not inspect Fulcrum.

## Short answer

Meshcaster has two separate shape-generation modes:

- Text mode sends the user's prompt to Meshy's Text-to-3D endpoint. Meshcaster trims the prompt but does not rewrite it, append a style profile, or send a negative prompt. Its 50-asset validation run used hand-written prompts such as `low-poly stylized cobblestone bridge over a stream, flat colors, game asset`. See [the request builder](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:189) and [the validation prompts](/home/zach/projects/meshcaster/harness/prompts.csv:1).
- Image mode sends one to four local PNG or JPEG files to Meshy's Image-to-3D endpoints as base64 data URIs. The first file is the primary or front view. A single file uses Image-to-3D and two to four files use Multi-Image-to-3D. See [GenerationSettings.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/GenerationSettings.cs:29), [the image body builder](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:265), and [the routing code](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:389). The feature landed in [commit `5b6457a`](https://github.com/millZach/Meshcaster/commit/5b6457ad958b85e2d67cd853d93dfa61e3f5411b).

The committed live quality evidence predates image mode. The 50-asset sheet is prompt-driven, as are the low-poly and texture A/B sheets. I found no committed Image-to-3D task IDs, scored image-result sheet, or output models. `Verya.png` was added later, but history does not connect it to a Meshy result. Image mode has extensive offline request tests, not a recorded live quality test. That distinction matters.

## What Meshcaster sends

### Text-to-3D

The default text Preview request uses:

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Endpoint           | `POST /openapi/v2/text-to-3d` |
| `mode`             | `preview`                     |
| `prompt`           | Exact trimmed user text       |
| `ai_model`         | `meshy-6`                     |
| `model_type`       | `lowpoly`                     |
| `topology`         | `quad`                        |
| `target_polycount` | `10000`                       |
| `should_remesh`    | `true`                        |

These are hardcoded and testable in [MeshyAdapter.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:23) and [BuildPreviewBody](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:189). The prompt itself carries the style steer. Meshcaster does not build a more detailed prompt from structured concept fields.

After approval, text mode sends a Refine request against the Preview task ID. It pins `meshy-6`, enables PBR, requests 4K textures, and can add one optional texture-only prompt. See [BuildRefineBody](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:225). The 4K and low-poly defaults came from live A/B work, not guesswork. Standard-mode UVs broke painted detail into tiny islands; the low-poly mode returned larger UV islands and game-sized meshes at the same price. The six-prop comparison cost about 210 credits. See [ADR-0004](/home/zach/projects/meshcaster/docs/adr/0004-lowpoly-generation-mode.md:1) and [commit `f9ace83`](https://github.com/millZach/Meshcaster/commit/f9ace83f12fce76f0515d7d4c68c0081b934e07f).

### Image-to-3D

Image mode does not send a shape prompt. It sends the source image bytes:

- One image: `POST /openapi/v1/image-to-3d` with `image_url` and `model_type: "standard"`.
- Two to four images: `POST /openapi/v1/multi-image-to-3d` with ordered `image_urls`. No `model_type` is sent.
- Both routes pin `meshy-6`, disable texturing during geometry creation, request quad remeshing at 10,000, set `image_enhancement: true`, and request only GLB. See [BuildImagePreviewBody](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:270).

After approval, Meshcaster sends the Preview's signed GLB URL to `POST /openapi/v1/retexture`. It uses only the first reference image as `image_style_url`, preserves the existing UVs, enables PBR, and asks for 4K GLB output. It uses a model URL instead of the Multi-Image task ID because the Retexture contract did not promise that Multi-Image IDs were valid inputs. See [BuildImageRefineBody](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:307), [the approval chain](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/GenerationJob.cs:488), and [the implementation note](/home/zach/projects/meshcaster/notes.md:3).

## Image preprocessing and multiview handling

Meshcaster performs no visual preprocessing. It validates the file extension, existence, count, and nonzero byte length, then copies the bytes unchanged into `UserSettings` for reload-safe retries. At submission it encodes those bytes directly. There is no crop, background removal, alpha cleanup, resizing, camera normalization, object centering, lighting cleanup, view classifier, or generated turntable. See [StageReferenceImages](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/Persistence/SingleJobStore.cs:229) and [ImageDataUris](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:981).

The UI tells the user to provide one to four views of the same object and labels the first as front or primary. The remaining files are merely `View 2`, `View 3`, and `View 4`; the request contains no front, side, back metadata. See [DrawReferenceImagePicker](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/MeshcasterWindow.cs:407).

This is a useful transport implementation, but a weak image-conditioning pipeline. Fulcrum should reuse the one-to-four-view request pattern, then add deterministic source preparation before Meshy sees the images.

## Generation stages, approval, and retries

Meshcaster's pipeline is Preview, human approval, Refine, Resize, download, local decimation, and normal repair. It spends on geometry first, shows Meshy's single thumbnail, and textures only after approval. See [GenerationJob.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/GenerationJob.cs:460) and [the approval UI](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/MeshcasterWindow.cs:560).

There are three different operations called retry in or around this code, and they should not be conflated:

1. HTTP 429 retry waits repeat a refused network request. They do not ask Meshy for another generated candidate. See [SendWithRetryAsync](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:660).
2. A queue-full response waits for a provider slot, then tries the submission again. Again, no generated candidate existed. See [SubmitWaitingOutTheQueueAsync](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/GenerationJob.cs:603).
3. A user Retry after an interrupted paid submission can re-submit the step and is labeled with its credit cost. A discarded or expired Preview requires a fresh priced generation. See [CreditCopy.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/Ui/CreditCopy.cs:64).

I found no use of Meshy's generation retry or variation allowance, and no endpoint call that requests another candidate from an existing successful Preview. Meshcaster therefore does not use the 12 retries Zach describes. Its approval gate prevents texture spend on a bad Preview, but a concept mismatch still becomes a new 20-credit submission in this implementation.

## Topology and post-processing

Meshcaster learned two useful lessons from live outputs:

- Asking Meshy's remesher for a low final polycount deformed the barrel. Meshcaster instead asked for a higher model, then decimated locally. See [ADR-0003](/home/zach/projects/meshcaster/docs/adr/0003-generate-high-decimate-locally.md:1) and [commit `44d550e`](https://github.com/millZach/Meshcaster/commit/44d550e18635baf15b948004c199c14632029df9).
- Refine returned hard per-face normals on geometry whose form was otherwise sound. The local pipeline recalculates normals at 60 degrees and preserves UV seams while decimating. See [MeshPostProcessor.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/Import/MeshPostProcessor.cs:9).

The text default later changed to Meshy's `lowpoly` generation mode because it had better UV islands. That mode ignores the requested target polycount, so local decimation remained the final authority. Single-image mode still forces `standard`; multi-image mode does not send a model type. Any Fulcrum reuse should keep the measured post-processing ideas but revisit the model selection against today's API documentation.

## Quality review and measured results

Meshcaster has a real quality gate, but it is mostly human:

- The batch stops at untextured thumbnails and lets the user refine or discard each asset. See [the approval grid](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/MeshcasterWindow.cs:838).
- The validation harness records generation time, triangle counts, delivered triangle count, hard-normal percentage, connected components, credits, and human `usable`, `fixable`, or `garbage` labels. See [the harness README](/home/zach/projects/meshcaster/harness/README.md:332).
- The gate refuses incomplete or wrong-sized samples and requires at least 60 percent usable plus fixable. See [gate.py](/home/zach/projects/meshcaster/harness/meshcaster_harness/gate.py:39).

The committed 50-prompt run produced 50 successful Previews for 1,000 credits. Human scoring marked 34 usable, 8 fixable, and 8 garbage, for an 84 percent pass rate. I calculated those counts from [results.csv](/home/zach/projects/meshcaster/harness/results.csv:1); the same 84 percent result is recorded in [commit `f9ace83`](https://github.com/millZach/Meshcaster/commit/f9ace83f12fce76f0515d7d4c68c0081b934e07f).

What it does not have is equally important: no semantic evaluator, no four-view review render, no comparison to the source images, no automatic retry decision, and no prompt or reference revision loop. The approval thumbnail is good cost control, not strong semantic QA.

## Credit accounting

Meshcaster accounts in Meshy credits, never dollars. The adapter owns three constants: 20 for Preview, 10 for Refine, and 1 for Resize. Every spending button reads those estimates from the provider. See [MeshyAdapter.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Core/MeshyAdapter.cs:72), [CreditCopy.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/Ui/CreditCopy.cs:20), and [BatchCreditCopy.cs](/home/zach/projects/meshcaster/unity/Assets/Meshcaster/Editor/Ui/BatchCreditCopy.cs:15).

Using Zach's intended scope, 300 credits buys ten generated and textured assets at 30 credits each. Meshcaster's complete Unity chain always adds a one-credit Resize, making that exact chain 31 credits per asset. That buys nine complete resized assets for 279 credits, with 21 credits left. If Fulcrum does not need Meshy's Resize step, it should budget 30 per accepted asset, not 31 and not dollars.

Retries need their own ledger. Network retries and queue waits cost zero because no task was accepted. Free generation retries, if the current API offers the 12-attempt allowance described by Zach, should also be recorded as attempts under the original 20-credit Preview rather than new assets. Meshcaster has no such accounting because it does not call that capability.

## What Fulcrum should carry forward

1. Make the input route explicit in every artifact record. Record `text`, `single-image`, or `multi-image`, the exact prompt, reference-image hashes and order, endpoint, model, and request body. Then QA can answer what actually conditioned a failed model.
2. For a specific concept, prefer a consistent one-to-four-view image set over a broad text prompt. Put the canonical front view first. Preprocess the images before submission, something Meshcaster never did.
3. Spend 20 credits on geometry, run semantic and geometric QA, use the included generation retries, and spend 10 on texturing only after geometry passes. Keep manual approval as an override, not the only evaluator.
4. Pin model and quality fields. Meshcaster's A/B work showed that defaults can leave free quality unused. Revalidate its old `meshy-6`, `lowpoly`, and 4K choices against the current documentation before copying them.
5. Keep the local mesh repair. UV-aware decimation and normal recalculation fixed visible defects without paying Meshy for another pass.
6. Judge the same deliverable the game will import. Meshcaster's gate improved when it stopped scoring damaged intermediate exports. Fulcrum should render and score its post-processed GLB from multiple fixed views.

The main lesson is simple. Meshcaster was careful about credits and mesh delivery, but its semantic control still depended on either one raw prompt or unprepared reference images. Fulcrum can keep the good spending gate and post-processing, then add the missing reference preparation and closed QA retry loop.
