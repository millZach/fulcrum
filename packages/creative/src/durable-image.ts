import { createHash } from "node:crypto";

import {
  ArtifactRefSchema,
  decideDurableSubmission,
  isProviderPreflightError,
  ProviderPreflightError,
  type ArtifactRef,
  type ImageProvider,
  type ProductionOutcome,
  type ProviderMode,
  type SubmissionRecord,
} from "@fulcrum/domain";
import type { SubscriptionImageRunner } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import sharp from "sharp";

import { subscriptionQuotaError } from "./provider-usage.js";

export const M1_LIVE_AUTHORIZATION_ENV = "FULCRUM_M1_LIVE_AUTHORIZED";
export const M1_IMAGE_RETRY_LIMIT_ENV = "FULCRUM_M1_IMAGE_RETRY_LIMIT";
export const M1_IMAGE_TIMEOUT_MS_ENV = "FULCRUM_M1_IMAGE_TIMEOUT_MS";

const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_TIMEOUT_MS = 360_000;

export type DurableImageResult = {
  bytes: Uint8Array;
  model: string;
  costUsd: number;
  artifact: ArtifactRef;
};

export const isM1LiveAuthorized = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean => {
  const value = environment[M1_LIVE_AUTHORIZATION_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
};

export const m1LiveAuthorizationMessage = (): string =>
  `Live M1 is not authorized. Set ${M1_LIVE_AUTHORIZATION_ENV}=true to enable a budget-capped live run.`;

export const m1ConceptImageIdempotencyKey = (input: {
  projectId: string;
  slotId: string;
  sourceRevisionIds: string[];
  attempt: number;
  mode: ProviderMode;
  imageProvider: ImageProvider;
  prompt: string;
}): string => {
  const lineage = createHash("sha256")
    .update([...new Set(input.sourceRevisionIds)].join("|"))
    .digest("hex");
  const promptHash = createHash("sha256").update(input.prompt).digest("hex");
  return `m1-concept:${input.projectId}:${input.slotId}:${lineage}:${input.attempt}:${input.mode}:${input.imageProvider}:${promptHash}`;
};

const readPositiveLimit = (name: string, fallback: number): number => {
  const amount = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ProviderPreflightError(
      "payload-invalid",
      `${name} must be a positive number.`,
    );
  }
  return amount;
};

