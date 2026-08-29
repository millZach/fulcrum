import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  AssetDocumentSchema,
  ConceptViewDocumentSchema,
  MultiviewConceptSetSchema,
  type AssetClassification,
  type ArtifactRef,
  type ConceptViewRole,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  m2AssetIdempotencyKey,
  type AssetGenerationJob,
} from "./asset-generation.js";
import { AssetProduction, createReplayReliquary } from "./index.js";
import { MeshyAssetAdapter } from "./meshy-adapter.js";
import { TripoAssetAdapter } from "./tripo-adapter.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [
    "MESHY_API_KEY",
    "FULCRUM_MESHY_MODEL",
    "FULCRUM_MESHY_RESERVE_USD",
    "TRIPO_API_KEY",
    "FULCRUM_TRIPO_MODEL_VERSION",
    "FULCRUM_TRIPO_RESERVE_USD",
  ]) {
    delete process.env[name];
  }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const guidance = {
  front: { role: "front", azimuthDegrees: 0 },
  left: { role: "left", azimuthDegrees: 90 },
  back: { role: "back", azimuthDegrees: 180 },
  right: { role: "right", azimuthDegrees: 270 },
} as const;

const fixture = (
  options: {
    mode?: "live" | "replay";
    assetProvider?: "meshy" | "tripo";
    classification?: AssetClassification;
    withSet?: boolean;
  } = {},
) => {
  const mode = options.mode ?? "replay";
  const assetProvider = options.assetProvider ?? "meshy";
  const classification = options.classification ?? "hero";
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-m2-production-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = `m2-production-${mode}-${assetProvider}-${roots.length}`;
  const runId = "run-1";
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "M2 production fixture.", rightsConfirmed: true },
    runId,
  });
  const gameDesignSpec = repository.writeRevision({
    projectId,
    entityId: `${projectId}:game-design-spec`,
    kind: "game-design-spec",
    value: { title: "Fixture" },
    runId,
  });
  const anchorImage = repository.putArtifact(
    projectId,
    Buffer.from("anchor-image"),
    "image/png",
  );
  const anchorConcept = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept:hero`,
    kind: "concept-document",
    value: {
      conceptId: "hero",
      name: "Ancient Reliquary",
      prompt: "Approved concept",
      negativePrompt: "photorealism",
      image: anchorImage,
      provider: "fulcrum-replay",
      model: "fixture",
      sourceRevisionIds: [brief.revisionId, gameDesignSpec.revisionId],
      ancestors: [brief, gameDesignSpec].map((revision) => ({
        revisionId: revision.revisionId,
        sha256: revision.artifact.sha256,
        kind: revision.kind,
      })),
      costUsd: 0,
    },
    runId,
  });
  const conceptSet = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept-set`,
    kind: "concept-set",
    value: {
      conceptSetId: `${projectId}:concept-set`,
      sourceDirectionRevisionId: "direction-1",
      slots: [
        {
          slotId: "gameplay-anchor",
          name: "Ancient Reliquary",
          purpose: "Readable objective",
          revisions: [
            {
              revision: anchorConcept,
              inheritedVisualTokens: [
                {
                  tokenId: "shape-1",
                  category: "shape",
                  value: "squat octagonal vessel",
                },
              ],
            },
          ],
          selectedRevisionId: anchorConcept.revisionId,
        },
      ],
    },
    runId,
  });
  const assetId = `${projectId}:asset:hero`;
  const assetPlan = repository.writeRevision({
    projectId,
    entityId: `${projectId}:asset-plan`,
    kind: "asset-plan",
    value: {
      planId: `${projectId}:asset-plan`,
      assets: [
        {
          assetId,
          name: "Ancient Reliquary",
          classification,
          rationale: "The objective needs a hero asset.",
          ...(classification === "procedural"
            ? {
                procedure: {
                  generatorId: "fixture-procedure",
                  parameters: { seed: 1 },
                },
              }
            : {}),
          sourceRefs: {
            gameDesignSpec: {
              revisionId: gameDesignSpec.revisionId,
              sha256: gameDesignSpec.artifact.sha256,
              kind: gameDesignSpec.kind,
            },
            conceptSet: {
              revisionId: conceptSet.revisionId,
              sha256: conceptSet.artifact.sha256,
              kind: conceptSet.kind,
            },
            conceptSlots: [
              {
                slotId: "gameplay-anchor",
                concept: {
                  revisionId: anchorConcept.revisionId,
                  sha256: anchorConcept.artifact.sha256,
                  kind: anchorConcept.kind,
                },
              },
            ],
          },
          dependsOnAssetIds: [],
          acceptanceCriteria: ["Readable from the arena perimeter."],
        },
      ],
      handling: ASSET_CLASS_HANDLING_POLICIES_V1,
      provenance: {
        revisionId: "asset-plan-provenance-1",
        parentRevisionIds: [
          gameDesignSpec.revisionId,
          conceptSet.revisionId,
          anchorConcept.revisionId,
        ],
        sourceArtifactHashes: [
          gameDesignSpec.artifact.sha256,
          conceptSet.artifact.sha256,
          anchorConcept.artifact.sha256,
        ],
        runId,
        operation: "asset-plan.initial",
        createdAt,
      },
    },
    runId,
  });
  const viewImages = new Map<ConceptViewRole, ArtifactRef>();
  const viewEntries = (["front", "left", "back", "right"] as const).map(
    (role) => {
      const image = repository.putArtifact(
        projectId,
        Buffer.from(`${role}-image`),
        "image/png",
      );
      viewImages.set(role, image);
      const sourceRevisionIds = [
        assetPlan.revisionId,
        conceptSet.revisionId,
        anchorConcept.revisionId,
      ];
      const document = ConceptViewDocumentSchema.parse({
        conceptViewId: `${assetId}:concept-view:${role}`,
        assetId,
        guidance: {
          ...guidance[role],
          elevationDegrees: 0,
          projection: "orthographic",
          framing: "full-subject-centered",
          background: "neutral-studio",
        },
        attempt: 0,
        prompt: `${role} view prompt`,
        promptHash: createHash("sha256")
          .update(`${role} view prompt`)
          .digest("hex"),
        image,
        provider: "fulcrum-replay",
        model: "fixture-view-v1",
        costUsd: 0,
        sourceConceptRevisionId: anchorConcept.revisionId,
        sourceRevisionIds,
        ancestors: [assetPlan, conceptSet, anchorConcept].map((revision) => ({
          revisionId: revision.revisionId,
          sha256: revision.artifact.sha256,
          kind: revision.kind,
        })),
        referenceArtifactHashes: [anchorImage.sha256],
        operation: "identity-preserving-concept-view",
      });
      const revision = repository.writeRevision({
        projectId,
        entityId: document.conceptViewId,
        kind: "concept-view-document",
        value: document,
        runId,
      });
      return { role, guidance: document.guidance, revision, image };
    },
  );
  const multiviewConceptSet = repository.writeRevision({
    projectId,
    entityId: `${assetId}:multiview-concept-set`,
    kind: "multiview-concept-set",
    value: MultiviewConceptSetSchema.parse({
      multiviewConceptSetId: `${assetId}:multiview-concept-set`,
      assetId,
      sourceAssetPlanRevisionId: assetPlan.revisionId,
      sourceConceptSetRevisionId: conceptSet.revisionId,
      anchorConcept: { revision: anchorConcept, image: anchorImage },
      views: viewEntries,
      sourceRevisionIds: [
        assetPlan.revisionId,
        conceptSet.revisionId,
        anchorConcept.revisionId,
      ],
    }),
    runId,
  });
  const conceptSetApproval = {
    approvalId: "concept-set-approval-1",
    projectId,
    targetType: "concept-set" as const,
    targetRevisionId: conceptSet.revisionId,
    targetSha256: conceptSet.artifact.sha256,
    decision: "approved" as const,
    decidedBy: "zach",
    decidedAt: createdAt,
  };
  const assetPlanApproval = {
    approvalId: "asset-plan-approval-1",
    projectId,
    targetType: "asset-plan" as const,
    targetRevisionId: assetPlan.revisionId,
    targetSha256: assetPlan.artifact.sha256,
    decision: "approved" as const,
    decidedBy: "zach",
    decidedAt: createdAt,
  };
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "M2 production fixture",
    mode,
    assetProvider,
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    soundProvider: "none",
    status: "active",
    stage: "asset-batch",
    runId,
    budgetUsd: 5,
    spentUsd: 0,
    ...(mode === "live" && assetProvider === "meshy"
      ? {
          meshyCreditBudget: 300,
          meshyCreditsReserved: 0,
          meshyCreditsConsumed: 0,
        }
      : {}),
    conceptReplacementCount: 0,
    brief,
    gameDesignSpec,
    conceptSet,
    conceptSetApproval,
    assetPlan,
    assetPlanApproval,
    createdAt,
    updatedAt: createdAt,
  });
  return {
    repository,
    projectId,
    runId,
    assetId,
    assetPlan,
    anchorConcept,
    anchorImage,
    multiviewConceptSet,
    viewEntries,
    viewImages,
    request: {
      projectId,
      assetPlan,
      assetId,
      ...(options.withSet === false ? {} : { multiviewConceptSet }),
    },
  };
};

