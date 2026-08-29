import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDurableSubscriptionImage } from "./durable-image.js";
import { createMultiviewReplayRunner } from "./multiview-replay.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const referenceImages = [{ bytes: PNG_1x1, mediaType: "image/png" as const }];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("deterministic multiview replay runner", () => {
  it("replay_view_same_anchor_and_role_produces_identical_png_hash", async () => {
    const runner = createMultiviewReplayRunner("front");

    const first = await runner({ prompt: "first", referenceImages });
    const second = await runner({ prompt: "second", referenceImages });

    expect(hash(first.bytes)).toBe(hash(second.bytes));
    expect(first.model).toBe("fulcrum-multiview-replay-v1");
  });

  it("replay_front_left_back_and_right_produce_four_distinct_hashes", async () => {
    const hashes = await Promise.all(
      (["front", "left", "back", "right"] as const).map(async (role) =>
        hash(
          (
            await createMultiviewReplayRunner(role)({
              prompt: `${role} view`,
              referenceImages,
            })
          ).bytes,
        ),
      ),
    );

    expect(new Set(hashes).size).toBe(4);
  });

  it("replay_view_requires_the_anchor_reference", async () => {
    await expect(
      createMultiviewReplayRunner("back")({ prompt: "Back view" }),
    ).rejects.toThrow(/anchor reference/i);
  });
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("replay_view_still_passes_through_durable_submission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-view-replay-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = "m2-replay-view";
  const runId = "run-1";
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "Replay view durable fixture.", rightsConfirmed: true },
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "M2 replay view fixture",
    mode: "replay",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    soundProvider: "none",
    status: "active",
    stage: "asset-batch",
    runId,
    spentUsd: 0,
    conceptReplacementCount: 0,
    brief,
    createdAt,
    updatedAt: createdAt,
  });
  const anchor = repository.putArtifact(projectId, PNG_1x1, "image/png");
  const idempotencyKey = "m2-view:front:durable-replay";

  const outcome = await ensureDurableSubscriptionImage({
    repository,
    runner: createMultiviewReplayRunner("front"),
    projectId,
    runId,
    idempotencyKey,
    prompt: "Front view",
    mode: "replay",
    operation: "m2-concept-view",
    referenceImages: [anchor],
  });

  expect(outcome.status).toBe("ready");
  expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe("ready");
  expect(
    repository
      .listEvents(projectId)
      .some(({ type }) => type === "concept-view.image-completed"),
  ).toBe(true);
  repository.close();
});
