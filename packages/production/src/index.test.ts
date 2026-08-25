import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AssetDocumentSchema,
  ConceptDocumentSchema,
  type ConceptDocument,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssetProduction,
  AssetQuality,
  createReplayReliquary,
  DEFAULT_ASSET_POLICIES,
} from "./index.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-production-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MESHY_API_KEY;
  delete process.env.FULCRUM_MESHY_MODEL;
  delete process.env.FULCRUM_MESHY_RESERVE_USD;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const openLiveAssetProject = (
  budgetUsd: number,
): {
  repository: ProjectRepository;
  production: AssetProduction;
  projectId: string;
  runId: string;
  concept: RevisionRef;
  idempotencyKey: string;
} => {
  const repository = new ProjectRepository(temporaryRoot());
  const projectId = "live-asset-project";
  const runId = "live-asset-run";
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "A live asset preflight fixture.", rightsConfirmed: true },
    runId,
  });
  const image = repository.putArtifact(projectId, PNG_1x1, "image/png");
  const conceptDocument: ConceptDocument = ConceptDocumentSchema.parse({
    conceptId: `${projectId}:reliquary-concept`,
    name: "Ancient Reliquary",
    prompt: "A squat stone reliquary",
    negativePrompt: "photorealism",
    image,
    provider: "fulcrum-replay",
    model: "fixture",
    sourceRevisionIds: [brief.revisionId, brief.revisionId],
    costUsd: 0,
  });
  const concept = repository.writeRevision({
    projectId,
    entityId: conceptDocument.conceptId,
    kind: "concept-document",
    value: conceptDocument,
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m0",
    projectId,
    name: "Live asset fixture",
    mode: "live",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    status: "active",
    stage: "asset-production",
    runId,
    budgetUsd,
    spentUsd: 0,
    conceptReplacementCount: 0,
    brief,
    createdAt,
    updatedAt: createdAt,
  });
  return {
    repository,
    production: new AssetProduction(repository),
    projectId,
    runId,
    concept,
    idempotencyKey: `asset:${projectId}:${concept.artifact.sha256}:live:meshy`,
  };
};

