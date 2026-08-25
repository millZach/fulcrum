import { createHash, randomUUID } from "node:crypto";

import {
  AssetPlanSchema,
  AssetProductionRequestSchema,
  AssetDocumentSchema,
  AssetEvaluationSchema,
  AssetPolicySchema,
  ConceptSetSchema,
  ConceptViewDocumentSchema,
  DeterministicAssetReportSchema,
  M1ConceptDocumentSchema,
  MultiviewConceptRequestSchema,
  MultiviewConceptSetSchema,
  RegenerationDecisionReportSchema,
  RegenerationStrategySchema,
  SemanticAssetReportSchema,
  TurntableManifestSchema,
  decideDurableSubmission,
  handlingForPlannedAsset,
  isProviderPreflightError,
  ProviderPreflightError,
  type AssetProvider,
  type AssetProductionRequest,
  type AssetDocument,
  type AssetEvaluation,
  type AssetPolicy,
  type MacroPhaseOutcome,
  type M2AssetProductionRequest,
  type MultiviewConceptRequest,
  type MultiviewNodeOutput,
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
import { MultiviewConceptProduction } from "@fulcrum/creative";
import {
  inspectExecutionProviders,
  ModelExecution,
  preferredVisionProvider,
  type ExecutionProviderStatus,
  type StructuredVisionExecution,
} from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { Document, getBounds, NodeIO, Primitive } from "@gltf-transform/core";
import { z } from "zod";

import { inspectParsedAsset } from "./deterministic-quality.js";
import {
  adapterJobRefFromSubmissionPayload,
  CARDINAL_VIEW_ROLES,
  decideMultiviewStrategy,
  m2AssetIdempotencyKey,
  type AssetGenerationJob,
} from "./asset-generation.js";
import {
  createAssetGenerationAdapter,
  resolveAssetGenerationProfile,
} from "./asset-generation-profile.js";
import { meshyConfiguration } from "./meshy-adapter.js";
import { createReplayReliquary } from "./replay-reliquary.js";
import {
  bestRegenerationAttempt,
  compareQualityVectors,
  decideRegeneration,
} from "./regeneration.js";
import { renderTurntable } from "./turntable.js";
import { AssetPreparationError, tripoConfiguration } from "./tripo-adapter.js";
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
export { createReplayReliquary } from "./replay-reliquary.js";

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

export class AssetProduction {
  private readonly multiviewConceptProduction: MultiviewConceptProduction;

  constructor(private readonly repository: ProjectRepository) {
    this.multiviewConceptProduction = new MultiviewConceptProduction(
      repository,
    );
  }

  async ensureMultiviewConcepts(
    input: MultiviewConceptRequest,
  ): Promise<MacroPhaseOutcome<MultiviewNodeOutput>> {
    try {
      const request = MultiviewConceptRequestSchema.parse(input);
      const context = this.resolveM2Context({
        projectId: request.projectId,
        assetPlan: request.assetPlan,
        assetId: request.assetId,
      });
      const capability = resolveAssetGenerationProfile(
        context.state.assetProvider,
        context.state.mode,
      ).multiviewImageInput;
      const decision = decideMultiviewStrategy(
        context.policy,
        capability,
        request.requestedRoles,
      );
      if (decision.kind === "not-required") {
        return {
          status: "ready",
          value: {
            projectId: request.projectId,
            assetPlan: request.assetPlan,
            assetId: request.assetId,
            classification: context.asset.classification,
            multiviewDecision: "not-required",
          },
        };
      }
      const outcome = await this.multiviewConceptProduction.ensure({
        ...request,
        runId: context.state.runId,
        mode: context.state.mode,
        imageProvider: context.state.imageProvider,
        sourceConceptSet: context.conceptSetRevision,
        anchorConcept: context.anchorConcept,
        rolesToGenerate: decision.roles,
      });
      if (outcome.status !== "ready") return outcome;
      return {
        status: "ready",
        value: {
          projectId: request.projectId,
          assetPlan: request.assetPlan,
          assetId: request.assetId,
          classification: context.asset.classification,
          multiviewConceptSet: outcome.value,
          multiviewDecision: "ready",
        },
      };
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: "multiview-lineage-invalid",
          message: error instanceof Error ? error.message : String(error),
          kind: "policy-blocked",
          evidenceRevisionIds: [
            input.assetPlan.revisionId,
            input.previousMultiviewConceptSet?.revisionId,
            input.strategyRevision?.revisionId,
          ].filter((value): value is string => Boolean(value)),
        },
      };
    }
  }

  async ensure(
    input: AssetProductionRequest,
  ): Promise<ProductionOutcome<RevisionRef>> {
    const parsed = AssetProductionRequestSchema.parse(input);
    return "concept" in parsed
      ? this.ensureLegacy(parsed)
      : this.ensureM2(parsed);
  }

  private resolveM2Context(input: M2AssetProductionRequest) {
    const state = this.repository.getProject(input.projectId);
    if (
      !state.assetPlan ||
      state.assetPlan.revisionId !== input.assetPlan.revisionId ||
      state.assetPlan.artifact.sha256 !== input.assetPlan.artifact.sha256 ||
      state.assetPlanApproval?.decision !== "approved" ||
      state.assetPlanApproval.targetRevisionId !== input.assetPlan.revisionId ||
      state.assetPlanApproval.targetSha256 !== input.assetPlan.artifact.sha256
    ) {
      throw new Error(
        "Asset production requires the current hash-approved plan.",
      );
    }
    const plan = AssetPlanSchema.parse(
      this.repository.resolveRevision(input.assetPlan),
    );
    const { asset, policy } = handlingForPlannedAsset(plan, input.assetId);
    const conceptSetSource = asset.sourceRefs.conceptSet;
    const conceptSetRevision = this.repository.getRevision(
      conceptSetSource.revisionId,
    );
    if (
      conceptSetRevision.artifact.sha256 !== conceptSetSource.sha256 ||
      conceptSetRevision.kind !== conceptSetSource.kind ||
      !state.conceptSet ||
      state.conceptSet.revisionId !== conceptSetRevision.revisionId ||
      state.conceptSet.artifact.sha256 !== conceptSetRevision.artifact.sha256 ||
      state.conceptSetApproval?.decision !== "approved" ||
      state.conceptSetApproval.targetRevisionId !==
        conceptSetRevision.revisionId ||
      state.conceptSetApproval.targetSha256 !==
        conceptSetRevision.artifact.sha256
    ) {
      throw new Error(
        "The planned concept set is stale or no longer approved.",
      );
    }
    const conceptSource = asset.sourceRefs.conceptSlots[0]?.concept;
    if (!conceptSource) {
      throw new Error(`Planned asset ${asset.assetId} has no kept concept.`);
    }
    const anchorConcept = this.repository.getRevision(conceptSource.revisionId);
    if (
      anchorConcept.artifact.sha256 !== conceptSource.sha256 ||
      anchorConcept.kind !== conceptSource.kind
    ) {
      throw new Error(
        `Planned asset ${asset.assetId} has stale concept lineage.`,
      );
    }
    const conceptSet = ConceptSetSchema.parse(
      this.repository.resolveRevision(conceptSetRevision),
    );
    const kept = conceptSet.slots.some(
      (slot) =>
        slot.selectedRevisionId === anchorConcept.revisionId &&
        slot.revisions.some(
          ({ revision }) =>
            revision.revisionId === anchorConcept.revisionId &&
            revision.artifact.sha256 === anchorConcept.artifact.sha256,
        ),
    );
    if (!kept) {
      throw new Error(
        "The planned anchor is not selected in the approved concept set.",
      );
    }
    const anchorDocument = M1ConceptDocumentSchema.parse(
      this.repository.resolveRevision(anchorConcept),
    );
    return {
      state,
      plan,
      asset,
      policy,
      conceptSetRevision,
      anchorConcept,
      anchorDocument,
    };
  }

  private async ensureM2(
    input: M2AssetProductionRequest,
  ): Promise<ProductionOutcome<RevisionRef>> {
    const fallbackRequestId = `m2-asset-${createHash("sha256")
      .update(JSON.stringify([input.projectId, input.assetId, input.assetPlan]))
      .digest("hex")}`;
    try {
      const context = this.resolveM2Context(input);
      let multiviewSet:
        ReturnType<typeof MultiviewConceptSetSchema.parse> | undefined;
      if (input.multiviewConceptSet) {
        multiviewSet = MultiviewConceptSetSchema.parse(
          this.repository.resolveRevision(input.multiviewConceptSet),
        );
        if (
          multiviewSet.assetId !== input.assetId ||
          multiviewSet.sourceAssetPlanRevisionId !==
            input.assetPlan.revisionId ||
          multiviewSet.sourceConceptSetRevisionId !==
            context.conceptSetRevision.revisionId ||
          multiviewSet.anchorConcept.revision.revisionId !==
            context.anchorConcept.revisionId ||
          multiviewSet.anchorConcept.revision.artifact.sha256 !==
            context.anchorConcept.artifact.sha256 ||
          multiviewSet.anchorConcept.image.sha256 !==
            context.anchorDocument.image.sha256
        ) {
          throw new Error(
            "The referenced multiview set does not match the approved asset lineage.",
          );
        }
        for (const view of multiviewSet.views) {
          const document = ConceptViewDocumentSchema.parse(
            this.repository.resolveRevision(view.revision),
          );
          const ancestorIds = new Set(
            document.ancestors.map(({ revisionId }) => revisionId),
          );
          if (
            document.assetId !== input.assetId ||
            document.guidance.role !== view.role ||
            document.image.sha256 !== view.image.sha256 ||
            document.sourceConceptRevisionId !==
              context.anchorConcept.revisionId ||
            !document.referenceArtifactHashes.includes(
              context.anchorDocument.image.sha256,
            ) ||
            !ancestorIds.has(input.assetPlan.revisionId) ||
            !ancestorIds.has(context.conceptSetRevision.revisionId) ||
            !ancestorIds.has(context.anchorConcept.revisionId)
          ) {
            throw new Error(
              `The ${view.role} concept view has corrupt or stale lineage.`,
            );
          }
        }
      }

      const profile = resolveAssetGenerationProfile(
        context.state.assetProvider,
        context.state.mode,
      );
      const adapter = createAssetGenerationAdapter(
        this.repository,
        context.state.assetProvider,
        context.state.mode,
      );
      const canUseMultiview =
        multiviewSet !== undefined &&
        profile.multiviewImageInput.supported &&
        multiviewSet.views.length >= profile.multiviewImageInput.minViews &&
        multiviewSet.views.length <= profile.multiviewImageInput.maxViews &&
        (context.state.assetProvider !== "tripo" ||
          multiviewSet.views.length === 4);
      const orderedViews = multiviewSet
        ? [...multiviewSet.views].sort(
            (left, right) =>
              CARDINAL_VIEW_ROLES.indexOf(left.role) -
              CARDINAL_VIEW_ROLES.indexOf(right.role),
          )
        : [];
      const job: AssetGenerationJob = canUseMultiview
        ? {
            projectId: input.projectId,
            assetId: input.assetId,
            ...(input.regeneration
              ? {
                  regeneration: {
                    attemptNumber: input.regeneration.attemptNumber,
                    strategyRevision: input.regeneration.strategyRevision,
                    parentAssetRevision: input.regeneration.parentAssetRevision,
                  },
                }
              : {}),
            imageInput: {
              kind: "multiview",
              conceptSet: input.multiviewConceptSet!,
              anchorConcept: context.anchorConcept,
              views: orderedViews.map(({ role, revision, image }) => ({
                role,
                revision,
                image,
              })),
            },
          }
        : {
            projectId: input.projectId,
            assetId: input.assetId,
            ...(input.regeneration
              ? {
                  regeneration: {
                    attemptNumber: input.regeneration.attemptNumber,
                    strategyRevision: input.regeneration.strategyRevision,
                    parentAssetRevision: input.regeneration.parentAssetRevision,
                  },
                }
              : {}),
            imageInput: {
              kind: "single",
              concept: context.anchorConcept,
              image: context.anchorDocument.image,
            },
          };
      const requestFingerprint = adapter.requestFingerprint(job);
      const idempotencyKey = m2AssetIdempotencyKey({
        projectId: input.projectId,
        mode: context.state.mode,
        provider: context.state.assetProvider,
        requestFingerprint,
      });
      const prior = this.repository.getSubmissionByKey(idempotencyKey);
      const decision =
        prior?.status === "intent-recorded" &&
        prior.payload.preparationRetryable === true &&
        typeof prior.payload.providerCallStartedAt !== "string"
          ? ({ kind: "proceed", submission: prior } as const)
          : decideDurableSubmission(prior, context.state.mode);
      if (decision.kind === "ready") {
        if (!decision.submission.resultRevisionId) {
          return {
            status: "failed",
            requestId: decision.submission.requestId,
            error: {
              code: "asset-generation-failed",
              message: "The ready M2 submission has no asset revision.",
              recoverable: true,
              failureKind: "retryable",
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
                ? "The paid asset request may have succeeded; Fulcrum will not submit it again automatically."
                : "The previous M2 asset job failed.",
            recoverable: true,
            failureKind:
              decision.submission.status === "submission-unknown"
                ? "user-action-required"
                : "strategy-changing",
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
            message:
              "The paid asset request may have succeeded; Fulcrum will not submit it again automatically.",
            recoverable: true,
            failureKind: "user-action-required",
          },
        };
      }

      const imageEntries =
        job.imageInput.kind === "multiview"
          ? job.imageInput.views.map(({ role, image }) => ({ role, image }))
          : [{ role: "anchor", image: job.imageInput.image }];
      const endpointKind =
        context.state.assetProvider === "meshy"
          ? job.imageInput.kind === "multiview"
            ? "multi-image-to-3d"
            : "image-to-3d"
          : job.imageInput.kind === "multiview"
            ? "multiview_to_model"
            : "image_to_model";
      const submission =
        "submission" in decision && decision.submission
          ? decision.submission
          : this.repository.recordSubmissionIntent({
              projectId: input.projectId,
              operation: "m2-image-to-model",
              provider:
                context.state.mode === "replay"
                  ? "fulcrum-replay"
                  : context.state.assetProvider,
              idempotencyKey,
              payload: {
                assetId: input.assetId,
                conceptRevisionId: context.anchorConcept.revisionId,
                ...(canUseMultiview && input.multiviewConceptSet
                  ? {
                      multiviewConceptSetRevisionId:
                        input.multiviewConceptSet.revisionId,
                    }
                  : {}),
                endpointKind,
                jobKind:
                  job.imageInput.kind === "multiview"
                    ? "multi-image"
                    : "single-image",
                roleOrder: imageEntries.map(({ role }) => role),
                imageArtifactIds: imageEntries.map(
                  ({ image }) => image.artifactId,
                ),
                imageHashes: imageEntries.map(({ image }) => image.sha256),
                modelVersion: profile.modelVersion,
                requestFingerprint,
                ...(input.regeneration
                  ? {
                      attemptNumber: input.regeneration.attemptNumber,
                      strategyRevisionId:
                        input.regeneration.strategyRevision.revisionId,
                      parentAssetRevisionId:
                        input.regeneration.parentAssetRevision.revisionId,
                    }
                  : {}),
              },
            });
      if (
        input.regeneration &&
        !("submission" in decision && decision.submission)
      ) {
        appendQualityEvent(this.repository, {
          projectId: input.projectId,
          runId: context.state.runId,
          type: "asset.regeneration-attempt-started",
          payload: {
            attemptNumber: input.regeneration.attemptNumber,
            strategyRevisionId: input.regeneration.strategyRevision.revisionId,
            parentAssetRevisionId:
              input.regeneration.parentAssetRevision.revisionId,
            multiviewConceptSetRevisionId:
              input.multiviewConceptSet?.revisionId ?? null,
            requestId: submission.requestId,
          },
        });
      }

      let generated: GeneratedAsset | undefined;
      if (decision.kind === "inspect") {
        try {
          const inspected = await adapter.inspect(
            adapterJobRefFromSubmissionPayload(
              decision.submission.externalJobId!,
              decision.submission.payload,
            ),
          );
          if (inspected.status === "pending") {
            return {
              status: "pending",
              requestId: submission.requestId,
              resumeAfter: inspected.resumeAfter,
            };
          }
          if (inspected.status === "failed") {
            this.repository.updateSubmission(submission.requestId, {
              status: "failed",
              payload: {
                ...submission.payload,
                providerError: inspected.error,
              },
            });
            return {
              status: "failed",
              requestId: submission.requestId,
              error: {
                code: `${context.state.assetProvider}-job-failed`,
                message: inspected.error,
                recoverable: true,
                failureKind: "strategy-changing",
              },
            };
          }
          generated = inspected.asset;
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
      } else {
        if (context.state.mode === "live") {
          const current =
            this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
          if (typeof current.payload.budgetReservedUsd !== "number") {
            try {
              const configuration =
                context.state.assetProvider === "meshy"
                  ? meshyConfiguration()
                  : tripoConfiguration();
              this.repository.reserveBudget(
                input.projectId,
                configuration.reservedCost,
                `${context.state.assetProvider} ${endpointKind}`,
              );
              this.repository.updateSubmission(submission.requestId, {
                status: "intent-recorded",
                payload: {
                  ...current.payload,
                  budgetReservedUsd: configuration.reservedCost,
                },
              });
            } catch (error) {
              if (isProviderPreflightError(error)) {
                return this.refuseBeforeProviderCall(submission, error);
              }
              throw error;
            }
          }
          if (context.state.assetProvider === "meshy") {
            const currentSubmission =
              this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
            this.repository.updateSubmission(submission.requestId, {
              status: "pending",
              payload: {
                ...currentSubmission.payload,
                providerCallStartedAt: new Date().toISOString(),
              },
            });
          }
        }
        let adapterJob;
        try {
          adapterJob = await adapter.submit(job, idempotencyKey);
        } catch (error) {
          const current =
            this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
          if (error instanceof AssetPreparationError) {
            this.repository.updateSubmission(submission.requestId, {
              status: "intent-recorded",
              payload: {
                ...current.payload,
                preparationRetryable: true,
                preparationError: error.message,
              },
            });
            return {
              status: "failed",
              requestId: submission.requestId,
              error: {
                code: "asset-preparation-retryable",
                message: error.message,
                recoverable: true,
                failureKind: "retryable",
              },
            };
          }
          const message =
            error instanceof Error ? error.message : String(error);
          this.repository.updateSubmission(submission.requestId, {
            status: "submission-unknown",
            payload: { ...current.payload, error: message },
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
        const current =
          this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
          externalJobId: adapterJob.taskId,
          payload: {
            ...current.payload,
            jobKind: adapterJob.jobKind,
            submittedAt: new Date().toISOString(),
          },
        });
        if (context.state.mode === "live") {
          return {
            status: "pending",
            requestId: submission.requestId,
            resumeAfter: new Date(Date.now() + 5_000).toISOString(),
          };
        }
        const inspected = await adapter.inspect(adapterJob);
        if (inspected.status !== "ready") {
          throw new Error(
            "Replay asset adapter did not complete synchronously.",
          );
        }
        generated = inspected.asset;
      }

      const glb = this.repository.putArtifact(
        input.projectId,
        generated.bytes,
        "model/gltf-binary",
      );
      const inputImageHashes = imageEntries.map(({ image }) => image.sha256);
      const asset = AssetDocumentSchema.parse({
        assetId: input.assetId,
        name: context.asset.name,
        classification: context.asset.classification,
        glb,
        provider: generated.provider,
        model: generated.model,
        sourceConceptRevisionId: context.anchorConcept.revisionId,
        ...(canUseMultiview && input.multiviewConceptSet
          ? {
              sourceMultiviewConceptSetRevisionId:
                input.multiviewConceptSet.revisionId,
            }
          : {}),
        sourceImageArtifactHashes: inputImageHashes,
        sourceConceptRevisionIds: [context.anchorConcept.revisionId],
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
        runId: context.state.runId,
      });
      const current =
        this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: revision.revisionId,
        payload: { ...current.payload, ...(generated.providerMetadata ?? {}) },
      });
      this.repository.appendEvent({
        projectId: input.projectId,
        runId: context.state.runId,
        type: "asset.completed",
        payload: {
          revisionId: revision.revisionId,
          glbArtifactId: glb.artifactId,
          ...(canUseMultiview && input.multiviewConceptSet
            ? {
                multiviewConceptSetRevisionId:
                  input.multiviewConceptSet.revisionId,
              }
            : {}),
          inputImageHashes,
        },
      });
      return {
        status: "ready",
        requestId: submission.requestId,
        value: revision,
      };
    } catch (error) {
      return {
        status: "failed",
        requestId: fallbackRequestId,
        error: {
          code: isProviderPreflightError(error)
            ? error.code
            : "multiview-lineage-invalid",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
          failureKind: isProviderPreflightError(error)
            ? "retryable"
            : "policy-blocked",
        },
      };
    }
  }

  private async ensureLegacy(
    input: Extract<AssetProductionRequest, { concept: RevisionRef }>,
  ): Promise<ProductionOutcome<RevisionRef>> {
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
    const adapter = createAssetGenerationAdapter(
      this.repository,
      input.assetProvider,
      input.mode,
    );
    const legacyJob: AssetGenerationJob = {
      projectId: input.projectId,
      assetId: `${input.projectId}:reliquary-asset`,
      imageInput: {
        kind: "single",
        concept: input.concept,
        image: concept.image,
      },
    };
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
          inspected = await adapter.inspect(
            adapterJobRefFromSubmissionPayload(
              submission.externalJobId!,
              submission.payload,
            ),
          );
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
        if (input.assetProvider === "meshy") {
          this.repository.updateSubmission(submission.requestId, {
            status: "pending",
            payload: {
              ...intentPayload,
              providerCallStartedAt: new Date().toISOString(),
            },
          });
        }
        let job;
        try {
          job = await adapter.submit(legacyJob, idempotencyKey);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (error instanceof AssetPreparationError) {
            const current =
              this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
            this.repository.updateSubmission(submission.requestId, {
              status: "intent-recorded",
              payload: {
                ...current.payload,
                preflightCode: "payload-invalid",
                preparationRetryable: true,
                error: message,
              },
            });
            return {
              status: "failed",
              requestId: submission.requestId,
              error: {
                code: "asset-preparation-retryable",
                message,
                recoverable: true,
                failureKind: "retryable",
              },
            };
          }
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
            jobKind: job.jobKind,
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
      const { reservedCost } = meshyConfiguration();
      this.repository.reserveBudget(
        projectId,
        reservedCost,
        "Meshy image-to-3D",
      );
      return;
    }
    const { reservedCost } = tripoConfiguration();
    this.repository.reserveBudget(
      projectId,
      reservedCost,
      "Tripo image-to-model",
    );
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
    const idempotencyKey = `asset-semantic:${input.projectId}:${asset.assetId}:${input.mode}:${requestDigest}`;
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
    if (input.mode === "live" && submission?.payload.providerCallStartedAt) {
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
        operationKey: `m2.asset-semantic:${asset.assetId}:${requestDigest}`,
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
    const state = this.repository.getProject(input.projectId);
    const multiviewCapability = resolveAssetGenerationProfile(
      state.assetProvider,
      state.mode,
    ).multiviewImageInput;
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
      providerSupportsMultiview: multiviewCapability.supported,
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
