import { createHash, randomUUID } from "node:crypto";

import {
  AssetDocumentSchema,
  AssetEvaluationSchema,
  AssetPolicySchema,
  DeterministicAssetReportSchema,
  RegenerationDecisionReportSchema,
  RegenerationStrategySchema,
  SemanticAssetReportSchema,
  TurntableManifestSchema,
  decideDurableSubmission,
  isProviderPreflightError,
  ProviderPreflightError,
  type AssetProvider,
  type AssetDocument,
  type AssetEvaluation,
  type AssetPolicy,
  type DeterministicAssetReport,
  type ArtifactRef,
  type ConceptDocument,
  type ProductionOutcome,
  type ProviderMode,
  type RevisionRef,
  type RegenerationAttempt,
  type RegenerationDecisionReport,
  type RegenerationStrategy,
  type SemanticAssetReport,
  type SubmissionRecord,
  type TurntableManifest,
} from "@fulcrum/domain";
import {
  inspectExecutionProviders,
  ModelExecution,
  preferredVisionProvider,
  type ExecutionProviderStatus,
  type StructuredVisionExecution,
} from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { Document, getBounds, NodeIO, Primitive } from "@gltf-transform/core";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  OctahedronGeometry,
  TorusGeometry,
} from "three";
import { z } from "zod";

import { inspectParsedAsset } from "./deterministic-quality.js";
import {
  bestRegenerationAttempt,
  compareQualityVectors,
  decideRegeneration,
} from "./regeneration.js";
import { renderTurntable } from "./turntable.js";
import {
  ASSET_VISION_RUBRIC_V1,
  LiveVisionEvaluationPort,
  materializeVisionReport,
  REPLAY_VISION_CATALOG,
  ReplayVisionEvaluationPort,
  ReplayVisionCatalogSchema,
  VisionEvaluationError,
  VisionRequestDescriptorSchema,
  visionRequestDigest,
  type ReplayVisionCatalog,
  type VisionRequestDescriptor,
} from "./vision-evaluation.js";

export { AssetPlanner } from "./asset-planner.js";
export type { AssetPlanning } from "./asset-planner.js";
export { DEFAULT_ASSET_POLICIES } from "./deterministic-quality.js";
export { ASSET_VISION_RUBRIC_V1 } from "./vision-evaluation.js";

export type AssetQualityOptions = {
  visionExecution?: StructuredVisionExecution;
  replayVisionCatalog?: ReplayVisionCatalog;
  visionProviderStatuses?: ExecutionProviderStatus[];
};

export type InspectAssetRequest = {
  projectId: string;
  runId: string;
  asset: RevisionRef;
  policy: { revision: RevisionRef; value: AssetPolicy };
};

export type InspectAssetResult = {
  deterministicReport: RevisionRef;
  turntable?: RevisionRef;
  report: DeterministicAssetReport;
  manifest?: TurntableManifest;
};

export type AssetEvaluationContext = {
  intendedUse: string;
  requiredFeatures: string[];
  prohibitedFeatures: string[];
  referenceArtifacts: ArtifactRef[];
};

export type SemanticAssetRequest = {
  projectId: string;
  runId: string;
  mode: ProviderMode;
  asset: RevisionRef;
  deterministicReport: RevisionRef;
  turntable: RevisionRef;
  policy: { revision: RevisionRef; value: AssetPolicy };
  context: AssetEvaluationContext;
};

export type SelectRegenerationRequest = {
  projectId: string;
  runId: string;
  assetId: string;
  currentAttempt: RegenerationAttempt;
  attemptHistory: RegenerationAttempt[];
  policy: AssetPolicy;
};

export type AssetRegenerationInput = {
  attemptNumber: number;
  strategyRevision: RevisionRef;
  parentAssetRevision: RevisionRef;
  additionalConceptViews?: RevisionRef[];
};

export class AssetQualityFailure extends Error {
  readonly failureKind = "strategy-changing" as const;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssetQualityFailure";
  }
}

const QualityWorkflowEventSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  type: z.enum([
    "asset.deterministic-quality-completed",
    "asset.turntable-rendered",
    "asset.semantic-evaluation-submitted",
    "asset.semantic-evaluation-completed",
    "asset.semantic-evaluation-submission-unknown",
    "asset.regeneration-strategy-selected",
    "asset.regeneration-attempt-started",
    "asset.best-revision-considered",
  ]),
  payload: z.record(z.string(), z.unknown()),
});

const appendQualityEvent = (
  repository: ProjectRepository,
  event: z.input<typeof QualityWorkflowEventSchema>,
) => repository.appendEvent(QualityWorkflowEventSchema.parse(event));

type GeneratedAsset = {
  bytes: Uint8Array;
  provider: string;
  model: string;
  externalJobId: string;
  costUsd: number;
  providerMetadata?: Record<string, unknown>;
};

const addGeometry = (
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  name: string,
  geometry: BufferGeometry,
  material: ReturnType<Document["createMaterial"]>,
): void => {
  geometry.computeVertexNormals();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!positions || !normals)
    throw new Error(`Geometry ${name} has no renderable attributes.`);
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor(`${name}:positions`, buffer)
        .setType("VEC3")
        .setArray(new Float32Array(positions.array)),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor(`${name}:normals`, buffer)
        .setType("VEC3")
        .setArray(new Float32Array(normals.array)),
    )
    .setMaterial(material);
  if (geometry.index) {
    const values = Array.from(geometry.index.array);
    const max = Math.max(...values);
    primitive.setIndices(
      document
        .createAccessor(`${name}:indices`, buffer)
        .setType("SCALAR")
        .setArray(
          max > 65_535 ? new Uint32Array(values) : new Uint16Array(values),
        ),
    );
  }
  const mesh = document.createMesh(name).addPrimitive(primitive);
  document
    .getRoot()
    .listScenes()[0]
    ?.addChild(document.createNode(name).setMesh(mesh));
  geometry.dispose();
};

