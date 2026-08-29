import { storeImageAttachment } from "@fulcrum/creative";
import {
  ASSET_STAGE_DECISION_STAGES,
  AssetBipedDetectionSchema,
  AssetPlanSchema,
  AssetReferenceSetSchema,
  AssetRigEligibilityOverrideSchema,
  AssetStageRecordSchema,
  AssetStageViewSchema,
  DecideAssetStageInputSchema,
  DEFAULT_MESHY_CONFIG,
  FinalizedAssetPlanBindingSchema,
  M1ConceptDocumentSchema,
  MAX_ASSET_REFERENCE_SET_BYTES,
  MeshyConfigSchema,
  MESHY_STAGE_CREDITS,
  MultiviewConceptSetSchema,
  ProviderPreflightError,
  OverrideAssetRigEligibilityInputSchema,
  StartAssetStageInputSchema,
  StoreAssetReferenceSetInputSchema,
  UpdateMeshyConfigInputSchema,
  assetRigEligibility,
  assetStageOffers,
  handlingForPlannedAsset,
  type ArtifactRef,
  type AssetBipedDetection,
  type AssetReferenceSet,
  type AssetReferenceView,
  type AssetRigEligibilityEvidence,
  type AssetRigEligibilityOverride,
  type AssetStageRecord,
  type AssetStageRun,
  type AssetStageView,
  type ConceptViewRole,
  type MeshyConfig,
  type MeshyStage,
  type PlannedAsset,
  type ProjectState,
} from "@fulcrum/domain";
import {
  inspectExecutionProviders,
  ModelExecution,
  preferredVisionProvider,
  type ExecutionProviderStatus,
  type StructuredVisionExecution,
} from "@fulcrum/execution";
import type { ProjectRepository } from "@fulcrum/project";

import { CARDINAL_VIEW_ROLES } from "./asset-generation.js";
import {
  MESHY_STAGE_ENDPOINTS,
  type MeshyStageEndpoint,
} from "./meshy-adapter.js";
import { stagedShapeSeed } from "./staged-glb.js";
import {
  createStagedAssetAdapter,
  type StagedAssetAdapter,
  type StagedBinary,
  type StagedSubmitInput,
} from "./staged-meshy.js";
import {
  LiveBipedDetectionPort,
  ReplayBipedDetectionPort,
  VisionEvaluationError,
} from "./vision-evaluation.js";

/**
 * The staged asset gate.
 *
 * One asset walks geometry (20 CR) → texture (10 CR) → rig (5 CR) → animation
 * (3 CR), and a human stands at every boundary with the previous result loaded
 * in a viewer. Nothing advances on its own: each transition is either a poll of
 * a task already paid for, or a decision that authorizes the next spend.
 *
 * Everything durable lives in `ProjectState.assetStages` and in the repository's
 * submission records, so a restarted orchestrator resumes mid-task, and every
 * decision and transition is an appended event.
 */

const POLL_INTERVAL_MS = 5_000;

const OPERATION_BY_STAGE: Record<MeshyStage, string> = {
  geometry: "m2-staged-geometry",
  texture: "m2-staged-texture",
  rig: "m2-staged-rig",
  animation: "m2-staged-animation",
};

const CREDIT_LABELS: Record<MeshyStage, string> = {
  geometry: "Meshy 6 geometry",
  texture: "Meshy 6 retexture",
  rig: "Meshy rigging",
  animation: "Meshy animation clip",
};

export type StagedAssetLifecycleOptions = {
  adapter?: StagedAssetAdapter;
  now?: () => string;
  visionExecution?: StructuredVisionExecution;
  visionProviderStatuses?: ExecutionProviderStatus[];
};

export type StagedAssetOutcome = {
  record: AssetStageRecord;
  /** Set while a paid task is in flight, so a caller can schedule the next poll. */
  resumeAfter?: string;
};

const nowIso = () => new Date().toISOString();

/**
 * Views in the one order every Meshy request uses. `multi-image-to-3d` reads
 * `image_urls` positionally, so a set that arrives front/right/back/left and a
 * set that arrives front/left/back/right must not describe two different
 * subjects to the same model.
 */
const inCardinalOrder = <T extends { role: ConceptViewRole }>(
  views: readonly T[],
): T[] =>
  [...views].sort(
    (left, right) =>
      CARDINAL_VIEW_ROLES.indexOf(left.role) -
      CARDINAL_VIEW_ROLES.indexOf(right.role),
  );

