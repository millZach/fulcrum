import type {
  AnswerFrontierRoundInput,
  ApprovalGate,
  ChangeVisualDirectionInput,
  CommitGameNameInput,
  ConfigurationStatus,
  ConfirmConceptPlanInput,
  ConfirmSoundPlanInput,
  ConfirmSharedUnderstandingInput,
  ContinueIntoM2Input,
  CreateProjectInput,
  IncreaseBudgetInput,
  M1ApprovalInput,
  ProjectSnapshot,
  RegenerateConceptInput,
  RegenerateSoundInput,
  ReplaceVisualDirectionInput,
  ReviseGameDesignSpecInput,
  SelectConceptRevisionInput,
  StoredImageAttachment,
  SuggestGameNamesInput,
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

export const advanceProject = (projectId: string): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(`/api/projects/${projectId}/advance`, {
    method: "POST",
  });

export const createM1Project = (
  input: CreateProjectInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>("/api/projects", json({ ...input, milestone: "m1" }));

export const createM2Project = (
  input: CreateProjectInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>("/api/projects", json({ ...input, milestone: "m2" }));

/** Park an image pasted into a text box. Returns the stored ref plus the
 *  project's honest answer about whether a model will ever read it. */
export const storeAttachment = (
  projectId: string,
  dataUrl: string,
): Promise<StoredImageAttachment> =>
  api<StoredImageAttachment>(
    `/api/projects/${projectId}/attachments`,
    json({ dataUrl }),
  );

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

/** Another batch of candidate titles, steered by what the user said about the
 *  last one. Repeatable — that repetition is the conversation. */
export const suggestGameNames = (
  projectId: string,
  input: SuggestGameNamesInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/game-name/suggest`,
    json(input),
  );

/** Settles the name — a proposed one or the user's own — and writes the Game
 *  Design Spec under it. */
export const commitGameName = (
  projectId: string,
  input: CommitGameNameInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/game-name/commit`,
    json(input),
  );

/** Seeds a new M2 world from a finished M1 one and returns the descendant.
 *  The source world is untouched, and the descendant lands at asset planning
 *  with nothing generated. */
export const continueIntoM2 = (
  projectId: string,
  input: ContinueIntoM2Input = {},
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(`/api/projects/${projectId}/continue/m2`, json(input));

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

export const confirmSoundPlan = (
  projectId: string,
  input: ConfirmSoundPlanInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/sound-plan/confirm`,
    json(input),
  );

export const regenerateSound = (
  projectId: string,
  input: RegenerateSoundInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/sounds/${input.slotId}/regenerate`,
    json({
      soundSetRevisionId: input.soundSetRevisionId,
      ...(input.notes ? { notes: input.notes } : {}),
    }),
  );

export const approveSoundSet = (
  projectId: string,
  input: M1ApprovalInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(
    `/api/projects/${projectId}/approvals/sound-set`,
    json(input),
  );

/** Returns a project blocked by a rejection to that gate's review. */
export const reopenApprovalReview = (
  projectId: string,
  gate: ApprovalGate,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(`/api/projects/${projectId}/approvals/${gate}/reopen`, {
    method: "POST",
  });

export const increaseBudget = (
  projectId: string,
  input: IncreaseBudgetInput,
): Promise<ProjectSnapshot> =>
  api<ProjectSnapshot>(`/api/projects/${projectId}/budget`, json(input));

export const m1Projects = (projects: ProjectSnapshot[]): ProjectSnapshot[] =>
  projects.filter((project) => project.state.milestone === "m1");

/** The one world list both studios show. The shell is milestone-aware but not
 *  milestone-exclusive: an M1 world and an M2 world belong to the same person
 *  and the same list, and opening the "wrong" one just mounts the other studio.
 *  M0 predates this shell and has its own screen, so it stays out. */
export const studioProjects = (
  projects: ProjectSnapshot[],
): ProjectSnapshot[] =>
  projects.filter(
    (project) =>
      project.state.milestone === "m1" || project.state.milestone === "m2",
  );

export const m2Projects = (projects: ProjectSnapshot[]): ProjectSnapshot[] =>
  projects.filter((project) => project.state.milestone === "m2");
