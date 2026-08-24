import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ConceptDocumentSchema,
  type ConceptDocument,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetProduction, createReplayReliquary } from "./index.js";

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
