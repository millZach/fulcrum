import { ProviderPreflightError, type ArtifactRef } from "@fulcrum/domain";
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

const MESHY_MULTIVIEW_MODELS = new Set(["meshy-6", "meshy-7"]);

const MESHY_GENERATION_OPTIONS = {
  model_type: "standard",
  should_texture: true,
  enable_pbr: true,
  texture_resolution: "2k",
  should_remesh: false,
  image_enhancement: false,
  moderation: true,
  target_formats: ["glb"],
} as const;

export const meshyMultiviewCapability = (
  model: string,
): MultiviewImageInputCapability =>
  MESHY_MULTIVIEW_MODELS.has(model)
    ? {
        supported: true,
        minViews: 2,
        maxViews: 4,
        primaryRole: "front",
        roles: CARDINAL_VIEW_ROLES,
        payloadShape: "ordered-images",
        profileVersion: "meshy-multi-image-v1",
      }
    : {
        supported: false,
        reason: `Meshy model ${model} has no declared multiview profile.`,
      };

export const meshyConfiguration = () => {
  const apiKey = process.env.MESHY_API_KEY;
  const model = process.env.FULCRUM_MESHY_MODEL;
  if (!apiKey || !model) {
    throw new ProviderPreflightError(
      "provider-unconfigured",
      "Live Meshy generation requires MESHY_API_KEY and FULCRUM_MESHY_MODEL.",
    );
  }
  const reservedCost = Number(process.env.FULCRUM_MESHY_RESERVE_USD ?? "0.50");
  if (!Number.isFinite(reservedCost) || reservedCost < 0) {
    throw new ProviderPreflightError(
      "payload-invalid",
      "FULCRUM_MESHY_RESERVE_USD must be a finite non-negative number.",
    );
  }
  return { apiKey, model, reservedCost };
};

