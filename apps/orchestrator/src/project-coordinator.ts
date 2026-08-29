import type {
  SoundGenerationRunner,
  StructuredModelExecution,
} from "@fulcrum/creative";
import {
  AmendAssetPlanInputSchema,
  approvalGateBlock,
  CreateProjectInputSchema,
  hasMeteredRoutes,
  IncreaseBudgetInputSchema,
  ReopenApprovalReviewInputSchema,
  type ApprovalInput,
  type CreateProjectInput,
  type ProjectSnapshot,
} from "@fulcrum/domain";
import type {
  ExecutionProviderStatus,
  StructuredVisionExecution,
  SubscriptionImageRunner,
} from "@fulcrum/execution";
import {
  AssetPlanAmender,
  type AssetPlanAmending,
  type StagedAssetAdapter,
} from "@fulcrum/production";
import { ProjectRepository } from "@fulcrum/project";

import { M0Coordinator } from "./coordinator.js";
import {
  PostConceptGraphDriver,
  createAutomaticAssetPlanFinalization,
} from "./macro-graph.js";
import { CreativeFrontCoordinator, M1Coordinator } from "./m1-coordinator.js";
import type { M2MacroGraphSlots } from "./macro-operations.js";

export type ProjectCoordinatorOptions = {
  imageRunner?: SubscriptionImageRunner;
  execution?: StructuredModelExecution;
  soundRunner?: SoundGenerationRunner;
  m2Slots?: M2MacroGraphSlots;
  stagedAssetAdapter?: StagedAssetAdapter;
  stagedVisionExecution?: StructuredVisionExecution;
  stagedVisionProviderStatuses?: ExecutionProviderStatus[];
};

/** Routes a project to its milestone-specific state machine. */
export class ProjectCoordinator {
  readonly m0: M0Coordinator;
  readonly creative: CreativeFrontCoordinator;
  readonly m1: M1Coordinator;
  readonly macro: PostConceptGraphDriver;
  readonly assetPlanAmender: AssetPlanAmending;

  constructor(
    readonly repository: ProjectRepository,
    options: ProjectCoordinatorOptions = {},
  ) {
    this.macro = new PostConceptGraphDriver(repository, {
      ...(options.m2Slots ? { slots: options.m2Slots } : {}),
    });
    this.m0 = new M0Coordinator(repository, this.macro);
    this.creative = new CreativeFrontCoordinator(repository, options);
    this.m1 = this.creative;
    this.assetPlanAmender = new AssetPlanAmender(repository, options.execution);
  }

  configuration() {
    return this.m0.configuration();
  }

  async create(input: CreateProjectInput): Promise<ProjectSnapshot> {
    const parsed = CreateProjectInputSchema.parse(input);
    return parsed.milestone === "m1" || parsed.milestone === "m2"
      ? await this.creative.create(parsed)
      : await this.m0.create(parsed);
  }

  snapshot(projectId: string): ProjectSnapshot {
    return this.isCreative(projectId)
      ? this.creative.snapshot(projectId)
      : this.m0.snapshot(projectId);
  }

  list(): ProjectSnapshot[] {
    return this.repository
      .listProjects()
      .map(({ projectId }) => this.snapshot(projectId));
  }

  async amendAssetPlan(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = AmendAssetPlanInputSchema.parse(input);
    const result = await this.assetPlanAmender.amend({ projectId, ...parsed });
    const state = this.repository.getProject(projectId);
    if (
      state.assetPlan?.revisionId !== result.fromRevision.revisionId ||
      state.assetPlan?.artifact.sha256 !== result.fromRevision.artifact.sha256
    )
      throw new Error(
        "The asset plan changed before the amendment could be finalized. The new revision was not applied.",
      );
    const finalization = createAutomaticAssetPlanFinalization(
      projectId,
      result.toRevision,
    );
    this.repository.commitApproval({
      decision: finalization,
      nextState: {
        ...state,
        assetPlan: result.toRevision,
        assetPlanApproval: finalization,
      },
      event: {
        runId: state.runId,
        type: "asset-plan.amended",
        payload: {
          section: parsed.section,
          request: parsed.request,
          fromRevisionId: result.fromRevision.revisionId,
          toRevisionId: result.toRevision.revisionId,
          addedAssetIds: result.addedAssetIds,
          changedAssetIds: result.changedAssetIds,
          removedAssetIds: result.removedAssetIds,
          decidedBy: finalization.decidedBy,
          targetSha256: finalization.targetSha256,
        },
      },
    });
    return this.snapshot(projectId);
  }

  /* The staged asset gate. Deliberately four separate entry points rather than
     one overloaded `advance`: three of them spend credits, and a route that can
     spend should never be reachable by accident. */

  async startAssetStage(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    return await this.creative.startAssetStage(projectId, input);
  }

  async pollAssetStage(
    projectId: string,
    assetId: string,
  ): Promise<ProjectSnapshot> {
    return await this.creative.pollAssetStage(projectId, assetId);
  }

  async decideAssetStage(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    return await this.creative.decideAssetStage(projectId, input);
  }

  updateMeshyConfig(projectId: string, input: unknown): ProjectSnapshot {
    return this.creative.updateMeshyConfig(projectId, input);
  }

  /** Free: it persists what a human approved, and spends nothing. */
  async storeAssetReferences(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    return await this.creative.storeAssetReferences(projectId, input);
  }

  async detectAssetBiped(
    projectId: string,
    assetId: string,
  ): Promise<ProjectSnapshot> {
    return await this.creative.detectAssetBiped(projectId, assetId);
  }

  overrideAssetRigEligibility(
    projectId: string,
    input: unknown,
  ): ProjectSnapshot {
    return this.creative.overrideAssetRigEligibility(projectId, input);
  }

