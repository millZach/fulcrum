import type {
  ConceptSlot,
  InterrogationQuestion,
  InterrogationRound,
  M1ConceptDocument,
  ProjectSnapshot,
  VisualDirection,
} from "@fulcrum/domain";

import { isApiError } from "../api.js";

export type M1StudioScreen =
  | "home"
  | "interrogation"
  | "shared-understanding"
  | "game-design"
  | "visual-direction"
  | "concept-plan"
  | "concept-review"
  | "complete"
  | "blocked";

export type StudioErrorView = {
  message: string;
  budgetRefused: boolean;
};

export type HotbarSlot = {
  key: "pitch" | "brief" | "style" | "images";
  label: string;
  tone: string;
  filled: boolean;
  locked: boolean;
  active: boolean;
  status: string;
};

export const PINNED_ASPECT_OPTIONS = [
  "palette",
  "shape language",
  "lighting",
  "materials",
  "atmosphere",
] as const;

export const SAMPLE_M1_BRIEF =
  "Create a first-person stealth game in a cramped lunar greenhouse. The player cannot use weapons, must escape within eight minutes, and must read colorblind-safe alerts despite near-dark lighting and one pursuing creature.";

export const screenForSnapshot = (
  snapshot: Pick<ProjectSnapshot, "state" | "interrogation">,
): M1StudioScreen => {
  switch (snapshot.state.stage) {
    case "interrogation":
    case "creative-development":
      return (snapshot.interrogation?.frontier.length ?? 0) > 0
        ? "interrogation"
        : "shared-understanding";
    case "game-design-approval":
      return "game-design";
    case "visual-direction-generation":
    case "visual-direction-approval":
      return "visual-direction";
    case "concept-planning":
    case "concept-generation":
      return "concept-plan";
    case "concept-set-approval":
      return "concept-review";
    case "complete":
      return "complete";
    case "blocked":
      return "blocked";
    default:
      return "blocked";
  }
};

export const currentRound = (
  snapshot: Pick<ProjectSnapshot, "interrogation">,
): InterrogationRound | undefined => {
  const rounds = snapshot.interrogation?.rounds ?? [];
  return (
    rounds.find((round) => round.completedAt === undefined) ?? rounds.at(-1)
  );
};

export const completedRounds = (
  snapshot: Pick<ProjectSnapshot, "interrogation">,
): InterrogationRound[] =>
  (snapshot.interrogation?.rounds ?? []).filter(
    (round) => round.completedAt !== undefined,
  );

export type RecordedAnswer = {
  roundId: string;
  question: InterrogationQuestion | undefined;
  value: string;
};

export const recordedAnswers = (
  snapshot: Pick<ProjectSnapshot, "interrogation">,
): RecordedAnswer[] =>
  (snapshot.interrogation?.rounds ?? []).flatMap((round) =>
    round.answers.map((answer) => ({
      roundId: round.roundId,
      question: round.questions.find(
        (question) => question.questionId === answer.questionId,
      ),
      value: answer.value,
    })),
  );

export const directionSha256 = (
  snapshot: Pick<ProjectSnapshot, "visualDirectionRevisions">,
  revisionId: string,
): string | undefined =>
  snapshot.visualDirectionRevisions?.[revisionId]?.artifact.sha256;

export const formatUsd = (amount: number): string => `$${amount.toFixed(2)}`;

export const describeStudioError = (error: unknown): StudioErrorView => {
  const message = error instanceof Error ? error.message : String(error);
  const code = isApiError(error) ? error.code : undefined;
  return {
    message,
    budgetRefused:
      code === "budget-refused" || /budget exhausted/i.test(message),
  };
};

export const liveGeneratingCopy = (mode: "replay" | "live"): string =>
  mode === "live"
    ? "Generating with your OpenAI subscription…"
    : "Building replay concepts…";

export type SlotRevisionView = {
  revisionId: string;
  staleReason: string | undefined;
  document: M1ConceptDocument | undefined;
  label: string;
};

export const slotRevisionViews = (
  snapshot: Pick<ProjectSnapshot, "conceptDocuments">,
  slot: ConceptSlot,
): SlotRevisionView[] => {
  const documents = snapshot.conceptDocuments?.[slot.slotId] ?? [];
  return slot.revisions.map((entry, index) => ({
    revisionId: entry.revision.revisionId,
    staleReason: entry.staleReason,
    document: documents[index],
    label: `r${String(index + 1).padStart(2, "0")}`,
  }));
};

