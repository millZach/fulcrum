import {
  hasMeteredRoutes,
  type ConceptSlot,
  type InterrogationQuestion,
  type InterrogationRound,
  type M1ConceptDocument,
  type M1InFlightAction,
  type ProjectRouting,
  type ProjectSnapshot,
  type ProviderMode,
  type SoundProvider,
  type VisualDirection,
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
  | "sound-plan"
  | "sound-review"
  | "complete"
  | "blocked";

export type StudioErrorView = {
  kind: "budget" | "quota" | "pinned-aspect" | "in-flight" | "refusal";
  title: string;
  message: string;
  guidance?: string;
  pinnedAspect?: string;
  budgetRefused: boolean;
};

export type ConceptReviewViewState = {
  projectId: string | undefined;
  conceptSetRevisionId: string | undefined;
  inspectingSlotId: string | undefined;
  viewedRevisionId: string | undefined;
  regenNotes: string;
};

export const initialConceptReviewViewState = (): ConceptReviewViewState => ({
  projectId: undefined,
  conceptSetRevisionId: undefined,
  inspectingSlotId: undefined,
  viewedRevisionId: undefined,
  regenNotes: "",
});

/** Keep the concept review's browser-owned state in sync with the loaded
 * project. Snapshot refreshes may advance the set revision, but only a project
 * switch starts a fresh review. */
export const reconcileConceptReviewView = (
  current: ConceptReviewViewState,
  snapshot: {
    state: Pick<ProjectSnapshot["state"], "projectId" | "conceptSet">;
  } | null,
): ConceptReviewViewState => {
  const projectId = snapshot?.state.projectId;
  const conceptSetRevisionId = snapshot?.state.conceptSet?.revisionId;
  if (current.projectId === projectId)
    return current.conceptSetRevisionId === conceptSetRevisionId
      ? current
      : { ...current, conceptSetRevisionId };
  return {
    projectId,
    conceptSetRevisionId,
    inspectingSlotId: undefined,
    viewedRevisionId: undefined,
    regenNotes: "",
  };
};

export type HotbarSlot = {
  key: "pitch" | "brief" | "style" | "images" | "sounds";
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
    case "sound-planning":
    case "sound-generation":
      return "sound-plan";
    case "sound-set-approval":
      return "sound-review";
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
  const budgetRefused =
    code === "budget-refused" || /budget exhausted/i.test(message);
  if (budgetRefused)
    return {
      kind: "budget",
      title: "Budget cap reached",
      message,
      budgetRefused: true,
    };

  const quotaPressure =
    code === "subscription-quota" ||
    /(?:subscription.*(?:quota|rate limit)|\b429\b|too many requests)/i.test(
      message,
    );
  if (quotaPressure)
    return {
      kind: "quota",
      title: "Subscription limit reached",
      message,
      guidance:
        "Wait for the subscription allowance to reset, then try this generation again.",
      budgetRefused: false,
    };

  const pinned = message.match(
    /focused change (?:targets|altered) pinned aspect ([^.]+)\.?/i,
  )?.[1];
  if (pinned) {
    const pinnedAspect = pinned.trim().toLocaleLowerCase("en-US");
    const label = `${pinnedAspect.charAt(0).toUpperCase()}${pinnedAspect.slice(1)}`;
    return {
      kind: "pinned-aspect",
      title: "Focused change not applied",
      message: `${label} changed even though it is pinned, so Fulcrum kept the current direction.`,
      guidance: `Adjust the note or unpin ${pinnedAspect}, then try again. Your note is still here.`,
      pinnedAspect,
      budgetRefused: false,
    };
  }

  const activeAction = message.match(/already processing ([a-z-]+)\.?/i)?.[1];
  if (activeAction) {
    const activities: Record<string, string> = {
      answers: "writing the next interrogation round",
      confirm: "writing the Game Design Spec",
      revise: "revising the Game Design Spec",
      "approve-gds": "creating visual directions",
      replace: "forging the replacement direction",
      change: "applying the focused change",
      generate: "generating concept images",
      regenerate: "regenerating the concept image",
      "generate-sounds": "generating the sound palette",
      "regenerate-sound": "regenerating the sound",
    };
    return {
      kind: "in-flight",
      title: "Previous request still working",
      message: `Fulcrum is still ${activities[activeAction] ?? "working on the previous request"}.`,
      guidance: "Wait for it to finish before starting another request.",
      budgetRefused: false,
    };
  }

  return {
    kind: "refusal",
    title: "The forge refused this step",
    message,
    guidance: "Adjust the request and try again.",
    budgetRefused: false,
  };
};

/** Elapsed wait time as m:ss, so a two-minute spec generation reads as a
 *  clock and not a scary raw number. */
export const formatElapsed = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
};

