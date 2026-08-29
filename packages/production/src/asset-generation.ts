import { createHash } from "node:crypto";

import type {
  AssetProvider,
  ArtifactRef,
  ConceptViewRole,
  RevisionRef,
  ProviderMode,
} from "@fulcrum/domain";

export const CARDINAL_VIEW_ROLES = [
  "front",
  "left",
  "back",
  "right",
] as const satisfies readonly ConceptViewRole[];

export type MultiviewImageInputCapability =
  | { supported: false; reason: string }
  | {
      supported: true;
      minViews: 2 | 4;
      maxViews: 4;
      primaryRole: "front";
      roles: readonly ["front", "left", "back", "right"];
      payloadShape: "ordered-images" | "cardinal-slots";
      profileVersion: string;
    };

export type MultiviewDecision =
  | { kind: "not-required"; reason: string }
  | { kind: "generate"; roles: ConceptViewRole[] };

type ConceptViewPolicy = {
  conceptViews: "multiview-if-supported" | "single-view" | "none";
};

export const decideMultiviewStrategy = (
  policy: ConceptViewPolicy,
  capability: MultiviewImageInputCapability,
  requestedRoles?: readonly ConceptViewRole[],
): MultiviewDecision => {
  if (policy.conceptViews === "none") {
    return {
      kind: "not-required",
      reason: "Asset handling policy disables concept views.",
    };
  }
  if (policy.conceptViews === "single-view") {
    return {
      kind: "not-required",
      reason: "Asset handling policy requires single-view input.",
    };
  }
  if (!capability.supported) {
    return { kind: "not-required", reason: capability.reason };
  }

  const requested = new Set(requestedRoles ?? CARDINAL_VIEW_ROLES);
  const roles = CARDINAL_VIEW_ROLES.filter((role) => requested.has(role)).slice(
    0,
    capability.maxViews,
  );
  if (roles.length === 0) {
    return { kind: "not-required", reason: "No compatible roles requested." };
  }
  return { kind: "generate", roles };
};

export type AssetImageInput =
  | { kind: "single"; concept: RevisionRef; image: ArtifactRef }
  | {
      kind: "multiview";
      conceptSet: RevisionRef;
      anchorConcept: RevisionRef;
      views: Array<{
        role: ConceptViewRole;
        revision: RevisionRef;
        image: ArtifactRef;
      }>;
    };

export type AssetGenerationJob = {
  projectId: string;
  assetId: string;
  stage?: "complete" | "geometry";
  poseMode?: "a-pose" | "t-pose";
  qualityTarget?: {
    maxTriangles: number;
  };
  imageInput: AssetImageInput;
  regeneration?: {
    attemptNumber: number;
    strategyRevision: RevisionRef;
    parentAssetRevision: RevisionRef;
  };
};

export type AssetRequestFingerprintConfig = {
  modelVersion: string;
  endpointKind: string;
  generationOptions: Record<string, unknown>;
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJsonValue(nested)]),
    );
  }
  return value;
};

export const assetRequestFingerprint = (
  job: AssetGenerationJob,
  config: AssetRequestFingerprintConfig,
): string => {
  const imageInput =
    job.imageInput.kind === "single"
      ? {
          kind: "single",
          images: [{ role: "anchor", hash: job.imageInput.image.sha256 }],
        }
      : {
          kind: "multiview",
          images: [...job.imageInput.views]
            .sort(
              (left, right) =>
                CARDINAL_VIEW_ROLES.indexOf(left.role) -
                CARDINAL_VIEW_ROLES.indexOf(right.role),
            )
            .map(({ role, image }) => ({ role, hash: image.sha256 })),
        };
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableJsonValue({
          version: 2,
          assetId: job.assetId,
          imageInput,
          modelVersion: config.modelVersion,
          endpointKind: config.endpointKind,
          generationOptions: config.generationOptions,
          regeneration: job.regeneration
            ? {
                attemptNumber: job.regeneration.attemptNumber,
                strategyHash: job.regeneration.strategyRevision.artifact.sha256,
                parentAssetHash:
                  job.regeneration.parentAssetRevision.artifact.sha256,
              }
            : null,
        }),
      ),
    )
    .digest("hex");
};

export const m2AssetIdempotencyKey = (input: {
  projectId: string;
  mode: ProviderMode;
  provider: AssetProvider;
  requestFingerprint: string;
}): string =>
  `asset:v2:${input.projectId}:${input.mode}:${input.provider}:${input.requestFingerprint}`;

export type AdapterJobRef = {
  taskId: string;
  jobKind: "single-image" | "multi-image" | "retexture";
  stage?: "complete" | "geometry" | "texture";
};

export const adapterJobRefFromSubmissionPayload = (
  taskId: string,
  payload: Record<string, unknown>,
): AdapterJobRef => ({
  taskId,
  jobKind:
    payload.jobKind === "multi-image"
      ? "multi-image"
      : payload.jobKind === "retexture"
        ? "retexture"
        : "single-image",
  ...(payload.pipelineStage === "geometry" ||
  payload.pipelineStage === "texture" ||
  payload.pipelineStage === "complete"
    ? { stage: payload.pipelineStage }
    : {}),
});

export type ExternalJobState =
  | { status: "pending"; resumeAfter: string }
  | {
      status: "failed";
      error: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      status: "ready";
      asset: {
        bytes: Uint8Array;
        provider: string;
        model: string;
        externalJobId: string;
        costUsd: number;
        costCredits?: number;
        generationClaims?: {
          textured: boolean;
          textureChannels: Array<
            | "base-color"
            | "metallic-roughness"
            | "normal"
            | "occlusion"
            | "emissive"
          >;
        };
        supportingArtifacts?: Array<{
          role: string;
          mediaType: string;
          bytes: Uint8Array;
        }>;
        providerMetadata?: Record<string, unknown>;
      };
    };

export interface AssetGenerationAdapter {
  readonly id: AssetProvider | "fulcrum-replay";
  readonly multiviewImageInput: MultiviewImageInputCapability;

  requestFingerprint(job: AssetGenerationJob): string;
  submit(
    job: AssetGenerationJob,
    idempotencyKey: string,
  ): Promise<AdapterJobRef>;
  inspect(job: AdapterJobRef): Promise<ExternalJobState>;
}
