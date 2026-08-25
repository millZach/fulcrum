import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDurableSubscriptionImage } from "./durable-image.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];

const fixture = (mode: "live" | "replay") => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-multiview-image-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = `m2-${mode}-image`;
  const runId = `m2-${mode}-run`;
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "Multiview durable image fixture.", rightsConfirmed: true },
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "M2 multiview fixture",
    mode,
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    soundProvider: "none",
    status: "active",
    stage: "asset-batch",
    runId,
    budgetUsd: 1,
    spentUsd: 0,
    conceptReplacementCount: 0,
    brief,
    createdAt,
    updatedAt: createdAt,
  });
  const anchor = repository.putArtifact(projectId, PNG_1x1, "image/png");
  return {
    repository,
    projectId,
    runId,
    anchor,
    idempotencyKey: `m2-view:${projectId}:front`,
  };
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("durable multiview image generation", () => {
  it("m2_image_intent_records_anchor_before_runner_call", async () => {
    const context = fixture("replay");
    const runner = vi.fn(async () => {
      expect(
        context.repository.getSubmissionByKey(context.idempotencyKey)?.payload,
      ).toEqual(
        expect.objectContaining({
          operation: "m2-concept-view",
          referenceImages: [
            {
              artifactId: context.anchor.artifactId,
              sha256: context.anchor.sha256,
              mediaType: "image/png",
            },
          ],
        }),
      );
      return { bytes: PNG_1x1, model: "replay-view-v1", costUsd: 0 };
    });

    const outcome = await ensureDurableSubscriptionImage({
      ...context,
      runner,
      prompt: "Front view",
      mode: "replay",
      operation: "m2-concept-view",
      referenceImages: [context.anchor],
    });

    expect(outcome.status).toBe("ready");
    expect(runner).toHaveBeenCalledOnce();
    context.repository.close();
  });

  it("m2_image_runner_receives_verified_anchor_bytes_and_media_type", async () => {
    const context = fixture("replay");
    const runner = vi.fn(async (input) => {
      expect(input.referenceImages).toHaveLength(1);
      expect(input.referenceImages?.[0]?.mediaType).toBe("image/png");
      expect(input.referenceImages?.[0]?.bytes).toEqual(
        context.repository.readArtifact(context.anchor),
      );
      return { bytes: PNG_1x1, model: "replay-view-v1", costUsd: 0 };
    });

    const outcome = await ensureDurableSubscriptionImage({
      ...context,
      runner,
      prompt: "Front view",
      mode: "replay",
      operation: "m2-concept-view",
      referenceImages: [context.anchor],
    });

    expect(outcome.status).toBe("ready");
    context.repository.close();
  });

  it("ready_view_submission_reuses_artifact_without_runner_call", async () => {
    const context = fixture("replay");
    const runner = vi.fn(async () => ({
      bytes: PNG_1x1,
      model: "replay-view-v1",
      costUsd: 0,
    }));
    const input = {
      ...context,
      runner,
      prompt: "Front view",
      mode: "replay" as const,
      operation: "m2-concept-view" as const,
      referenceImages: [context.anchor],
    };

    const first = await ensureDurableSubscriptionImage(input);
    const second = await ensureDurableSubscriptionImage(input);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(second.requestId).toBe(first.requestId);
    expect(runner).toHaveBeenCalledOnce();
    context.repository.close();
  });

  it("live_view_throw_becomes_submission_unknown_and_never_auto_retries", async () => {
    const context = fixture("live");
    const runner = vi.fn(async () => {
      throw new Error("runner disconnected");
    });
    const input = {
      ...context,
      runner,
      prompt: "Front view",
      mode: "live" as const,
      operation: "m2-concept-view" as const,
      referenceImages: [context.anchor],
    };

    const first = await ensureDurableSubscriptionImage(input);
    const second = await ensureDurableSubscriptionImage(input);

    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(
      context.repository.getSubmissionByKey(context.idempotencyKey)?.status,
    ).toBe("submission-unknown");
    expect(runner).toHaveBeenCalledOnce();
    context.repository.close();
  });

  it("replay_view_throw_remains_safely_retryable", async () => {
    const context = fixture("replay");
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture interrupted"))
      .mockResolvedValueOnce({
        bytes: PNG_1x1,
        model: "replay-view-v1",
        costUsd: 0,
      });
    const input = {
      ...context,
      runner,
      prompt: "Front view",
      mode: "replay" as const,
      operation: "m2-concept-view" as const,
      referenceImages: [context.anchor],
    };

    expect((await ensureDurableSubscriptionImage(input)).status).toBe("failed");
    expect((await ensureDurableSubscriptionImage(input)).status).toBe("ready");
    expect(runner).toHaveBeenCalledTimes(2);
    context.repository.close();
  });

  it("subscription_view_generation_never_reserves_project_budget", async () => {
    const context = fixture("live");
    const runner = vi.fn(async () => ({
      bytes: PNG_1x1,
      model: "gpt-image-2",
      costUsd: 0.42,
    }));

    await ensureDurableSubscriptionImage({
      ...context,
      runner,
      prompt: "Front view",
      mode: "live",
      operation: "m2-concept-view",
      referenceImages: [context.anchor],
    });

    expect(context.repository.getProject(context.projectId).spentUsd).toBe(0);
    expect(
      context.repository
        .listEvents(context.projectId)
        .some(({ type }) => type === "budget.reserved"),
    ).toBe(false);
    context.repository.close();
  });
});