export type ModelWaitView = {
  /** What Fulcrum is doing right now, in plain words. */
  title: string;
  /** Set-expectation line (real numbers from live runs where we have them). */
  hint: string;
};

/** The studio talks to the coordinator through awaited POSTs, so the `working`
 *  label is the exact in-flight window of every live model call. Map the
 *  labels that sit on a model call to banner copy; fast, model-free mutations
 *  (select, approve-set, raise-budget…) map to nothing. Expectations come from
 *  a real live run: rounds 13–35 s, Game Design Spec 98.8 s, directions
 *  75.9 s. */
export const modelWaitForWorking = (
  working: string,
  mode: ProviderMode,
): ModelWaitView | undefined => {
  const replay = mode !== "live";
  const titles: Record<string, [title: string, liveHint: string]> = {
    create: [
      "Reading your pitch…",
      "Opening interrogation round one · usually 15–40 seconds",
    ],
    answers: [
      "Interrogation round underway…",
      "Fulcrum is writing the next round · usually 15–40 seconds",
    ],
    confirm: [
      "Writing the Game Design Spec…",
      "Turning your answers into the spec · usually 1–2 minutes",
    ],
    revise: [
      "Rewriting the Game Design Spec…",
      "Folding your change in · this can take 1–2 minutes",
    ],
    "approve-gds": [
      "Inventing visual directions…",
      "Three distinct looks for your world · usually 1–2 minutes",
    ],
    replace: [
      "Forging a replacement direction…",
      "One new look, same spec · this can take 1–2 minutes",
    ],
    change: [
      "Applying your focused change…",
      "Re-rendering the chosen look · this can take 1–2 minutes",
    ],
    generate: [
      "Generating concept images…",
      "Building the approved concept set · this can take a few minutes",
    ],
    regenerate: [
      "Regenerating the concept image…",
      "Building one focused revision · this can take a few minutes",
    ],
    "plan-assets": [
      "Planning the asset batch…",
      "Turning the approved concept set into a production plan · this can take a few minutes",
    ],
    "replan-assets": [
      "Revising the asset plan…",
      "Applying the requested planning changes · this can take a few minutes",
    ],
    "generate-sounds": [
      "Generating the sound palette…",
      "Rendering the approved sound set · this can take a few minutes",
    ],
    "regenerate-sound": [
      "Regenerating the sound…",
      "Rendering one focused sound revision · this can take a few minutes",
    ],
  };
  const entry = titles[working];
  if (!entry) return undefined;
  return {
    title: entry[0],
    hint: replay ? "Replay is offline · this stays quick" : entry[1],
  };
};

export type SnapshotModelWait = {
  action: M1InFlightAction;
  startedAt: string;
  banner: ModelWaitView | undefined;
};

export const modelWaitForSnapshot = (
  snapshot: Pick<ProjectSnapshot, "state" | "inFlight">,
): SnapshotModelWait | undefined => {
  if (!snapshot.inFlight) return undefined;
  return {
    action: snapshot.inFlight.action,
    startedAt: snapshot.inFlight.startedAt,
    banner: modelWaitForWorking(snapshot.inFlight.action, snapshot.state.mode),
  };
};

export const liveGeneratingCopy = (mode: "replay" | "live"): string =>
  mode === "live"
    ? "Generating with your OpenAI subscription…"
    : "Building replay concepts…";

export const liveSoundGeneratingCopy = (mode: "replay" | "live"): string =>
  mode === "live"
    ? "Generating sound effects…"
    : "Building replay sound palette…";

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

/** Default live ElevenLabs SFX reserve. Matches
 *  FULCRUM_ELEVENLABS_SFX_COST_USD when that env is unset. */
export const SOUND_RESERVE_USD = 0.05;

export const routingCostNote = (routing: ProjectRouting): string => {
  if (routing.mode === "replay")
    return "Replay and local generators use no metered services.";
  if (
    routing.orchestratorProvider === "openai" &&
    routing.implementationProvider === "openai" &&
    (routing.imageProvider === "openai-subscription" ||
      routing.imageProvider === "none") &&
    routing.soundProvider === "none"
  )
    return "Runs on your OpenAI subscription · no metered spend.";
  return "Runs on subscription and local routes · no metered spend.";
};

