# Meshy API review for Fulcrum

Verified against Meshy's official API documentation and Help Center on 2026-08-25.

## Bottom line

The user's credit arithmetic is correct for a first-pass standard asset: 20 credits for geometry plus 10 credits for a 2K or 4K texture equals 30 credits, so 300 credits buys 10 completed assets if all ten geometry attempts are accepted. Meshy prices API work in credits, not dollars. [Meshy API pricing](https://docs.meshy.ai/en/api/pricing)

The 12 free retries are real for a Premium subscription in Meshy's web app, but they do not apply to ordinary API calls. Meshy's API-specific help page says individual and Studio API users must submit a new request and pay its normal credit cost. API retry support is an Enterprise sales option. [Plan comparison](https://help.meshy.ai/en/articles/12062933-which-meshy-plan-is-right-for-you-free-vs-pro-vs-premium-vs-ultra) [API retry policy](https://help.meshy.ai/en/articles/9992034-does-the-meshy-api-support-retry-for-generations)

For concept art, Fulcrum should prefer Image to 3D or Multi-Image to 3D over prompt-only Text to 3D. Meshy's own comparison calls Text to 3D a concept-exploration tool, Image to 3D the precise-reference route, and multi-view the highest-fidelity reconstruction route. [Meshy generation-method guide](https://docs.meshy.ai/en/webapp/guides/choosing/generation-method)

The strongest 30-credit pipeline is:

1. Generate or collect a clean concept image, preferably multiple consistent views.
2. Submit Image to 3D or Multi-Image to 3D with `should_texture: false` for 20 credits.
3. Run geometry QA before texturing.
4. Retexture the accepted task with the same reference art, `ai_model: "meshy-7"`, `enable_pbr: true`, and `texture_resolution: "4k"` for 10 credits.

That composition is an inference from Meshy's documented endpoints, not a named Meshy workflow. It preserves the 30-credit total while avoiding texture spend on rejected geometry. [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d) [Multi-Image to 3D API](https://docs.meshy.ai/en/api/multi-image-to-3d) [Retexture API](https://docs.meshy.ai/en/api/retexture)

## Generation routes

| Route             | Best input                                      | Geometry behavior                                                    | Texture behavior                                                           | Standard credit cost      |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| Text to 3D        | A prose concept with no reference art           | `preview` creates one untextured mesh                                | `refine` textures a succeeded preview                                      | 20 + 10 = 30              |
| Image to 3D       | One concept image, sketch, or product photo     | One call; set `should_texture: false` for mesh only                  | Texture is on by default, or use Retexture later                           | 20 mesh only, 30 textured |
| Multi-Image to 3D | One to four consistent views of the same object | Meshy 7 conditions on all views; first image is the front view       | Can texture in the same call or use separate multi-view texture references | 20 mesh only, 30 textured |
| Smart Topology    | A lower-face-count, parts-aware game asset      | Meshy T2 generates triangle topology directly at 100 to 15,000 faces | Texture adds 10 credits                                                    | 5 mesh only, 15 textured  |

Sources: [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d), [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d), [Multi-Image to 3D API](https://docs.meshy.ai/en/api/multi-image-to-3d), [pricing](https://docs.meshy.ai/en/api/pricing).

### Text to 3D

Text to 3D accepts a prompt of at most 600 characters and uses a two-stage `preview` then `refine` workflow. The current standard models are `meshy-5`, `meshy-6`, `meshy-7`, and `latest`, which currently resolves to Meshy 7. Meshy describes Meshy 7 as higher-fidelity than Meshy 6. `ultra_mode: true` adds finer geometry for 5 more credits and works only with Meshy 7 preview tasks. [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d) [Meshy API changelog](https://docs.meshy.ai/en/api/changelog)

Text to 3D is the weaker route when Fulcrum already has approved concept art. Meshy's web guide says Text to 3D is useful for fast exploration, but recommends the Text to Image, review, Image to 3D sequence when output direction is unpredictable or a specific consistent look matters. [Text to 3D guide](https://help.meshy.ai/en/articles/9996858-how-to-use-meshy-text-to-3d)

### Image to 3D

Image to 3D accepts one JPG or PNG through a public URL or base64 data URI. The same endpoint can create an untextured mesh or a finished textured model. Important controls include:

- `ai_model: "meshy-7"` or `latest` for the current high-fidelity model.
- `ultra_mode` for 5 additional credits when finer geometry justifies the cost.
- `image_enhancement`, which defaults to `true`. Set it to `false` when preserving the exact source appearance matters more than Meshy's input optimization.
- `should_texture`, `enable_pbr`, and `texture_resolution`.
- `texture_prompt` or `texture_image_url` for extra texture direction. If both are sent, the text prompt wins.
- `pose_mode: "a-pose"` or `"t-pose"` for a humanoid intended for rigging.
- `auto_size` and `origin_at` for real-world scale and a bottom or center origin.
- `multi_view_thumbnails` for front, right, back, and left QA renders.

[Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d)

### Multi-Image to 3D

Multi-Image to 3D accepts one to four images of the same object. On Meshy 7, the first image is the primary front view and the remaining order does not matter. Meshy's current changelog says Meshy 7 conditions geometry on all input views and drives texturing from them. This is the most relevant endpoint for Fulcrum's approved multi-angle concept art. [Multi-Image to 3D API](https://docs.meshy.ai/en/api/multi-image-to-3d) [Meshy API changelog](https://docs.meshy.ai/en/api/changelog)

Meshy 7 also accepts `texture_image_urls`, a separate list of one to four texture references. These may differ from the geometry views. The first is the front texture view. The field cannot be combined with `texture_image_url` or `texture_prompt`. [Multi-Image to 3D API](https://docs.meshy.ai/en/api/multi-image-to-3d)

Meshy's Text to Image and Image to Image APIs can generate three viewing angles with `generate_multi_view: true`. A completed multi-view image task can feed Multi-Image to 3D directly through `input_task_id`, avoiding a download and re-upload step. The documentation lists the per-image model prices but does not state an unambiguous total charge for one three-view task, so Fulcrum should read `consumed_credits` rather than assume those concept views are free. [Text to Image API](https://docs.meshy.ai/en/api/text-to-image) [Image to Image API](https://docs.meshy.ai/en/api/image-to-image) [Multi-Image to 3D API](https://docs.meshy.ai/en/api/multi-image-to-3d)

## Geometry and topology controls

For a standard Meshy 6 or Meshy 7 generation, `should_remesh` defaults to `false`, and Meshy explicitly recommends `false` for the highest-quality model. If Fulcrum enables remeshing during generation, it can request triangle or quad-dominant topology and a target from 100 to 300,000 faces. The actual count may differ. `decimation_mode` offers adaptive ultra, high, medium, or low levels and overrides `target_polycount`. [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d) [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d)

This creates a real tradeoff. Remeshing at generation time helps enforce a game budget, but it can erase geometry before semantic QA. A safer high-fidelity flow is to keep the original mesh for geometry review, then call the 5-credit Remesh API after acceptance. If generation-time remeshing is necessary, `save_pre_remeshed_model: true` preserves a `pre_remeshed_glb` backup. [Remesh API](https://docs.meshy.ai/en/api/remesh) [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d) [pricing](https://docs.meshy.ai/en/api/pricing)

Smart Topology is a different option, not merely a remesh flag. `model_type: "smart-topology"` with `ai_model: "meshy-t2"` produces triangle output directly at 100 to 15,000 faces, defaults to 4,000 faces, and returns cleaner topology with natively separated parts. Geometry costs 5 credits and a textured result costs 15. It is worth testing for ordinary props, but the standard Meshy 7 route remains the documented high-detail option for hero assets. [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d) [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d) [pricing](https://docs.meshy.ai/en/api/pricing)

## Texture controls

The API exposes more texture control than a generic "texture this" step:

- `texture_resolution` supports 2K, 4K, and 8K. Both 2K and 4K cost 10 credits; 8K costs 15. Fulcrum can request 4K without changing the 30-credit standard-asset budget.
- `enable_pbr: true` adds metallic, roughness, and normal maps to base color. Meshy 7 does not return an emission map.
- Text to 3D Refine and Image to 3D accept either a `texture_prompt` or one `texture_image_url`.
- Meshy 7 Multi-Image to 3D accepts one to four dedicated `texture_image_urls`.
- Retexture accepts a text style prompt, one image, or one to four multi-view images. It can keep an existing good UV layout with `enable_original_uv: true`.
- `remove_lighting` removes baked highlights and shadows where the selected endpoint and model support it. Support differs by endpoint, so Fulcrum should not send it blindly.

[Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d) [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d) [Multi-Image to 3D API](https://docs.meshy.ai/en/api/multi-image-to-3d) [Retexture API](https://docs.meshy.ai/en/api/retexture) [pricing](https://docs.meshy.ai/en/api/pricing)

The Retexture endpoint matters when geometry passes but materials fail. It costs 10 credits at 2K or 4K, so Fulcrum can correct a muddy material without paying another 20 credits for geometry. Meshy's current changelog describes Meshy 7 Retexture as producing sharper surface detail and cleaner PBR materials than Meshy 6. [Retexture API](https://docs.meshy.ai/en/api/retexture) [Meshy API changelog](https://docs.meshy.ai/en/api/changelog)

Meshy also has a standalone UV Unwrap API for models that need clean, non-overlapping UVs before texturing. It costs 5 credits, accepts GLB inputs up to 40,000 faces, and always returns triangle geometry. Meshy-generated models with good existing UVs should normally reuse those UVs in Retexture instead of paying for this extra step. [UV Unwrap API](https://docs.meshy.ai/en/api/uv-unwrap)

## Deprecated controls that should not influence QA

Several familiar generation knobs no longer work in the current API:

- `negative_prompt` is deprecated and has no functional effect.
- `symmetry_mode` is deprecated and no longer affects output.
- `art_style` is deprecated and unsupported by Meshy 6. Current high-quality requests should express style through the concept art and texture inputs instead.
- `texture_richness` has no functional effect.

[Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d)

The create schemas also expose no seed, candidate count, or variation count. A Meshy 7 or Meshy 6 web-app generation produces one draft, while legacy Meshy 5 can show four. The API does not document the legacy four-draft selection behavior as an API feature. Fulcrum should treat each API submission as one probabilistic candidate and store its exact request, input images, model version, and task ID. [Text to 3D guide](https://help.meshy.ai/en/articles/9996858-how-to-use-meshy-text-to-3d) [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d)

## Rigging and animation

Rigging is relevant only to character assets. The Rigging API takes a humanoid model and an approximate `height_meters`; it can also accept the UV-unwrapped base-color texture. A successful task returns rigged GLB and FBX files plus basic walking and running animations. Pose estimation can fail with HTTP 422 if the model is not a valid humanoid. Auto-rigging costs 5 credits. [Rigging API](https://docs.meshy.ai/en/api/rigging) [pricing](https://docs.meshy.ai/en/api/pricing)

Additional preset animations cost 3 credits per Animation API call and require a successful rig task plus an `action_id`. [Animation API](https://docs.meshy.ai/en/api/animation) [pricing](https://docs.meshy.ai/en/api/pricing)

## Task lifecycle and outputs

Meshy generation is asynchronous. Tasks report `PENDING`, `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, or `CANCELED`; the API supports polling and Server-Sent Events. Fulcrum should only download result URLs after `SUCCEEDED`. Standard 3D endpoints can return GLB, OBJ, FBX, STL, USDZ, and opt-in 3MF. Passing only `target_formats: ["glb"]` avoids generating unused formats and can shorten completion time. [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d) [Image to 3D API](https://docs.meshy.ai/en/api/image-to-3d)

Every current task object includes `consumed_credits`; failed tasks report zero because Meshy refunds technical failures. Meshy also exposes `GET /openapi/v1/balance`. These should be the source of truth for Fulcrum's budget ledger. [Meshy API changelog](https://docs.meshy.ai/en/api/changelog) [Balance API](https://docs.meshy.ai/en/api/balance)

## Credit claim audit

| Claim                                                  | Finding                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Meshy charges credits, not dollars                     | Correct. The API price table is credit-based.                                                                                                                                                                            |
| Standard preview or mesh generation costs 20 credits   | Correct for standard Meshy 6 and Meshy 7. Meshy 7 Ultra adds 5. Smart Topology costs 5.                                                                                                                                  |
| Texture costs 10 credits                               | Correct for 2K and 4K. 8K costs 15.                                                                                                                                                                                      |
| Premium has 12 free retries                            | Correct as a web-app plan benefit, documented as free retries per generation.                                                                                                                                            |
| Those 12 retries apply to Fulcrum's ordinary API calls | Incorrect. The API explicitly does not support free generation retries for individual or Studio plans. A new API request consumes credits normally. Enterprise customers can ask sales about API retries.                |
| 300 credits gets 10 assets                             | Correct for ten accepted first-pass standard assets at 20 + 10 credits each. It is not a guarantee of ten QA-passing assets because every unsatisfactory geometry resubmission costs another 20 credits through the API. |

Sources: [API pricing](https://docs.meshy.ai/en/api/pricing), [plan comparison](https://help.meshy.ai/en/articles/12062933-which-meshy-plan-is-right-for-you-free-vs-pro-vs-premium-vs-ultra), [web-app retry behavior](https://help.meshy.ai/en/articles/9996858-how-to-use-meshy-text-to-3d), [API retry policy](https://help.meshy.ai/en/articles/9992034-does-the-meshy-api-support-retry-for-generations), [refund rules](https://help.meshy.ai/en/articles/15643245-when-were-my-meshy-credits-used-or-refunded).

Budget examples:

| Per accepted asset path                                 | Credits | Finished assets from 300 credits |
| ------------------------------------------------------- | ------: | -------------------------------: |
| Standard geometry + 2K or 4K texture                    |      30 |                               10 |
| Standard geometry + 8K texture                          |      35 |          8, with 20 credits left |
| Meshy 7 Ultra geometry + 2K or 4K texture               |      35 |          8, with 20 credits left |
| Standard geometry + 4K texture + post-acceptance remesh |      35 |          8, with 20 credits left |
| Smart Topology geometry + 2K or 4K texture              |      15 |                               20 |

Rigging, animation, UV unwrapping, concept-image generation, rejected geometry attempts, and extra retexture passes are separate costs. Technical failures are refunded; successful but visually unsatisfactory API tasks are not. [API pricing](https://docs.meshy.ai/en/api/pricing) [UV Unwrap API](https://docs.meshy.ai/en/api/uv-unwrap) [refund rules](https://help.meshy.ai/en/articles/15643245-when-were-my-meshy-credits-used-or-refunded)

## Controls Fulcrum should audit

This is the implementation checklist I would compare against the current adapter:

1. Route approved concept art to Image to 3D or Multi-Image to 3D instead of reducing it back to a Text to 3D prompt.
2. Send all consistent available views, up to four, with the intended front view first.
3. Pin or record `ai_model` so a change to `latest` cannot silently alter reproducibility.
4. Use a geometry-only first stage and spend the 10 texture credits only after geometry QA.
5. Request Meshy 7, PBR maps, and 4K texture for final hero assets. PBR and 4K do not add to the normal 10-credit texture price.
6. Feed approved concept art back into texturing through `image_style_url`, `texture_image_url`, or the Meshy 7 multi-view texture fields.
7. Preserve the high-detail mesh for semantic QA. Remesh only after acceptance, or retain `pre_remeshed_glb` when remeshing during generation.
8. Expose standard versus Smart Topology as an asset-class decision rather than one global default.
9. Use A-pose or T-pose for characters that must rig. Do not spend rigging credits on static props.
10. Request cardinal-view thumbnails and grade all four views before accepting geometry or texture.
11. Remove dead options such as `negative_prompt`, `symmetry_mode`, and `texture_richness` from request planning.
12. Record `consumed_credits` from each completed task and reconcile with the Balance API. Do not translate credits to dollars inside the generation domain.
13. Separate network retries from generation retries. Back off and retry status calls on transient failures, but never create a second paid generation task automatically without a credit guard.
14. Download accepted GLBs, textures, thumbnails, and task metadata promptly instead of relying on signed Meshy URLs as permanent storage.