export const allSlotsSelected = (
  snapshot: Pick<ProjectSnapshot, "conceptSet">,
): boolean =>
  (snapshot.conceptSet?.slots.length ?? 0) > 0 &&
  (snapshot.conceptSet?.slots.every((slot) => slot.selectedRevisionId) ??
    false);

export const firstOpenSlotId = (
  snapshot: Pick<ProjectSnapshot, "conceptSet">,
): string | undefined =>
  snapshot.conceptSet?.slots.find((slot) => !slot.selectedRevisionId)?.slotId ??
  snapshot.conceptSet?.slots[0]?.slotId;

/** Default live ImageGen reserve shown next to regenerate. Matches
 *  FULCRUM_SUBSCRIPTION_IMAGE_RESERVE_USD when that env is unset. */
export const IMAGE_RESERVE_USD = 0.01;

export const suggestedNextBudgetUsd = (budgetUsd: number): number =>
  Math.round((budgetUsd + 1) * 100) / 100;

export type BudgetRaisePrompt = {
  spentUsd: number;
  budgetUsd: number;
  suggestedBudgetUsd: number;
};

export const budgetRaisePrompt = (
  snapshot: Pick<ProjectSnapshot, "state">,
): BudgetRaisePrompt => ({
  spentUsd: snapshot.state.spentUsd,
  budgetUsd: snapshot.state.budgetUsd,
  suggestedBudgetUsd: suggestedNextBudgetUsd(snapshot.state.budgetUsd),
});

/** Map a visual-bible palette onto the five positional slots VoxelWorld tints
 *  as ground, wood, stone, accent/glow, ground-alt. */
export const voxelPaletteFromTokens = (
  tokens: ReadonlyArray<{ hex: string }>,
): string[] => {
  const hexes = tokens.map((token) => token.hex);
  if (hexes.length === 0) return [];
  const palette = [...hexes];
  while (palette.length < 5) palette.push(palette.at(-1)!);
  return palette.slice(0, 5);
};

export type VoxelWorldView = {
  styled: boolean;
  palette: string[];
  directionName: string | undefined;
};

export const projectTitle = (
  snapshot: Pick<ProjectSnapshot, "briefText" | "gameDesignSpec">,
): string => snapshot.gameDesignSpec?.title ?? snapshot.briefText;

export const hotbarForSnapshot = (
  snapshot: Pick<
    ProjectSnapshot,
    "state" | "interrogation" | "conceptSet" | "gameDesignSpec"
  >,
): HotbarSlot[] => {
  const screen = screenForSnapshot(snapshot);
  const briefFilled = ![
    "interrogation",
    "shared-understanding",
    "game-design",
  ].includes(screen);
  const styleFilled =
    snapshot.state.directionApproval?.decision === "approved" ||
    ["concept-plan", "concept-review", "complete"].includes(screen);
  const imagesFilled = snapshot.state.stage === "complete";
  const roundCount = snapshot.interrogation?.rounds.length ?? 0;
  const frontier = snapshot.interrogation?.frontier.length ?? 0;
  const kept =
    snapshot.conceptSet?.slots.filter((slot) => slot.selectedRevisionId)
      .length ?? 0;
  const total = snapshot.conceptSet?.slots.length ?? 0;

  return [
    {
      key: "pitch",
      label: "PITCH",
      tone: "wood",
      filled: true,
      locked: false,
      active: false,
      status: snapshot.state.mode === "live" ? "Live" : "Replay",
    },
    {
      key: "brief",
      label: "BRIEF",
      tone: "accent",
      filled: briefFilled,
      locked: false,
      active:
        screen === "interrogation" ||
        screen === "shared-understanding" ||
        screen === "game-design",
      status:
        screen === "interrogation"
          ? `Round ${roundCount} · ${frontier} open`
          : screen === "shared-understanding"
            ? "Ready to confirm"
            : screen === "game-design"
              ? "Spec approval"
              : "Signed off",
    },
    {
      key: "style",
      label: "STYLE",
      tone: "glow",
      filled: styleFilled,
      locked: !briefFilled && screen !== "visual-direction",
      active: screen === "visual-direction",
      status: styleFilled
        ? (snapshot.gameDesignSpec?.title ?? "Loaded")
        : briefFilled
          ? "Choose one"
          : "Needs brief",
    },
    {
      key: "images",
      label: "IMAGES",
      tone: "stone",
      filled: imagesFilled,
      locked:
        !styleFilled &&
        screen !== "concept-plan" &&
        screen !== "concept-review",
      active: screen === "concept-plan" || screen === "concept-review",
      status: imagesFilled
        ? "Approved"
        : total > 0
          ? `${kept} of ${total} kept`
          : styleFilled
            ? "Plan pending"
            : "Needs style",
    },
  ];
};