describe("AssetProduction live preflight", () => {
  it("does not poison the idempotency key when budget is refused before any provider call", async () => {
    const {
      repository,
      production,
      projectId,
      runId,
      concept,
      idempotencyKey,
    } = openLiveAssetProject(0.2);
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new Error("provider should not be contacted");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.50";

    const refused = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });

    expect(refused.status).toBe("failed");
    if (refused.status === "failed") {
      expect(refused.error.code).toBe("budget-refused");
      expect(refused.error.recoverable).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "intent-recorded",
    );
    expect(repository.getProject(projectId).spentUsd).toBe(0);
    expect(
      repository
        .listEvents(projectId)
        .some((event) => event.type === "budget.refused"),
    ).toBe(true);

    const project = repository.getProject(projectId);
    repository.saveProject({ ...project, budgetUsd: 1 });
    fetchMock.mockImplementation(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/image-to-3d") && init?.method === "POST")
          return Response.json({ result: "meshy-job-budget-retry" });
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    const retried = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });

    expect(retried.status).toBe("pending");
    expect(retried.requestId).toBe(refused.requestId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "pending",
    );
    expect(repository.getSubmissionByKey(idempotencyKey)?.externalJobId).toBe(
      "meshy-job-budget-retry",
    );
    expect(repository.getProject(projectId).spentUsd).toBe(0.5);
    repository.close();
  });

  it("does not poison the idempotency key when Meshy is unconfigured", async () => {
    const {
      repository,
      production,
      projectId,
      runId,
      concept,
      idempotencyKey,
    } = openLiveAssetProject(1);
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new Error("provider should not be contacted");
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const refused = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });

    expect(refused.status).toBe("failed");
    if (refused.status === "failed")
      expect(refused.error.code).toBe("provider-unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "intent-recorded",
    );

    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";
    fetchMock.mockImplementation(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/image-to-3d") && init?.method === "POST")
          return Response.json({ result: "meshy-job-config-retry" });
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    const retried = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });
    expect(retried.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)?.externalJobId).toBe(
      "meshy-job-config-retry",
    );
    repository.close();
  });

  it("still marks a mid-flight fetch throw as submission-unknown", async () => {
    const {
      repository,
      production,
      projectId,
      runId,
      concept,
      idempotencyKey,
    } = openLiveAssetProject(1);
    const fetchMock = vi.fn(
      async (
        _request: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new Error("socket hang up");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";

    const outcome = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error.code).toBe("submission-unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "submission-unknown",
    );

    const retried = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });
    expect(retried.status).toBe("failed");
    if (retried.status === "failed")
      expect(retried.error.code).toBe("submission-unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("submits after a successful preflight and reconciles the Meshy job", async () => {
    const { repository, production, projectId, runId, concept } =
      openLiveAssetProject(1);
    const glb = await createReplayReliquary();
    const glbBuffer = new ArrayBuffer(glb.byteLength);
    new Uint8Array(glbBuffer).set(glb);
    const fetchMock = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/image-to-3d") && init?.method === "POST")
          return Response.json({ result: "meshy-job-1" });
        if (url.endsWith("/image-to-3d/meshy-job-1")) {
          return Response.json({
            id: "meshy-job-1",
            status: "SUCCEEDED",
            progress: 100,
            consumed_credits: 30,
            model_urls: { glb: "https://assets.meshy.test/model.glb" },
          });
        }
        if (url === "https://assets.meshy.test/model.glb") {
          return new Response(glbBuffer, {
            status: 200,
            headers: { "Content-Type": "model/gltf-binary" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";
    process.env.FULCRUM_MESHY_RESERVE_USD = "0.20";

    const submitted = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });
    expect(submitted.status).toBe("pending");
    const completed = await production.ensure({
      projectId,
      runId,
      mode: "live",
      assetProvider: "meshy",
      concept,
    });
    expect(completed.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(repository.getProject(projectId).spentUsd).toBe(0.2);
    repository.close();
  });
});

describe("AssetProduction regeneration lineage", () => {
  it("extends_idempotency_with_strategy_parent_attempt_and_ordered_views", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = "regeneration-project";
    const runId = "regeneration-run";
    const createdAt = "2026-08-24T12:00:00.000Z";
    repository.reserveProject(projectId, createdAt);
    const brief = repository.writeRevision({
      projectId,
      entityId: `${projectId}:brief`,
      kind: "game-brief",
      value: { text: "A regeneration fixture.", rightsConfirmed: true },
      runId,
    });
    const image = repository.putArtifact(projectId, PNG_1x1, "image/png");
    const writeConcept = (conceptId: string) =>
      repository.writeRevision({
        projectId,
        entityId: conceptId,
        kind: "concept-document",
        value: ConceptDocumentSchema.parse({
          conceptId,
          name: conceptId,
          prompt: "A readable stone reliquary",
          negativePrompt: "photorealism",
          image,
          provider: "fulcrum-replay",
          model: "fixture",
          sourceRevisionIds: [brief.revisionId, brief.revisionId],
          costUsd: 0,
        }),
        runId,
      });
    const concept = writeConcept(`${projectId}:concept:front`);
    const back = writeConcept(`${projectId}:concept:back`);
    const left = writeConcept(`${projectId}:concept:left`);
    repository.createProject({
      schemaVersion: 1,
      milestone: "m2",
      projectId,
      name: "Regeneration fixture",
      mode: "replay",
      status: "active",
      stage: "asset-batch",
      runId,
      spentUsd: 0,
      brief,
      createdAt,
      updatedAt: createdAt,
    });
    const production = new AssetProduction(repository);
    const initial = await production.ensure({
      projectId,
      runId,
      mode: "replay",
      assetProvider: "meshy",
      concept,
    });
    if (initial.status !== "ready")
      throw new Error("Initial asset was not ready.");
    const strategyRevision = repository.writeRevision({
      projectId,
      entityId: `${projectId}:decision`,
      kind: "asset-regeneration-decision",
      value: {
        schema: "fulcrum.asset-regeneration-decision",
        version: 1,
        decisionId: "decision-1",
        assetId: `${projectId}:reliquary-asset`,
        sourceReportRevisionIds: ["semantic-1"],
        bestKnownAssetRevisionId: initial.value.revisionId,
        strategy: {
          kind: "change-views",
          rationale: "The rear silhouette needs direct references.",
          reasonFindingIds: ["finding-1"],
          operation: "add",
          roles: ["back", "left", "right"],
          brief: "Define the rear structure.",
        },
      },
      runId,
    });
    const regeneration = {
      attemptNumber: 1,
      strategyRevision,
      parentAssetRevision: initial.value,
      additionalConceptViews: [back, left],
    };

    const first = await production.ensure({
      projectId,
      runId,
      mode: "replay",
      assetProvider: "meshy",
      concept,
      regeneration,
    });
    const repeated = await production.ensure({
      projectId,
      runId,
      mode: "replay",
      assetProvider: "meshy",
      concept,
      regeneration,
    });
    const reordered = await production.ensure({
      projectId,
      runId,
      mode: "replay",
      assetProvider: "meshy",
      concept,
      regeneration: {
        ...regeneration,
        additionalConceptViews: [left, back],
      },
    });

    expect(first.status).toBe("ready");
    expect(repeated.status).toBe("ready");
    expect(reordered.status).toBe("ready");
    if (
      first.status === "ready" &&
      repeated.status === "ready" &&
      reordered.status === "ready"
    ) {
      expect(repeated.value).toEqual(first.value);
      expect(reordered.value.revisionId).not.toBe(first.value.revisionId);
      expect(repository.resolveRevision(first.value)).toMatchObject({
        parentAssetRevisionId: initial.value.revisionId,
        regenerationStrategyRevisionId: strategyRevision.revisionId,
        sourceConceptRevisionIds: [
          concept.revisionId,
          back.revisionId,
          left.revisionId,
        ],
        generationClaims: { textured: false, textureChannels: [] },
      });
    }
    repository.close();
  });
});

