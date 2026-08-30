import { createHash } from "node:crypto";

import {
  MESHY_STAGE_CREDITS,
  ProviderPreflightError,
  type ArtifactRef,
  type CharacterPoseMode,
  type MeshyConfig,
  type MeshyStage,
} from "@fulcrum/domain";

import {
  buildMeshyStagedAnimationRequest,
  buildMeshyStagedGeometryRequest,
  buildMeshyStagedRigRequest,
  buildMeshyStagedTextureRequest,
  meshyConfiguration,
  meshyStageEndpointUrl,
  meshyTaskStatus,
  MESHY_STAGE_ENDPOINTS,
  type MeshyStageEndpoint,
} from "./meshy-adapter.js";
import { createStagedPlaceholderGlb } from "./staged-glb.js";

/**
 * The provider seam for the staged asset lifecycle.
 *
 * Two implementations exist and only ever two: a live one that talks to Meshy,
 * and a simulated one that never leaves the process. The dev loop runs on the
 * simulator — a staged human-in-the-loop gate is unusable to build against if
 * exercising it costs 35 credits a lap.
 */

export type StagedBinary = { artifact: ArtifactRef; bytes: Uint8Array };

export type StagedSubmitInput =
  | {
      stage: "geometry";
      round: number;
      config: MeshyConfig;
      shapeSeed: string;
      images: StagedBinary[];
      poseMode?: CharacterPoseMode | undefined;
    }
  | {
      stage: "texture";
      round: number;
      config: MeshyConfig;
      shapeSeed: string;
      sourceModel: StagedBinary;
      styleImage: StagedBinary;
    }
  | {
      stage: "rig";
      round: number;
      config: MeshyConfig;
      shapeSeed: string;
      sourceModel: StagedBinary;
      /** Preferred input. Absent once Meshy has deleted the source task. */
      sourceTaskId?: string | undefined;
      faceCount?: number | undefined;
    }
  | {
      stage: "animation";
      round: number;
      config: MeshyConfig;
      shapeSeed: string;
      /** Meshy's animation endpoint accepts nothing else. */
      rigTaskId: string;
    };

export type StagedSubmission = {
  taskId: string;
  endpoint: MeshyStageEndpoint;
};

export type MeshySubmissionFailureKind =
  | "provider-refusal"
  | "authentication"
  | "rate-limit"
  | "upstream"
  | "unexpected-response";

const meshySubmissionFailureKind = (
  status: number,
): MeshySubmissionFailureKind => {
  if (status === 400 || status === 422) return "provider-refusal";
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "upstream";
  return "unexpected-response";
};

/** A synchronous HTTP response from Meshy, kept distinct from transport errors. */
export class MeshySubmissionError extends Error {
  readonly provider = "meshy" as const;
  readonly failureKind: MeshySubmissionFailureKind;

  constructor(
    readonly endpoint: MeshyStageEndpoint,
    readonly status: number,
    readonly providerReason: string,
  ) {
    super(providerReason);
    this.name = "MeshySubmissionError";
    this.failureKind = meshySubmissionFailureKind(status);
  }
}

/** Only a rigging endpoint's model-validation refusal may use Blender. */
export const isMeshyRiggingProviderRefusal = (
  error: unknown,
): error is MeshySubmissionError =>
  error instanceof MeshySubmissionError &&
  error.endpoint === "rigging" &&
  error.failureKind === "provider-refusal";

export type StagedInspectInput = {
  stage: MeshyStage;
  round: number;
  taskId: string;
  endpoint: MeshyStageEndpoint;
  shapeSeed: string;
  /** Polls taken against this task so far, this one included. Durable. */
  pollCount: number;
};

