import type {
  SoundGenerationRunner,
  StructuredModelExecution,
} from "@fulcrum/creative";
import {
  CreateProjectInputSchema,
  hasMeteredRoutes,
  IncreaseBudgetInputSchema,
  type ApprovalInput,
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
      ["asset-planning", "asset-plan-approval", "asset-batch"].includes(
        state.stage,
      )
    ) {
      await this.macro.advance(projectId);
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
    _input: unknown,
  ): Promise<ProjectSnapshot> {
    const state = this.repository.getProject(projectId);
    if (state.milestone !== "m2")
      throw new Error("Only M2 projects have an asset plan.");
    throw new Error(
      "Asset-plan decisions require the S2 planner and approval contract.",
    );
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