describe("AssetQuality regeneration capability", () => {
  it("unsupported_live_multiview_capability_prevents_change_views_selection", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = "unsupported-multiview-quality";
    const runId = "run-1";
    const createdAt = "2026-08-24T12:00:00.000Z";
    repository.reserveProject(projectId, createdAt);
    const revision = (entityId: string, kind: string, value: unknown) =>
      repository.writeRevision({
        projectId,
        entityId,
        kind,
        value,
        runId,
      });
    const brief = revision("brief", "game-brief", {
      text: "Unsupported multiview quality fixture.",
      rightsConfirmed: true,
    });
    const asset = revision("hero", "asset-document", { fixture: "asset" });
    const policy = revision("hero-policy", "asset-policy", {
      fixture: "policy",
    });
    const turntable = revision("hero-turntable", "turntable", {
      fixture: "turntable",
    });
    const deterministicReport = revision(
      "hero-deterministic",
      "asset-deterministic-report",
      {
        schema: "fulcrum.asset-deterministic-report",
        version: 1,
        reportId: "deterministic-1",
        assetId: "hero",
        assetRevisionId: asset.revisionId,
        assetArtifactSha256: asset.artifact.sha256,
        policy: {
          revisionId: policy.revisionId,
          sha256: policy.artifact.sha256,
        },
        classification: "hero",
        passed: true,
        measurements: {
          mesh: {
            meshCount: 1,
            primitiveCount: 1,
            vertexCount: 3,
            triangleCount: 1,
            boundsMeters: { x: 1, y: 1, z: 1 },
          },
          material: {
            materialCount: 1,
            unassignedPrimitiveCount: 0,
            unusedMaterialCount: 0,
            duplicateMaterialGroupCount: 0,
          },
          texture: {
            textureCount: 1,
            embeddedCount: 1,
            referencedCount: 0,
            unusedCount: 0,
            smallestDimensionPx: 1024,
            largestDimensionPx: 1024,
          },
          topology: {
            degenerateTriangles: 0,
            nonManifoldEdges: 0,
            boundaryEdges: 0,
            unreferencedVertices: 0,
            inconsistentWindingEdges: 0,
            normalMismatchTriangles: 0,
          },
        },
        gates: [],
        findings: [],
        qualityVector: {
          hardGateFailures: 0,
          criticalFindings: 0,
          majorFindings: 0,
          minorFindings: 0,
          semanticVerdict: "not-run",
        },
      },
    );
    const finding = {
      findingId: "finding-silhouette",
      findingCode: "semantic.silhouette-readability",
      rubricVersion: "asset-turntable-v1",
      category: "geometry",
      summary: "The rear silhouette collapses behind the crystal housing.",
      evidenceArtifactIds: ["frame-4"],
      evidence: [
        {
          artifactId: "frame-4",
          kind: "turntable-frame",
          frameIndex: 4,
        },
      ],
      severity: "major",
      confidence: 0.94,
      ownerModule: "asset-quality.semantic",
      suggestedAction: "Add direct rear and side concept evidence.",
    };
    const semanticReport = revision("hero-semantic", "asset-semantic-report", {
      schema: "fulcrum.asset-semantic-report",
      version: 1,
      reportId: "semantic-1",
      assetId: "hero",
      assetRevisionId: asset.revisionId,
      turntableRevisionId: turntable.revisionId,
      rubricVersion: "asset-turntable-v1",
      requestDigest: "a".repeat(64),
      provider: "fixture",
      model: "fixture",
      costUsd: 0,
      verdict: "revise",
      dimensionScores: { "silhouette-readability": 0.4 },
      findings: [finding],
      qualityVector: {
        hardGateFailures: 0,
        criticalFindings: 0,
        majorFindings: 1,
        minorFindings: 0,
        semanticVerdict: "revise",
      },
    });
    repository.createProject({
      schemaVersion: 1,
      milestone: "m2",
      projectId,
      name: "Unsupported multiview quality fixture",
      mode: "live",
      assetProvider: "meshy",
      status: "active",
      stage: "asset-batch",
      runId,
      spentUsd: 0,
      brief,
      createdAt,
      updatedAt: createdAt,
    });
    vi.stubEnv("FULCRUM_MESHY_MODEL", "meshy-5");

    const selected = await new AssetQuality(repository).selectRegeneration({
      projectId,
      runId,
      assetId: "hero",
      currentAttempt: {
        attemptNumber: 0,
        asset,
        deterministicReport,
        turntable,
        semanticReport,
        qualityVector: {
          hardGateFailures: 0,
          criticalFindings: 0,
          majorFindings: 1,
          minorFindings: 0,
          semanticVerdict: "revise",
        },
      },
      attemptHistory: [],
      policy: DEFAULT_ASSET_POLICIES.hero,
    });

    expect(selected.decision.strategy.kind).toBe("give-up-user");
    repository.close();
  });
});