export type StagedSupportingArtifact = {
  role: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type StagedTaskState =
  | { status: "running"; progress: number }
  | {
      /** Meshy refunds failed tasks, so `consumedCredits` is normally zero. */
      status: "failed";
      error: string;
      consumedCredits: number;
    }
  | {
      /** Billed, succeeded, and deleted before Fulcrum could persist it. */
      status: "expired";
      error: string;
      consumedCredits: number;
    }
  | { status: "canceled"; error: string; consumedCredits: number }
  | {
      status: "succeeded";
      consumedCredits: number;
      model: Uint8Array;
      supporting: StagedSupportingArtifact[];
    };

export interface StagedAssetAdapter {
  readonly id: "meshy" | "fulcrum-simulated";
  submit(input: StagedSubmitInput): Promise<StagedSubmission>;
  inspect(input: StagedInspectInput): Promise<StagedTaskState>;
}

/* ------------------------------- simulation ------------------------------- */

export type SimulatedStagedOutcome = "succeeded" | "failed" | "expired";

export type SimulatedStagedOptions = {
  /** Polls before a task finishes. Three gives the studio a real progress bar. */
  pollsToComplete?: number;
  /** Lets a test drive a stage into a failure or an expiry deterministically. */
  outcomeFor?: (input: {
    stage: MeshyStage;
    round: number;
    shapeSeed: string;
  }) => SimulatedStagedOutcome;
};

const stageCredits = (stage: MeshyStage): number => MESHY_STAGE_CREDITS[stage];

const SIMULATED_VARIANTS = {
  geometry: "geometry",
  texture: "textured",
  rig: "rigged",
  animation: "rigged",
} as const;

/**
 * A Meshy stand-in that behaves like the real thing in the ways that matter:
 * it hands back a task id, reports rising progress over several polls, charges
 * the documented credits, and finally produces a GLB a viewer can open. It has
 * no timers and no clock — progress is a function of the poll count Fulcrum
 * already persists, so a restarted orchestrator resumes exactly where it was.
 */
export class SimulatedStagedAdapter implements StagedAssetAdapter {
  readonly id = "fulcrum-simulated" as const;
  private readonly pollsToComplete: number;
  private readonly outcomeFor: NonNullable<
    SimulatedStagedOptions["outcomeFor"]
  >;

  constructor(options: SimulatedStagedOptions = {}) {
    this.pollsToComplete = options.pollsToComplete ?? 3;
    this.outcomeFor = options.outcomeFor ?? (() => "succeeded");
  }

  async submit(input: StagedSubmitInput): Promise<StagedSubmission> {
    if (input.stage === "animation" && !input.rigTaskId)
      throw new ProviderPreflightError(
        "payload-invalid",
        "An animation clip needs the rigging task it came from.",
      );
    const digest = createHash("sha256")
      .update(`${input.stage}:${input.round}:${input.shapeSeed}`)
      .digest("hex")
      .slice(0, 16);
    return {
      taskId: `simulated-${input.stage}-${digest}`,
      endpoint: MESHY_STAGE_ENDPOINTS[input.stage],
    };
  }

  async inspect(input: StagedInspectInput): Promise<StagedTaskState> {
    if (input.pollCount < this.pollsToComplete)
      return {
        status: "running",
        progress: Math.min(
          99,
          Math.round((input.pollCount / this.pollsToComplete) * 100),
        ),
      };
    const outcome = this.outcomeFor({
      stage: input.stage,
      round: input.round,
      shapeSeed: input.shapeSeed,
    });
    if (outcome === "failed")
      return {
        status: "failed",
        error: `Simulated Meshy ${input.stage} task failed.`,
        consumedCredits: 0,
      };
    if (outcome === "expired")
      return {
        status: "expired",
        error: `Simulated Meshy ${input.stage} result was deleted before download.`,
        consumedCredits: stageCredits(input.stage),
      };
    return {
      status: "succeeded",
      consumedCredits: stageCredits(input.stage),
      model: await createStagedPlaceholderGlb({
        shapeSeed: input.shapeSeed,
        variant: SIMULATED_VARIANTS[input.stage],
        round: input.round,
      }),
      supporting: [],
    };
  }
}

/* ---------------------------------- live ---------------------------------- */

type MeshyStagedTaskBody = {
  status?: string;
  progress?: number;
  expires_at?: number;
  consumed_credits?: number;
  model_urls?: { glb?: string };
  rigged_character_glb_url?: string;
  animation_glb_url?: string;
  basic_animations?: Record<string, string>;
  thumbnail_url?: string;
  alpha_thumbnail_url?: string;
  thumbnail_urls?: Record<string, string>;
  texture_urls?: Array<Record<string, string>>;
  task_error?: { message?: string };
  message?: string;
};

/** Where each stage's finished GLB lives in that family's task object. */
const modelUrlFor = (
  stage: MeshyStage,
  body: MeshyStagedTaskBody,
): string | undefined => {
  if (stage === "rig") return body.rigged_character_glb_url;
  if (stage === "animation") return body.animation_glb_url;
  return body.model_urls?.glb;
};

const supportingUrls = (
  body: MeshyStagedTaskBody,
): Array<{ role: string; url: string }> => [
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
  ...Object.entries(body.basic_animations ?? {}).map(([clip, url]) => ({
    role: `provider-animation-${clip.replace(/_/g, "-")}`,
    url,
  })),
  ...(body.texture_urls ?? []).flatMap((set, index) =>
    Object.entries(set).map(([channel, url]) => ({
      role: `provider-texture-${index}-${channel.replace(/_/g, "-")}`,
      url,
    })),
  ),
];

export class LiveMeshyStagedAdapter implements StagedAssetAdapter {
  readonly id = "meshy" as const;

  async submit(input: StagedSubmitInput): Promise<StagedSubmission> {
    const { apiKey } = meshyConfiguration();
    const { endpoint, body } = this.request(input);
    const response = await fetch(meshyStageEndpointUrl(endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      result?: string;
      message?: string;
      detail?: string;
    };
    if (!response.ok || !payload.result)
      throw new MeshySubmissionError(
        endpoint,
        response.status,
        payload.message ??
          payload.detail ??
          `Meshy ${input.stage} submission failed (${response.status}).`,
      );
    return { taskId: payload.result, endpoint };
  }

  private request(input: StagedSubmitInput): {
    endpoint: MeshyStageEndpoint;
    body: Record<string, unknown>;
  } {
    switch (input.stage) {
      case "geometry": {
        const built = buildMeshyStagedGeometryRequest(
          {
            images: input.images.map(({ artifact, bytes }) => ({
              artifact,
              bytes,
            })),
            ...(input.poseMode ? { poseMode: input.poseMode } : {}),
          },
          input.config,
        );
        return built;
      }
      case "texture":
        return {
          endpoint: "retexture",
          body: buildMeshyStagedTextureRequest(
            { sourceModel: input.sourceModel, styleImage: input.styleImage },
            input.config,
          ),
        };
      case "rig":
        return {
          endpoint: "rigging",
          body: buildMeshyStagedRigRequest(
            {
              ...(input.sourceTaskId
                ? { inputTaskId: input.sourceTaskId }
                : { model: { bytes: input.sourceModel.bytes } }),
              ...(input.faceCount !== undefined
                ? { faceCount: input.faceCount }
                : {}),
            },
            input.config,
          ),
        };
      case "animation":
        return {
          endpoint: "animations",
          body: buildMeshyStagedAnimationRequest({
            rigTaskId: input.rigTaskId,
          }),
        };
    }
  }

  async inspect(input: StagedInspectInput): Promise<StagedTaskState> {
    const { apiKey } = meshyConfiguration();
    const response = await fetch(
      meshyStageEndpointUrl(input.endpoint, input.taskId),
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    /* 404 and 410 on a *task read* mean Meshy deleted a result it already
       billed. On any other route they would mean a bad request, which is why
       this branch is scoped to the poll. */
    if (response.status === 404 || response.status === 410)
      return {
        status: "expired",
        error: `Meshy no longer holds ${input.stage} task ${input.taskId}; its result was deleted.`,
        consumedCredits: 0,
      };
    const body = (await response.json()) as MeshyStagedTaskBody;
    if (!response.ok)
      throw new Error(
        body.message ??
          `Meshy ${input.stage} polling failed (${response.status}).`,
      );
    const status = meshyTaskStatus(body.status);
    const consumedCredits =
      Number.isInteger(body.consumed_credits) &&
      (body.consumed_credits ?? -1) >= 0
        ? body.consumed_credits!
        : 0;
    if (status === "running" || status === "unknown")
      return {
        status: "running",
        progress: Math.max(0, Math.min(99, Math.round(body.progress ?? 0))),
      };
    if (status === "expired")
      return {
        status: "expired",
        error: `Meshy reported ${input.stage} task ${input.taskId} as expired.`,
        consumedCredits,
      };
    if (status === "failed")
      return {
        status: "failed",
        error: `Meshy ${input.stage} task failed: ${body.task_error?.message || "no reason given"}.`,
        consumedCredits,
      };
    if (status === "canceled")
      return {
        status: "canceled",
        error: `Meshy ${input.stage} task was canceled.`,
        consumedCredits,
      };

    const modelUrl = modelUrlFor(input.stage, body);
    /* A SUCCEEDED task with no downloadable result is the expiry case in
       disguise: Meshy charged for it and then deleted the file. Calling it a
       failure would offer a free retry for something already paid for. */
    if (!modelUrl)
      return {
        status: "expired",
        error: `Meshy ${input.stage} task ${input.taskId} succeeded but holds no downloadable GLB.`,
        consumedCredits,
      };
    const download = await fetch(modelUrl);
    if (
      download.status === 403 ||
      download.status === 404 ||
      download.status === 410
    )
      return {
        status: "expired",
        error: `Meshy deleted the ${input.stage} GLB for task ${input.taskId} before it could be stored.`,
        consumedCredits,
      };
    if (!download.ok)
      throw new Error(
        `Meshy ${input.stage} GLB download failed (${download.status}).`,
      );
    return {
      status: "succeeded",
      consumedCredits,
      model: new Uint8Array(await download.arrayBuffer()),
      supporting: await this.downloadSupporting(body),
    };
  }

  /** Best effort. A missing thumbnail must never fail a task already paid for. */
  private async downloadSupporting(
    body: MeshyStagedTaskBody,
  ): Promise<StagedSupportingArtifact[]> {
    const downloaded = await Promise.all(
      supportingUrls(body).map(async ({ role, url }) => {
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
    return downloaded.filter((entry) => entry !== undefined);
  }
}

export const createStagedAssetAdapter = (
  mode: "live" | "replay",
  options: SimulatedStagedOptions = {},
): StagedAssetAdapter =>
  mode === "live"
    ? new LiveMeshyStagedAdapter()
    : new SimulatedStagedAdapter(options);
