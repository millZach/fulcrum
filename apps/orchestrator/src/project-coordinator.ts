import { randomUUID } from "node:crypto";

import type {
  SoundGenerationRunner,
  StructuredModelExecution,
} from "@fulcrum/creative";
import {
  AssetPlanApprovalInputSchema,
  CreateProjectInputSchema,
  hasMeteredRoutes,
  IncreaseBudgetInputSchema,
  type ApprovalInput,
  type AssetPlanApprovalInput,
  type ApprovalDecision,
  type CreateProjectInput,
  type ProjectSnapshot,
} from "@fulcrum/domain";
import type { SubscriptionImageRunner } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";

import { M0Coordinator } from "./coordinator.js";
import { PostConceptGraphDriver } from "./macro-graph.js";
import { CreativeFrontCoordinator, M1Coordinator } from "./m1-coordinator.js";
import type { M2MacroGraphSlots } from "./macro-operations.js";

export type ProjectCoordinatorOptions = {
  imageRunner?: SubscriptionImageRunner;
  execution?: StructuredModelExecution;
  soundRunner?: SoundGenerationRunner;
  m2Slots?: M2MacroGraphSlots;
};

/** Routes a project to its milestone-specific state machine. */
export class ProjectCoordinator {
  readonly m0: M0Coordinator;
  readonly creative: CreativeFrontCoordinator;
  readonly m1: M1Coordinator;
  readonly macro: PostConceptGraphDriver;

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

  async advance(projectId: string): Promise<ProjectSnapshot> {
    const state = this.repository.getProject(projectId);
    if (state.milestone === "m0") return await this.m0.advance(projectId);
    if (
      state.milestone === "m2" &&
      (["asset-planning", "asset-plan-approval", "asset-batch"].includes(
        state.stage,
      ) ||
        (state.status === "blocked" &&
          state.blockedReason?.recoverable === true))
    ) {
      await this.macro.advance(projectId, "explicit-advance");
      return this.snapshot(projectId);
    }
    return this.creative.advance(projectId);
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

  async decideAssetPlan(
    projectId: string,
    input: AssetPlanApprovalInput | unknown,
  ): Promise<ProjectSnapshot> {
    const state = this.repository.getProject(projectId);
    if (state.milestone !== "m2")
      throw new Error("Only M2 projects have an asset plan.");
    if (state.stage !== "asset-plan-approval")
      throw new Error("This project is not in the asset-plan-approval stage.");
    if (!state.assetPlan) throw new Error("The project has no asset plan.");
    const parsed = AssetPlanApprovalInputSchema.parse(input);
    if (
      parsed.targetRevisionId !== state.assetPlan.revisionId ||
      parsed.targetSha256 !== state.assetPlan.artifact.sha256
    )
      throw new Error(
        "The approval target does not match the current immutable revision.",
      );
    if (
      parsed.decision === "changes-requested" &&
      (state.assetPlanReplanCount ?? 0) >= 1
    ) {
      const blocked = this.repository.saveProject({
        ...state,
        status: "blocked",
        stage: "blocked",
        blockedReason: {
          code: "asset-plan-replan-limit",
          message: "M2 permits one asset-plan replan.",
          recoverable: false,
          failureKind: "policy-blocked",
        },
      });
      this.repository.appendEvent({
        projectId,
        runId: state.runId,
        type: "asset-plan.failed",
        payload: {
          requestId: `asset-plan-replan-limit:${state.assetPlan.revisionId}`,
          failureCode: "asset-plan-replan-limit",
          kind: "policy-blocked",
          issueCodes: [],
        },
      });
      return this.snapshot(blocked.projectId);
    }
    const decision: ApprovalDecision = {
      approvalId: randomUUID(),
      projectId,
      targetType: "asset-plan",
      targetRevisionId: parsed.targetRevisionId,
      targetSha256: parsed.targetSha256,
      decision: parsed.decision,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
      decidedBy: "local-user",
      decidedAt: new Date().toISOString(),
    };
    const event = {
      runId: state.runId,
      type: "approval.asset-plan-decided",
      payload: {
        approvalId: decision.approvalId,
        decision: decision.decision,
        targetRevisionId: decision.targetRevisionId,
        targetSha256: decision.targetSha256,
      },
    };
    if (decision.decision === "rejected") {
      this.repository.commitApproval({
        decision,
        nextState: {
          ...state,
          assetPlanApproval: decision,
          status: "blocked",
          stage: "blocked",
          blockedReason: {
            code: "asset-plan-not-approved",
            message: "The asset plan was rejected.",
            recoverable: false,
            failureKind: "policy-blocked",
          },
        },
        event,
      });
      return this.snapshot(projectId);
    }
    if (decision.decision === "changes-requested") {
      this.repository.commitApproval({
        decision,
        nextState: {
          ...state,
          assetPlanApproval: decision,
          status: "active",
          stage: "asset-planning",
        },
        event,
      });
      await this.macro.advance(projectId, "approval-recorded");
      return this.snapshot(projectId);
    }
    this.repository.commitApproval({
      decision,
      nextState: {
        ...state,
        assetPlanApproval: decision,
        status: "active",
        stage: "asset-plan-approval",
      },
      event,
    });
    await this.macro.advance(projectId, "approval-recorded");
    return this.snapshot(projectId);
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
    if (state.stage === "complete" || state.stage === "blocked")
      throw new Error(
        "A completed or blocked project cannot raise its budget.",
      );
    if (state.milestone === "m1" && !hasMeteredRoutes(state))
      throw new Error("This project has no metered routes to budget.");
    if (!(parsed.budgetUsd > state.budgetUsd))
      throw new Error(
        `The new budget must be greater than the current $${state.budgetUsd.toFixed(2)} cap.`,
      );
    const previousBudgetUsd = state.budgetUsd;
    this.repository.saveProject({
      ...state,
      budgetUsd: parsed.budgetUsd,
    });
    this.repository.appendEvent({
      projectId,
      runId: state.runId,
      type: "budget.increased",
      payload: { previousBudgetUsd, budgetUsd: parsed.budgetUsd },
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
