# M0 Live Acceptance Report

## Result

**Accepted on 2026-08-18.** Project `3015a569-793b-403d-8310-b37b7cd9a446` completed one live, immutable lineage from the fixture brief through both human approvals.

The run began at `2026-08-18T16:56:28.066Z` and reached terminal completion at `2026-08-18T17:51:13.777Z`: 54 minutes 46 seconds of wall time, including human review and live-run fixes. The three provider operations themselves completed in approximately 5 minutes 38 seconds.

## Providers and cost

- Structured creative development: signed-in OpenAI subscription (`subscription-default`)
- Concept image: OpenAI subscription ImageGen (`gpt-image-2`)
- Image-to-3D: Meshy (`meshy-6`)
- Meshy consumption: 30 credits
- Fulcrum cost reservation: `$0.60` against a `$1.20` run cap
- Paid Meshy submissions: one; polling and browser recovery reused the recorded job

The dollar value is Fulcrum's configured reservation, not a reconstruction of Meshy's invoice. Subscription-backed creative and image work is not assigned a per-run USD cost.

## Artifacts and quality

| Artifact      | Evidence                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- |
| Concept PNG   | 1,795,429 bytes · SHA-256 `62d765c948b5f774ab7d36dee95be4025e6edbcab320623cf936867907ce0ce3`  |
| Textured GLB  | 16,548,312 bytes · SHA-256 `d175de97484272e3e3806ba3cfaea3f5ea3c9690376a80212d032f7b08a7fb14` |
| Scene Spec v0 | SHA-256 `7db18f4b8f4cbed119922171cb86400e0f0f241b04f5adab0f7b2d75d477cb85`                    |
| Review PNG    | 210,777 bytes · SHA-256 `c6cc8482748feef004d4f68df1e99a4d4da519b54e1e72d488a035fafad76846`    |

Deterministic GLB inspection passed all 6 gates. The asset contains 1 mesh, 1 primitive, 145,726 vertices, 270,152 triangles, 1 material, 4 embedded textures, and no animations. Its source bounds are `1.90 × 0.89 × 1.90 m`; the runtime centers, grounds, and uniformly fits provider output to the authored 3.2 m review extent.

## Failures resolved during acceptance

1. The orchestrator originally resolved `.env` and `workspace` from its package working directory. Runtime configuration now locates the repository root before loading either path.
2. Studio attached `Content-Type: application/json` to a bodyless polling POST, which Fastify rejected after a browser restart. The API client now sets that header only when a body exists, and the same paid job resumed without duplication.
3. The valid live GLB appeared too small in the fixed arena camera. Runtime asset fitting now normalizes arbitrary provider bounds to the authored target and grounds the result before capture.

No provider operation ended in failure, no second concept was requested, and no regeneration was purchased.

## Validation and accepted limitations

- `pnpm test`: 16 tests passed across 5 files
- `pnpm typecheck`: passed across all workspace packages
- `pnpm build`: passed, including the Studio production bundle
- `pnpm format:check`: passed
- The configured API credential value was scanned against all 13 local database and artifact-store files with zero matches; request logs contained no credentials.
- The live artifacts remain in the local artifact store and are not committed. Offline CI continues to use the deterministic, rights-safe replay fixture.
- The 270,152-triangle mesh establishes the M0 measurement baseline and remains under the 500,000-triangle gate; later runtime milestones should define stricter platform-specific budgets.
- M0 proves production lineage, recovery, inspection, and approval. It does not claim gameplay, engine integration, or a polished vertical slice.
