import {
  ProviderPreflightError,
  type ArtifactRef,
  type SubmissionRecord,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";

import {
  assetRequestFingerprint,
  CARDINAL_VIEW_ROLES,
  type AdapterJobRef,
  type AssetGenerationAdapter,
  type AssetGenerationJob,
  type ExternalJobState,
  type MultiviewImageInputCapability,
} from "./asset-generation.js";

const TRIPO_MULTIVIEW_MODELS = new Set(["v2.5-20250123"]);

export class AssetPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetPreparationError";
  }
}

export const tripoMultiviewCapability = (
  modelVersion: string,
): MultiviewImageInputCapability =>
  TRIPO_MULTIVIEW_MODELS.has(modelVersion)
    ? {
        supported: true,
        minViews: 2,
        maxViews: 4,
        primaryRole: "front",
        roles: CARDINAL_VIEW_ROLES,
        payloadShape: "cardinal-slots",
        profileVersion: "tripo-cardinal-slots-v1",
      }
    : {
        supported: false,
        reason: `Tripo model ${modelVersion} has no declared multiview profile.`,
      };

export const tripoConfiguration = () => {
  const apiKey = process.env.TRIPO_API_KEY;
  const modelVersion = process.env.FULCRUM_TRIPO_MODEL_VERSION;
  if (!apiKey || !modelVersion) {
    throw new ProviderPreflightError(
      "provider-unconfigured",
      "Live asset generation requires TRIPO_API_KEY and FULCRUM_TRIPO_MODEL_VERSION.",
    );
  }
  const reservedCost = Number(process.env.FULCRUM_TRIPO_RESERVE_USD ?? "0.50");
  if (!Number.isFinite(reservedCost) || reservedCost < 0) {
    throw new ProviderPreflightError(
      "payload-invalid",
      "FULCRUM_TRIPO_RESERVE_USD must be a finite non-negative number.",
    );
  }
  return { apiKey, modelVersion, reservedCost };
};

const imageType = (artifact: ArtifactRef): "png" | "jpg" | "webp" =>
  artifact.mediaType === "image/jpeg"
    ? "jpg"
    : artifact.mediaType === "image/webp"
      ? "webp"
      : "png";

const jobImages = (job: AssetGenerationJob) =>
  job.imageInput.kind === "single"
    ? [{ role: "front" as const, image: job.imageInput.image }]
    : [...job.imageInput.views].sort(
        (left, right) =>
          CARDINAL_VIEW_ROLES.indexOf(left.role) -
          CARDINAL_VIEW_ROLES.indexOf(right.role),
      );

export const buildTripoTaskPayload = (
  job: AssetGenerationJob,
  modelVersion: string,
  uploadTokens: Record<string, string>,
): Record<string, unknown> => {
  if (job.imageInput.kind === "single") {
    const token = uploadTokens[job.imageInput.image.sha256];
    if (!token)
      throw new AssetPreparationError("Single image upload is missing.");
    return {
      type: "image_to_model",
      model_version: modelVersion,
      file: {
        type: imageType(job.imageInput.image),
        file_token: token,
      },
    };
  }
  const byRole = new Map(
    job.imageInput.views.map((view) => [view.role, view.image]),
  );
  const files = CARDINAL_VIEW_ROLES.map((role) => {
    const image = byRole.get(role);
    const token = image ? uploadTokens[image.sha256] : undefined;
    if (!image || !token) {
      throw new AssetPreparationError(
        `Tripo multiview input is missing the ${role} upload token.`,
      );
    }
    return { type: imageType(image), file_token: token };
  });
  return {
    type: "multiview_to_model",
    model_version: modelVersion,
    files,
  };
};