const dataUri = (artifact: ArtifactRef, bytes: Uint8Array): string =>
  `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

export const buildMeshyRequest = (
  job: AssetGenerationJob,
  model: string,
  readArtifact: (artifact: ArtifactRef) => Uint8Array,
): {
  endpointKind: "image-to-3d" | "multi-image-to-3d";
  jobKind: "single-image" | "multi-image";
  body: Record<string, unknown>;
} => {
  if (job.imageInput.kind === "single") {
    return {
      endpointKind: "image-to-3d",
      jobKind: "single-image",
      body: {
        image_url: dataUri(
          job.imageInput.image,
          readArtifact(job.imageInput.image),
        ),
        model_type: MESHY_GENERATION_OPTIONS.model_type,
        ai_model: model,
        should_texture: MESHY_GENERATION_OPTIONS.should_texture,
        enable_pbr: MESHY_GENERATION_OPTIONS.enable_pbr,
        texture_resolution: MESHY_GENERATION_OPTIONS.texture_resolution,
        should_remesh: MESHY_GENERATION_OPTIONS.should_remesh,
        image_enhancement: MESHY_GENERATION_OPTIONS.image_enhancement,
        ...(model === "meshy-6" ? { remove_lighting: true } : {}),
        moderation: MESHY_GENERATION_OPTIONS.moderation,
        target_formats: MESHY_GENERATION_OPTIONS.target_formats,
      },
    };
  }
  const ordered = [...job.imageInput.views].sort(
    (left, right) =>
      CARDINAL_VIEW_ROLES.indexOf(left.role) -
      CARDINAL_VIEW_ROLES.indexOf(right.role),
  );
  if (
    ordered[0]?.role !== "front" ||
    ordered.length < 2 ||
    ordered.length > 4
  ) {
    throw new ProviderPreflightError(
      "payload-invalid",
      "Meshy multiview input requires front first and two to four cardinal views.",
    );
  }
  return {
    endpointKind: "multi-image-to-3d",
    jobKind: "multi-image",
    body: {
      image_urls: ordered.map(({ image }) =>
        dataUri(image, readArtifact(image)),
      ),
      model_type: MESHY_GENERATION_OPTIONS.model_type,
      ai_model: model,
      should_texture: MESHY_GENERATION_OPTIONS.should_texture,
      enable_pbr: MESHY_GENERATION_OPTIONS.enable_pbr,
      texture_resolution: MESHY_GENERATION_OPTIONS.texture_resolution,
      should_remesh: MESHY_GENERATION_OPTIONS.should_remesh,
      image_enhancement: MESHY_GENERATION_OPTIONS.image_enhancement,
      ...(model === "meshy-6" ? { remove_lighting: true } : {}),
      moderation: MESHY_GENERATION_OPTIONS.moderation,
      target_formats: MESHY_GENERATION_OPTIONS.target_formats,
    },
  };
};

export class MeshyAssetAdapter implements AssetGenerationAdapter {
  readonly id = "meshy" as const;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly modelOverride?: string,
  ) {}

  private model(): string {
    return (
      this.modelOverride ?? process.env.FULCRUM_MESHY_MODEL ?? "unconfigured"
    );
  }

  get multiviewImageInput(): MultiviewImageInputCapability {
    return meshyMultiviewCapability(this.model());
  }

  requestFingerprint(job: AssetGenerationJob): string {
    const model = this.model();
    if (model === "unconfigured") {
      throw new ProviderPreflightError(
        "provider-unconfigured",
        "Meshy request fingerprinting requires FULCRUM_MESHY_MODEL.",
      );
    }
    return assetRequestFingerprint(job, {
      modelVersion: model,
      endpointKind:
        job.imageInput.kind === "multiview"
          ? "multi-image-to-3d"
          : "image-to-3d",
      generationOptions: MESHY_GENERATION_OPTIONS,
    });
  }

  async submit(
    job: AssetGenerationJob,
    _idempotencyKey: string,
  ): Promise<AdapterJobRef> {
    const { apiKey, model } = meshyConfiguration();
    const request = buildMeshyRequest(job, model, (artifact) =>
      this.repository.readArtifact(artifact),
    );
    const response = await fetch(
      `https://api.meshy.ai/openapi/v1/${request.endpointKind}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
      },
    );
    const body = (await response.json()) as {
      result?: string;
      message?: string;
      detail?: string;
    };
    if (!response.ok || !body.result) {
      throw new Error(
        body.message ??
          body.detail ??
          `Meshy task submission failed (${response.status}).`,
      );
    }
    return { taskId: body.result, jobKind: request.jobKind };
  }

  async inspect(job: AdapterJobRef): Promise<ExternalJobState> {
    const { apiKey, model, reservedCost } = meshyConfiguration();
    const endpoint =
      job.jobKind === "multi-image" ? "multi-image-to-3d" : "image-to-3d";
    const response = await fetch(
      `https://api.meshy.ai/openapi/v1/${endpoint}/${encodeURIComponent(job.taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const body = (await response.json()) as {
      status?: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
      consumed_credits?: number;
      message?: string;
    };
    if (!response.ok || !body.status) {
      throw new Error(
        body.message ?? `Meshy polling failed (${response.status}).`,
      );
    }
    if (["PENDING", "IN_PROGRESS"].includes(body.status)) {
      return {
        status: "pending",
        resumeAfter: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    if (body.status !== "SUCCEEDED") {
      return {
        status: "failed",
        error: `Meshy task ended with status ${body.status}: ${body.task_error?.message || "unknown error"}.`,
      };
    }
    const modelUrl = body.model_urls?.glb;
    if (!modelUrl) {
      return {
        status: "failed",
        error: "Meshy completed without a downloadable GLB.",
      };
    }
    const modelResponse = await fetch(modelUrl);
    if (!modelResponse.ok) {
      return {
        status: "failed",
        error: `Meshy GLB download failed (${modelResponse.status}).`,
      };
    }
    return {
      status: "ready",
      asset: {
        bytes: new Uint8Array(await modelResponse.arrayBuffer()),
        provider: "meshy",
        model,
        externalJobId: job.taskId,
        costUsd: reservedCost,
        providerMetadata: {
          consumedCredits: body.consumed_credits ?? null,
          providerProgress: body.progress ?? 100,
        },
      },
    };
  }
}
