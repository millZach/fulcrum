import {
  CreateProjectInputSchema,
  IncreaseBudgetInputSchema,
  type ApprovalInput,
  type CreateProjectInput,
  type ProjectSnapshot,
} from "@fulcrum/domain";
import type { SubscriptionImageRunner } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";

import { M0Coordinator } from "./coordinator.js";
import { M1Coordinator } from "./m1-coordinator.js";

export type ProjectCoordinatorOptions = {
  imageRunner?: SubscriptionImageRunner;
};

/** Routes a project to its milestone-specific state machine. */
export class ProjectCoordinator {
  readonly m0: M0Coordinator;
  readonly m1: M1Coordinator;

  constructor(
    readonly repository: ProjectRepository,
    options: ProjectCoordinatorOptions = {},
  ) {
    this.m0 = new M0Coordinator(repository);
    this.m1 = new M1Coordinator(repository, options);
  }

  configuration() {
    return this.m0.configuration();
  }

  async create(input: CreateProjectInput): Promise<ProjectSnapshot> {
    const parsed = CreateProjectInputSchema.parse(input);
    return parsed.milestone === "m1"
      ? await this.m1.create(parsed)
      : await this.m0.create(parsed);
  }

  snapshot(projectId: string): ProjectSnapshot {
    return this.isM1(projectId)
      ? this.m1.snapshot(projectId)
      : this.m0.snapshot(projectId);
  }

  list(): ProjectSnapshot[] {
    return this.repository
      .listProjects()
      .map(({ projectId }) => this.snapshot(projectId));
  }

  async advance(projectId: string): Promise<ProjectSnapshot> {
    return this.isM1(projectId)
      ? this.m1.advance(projectId)
      : await this.m0.advance(projectId);
  }

  async approveDirection(
    projectId: string,
    input: ApprovalInput | unknown,
  ): Promise<ProjectSnapshot> {
    return this.isM1(projectId)
      ? await this.m1.approveDirection(projectId, input)
      : await this.m0.approveDirection(projectId, input as ApprovalInput);
  }

  approveSlice(projectId: string, input: ApprovalInput): ProjectSnapshot {
    if (this.isM1(projectId))
      throw new Error(
        "M1 ends at concept-set approval and has no visual slice.",
      );
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
}