const storedTokens = (submission: SubmissionRecord): Record<string, string> => {
  const value = submission.payload.uploadTokens;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

export class TripoAssetAdapter implements AssetGenerationAdapter {
  readonly id = "tripo" as const;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly modelVersionOverride?: string,
  ) {}

  private modelVersion(): string {
    return (
      this.modelVersionOverride ??
      process.env.FULCRUM_TRIPO_MODEL_VERSION ??
      "unconfigured"
    );
  }

  get multiviewImageInput(): MultiviewImageInputCapability {
    return tripoMultiviewCapability(this.modelVersion());
  }

  requestFingerprint(job: AssetGenerationJob): string {
    const modelVersion = this.modelVersion();
    if (modelVersion === "unconfigured") {
      throw new ProviderPreflightError(
        "provider-unconfigured",
        "Tripo request fingerprinting requires FULCRUM_TRIPO_MODEL_VERSION.",
      );
    }
    return assetRequestFingerprint(job, {
      modelVersion,
      endpointKind:
        job.imageInput.kind === "multiview"
          ? "multiview_to_model"
          : "image_to_model",
      generationOptions: {},
    });
  }

  async submit(
    job: AssetGenerationJob,
    idempotencyKey: string,
  ): Promise<AdapterJobRef> {
    const { apiKey, modelVersion } = tripoConfiguration();
    let submission = this.repository.getSubmissionByKey(idempotencyKey);
    if (!submission) {
      throw new Error("Tripo submission intent must exist before preparation.");
    }
    const tokens = storedTokens(submission);
    for (const { image } of jobImages(job)) {
      if (tokens[image.sha256]) continue;
      const bytes = this.repository.readArtifact(image);
      const copied = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copied).set(bytes);
      const form = new FormData();
      form.append(
        "file",
        new Blob([copied], { type: image.mediaType }),
        `concept.${imageType(image)}`,
      );
      let response: Response;
      try {
        response = await fetch("https://api.tripo3d.ai/v2/openapi/upload/sts", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
      } catch (error) {
        throw new AssetPreparationError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const upload = (await response.json()) as {
        data?: { image_token?: string };
        message?: string;
      };
      if (!response.ok || !upload.data?.image_token) {
        throw new AssetPreparationError(
          upload.message ?? `Tripo upload failed (${response.status}).`,
        );
      }
      tokens[image.sha256] = upload.data.image_token;
      submission = this.repository.updateSubmission(submission.requestId, {
        status: "intent-recorded",
        payload: { ...submission.payload, uploadTokens: tokens },
      });
    }

    const taskPayload = buildTripoTaskPayload(job, modelVersion, tokens);
    submission = this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...submission.payload,
        uploadTokens: tokens,
        providerCallStartedAt: new Date().toISOString(),
      },
    });
    const taskResponse = await fetch("https://api.tripo3d.ai/v2/openapi/task", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(taskPayload),
    });
    const task = (await taskResponse.json()) as {
      data?: { task_id?: string };
      message?: string;
    };
    if (!taskResponse.ok || !task.data?.task_id) {
      throw new Error(
        task.message ??
          `Tripo task submission failed (${taskResponse.status}).`,
      );
    }
    return {
      taskId: task.data.task_id,
      jobKind:
        job.imageInput.kind === "multiview" ? "multi-image" : "single-image",
    };
  }

  async inspect(job: AdapterJobRef): Promise<ExternalJobState> {
    const { apiKey, modelVersion, reservedCost } = tripoConfiguration();
    const response = await fetch(
      `https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(job.taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const body = (await response.json()) as {
      data?: {
        status?: string;
        output?: { pbr_model?: string; model?: string };
        consumed_credit?: number;
      };
      message?: string;
    };
    if (!response.ok || !body.data?.status) {
      throw new Error(
        body.message ?? `Tripo polling failed (${response.status}).`,
      );
    }
    if (["queued", "running"].includes(body.data.status)) {
      return {
        status: "pending",
        resumeAfter: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    if (body.data.status !== "success") {
      return {
        status: "failed",
        error: `Tripo task ended with status ${body.data.status}.`,
      };
    }
    const modelUrl = body.data.output?.pbr_model ?? body.data.output?.model;
    if (!modelUrl) {
      return {
        status: "failed",
        error: "Tripo completed without a downloadable model.",
      };
    }
    const modelResponse = await fetch(modelUrl);
    if (!modelResponse.ok) {
      return {
        status: "failed",
        error: `Tripo model download failed (${modelResponse.status}).`,
      };
    }
    return {
      status: "ready",
      asset: {
        bytes: new Uint8Array(await modelResponse.arrayBuffer()),
        provider: "tripo",
        model: modelVersion,
        externalJobId: job.taskId,
        costUsd: reservedCost,
        providerMetadata: {
          consumedCredits: body.data.consumed_credit ?? null,
        },
      },
    };
  }
}
