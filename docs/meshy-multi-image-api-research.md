# Meshy multi-image API evidence

Checked against Meshy's official API documentation on 2026-08-26.

## Findings

- The [Multi-Image to 3D endpoint reference](https://docs.meshy.ai/en/api/multi-image-to-3d) lists `meshy-5`, `meshy-6`, `meshy-7`, and `latest` as accepted `ai_model` values. Meshy-6 is therefore valid for `POST /openapi/v1/multi-image-to-3d`.
- The same reference lists `remove_lighting` as a boolean request parameter with a default of `true`. It supports `meshy-6`, `meshy-7`, and `latest`, but not `meshy-5`. Sending `remove_lighting: true` in Fulcrum's Meshy-6 multi-image request is documented behavior and matches the existing Meshy-6 single-image request.
- Meshy's [API changelog](https://docs.meshy.ai/en/api/changelog) records full Meshy-6 support for Multi-Image to 3D on January 26, 2026. The February 28, 2026 entry records the addition of `remove_lighting` to Multi-Image to 3D and identifies Meshy-6 as supported.

## Relevant constraints

- `image_urls` accepts 1 to 4 JPG, JPEG, or PNG images supplied as public URLs or data URIs. The images should show the same object from different angles. Fulcrum's 2-to-4 multiview profile is stricter at the lower bound and matches the endpoint's upper bound.
- The current reference says the first `image_urls` entry is the primary front view for `meshy-7` and `latest`. It does not list a separate Meshy-6 payload format or an alternate ordering rule, so the existing ordered-images profile does not need a Meshy-6-specific variant.
- `image_enhancement` supports `meshy-6`, `meshy-7`, and `latest`. `should_remesh` defaults to `false` for Meshy-6 and `true` for other models. Fulcrum already sends explicit values for both fields.
- Both endpoints accept generation without textures or remeshing. M2 sets `should_texture: false` and `should_remesh: false` so semantic geometry QA sees the highest-fidelity candidate before another 10 credits are authorized.
- `pose_mode` supports `a-pose` and `t-pose`. Fulcrum carries this as explicit asset-plan intent for humanoid heroes instead of guessing from the asset class.
- `auto_size: true` enables bottom-origin placement and the four cardinal QA thumbnails. Fulcrum requests both the alpha preview and `thumbnail_urls`, then downloads those signed outputs immediately.
- `texture_image_urls` is separate from geometry input `image_urls` and only supports `meshy-7` or `latest`. Fulcrum's request does not send `texture_image_urls`, so this does not block Meshy-6 multiview geometry generation.
- Meshy's raw endpoint still accepts `meshy-5`, but that does not require Fulcrum to declare a Meshy-5 capability profile. Keeping Meshy-5 unsupported is a local product policy. The endpoint does not support `remove_lighting` for Meshy-5.

## Implementation decision

Pin the Fulcrum M2 multiview profile to `meshy-6`; reject `latest`, Meshy 7, and undeclared model versions before submission. Generate geometry without texture or remeshing, grade it with the geometry rubric and cardinal thumbnails, then submit an approved GLB to Meshy 6 Retexture for 4K PBR output with original UVs and lighting removal. Persist the GLB, texture maps, thumbnails, task ID, and reported credit use before their signed URLs expire.
