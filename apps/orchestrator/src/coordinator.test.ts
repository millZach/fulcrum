import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { M0_FIXTURE_BRIEF, type AssetDocument } from "@fulcrum/domain";
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
