import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  M0_FIXTURE_BRIEF,
  type ArtifactRef,
  type AssetDocument,
  type ProjectSnapshot,
  type RevisionRef,
} from "@fulcrum/domain";
import { AssetProduction, createReplayReliquary } from "@fulcrum/production";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { M0Coordinator } from "./coordinator.js";

const temporaryRoots: string[] = [];
const temporaryRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-m0-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MESHY_API_KEY;
  delete process.env.FULCRUM_MESHY_MODEL;
  delete process.env.FULCRUM_MESHY_RESERVE_USD;
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("M0Coordinator replay path", () => {
  it("preserves a useful message when a workflow phase rejects with an object", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new M0Coordinator(repository);
    const coordinatorInternals = coordinator as unknown as {
      creative: {
        develop: () => Promise<never>;
      };
    };
    coordinatorInternals.creative.develop = vi.fn().mockRejectedValue({
      error: new Error("The response schema uses an unsupported draft."),
    });

    const blocked = await coordinator.create({
      brief: M0_FIXTURE_BRIEF,
      mode: "replay",
      assetProvider: "meshy",
      orchestratorProvider: "claude",
      implementationProvider: "grok",
      imageProvider: "none",
      soundProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });

    expect(blocked.state.blockedReason).toMatchObject({
      code: "workflow-phase-failed",
      message: "The response schema uses an unsupported draft.",
    });
    repository.close();
  });

  it("persists an immutable lineage across restart and reaches visual review", async () => {
    const root = temporaryRoot();
    const firstRepository = new ProjectRepository(root);
    const firstCoordinator = new M0Coordinator(firstRepository);
    const direction = await firstCoordinator.create({
      brief: M0_FIXTURE_BRIEF,
      mode: "replay",
      assetProvider: "meshy",
      orchestratorProvider: "claude",
      implementationProvider: "grok",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });

    expect(direction.state.stage).toBe("visual-direction-approval");
    expect(direction.state.orchestratorProvider).toBe("claude");
    expect(direction.state.implementationProvider).toBe("grok");
    expect(direction.state.imageProvider).toBe("none");
    expect(direction.concept?.image.mediaType).toBe("image/png");
    expect(direction.concept?.image.byteLength).toBeGreaterThan(10_000);
    const conceptRevisionId = direction.state.concept?.revisionId;
    const eventCount = firstRepository.listEvents(
      direction.state.projectId,
    ).length;

    await firstCoordinator.advance(direction.state.projectId);
    expect(
      firstRepository.getProject(direction.state.projectId).concept?.revisionId,
    ).toBe(conceptRevisionId);
    expect(firstRepository.listEvents(direction.state.projectId)).toHaveLength(
      eventCount,
    );
    firstRepository.close();

    const restartedRepository = new ProjectRepository(root);
    const restartedCoordinator = new M0Coordinator(restartedRepository);
    const restored = restartedCoordinator.snapshot(direction.state.projectId);
    expect(restored.state.stage).toBe("visual-direction-approval");
    expect(restored.state.concept?.revisionId).toBe(conceptRevisionId);

    const replacement = await restartedCoordinator.approveDirection(
      direction.state.projectId,
      { decision: "changes-requested" },
    );
    expect(replacement.state.stage).toBe("visual-direction-approval");
    expect(replacement.state.conceptReplacementCount).toBe(1);
    expect(replacement.state.concept?.revisionId).not.toBe(conceptRevisionId);
    expect(replacement.concept?.image.sha256).not.toBe(
      direction.concept?.image.sha256,
    );

    const slice = await restartedCoordinator.approveDirection(
      direction.state.projectId,
      { decision: "approved" },
    );
    expect(slice.state.stage).toBe("visual-slice-approval");
    expect(slice.asset?.glb.mediaType).toBe("model/gltf-binary");
    expect(slice.assetEvaluation?.passed).toBe(true);
    expect(slice.assetEvaluation?.measurements.meshCount).toBeGreaterThan(0);
    expect(slice.assetEvaluation?.measurements.triangleCount).toBeGreaterThan(
      0,
    );
    expect(slice.scene?.entities[0]?.assetRevisionId).toBe(
      slice.state.asset?.revisionId,
    );

    const reviewBytes = restartedRepository.readArtifact(
      direction.concept!.image,
    );
    const withReview = restartedCoordinator.storeReviewImage(
      direction.state.projectId,
      `data:image/png;base64,${Buffer.from(reviewBytes).toString("base64")}`,
    );
    expect(withReview.state.reviewImage?.sha256).toBe(
      direction.concept?.image.sha256,
    );

    const complete = restartedCoordinator.approveSlice(
      direction.state.projectId,
      { decision: "approved" },
    );
    expect(complete.state.status).toBe("complete");
    expect(complete.state.sliceApproval?.targetSha256).toBe(
      complete.state.scene?.artifact.sha256,
    );
    restartedRepository.close();
  });

  it("deduplicates identical artifact bytes inside a project", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = "artifact-test-project";
    repository.reserveProject(projectId);
    const bytes = new TextEncoder().encode("immutable content");
    const first = repository.putArtifact(projectId, bytes, "text/plain");
    const second = repository.putArtifact(projectId, bytes, "text/plain");
    expect(second).toEqual(first);
    repository.close();
  });

  it("blocks an ambiguous paid submission instead of calling the provider again", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new M0Coordinator(repository);
    const direction = await coordinator.create({
      brief: M0_FIXTURE_BRIEF,
      mode: "replay",
      assetProvider: "meshy",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    const concept = direction.state.concept!;
    const idempotencyKey = `asset:${direction.state.projectId}:${concept.artifact.sha256}:live:tripo`;
    const intent = repository.recordSubmissionIntent({
      projectId: direction.state.projectId,
      operation: "image-to-model",
      provider: "tripo",
      idempotencyKey,
      payload: { crashFixture: true },
    });

    const outcome = await new AssetProduction(repository).ensure({
      projectId: direction.state.projectId,
      runId: direction.state.runId,
      mode: "live",
      assetProvider: "tripo",
      concept,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error.code).toBe("submission-unknown");
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "submission-unknown",
    );
    expect(repository.getSubmissionByKey(idempotencyKey)?.requestId).toBe(
      intent.requestId,
    );
    repository.close();
  });

  it("submits and reconciles a Meshy image-to-3D task through the asset interface", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new M0Coordinator(repository);
    const direction = await coordinator.create({
      brief: M0_FIXTURE_BRIEF,
      mode: "replay",
      assetProvider: "meshy",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    const glb = await createReplayReliquary();
    const glbBuffer = new ArrayBuffer(glb.byteLength);
    new Uint8Array(glbBuffer).set(glb);
    const fetchMock = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/image-to-3d") && init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          expect(payload.ai_model).toBe("meshy-6");
          expect(payload.target_formats).toEqual(["glb"]);
          expect(String(payload.image_url)).toMatch(/^data:image\/png;base64,/);
          return Response.json({ result: "meshy-job-1" });
        }
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
    const production = new AssetProduction(repository);

    const submitted = await production.ensure({
      projectId: direction.state.projectId,
      runId: direction.state.runId,
      mode: "live",
      assetProvider: "meshy",
      concept: direction.state.concept!,
    });
    expect(submitted.status).toBe("pending");

    const completed = await production.ensure({
      projectId: direction.state.projectId,
      runId: direction.state.runId,
      mode: "live",
      assetProvider: "meshy",
      concept: direction.state.concept!,
    });
    expect(completed.status).toBe("ready");
    if (completed.status === "ready") {
      const asset = repository.resolveRevision<AssetDocument>(completed.value);
      expect(asset.provider).toBe("meshy");
      expect(asset.model).toBe("meshy-6");
      expect(asset.externalJobId).toBe("meshy-job-1");
    }
    expect(repository.getProject(direction.state.projectId).spentUsd).toBe(0.2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    repository.close();
  });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRevisionRef = (value: unknown): value is RevisionRef =>
  isRecord(value) &&
  typeof value.revisionId === "string" &&
  isRecord(value.artifact) &&
  value.artifact.mediaType === "application/json";

const canonicalizer = (repository: ProjectRepository, roots: unknown[]) => {
  const revisions = new Map<string, RevisionRef>();
  const collectRevisions = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectRevisions);
      return;
    }
    if (!isRecord(value)) return;
    if (isRevisionRef(value)) revisions.set(value.revisionId, value);
    Object.values(value).forEach(collectRevisions);
  };
  roots.forEach(collectRevisions);
  const documents = [...revisions.values()].map((revision) =>
    repository.resolveRevision(revision),
  );
  const identityKeys = new Set([
    "projectId",
    "runId",
    "workflowRunId",
    "revisionId",
    "revisionIds",
    "targetRevisionId",
    "sourceRevisionIds",
    "assetRevisionId",
    "conceptRevisionId",
    "sceneRevisionId",
    "selectedVisualDirectionRevisionId",
    "artifactId",
    "approvalId",
    "evaluationId",
    "sceneId",
    "entityId",
    "conceptId",
    "assetId",
    "requestId",
    "externalJobId",
  ]);
  const identities = new Map<string, string>();
  const register = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => register(entry, key));
      return;
    }
    if (!isRecord(value)) {
      if (
        typeof value === "string" &&
        key &&
        identityKeys.has(key) &&
        !identities.has(value)
      )
        identities.set(value, `<${key}:${identities.size + 1}>`);
      return;
    }
    for (const [childKey, child] of Object.entries(value))
      register(child, childKey);
  };
  [...roots, ...documents].forEach((value) => register(value));
  const normalizeString = (value: string): string => {
    let normalized = value.replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
      "<timestamp>",
    );
    for (const [identity, label] of [...identities.entries()].sort(
      ([left], [right]) => right.length - left.length,
    ))
      normalized = normalized.split(identity).join(label);
    return normalized;
  };
  const jsonHashes = new Map<string, string>();
  const normalize = (
    value: unknown,
    key?: string,
    parent?: Record<string, unknown>,
  ): unknown => {
    if (typeof value === "string") {
      if (key === "targetSha256" && jsonHashes.has(value))
        return jsonHashes.get(value);
      if (
        key === "sha256" &&
        parent?.mediaType === "application/json" &&
        jsonHashes.has(value)
      )
        return jsonHashes.get(value);
      return normalizeString(value);
    }
    if (Array.isArray(value))
      return value.map((entry) => normalize(entry, key));
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [
          childKey,
          normalize(value[childKey], childKey, value),
        ]),
    );
  };
  for (const revision of revisions.values()) {
    const document = repository.resolveRevision(revision);
    const bytes = JSON.stringify(normalize(document));
    jsonHashes.set(
      revision.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
  return (value: unknown): string => JSON.stringify(normalize(value));
};

const replayDeterminismRun = async () => {
  const repository = new ProjectRepository(temporaryRoot());
  const coordinator = new M0Coordinator(repository);
  let snapshot = await coordinator.create({
    brief: M0_FIXTURE_BRIEF,
    mode: "replay",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "none",
    budgetUsd: 1,
    rightsConfirmed: true,
  });
  snapshot = await coordinator.approveDirection(snapshot.state.projectId, {
    decision: "approved",
  });
  snapshot = coordinator.approveSlice(snapshot.state.projectId, {
    decision: "approved",
  });
  const state = snapshot.state;
  const concept = repository.resolveRevision<Record<string, unknown>>(
    state.concept!,
  );
  const asset = repository.resolveRevision<AssetDocument>(state.asset!);
  const quality = repository.resolveRevision<Record<string, unknown>>(
    state.assetEvaluation!,
  );
  const scene = repository.resolveRevision<Record<string, unknown>>(
    state.scene!,
  );
  const events = repository
    .listEvents(state.projectId)
    .map(({ type, payload }) => ({ type, payload }));
  const roots = [concept, asset, quality, scene, snapshot, events];
  const canonical = canonicalizer(repository, roots);
  const raw = {
    brief: Buffer.from(repository.readArtifact(state.brief.artifact)).toString(
      "base64",
    ),
    gameDesign: Buffer.from(
      repository.readArtifact(state.gameDesign!.artifact),
    ).toString("base64"),
    visualBible: Buffer.from(
      repository.readArtifact(state.visualBible!.artifact),
    ).toString("base64"),
    conceptPng: Buffer.from(
      repository.readArtifact(concept.image as ArtifactRef),
    ).toString("base64"),
    glb: Buffer.from(repository.readArtifact(asset.glb)).toString("base64"),
  };
  const result = {
    raw,
    canonical: {
      concept: canonical(concept),
      asset: canonical(asset),
      quality: canonical(quality),
      scene: canonical(scene),
      snapshot: canonical(snapshot),
      events: canonical(events),
    },
    eventOrder: events.map(({ type }) => type),
  };
  repository.close();
  return result;
};

describe("M0 replay determinism", () => {
  it("two_fresh_replay_runs_match_raw_content_bytes_and_canonical_lineage", async () => {
    const first = await replayDeterminismRun();
    const second = await replayDeterminismRun();

    expect(second.raw).toEqual(first.raw);
    expect(second.canonical).toEqual(first.canonical);
  });

  it("canonicalizer_does_not_hide_changed_prompt_measurement_or_stage", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const normalize = canonicalizer(repository, []);
    const baseline = {
      prompt: "A squat stone reliquary",
      measurements: { triangleCount: 10 },
      stage: "asset-quality",
    };

    expect(normalize({ ...baseline, prompt: "A tall glass tower" })).not.toBe(
      normalize(baseline),
    );
    expect(
      normalize({ ...baseline, measurements: { triangleCount: 11 } }),
    ).not.toBe(normalize(baseline));
    expect(normalize({ ...baseline, stage: "scene-composition" })).not.toBe(
      normalize(baseline),
    );
    repository.close();
  });

  it("replay_event_type_and_checkpoint_order_is_identical", async () => {
    const first = await replayDeterminismRun();
    const second = await replayDeterminismRun();

    expect(second.eventOrder).toEqual(first.eventOrder);
    expect(second.canonical.events).toBe(first.canonical.events);
  });
});
