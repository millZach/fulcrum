# Meshy API capability correction and addendum

Verified against Meshy's first-party API documentation and changelog on 2026-08-26. This document corrects and extends `research/meshy-api-review.md`. It does not propose switching Fulcrum to Meshy 7; Zach has chosen Meshy 6 because Meshy 7 is too slow for this pipeline.

## Direct answers

### Meshy 7 pricing

Meshy's current API price table says:

- Meshy 6 standard geometry: **20 credits**.
- Meshy 7 standard geometry: **20 credits**.
- Meshy 7 with `ultra_mode: true`: **25 credits** (20 + 5).
- A 2K or 4K texture: **10 credits**.

The Image-to-3D schema says `ultra_mode` defaults to `false`. Therefore, **25 credits is the documented Meshy 7 Ultra price, not the documented Meshy 7 standard price**. If a supposedly standard live task reports `consumed_credits: 25`, Fulcrum should trust the task response, preserve its request, and treat that as a billing discrepancy or undocumented rollout rather than overwrite it with the tariff assumption.

Sources: [API pricing](https://docs.meshy.ai/en/api/pricing), [Image-to-3D parameters](https://docs.meshy.ai/en/api/image-to-3d), [Meshy 7 changelog entry](https://docs.meshy.ai/en/api/changelog).

### Latency

Meshy's API documentation does **not** publish a standard Meshy 7 end-to-end latency figure or service-level guarantee. It says only that Meshy 7 has higher-fidelity geometry and that Ultra mode "takes longer." Meshy's platform overview lists Meshy 6 at approximately two minutes, but it does not yet list Meshy 7 in its model-speed table. Zach's observed Meshy 7 latency is therefore the useful operational evidence, and pinning `ai_model: "meshy-6"` is reasonable.

Sources: [Text-to-3D API](https://docs.meshy.ai/en/api/text-to-3d), [Meshy platform overview](https://docs.meshy.ai/en), [API changelog](https://docs.meshy.ai/en/api/changelog).

### Rigging and animation over API

**Yes.** Meshy exposes three separate character-motion capabilities:

1. **Rigging API** — adds an armature to a textured humanoid. It costs 5 credits and returns rigged GLB and FBX files. Its task result can also contain basic walking and running animations.
2. **Animation API** — applies a preset animation from Meshy's published 600+ action library to a successful Meshy rig task. It costs 3 credits per animation call and returns animated GLB and FBX files.
3. **Text-to-Motion API** — generates a standalone motion clip from a natural-language prompt. It costs 3 credits in Swift mode (BVH) or 10 credits in Prime mode (FBX). This clip is not attached to a character; Fulcrum would need a retargeting step outside this endpoint.

Sources: [Rigging API](https://docs.meshy.ai/en/api/rigging), [Animation API](https://docs.meshy.ai/en/api/animation), [Animation library](https://docs.meshy.ai/en/api/animation-library), [Text-to-Motion API](https://docs.meshy.ai/en/api/text-to-motion), [API pricing](https://docs.meshy.ai/en/api/pricing).

## Was the earlier review complete?

No. It accurately covered the core Image/Multi-Image generation and credit problem, and it correctly noted that rigging and preset animation exist. It was not a full inventory of the current API. In particular, it underexplained or omitted:

- Text-to-Motion, released on 2026-08-21.
- The 600+ preset animation library and animation post-processing controls.
- Standalone Convert and Resize endpoints.
- Alpha and four-view thumbnail generation.
- Webhooks as an alternative to polling and SSE.
- Meshy 6-specific limitations on multi-view texture guidance.
- The important fact that Image-to-3D and Multi-Image-to-3D expose no semantic geometry prompt.
- The exact limitations for rigging inputs and orientation.
- A current Multi-Image default: `should_remesh` is documented as `false` for Meshy 6 and `true` for other models. The earlier report generalized the Image-to-3D default (`false` for Meshy 6 and 7) to Multi-Image-to-3D.

The earlier report's claim that standard Meshy 7 geometry costs 20 credits remains consistent with the official API price table. Its recommendation to use Meshy 7 should be superseded by Zach's Meshy 6 decision.

## What the Meshy 6 API can do for Fulcrum

### Geometry generation

| Capability                      | Meshy 6 support | Important details                                                                                                                                   |
| ------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text-to-3D                      | Yes             | Two-stage Preview (geometry) then Refine (texture); prompt limit 600 characters.                                                                    |
| Image-to-3D                     | Yes             | One JPG/PNG, public URL or Data URI. No text prompt for geometry.                                                                                   |
| Multi-Image-to-3D               | Yes             | One to four JPG/PNG images of the same object. No text prompt for geometry.                                                                         |
| Input image enhancement         | Yes             | `image_enhancement` defaults to `true`; Fulcrum currently turns it off.                                                                             |
| A-pose/T-pose                   | Yes             | `pose_mode: "a-pose"` or `"t-pose"`; this is a generation control, not a standalone posing API.                                                     |
| Geometry-only output            | Yes             | `should_texture: false`; useful for semantic QA before texture spend.                                                                               |
| Remesh during generation        | Yes             | `should_remesh`, triangle or quad, target 100–300,000 faces, or adaptive decimation levels 1–4.                                                     |
| Preserve original before remesh | Yes             | `save_pre_remeshed_model: true` returns `pre_remeshed_glb`.                                                                                         |
| Smart Topology                  | Separate model  | `model_type: "smart-topology"`, `ai_model: "meshy-t2"`; 100–15,000 triangle faces, natively separated parts, 5 geometry credits. It is not Meshy 6. |
| Scale and origin                | Yes             | `auto_size` plus `origin_at: "bottom"` or `"center"`. Exact sizing is also available through Resize.                                                |
| Moderation                      | Yes             | Screens geometry images and supplied texture guidance when enabled.                                                                                 |

Sources: [Text-to-3D](https://docs.meshy.ai/en/api/text-to-3d), [Image-to-3D](https://docs.meshy.ai/en/api/image-to-3d), [Multi-Image-to-3D](https://docs.meshy.ai/en/api/multi-image-to-3d), [pricing](https://docs.meshy.ai/en/api/pricing).

The semantic-prompt limitation matters for the failed bridge. On Image-to-3D and Multi-Image-to-3D, Meshy sees the pixels. `texture_prompt` can guide materials, but there is no documented geometry prompt where Fulcrum can say "this must include a traversable bridge deck." That requirement has to be visible in the accepted reference images or Fulcrum must use Text-to-3D instead.

### Texture generation

Meshy 6 supports:

- Base color at 2K, 4K, or 8K. 2K and 4K cost 10 credits; 8K costs 15.
- `enable_pbr: true` for metallic, roughness, and normal maps. Meshy 6 also returns an emission map except at 8K.
- `remove_lighting: true` to reduce baked highlights and shadows.
- A texture text prompt or one texture reference image on Image-to-3D, Multi-Image-to-3D, Text-to-3D Refine, and Retexture, subject to each endpoint's schema.
- Reusing good existing UVs in Retexture through `enable_original_uv: true`.

Meshy 6 does **not** support the new one-to-four-image texture guidance fields. `texture_image_urls` on Multi-Image-to-3D and `multiview_image_urls` on Retexture require Meshy 7. With Meshy 6, a staged geometry-only → Retexture pipeline can retain the accepted mesh for 10 texture credits, but Retexture can use only one style image or one text prompt.

That creates a genuine Meshy 6 tradeoff:

- `should_texture: true` in the initial Multi-Image call lets Meshy perform its integrated texture phase, but spends 10 credits before Fulcrum's geometry QA.
- `should_texture: false`, then Retexture after QA, avoids wasted texture credits but limits explicit texture guidance to one image or text prompt.

The public API documents no "resume the texture phase" endpoint for a completed untextured Multi-Image task.

Sources: [Multi-Image-to-3D](https://docs.meshy.ai/en/api/multi-image-to-3d), [Retexture](https://docs.meshy.ai/en/api/retexture), [Text-to-3D](https://docs.meshy.ai/en/api/text-to-3d), [pricing](https://docs.meshy.ai/en/api/pricing).

### QA and delivery outputs

Meshy can return more useful QA evidence than Fulcrum currently requests:

- `multi_view_thumbnails: true` on Image-to-3D and Multi-Image-to-3D returns front, right, back, and left 512×512 renders. Meshy says this adds about three seconds.
- `alpha_thumbnail: true` returns a transparent-background preview.
- `target_formats` can limit work to only the required exports. Meshy supports GLB, OBJ, FBX, STL, USDZ, and opt-in 3MF on generation endpoints.
- `texture_urls` exposes base-color and PBR maps separately.
- `consumed_credits` appears on task objects and returns zero for failed tasks.

Sources: [Image-to-3D](https://docs.meshy.ai/en/api/image-to-3d), [Multi-Image-to-3D](https://docs.meshy.ai/en/api/multi-image-to-3d), [API changelog](https://docs.meshy.ai/en/api/changelog).

## Post-processing API inventory

| Endpoint  | Purpose                                                                                     |                          Cost | Notable limits                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------- | ----------------------------: | ------------------------------------------------------------------------------------------------------------------- |
| Retexture | Texture an existing Meshy or uploaded model from text or image                              | 10 credits at 2K/4K; 15 at 8K | Meshy 6 supports one text or one image style input; multi-view style images require Meshy 7.                        |
| Remesh    | Triangle/quad topology, target polycount or adaptive decimation                             |                             5 | Input GLB/GLTF/OBJ/FBX/STL; dedicated Convert and Resize are preferred for those operations.                        |
| UV Unwrap | New clean, non-overlapping UV layout                                                        |                             5 | GLB only, maximum 40,000 faces, output is triangulated and untextured. Feature can be account-gated during rollout. |
| Convert   | Convert between GLB, FBX, OBJ, USDZ, BLEND, STL, and 3MF                                    |                             1 | Input GLB/GLTF/OBJ/FBX/STL.                                                                                         |
| Resize    | Exact height, exact longest side, or AI-estimated real-world size; set bottom/center origin |                             1 | Resize modes are mutually exclusive.                                                                                |
| Balance   | Read current account credit balance                                                         |                      Free GET | Returns `{ "balance": number }`.                                                                                    |

Sources: [Retexture](https://docs.meshy.ai/en/api/retexture), [Remesh](https://docs.meshy.ai/en/api/remesh), [UV Unwrap](https://docs.meshy.ai/en/api/uv-unwrap), [Convert](https://docs.meshy.ai/en/api/convert), [Resize](https://docs.meshy.ai/en/api/resize), [Balance](https://docs.meshy.ai/en/api/balance), [pricing](https://docs.meshy.ai/en/api/pricing).

There is no separate "balance the physical model" endpoint. "Balance API" means credit balance. There is also no standalone arbitrary pose-edit endpoint; the public 3D API exposes only A-pose/T-pose generation controls.

## Rigging details

Create a rig task with `POST /openapi/v1/rigging` using either:

- `input_task_id` for a successful textured humanoid Meshy task, or
- `model_url` for a textured humanoid GLB supplied through a public URL or Data URI.

Optional inputs are approximate `height_meters` (default 1.7) and a UV-unwrapped PNG base-color `texture_image_url`.

Important limitations:

- The API documentation says it currently works well only for standard humanoid bipeds with clear limbs and body structure.
- Untextured, non-humanoid, or ambiguous-limb assets are unsuitable.
- When using `input_task_id`, more than 300,000 faces is unsupported.
- A model supplied through `model_url` must face +Z, the glTF forward direction, or pose estimation can fail.
- Pose-estimation failure is reported as HTTP 422.
- This API documentation does not promise web-app quadruped rigging support over the API.

Successful output includes rigged GLB and FBX. The result may also include basic walking and running animations in skinned GLB/FBX and armature-only GLB variants. The create schema does not document a request switch for these basic animations, so Fulcrum should treat their presence as optional and inspect the response.

Source: [Rigging API](https://docs.meshy.ai/en/api/rigging).

## Animation details

### Preset Animation API

`POST /openapi/v1/animations` requires:

- `rig_task_id`: a successful Meshy Rigging task ID.
- `action_id`: an integer from Meshy's published animation library.

Each call costs 3 credits. The library contains more than 600 documented actions across idles, locomotion, combat, dancing, climbing, swimming, stunts, and in-place variants.

Output includes animated GLB and FBX. Optional post-processing supports:

- `change_fps` at 24, 25, 30, or 60 FPS.
- `fbx2usdz`.
- `extract_armature`.

The API requires a Meshy `rig_task_id`; it is not documented as a general endpoint for arbitrary third-party skeletons.

Sources: [Animation API](https://docs.meshy.ai/en/api/animation), [Animation library](https://docs.meshy.ai/en/api/animation-library), [pricing](https://docs.meshy.ai/en/api/pricing).

### Text-to-Motion API

`POST /openapi/v1/text-to-motion` accepts:

- A natural-language prompt up to 400 characters.
- Duration from 2 to 10 seconds in 0.5-second increments.
- `mode: "swift"` for a faster 3-credit BVH clip.
- `mode: "prime"` for a higher-quality 10-credit FBX clip.

The output is a standalone motion clip. It does not take `rig_task_id` and does not return a character-bound animation. Retargeting that clip onto a Fulcrum character would remain a Blender, Unity, Unreal, or custom-pipeline responsibility.

Source: [Text-to-Motion API](https://docs.meshy.ai/en/api/text-to-motion).

## 2D concept generation that can feed 3D

Meshy also exposes Text-to-Image and Image-to-Image APIs. Both can set `generate_multi_view: true`, producing three views; their completed task ID can be passed directly as `input_task_id` to Multi-Image-to-3D. Text-to-Image also supports A-pose/T-pose, and both endpoints can remove the background. Image-to-Image accepts one to five references plus an edit prompt.

This is an available alternative to Fulcrum's current independent four-view generation, not automatically a superior one. It would need an A/B quality and credit test. The current image prices range from 3 to 12 credits depending on endpoint and model, and `consumed_credits` should be read from the task.

Sources: [Text-to-Image](https://docs.meshy.ai/en/api/text-to-image), [Image-to-Image](https://docs.meshy.ai/en/api/image-to-image), [Multi-Image-to-3D](https://docs.meshy.ai/en/api/multi-image-to-3d), [pricing](https://docs.meshy.ai/en/api/pricing).

## Task orchestration and storage

All major task APIs are asynchronous and support status polling and SSE streams. Meshy also supports account-level HTTPS webhooks for task status updates. Webhooks can reduce polling load; an account can configure up to five active webhook URLs.

Non-Enterprise API assets are retained for at most three days according to the API retention page, so Fulcrum must download accepted models, maps, thumbnails, rig files, and animation files promptly. API-created tasks do not necessarily appear in the web app workspace.

Sources: [Meshy API agent index](https://docs.meshy.ai/llms.txt), [Webhooks](https://docs.meshy.ai/en/api/webhooks), [Asset retention](https://docs.meshy.ai/en/api/asset-retention), [Rate limits](https://docs.meshy.ai/en/api/rate-limits).

## Credit implications for Meshy 6

| Accepted-output path                     |         Credits |
| ---------------------------------------- | --------------: |
| Meshy 6 geometry only                    |              20 |
| Meshy 6 geometry + 2K/4K texture         |              30 |
| Meshy 6 geometry + 2K/4K texture + rig   |              35 |
| Rigged character + one preset animation  |        38 total |
| Rigged character + `N` preset animations | `35 + 3N` total |
| Standard asset + post-acceptance Remesh  |              35 |
| Standard asset + Remesh + UV Unwrap      |              40 |
| Smart Topology geometry + 2K/4K texture  |              15 |

Therefore 300 credits yields ten first-pass Meshy 6 assets only when the required path is geometry + 2K/4K texture and there are no rejected geometry attempts or paid post-processing steps. Characters that require rigging and animation need their own credit class.

Source: [API pricing](https://docs.meshy.ai/en/api/pricing).

## Recommended Meshy 6 capability set for Fulcrum

Without changing the chosen model, Fulcrum can use substantially more of the API:

1. Pin `ai_model: "meshy-6"`; never use `latest` because it currently resolves to Meshy 7.
2. A/B test Meshy's default `image_enhancement: true` against exact-preservation mode instead of globally disabling it.
3. Submit geometry-only candidates and perform semantic QA before texture spend where the one-image Retexture limitation is acceptable.
4. Keep `should_remesh: false` for semantic geometry review, then call the standalone Remesh endpoint only after acceptance. If generation-time remesh remains necessary, save the pre-remeshed GLB.
5. Request four-view thumbnails for automated and human QA; the documented latency cost is about three seconds.
6. Use 4K PBR at the same 10-credit texture price as 2K, and keep `remove_lighting: true` for Meshy 6 assets intended for engine lighting.
7. Add exact scale/origin handling through Resize or generation-time auto-size.
8. Use `pose_mode` for humanoids, then texture, rig, and optionally animate as distinct gated stages.
9. Record every task's `consumed_credits`, reconcile against the Balance API, and budget rigging/animation/post-processing separately.
10. Use SSE or webhooks for completion and immediately persist every accepted signed output because of the three-day retention limit.

The highest-value immediate experiment is not Meshy 7. It is a controlled Meshy 6 comparison of the current request against: enhancement enabled, no generation-time remesh, geometry-only QA, four-view thumbnails, and post-acceptance 4K/PBR texturing.
