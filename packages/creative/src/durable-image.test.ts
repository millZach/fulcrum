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
      prompt: "A readable greenhouse airlock",
    }),
  };
};

describe("ensureDurableSubscriptionImage", () => {
  it("records intent and idempotency without touching budget on a successful subscription run", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const runner = vi.fn(async () => ({
      bytes: PNG_1x1,
      model: "gpt-image-2",
      costUsd: 0.42,
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
    expect(submission?.payload.costUsd).toBe(0);
    if (first.status === "ready") expect(first.value.costUsd).toBe(0);
    expect(repository.getProject(projectId).spentUsd).toBe(0);
    expect(
      repository
        .listEvents(projectId)
        .some((event) => event.type === "budget.reserved"),
    ).toBe(false);
    repository.close();
  });

  it("bypasses an exhausted project budget for subscription generation", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(0);
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

    expect(outcome.status).toBe("ready");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getProject(projectId).spentUsd).toBe(0);
    expect(
      repository
        .listEvents(projectId)
        .some((event) => event.type === "budget.refused"),
    ).toBe(false);
    repository.close();
  });

  it("returns a retryable subscription-quota error without budget spend", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(0);
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("quota_exceeded: too many requests"), {
        status: 429,
      });
    });

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

    expect(first).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "subscription-quota",
          message: expect.stringMatching(/subscription usage.*limited/i),
          recoverable: true,
        }),
      }),
    );
    expect(second.status).toBe("failed");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(repository.getSubmissionByKey(idempotencyKey)?.payload).toEqual(
      expect.objectContaining({
        usageCode: "subscription-quota",
      }),
    );
    expect(repository.getProject(projectId).spentUsd).toBe(0);
    repository.close();
  });

  it("retries an interrupted subscription call when the stored attempt has headroom", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const intent = repository.recordSubmissionIntent({
      projectId,
      operation: "m1-concept-image",
      provider: "openai-subscription",
      idempotencyKey,
      payload: {
        retryLimit: 2,
        timeoutMs: 360_000,
        providerAttemptCount: 1,
        providerCallStartedAt: "2026-08-25T12:00:00.000Z",
      },
    });
    repository.updateSubmission(intent.requestId, {
      status: "pending",
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

    expect(outcome.status).toBe("ready");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)).toMatchObject({
      requestId: intent.requestId,
      status: "ready",
      payload: { providerAttemptCount: 2 },
    });
    repository.close();
  });

  it("retries a prior submission-unknown row when the stored attempt has headroom", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const intent = repository.recordSubmissionIntent({
      projectId,
      operation: "m1-concept-image",
      provider: "openai-subscription",
      idempotencyKey,
      payload: {
        retryLimit: 2,
        timeoutMs: 360_000,
        providerAttemptCount: 1,
        providerCallStartedAt: "2026-08-25T12:00:00.000Z",
      },
    });
    repository.updateSubmission(intent.requestId, {
      status: "submission-unknown",
      payload: {
        ...intent.payload,
        error: "codex timed out.",
      },
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

    expect(outcome.status).toBe("ready");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)).toMatchObject({
      requestId: intent.requestId,
      status: "ready",
      payload: { providerAttemptCount: 2 },
    });
    repository.close();
  });

  it("retries a live timeout in place and succeeds in the same ensure call", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 1) throw new Error("codex timed out.");
      return {
        bytes: PNG_1x1,
        model: "gpt-image-2",
        costUsd: 0,
      };
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

    expect(outcome.status).toBe("ready");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(repository.getSubmissionByKey(idempotencyKey)).toMatchObject({
      status: "ready",
      payload: { providerAttemptCount: 2 },
    });
    repository.close();
  });

  it("parks exhausted subscription failures as spend-safe user action", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const runner = vi.fn(async () => {
      throw new Error("codex timed out.");
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

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "concept-generation-failed",
          message: expect.stringMatching(
            /subscription-covered.*\$0.*spend-safe/i,
          ),
          failureKind: "user-action-required",
        }),
      }),
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(repository.getSubmissionByKey(idempotencyKey)).toMatchObject({
      status: "failed",
      payload: { providerAttemptCount: 2 },
    });

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
    expect(runner).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it("refuses an exhausted submission-unknown row without a provider call", async () => {
    const { repository, projectId, runId, idempotencyKey } = openProject(1);
    const intent = repository.recordSubmissionIntent({
      projectId,
      operation: "m1-concept-image",
      provider: "openai-subscription",
      idempotencyKey,
      payload: {
        retryLimit: 2,
        timeoutMs: 360_000,
        providerAttemptCount: 2,
        providerCallStartedAt: "2026-08-25T12:00:00.000Z",
      },
    });
    repository.updateSubmission(intent.requestId, {
      status: "submission-unknown",
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

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          message: expect.stringMatching(/retry limit/i),
        }),
      }),
    );
    expect(runner).not.toHaveBeenCalled();
    repository.close();
  });
});

describe("m1ConceptImageIdempotencyKey", () => {
  it("changes when the prompt changes and stays put when only the text is identical", () => {
    const base = {
      projectId: "p1",
      slotId: "gameplay-anchor",
      sourceRevisionIds: ["rev-a", "rev-b"],
      attempt: 0,
      mode: "live" as const,
      imageProvider: "openai-subscription" as const,
    };
    const first = m1ConceptImageIdempotencyKey({
      ...base,
      prompt: "unedited greenhouse airlock",
    });
    const edited = m1ConceptImageIdempotencyKey({
      ...base,
      prompt: "edited greenhouse airlock",
    });
    const again = m1ConceptImageIdempotencyKey({
      ...base,
      prompt: "unedited greenhouse airlock",
    });
    expect(edited).not.toBe(first);
    expect(again).toBe(first);
  });
});