export const createReplayReliquary = async (
  variant: "baseline" | "rear-defined" = "baseline",
): Promise<Uint8Array> => {
  const document = new Document();
  document.createScene("Fulcrum M0 Reliquary");
  const buffer = document.createBuffer("reliquary-buffer");
  const stone = document
    .createMaterial("Weathered basalt")
    .setBaseColorFactor([0.085, 0.105, 0.14, 1])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.86);
  const edgeStone = document
    .createMaterial("Ash edge planes")
    .setBaseColorFactor([0.25, 0.29, 0.34, 1])
    .setMetallicFactor(0.02)
    .setRoughnessFactor(0.78);
  const bronze = document
    .createMaterial("Aged bronze")
    .setBaseColorFactor([0.52, 0.32, 0.16, 1])
    .setMetallicFactor(0.78)
    .setRoughnessFactor(0.42);
  const crystal = document
    .createMaterial("Cyan crystal")
    .setBaseColorFactor([0.13, 0.78, 0.86, 1])
    .setEmissiveFactor([0.12, 0.74, 0.82])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.18);

  const base = new CylinderGeometry(1.45, 1.62, 0.32, 8).translate(0, 0.16, 0);
  addGeometry(document, buffer, "octagonal plinth", base, stone);
  const foot = new CylinderGeometry(1.26, 1.42, 0.24, 8).translate(0, 0.43, 0);
  addGeometry(document, buffer, "bronze foot", foot, bronze);
  const body = new BoxGeometry(1.9, 1.55, 1.55).translate(0, 1.27, 0);
  addGeometry(document, buffer, "stone vessel", body, stone);
  const shoulder = new CylinderGeometry(1.16, 1.34, 0.36, 8).translate(
    0,
    2.13,
    0,
  );
  addGeometry(document, buffer, "crowned shoulder", shoulder, edgeStone);
  const lid = new CylinderGeometry(0.95, 1.14, 0.24, 8).translate(0, 2.43, 0);
  addGeometry(document, buffer, "capstone", lid, stone);

  for (const [index, height] of [0.73, 1.82, 2.35].entries()) {
    const ring = new TorusGeometry(index === 1 ? 1.25 : 1.08, 0.085, 8, 32)
      .rotateX(Math.PI / 2)
      .translate(0, height, 0);
    addGeometry(document, buffer, `bronze binding ${index + 1}`, ring, bronze);
  }

  const core = new OctahedronGeometry(0.56, 0)
    .scale(0.72, 1.55, 0.72)
    .translate(0, 1.43, 0.88);
  addGeometry(document, buffer, "awakened cyan core", core, crystal);
  const coreFrameLeft = new BoxGeometry(0.16, 1.4, 0.18)
    .rotateZ(-0.16)
    .translate(-0.65, 1.42, 0.74);
  addGeometry(document, buffer, "left core guard", coreFrameLeft, bronze);
  const coreFrameRight = new BoxGeometry(0.16, 1.4, 0.18)
    .rotateZ(0.16)
    .translate(0.65, 1.42, 0.74);
  addGeometry(document, buffer, "right core guard", coreFrameRight, bronze);

  if (variant === "rear-defined") {
    const rearCore = new OctahedronGeometry(0.48, 0)
      .scale(0.76, 1.42, 0.76)
      .translate(0, 1.43, -0.9);
    addGeometry(document, buffer, "rear cyan core", rearCore, crystal);
    const rearGuardLeft = new BoxGeometry(0.18, 1.28, 0.2)
      .rotateZ(-0.2)
      .translate(-0.62, 1.42, -0.76);
    addGeometry(document, buffer, "rear left guard", rearGuardLeft, bronze);
    const rearGuardRight = new BoxGeometry(0.18, 1.28, 0.2)
      .rotateZ(0.2)
      .translate(0.62, 1.42, -0.76);
    addGeometry(document, buffer, "rear right guard", rearGuardRight, bronze);
  }

  document.getRoot().getAsset().generator = "Fulcrum replay asset generator";
  return new NodeIO().writeBinary(document);
};

export class AssetProduction {
  constructor(private readonly repository: ProjectRepository) {}