describe("AssetQuality replay idempotency", () => {
  it("asset_quality_replay_returns_the_original_evaluation_revision", async () => {
    const root = temporaryRoot();
    const projectId = "quality-project";
    const repository = new ProjectRepository(root);
    repository.reserveProject(projectId, "2026-01-01T00:00:00.000Z");
    const glb = repository.putArtifact(
      projectId,
      await createReplayReliquary(),
      "model/gltf-binary",
    );
    const asset = repository.writeRevision({
      projectId,
      entityId: "asset-1",
      kind: "asset-document",
      value: AssetDocumentSchema.parse({
        assetId: "asset-1",
        name: "Reliquary",
        classification: "hero",
        glb,
        provider: "fulcrum-replay",
        model: "fixture",
        sourceConceptRevisionId: "concept-1",
        externalJobId: "replay-1",
        costUsd: 0,
      }),
      runId: "run-1",
    });
    const quality = new AssetQuality(repository);
    const first = await quality.evaluate({
      projectId,
      runId: "run-1",
      asset,
    });
    repository.close();

    const reconstructed = new ProjectRepository(root);
    const second = await new AssetQuality(reconstructed).evaluate({
      projectId,
      runId: "run-2",
      asset,
    });

    expect(second.revision).toEqual(first.revision);
    expect(second.evaluation).toEqual(first.evaluation);
    expect(
      reconstructed
        .listEvents(projectId)
        .filter(({ type }) => type === "asset.quality-evaluated"),
    ).toHaveLength(1);
    reconstructed.close();
  });
});