  async advance(projectId: string): Promise<ProjectSnapshot> {
    const state = this.repository.getProject(projectId);
    if (state.milestone === "m0") return await this.m0.advance(projectId);
    if (
      state.milestone === "m2" &&
      (["asset-planning", "asset-plan-approval", "asset-batch"].includes(
        state.stage,
      ) ||
        (state.status === "blocked" &&
          state.blockedReason?.recoverable === true &&
          !approvalGateBlock(state)))
    ) {
      await this.macro.advance(projectId, "explicit-advance");
      return this.snapshot(projectId);
    }
    return this.creative.advance(projectId);
  }

  /**
   * Returns a project blocked by a rejection to that gate's review, with its
   * revisions intact. This never generates anything: the human re-reviews and
   * decides again.
   */
  reopenApprovalReview(projectId: string, input: unknown): ProjectSnapshot {
    const parsed = ReopenApprovalReviewInputSchema.parse(input);
    if (parsed.gate === "asset-plan")
      throw new Error(
        "Asset plans finalize automatically and have no review gate to reopen.",
      );
    const state = this.repository.getProject(projectId);
    const block = approvalGateBlock(state);
    if (state.status !== "blocked" || !block)
      throw new Error("This project has no rejected approval to reopen.");
    if (block.gate !== parsed.gate)
      throw new Error(
        `This project is blocked at the ${block.gate} gate, not ${parsed.gate}.`,
      );
    this.repository.saveProject({
      ...state,
      status: "awaiting-approval",
      stage: block.reviewStage,
      blockedReason: undefined,
    });
    this.repository.appendEvent({
      projectId,
      runId: state.runId,
      type: "approval.review-reopened",
      payload: {
        gate: block.gate,
        stage: block.reviewStage,
        blockedReasonCode: state.blockedReason?.code ?? null,
      },
    });
    return this.snapshot(projectId);
  }

  async approveDirection(
    projectId: string,
    input: ApprovalInput | unknown,
  ): Promise<ProjectSnapshot> {
    return this.isCreative(projectId)
      ? await this.creative.approveDirection(projectId, input)
      : await this.m0.approveDirection(projectId, input as ApprovalInput);
  }

  async approveConceptSet(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const state = this.repository.getProject(projectId);
    if (state.milestone === "m0")
      throw new Error("M0 has no concept-set approval stage.");
    const snapshot = this.creative.approveConceptSet(projectId, input);
    if (
      snapshot.state.milestone === "m2" &&
      snapshot.state.stage === "asset-planning"
    ) {
      await this.macro.advance(projectId, "approval-recorded");
      return this.snapshot(projectId);
    }
    return snapshot;
  }

  approveSlice(projectId: string, input: ApprovalInput): ProjectSnapshot {
    if (this.isM1(projectId))
      throw new Error("M1 ends at sound-set approval and has no visual slice.");
    return this.m0.approveSlice(projectId, input);
  }

  storeReviewImage(projectId: string, dataUrl: string): ProjectSnapshot {
    if (this.isM1(projectId))
      throw new Error("M1 does not produce a 3D scene review image.");
    return this.m0.storeReviewImage(projectId, dataUrl);
  }

  increaseBudget(projectId: string, input: unknown): ProjectSnapshot {
    const parsed = IncreaseBudgetInputSchema.parse(input);
    const state = this.repository.getProject(projectId);
    const recoverableBudgetBlock =
      state.stage === "blocked" &&
      state.blockedReason?.code === "budget-refused" &&
      state.blockedReason.recoverable;
    if (
      state.stage === "complete" ||
      (state.stage === "blocked" && !recoverableBudgetBlock)
    )
      throw new Error(
        "A completed or blocked project cannot raise its budget unless it has a recoverable budget refusal.",
      );
    if (parsed.meshyCreditBudget !== undefined) {
      if (
        state.milestone !== "m2" ||
        state.mode !== "live" ||
        state.assetProvider !== "meshy"
      )
        throw new Error(
          "Only a live M2 Meshy project has a Meshy credit budget.",
        );
      const currentCredits = state.meshyCreditBudget ?? 0;
      if (parsed.meshyCreditBudget <= currentCredits)
        throw new Error(
          `The new Meshy credit budget must exceed the current ${currentCredits}-credit cap.`,
        );
      this.repository.saveProject({
        ...state,
        meshyCreditBudget: parsed.meshyCreditBudget,
        meshyCreditsReserved: state.meshyCreditsReserved ?? 0,
        meshyCreditsConsumed: state.meshyCreditsConsumed ?? 0,
      });
      this.repository.appendEvent({
        projectId,
        runId: state.runId,
        type: "meshy-credits.budget-increased",
        payload: {
          previousBudgetCredits: currentCredits,
          budgetCredits: parsed.meshyCreditBudget,
        },
      });
      return this.snapshot(projectId);
    }

    if (state.milestone === "m1" && !hasMeteredRoutes(state))
      throw new Error("This project has no metered routes to budget.");
    const budgetUsd = parsed.budgetUsd!;
    if (!(budgetUsd > state.budgetUsd))
      throw new Error(
        `The new budget must be greater than the current $${state.budgetUsd.toFixed(2)} cap.`,
      );
    const previousBudgetUsd = state.budgetUsd;
    this.repository.saveProject({
      ...state,
      budgetUsd,
    });
    this.repository.appendEvent({
      projectId,
      runId: state.runId,
      type: "budget.increased",
      payload: { previousBudgetUsd, budgetUsd },
    });
    return this.snapshot(projectId);
  }

  private isM1(projectId: string): boolean {
    return this.repository.getProject(projectId).milestone === "m1";
  }

  private isCreative(projectId: string): boolean {
    return this.repository.getProject(projectId).milestone !== "m0";
  }
}