/** Decoded size of a base64 data URL, without allocating the buffer. */
const dataUrlByteLength = (dataUrl: string): number => {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

/** The run a poll should look at, if any. */
const activeRunOf = (record: AssetStageRecord): AssetStageRun | undefined =>
  record.runs.find((run) => run.status === "running");

const creditTotals = (record: AssetStageRecord) => ({
  creditsReserved: record.runs
    .filter((run) => run.status === "running")
    .reduce((total, run) => total + run.reservedCredits, 0),
  creditsConsumed: record.runs.reduce(
    (total, run) => total + (run.consumedCredits ?? 0),
    0,
  ),
});

const latestSucceeded = (record: AssetStageRecord): AssetStageRun | undefined =>
  [...record.runs]
    .reverse()
    .find((run) => run.status === "succeeded" && run.model !== undefined);

/**
 * Projects one durable record into what the studio renders. Kept pure and
 * exported so the snapshot, the routes and the tests all read the same view.
 */
export const assetStageView = (
  record: AssetStageRecord,
  planned: PlannedAsset,
  evidence: AssetRigEligibilityEvidence = {},
): AssetStageView => {
  const eligibility = assetRigEligibility(planned, evidence);
  const active = activeRunOf(record);
  const preview = latestSucceeded(record);
  return AssetStageViewSchema.parse({
    ...record,
    name: planned.name,
    classification: planned.classification,
    ...(eligibility.poseMode ? { poseMode: eligibility.poseMode } : {}),
    rigEligible: eligibility.eligible,
    rigEligibilityReason: eligibility.reason,
    rigEligibilitySource: eligibility.source,
    ...(evidence.override ? { rigEligibilityOverride: evidence.override } : {}),
    ...(evidence.detection ? { bipedDetection: evidence.detection } : {}),
    progress: active
      ? active.progress
      : record.status === "not-started"
        ? 0
        : 100,
    ...(active ? { activeRun: active } : {}),
    ...(preview
      ? {
          preview: {
            glb: preview.model!,
            stage: preview.stage,
            round: preview.round,
            textured: preview.stage !== "geometry",
            rigged: preview.stage === "rig" || preview.stage === "animation",
            animated: preview.stage === "animation",
          },
        }
      : {}),
    offers: assetStageOffers(record, eligibility),
    ...creditTotals(record),
  });
};

/** Every planned asset, whether or not its lifecycle has started. */
export const assetStageViews = (
  state: ProjectState,
  plan: { assets: PlannedAsset[] },
  now: () => string = nowIso,
  evidenceByAsset: Record<string, AssetRigEligibilityEvidence> = {},
): Record<string, AssetStageView> =>
  Object.fromEntries(
    plan.assets.map((planned) => [
      planned.assetId,
      assetStageView(
        state.assetStages?.[planned.assetId] ??
          AssetStageRecordSchema.parse({
            assetId: planned.assetId,
            status: "not-started",
            stage: "geometry",
            runs: [],
            decisions: [],
            updatedAt: now(),
          }),
        planned,
        evidenceByAsset[planned.assetId],
      ),
    ]),
  );

export const resolveMeshyConfig = (
  repository: ProjectRepository,
  state: ProjectState,
): MeshyConfig =>
  state.meshyConfig
    ? MeshyConfigSchema.parse(repository.resolveRevision(state.meshyConfig))
    : DEFAULT_MESHY_CONFIG;

export class StagedAssetLifecycle {
  private readonly adapter: StagedAssetAdapter | undefined;
  private readonly now: () => string;
  private readonly visionExecution: StructuredVisionExecution;
  private readonly visionProviderStatuses:
    ExecutionProviderStatus[] | undefined;

  constructor(
    private readonly repository: ProjectRepository,
    options: StagedAssetLifecycleOptions = {},
  ) {
    this.adapter = options.adapter;
    this.now = options.now ?? nowIso;
    this.visionExecution = options.visionExecution ?? new ModelExecution();
    this.visionProviderStatuses = options.visionProviderStatuses;
  }

  config(projectId: string): MeshyConfig {
    return resolveMeshyConfig(this.repository, this.state(projectId));
  }

  /**
   * Records the reference views a human approved for one asset.
   *
   * Free, and deliberately reachable before the asset plan is approved:
   * building a reference set is part of deciding whether the plan is worth
   * approving. The asset only has to exist in the *current* plan revision.
   * Geometry — the first thing that spends — still refuses to run without an
   * approved plan, so nothing here can bring a charge forward.
   */
  async recordReferences(
    projectId: string,
    input: unknown,
  ): Promise<AssetReferenceSet> {
    const parsed = StoreAssetReferenceSetInputSchema.parse(input);
    const state = this.state(projectId);
    if (!state.assetPlan)
      throw new Error(`Project ${projectId} has no asset plan.`);
    const plan = AssetPlanSchema.parse(
      this.repository.resolveRevision(state.assetPlan),
    );
    const planned = plan.assets.find(
      ({ assetId }) => assetId === parsed.assetId,
    );
    if (!planned)
      throw new Error(
        `${parsed.assetId} is not in this project's current asset plan.`,
      );

    const ordered = inCardinalOrder(parsed.views);
    const totalBytes = ordered.reduce(
      (total, view) => total + dataUrlByteLength(view.dataUrl),
      0,
    );
    if (totalBytes > MAX_ASSET_REFERENCE_SET_BYTES)
      throw new Error(
        `An approved reference set must total ${MAX_ASSET_REFERENCE_SET_BYTES / (1024 * 1024)} MB or less across every view.`,
      );

    const views: AssetReferenceView[] = [];
    for (const view of ordered)
      views.push({
        role: view.role,
        source: view.source,
        image: await storeImageAttachment({
          repository: this.repository,
          projectId,
          dataUrl: view.dataUrl,
        }),
      });

    const set = AssetReferenceSetSchema.parse({
      assetId: parsed.assetId,
      sourceAssetPlanRevisionId: state.assetPlan.revisionId,
      views,
      approvedAt: this.now(),
    });
    const revision = this.repository.writeRevision({
      projectId,
      entityId: `${projectId}:asset-reference-set:${parsed.assetId}`,
      kind: "asset-reference-set",
      value: set,
      runId: state.runId,
    });
    const current = this.state(projectId);
    this.repository.saveProject({
      ...current,
      assetReferenceSets: {
        ...current.assetReferenceSets,
        [parsed.assetId]: revision,
      },
    });
    this.event(projectId, "asset.references-approved", {
      assetId: parsed.assetId,
      revisionId: revision.revisionId,
      roles: views.map(({ role }) => role),
      artifactIds: views.map(({ image }) => image.artifactId),
    });
    if (planned.classification === "hero")
      await this.detectBiped(projectId, parsed.assetId);
    return set;
  }

  /**
   * Detects a riggable biped from the approved front reference. Replay runs a
   * seeded local heuristic; live uses the same structured-vision provider
   * selection and durable submission pattern as semantic asset evaluation.
   */
  async detectBiped(
    projectId: string,
    assetId: string,
  ): Promise<AssetBipedDetection> {
    const state = this.state(projectId);
    if (!state.assetPlan)
      throw new Error(`Project ${projectId} has no asset plan.`);
    const plan = AssetPlanSchema.parse(
      this.repository.resolveRevision(state.assetPlan),
    );
    const planned = handlingForPlannedAsset(plan, assetId).asset;
    if (planned.classification !== "hero")
      throw new Error(
        `Automatic biped detection only runs for hero assets; ${assetId} is planned as ${planned.classification}.`,
      );
    const referenceRevision = state.assetReferenceSets?.[assetId];
    if (!referenceRevision)
      throw new Error(
        `${assetId} needs an approved reference set before biped detection.`,
      );
    const existing = this.resolvedDetection(state, assetId);
    if (existing) return existing;
    const set = AssetReferenceSetSchema.parse(
      this.repository.resolveRevision(referenceRevision),
    );
    const front = set.views.find(({ role }) => role === "front");
    if (!front)
      throw new Error(`${assetId}'s approved reference set has no front view.`);

    const idempotencyKey = `biped-detection:v1:${projectId}:${assetId}:${referenceRevision.revisionId}`;
    let submission = this.repository.getSubmissionByKey(idempotencyKey);
    if (submission?.status === "ready" && submission.resultRevisionId) {
      const revision = this.repository.getRevision(submission.resultRevisionId);
      const detection = AssetBipedDetectionSchema.parse(
        this.repository.resolveRevision(revision),
      );
      this.repository.saveProject({
        ...this.state(projectId),
        assetBipedDetections: {
          ...this.state(projectId).assetBipedDetections,
          [assetId]: revision,
        },
      });
      return detection;
    }
    if (state.mode === "live" && submission?.payload.providerCallStartedAt)
      throw new Error(
        `Biped detection for ${assetId} may already have reached the vision provider; Fulcrum will not submit it twice.`,
      );

    const provider =
      state.mode === "replay"
        ? "fulcrum-replay"
        : preferredVisionProvider(
            this.visionProviderStatuses ?? inspectExecutionProviders(),
          );
    if (!provider)
      throw new ProviderPreflightError(
        "provider-unconfigured",
        "Biped detection requires signed-in Codex or a configured OpenAI API key.",
      );
    submission ??= this.repository.recordSubmissionIntent({
      projectId,
      operation: "asset-biped-detection",
      provider,
      idempotencyKey,
      payload: {
        assetId,
        assetPlanRevisionId: state.assetPlan.revisionId,
        referenceSetRevisionId: referenceRevision.revisionId,
        frontImageSha256: front.image.sha256,
        budgetReserved: false,
      },
    });

    if (
      provider === "openai-api" &&
      submission.payload.budgetReserved !== true
    ) {
      const reservedCost = Number(
        process.env.FULCRUM_OPENAI_VISION_RESERVE_USD ?? "0.05",
      );
      if (!Number.isFinite(reservedCost) || reservedCost < 0)
        throw new ProviderPreflightError(
          "payload-invalid",
          "FULCRUM_OPENAI_VISION_RESERVE_USD must be a finite non-negative number.",
        );
      this.repository.reserveBudget(
        projectId,
        reservedCost,
        "OpenAI biped detection",
      );
      submission = this.repository.updateSubmission(submission.requestId, {
        status: "intent-recorded",
        payload: {
          ...submission.payload,
          budgetReserved: true,
          reservedCostUsd: reservedCost,
        },
      });
    }

    submission = this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...submission.payload,
        providerCallStartedAt: this.now(),
      },
    });
    try {
      const port =
        provider === "fulcrum-replay"
          ? new ReplayBipedDetectionPort()
          : new LiveBipedDetectionPort(
              this.visionExecution,
              provider,
              this.repository.workspaceRoot,
            );
      const result = await port.detect(
        {
          assetId,
          name: planned.name,
          description: [planned.rationale, ...planned.acceptanceCriteria].join(
            " ",
          ),
          classification: planned.classification,
          frontImage: front.image,
          frontImageBytes: this.repository.readArtifact(front.image),
        },
        idempotencyKey,
      );
      const detection = AssetBipedDetectionSchema.parse({
        assetId,
        sourceAssetPlanRevisionId: state.assetPlan.revisionId,
        sourceReferenceSetRevisionId: referenceRevision.revisionId,
        ...result.verdict,
        provider: result.provider,
        model: result.model,
        detectedAt: this.now(),
      });
      const revision = this.repository.writeRevision({
        projectId,
        entityId: `${projectId}:asset-biped-detection:${assetId}`,
        kind: "asset-biped-detection",
        value: detection,
        runId: state.runId,
      });
      this.repository.saveProject({
        ...this.state(projectId),
        assetBipedDetections: {
          ...this.state(projectId).assetBipedDetections,
          [assetId]: revision,
        },
      });
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: revision.revisionId,
        payload: {
          ...submission.payload,
          provider: result.provider,
          model: result.model,
          completedAt: this.now(),
        },
      });
      this.event(projectId, "asset.biped-detected", {
        assetId,
        revisionId: revision.revisionId,
        biped: detection.biped,
        confidence: detection.confidence,
        rationale: detection.rationale,
        provider: detection.provider,
        model: detection.model,
      });
      return detection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.updateSubmission(submission.requestId, {
        status:
          provider === "fulcrum-replay" &&
          error instanceof VisionEvaluationError
            ? "failed"
            : "submission-unknown",
        payload: { ...submission.payload, error: message },
      });
      throw error;
    }
  }

  /** Records a human override without changing the approved asset plan. */
  overrideRigEligibility(
    projectId: string,
    input: unknown,
  ): AssetRigEligibilityOverride {
    const parsed = OverrideAssetRigEligibilityInputSchema.parse(input);
    this.plannedAsset(projectId, parsed.assetId);
    const state = this.state(projectId);
    const decision = AssetRigEligibilityOverrideSchema.parse({
      assetId: parsed.assetId,
      sourceAssetPlanRevisionId: state.assetPlan!.revisionId,
      biped: parsed.biped,
      ...(parsed.biped ? { poseMode: parsed.poseMode ?? "a-pose" } : {}),
      decidedBy: "local-user",
      decidedAt: this.now(),
    });
    const revision = this.repository.writeRevision({
      projectId,
      entityId: `${projectId}:asset-rig-eligibility:${parsed.assetId}`,
      kind: "asset-rig-eligibility-override",
      value: decision,
      runId: state.runId,
    });
    this.repository.saveProject({
      ...this.state(projectId),
      assetRigEligibilityOverrides: {
        ...this.state(projectId).assetRigEligibilityOverrides,
        [parsed.assetId]: revision,
      },
    });
    this.event(projectId, "asset.rig-eligibility-overridden", {
      assetId: parsed.assetId,
      revisionId: revision.revisionId,
      biped: decision.biped,
      poseMode: decision.poseMode ?? null,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
    });
    return decision;
  }

  /** Every approved reference set, resolved for the snapshot. */
  referenceSets(projectId: string): Record<string, AssetReferenceSet> {
    return Object.fromEntries(
      Object.entries(this.state(projectId).assetReferenceSets ?? {}).map(
        ([assetId, revision]) => [
          assetId,
          AssetReferenceSetSchema.parse(
            this.repository.resolveRevision(revision),
          ),
        ],
      ),
    );
  }

  views(projectId: string): Record<string, AssetStageView> {
    const state = this.state(projectId);
    if (!state.assetPlan) return {};
    const plan = AssetPlanSchema.parse(
      this.repository.resolveRevision(state.assetPlan),
    );
    return assetStageViews(
      state,
      plan,
      this.now,
      Object.fromEntries(
        plan.assets.map((asset) => [
          asset.assetId,
          this.rigEvidence(state, asset.assetId),
        ]),
      ),
    );
  }

  /**
   * Rewrites the project's Meshy settings.
   *
   * Refused while any asset has a paid task in flight. Meshy has already been
   * handed the old settings; letting the panel move underneath a running task
   * would make the record of what was actually requested unreconstructable.
   */
  updateConfig(projectId: string, input: unknown): MeshyConfig {
    const state = this.state(projectId);
    const inFlight = Object.values(state.assetStages ?? {}).find((record) =>
      activeRunOf(record),
    );
    if (inFlight)
      throw new ProviderPreflightError(
        "payload-invalid",
        `Meshy settings are locked while ${inFlight.assetId} has a ${activeRunOf(inFlight)!.stage} task in flight.`,
      );
    const patch = UpdateMeshyConfigInputSchema.parse(input);
    const config = MeshyConfigSchema.parse({
      ...resolveMeshyConfig(this.repository, state),
      ...patch,
    });
    const revision = this.repository.writeRevision({
      projectId,
      entityId: "meshy-config",
      kind: "meshy-config",
      value: config,
      runId: state.runId,
    });
    this.repository.saveProject({
      ...this.state(projectId),
      meshyConfig: revision,
    });
    this.event(projectId, "asset.meshy-config-updated", {
      revisionId: revision.revisionId,
      changedKeys: Object.keys(patch).sort(),
    });
    return config;
  }

  /** Authorizes the first paid task for one asset: 20 credits of geometry. */
  async start(projectId: string, input: unknown): Promise<StagedAssetOutcome> {
    const parsed = StartAssetStageInputSchema.parse(input);
    const record = this.recordFor(projectId, parsed.assetId);
    if (record.status !== "not-started")
      throw new Error(
        `Asset ${parsed.assetId} already started its staged lifecycle.`,
      );
    return await this.submitStage(projectId, parsed.assetId, "geometry", 1);
  }

  /**
   * Advances whatever paid task is in flight for one asset. Safe to call on a
   * timer, on a page load, or not at all — it is a read of Meshy plus a write
   * of whatever changed.
   */
  async poll(projectId: string, assetId: string): Promise<StagedAssetOutcome> {
    const record = this.recordFor(projectId, assetId);
    const run = activeRunOf(record);
    if (!run) return { record };

    const submission = this.repository.getSubmissionByKey(
      this.idempotencyKey(projectId, assetId, run.stage, run.round),
    );
    if (!submission?.externalJobId)
      throw new Error(
        `The ${run.stage} task for ${assetId} has no provider job to poll.`,
      );
    const pollCount = Number(submission.payload.pollCount ?? 0) + 1;
    this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: { ...submission.payload, pollCount },
    });

    const state = await this.adapterFor(projectId).inspect({
      stage: run.stage,
      round: run.round,
      taskId: submission.externalJobId,
      endpoint:
        (submission.payload.endpoint as MeshyStageEndpoint) ??
        MESHY_STAGE_ENDPOINTS[run.stage],
      shapeSeed: stagedShapeSeed(assetId),
      pollCount,
    });

    if (state.status === "running") {
      const advanced = this.replaceRun(projectId, assetId, {
        ...run,
        progress: state.progress,
        updatedAt: this.now(),
      });
      return {
        record: advanced,
        resumeAfter: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
      };
    }

    /* Reconcile only what was reserved. A replay world without a credit cap
       never reserved anything, and the ledger must not invent a debt. */
    if (typeof submission.payload.meshyCreditsReserved === "number")
      this.repository.reconcileMeshySubmissionCredits(
        submission.requestId,
        state.consumedCredits,
        CREDIT_LABELS[run.stage],
      );

    if (state.status === "succeeded") {
      const model = this.repository.putArtifact(
        projectId,
        state.model,
        "model/gltf-binary",
      );
      const supporting = state.supporting.map(({ role, mediaType, bytes }) => ({
        role,
        artifact: this.repository.putArtifact(projectId, bytes, mediaType),
      }));
      const finished = this.now();
      const next = this.writeRecord(projectId, assetId, (current) => ({
        ...current,
        status: "review",
        stage: run.stage,
        runs: this.withRun(current, {
          ...run,
          status: "succeeded",
          progress: 100,
          consumedCredits: state.consumedCredits,
          model,
          ...(supporting.length > 0 ? { supporting } : {}),
          updatedAt: finished,
          finishedAt: finished,
        }),
        updatedAt: finished,
      }));
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        payload: {
          ...submission.payload,
          pollCount,
          glbArtifactId: model.artifactId,
        },
      });
      this.event(projectId, "asset.stage-succeeded", {
        assetId,
        stage: run.stage,
        round: run.round,
        glbArtifactId: model.artifactId,
        consumedCredits: state.consumedCredits,
      });
      return { record: next };
    }

    /* `expired` is kept distinct from `failed` on purpose. Meshy refunds a
       failed task; an expired one succeeded, was billed, and had its result
       deleted. Collapsing the two would offer a free-looking retry for work
       already paid for. */
    const terminal = state.status === "canceled" ? "failed" : state.status;
    const finishedAt = this.now();
    const next = this.writeRecord(projectId, assetId, (current) => ({
      ...current,
      status: terminal,
      stage: run.stage,
      runs: this.withRun(current, {
        ...run,
        status: state.status,
        consumedCredits: state.consumedCredits,
        error: state.error,
        updatedAt: finishedAt,
        finishedAt,
      }),
      terminalReason: state.error,
      updatedAt: finishedAt,
    }));
    this.repository.updateSubmission(submission.requestId, {
      status: "failed",
      payload: { ...submission.payload, pollCount, error: state.error },
    });
    this.event(projectId, `asset.stage-${state.status}`, {
      assetId,
      stage: run.stage,
      round: run.round,
      consumedCredits: state.consumedCredits,
      error: state.error,
    });
    return { record: next };
  }

  /** Records a human's call at a review gate, and spends if the call costs. */
  async decide(projectId: string, input: unknown): Promise<StagedAssetOutcome> {
    const parsed = DecideAssetStageInputSchema.parse(input);
    const record = this.recordFor(projectId, parsed.assetId);
    const planned = this.plannedAsset(projectId, parsed.assetId);
    const eligibility = assetRigEligibility(
      planned,
      this.rigEvidence(this.state(projectId), parsed.assetId),
    );
    if (
      (parsed.decision === "rig" || parsed.decision === "animate") &&
      !eligibility.eligible
    )
      throw new Error(eligibility.reason);
    const offers = assetStageOffers(record, eligibility);
    const offer = offers.find(({ decision }) => decision === parsed.decision);
    if (!offer)
      throw new Error(
        `"${parsed.decision}" is not offered for ${parsed.assetId} at ${record.stage}/${record.status}.`,
      );
    if (!offer.available)
      throw new Error(
        offer.unavailableReason ?? "That decision is unavailable.",
      );
    /* The studio echoes back the price it rendered. A CTA drawn against an
       older price list must not be able to authorize a different spend. */
    if (parsed.acknowledgedCredits !== offer.credits)
      throw new Error(
        `This decision costs ${offer.credits} credits, but ${parsed.acknowledgedCredits} were acknowledged.`,
      );

    const decidedAt = this.now();
    const reviewedRound =
      [...record.runs].reverse().find((run) => run.stage === record.stage)
        ?.round ?? 1;
    const withDecision = this.writeRecord(
      projectId,
      parsed.assetId,
      (current) => ({
        ...current,
        decisions: [
          ...current.decisions,
          {
            decision: parsed.decision,
            reviewedStage: current.stage,
            reviewedRound,
            credits: offer.credits,
            ...(parsed.note ? { note: parsed.note } : {}),
            decidedAt,
          },
        ],
        updatedAt: decidedAt,
      }),
    );
    this.event(projectId, "asset.stage-decided", {
      assetId: parsed.assetId,
      decision: parsed.decision,
      reviewedStage: withDecision.stage,
      reviewedRound,
      credits: offer.credits,
      ...(parsed.note ? { note: parsed.note } : {}),
    });

    if (parsed.decision === "scrap")
      return {
        record: this.terminate(
          projectId,
          parsed.assetId,
          "scrapped",
          /* Honest, not consoling: the credits already spent are gone. */
          `Scrapped after ${creditTotals(withDecision).creditsConsumed} credits.`,
        ),
      };
    if (parsed.decision === "accept")
      return {
        record: this.terminate(
          projectId,
          parsed.assetId,
          "accepted",
          `Accepted at the ${withDecision.stage} stage.`,
        ),
      };

    const stage = ASSET_STAGE_DECISION_STAGES[parsed.decision];
    const round =
      withDecision.runs.filter((run) => run.stage === stage).length + 1;
    return await this.submitStage(projectId, parsed.assetId, stage, round);
  }

  /* ------------------------------- internals ------------------------------ */

  private async submitStage(
    projectId: string,
    assetId: string,
    stage: MeshyStage,
    round: number,
  ): Promise<StagedAssetOutcome> {
    const state = this.state(projectId);
    const config = resolveMeshyConfig(this.repository, state);
    const credits = MESHY_STAGE_CREDITS[stage];
    const idempotencyKey = this.idempotencyKey(
      projectId,
      assetId,
      stage,
      round,
    );
    const prior = this.repository.getSubmissionByKey(idempotencyKey);
    const submission =
      prior ??
      this.repository.recordSubmissionIntent({
        projectId,
        operation: OPERATION_BY_STAGE[stage],
        provider: "meshy",
        idempotencyKey,
        payload: {
          assetId,
          stage,
          round,
          modelVersion: config.modelVersion,
          targetPolycount: config.targetPolycount,
          textureResolution: config.textureResolution,
          pollCount: 0,
        },
      });

    /* Reserve before the call. A task submitted against an exhausted cap is a
       bill Fulcrum cannot refuse after the fact. A live project always has a
       ledger; a replay world runs one only if it was given a cap to rehearse
       against, which is how the accounting gets tested without spending. */
    if (state.mode === "live" || (state.meshyCreditBudget ?? 0) > 0) {
      try {
        this.repository.reserveMeshySubmissionCredits(
          submission.requestId,
          credits,
          CREDIT_LABELS[stage],
        );
      } catch (error) {
        this.repository.updateSubmission(submission.requestId, {
          status: "intent-recorded",
          payload: {
            ...submission.payload,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }

    const submitted = await this.adapterFor(projectId).submit(
      this.submitInput(projectId, assetId, stage, round, config),
    );
    this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      externalJobId: submitted.taskId,
      payload: {
        ...this.repository.getSubmissionByKey(idempotencyKey)!.payload,
        endpoint: submitted.endpoint,
      },
    });

    const startedAt = this.now();
    const record = this.writeRecord(projectId, assetId, (current) => ({
      ...current,
      status: "running",
      stage,
      runs: [
        ...current.runs,
        {
          stage,
          round,
          status: "running",
          progress: 0,
          requestId: submission.requestId,
          externalJobId: submitted.taskId,
          reservedCredits: credits,
          startedAt,
          updatedAt: startedAt,
        },
      ],
      updatedAt: startedAt,
    }));
    this.event(projectId, "asset.stage-started", {
      assetId,
      stage,
      round,
      reservedCredits: credits,
      externalJobId: submitted.taskId,
    });
    return {
      record,
      resumeAfter: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
    };
  }

  private submitInput(
    projectId: string,
    assetId: string,
    stage: MeshyStage,
    round: number,
    config: MeshyConfig,
  ): StagedSubmitInput {
    const shapeSeed = stagedShapeSeed(assetId);
    const planned = this.plannedAsset(projectId, assetId);
    const eligibility = assetRigEligibility(
      planned,
      this.rigEvidence(this.state(projectId), assetId),
    );
    if (stage === "geometry")
      return {
        stage,
        round,
        config,
        shapeSeed,
        images: this.geometryImages(projectId, assetId),
        ...(eligibility.poseMode
          ? { poseMode: eligibility.poseMode }
          : { poseMode: undefined }),
      };

    const record = this.recordFor(projectId, assetId);
    if (stage === "texture") {
      const source = this.sourceRun(record, "geometry");
      return {
        stage,
        round,
        config,
        shapeSeed,
        sourceModel: this.binary(source.model!),
        styleImage: this.textureStyleImage(projectId, assetId),
      };
    }
    if (stage === "rig") {
      if (!eligibility.eligible)
        throw new ProviderPreflightError("payload-invalid", eligibility.reason);
      const source = this.sourceRun(record, "texture");
      return {
        stage,
        round,
        config,
        shapeSeed,
        sourceModel: this.binary(source.model!),
        ...(source.externalJobId ? { sourceTaskId: source.externalJobId } : {}),
      };
    }
    if (!eligibility.eligible)
      throw new ProviderPreflightError("payload-invalid", eligibility.reason);
    const rig = this.sourceRun(record, "rig");
    if (!rig.externalJobId)
      throw new ProviderPreflightError(
        "payload-invalid",
        "Meshy builds an animation clip from a rigging task id, and this rig has none.",
      );
    return { stage, round, config, shapeSeed, rigTaskId: rig.externalJobId };
  }

  /** The most recent successful run of a stage. Its GLB feeds the next one. */
  private sourceRun(
    record: AssetStageRecord,
    stage: MeshyStage,
  ): AssetStageRun {
    const run = [...record.runs]
      .reverse()
      .find(
        (candidate) =>
          candidate.stage === stage &&
          candidate.status === "succeeded" &&
          candidate.model !== undefined,
      );
    if (!run)
      throw new Error(
        `${record.assetId} has no successful ${stage} result to build on.`,
      );
    return run;
  }

  /**
   * Meshy's geometry input, in preference order:
   *
   *  1. The set a human approved in the Images stage. That screen is where
   *     someone looked at four views and said "build this", so anything else
   *     would build something they never saw.
   *  2. A multiview set produced by the older batch flow.
   *  3. The single anchor concept, which is all a project that skipped both
   *     of those has.
   *
   * One image goes to `image-to-3d`, two to four to `multi-image-to-3d`.
   */
  private geometryImages(projectId: string, assetId: string): StagedBinary[] {
    const state = this.state(projectId);
    const approved = this.approvedReferenceSet(projectId, assetId);
    if (approved) {
      const set = approved;
      return inCardinalOrder(set.views).map(({ image }) => this.binary(image));
    }
    const setRevision = state.assetBatch?.[assetId]?.multiviewConceptSet;
    if (setRevision) {
      const set = MultiviewConceptSetSchema.parse(
        this.repository.resolveRevision(setRevision),
      );
      return inCardinalOrder(set.views).map(({ image }) => this.binary(image));
    }
    return [this.binary(this.anchorImage(projectId, assetId))];
  }

  /** Texture reads the exact front image the human approved for geometry. */
  private textureStyleImage(projectId: string, assetId: string): StagedBinary {
    const approved = this.approvedReferenceSet(projectId, assetId);
    const front = approved?.views.find(({ role }) => role === "front");
    return this.binary(front?.image ?? this.anchorImage(projectId, assetId));
  }

  private approvedReferenceSet(
    projectId: string,
    assetId: string,
  ): AssetReferenceSet | undefined {
    const state = this.state(projectId);
    const revision = state.assetReferenceSets?.[assetId];
    if (!revision) return undefined;
    const set = AssetReferenceSetSchema.parse(
      this.repository.resolveRevision(revision),
    );
    if (set.assetId !== assetId)
      throw new Error(
        `Approved references for ${set.assetId} cannot be used by ${assetId}.`,
      );
    return set;
  }

  private binary(artifact: ArtifactRef): StagedBinary {
    return { artifact, bytes: this.repository.readArtifact(artifact) };
  }

  private anchorImage(projectId: string, assetId: string): ArtifactRef {
    const planned = this.plannedAsset(projectId, assetId);
    const source = planned.sourceRefs.conceptSlots[0]?.concept;
    if (!source)
      throw new Error(`Planned asset ${assetId} has no kept concept.`);
    const revision = this.repository.getRevision(source.revisionId);
    if (revision.artifact.sha256 !== source.sha256)
      throw new Error(`Planned asset ${assetId} has stale concept lineage.`);
    return M1ConceptDocumentSchema.parse(
      this.repository.resolveRevision(revision),
    ).image;
  }

  private plannedAsset(projectId: string, assetId: string): PlannedAsset {
    const state = this.state(projectId);
    if (!state.assetPlan)
      throw new Error(`Project ${projectId} has no asset plan.`);
    if (
      !FinalizedAssetPlanBindingSchema.safeParse({
        projectId,
        plan: state.assetPlan,
        finalization: state.assetPlanApproval,
      }).success
    )
      throw new Error(
        "The staged asset gate needs the current finalized asset plan before it can spend.",
      );
    const plan = AssetPlanSchema.parse(
      this.repository.resolveRevision(state.assetPlan),
    );
    return handlingForPlannedAsset(plan, assetId).asset;
  }

  private resolvedOverride(
    state: ProjectState,
    assetId: string,
  ): AssetRigEligibilityOverride | undefined {
    const revision = state.assetRigEligibilityOverrides?.[assetId];
    if (!revision || !state.assetPlan) return undefined;
    const decision = AssetRigEligibilityOverrideSchema.parse(
      this.repository.resolveRevision(revision),
    );
    return decision.sourceAssetPlanRevisionId === state.assetPlan.revisionId
      ? decision
      : undefined;
  }

  private resolvedDetection(
    state: ProjectState,
    assetId: string,
  ): AssetBipedDetection | undefined {
    const revision = state.assetBipedDetections?.[assetId];
    const references = state.assetReferenceSets?.[assetId];
    if (!revision || !references || !state.assetPlan) return undefined;
    const detection = AssetBipedDetectionSchema.parse(
      this.repository.resolveRevision(revision),
    );
    return detection.sourceAssetPlanRevisionId === state.assetPlan.revisionId &&
      detection.sourceReferenceSetRevisionId === references.revisionId
      ? detection
      : undefined;
  }

  private rigEvidence(
    state: ProjectState,
    assetId: string,
  ): AssetRigEligibilityEvidence {
    const override = this.resolvedOverride(state, assetId);
    const detection = this.resolvedDetection(state, assetId);
    return {
      ...(override ? { override } : {}),
      ...(detection ? { detection } : {}),
    };
  }

  private adapterFor(projectId: string): StagedAssetAdapter {
    return this.adapter ?? createStagedAssetAdapter(this.state(projectId).mode);
  }

  private idempotencyKey(
    projectId: string,
    assetId: string,
    stage: MeshyStage,
    round: number,
  ): string {
    return `asset-stage:v1:${projectId}:${assetId}:${stage}:${round}`;
  }

  private state(projectId: string): ProjectState {
    return this.repository.getProject(projectId);
  }

  private recordFor(projectId: string, assetId: string): AssetStageRecord {
    this.plannedAsset(projectId, assetId);
    return (
      this.state(projectId).assetStages?.[assetId] ??
      AssetStageRecordSchema.parse({
        assetId,
        status: "not-started",
        stage: "geometry",
        runs: [],
        decisions: [],
        updatedAt: this.now(),
      })
    );
  }

  private withRun(
    record: AssetStageRecord,
    run: AssetStageRun,
  ): AssetStageRun[] {
    return record.runs.map((candidate) =>
      candidate.stage === run.stage && candidate.round === run.round
        ? run
        : candidate,
    );
  }

  private replaceRun(
    projectId: string,
    assetId: string,
    run: AssetStageRun,
  ): AssetStageRecord {
    return this.writeRecord(projectId, assetId, (current) => ({
      ...current,
      runs: this.withRun(current, run),
      updatedAt: run.updatedAt,
    }));
  }

  private terminate(
    projectId: string,
    assetId: string,
    status: "accepted" | "scrapped",
    reason: string,
  ): AssetStageRecord {
    return this.writeRecord(projectId, assetId, (current) => ({
      ...current,
      status,
      terminalReason: reason,
      updatedAt: this.now(),
    }));
  }

  private writeRecord(
    projectId: string,
    assetId: string,
    update: (current: AssetStageRecord) => AssetStageRecord,
  ): AssetStageRecord {
    const state = this.state(projectId);
    const current =
      state.assetStages?.[assetId] ??
      AssetStageRecordSchema.parse({
        assetId,
        status: "not-started",
        stage: "geometry",
        runs: [],
        decisions: [],
        updatedAt: this.now(),
      });
    const next = AssetStageRecordSchema.parse(update(current));
    this.repository.saveProject({
      ...state,
      assetStages: { ...state.assetStages, [assetId]: next },
    });
    return next;
  }

  private event(
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.repository.appendEvent({
      projectId,
      runId: this.state(projectId).runId,
      type,
      payload,
    });
  }
}