  async ensure(input: {
    projectId: string;
    runId: string;
    mode: ProviderMode;
    assetProvider: AssetProvider;
    concept: RevisionRef;
    regeneration?: AssetRegenerationInput;
  }): Promise<ProductionOutcome<RevisionRef>> {
    if (
      input.mode === "live" &&
      (input.regeneration?.additionalConceptViews?.length ?? 0) > 0
    )
      return {
        status: "failed",
        requestId: `asset-capability-${createHash("sha256")
          .update(
            JSON.stringify([
              input.projectId,
              input.assetProvider,
              input.regeneration?.additionalConceptViews?.map(
                (view) => view.revisionId,
              ),
            ]),
          )
          .digest("hex")}`,
        error: {
          code: "provider-multiview-unsupported",
          message:
            "Live multi-image asset submission belongs to the S4 provider adapter.",
          recoverable: true,
          failureKind: "strategy-changing",
        },
      };
    let regenerationStrategy: RegenerationStrategy | undefined;
    if (input.regeneration) {
      if (
        !Number.isInteger(input.regeneration.attemptNumber) ||
        input.regeneration.attemptNumber < 1
      )
        return {
          status: "failed",
          requestId: `asset-regeneration-invalid-${input.projectId}`,
          error: {
            code: "regeneration-attempt-invalid",
            message: "Regeneration attempt numbers start at one.",
            recoverable: true,
            failureKind: "policy-blocked",
          },
        };
      const strategyValue = this.repository.resolveRevision<unknown>(
        input.regeneration.strategyRevision,
      );
      const decisionReport =
        RegenerationDecisionReportSchema.safeParse(strategyValue);
      regenerationStrategy = decisionReport.success
        ? decisionReport.data.strategy
        : RegenerationStrategySchema.parse(strategyValue);
    }
    const regenerationKey = input.regeneration
      ? `:${input.regeneration.strategyRevision.artifact.sha256}:${input.regeneration.parentAssetRevision.artifact.sha256}:${input.regeneration.attemptNumber}:${(
          input.regeneration.additionalConceptViews ?? []
        )
          .map((view) => view.artifact.sha256)
          .join(":")}`
      : "";
    const idempotencyKey = `asset:${input.projectId}:${input.concept.artifact.sha256}:${input.mode}:${input.assetProvider}${regenerationKey}`;
    const prior = this.repository.getSubmissionByKey(idempotencyKey);
    const decision = decideDurableSubmission(prior, input.mode);
    if (decision.kind === "ready") {
      if (!decision.submission.resultRevisionId) {
        return {
          status: "failed",
          requestId: decision.submission.requestId,
          error: {
            code: "asset-generation-failed",
            message:
              "The previous asset job is marked ready without a result revision.",
            recoverable: true,
          },
        };
      }
      return {
        status: "ready",
        requestId: decision.submission.requestId,
        value: this.repository.getRevision(
          decision.submission.resultRevisionId,
        ),
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
              : "asset-generation-failed",
          message:
            decision.submission.status === "submission-unknown"
              ? `The ${input.assetProvider} submission outcome is ambiguous; Fulcrum will not create another paid job automatically.`
              : "The previous asset job failed and requires user-directed regeneration.",
          recoverable: true,
        },
      };
    }
    if (decision.kind === "unknown-interruption") {
      this.repository.updateSubmission(decision.submission.requestId, {
        status: "submission-unknown",
      });
      return {
        status: "failed",
        requestId: decision.submission.requestId,
        error: {
          code: "submission-unknown",
          message: `${input.assetProvider} may have accepted this request before interruption; Fulcrum will not risk duplicate spend.`,
          recoverable: true,
        },
      };
    }
    const concept = this.repository.resolveRevision<ConceptDocument>(
      input.concept,
    );
    const submission =
      decision.kind === "inspect"
        ? decision.submission
        : (decision.submission ??
          this.repository.recordSubmissionIntent({
            projectId: input.projectId,
            operation: "image-to-model",
            provider:
              input.mode === "replay" ? "fulcrum-replay" : input.assetProvider,
            idempotencyKey,
            payload: {
              conceptRevisionId: input.concept.revisionId,
              imageArtifactId: concept.image.artifactId,
              ...(input.regeneration
                ? {
                    attemptNumber: input.regeneration.attemptNumber,
                    strategyRevisionId:
                      input.regeneration.strategyRevision.revisionId,
                    parentAssetRevisionId:
                      input.regeneration.parentAssetRevision.revisionId,
                    additionalConceptViewRevisionIds: (
                      input.regeneration.additionalConceptViews ?? []
                    ).map((view) => view.revisionId),
                  }
                : {}),
            },
          }));
    if (
      decision.kind !== "inspect" &&
      !decision.submission &&
      input.regeneration
    )
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.regeneration-attempt-started",
        payload: {
          attemptNumber: input.regeneration.attemptNumber,
          strategyRevisionId: input.regeneration.strategyRevision.revisionId,
          parentAssetRevisionId:
            input.regeneration.parentAssetRevision.revisionId,
          additionalConceptViewRevisionIds: (
            input.regeneration.additionalConceptViews ?? []
          ).map((view) => view.revisionId),
          requestId: submission.requestId,
        },
      });
    try {
      let generated: GeneratedAsset | undefined;
      if (input.mode === "replay") {
        const rearDefined = regenerationStrategy?.kind === "change-views";
        generated = {
          bytes: await createReplayReliquary(
            rearDefined ? "rear-defined" : "baseline",
          ),
          provider: "fulcrum-replay",
          model: rearDefined
            ? "parametric-reliquary-rear-defined-v2"
            : "parametric-reliquary-v1",
          externalJobId: `replay-${input.concept.artifact.sha256.slice(0, 12)}${input.regeneration ? `-attempt-${input.regeneration.attemptNumber}` : ""}`,
          costUsd: 0,
        };
      } else if (decision.kind === "inspect") {
        let inspected;
        try {
          inspected =
            input.assetProvider === "meshy"
              ? await this.inspectMeshyJob(submission.externalJobId!)
              : await this.inspectTripoJob(submission.externalJobId!);
        } catch (error) {
          this.repository.updateSubmission(submission.requestId, {
            status: "pending",
            payload: {
              ...submission.payload,
              lastPollError:
                error instanceof Error ? error.message : String(error),
            },
          });
          return {
            status: "pending",
            requestId: submission.requestId,
            resumeAfter: new Date(Date.now() + 5_000).toISOString(),
          };
        }
        if (inspected.status === "pending")
          return {
            status: "pending",
            requestId: submission.requestId,
            resumeAfter: inspected.resumeAfter,
          };
        if (inspected.status === "failed") {
          this.repository.updateSubmission(submission.requestId, {
            status: "failed",
            payload: {
              ...submission.payload,
              provider: input.assetProvider,
              providerError: inspected.error,
            },
          });
          return {
            status: "failed",
            requestId: submission.requestId,
            error: {
              code: `${input.assetProvider}-job-failed`,
              message: inspected.error,
              recoverable: true,
            },
          };
        }
        generated = inspected.asset;
      } else {
        try {
          this.preflightPaidAssetJob(input.projectId, input.assetProvider);
        } catch (error) {
          if (isProviderPreflightError(error))
            return this.refuseBeforeProviderCall(submission, error);
          throw error;
        }
        const {
          preflightCode: _preflightCode,
          error: _preflightError,
          ...intentPayload
        } = submission.payload;
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
          payload: {
            ...intentPayload,
            providerCallStartedAt: new Date().toISOString(),
          },
        });
        let job;
        try {
          job =
            input.assetProvider === "meshy"
              ? await this.submitMeshyJob(concept)
              : await this.submitTripoJob(concept);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.repository.updateSubmission(submission.requestId, {
            status: "submission-unknown",
            payload: { ...submission.payload, error: message },
          });
          return {
            status: "failed",
            requestId: submission.requestId,
            error: { code: "submission-unknown", message, recoverable: true },
          };
        }
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
          externalJobId: job.taskId,
          payload: {
            ...submission.payload,
            submittedAt: new Date().toISOString(),
          },
        });
        return {
          status: "pending",
          requestId: submission.requestId,
          resumeAfter: new Date(Date.now() + 5_000).toISOString(),
        };
      }

      const glb = this.repository.putArtifact(
        input.projectId,
        generated.bytes,
        "model/gltf-binary",
      );
      const asset: AssetDocument = AssetDocumentSchema.parse({
        assetId: `${input.projectId}:reliquary-asset`,
        name: "Ancient Reliquary",
        classification:
          regenerationStrategy?.kind === "reclassify"
            ? regenerationStrategy.to
            : "hero",
        glb,
        provider: generated.provider,
        model: generated.model,
        sourceConceptRevisionId: input.concept.revisionId,
        sourceConceptRevisionIds: [
          input.concept.revisionId,
          ...(input.regeneration?.additionalConceptViews ?? []).map(
            (view) => view.revisionId,
          ),
        ],
        ...(input.regeneration
          ? {
              parentAssetRevisionId:
                input.regeneration.parentAssetRevision.revisionId,
              regenerationStrategyRevisionId:
                input.regeneration.strategyRevision.revisionId,
            }
          : {}),
        generationClaims:
          generated.provider === "fulcrum-replay"
            ? { textured: false, textureChannels: [] }
            : {
                textured: true,
                textureChannels: ["base-color", "metallic-roughness"],
              },
        externalJobId: generated.externalJobId,
        costUsd: generated.costUsd,
      });
      const revision = this.repository.writeRevision({
        projectId: input.projectId,
        entityId: asset.assetId,
        kind: "asset-document",
        value: asset,
        runId: input.runId,
      });
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: revision.revisionId,
        payload: {
          ...submission.payload,
          ...(generated.providerMetadata ?? {}),
        },
      });
      this.repository.appendEvent({
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.completed",
        payload: {
          revisionId: revision.revisionId,
          glbArtifactId: glb.artifactId,
        },
      });
      return {
        status: "ready",
        requestId: submission.requestId,
        value: revision,
      };
    } catch (error) {
      if (isProviderPreflightError(error))
        return this.refuseBeforeProviderCall(submission, error);
      const message = error instanceof Error ? error.message : String(error);
      this.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: { ...submission.payload, error: message },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: { code: "asset-generation-failed", message, recoverable: true },
      };
    }
  }

  private refuseBeforeProviderCall(
    submission: SubmissionRecord,
    error: ProviderPreflightError,
  ): ProductionOutcome<RevisionRef> {
    this.repository.updateSubmission(submission.requestId, {
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
  }

  private preflightPaidAssetJob(
    projectId: string,
    assetProvider: AssetProvider,
  ): void {
    if (assetProvider === "meshy") {
      const { reservedCost } = this.requireMeshyConfiguration();
      this.repository.reserveBudget(
        projectId,
        reservedCost,
        "Meshy image-to-3D",
      );
      return;
    }
    const { reservedCost } = this.requireTripoConfiguration();
    this.repository.reserveBudget(
      projectId,
      reservedCost,
      "Tripo image-to-model",
    );
  }

  private requireMeshyConfiguration(): {
    apiKey: string;
    model: string;
    reservedCost: number;
  } {
    const apiKey = process.env.MESHY_API_KEY;
    const model = process.env.FULCRUM_MESHY_MODEL;
    if (!apiKey || !model) {
      throw new ProviderPreflightError(
        "provider-unconfigured",
        "Live Meshy generation requires MESHY_API_KEY and FULCRUM_MESHY_MODEL.",
      );
    }
    const reservedCost = Number(
      process.env.FULCRUM_MESHY_RESERVE_USD ?? "0.50",
    );
    if (!Number.isFinite(reservedCost) || reservedCost < 0) {
      throw new ProviderPreflightError(
        "payload-invalid",
        "FULCRUM_MESHY_RESERVE_USD must be a finite non-negative number.",
      );
    }
    return { apiKey, model, reservedCost };
  }

  private requireTripoConfiguration(): {
    apiKey: string;
    modelVersion: string;
    reservedCost: number;
  } {
    const apiKey = process.env.TRIPO_API_KEY;
    const modelVersion = process.env.FULCRUM_TRIPO_MODEL_VERSION;
    if (!apiKey || !modelVersion) {
      throw new ProviderPreflightError(
        "provider-unconfigured",
        "Live asset generation requires TRIPO_API_KEY and FULCRUM_TRIPO_MODEL_VERSION.",
      );
    }
    const reservedCost = Number(
      process.env.FULCRUM_TRIPO_RESERVE_USD ?? "0.50",
    );
    if (!Number.isFinite(reservedCost) || reservedCost < 0) {
      throw new ProviderPreflightError(
        "payload-invalid",
        "FULCRUM_TRIPO_RESERVE_USD must be a finite non-negative number.",
      );
    }
    return { apiKey, modelVersion, reservedCost };
  }

  private async submitMeshyJob(
    concept: ConceptDocument,
  ): Promise<{ taskId: string }> {
    const { apiKey, model } = this.requireMeshyConfiguration();
    const imageBytes = this.repository.readArtifact(concept.image);
    const imageUrl = `data:${concept.image.mediaType};base64,${Buffer.from(imageBytes).toString("base64")}`;
    const response = await fetch(
      "https://api.meshy.ai/openapi/v1/image-to-3d",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: imageUrl,
          model_type: "standard",
          ai_model: model,
          should_texture: true,
          enable_pbr: true,
          texture_resolution: "2k",
          should_remesh: false,
          image_enhancement: false,
          ...(model === "meshy-6" ? { remove_lighting: true } : {}),
          moderation: true,
          target_formats: ["glb"],
        }),
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
    return { taskId: body.result };
  }

  private async inspectMeshyJob(
    taskId: string,
  ): Promise<
    | { status: "pending"; resumeAfter: string }
    | { status: "failed"; error: string }
    | { status: "ready"; asset: GeneratedAsset }
  > {
    const apiKey = process.env.MESHY_API_KEY;
    const model = process.env.FULCRUM_MESHY_MODEL;
    if (!apiKey || !model) {
      throw new Error(
        "Meshy polling requires MESHY_API_KEY and FULCRUM_MESHY_MODEL.",
      );
    }
    const response = await fetch(
      `https://api.meshy.ai/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`,
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
        externalJobId: taskId,
        costUsd: Number(process.env.FULCRUM_MESHY_RESERVE_USD ?? "0.50"),
        providerMetadata: {
          consumedCredits: body.consumed_credits ?? null,
          providerProgress: body.progress ?? 100,
        },
      },
    };
  }

  private async submitTripoJob(
    concept: ConceptDocument,
  ): Promise<{ taskId: string }> {
    const { apiKey, modelVersion } = this.requireTripoConfiguration();
    const imageBytes = this.repository.readArtifact(concept.image);
    const imageBuffer = new ArrayBuffer(imageBytes.byteLength);
    new Uint8Array(imageBuffer).set(imageBytes);
    const form = new FormData();
    form.append(
      "file",
      new Blob([imageBuffer], { type: concept.image.mediaType }),
      "concept.png",
    );
    const uploadResponse = await fetch(
      "https://api.tripo3d.ai/v2/openapi/upload/sts",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
    const upload = (await uploadResponse.json()) as {
      data?: { image_token?: string };
      message?: string;
    };
    if (!uploadResponse.ok || !upload.data?.image_token)
      throw new Error(
        upload.message ?? `Tripo upload failed (${uploadResponse.status}).`,
      );
    const taskResponse = await fetch("https://api.tripo3d.ai/v2/openapi/task", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "image_to_model",
        model_version: modelVersion,
        file: { type: "png", file_token: upload.data.image_token },
      }),
    });
    const task = (await taskResponse.json()) as {
      data?: { task_id?: string };
      message?: string;
    };
    if (!taskResponse.ok || !task.data?.task_id)
      throw new Error(
        task.message ??
          `Tripo task submission failed (${taskResponse.status}).`,
      );
    return { taskId: task.data.task_id };
  }

  private async inspectTripoJob(
    taskId: string,
  ): Promise<
    | { status: "pending"; resumeAfter: string }
    | { status: "failed"; error: string }
    | { status: "ready"; asset: GeneratedAsset }
  > {
    const apiKey = process.env.TRIPO_API_KEY;
    const modelVersion = process.env.FULCRUM_TRIPO_MODEL_VERSION;
    if (!apiKey || !modelVersion)
      throw new Error("Tripo polling requires its API key and model version.");
    const response = await fetch(
      `https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(taskId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    const body = (await response.json()) as {
      data?: {
        status?: string;
        output?: { pbr_model?: string; model?: string };
        consumed_credit?: number;
      };
      message?: string;
    };
    if (!response.ok || !body.data?.status)
      throw new Error(
        body.message ?? `Tripo polling failed (${response.status}).`,
      );
    if (["queued", "running"].includes(body.data.status)) {
      return {
        status: "pending",
        resumeAfter: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    if (body.data.status !== "success")
      return {
        status: "failed",
        error: `Tripo task ended with status ${body.data.status}.`,
      };
    const modelUrl = body.data.output?.pbr_model ?? body.data.output?.model;
    if (!modelUrl)
      return {
        status: "failed",
        error: "Tripo completed without a downloadable model.",
      };
    const modelResponse = await fetch(modelUrl);
    if (!modelResponse.ok)
      return {
        status: "failed",
        error: `Tripo model download failed (${modelResponse.status}).`,
      };
    return {
      status: "ready",
      asset: {
        bytes: new Uint8Array(await modelResponse.arrayBuffer()),
        provider: "tripo",
        model: modelVersion,
        externalJobId: taskId,
        costUsd: Number(process.env.FULCRUM_TRIPO_RESERVE_USD ?? "0.50"),
      },
    };
  }
}

export class AssetQuality {
  private readonly visionExecution: StructuredVisionExecution;
  private readonly replayVisionCatalog: ReplayVisionCatalog;
  private readonly visionProviderStatuses:
    ExecutionProviderStatus[] | undefined;

  constructor(
    private readonly repository: ProjectRepository,
    options: AssetQualityOptions = {},
  ) {
    this.visionExecution = options.visionExecution ?? new ModelExecution();
    this.replayVisionCatalog = ReplayVisionCatalogSchema.parse(
      options.replayVisionCatalog ?? REPLAY_VISION_CATALOG,
    );
    this.visionProviderStatuses = options.visionProviderStatuses;
  }

  async inspect(input: InspectAssetRequest): Promise<InspectAssetResult> {
    const asset = AssetDocumentSchema.parse(
      this.repository.resolveRevision<AssetDocument>(input.asset),
    );
    const policy = AssetPolicySchema.parse(input.policy.value);
    if (asset.classification !== policy.classification)
      throw new AssetQualityFailure(
        "asset-policy-classification-mismatch",
        `Asset class ${asset.classification} cannot use ${policy.classification} policy.`,
      );
    let document: Document;
    try {
      document = await new NodeIO().readBinary(
        this.repository.readArtifact(asset.glb),
      );
    } catch (error) {
      throw new AssetQualityFailure(
        "asset-glb-unsupported",
        `Asset GLB could not be parsed without unsupported compression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const inspection = inspectParsedAsset(document, asset, policy);
    const reportId = `deterministic-${createHash("sha256")
      .update(
        JSON.stringify([
          input.asset.revisionId,
          input.policy.revision.revisionId,
          inspection,
        ]),
      )
      .digest("hex")}`;
    const report = DeterministicAssetReportSchema.parse({
      schema: "fulcrum.asset-deterministic-report",
      version: 1,
      reportId,
      assetId: asset.assetId,
      assetRevisionId: input.asset.revisionId,
      assetArtifactSha256: asset.glb.sha256,
      policy: {
        revisionId: input.policy.revision.revisionId,
        sha256: input.policy.revision.artifact.sha256,
      },
      classification: asset.classification,
      ...inspection,
    });
    const deterministic = this.repository.ensureRevision({
      projectId: input.projectId,
      operationKey: `m2.asset-deterministic-quality:${input.asset.revisionId}:${input.policy.revision.revisionId}`,
      entityId: `${asset.assetId}:deterministic-quality`,
      kind: "asset-deterministic-report",
      runId: input.runId,
      createValue: () => report,
    });
    if (deterministic.created)
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.deterministic-quality-completed",
        payload: {
          assetId: asset.assetId,
          assetRevisionId: input.asset.revisionId,
          reportRevisionId: deterministic.revision.revisionId,
          passed: deterministic.value.passed,
        },
      });
    if (!deterministic.value.passed)
      return {
        deterministicReport: deterministic.revision,
        report: DeterministicAssetReportSchema.parse(deterministic.value),
      };

    let rendered;
    try {
      rendered = renderTurntable(document, policy.turntable);
    } catch (error) {
      throw new AssetQualityFailure(
        "asset-turntable-render-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const frameArtifacts = rendered.map((frame) => ({
      ...frame,
      artifact: this.repository.putArtifact(
        input.projectId,
        frame.bytes,
        "image/png",
      ),
    }));
    const manifest = TurntableManifestSchema.parse({
      schema: "fulcrum.turntable",
      version: 1,
      turntableId: `turntable-${createHash("sha256")
        .update(
          JSON.stringify([
            input.asset.revisionId,
            input.policy.revision.revisionId,
            frameArtifacts.map(({ artifact }) => artifact.sha256),
          ]),
        )
        .digest("hex")}`,
      assetId: asset.assetId,
      assetRevisionId: input.asset.revisionId,
      sourceArtifactHashes: [asset.glb.sha256],
      rendererVersion: "software-rasterizer-v1",
      config: policy.turntable,
      frames: frameArtifacts.map(
        ({ frameIndex, yawDegrees, artifact: frameArtifact }) => ({
          frameIndex,
          yawDegrees,
          artifact: frameArtifact,
        }),
      ),
    });
    const turntable = this.repository.ensureRevision({
      projectId: input.projectId,
      operationKey: `m2.asset-turntable:${input.asset.revisionId}:${input.policy.revision.revisionId}`,
      entityId: `${asset.assetId}:turntable`,
      kind: "turntable-manifest",
      runId: input.runId,
      createValue: () => manifest,
    });
    if (turntable.created)
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.turntable-rendered",
        payload: {
          assetId: asset.assetId,
          assetRevisionId: input.asset.revisionId,
          turntableRevisionId: turntable.revision.revisionId,
          frameCount: turntable.value.frames.length,
        },
      });
    return {
      deterministicReport: deterministic.revision,
      turntable: turntable.revision,
      report: DeterministicAssetReportSchema.parse(deterministic.value),
      manifest: TurntableManifestSchema.parse(turntable.value),
    };
  }

  async ensureSemantic(
    input: SemanticAssetRequest,
  ): Promise<
    ProductionOutcome<{ revision: RevisionRef; report: SemanticAssetReport }>
  > {
    const asset = AssetDocumentSchema.parse(
      this.repository.resolveRevision<AssetDocument>(input.asset),
    );
    const policy = AssetPolicySchema.parse(input.policy.value);
    const deterministic = DeterministicAssetReportSchema.parse(
      this.repository.resolveRevision(input.deterministicReport),
    );
    const manifest = TurntableManifestSchema.parse(
      this.repository.resolveRevision(input.turntable),
    );
    if (
      deterministic.assetRevisionId !== input.asset.revisionId ||
      manifest.assetRevisionId !== input.asset.revisionId ||
      deterministic.policy.revisionId !== input.policy.revision.revisionId
    )
      throw new AssetQualityFailure(
        "asset-quality-lineage-mismatch",
        "Semantic evaluation inputs do not share exact asset and policy lineage.",
      );
    if (!deterministic.passed)
      return {
        status: "failed",
        requestId: `semantic-blocked-${input.asset.revisionId}`,
        error: {
          code: "deterministic-quality-failed",
          message: "Semantic evaluation requires a deterministic pass.",
          recoverable: true,
          failureKind: "strategy-changing",
        },
      };
    const descriptor: VisionRequestDescriptor =
      VisionRequestDescriptorSchema.parse({
        assetRevisionId: input.asset.revisionId,
        assetSha256: asset.glb.sha256,
        policySha256: input.policy.revision.artifact.sha256,
        classification: policy.classification,
        intendedUse: input.context.intendedUse,
        requiredFeatures: input.context.requiredFeatures,
        prohibitedFeatures: input.context.prohibitedFeatures,
        referenceArtifacts: input.context.referenceArtifacts,
        frames: manifest.frames,
        rubric: ASSET_VISION_RUBRIC_V1,
      });
    const requestDigest = visionRequestDigest(descriptor);
    const idempotencyKey = `asset-semantic:${input.projectId}:${input.mode}:${requestDigest}`;
    let submission = this.repository.getSubmissionByKey(idempotencyKey);
    if (submission?.status === "ready") {
      if (!submission.resultRevisionId)
        return {
          status: "failed",
          requestId: submission.requestId,
          error: {
            code: "semantic-result-missing",
            message: "Semantic submission is ready without a result revision.",
            recoverable: true,
            failureKind: "user-action-required",
          },
        };
      const revision = this.repository.getRevision(submission.resultRevisionId);
      return {
        status: "ready",
        requestId: submission.requestId,
        value: {
          revision,
          report: SemanticAssetReportSchema.parse(
            this.repository.resolveRevision(revision),
          ),
        },
      };
    }
    if (
      submission?.status === "failed" ||
      submission?.status === "submission-unknown"
    )
      return {
        status: "failed",
        requestId: submission.requestId,
        error: {
          code:
            submission.status === "submission-unknown"
              ? "submission-unknown"
              : "semantic-evaluation-failed",
          message:
            submission.status === "submission-unknown"
              ? "The semantic provider may have accepted this request; Fulcrum will not risk duplicate spend."
              : "Semantic evaluation failed and requires a new strategy.",
          recoverable: true,
          failureKind:
            submission.status === "submission-unknown"
              ? "user-action-required"
              : "strategy-changing",
        },
      };
    if (submission?.payload.providerCallStartedAt) {
      submission = this.repository.updateSubmission(submission.requestId, {
        status: "submission-unknown",
        payload: submission.payload,
      });
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.semantic-evaluation-submission-unknown",
        payload: {
          assetId: asset.assetId,
          requestId: submission.requestId,
          requestDigest,
        },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: {
          code: "submission-unknown",
          message:
            "The semantic provider call started before interruption; Fulcrum will not submit it twice.",
          recoverable: true,
          failureKind: "user-action-required",
        },
      };
    }

    let provider: "fulcrum-replay" | "openai" | "openai-api";
    if (submission) {
      const parsed = z
        .enum(["fulcrum-replay", "openai", "openai-api"])
        .safeParse(submission.provider);
      if (!parsed.success)
        throw new AssetQualityFailure(
          "semantic-provider-invalid",
          `Recorded semantic provider ${submission.provider} is invalid.`,
        );
      provider = parsed.data;
    } else if (input.mode === "replay") provider = "fulcrum-replay";
    else {
      const selected = preferredVisionProvider(
        this.visionProviderStatuses ?? inspectExecutionProviders(),
      );
      if (!selected)
        return {
          status: "failed",
          requestId: `semantic-unavailable-${requestDigest}`,
          error: {
            code: "vision-provider-unavailable",
            message:
              "Semantic evaluation requires signed-in Codex or a configured OpenAI API key.",
            recoverable: true,
            failureKind: "policy-blocked",
          },
        };
      provider = selected;
    }
    if (!submission) {
      submission = this.repository.recordSubmissionIntent({
        projectId: input.projectId,
        operation: "asset-semantic-evaluation",
        provider,
        idempotencyKey,
        payload: {
          assetRevisionId: input.asset.revisionId,
          deterministicReportRevisionId: input.deterministicReport.revisionId,
          turntableRevisionId: input.turntable.revisionId,
          policyRevisionId: input.policy.revision.revisionId,
          requestDigest,
          budgetReserved: false,
        },
      });
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.semantic-evaluation-submitted",
        payload: {
          assetId: asset.assetId,
          requestId: submission.requestId,
          requestDigest,
          provider,
        },
      });
    }

    let reservedCost = 0;
    if (provider === "openai-api") {
      reservedCost = Number(
        process.env.FULCRUM_OPENAI_VISION_RESERVE_USD ?? "0.05",
      );
      if (!Number.isFinite(reservedCost) || reservedCost < 0)
        return {
          status: "failed",
          requestId: submission.requestId,
          error: {
            code: "payload-invalid",
            message:
              "FULCRUM_OPENAI_VISION_RESERVE_USD must be a finite non-negative number.",
            recoverable: true,
            failureKind: "policy-blocked",
          },
        };
      if (submission.payload.budgetReserved !== true) {
        try {
          this.repository.reserveBudget(
            input.projectId,
            reservedCost,
            "OpenAI asset vision evaluation",
          );
        } catch (error) {
          if (isProviderPreflightError(error))
            return {
              status: "failed",
              requestId: submission.requestId,
              error: {
                code: error.code,
                message: error.message,
                recoverable: true,
                failureKind: "policy-blocked",
              },
            };
          throw error;
        }
        submission = this.repository.updateSubmission(submission.requestId, {
          status: "intent-recorded",
          payload: {
            ...submission.payload,
            budgetReserved: true,
            reservedCostUsd: reservedCost,
          },
        });
      } else if (typeof submission.payload.reservedCostUsd === "number")
        reservedCost = submission.payload.reservedCostUsd;
    }
    submission = this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...submission.payload,
        providerCallStartedAt: new Date().toISOString(),
      },
    });
    const frameBytes = manifest.frames.map((frame) =>
      this.repository.readArtifact(frame.artifact),
    );
    try {
      const port =
        provider === "fulcrum-replay"
          ? new ReplayVisionEvaluationPort(this.replayVisionCatalog)
          : new LiveVisionEvaluationPort(
              this.visionExecution,
              provider,
              this.repository.workspaceRoot,
            );
      const evaluated = await port.evaluate(
        { ...descriptor, frameBytes },
        idempotencyKey,
      );
      const materialized = materializeVisionReport(
        descriptor,
        evaluated.findings,
      );
      const allFindings = [...deterministic.findings, ...materialized.findings];
      const report = SemanticAssetReportSchema.parse({
        schema: "fulcrum.asset-semantic-report",
        version: 1,
        reportId: `semantic-${requestDigest}`,
        assetId: asset.assetId,
        assetRevisionId: input.asset.revisionId,
        turntableRevisionId: input.turntable.revisionId,
        rubricVersion: ASSET_VISION_RUBRIC_V1.rubricVersion,
        requestDigest,
        provider: evaluated.provider,
        model: evaluated.model,
        costUsd: evaluated.costUsd || reservedCost,
        verdict: materialized.verdict,
        dimensionScores: materialized.dimensionScores,
        findings: materialized.findings,
        qualityVector: {
          hardGateFailures: deterministic.qualityVector.hardGateFailures,
          criticalFindings: allFindings.filter(
            (finding) => finding.severity === "critical",
          ).length,
          majorFindings: allFindings.filter(
            (finding) => finding.severity === "major",
          ).length,
          minorFindings: allFindings.filter(
            (finding) => finding.severity === "minor",
          ).length,
          semanticVerdict: materialized.verdict,
        },
      });
      const ensured = this.repository.ensureRevision({
        projectId: input.projectId,
        operationKey: `m2.asset-semantic:${requestDigest}`,
        entityId: `${asset.assetId}:semantic-quality`,
        kind: "asset-semantic-report",
        runId: input.runId,
        createValue: () => report,
      });
      submission = this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: ensured.revision.revisionId,
        payload: {
          ...submission.payload,
          provider: evaluated.provider,
          model: evaluated.model,
          completedAt: new Date().toISOString(),
        },
      });
      if (ensured.created)
        appendQualityEvent(this.repository, {
          projectId: input.projectId,
          runId: input.runId,
          type: "asset.semantic-evaluation-completed",
          payload: {
            assetId: asset.assetId,
            requestId: submission.requestId,
            requestDigest,
            semanticReportRevisionId: ensured.revision.revisionId,
            verdict: ensured.value.verdict,
            provider: ensured.value.provider,
            model: ensured.value.model,
          },
        });
      return {
        status: "ready",
        requestId: submission.requestId,
        value: {
          revision: ensured.revision,
          report: SemanticAssetReportSchema.parse(ensured.value),
        },
      };
    } catch (error) {
      if (
        provider === "fulcrum-replay" &&
        error instanceof VisionEvaluationError
      ) {
        submission = this.repository.updateSubmission(submission.requestId, {
          status: "failed",
          payload: { ...submission.payload, error: error.message },
        });
        return {
          status: "failed",
          requestId: submission.requestId,
          error: {
            code: error.code,
            message: error.message,
            recoverable: true,
            failureKind: error.failureKind,
          },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      submission = this.repository.updateSubmission(submission.requestId, {
        status: "submission-unknown",
        payload: { ...submission.payload, error: message },
      });
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.semantic-evaluation-submission-unknown",
        payload: {
          assetId: asset.assetId,
          requestId: submission.requestId,
          requestDigest,
          error: message,
        },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: {
          code: "submission-unknown",
          message,
          recoverable: true,
          failureKind: "user-action-required",
        },
      };
    }
  }

  async selectRegeneration(input: SelectRegenerationRequest): Promise<{
    revision: RevisionRef;
    decision: RegenerationDecisionReport;
  }> {
    const policy = AssetPolicySchema.parse(input.policy);
    const deterministic = DeterministicAssetReportSchema.parse(
      this.repository.resolveRevision(input.currentAttempt.deterministicReport),
    );
    const semantic = input.currentAttempt.semanticReport
      ? SemanticAssetReportSchema.parse(
          this.repository.resolveRevision(input.currentAttempt.semanticReport),
        )
      : undefined;
    const priorStrategies = [
      ...input.attemptHistory,
      input.currentAttempt,
    ].flatMap((attempt) => {
      if (!attempt.appliedStrategy) return [];
      const value = this.repository.resolveRevision<unknown>(
        attempt.appliedStrategy,
      );
      const decision = RegenerationDecisionReportSchema.safeParse(value);
      if (decision.success) return [decision.data.strategy];
      const strategy = RegenerationStrategySchema.safeParse(value);
      return strategy.success ? [strategy.data] : [];
    });
    const history = input.attemptHistory.filter(
      (attempt) =>
        attempt.asset.revisionId !== input.currentAttempt.asset.revisionId,
    );
    const attempts = [...history, input.currentAttempt].sort(
      (left, right) => left.attemptNumber - right.attemptNumber,
    );
    const best = bestRegenerationAttempt(attempts);
    const strategy: RegenerationStrategy = decideRegeneration({
      assetId: input.assetId,
      currentAttempt: input.currentAttempt,
      attemptHistory: history,
      currentFindings: [
        ...deterministic.findings,
        ...(semantic?.findings ?? []),
      ],
      failedGateIds: deterministic.gates
        .filter((gate) => !gate.passed)
        .map((gate) => gate.id),
      priorStrategies,
      policy,
      providerSupportsMultiview:
        policy.regeneration.allowedStrategies.includes("change-views"),
      permissibleClassifications: [policy.classification],
    });
    const sourceReportRevisionIds = [
      input.currentAttempt.deterministicReport.revisionId,
      ...(input.currentAttempt.semanticReport
        ? [input.currentAttempt.semanticReport.revisionId]
        : []),
    ];
    const decisionId = `decision-${createHash("sha256")
      .update(
        JSON.stringify([
          input.assetId,
          input.currentAttempt.attemptNumber,
          sourceReportRevisionIds,
          best.asset.revisionId,
          strategy,
        ]),
      )
      .digest("hex")}`;
    const report = RegenerationDecisionReportSchema.parse({
      schema: "fulcrum.asset-regeneration-decision",
      version: 1,
      decisionId,
      assetId: input.assetId,
      sourceReportRevisionIds,
      bestKnownAssetRevisionId: best.asset.revisionId,
      strategy,
    });
    const ensured = this.repository.ensureRevision({
      projectId: input.projectId,
      operationKey: `m2.asset-regeneration-decision:${decisionId}`,
      entityId: `${input.assetId}:regeneration-decision`,
      kind: "asset-regeneration-decision",
      runId: input.runId,
      createValue: () => report,
    });
    if (ensured.created) {
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.regeneration-strategy-selected",
        payload: {
          assetId: input.assetId,
          attemptNumber: input.currentAttempt.attemptNumber,
          decisionRevisionId: ensured.revision.revisionId,
          strategyKind: ensured.value.strategy.kind,
        },
      });
      const incumbent = history.length
        ? bestRegenerationAttempt(history)
        : input.currentAttempt;
      const comparison = history.length
        ? compareQualityVectors(
            incumbent.qualityVector,
            input.currentAttempt.qualityVector,
          )
        : "candidate-dominates";
      const result =
        comparison === "candidate-dominates" ? "updated" : "retained";
      appendQualityEvent(this.repository, {
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.best-revision-considered",
        payload: {
          assetId: input.assetId,
          result,
          incumbentAssetRevisionId: incumbent.asset.revisionId,
          candidateAssetRevisionId: input.currentAttempt.asset.revisionId,
          bestAssetRevisionId: best.asset.revisionId,
          decisionRevisionId: ensured.revision.revisionId,
        },
      });
    }
    return {
      revision: ensured.revision,
      decision: RegenerationDecisionReportSchema.parse(ensured.value),
    };
  }

  async evaluate(input: {
    projectId: string;
    runId: string;
    asset: RevisionRef;
  }): Promise<{ revision: RevisionRef; evaluation: AssetEvaluation }> {
    const asset = this.repository.resolveRevision<AssetDocument>(input.asset);
    const document = await new NodeIO().readBinary(
      this.repository.readArtifact(asset.glb),
    );
    const root = document.getRoot();
    const meshes = root.listMeshes();
    const primitives: Primitive[] = meshes.flatMap((mesh) =>
      mesh.listPrimitives(),
    );
    const vertexCount = primitives.reduce(
      (sum, primitive) =>
        sum + (primitive.getAttribute("POSITION")?.getCount() ?? 0),
      0,
    );
    const triangleCount = primitives.reduce((sum, primitive) => {
      const indices = primitive.getIndices();
      return (
        sum +
        Math.floor(
          (indices?.getCount() ??
            primitive.getAttribute("POSITION")?.getCount() ??
            0) / 3,
        )
      );
    }, 0);
    const scene = root.listScenes()[0];
    if (!scene) throw new Error("Asset GLB contains no scene.");
    const bounds = getBounds(scene);
    const size = {
      x: Math.max(0, bounds.max[0] - bounds.min[0]),
      y: Math.max(0, bounds.max[1] - bounds.min[1]),
      z: Math.max(0, bounds.max[2] - bounds.min[2]),
    };
    const gates = [
      {
        id: "mesh-present",
        label: "At least one mesh",
        passed: meshes.length > 0,
        detail: `${meshes.length} mesh(es)`,
      },
      {
        id: "triangles-present",
        label: "Renderable triangles",
        passed: triangleCount > 0,
        detail: `${triangleCount.toLocaleString()} triangles`,
      },
      {
        id: "triangle-budget",
        label: "M0 triangle budget",
        passed: triangleCount <= 500_000,
        detail: `${triangleCount.toLocaleString()} / 500,000`,
      },
      {
        id: "materials-present",
        label: "At least one material",
        passed: root.listMaterials().length > 0,
        detail: `${root.listMaterials().length} material(s)`,
      },
      {
        id: "claimed-textures-present",
        label: "Claimed textures are embedded",
        passed:
          !["meshy", "tripo"].includes(asset.provider) ||
          root.listTextures().length > 0,
        detail: ["meshy", "tripo"].includes(asset.provider)
          ? `${root.listTextures().length} embedded texture(s)`
          : "Replay asset makes no texture claim",
      },
      {
        id: "sane-bounds",
        label: "Sane authored bounds",
        passed:
          Math.max(size.x, size.y, size.z) <= 50 &&
          Math.min(size.x, size.y, size.z) >= 0.05,
        detail: `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`,
      },
    ];
    const evaluation: AssetEvaluation = AssetEvaluationSchema.parse({
      evaluationId: randomUUID(),
      assetRevisionId: input.asset.revisionId,
      passed: gates.every((gate) => gate.passed),
      measurements: {
        meshCount: meshes.length,
        primitiveCount: primitives.length,
        vertexCount,
        triangleCount,
        materialCount: root.listMaterials().length,
        textureCount: root.listTextures().length,
        animationCount: root.listAnimations().length,
        boundsMeters: size,
      },
      gates,
      evaluatedAt: new Date().toISOString(),
    });
    const ensured = this.repository.ensureRevision({
      projectId: input.projectId,
      operationKey: `m0.asset-quality:${input.asset.revisionId}`,
      entityId: `${asset.assetId}:quality`,
      kind: "asset-evaluation",
      runId: input.runId,
      createValue: () => evaluation,
    });
    if (ensured.created)
      this.repository.appendEvent({
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.quality-evaluated",
        payload: {
          revisionId: ensured.revision.revisionId,
          passed: ensured.value.passed,
          triangleCount: ensured.value.measurements.triangleCount,
        },
      });
    return { revision: ensured.revision, evaluation: ensured.value };
  }
}