const multiviewJob = (
  context: ReturnType<typeof fixture>,
): AssetGenerationJob => ({
  projectId: context.projectId,
  assetId: context.assetId,
  stage:
    context.repository.getProject(context.projectId).assetProvider === "meshy"
      ? "geometry"
      : "complete",
  qualityTarget: { maxTriangles: 250_000 },
  imageInput: {
    kind: "multiview",
    conceptSet: context.multiviewConceptSet,
    anchorConcept: context.anchorConcept,
    views: context.viewEntries.map(({ role, revision, image }) => ({
      role,
      revision,
      image,
    })),
  },
});

describe("AssetProduction M2 durability", () => {
  it.each([
    ["meshy" as const, "FULCRUM_MESHY_MODEL", "meshy-7", "meshy-6"],
    [
      "tripo" as const,
      "FULCRUM_TRIPO_MODEL_VERSION",
      "v2.4-20240919",
      "v2.5-20250123",
    ],
  ])(
    "replay_%s_capability_and_fingerprint_ignore_live_model_env",
    async (assetProvider, envName, liveModelOverride, pinnedModel) => {
      const context = fixture({ mode: "replay", assetProvider });
      const production = new AssetProduction(context.repository);
      const pinnedAdapter =
        assetProvider === "meshy"
          ? new MeshyAssetAdapter(context.repository, pinnedModel)
          : new TripoAssetAdapter(context.repository, pinnedModel);
      const pinnedKey = m2AssetIdempotencyKey({
        projectId: context.projectId,
        mode: "replay",
        provider: assetProvider,
        requestFingerprint: pinnedAdapter.requestFingerprint(
          multiviewJob(context),
        ),
      });

      const withoutOverride = await production.ensure(context.request);
      vi.stubEnv(envName, liveModelOverride);
      const withOverride = await production.ensure(context.request);

      expect(withoutOverride.status).toBe("ready");
      expect(withOverride.status).toBe("ready");
      if (
        withoutOverride.status === "ready" &&
        withOverride.status === "ready"
      ) {
        expect(withOverride.requestId).toBe(withoutOverride.requestId);
        expect(withOverride.value).toEqual(withoutOverride.value);
        expect(
          AssetDocumentSchema.parse(
            context.repository.resolveRevision(withOverride.value),
          ).sourceMultiviewConceptSetRevisionId,
        ).toBe(context.multiviewConceptSet.revisionId);
      }
      expect(
        context.repository.getSubmissionByKey(pinnedKey)?.payload,
      ).toMatchObject({
        modelVersion: pinnedModel,
        requestFingerprint: pinnedAdapter.requestFingerprint(
          multiviewJob(context),
        ),
      });
      expect(
        context.repository
          .listEvents(context.projectId)
          .filter(({ type }) => type === "asset.completed"),
      ).toHaveLength(1);
      context.repository.close();
    },
  );

  it("multiview_job_journals_full_hash_set_before_network", async () => {
    const context = fixture({ mode: "live" });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    const adapter = new MeshyAssetAdapter(context.repository);
    const idempotencyKey = m2AssetIdempotencyKey({
      projectId: context.projectId,
      mode: "live",
      provider: "meshy",
      requestFingerprint: adapter.requestFingerprint(multiviewJob(context)),
    });
    const fetchMock = vi.fn(async () => {
      expect(
        context.repository.getSubmissionByKey(idempotencyKey)?.payload,
      ).toEqual(
        expect.objectContaining({
          jobKind: "multi-image",
          roleOrder: ["front", "left", "back", "right"],
          imageHashes: context.viewEntries.map(({ image }) => image.sha256),
          requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      return Response.json({ result: "meshy-multi-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(
      (await new AssetProduction(context.repository).ensure(context.request))
        .status,
    ).toBe("pending");
    context.repository.close();
  });

  it("multiview_budget_is_reserved_once_before_paid_submission", async () => {
    const context = fixture({ mode: "live" });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/multi-image-to-3d"))
        return Response.json({ result: "meshy-multi-2" });
      return Response.json({ status: "IN_PROGRESS", progress: 50 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const production = new AssetProduction(context.repository);

    expect((await production.ensure(context.request)).status).toBe("pending");
    expect((await production.ensure(context.request)).status).toBe("pending");
    expect(
      context.repository
        .listEvents(context.projectId)
        .filter(({ type }) => type === "meshy-credits.reserved"),
    ).toHaveLength(1);
    expect(context.repository.getProject(context.projectId)).toMatchObject({
      meshyCreditsReserved: 20,
      meshyCreditsConsumed: 0,
      spentUsd: 0,
    });
    context.repository.close();
  });

  it.each([
    "hero" as const,
    "kit" as const,
    "procedural" as const,
    "functional" as const,
  ])("live_meshy_%s_job_preserves_geometry_for_qa", async (classification) => {
    const context = fixture({
      mode: "live",
      classification,
      withSet: false,
    });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ result: `meshy-${classification}-1` });
      }),
    );

    expect(
      (await new AssetProduction(context.repository).ensure(context.request))
        .status,
    ).toBe("pending");
    expect(body).toMatchObject({
      should_texture: false,
      should_remesh: false,
      image_enhancement: true,
      auto_size: true,
      origin_at: "bottom",
      multi_view_thumbnails: true,
    });
    expect(body).not.toHaveProperty("target_polycount");
    context.repository.close();
  });

  it("tripo_upload_retry_reuses_completed_tokens_and_budget_reservation", async () => {
    const context = fixture({ mode: "live", assetProvider: "tripo" });
    process.env.TRIPO_API_KEY = "test-key";
    process.env.FULCRUM_TRIPO_MODEL_VERSION = "v2.5-20250123";
    process.env.FULCRUM_TRIPO_RESERVE_USD = "0.30";
    let uploadCall = 0;
    const fetchMock = vi.fn(
      async (request: string | URL | Request): Promise<Response> => {
        const url = String(request);
        if (url.endsWith("/upload/sts")) {
          uploadCall += 1;
          if (uploadCall === 2) throw new Error("upload interrupted");
          const tokenByCall: Record<number, string> = {
            1: "front-token",
            3: "left-token",
            4: "back-token",
            5: "right-token",
          };
          return Response.json({
            data: { image_token: tokenByCall[uploadCall] },
          });
        }
        if (url.endsWith("/task"))
          return Response.json({ data: { task_id: "tripo-multi-1" } });
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const production = new AssetProduction(context.repository);

    expect((await production.ensure(context.request)).status).toBe("failed");
    expect((await production.ensure(context.request)).status).toBe("pending");
    expect(uploadCall).toBe(5);
    expect(
      context.repository
        .listEvents(context.projectId)
        .filter(({ type }) => type === "budget.reserved"),
    ).toHaveLength(1);
    context.repository.close();
  });

  it("ambiguous_paid_post_blocks_without_duplicate_spend", async () => {
    const context = fixture({ mode: "live" });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    const fetchMock = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    vi.stubGlobal("fetch", fetchMock);
    const production = new AssetProduction(context.repository);

    const first = await production.ensure(context.request);
    const second = await production.ensure(context.request);

    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(context.repository.getProject(context.projectId)).toMatchObject({
      spentUsd: 0,
      meshyCreditsReserved: 20,
      meshyCreditsConsumed: 0,
    });
    context.repository.close();
  });

  it("absent_views_fall_back_to_single_image_without_failure", async () => {
    const context = fixture({ mode: "live", withSet: false });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      expect(String(request)).toContain("/image-to-3d");
      expect(String(request)).not.toContain("/multi-image-to-3d");
      return Response.json({ result: "meshy-single-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(
      (await new AssetProduction(context.repository).ensure(context.request))
        .status,
    ).toBe("pending");
    context.repository.close();
  });

  it("non_meshy_6_configuration_is_rejected_before_network", async () => {
    const context = fixture({ mode: "live" });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-5";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      expect(String(request)).toContain("/image-to-3d");
      expect(String(request)).not.toContain("/multi-image-to-3d");
      return Response.json({ result: "meshy-single-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new AssetProduction(context.repository).ensure(
      context.request,
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error.code).toBe("payload-invalid");
    expect(fetchMock).not.toHaveBeenCalled();
    context.repository.close();
  });

  it("meshy_6_geometry_and_4k_texture_are_separate_credit_gated_jobs", async () => {
    const context = fixture({ mode: "live" });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    const glb = await createReplayReliquary();
    let geometryBody: Record<string, unknown> | undefined;
    let textureBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(
      async (
        request: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(request);
        if (url.endsWith("/multi-image-to-3d") && init?.method === "POST") {
          geometryBody = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          return Response.json({ result: "geometry-task-1" });
        }
        if (url.endsWith("/multi-image-to-3d/geometry-task-1"))
          return Response.json({
            status: "SUCCEEDED",
            progress: 100,
            consumed_credits: 20,
            model_urls: { glb: "https://assets.test/geometry.glb" },
            thumbnail_urls: {
              front: "https://assets.test/front.png",
              right: "https://assets.test/right.png",
              back: "https://assets.test/back.png",
              left: "https://assets.test/left.png",
            },
          });
        if (url === "https://assets.test/geometry.glb")
          return new Response(glb.buffer as ArrayBuffer);
        if (url.endsWith(".png"))
          return new Response(Uint8Array.from([137, 80, 78, 71]), {
            headers: { "content-type": "image/png" },
          });
        if (url.endsWith("/retexture") && init?.method === "POST") {
          textureBody = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          return Response.json({ result: "texture-task-1" });
        }
        if (url.endsWith("/retexture/texture-task-1"))
          return Response.json({
            status: "SUCCEEDED",
            progress: 100,
            consumed_credits: 10,
            model_urls: { glb: "https://assets.test/textured.glb" },
            texture_urls: [{ base_color: "https://assets.test/base.png" }],
          });
        if (url === "https://assets.test/textured.glb")
          return new Response(glb.buffer as ArrayBuffer);
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const production = new AssetProduction(context.repository);

    expect((await production.ensure(context.request)).status).toBe("pending");
    const geometry = await production.ensure(context.request);
    expect(geometry.status).toBe("ready");
    if (geometry.status !== "ready") throw new Error("geometry not ready");
    const geometryDocument = AssetDocumentSchema.parse(
      context.repository.resolveRevision(geometry.value),
    );
    expect(geometryDocument).toMatchObject({
      generationClaims: { textured: false, textureChannels: [] },
      costCredits: 20,
    });
    expect(geometryDocument.providerEvidence?.map(({ role }) => role)).toEqual([
      "provider-front",
      "provider-right",
      "provider-back",
      "provider-left",
    ]);
    expect(geometryBody).toMatchObject({
      ai_model: "meshy-6",
      should_texture: false,
      should_remesh: false,
      image_enhancement: true,
      multi_view_thumbnails: true,
    });

    const finishRequest = {
      projectId: context.projectId,
      assetPlan: context.assetPlan,
      assetId: context.assetId,
      geometryAsset: geometry.value,
    };
    expect((await production.finish(finishRequest)).status).toBe("pending");
    const finished = await production.finish(finishRequest);
    expect(finished.status).toBe("ready");
    if (finished.status !== "ready") throw new Error("texture not ready");
    const finishedDocument = AssetDocumentSchema.parse(
      context.repository.resolveRevision(finished.value),
    );
    expect(finishedDocument).toMatchObject({
      parentAssetRevisionId: geometry.value.revisionId,
      generationClaims: {
        textured: true,
        textureChannels: ["base-color", "metallic-roughness", "normal"],
      },
      costCredits: 30,
    });
    expect(finishedDocument.providerEvidence?.map(({ role }) => role)).toEqual([
      "provider-front",
      "provider-right",
      "provider-back",
      "provider-left",
      "provider-texture-0-base-color",
    ]);
    expect(textureBody).toMatchObject({
      ai_model: "meshy-6",
      enable_original_uv: true,
      enable_pbr: true,
      texture_resolution: "4k",
      remove_lighting: true,
      target_formats: ["glb"],
    });
    expect(context.repository.getProject(context.projectId)).toMatchObject({
      spentUsd: 0,
      meshyCreditsReserved: 0,
      meshyCreditsConsumed: 30,
    });
    expect((await production.finish(finishRequest)).status).toBe("ready");
    expect(
      context.repository
        .listEvents(context.projectId)
        .filter(({ type }) => type === "meshy-credits.reserved"),
    ).toHaveLength(2);
    context.repository.close();
  });

  it("corrupt_multiview_lineage_is_policy_blocked_not_silently_ignored", async () => {
    const context = fixture({ mode: "live" });
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    const original = context.repository.resolveRevision<
      Record<string, unknown>
    >(context.multiviewConceptSet);
    const corrupt = context.repository.writeRevision({
      projectId: context.projectId,
      entityId: `${context.assetId}:corrupt-set`,
      kind: "multiview-concept-set",
      value: { ...original, assetId: "different-asset" },
      runId: context.runId,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new AssetProduction(context.repository).ensure({
      ...context.request,
      multiviewConceptSet: corrupt,
    });

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ failureKind: "policy-blocked" }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    context.repository.close();
  });

  it("m2_asset_document_records_exact_input_hashes_and_set_revision", async () => {
    const context = fixture();
    const outcome = await new AssetProduction(context.repository).ensure(
      context.request,
    );
    if (outcome.status !== "ready") throw new Error("Expected replay asset");
    const asset = AssetDocumentSchema.parse(
      context.repository.resolveRevision(outcome.value),
    );

    expect(asset.sourceMultiviewConceptSetRevisionId).toBe(
      context.multiviewConceptSet.revisionId,
    );
    expect(asset.sourceImageArtifactHashes).toEqual(
      context.viewEntries.map(({ image }) => image.sha256),
    );
    expect(
      context.repository
        .listEvents(context.projectId)
        .find(({ type }) => type === "asset.completed")?.payload,
    ).toEqual(
      expect.objectContaining({
        multiviewConceptSetRevisionId: context.multiviewConceptSet.revisionId,
        inputImageHashes: context.viewEntries.map(({ image }) => image.sha256),
      }),
    );
    context.repository.close();
  });
});