export const selectedDirection = (
  snapshot: Pick<ProjectSnapshot, "visualDirections" | "state">,
  viewedRevisionId: string | undefined,
): VisualDirection | undefined => {
  const directions = snapshot.visualDirections?.directions;
  if (!directions) return undefined;
  const preferred =
    viewedRevisionId ?? snapshot.state.selectedVisualDirectionRevisionId;
  return (
    directions.find((direction) => direction.revisionId === preferred) ??
    directions[0]
  );
};

export const voxelWorldView = (
  snapshot: Pick<
    ProjectSnapshot,
    "state" | "visualDirections" | "visualBible"
  > | null,
): VoxelWorldView => {
  if (!snapshot || snapshot.state.directionApproval?.decision !== "approved") {
    return { styled: false, palette: [], directionName: undefined };
  }
  const direction = selectedDirection(
    snapshot,
    snapshot.state.selectedVisualDirectionRevisionId,
  );
  const tokens =
    direction?.visualBible.palette ?? snapshot.visualBible?.palette ?? [];
  return {
    styled: tokens.length > 0,
    palette: voxelPaletteFromTokens(tokens),
    directionName: direction?.name ?? snapshot.visualBible?.title,
  };
};

export type MascotView = {
  screen:
    "start" | "question" | "signoff" | "direction" | "concepts" | "package";
  decisions: number;
  visible: boolean;
};

const flag = (on: boolean): 0 | 1 => (on ? 1 : 0);

const mascotScreenFor = (
  studio: M1StudioScreen,
  slotReview: boolean,
): MascotView["screen"] => {
  switch (studio) {
    case "home":
      return "start";
    case "interrogation":
    case "blocked":
      return "question";
    case "shared-understanding":
    case "game-design":
      return "signoff";
    case "visual-direction":
      return "direction";
    case "concept-plan":
      return "concepts";
    case "concept-review":
      return slotReview ? "concepts" : "package";
    case "complete":
      return "package";
  }
};

/** Rusty's corner and how many blocks the diorama has earned.
 *  Count is a pure function of the snapshot so a reload mid-flow rebuilds
 *  the same heap; it never decreases as the flow advances. */
export const mascotForSnapshot = (
  snapshot: Pick<
    ProjectSnapshot,
    "state" | "interrogation" | "conceptSet"
  > | null,
  options: { slotReview?: boolean } = {},
): MascotView => {
  if (!snapshot) {
    return { screen: "start", decisions: 0, visible: true };
  }

  const studio = screenForSnapshot(snapshot);
  const slotReview = options.slotReview === true;
  const selectedSlots =
    snapshot.conceptSet?.slots.filter((slot) => slot.selectedRevisionId)
      .length ?? 0;
  const pastUnderstanding =
    studio === "game-design" ||
    studio === "visual-direction" ||
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "complete";
  const pastGameDesign =
    studio === "visual-direction" ||
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "complete";
  const pastDirection =
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "complete";

  const decisions =
    1 +
    recordedAnswers(snapshot).length +
    flag(
      snapshot.interrogation?.sharedUnderstanding?.confirmed === true ||
        pastUnderstanding,
    ) +
    flag(
      snapshot.state.gameDesignApproval?.decision === "approved" ||
        pastGameDesign,
    ) +
    flag(
      snapshot.state.directionApproval?.decision === "approved" ||
        pastDirection,
    ) +
    selectedSlots +
    flag(
      snapshot.state.conceptSetApproval?.decision === "approved" ||
        studio === "complete",
    );

  const visible =
    studio !== "blocked" && !(studio === "concept-review" && slotReview);

  return {
    screen: mascotScreenFor(studio, slotReview),
    decisions,
    visible,
  };
};