export const soundRouteLabel = (routing: {
  mode: ProviderMode;
  soundProvider: SoundProvider;
}): string => {
  if (routing.soundProvider === "elevenlabs")
    return "ElevenLabs · text-to-sound";
  return routing.mode === "replay"
    ? "Replay · deterministic WAV"
    : "None · deterministic WAV";
};

export const showsMeteredBudget = (routing: ProjectRouting): boolean =>
  hasMeteredRoutes(routing);

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
    [
      "concept-plan",
      "concept-review",
      "sound-plan",
      "sound-review",
      "complete",
    ].includes(screen);
  const imagesFilled =
    snapshot.state.conceptSetApproval?.decision === "approved" ||
    ["sound-plan", "sound-review", "complete"].includes(screen);
  const soundsFilled = snapshot.state.stage === "complete";
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
    {
      key: "sounds",
      label: "SOUNDS",
      tone: "wood",
      filled: soundsFilled,
      locked:
        !imagesFilled && screen !== "sound-plan" && screen !== "sound-review",
      active: screen === "sound-plan" || screen === "sound-review",
      status: soundsFilled
        ? "Approved"
        : screen === "sound-review"
          ? "Playback"
          : screen === "sound-plan"
            ? "Palette pending"
            : imagesFilled
              ? "Plan pending"
              : "Needs images",
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

/* ---------- choreography: how the diorama earns its blocks ----------
   The world's shown level is gated behind Rusty's walk-and-place: a decision
   recorded on the coordinator only *queues* a performance, and the block
   lands on the grid when he sets it down. This step function decides, for
   one snapshot-to-snapshot transition, whether the world snaps to the truth
   instantly (reload, project switch) or earns it one placed block at a
   time. */

export type ChoreographyState = {
  projectId: string | undefined;
  decisions: number;
};

export type ChoreographyStep =
  /** Nothing changed — leave the shown level and the queue alone. */
  | { kind: "none" }
  /** Render the truth immediately: a reload or project switch must not replay
   *  old choreography, and a decision count that went down must clamp. */
  | { kind: "sync" }
  /** Queue this many trips. stride "level" advances the shown world one
   *  level per placement (the interrogation build log); stride "all" snaps
   *  to the full truth on the single placement (every other screen keeps
   *  the prototype's collapse-the-backlog behavior). */
  | { kind: "trips"; count: number; stride: "level" | "all" };

export const choreographyStep = (
  prev: ChoreographyState,
  next: ChoreographyState & { screen: M1StudioScreen },
  maxLevel: number,
): ChoreographyStep => {
  if (prev.projectId !== next.projectId) return { kind: "sync" };
  if (next.decisions < prev.decisions) return { kind: "sync" };
  if (next.decisions === prev.decisions) return { kind: "none" };
  if (next.screen !== "interrogation")
    return { kind: "trips", count: 1, stride: "all" };
  /* One trip per level the diorama can actually grow by; decisions past the
     blueprint's cap collapse into a single trip so a four-answer round on a
     finished world does not queue four pointless walks. */
  const count = Math.max(
    Math.min(next.decisions, maxLevel) - Math.min(prev.decisions, maxLevel),
    1,
  );
  return { kind: "trips", count, stride: "level" };
};

/** Give every queued visible-level trip its own watchdog window. Placements
 *  re-run this calculation, so the delay shrinks with the remaining queue. */
export const choreographySafetyDelay = (
  shown: number,
  decisions: number,
  maxLevel: number,
): number | undefined => {
  if (shown >= decisions) return undefined;
  const visibleTrips =
    Math.min(decisions, maxLevel) - Math.min(shown, maxLevel);
  return Math.max(visibleTrips, 1) * 24_000;
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
    case "sound-plan":
      return "concepts";
    case "sound-review":
      return "package";
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
    studio === "sound-plan" ||
    studio === "sound-review" ||
    studio === "complete";
  const pastGameDesign =
    studio === "visual-direction" ||
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "sound-plan" ||
    studio === "sound-review" ||
    studio === "complete";
  const pastDirection =
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "sound-plan" ||
    studio === "sound-review" ||
    studio === "complete";
  const pastConcepts =
    studio === "sound-plan" ||
    studio === "sound-review" ||
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
        pastConcepts,
    ) +
    flag(
      snapshot.state.soundSetApproval?.decision === "approved" ||
        studio === "complete",
    );

  /* game-design is a full-width reading screen: no world panel, no Rusty —
     the spec gets the whole stage (data-mascot="off" pattern). */
  const visible =
    studio !== "blocked" &&
    studio !== "game-design" &&
    !(studio === "concept-review" && slotReview);

  return {
    screen: mascotScreenFor(studio, slotReview),
    decisions,
    visible,
  };
};
