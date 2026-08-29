import { createHash } from "node:crypto";

import {
  MESHY_STAGE_CREDITS,
  ProviderPreflightError,
  type ArtifactRef,
  type MeshyConfig,
  type MeshyStage,
  type MeshyTaskStatus,
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

export const FULCRUM_MESHY_MODEL = "meshy-6" as const;
export const MESHY_GEOMETRY_CREDITS = MESHY_STAGE_CREDITS.geometry;
export const MESHY_TEXTURE_CREDITS = MESHY_STAGE_CREDITS.texture;
export const MESHY_RIG_CREDITS = MESHY_STAGE_CREDITS.rig;
export const MESHY_ANIMATION_CREDITS = MESHY_STAGE_CREDITS.animation;

/**
 * Meshy's rigger rejects an `input_task_id` model above 300,000 faces. Its
 * human reference says 300,000 and its OpenAPI description says 320,000;
 * Fulcrum takes the stricter number, because being refused after paying is
 * worse than declining to submit.
 */
export const MESHY_RIG_MAX_FACES = 300_000;

/** Meshy deletes API results three days after a task finishes. */
export const MESHY_RESULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;

const MESHY_MULTIVIEW_MODELS = new Set<string>([FULCRUM_MESHY_MODEL]);

const MESHY_BASE_GENERATION_OPTIONS = {
  model_type: "standard",
  moderation: true,
  target_formats: ["glb"],
} as const;

const meshyGenerationOptions = (job: AssetGenerationJob) => {
  const geometryOnly = job.stage === "geometry";
  return {
    ...MESHY_BASE_GENERATION_OPTIONS,
    should_texture: !geometryOnly,
    should_remesh: false,
    image_enhancement: geometryOnly,
    ...(geometryOnly
      ? {
          auto_size: true,
          origin_at: "bottom",
          alpha_thumbnail: true,
          multi_view_thumbnails: true,
        }
      : {
          enable_pbr: true,
          texture_resolution: "2k",
          remove_lighting: true,
        }),
    ...(job.poseMode ? { pose_mode: job.poseMode } : {}),
  } as const;
};

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
  const model = process.env.FULCRUM_MESHY_MODEL ?? FULCRUM_MESHY_MODEL;
  if (!apiKey) {
    throw new ProviderPreflightError(
      "provider-unconfigured",
      "Live Meshy generation requires MESHY_API_KEY.",
    );
  }
  if (model !== FULCRUM_MESHY_MODEL) {
    throw new ProviderPreflightError(
      "payload-invalid",
      `Fulcrum pins Meshy generation to ${FULCRUM_MESHY_MODEL}; received ${model}.`,
    );
  }
  const reservedCost = Number(process.env.FULCRUM_MESHY_RESERVE_USD ?? "0.50");
  if (!Number.isFinite(reservedCost) || reservedCost < 0) {
    throw new ProviderPreflightError(
      "payload-invalid",
      "FULCRUM_MESHY_RESERVE_USD must be a finite non-negative number.",
    );
  }
  return {
    apiKey,
    model: FULCRUM_MESHY_MODEL,
    reservedCost,
    geometryCredits: MESHY_GEOMETRY_CREDITS,
    textureCredits: MESHY_TEXTURE_CREDITS,
  };
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
  const generationOptions = meshyGenerationOptions(job);
  if (job.imageInput.kind === "single") {
    return {
      endpointKind: "image-to-3d",
      jobKind: "single-image",
      body: {
        image_url: dataUri(
          job.imageInput.image,
          readArtifact(job.imageInput.image),
        ),
        ai_model: model,
        ...generationOptions,
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
      ai_model: model,
      ...generationOptions,
    },
  };
};

export type MeshyRetextureJob = {
  projectId: string;
  assetId: string;
  sourceModel: ArtifactRef;
  styleImage: ArtifactRef;
};

const modelDataUri = (bytes: Uint8Array): string =>
  `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;

export const buildMeshyRetextureRequest = (
  job: MeshyRetextureJob,
  readArtifact: (artifact: ArtifactRef) => Uint8Array,
): Record<string, unknown> => ({
  model_url: modelDataUri(readArtifact(job.sourceModel)),
  image_style_url: dataUri(job.styleImage, readArtifact(job.styleImage)),
  ai_model: FULCRUM_MESHY_MODEL,
  enable_original_uv: true,
  enable_pbr: true,
  texture_resolution: "4k",
  remove_lighting: true,
  target_formats: ["glb"],
  alpha_thumbnail: true,
});

export const meshyRetextureFingerprint = (job: MeshyRetextureJob): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        assetId: job.assetId,
        sourceModelSha256: job.sourceModel.sha256,
        styleImageSha256: job.styleImage.sha256,
        model: FULCRUM_MESHY_MODEL,
        textureResolution: "4k",
        enablePbr: true,
        enableOriginalUv: true,
        removeLighting: true,
      }),
    )
    .digest("hex");

/* ------------------------------------------------------------------------- *
 * Staged lifecycle request bodies
 *
 * The single-shot gate sent one body and hoped. The staged gate sends four,
 * each priced separately, each built from the project's pinned config. Every
 * field below is load-bearing:
 *
 *  - `ai_model` is the pinned version, never "latest". "latest" repointed in
 *    January 2026 and quadrupled the per-task price of everyone still using it.
 *  - `should_remesh` is always explicit. Meshy silently ignores `topology` and
 *    `target_polycount` unless it is sent, and its default flipped to false on
 *    meshy-6 — so omitting it produces a full-density mesh and a config panel
 *    that lies about what it did.
 *  - `target_polycount` is always high. A low remesh target visibly deforms the
 *    mesh and polycount does not change the price, so generating high is free.
 *    Delivered low-poly is a local decimation concern outside Fulcrum.
 * ------------------------------------------------------------------------- */

export type MeshyStageEndpoint =
  "image-to-3d" | "multi-image-to-3d" | "retexture" | "rigging" | "animations";

/**
 * Which Meshy family owns each stage. Geometry is resolved per request because
 * one input image and several go to different endpoints; this is the default
 * used for polling and simulation.
 */
export const MESHY_STAGE_ENDPOINTS = {
  geometry: "multi-image-to-3d",
  texture: "retexture",
  rig: "rigging",
  animation: "animations",
} as const satisfies Record<MeshyStage, MeshyStageEndpoint>;

export const meshyStageEndpointUrl = (
  endpoint: MeshyStageEndpoint,
  taskId?: string,
): string =>
  `https://api.meshy.ai/openapi/v1/${endpoint}${
    taskId ? `/${encodeURIComponent(taskId)}` : ""
  }`;

export type MeshyStagedGeometryInput = {
  images: Array<{ artifact: ArtifactRef; bytes: Uint8Array }>;
  /** Plan intent for a riggable humanoid. Absent for everything else. */
  poseMode?: "a-pose" | "t-pose";
};

export const buildMeshyStagedGeometryRequest = (
  input: MeshyStagedGeometryInput,
  config: MeshyConfig,
): {
  endpoint: "image-to-3d" | "multi-image-to-3d";
  body: Record<string, unknown>;
} => {
  if (input.images.length < 1 || input.images.length > 4)
    throw new ProviderPreflightError(
      "payload-invalid",
      "Meshy geometry needs one to four input images.",
    );
  const uris = input.images.map(({ artifact, bytes }) =>
    dataUri(artifact, bytes),
  );
  const shared = {
    ai_model: config.modelVersion,
    moderation: true,
    target_formats: ["glb"],
    should_texture: false,
    should_remesh: true,
    topology: config.topology,
    target_polycount: config.targetPolycount,
    image_enhancement: config.imageEnhancement,
    auto_size: true,
    origin_at: "bottom",
    alpha_thumbnail: true,
    multi_view_thumbnails: true,
    ...(input.poseMode ? { pose_mode: input.poseMode } : {}),
  };
  return uris.length === 1
    ? {
        endpoint: "image-to-3d",
        body: { image_url: uris[0], model_type: "standard", ...shared },
      }
    : { endpoint: "multi-image-to-3d", body: { image_urls: uris, ...shared } };
};

export type MeshyStagedTextureInput = {
  sourceModel: { artifact: ArtifactRef; bytes: Uint8Array };
  styleImage: { artifact: ArtifactRef; bytes: Uint8Array };
};

/**
 * Retexture takes the persisted GLB rather than the geometry task id. Meshy's
 * `input_task_id` accepts Text Preview, Text Refine, Image to 3D and Remesh
 * ids — but *not* Multi-Image to 3D, which is the endpoint Fulcrum's multiview
 * path uses. Posting the bytes Fulcrum already owns works for either shape and
 * survives the three-day result deletion.
 */
export const buildMeshyStagedTextureRequest = (
  input: MeshyStagedTextureInput,
  config: MeshyConfig,
): Record<string, unknown> => ({
  model_url: modelDataUri(input.sourceModel.bytes),
  image_style_url: dataUri(input.styleImage.artifact, input.styleImage.bytes),
  ai_model: config.modelVersion,
  enable_original_uv: true,
  enable_pbr: true,
  texture_resolution: config.textureResolution,
  remove_lighting: config.removeLighting,
  target_formats: ["glb"],
  alpha_thumbnail: true,
});

export type MeshyStagedRigInput = {
  /** A *textured* Meshy task. Preferred: it avoids re-uploading the mesh. */
  inputTaskId?: string;
  /** Fallback once the source task has expired. Must face +Z. */
  model?: { bytes: Uint8Array };
  faceCount?: number;
};

export const buildMeshyStagedRigRequest = (
  input: MeshyStagedRigInput,
  config: MeshyConfig,
): Record<string, unknown> => {
  if (!input.inputTaskId && !input.model)
    throw new ProviderPreflightError(
      "payload-invalid",
      "Meshy rigging needs either a textured task id or the textured model bytes.",
    );
  if (input.faceCount !== undefined && input.faceCount > MESHY_RIG_MAX_FACES)
    throw new ProviderPreflightError(
      "payload-invalid",
      `Meshy rigging refuses meshes above ${MESHY_RIG_MAX_FACES} faces; this one has ${input.faceCount}.`,
    );
  return {
    ...(input.inputTaskId
      ? { input_task_id: input.inputTaskId }
      : { model_url: modelDataUri(input.model!.bytes) }),
    ...(config.realWorldHeightMeters !== undefined
      ? { height_meters: config.realWorldHeightMeters }
      : {}),
  };
};

/**
 * Meshy's animation library is a static documentation page of non-contiguous
 * integer action ids, not a discovery endpoint. v1 asks for one clip and does
 * not model a catalog, so the id is a named constant rather than an enum
 * generated from a maximum.
 */
export const MESHY_DEFAULT_ACTION_ID = 0;

export const buildMeshyStagedAnimationRequest = (input: {
  rigTaskId: string;
  actionId?: number;
}): Record<string, unknown> => ({
  rig_task_id: input.rigTaskId,
  action_id: input.actionId ?? MESHY_DEFAULT_ACTION_ID,
});

/**
 * Meshy's status vocabulary, mapped onto Fulcrum's. An unrecognised status
 * stays `running`: a Meshy release that adds a state must not strand a task
 * that has already been paid for.
 */
export const meshyTaskStatus = (
  status: string | undefined,
): MeshyTaskStatus | "unknown" => {
  switch ((status ?? "").trim().toUpperCase()) {
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "CANCELED":
    case "CANCELLED":
      return "canceled";
    case "PENDING":
    case "IN_PROGRESS":
      return "running";
    default:
      return "unknown";
  }
};

type MeshyTaskBody = {
  status?: string;
  progress?: number;
  model_urls?: { glb?: string };
  thumbnail_url?: string;
  alpha_thumbnail_url?: string;
  thumbnail_urls?: Partial<Record<"front" | "right" | "back" | "left", string>>;
  texture_urls?: Array<Record<string, string>>;
  task_error?: { message?: string };
  consumed_credits?: number;
  message?: string;
};

const downloadSupportingArtifacts = async (
  body: MeshyTaskBody,
): Promise<Array<{ role: string; mediaType: string; bytes: Uint8Array }>> => {
  const urls = [
    ...(body.thumbnail_url
      ? [{ role: "provider-thumbnail", url: body.thumbnail_url }]
      : []),
    ...(body.alpha_thumbnail_url
      ? [{ role: "provider-thumbnail-alpha", url: body.alpha_thumbnail_url }]
      : []),
    ...Object.entries(body.thumbnail_urls ?? {}).map(([role, url]) => ({
      role: `provider-${role}`,
      url,
    })),
    ...(body.texture_urls ?? []).flatMap((textureSet, textureIndex) =>
      Object.entries(textureSet).map(([channel, url]) => ({
        role: `provider-texture-${textureIndex}-${channel.replace(/_/g, "-")}`,
        url,
      })),
    ),
  ];
  const artifacts = await Promise.all(
    urls.map(async ({ role, url }) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return undefined;
        return {
          role,
          mediaType: response.headers.get("content-type") ?? "image/png",
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      } catch {
        return undefined;
      }
    }),
  );
  return artifacts.filter((artifact) => artifact !== undefined);
};

const inspectMeshyTask = async (
  job: AdapterJobRef,
): Promise<ExternalJobState> => {
  const { apiKey, model } = meshyConfiguration();
  const endpoint =
    job.jobKind === "multi-image"
      ? "multi-image-to-3d"
      : job.jobKind === "retexture"
        ? "retexture"
        : "image-to-3d";
  const response = await fetch(
    `https://api.meshy.ai/openapi/v1/${endpoint}/${encodeURIComponent(job.taskId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const body = (await response.json()) as MeshyTaskBody;
  if (!response.ok || !body.status) {
    throw new Error(
      body.message ?? `Meshy ${endpoint} polling failed (${response.status}).`,
    );
  }
  if (["PENDING", "IN_PROGRESS"].includes(body.status)) {
    return {
      status: "pending",
      resumeAfter: new Date(Date.now() + 5_000).toISOString(),
    };
  }
  const providerMetadata = {
    consumedCredits: body.consumed_credits ?? null,
    providerProgress: body.progress ?? 100,
    textureMapCount: (body.texture_urls ?? []).reduce(
      (count, textureSet) => count + Object.keys(textureSet).length,
      0,
    ),
  };
  if (body.status !== "SUCCEEDED") {
    return {
      status: "failed",
      error: `Meshy task ended with status ${body.status}: ${body.task_error?.message || "unknown error"}.`,
      providerMetadata,
    };
  }
  const modelUrl = body.model_urls?.glb;
  if (!modelUrl) {
    return {
      status: "failed",
      error: "Meshy completed without a downloadable GLB.",
      providerMetadata,
    };
  }
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) {
    return {
      status: "failed",
      error: `Meshy GLB download failed (${modelResponse.status}).`,
      providerMetadata,
    };
  }
  const textured = job.stage !== "geometry";
  return {
    status: "ready",
    asset: {
      bytes: new Uint8Array(await modelResponse.arrayBuffer()),
      provider: "meshy",
      model,
      externalJobId: job.taskId,
      costUsd: 0,
      ...(Number.isInteger(body.consumed_credits) &&
      (body.consumed_credits ?? -1) >= 0
        ? { costCredits: body.consumed_credits }
        : {}),
      generationClaims: textured
        ? {
            textured: true,
            textureChannels: ["base-color", "metallic-roughness", "normal"],
          }
        : { textured: false, textureChannels: [] },
      supportingArtifacts: await downloadSupportingArtifacts(body),
      providerMetadata,
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
      this.modelOverride ??
      process.env.FULCRUM_MESHY_MODEL ??
      FULCRUM_MESHY_MODEL
    );
  }

  get multiviewImageInput(): MultiviewImageInputCapability {
    return meshyMultiviewCapability(this.model());
  }

  requestFingerprint(job: AssetGenerationJob): string {
    const model = this.model();
    if (model !== FULCRUM_MESHY_MODEL) {
      throw new ProviderPreflightError(
        "payload-invalid",
        `Fulcrum pins Meshy generation to ${FULCRUM_MESHY_MODEL}; received ${model}.`,
      );
    }
    return assetRequestFingerprint(job, {
      modelVersion: model,
      endpointKind:
        job.imageInput.kind === "multiview"
          ? "multi-image-to-3d"
          : "image-to-3d",
      generationOptions: meshyGenerationOptions(job),
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
    return {
      taskId: body.result,
      jobKind: request.jobKind,
      stage: job.stage ?? "complete",
    };
  }

  async inspect(job: AdapterJobRef): Promise<ExternalJobState> {
    return await inspectMeshyTask(job);
  }
}

export class MeshyRetextureAdapter {
  constructor(private readonly repository: ProjectRepository) {}

  requestFingerprint(job: MeshyRetextureJob): string {
    return meshyRetextureFingerprint(job);
  }

  async submit(job: MeshyRetextureJob): Promise<AdapterJobRef> {
    const { apiKey } = meshyConfiguration();
    const response = await fetch("https://api.meshy.ai/openapi/v1/retexture", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildMeshyRetextureRequest(job, (artifact) =>
          this.repository.readArtifact(artifact),
        ),
      ),
    });
    const body = (await response.json()) as {
      result?: string;
      message?: string;
      detail?: string;
    };
    if (!response.ok || !body.result) {
      throw new Error(
        body.message ??
          body.detail ??
          `Meshy retexture submission failed (${response.status}).`,
      );
    }
    return { taskId: body.result, jobKind: "retexture", stage: "texture" };
  }

  async inspect(job: AdapterJobRef): Promise<ExternalJobState> {
    if (job.jobKind !== "retexture") {
      throw new ProviderPreflightError(
        "payload-invalid",
        `Meshy Retexture cannot inspect ${job.jobKind} jobs.`,
      );
    }
    return await inspectMeshyTask({ ...job, stage: "texture" });
  }
}