const withElapsedLimit = async <T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `ImageGen elapsed-time limit of ${timeoutMs}ms exceeded.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const imageArtifactFromPayload = (
  payload: Record<string, unknown>,
): ArtifactRef | undefined => {
  const parsed = ArtifactRefSchema.safeParse(payload.imageArtifact);
  return parsed.success ? parsed.data : undefined;
};

const refuseBeforeProviderCall = (
  repository: ProjectRepository,
  submission: SubmissionRecord,
  error: ProviderPreflightError,
): ProductionOutcome<DurableImageResult> => {
  repository.updateSubmission(submission.requestId, {
    status: "intent-recorded",
    payload: {
      ...submission.payload,
      preflightCode: error.code,
      error: error.message,
    },
  });
  return {
    status: "failed",
    requestId: submission.requestId,
    error: {
      code: error.code,
      message: error.message,
      recoverable: true,
    },
  };
};

const retryableSubscriptionQuota = (
  submission: SubmissionRecord | undefined,
): submission is SubmissionRecord =>
  submission?.status === "failed" &&
  submission.payload.usageCode === "subscription-quota";

export const ensureDurableSubscriptionImage = async (input: {
  repository: ProjectRepository;
  runner: SubscriptionImageRunner;
  projectId: string;
  runId: string;
  idempotencyKey: string;
  prompt: string;
  mode: ProviderMode;
  provider?: string;
}): Promise<ProductionOutcome<DurableImageResult>> => {
  const provider = input.provider ?? "openai-subscription";
  const prior = input.repository.getSubmissionByKey(input.idempotencyKey);
  if (prior?.status === "ready") {
    const artifact = imageArtifactFromPayload(prior.payload);
    const model =
      typeof prior.payload.model === "string" ? prior.payload.model : undefined;
    const costUsd =
      typeof prior.payload.costUsd === "number"
        ? prior.payload.costUsd
        : undefined;
    if (!artifact || !model || costUsd === undefined) {
      return {
        status: "failed",
        requestId: prior.requestId,
        error: {
          code: "concept-generation-failed",
          message:
            "The previous concept image is marked ready without a stored artifact.",
          recoverable: true,
        },
      };
    }
    return {
      status: "ready",
      requestId: prior.requestId,
      value: {
        bytes: input.repository.readArtifact(artifact),
        model,
        costUsd,
        artifact,
      },
    };
  }

  const decision = retryableSubscriptionQuota(prior)
    ? ({ kind: "proceed", submission: prior } as const)
    : decideDurableSubmission(prior, input.mode);
  if (decision.kind === "ready") {
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code: "concept-generation-failed",
        message:
          "The previous concept image is marked ready without a stored artifact.",
        recoverable: true,
      },
    };
  }
  if (decision.kind === "terminal-failed") {
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code:
          decision.submission.status === "submission-unknown"
            ? "submission-unknown"
            : "concept-generation-failed",
        message:
          decision.submission.status === "submission-unknown"
            ? "The live concept request may have reached OpenAI before interruption; Fulcrum will not spend again automatically."
            : "The previous concept image job failed and requires user-directed regeneration.",
        recoverable: true,
      },
    };
  }
  if (decision.kind === "unknown-interruption") {
    input.repository.updateSubmission(decision.submission.requestId, {
      status: "submission-unknown",
    });
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code: "submission-unknown",
        message:
          "The live concept request may have reached OpenAI before interruption; Fulcrum will not spend again automatically.",
        recoverable: true,
      },
    };
  }
  if (decision.kind === "inspect") {
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code: "concept-generation-failed",
        message:
          "Subscription ImageGen has no external job to inspect; this submission cannot be polled.",
        recoverable: true,
      },
    };
  }

  const submission =
    decision.submission ??
    input.repository.recordSubmissionIntent({
      projectId: input.projectId,
      operation: "m1-concept-image",
      provider,
      idempotencyKey: input.idempotencyKey,
      payload: {
        prompt: input.prompt,
      },
    });

  try {
    const retryLimit = readPositiveLimit(
      M1_IMAGE_RETRY_LIMIT_ENV,
      DEFAULT_RETRY_LIMIT,
    );
    const timeoutMs = readPositiveLimit(
      M1_IMAGE_TIMEOUT_MS_ENV,
      DEFAULT_TIMEOUT_MS,
    );
    const attempts = Number(submission.payload.providerAttemptCount ?? 0);
    const storedRetryLimit = Number(
      submission.payload.retryLimit ?? retryLimit,
    );
    if (Number.isFinite(storedRetryLimit) && attempts >= storedRetryLimit) {
      throw new ProviderPreflightError(
        "payload-invalid",
        `ImageGen retry limit of ${storedRetryLimit} has been reached for this idempotency key.`,
      );
    }
    const {
      preflightCode: _preflightCode,
      error: _preflightError,
      usageCode: _usageCode,
      ...intentPayload
    } = submission.payload;
    const storedTimeoutMs = Number(intentPayload.timeoutMs ?? timeoutMs);
    input.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...intentPayload,
        retryLimit: storedRetryLimit,
        timeoutMs: Number.isFinite(storedTimeoutMs)
          ? storedTimeoutMs
          : timeoutMs,
        providerAttemptCount: attempts + 1,
        providerCallStartedAt: new Date().toISOString(),
      },
    });

    let generated;
    try {
      generated = await withElapsedLimit(
        input.runner({ prompt: input.prompt }),
        Number.isFinite(storedTimeoutMs) ? storedTimeoutMs : timeoutMs,
      );
    } catch (error) {
      const quota = subscriptionQuotaError(error, "OpenAI");
      const current =
        input.repository.getSubmissionByKey(input.idempotencyKey) ?? submission;
      if (quota) {
        input.repository.updateSubmission(submission.requestId, {
          status: "failed",
          payload: {
            ...current.payload,
            usageCode: quota.code,
            error: quota.message,
          },
        });
        return {
          status: "failed",
          requestId: submission.requestId,
          error: {
            code: quota.code,
            message: quota.message,
            recoverable: true,
          },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      input.repository.updateSubmission(submission.requestId, {
        status: "submission-unknown",
        payload: { ...current.payload, error: message },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: { code: "submission-unknown", message, recoverable: true },
      };
    }

    const png = await sharp(generated.bytes).png().toBuffer();
    const artifact = input.repository.putArtifact(
      input.projectId,
      png,
      "image/png",
    );
    const current =
      input.repository.getSubmissionByKey(input.idempotencyKey) ?? submission;
    input.repository.updateSubmission(submission.requestId, {
      status: "ready",
      payload: {
        ...current.payload,
        model: generated.model,
        costUsd: 0,
        imageArtifact: artifact,
      },
    });
    input.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: "concept.image-completed",
      payload: {
        requestId: submission.requestId,
        imageArtifactId: artifact.artifactId,
        costUsd: 0,
      },
    });
    return {
      status: "ready",
      requestId: submission.requestId,
      value: {
        bytes: png,
        model: generated.model,
        costUsd: 0,
        artifact,
      },
    };
  } catch (error) {
    if (isProviderPreflightError(error))
      return refuseBeforeProviderCall(input.repository, submission, error);
    const message = error instanceof Error ? error.message : String(error);
    input.repository.updateSubmission(submission.requestId, {
      status: "failed",
      payload: { ...submission.payload, error: message },
    });
    return {
      status: "failed",
      requestId: submission.requestId,
      error: {
        code: "concept-generation-failed",
        message,
        recoverable: true,
      },
    };
  }
};
