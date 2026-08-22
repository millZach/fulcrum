import type {
  AnswerFrontierRoundInput,
  ChangeVisualDirectionInput,
  ConfigurationStatus,
  ConfirmConceptPlanInput,
  ConfirmSharedUnderstandingInput,
  CreateProjectInput,
  IncreaseBudgetInput,
  M1ApprovalInput,
  ProjectSnapshot,
  RegenerateConceptInput,
  ReplaceVisualDirectionInput,
  ReviseGameDesignSpecInput,
  SelectConceptRevisionInput,
} from "@fulcrum/domain";

import { api } from "./api.js";

const json = (value: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(value),
});

export const getConfiguration = (): Promise<ConfigurationStatus> =>
  api<ConfigurationStatus>("/api/configuration");

export const listProjects = (): Promise<ProjectSnapshot[]> =>
  api<ProjectSnapshot[]>("/api/projects");

export const getProject = (projectId: string): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(`/api/projects/${projectId}`);

export const createM1Project = (
  input: CreateProjectInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>("/api/projects", json({ ...input, milestone: "m1" }));

export const answerFrontier = (
  projectId: string,
  input: AnswerFrontierRoundInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/interrogation/answers`,
    json(input),
  );

export const confirmSharedUnderstanding = (
  projectId: string,
  input: ConfirmSharedUnderstandingInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/interrogation/confirm`,
    json(input),
  );

export const approveGameDesign = (
  projectId: string,
  input: M1ApprovalInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/approvals/game-design`,
    json(input),
  );

export const reviseGameDesign = (
  projectId: string,
  input: ReviseGameDesignSpecInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/game-design/revise`,
    json(input),
  );

export const replaceDirection = (
  projectId: string,
  input: ReplaceVisualDirectionInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/directions/${input.directionRevisionId}/replace`,
    json({
      directionSetRevisionId: input.directionSetRevisionId,
      notes: input.notes,
    }),
  );

export const changeDirection = (
  projectId: string,
  input: ChangeVisualDirectionInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/directions/${input.directionRevisionId}/change`,
    json({
      directionSetRevisionId: input.directionSetRevisionId,
      change: input.change,
      pinnedAspects: input.pinnedAspects,
    }),
  );

export const approveVisualDirection = (
  projectId: string,
  input: M1ApprovalInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/approvals/visual-direction`,
    json(input),
  );

export const confirmConceptPlan = (
  projectId: string,
  input: ConfirmConceptPlanInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/concept-plan/confirm`,
    json(input),
  );

export const regenerateConcept = (
  projectId: string,
  input: RegenerateConceptInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/concepts/${input.slotId}/regenerate`,
    json({
      conceptSetRevisionId: input.conceptSetRevisionId,
      ...(input.notes ? { notes: input.notes } : {}),
    }),
  );

export const selectConcept = (
  projectId: string,
  input: SelectConceptRevisionInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/concepts/${input.slotId}/select`,
    json({
      conceptSetRevisionId: input.conceptSetRevisionId,
      conceptRevisionId: input.conceptRevisionId,
    }),
  );

export const approveConceptSet = (
  projectId: string,
  input: M1ApprovalInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/approvals/concept-set`,
    json(input),
  );

export const increaseBudget = (
  projectId: string,
  input: IncreaseBudgetInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(`/api/projects/${projectId}/budget`, json(input));

export const m1Projects = (projects: ProjectSnapshot[]): ProjectSnapshot[] =>
  projects.filter((project) => project.state.milestone === "m1");
