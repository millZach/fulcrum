import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureDurableSubscriptionImage,
  m1ConceptImageIdempotencyKey,
} from "./durable-image.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-durable-image-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  delete process.env.FULCRUM_SUBSCRIPTION_IMAGE_RESERVE_USD;
  delete process.env.FULCRUM_M1_IMAGE_RETRY_LIMIT;
  delete process.env.FULCRUM_M1_IMAGE_TIMEOUT_MS;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const openProject = (
  budgetUsd: number,
): {
  repository: ProjectRepository;
  projectId: string;
  runId: string;
  idempotencyKey: string;
} => {
  const repository = new ProjectRepository(temporaryRoot());
  const projectId = "m1-live-image";
  const runId = "m1-live-run";
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "Live concept image seam fixture.", rightsConfirmed: true },
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m1",
    projectId,
    name: "M1 live image fixture",
    mode: "live",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    status: "awaiting-input",
    stage: "concept-generation",
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
    projectId,
    runId,
    idempotencyKey: m1ConceptImageIdempotencyKey({
      projectId,
      slotId: "gameplay-anchor",
      sourceRevisionIds: [brief.revisionId, "direction-1"],
      attempt: 0,
      mode: "live",
      imageProvider: "openai-subscription",
    }),
  };
};

describe("ensureDurableSubscriptionImage", () => {
  it("records intent, idempotency, and a budget decision on a successful fake run", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const runner = vi.fn(async () => ({
      bytes: PNG_1x1,
      model: "gpt-image-2",
      costUsd: 0,
    }));

    const first = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });
    const second = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(second.requestId).toBe(first.requestId);
    expect(runner).toHaveBeenCalledTimes(1);
    const submission = repository.getSubmissionByKey(idempotencyKey);
    expect(submission?.status).toBe("ready");
    expect(submission?.idempotencyKey).toBe(idempotencyKey);
    expect(submission?.payload.retryLimit).toBe(2);
    expect(submission?.payload.timeoutMs).toBe(360_000);
    expect(repository.getProject(projectId).spentUsd).toBe(0.01);
    expect(
      repository
        .listEvents(projectId)
        .some((event) => event.type === "budget.reserved"),
    ).toBe(true);
    repository.close();
  });

  it("refuses a budget-exhausted key without calling the provider, then proceeds after the cap is raised", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(0.01);
    repository.reserveBudget(projectId, 0.01, "exhaust the cap");
    const runner = vi.fn(async () => ({
      bytes: PNG_1x1,
      model: "gpt-image-2",
      costUsd: 0,
    }));

    const refused = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });

    expect(refused.status).toBe("failed");
    if (refused.status === "failed")
      expect(refused.error.code).toBe("budget-refused");
    expect(runner).not.toHaveBeenCalled();
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "intent-recorded",
    );

    const project = repository.getProject(projectId);
    repository.saveProject({ ...project, budgetUsd: 1 });
    const retried = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });

    expect(retried.status).toBe("ready");
    expect(retried.requestId).toBe(refused.requestId);
    expect(runner).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("does not call the provider again after a live restart between intent and confirmed submission", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    repository.recordSubmissionIntent({
      projectId,
      operation: "m1-concept-image",
      provider: "openai-subscription",
      idempotencyKey,
      payload: { crashFixture: true },
    });
    const runner = vi.fn(async () => ({
      bytes: PNG_1x1,
      model: "gpt-image-2",
      costUsd: 0,
    }));

    const outcome = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error.code).toBe("submission-unknown");
    expect(runner).not.toHaveBeenCalled();
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "submission-unknown",
    );

    const retried = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });
    expect(retried.status).toBe("failed");
    if (retried.status === "failed")
      expect(retried.error.code).toBe("submission-unknown");
    expect(runner).not.toHaveBeenCalled();
    repository.close();
  });

  it("marks a provider throw as submission-unknown and does not retry the runner", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const runner = vi.fn(async () => {
      throw new Error("codex exited 1");
    });

    const outcome = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error.code).toBe("submission-unknown");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "submission-unknown",
    );

    const retried = await ensureDurableSubscriptionImage({
      repository,
      runner,
      projectId,
      runId,
      idempotencyKey,
      prompt: "A readable greenhouse airlock",
      mode: "live",
    });
    expect(retried.status).toBe("failed");
    expect(runner).toHaveBeenCalledTimes(1);
    repository.close();
  });
});
