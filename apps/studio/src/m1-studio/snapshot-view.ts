import {
  approvalGateBlock,
  attachmentsReachOrchestrator,
  MAX_IMAGE_ATTACHMENTS,
  projectNeedsBudget,
  type ApprovalGate,
  type ArtifactRef,
  type ConceptSlot,
  type CreateProjectInput,
  type InterrogationQuestion,
  type InterrogationRound,
  type M1ConceptDocument,
  type M1InFlightAction,
  type ProjectBudgetRouting,
  type ProjectRouting,
  type ProjectSnapshot,
  type ProjectStage,
  type ProjectStatus,
  type ProviderMode,
  type ExecutionProvider,
  type SoundProvider,
  type VisualDirection,
} from "@fulcrum/domain";

import { isApiError } from "../api.js";

export type M1StudioScreen =
  | "home"
  | "interrogation"
  | "shared-understanding"
  | "game-name"
  | "game-design"
  | "visual-direction"
  | "concept-plan"
  | "concept-review"
  | "sound-plan"
  | "sound-review"
  | "asset-planning"
  | "asset-batch"
  | "complete"
  | "blocked";

/* ---------- the shared status formatter ----------
   One place turns `{ stage, status }` into a written label and a tone. It
   lives here, beside the rail's own model, so the header pill, the world
   cards and the hotbar tiles read the same source and can never disagree
   about what "blocked" is called or what colour it wears. */

export type StudioStatusTone = "running" | "attention" | "blocked" | "done";

export interface StudioStatus {
  /** Written label for the stage — never a raw enum. */
  label: string;
  /** Who the project is waiting on, which is what carries the colour. */
  tone: StudioStatusTone;
  /** Micro-caps word for the tone, and the spoken prefix for the pill. */
  toneLabel: string;
}

/** Every stage the coordinator can report, written the way a person would say
 *  it. Approval stages stay descriptive ("Visual direction review") because the
 *  "who is waiting" half of the message is carried by the tone, not the words —
 *  a stage can be mid-generation and post-generation under the same name. */
const STAGE_LABELS: Record<ProjectStage, string> = {
  "creative-development": "Creative development",
  interrogation: "Interrogation",
  "game-design-approval": "Game design review",
  "visual-direction-generation": "Generating directions",
  "visual-direction-approval": "Visual direction review",
  "concept-planning": "Concept planning",
  "concept-generation": "Generating concepts",
  "concept-set-approval": "Concept set review",
  "sound-planning": "Sound planning",
  "sound-generation": "Generating sound",
  "sound-set-approval": "Sound set review",
  "asset-planning": "Asset planning",
  "asset-plan-approval": "Finalizing asset plan",
  "asset-batch": "Asset batch",
  "asset-production": "Producing assets",
  "asset-quality": "Asset quality",
  "scene-composition": "Scene composition",
  "visual-slice-approval": "Visual slice review",
  complete: "Complete",
  blocked: "Blocked",
};

const STATUS_TONES: Record<ProjectStatus, StudioStatusTone> = {
  active: "running",
  "awaiting-input": "attention",
  "awaiting-approval": "attention",
  blocked: "blocked",
  complete: "done",
};

const TONE_LABELS: Record<StudioStatusTone, string> = {
  running: "Running",
  attention: "Needs you",
  blocked: "Blocked",
  done: "Done",
};

/** "visual-slice-approval" -> "Visual slice approval". The fallback for an
 *  enum member this build has never heard of, so a newer coordinator degrades
 *  to readable prose instead of shouting kebab-case at the user. */
const humaniseEnum = (value: string): string => {
  const [first, ...rest] = value.split("-").filter(Boolean);
  if (first === undefined) return "Unknown";
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
};

/** THE shared status formatter. One place turns `{ stage, status }` into the
 *  label and tone, so the header and the world cards can never disagree about
 *  what "blocked" looks like or what it is called. */
export const studioStatus = (state: {
  stage: string;
  status: string;
}): StudioStatus => {
  const label =
    (STAGE_LABELS as Record<string, string | undefined>)[state.stage] ??
    humaniseEnum(state.stage);
  const tone: StudioStatusTone =
    state.stage === "blocked"
      ? "blocked"
      : ((STATUS_TONES as Record<string, StudioStatusTone | undefined>)[
          state.status
        ] ?? (state.stage.endsWith("-approval") ? "attention" : "running"));
  return { label, tone, toneLabel: TONE_LABELS[tone] };
};

/** The world card's meta line. One list now carries both milestones, so the
 *  card says which studio a world belongs to before it says anything else —
 *  the CSS micro-caps it, so this reads "M2 · LIVE · BLOCKED". */
export const worldCardMeta = (state: {
  milestone: string;
  mode: string;
  stage: string;
  status: string;
}): string =>
  `${state.milestone} · ${state.mode} · ${studioStatus(state).label}`;

/** Where a world of the other milestone actually lives. `milestone` is a
 *  mount-time prop, so the only honest way to open an M2 world from the M1
 *  studio is to navigate: the correct studio then mounts with the project
 *  already selected. Every other query param on the page is preserved. */
export const studioHrefForProject = (
  href: string,
  state: { milestone: string; projectId: string },
): string => {
  const url = new URL(href);
  url.searchParams.set("studio", state.milestone);
  url.searchParams.set("project", state.projectId);
  return url.toString();
};

export type StudioErrorView = {
  kind:
    | "budget"
    | "meshy-credits"
    | "quota"
    | "pinned-aspect"
    | "in-flight"
    | "refusal";
  title: string;
  message: string;
  guidance?: string;
  pinnedAspect?: string;
  /** A USD spend cap stopped the run: the raise-USD-budget retry applies. */
  budgetRefused: boolean;
  /** The Meshy credit cap stopped the run: the raise-credit-cap retry
   *  applies. Raising dollars here would do nothing. */
  creditsRefused: boolean;
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
  key: "pitch" | "brief" | "style" | "images" | "sounds" | "assets";
  label: string;
  tone: string;
  filled: boolean;
  locked: boolean;
  active: boolean;
  /** The stage the project died on. The rail's fourth tier — a blocked stage
   *  must not look like an unstarted one. */
  blocked: boolean;
  status: string;
  /** Set only on the tile that stands for where the project is right now, and
   *  taken straight from `studioStatus` — the same value the header pill and
   *  the world cards wear, so the rail cannot contradict them. */
  statusTone?: StudioStatusTone;
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
      if ((snapshot.interrogation?.frontier.length ?? 0) > 0)
        return "interrogation";
      /* The naming conversation is the tail of the BRIEF stage, after the
         signoff and before the spec — the same place the signoff screen sits,
         and for the same reason: it is the last thing the interview owes. */
      return snapshot.state.gameNameCandidates && !snapshot.state.gameName
        ? "game-name"
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
    case "asset-planning":
      return "asset-planning";
    case "asset-plan-approval":
      return "asset-batch";
    case "asset-batch":
      return "asset-batch";
    case "complete":
      return "complete";
    case "blocked":
      return "blocked";
    default:
      return "blocked";
  }
};

/* ---------- who owns an M2 world's screen ----------

   Two screens can claim an M2 world that already has a plan: the asset gate,
   which owns the whole Images-and-Meshy flow, and the ordinary stage switch,
   which owns planning. The gate used to win unconditionally, which meant a
   replan — plan still in state, stage back at `asset-planning` — rendered the
   old inventory while the batch itself was being rewritten. Planning is the
   one stage the gate does not own. */

export type AssetFlowOwner = "gate" | "stage";

export const assetFlowOwner = (
  snapshot: Pick<ProjectSnapshot, "state" | "assetPlan">,
): AssetFlowOwner =>
  snapshot.state.milestone === "m2" &&
  snapshot.assetPlan &&
  snapshot.state.stage !== "asset-planning"
    ? "gate"
    : "stage";

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
  attachments: ArtifactRef[];
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
      attachments: answer.attachments ?? [],
    })),
  );

/* ---------- pasted images ----------

   An image pasted into a text box is always kept. Whether a model ever looks
   at it depends on the project's own routing, and the studio says which of
   the two happened rather than letting a thumbnail imply vision the route
   does not have. */

export const ACCEPTED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** The image entries in a clipboard payload, in paste order. Typed
 *  structurally so the rule is testable without a browser. */
export const pastedImageItems = <T extends { kind: string; type: string }>(
  items: readonly T[],
): T[] =>
  items.filter(
    (item) =>
      item.kind === "file" &&
      (ACCEPTED_ATTACHMENT_TYPES as readonly string[]).includes(item.type),
  );

/** True when the same paste also carries text the box should still receive.
 *  A screenshot on its own does not, so the paste is consumed; a payload that
 *  has both keeps the ordinary text paste and attaches the picture too. */
export const clipboardCarriesText = <T extends { kind: string; type: string }>(
  items: readonly T[],
): boolean =>
  items.some((item) => item.kind === "string" && item.type === "text/plain");

/** How many of `incoming` fit alongside `existing`. Never negative. */
export const attachmentRoom = (existing: number): number =>
  Math.max(0, MAX_IMAGE_ATTACHMENTS - existing);

export const attachmentLimitMessage = (): string =>
  `An answer can carry at most ${MAX_IMAGE_ATTACHMENTS} images. Remove one to paste another.`;

/** The one sentence under a text box that says where its images go.
 *  `subject` names what they are attached to — an answer on the grilling
 *  screen, a steer on the naming screen. */
export const attachmentDeliveryNote = (
  routing: {
    mode: ProviderMode;
    orchestratorProvider: ExecutionProvider;
  },
  subject = "this answer",
): string => {
  if (attachmentsReachOrchestrator(routing))
    return `Sent to ${routing.orchestratorProvider} with ${subject}.`;
  if (routing.mode === "replay")
    return `Replay world: saved with ${subject}, but no model reads it.`;
  return `The ${routing.orchestratorProvider} orchestrator route is text-only here: saved with ${subject}, but not read.`;
};

export const directionSha256 = (
  snapshot: Pick<ProjectSnapshot, "visualDirectionRevisions">,
  revisionId: string,
): string | undefined =>
  snapshot.visualDirectionRevisions?.[revisionId]?.artifact.sha256;

export const formatUsd = (amount: number): string => `$${amount.toFixed(2)}`;

/** Two different caps refuse through one code.
 *
 *  `ProjectRepository.reserveBudget` (USD) and
 *  `ProjectRepository.reserveMeshyCredits` (Meshy credits) both throw
 *  `ProviderPreflightError("budget-refused", …)`, and the orchestrator
 *  forwards that single code to the browser. The code alone therefore cannot
 *  say which cap ran out, and the recoveries are not interchangeable: raising
 *  dollars never buys a Meshy credit. The messages are the only signal that
 *  survives the wire, and they are minted in exactly one place each:
 *
 *    USD     "Budget exhausted: <label> requires $x.xx, but only $y.yy remains."
 *    credits "Meshy credit budget exhausted: <label> requires N credits, but M remain."
 *
 *  so the credit sentence is matched first and the USD sentence is what is
 *  left. Anything else that merely mentions a budget is not a refusal at all
 *  and falls through to the generic refusal view. */
export const budgetRefusalKind = (
  error: unknown,
): "usd" | "meshy-credits" | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  if (/meshy credit budget exhausted/i.test(message)) return "meshy-credits";
  const code = isApiError(error) ? error.code : undefined;
  if (/\bbudget exhausted\b/i.test(message)) return "usd";
  if (code === "budget-refused")
    return /meshy credit/i.test(message) ? "meshy-credits" : "usd";
  return undefined;
};

export const describeStudioError = (error: unknown): StudioErrorView => {
  const message = error instanceof Error ? error.message : String(error);
  const refusal = budgetRefusalKind(error);
  if (refusal === "meshy-credits")
    return {
      kind: "meshy-credits",
      title: "Meshy credit cap reached",
      message,
      guidance:
        "Raise this world's Meshy credit cap and retry. The same asset resumes and is not paid for twice. Your USD budget is not what ran out.",
      budgetRefused: false,
      creditsRefused: true,
    };
  if (refusal === "usd")
    return {
      kind: "budget",
      title: "Budget cap reached",
      message,
      budgetRefused: true,
      creditsRefused: false,
    };

  const code = isApiError(error) ? error.code : undefined;
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
      creditsRefused: false,
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
      creditsRefused: false,
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
      creditsRefused: false,
    };
  }

  return {
    kind: "refusal",
    title: "The forge refused this step",
    message,
    guidance: "Adjust the request and try again.",
    budgetRefused: false,
    creditsRefused: false,
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
      "Naming your game…",
      "Reading the brief for titles that fit · usually 15–40 seconds",
    ],
    "suggest-names": [
      "Rethinking the name…",
      "A fresh batch shaped by your feedback · usually 15–40 seconds",
    ],
    "name-game": [
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

/** Where "Continue" lands after `keptSlotId` is kept: the next slot after it
 *  with nothing kept yet, else any earlier open slot, else `undefined` for the
 *  package screen. Reviewing an already-kept slot out of order used to pin the
 *  review to that slot, so Continue re-selected the same revision and the
 *  screen never moved. */
export const nextReviewSlotId = (
  snapshot: Pick<ProjectSnapshot, "conceptSet">,
  keptSlotId: string,
): string | undefined => {
  const slots = snapshot.conceptSet?.slots ?? [];
  const kept = slots.findIndex((slot) => slot.slotId === keptSlotId);
  const open = (slot: (typeof slots)[number]) => !slot.selectedRevisionId;
  return (
    slots.slice(kept + 1).find(open)?.slotId ??
    slots.slice(0, Math.max(kept, 0)).find(open)?.slotId
  );
};

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

/** The USD cap offered on the create form when the chosen routing forces one.
 *
 *  Budget policy is metered-routes-only: subscription and local routes are
 *  never billed against a cap, so a project on those routes is created with
 *  no `budgetUsd` at all and simply reports what it spends. The moment a
 *  metered route is picked, `CreateProjectInputSchema` hard-requires a
 *  positive number (`projectNeedsBudget`), so "no cap" is not expressible for
 *  that shape and the form has to offer one. It offers a number that survives
 *  a real run — the live reserves are $0.25 a text call, $0.20–0.25 an image
 *  and $0.05 a vision pass, so a batch is tens of calls — rather than the old
 *  $1 seed, which was under four calls and was submitted while hidden behind
 *  the M2 credit field. */
export const DEFAULT_METERED_BUDGET_USD = 25;

export const showsMeteredBudget = (routing: ProjectBudgetRouting): boolean =>
  routing.mode === "live" && projectNeedsBudget(routing);

export const showsMeshyCreditBudget = (routing: {
  milestone: "m0" | "m1" | "m2";
  mode: ProviderMode;
}): boolean => routing.milestone === "m2" && routing.mode === "live";

export const studioCreateProjectInput = ({
  brief,
  budgetUsd,
  meshyCreditBudget,
  ...routing
}: ProjectBudgetRouting & {
  brief: string;
  budgetUsd: number;
  meshyCreditBudget?: number;
}): CreateProjectInput => ({
  ...routing,
  brief: brief.trim(),
  ...(showsMeteredBudget(routing) ? { budgetUsd } : {}),
  ...(showsMeshyCreditBudget(routing)
    ? { meshyCreditBudget: meshyCreditBudget ?? 300 }
    : {}),
  rightsConfirmed: true,
});

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

/** One first-pass static Meshy 6 asset is 20 credits of geometry plus 10 of
 *  4K texturing, so the smallest raise that buys anything is 30. */
export const MESHY_CREDIT_RAISE_STEP = 30;

export const suggestedNextMeshyCredits = (budgetCredits: number): number =>
  budgetCredits + MESHY_CREDIT_RAISE_STEP;

export type MeshyCreditRaisePrompt = {
  usedCredits: number;
  reservedCredits: number;
  budgetCredits: number;
  suggestedBudgetCredits: number;
};

export const meshyCreditRaisePrompt = (
  snapshot: Pick<ProjectSnapshot, "state">,
): MeshyCreditRaisePrompt => {
  const budgetCredits = snapshot.state.meshyCreditBudget ?? 0;
  return {
    usedCredits: snapshot.state.meshyCreditsConsumed ?? 0,
    reservedCredits: snapshot.state.meshyCreditsReserved ?? 0,
    budgetCredits,
    suggestedBudgetCredits: suggestedNextMeshyCredits(budgetCredits),
  };
};

/** Which cap a *blocked* project ran out of.
 *
 *  Same conflation as `budgetRefusalKind`, one layer further on: the stored
 *  `blockedReason.code` is "budget-refused" for both caps, and the blocked
 *  screen used to guess from the project's routing instead — so a live M2
 *  Meshy world that hit its USD cap was offered a credit field that could not
 *  unblock it. The stored message is the same sentence the refusal threw, so
 *  it answers the question directly. */
export const blockedBudgetKind = (
  reason: { code?: string; message?: string } | undefined,
): "usd" | "meshy-credits" | undefined => {
  if (reason?.code !== "budget-refused") return undefined;
  return /meshy credit/i.test(reason.message ?? "") ? "meshy-credits" : "usd";
};

/* ---------- a rejection is a paused decision, not a dead world ----------
   Rejecting at a gate parks the project on the blocked screen, which was
   written for failures: a reason code, a sentence about the forge stopping,
   and — when the block happened to be recoverable — one "Resume project"
   button that says nothing about what resuming would do. A user who rejected
   their own concept package read that as the end of the world.

   The coordinator already knows better: `approvalGateBlock` reports the gate a
   rejection can be returned to, and reopening it is a no-spend action that puts
   the same revisions back in front of the user. This is the copy for that,
   written per gate so the headline names the thing the user actually rejected
   and the body names the choices waiting on the other side. */

export type ReviewGateRescue = {
  gate: ApprovalGate;
  /** The decision the user made, in their own words. */
  headline: string;
  /** What reopening does — and, explicitly, what it does not cost. */
  body: string;
  /** The primary button. */
  actionLabel: string;
};

const REVIEW_GATE_RESCUE: Record<
  Exclude<ApprovalGate, "asset-plan">,
  Omit<ReviewGateRescue, "gate">
> = {
  "game-design": {
    headline: "You rejected the Game Design Spec.",
    body: "Reopen the review to approve it, request changes, or reject it again. Nothing is generated or spent by reopening.",
    actionLabel: "Reopen game design review",
  },
  "visual-direction": {
    headline: "You rejected the visual direction.",
    body: "Reopen the review to choose another look, replace one, or approve. Nothing is generated or spent by reopening.",
    actionLabel: "Reopen visual direction review",
  },
  "concept-set": {
    headline: "You rejected the concept package.",
    body: "Reopen the review to keep, swap, or re-judge the concepts. Nothing is generated or spent by reopening.",
    actionLabel: "Reopen concept set review",
  },
  "sound-set": {
    headline: "You rejected the sound palette.",
    body: "Reopen the review to replay the clips, regenerate a slot, or approve. Nothing is generated or spent by reopening.",
    actionLabel: "Reopen sound set review",
  },
};

/** The rescue a blocked project is owed, or `undefined` when the block is a
 *  real failure (a credit cap, a hard error) and the existing presentation is
 *  the right one. */
export const reviewGateRescue = (
  state: Pick<
    ProjectSnapshot["state"],
    "milestone" | "status" | "blockedReason"
  >,
): ReviewGateRescue | undefined => {
  const block = approvalGateBlock(state);
  if (!block || block.gate === "asset-plan") return undefined;
  return { gate: block.gate, ...REVIEW_GATE_RESCUE[block.gate] };
};

/* ---------- stepping back through the rail ----------
   The hotbar was a readout: every tile shipped `disabled`, so a user who had
   signed the brief off could not look at it again without reloading the world
   from a URL. Completed tiles are navigable now, and the two pure questions —
   "which tiles can be stepped into?" and "what does a step into this one
   show?" — live here.

   Stepping back never mutates: the screen it opens is rendered read-only and
   the coordinator is not told about it at all. */

export type HotbarStageKey = HotbarSlot["key"];

export type HotbarNavSlot = HotbarSlot & {
  /** true when this tile can be clicked: history, or "now" itself. */
  navigable: boolean;
  /** true when this tile's record is the one on the stage. */
  viewing: boolean;
};

/** The tile that stands for where the project is right now. `undefined` on a
 *  finished world, where every tile is history. */
export const currentStageKey = (
  slots: HotbarSlot[],
): HotbarStageKey | undefined =>
  slots.find((slot) => slot.blocked || slot.active)?.key;

/** Past and present tiles are navigable; the future is not. A locked tile is
 *  a stage the project never reached, so it stays inert wherever it sits. */
export const hotbarNavigation = (
  slots: HotbarSlot[],
  viewedStage: HotbarStageKey | undefined,
): HotbarNavSlot[] => {
  const current = slots.findIndex((slot) => slot.blocked || slot.active);
  /* No current tile means the world is finished: everything behind it is
     history, so nothing is in the future. */
  const now = current < 0 ? slots.length : current;
  return slots.map((slot, at) => ({
    ...slot,
    navigable: at <= now && !slot.locked,
    viewing: viewedStage !== undefined && viewedStage === slot.key,
  }));
};

/** The written name of a stage, for the history banner. */
export const HOTBAR_STAGE_LABELS: Record<HotbarStageKey, string> = {
  pitch: "Pitch",
  brief: "Brief",
  style: "Color & mood",
  images: "Images",
  sounds: "Sounds",
  assets: "Assets",
};

export type StageHistoryScreen =
  /** The pitch is not a screen of its own — it is the brief text and the
   *  routing the world was created with, which is all the snapshot keeps. */
  | "pitch-record"
  | "shared-understanding"
  | "game-design"
  | "visual-direction"
  | "concept-review"
  | "sound-review"
  /** The stage is behind the project, but its artifacts are not in this
   *  snapshot — say so rather than rendering a screen with nothing in it. */
  | "unavailable";

/** What a step back into `key` can actually show, given what this snapshot
 *  still carries. Everything here is a presence check: a screen is only
 *  offered when the record it reads is in the snapshot. */
export const stageHistoryScreen = (
  snapshot: Pick<
    ProjectSnapshot,
    | "interrogation"
    | "gameDesignSpec"
    | "visualDirections"
    | "conceptSet"
    | "soundSet"
  >,
  key: HotbarStageKey,
): StageHistoryScreen => {
  switch (key) {
    case "pitch":
      return "pitch-record";
    case "brief":
      return snapshot.gameDesignSpec
        ? "game-design"
        : snapshot.interrogation
          ? "shared-understanding"
          : "unavailable";
    case "style":
      return (snapshot.visualDirections?.directions.length ?? 0) > 0
        ? "visual-direction"
        : "unavailable";
    case "images":
      return (snapshot.conceptSet?.slots.length ?? 0) > 0
        ? "concept-review"
        : "unavailable";
    case "sounds":
      return (snapshot.soundSet?.slots.length ?? 0) > 0
        ? "sound-review"
        : "unavailable";
    case "assets":
      return "unavailable";
  }
};

/** History screens that host themselves in the concept column, so the shell
 *  can pick the same wrapper it picks for the live screen.
 *
 *  The two record cards belong here too: `.concept-complete` is a dark-theme
 *  class in the base sheet and only the `.voxel-concept-host` descendant rules
 *  repaint it for this skin, so a card rendered outside the host arrives as
 *  near-black text on near-black paper. */
export const stageHistoryUsesConceptHost = (
  screen: StageHistoryScreen,
): boolean =>
  screen === "concept-review" ||
  screen === "sound-review" ||
  screen === "pitch-record" ||
  screen === "unavailable";

/* ---------- the spend meter ----------
   A cap is a picture, not a sentence: a solid run of what is already spent, a
   hatched run of what is committed but not yet billed, and the empty remainder
   that is still yours. The written half is only the number that answers "can I
   keep going" — what is left — and the full accounting rides in the aria-label
   so the meter is not a worse readout for a screen reader than the string it
   replaced. */

export type SpendMeterTone = "steady" | "attention" | "alert";

export type SpendMeterView = {
  /** Percentage of the track drawn solid: already billed. */
  usedPercent: number;
  /** Percentage drawn hatched, starting where the solid run ends. */
  reservedPercent: number;
  /** used + reserved over the cap, 0–1, clamped. */
  committedRatio: number;
  tone: SpendMeterTone;
  /** The short label beside the track: "60 credits left". */
  label: string;
  /** The whole picture in words, for `aria-label`. */
  ariaLabel: string;
};

/** Amber once three quarters of the cap is committed, alert red past nine
 *  tenths — the same two thresholds the header pill and the world cards use,
 *  so one glance means one thing everywhere. */
const spendMeterTone = (committedRatio: number): SpendMeterTone =>
  committedRatio > 0.9
    ? "alert"
    : committedRatio > 0.75
      ? "attention"
      : "steady";

const spendMeterView = (input: {
  total: number;
  used: number;
  reserved: number;
  /** One bare quantity: `12` -> "12", `1.5` -> "$1.50". */
  format: (value: number) => string;
  /** Appended to the remainder and the cap. " credits", or "" for dollars. */
  unit: string;
  /** What the meter is about, spoken first in the aria-label. */
  noun: string;
}): SpendMeterView => {
  const total = Math.max(0, input.total);
  /* Clamped, because reconciliation can transiently report more committed
     than the cap and a 140% track is not a picture of anything. */
  const used = Math.max(0, Math.min(input.used, total));
  const reserved = Math.max(0, Math.min(input.reserved, total - used));
  const remaining = total - used - reserved;
  const percent = (value: number): number =>
    total === 0 ? 0 : (value / total) * 100;
  const committedRatio =
    total === 0 ? 1 : Math.min(1, (input.used + input.reserved) / total);
  const said = (value: number): string => `${input.format(value)}${input.unit}`;
  return {
    usedPercent: percent(used),
    reservedPercent: percent(reserved),
    committedRatio,
    tone: spendMeterTone(committedRatio),
    label: `${said(remaining)} left`,
    ariaLabel: `${input.noun}: ${input.format(used)} used${
      reserved > 0 ? `, ${input.format(reserved)} reserved` : ""
    }, ${said(remaining)} left of ${said(total)}.`,
  };
};

/** `undefined` when the world has no credit cap recorded — the caller says
 *  "Meshy credit cap required" rather than drawing an empty track. */
export const meshyCreditMeterView = (
  state: Pick<
    ProjectSnapshot["state"],
    "meshyCreditBudget" | "meshyCreditsReserved" | "meshyCreditsConsumed"
  >,
): SpendMeterView | undefined => {
  if (state.meshyCreditBudget === undefined) return undefined;
  return spendMeterView({
    total: state.meshyCreditBudget,
    used: state.meshyCreditsConsumed ?? 0,
    reserved: state.meshyCreditsReserved ?? 0,
    format: (value) => `${Math.round(value)}`,
    unit: " credits",
    noun: "Meshy credits",
  });
};

/** The dollar twin, for a metered-route world. `spentUsd` is money already
 *  committed, so there is no separate reserved run to hatch. */
export const usdSpendMeterView = (
  state: Pick<ProjectSnapshot["state"], "budgetUsd" | "spentUsd">,
): SpendMeterView | undefined => {
  if (!(state.budgetUsd > 0)) return undefined;
  return spendMeterView({
    total: state.budgetUsd,
    used: state.spentUsd,
    reserved: 0,
    format: formatUsd,
    unit: "",
    noun: "Metered spend",
  });
};

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

/** The decided name outranks the spec title: the user chose it, and it is
 *  what the spec is titled with anyway. The brief only stands in until a
 *  world has been named. */
export const projectTitle = (
  snapshot: Pick<ProjectSnapshot, "briefText" | "gameDesignSpec" | "gameName">,
): string =>
  snapshot.gameName?.name ??
  snapshot.gameDesignSpec?.title ??
  snapshot.briefText;

/** `stage: "blocked"` does not record where the run died, so the rail infers
 *  it: the furthest stage the project actually reached is the last slot that is
 *  unlocked and not yet done. That slot carries the alert tier; every other
 *  slot keeps its own state. */
const markBlockedSlot = (
  slots: HotbarSlot[],
  status: StudioStatus,
): HotbarSlot[] => {
  if (status.tone !== "blocked") return slots;
  const index = slots.reduce(
    (furthest, slot, at) => (!slot.locked && !slot.filled ? at : furthest),
    -1,
  );
  if (index < 0) return slots;
  return slots.map((slot, at) =>
    at === index ? { ...slot, blocked: true, active: false } : slot,
  );
};

/** The rail's current tile answers the same question as the header pill —
 *  "who is this waiting on?" — so it takes the shared formatter's tone rather
 *  than inferring one from its own data attributes. Done and not-yet tiles are
 *  history and future; they stay neutral. */
const withSharedStatusTone = (
  slots: HotbarSlot[],
  status: StudioStatus,
): HotbarSlot[] => {
  const current = slots.findIndex((slot) => slot.blocked || slot.active);
  if (current < 0) return slots;
  return slots.map((slot, at) =>
    at === current ? { ...slot, statusTone: status.tone } : slot,
  );
};

const finishRail = (slots: HotbarSlot[], status: StudioStatus): HotbarSlot[] =>
  withSharedStatusTone(markBlockedSlot(slots, status), status);

export const hotbarForSnapshot = (
  snapshot: Pick<
    ProjectSnapshot,
    "state" | "interrogation" | "conceptSet" | "gameDesignSpec"
  >,
): HotbarSlot[] => {
  const screen = screenForSnapshot(snapshot);
  const status = studioStatus(snapshot.state);
  const briefFilled = ![
    "interrogation",
    "shared-understanding",
    "game-name",
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

  const common: HotbarSlot[] = [
    {
      key: "pitch",
      label: "PITCH",
      tone: "wood",
      filled: true,
      locked: false,
      active: false,
      blocked: false,
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
        screen === "game-name" ||
        screen === "game-design",
      blocked: false,
      status:
        screen === "interrogation"
          ? `Round ${roundCount} · ${frontier} open`
          : screen === "shared-understanding"
            ? "Ready to confirm"
            : screen === "game-name"
              ? "Naming the game"
              : screen === "game-design"
                ? "Spec approval"
                : "Signed off",
    },
    {
      key: "style",
      label: "COLOR & MOOD",
      tone: "glow",
      filled: styleFilled,
      locked: !briefFilled && screen !== "visual-direction",
      active: screen === "visual-direction",
      blocked: false,
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
      blocked: false,
      status: imagesFilled
        ? "Approved"
        : total > 0
          ? `${kept} of ${total} kept`
          : styleFilled
            ? "Plan pending"
            : "Needs color & mood",
    },
    {
      key: "sounds",
      label: "SOUNDS",
      tone: "wood",
      filled: soundsFilled,
      locked:
        !imagesFilled && screen !== "sound-plan" && screen !== "sound-review",
      active: screen === "sound-plan" || screen === "sound-review",
      blocked: false,
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
  if (snapshot.state.milestone !== "m2") return finishRail(common, status);

  const assetEntries = Object.values(snapshot.state.assetBatch ?? {});
  const validated = assetEntries.filter((entry) => entry.validated).length;
  const assetStatus =
    screen === "asset-planning"
      ? "Planning batch"
      : screen === "asset-batch"
        ? assetEntries.length > 0
          ? `${validated} of ${assetEntries.length} validated`
          : "Resolving assets"
        : screen === "complete"
          ? `${validated} of ${assetEntries.length} validated`
          : screen === "blocked"
            ? "Blocked"
            : "Needs images";

  return finishRail(
    [
      ...common.slice(0, 4),
      {
        key: "assets",
        label: "ASSETS",
        tone: "wood",
        filled: screen === "complete",
        locked:
          !imagesFilled && !["asset-planning", "asset-batch"].includes(screen),
        active: ["asset-planning", "asset-batch"].includes(screen),
        blocked: false,
        status: assetStatus,
      },
    ],
    status,
  );
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
    case "game-name":
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
    case "asset-planning":
    case "asset-batch":
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
    studio === "asset-planning" ||
    studio === "asset-batch" ||
    studio === "complete";
  const pastGameDesign =
    studio === "visual-direction" ||
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "sound-plan" ||
    studio === "sound-review" ||
    studio === "asset-planning" ||
    studio === "asset-batch" ||
    studio === "complete";
  const pastDirection =
    studio === "concept-plan" ||
    studio === "concept-review" ||
    studio === "sound-plan" ||
    studio === "sound-review" ||
    studio === "asset-planning" ||
    studio === "asset-batch" ||
    studio === "complete";
  const pastConcepts =
    studio === "sound-plan" ||
    studio === "sound-review" ||
    studio === "asset-planning" ||
    studio === "asset-batch" ||
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

/* === Color & Mood: the model's strings as marks ============================
   Everything on the Color & Mood screen except three equal swatches used to be
   prose, so choosing between three visual directions was a reading task. The
   helpers below encode the model's own strings as marks — swatch width from the
   colour's stated job, gradient strips for light and air, tinted material
   chips, a silhouette family for shape language — and pull the blocks the
   directions state identically out of the tabs.

   Every mapping is a keyword heuristic over the model's vocabulary. Nothing
   here knows this project's palette; an unrecognised vocabulary degrades to
   the plain text row it replaced. All of it is pure, which is why it lives
   here and not in the component that draws it.
   ========================================================================= */

export type MoodBible = VisualDirection["visualBible"];
export type MoodPaletteToken = MoodBible["palette"][number];

const MOOD_PAPER = "#fbf8ef";
export const MOOD_INK = "#16161d";

function moodHexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/** `hex` moved `amount` (0–1) of the way toward `toward`. */
function moodMix(hex: string, toward: string, amount: number): string {
  const from = moodHexToRgb(hex);
  const to = moodHexToRgb(toward);
  const channel = (index: 0 | 1 | 2): number =>
    Math.round(from[index] + (to[index] - from[index]) * amount);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/** Perceived brightness 0–1; orders a palette shadow → key light. */
function moodLuminance(hex: string): number {
  const [r, g, b] = moodHexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/* A colour's role is a free-text string from the model ("primary mass",
   "edge separation", "gameplay focus"). Words that mean "this covers the
   frame" size the swatch up, words that mean "this is a spot of it" size it
   down, and anything unrecognised keeps the middle weight — so a palette
   whose roles we cannot read still renders as the old equal strip. */
const MOOD_DOMINANT_ROLE_WORDS = [
  "primary",
  "dominant",
  "mass",
  "base",
  "body",
  "bulk",
  "ground",
  "field",
  "backdrop",
  "background",
  "structure",
];
const MOOD_MINOR_ROLE_WORDS = [
  "accent",
  "focus",
  "highlight",
  "pop",
  "signal",
  "spark",
  "detail",
  "trim",
  "marker",
  "emissive",
  "glow",
];

export function moodPaletteWeight(role: string): number {
  const text = role.toLowerCase();
  const hits = (words: string[]): boolean =>
    words.some((word) => text.includes(word));
  if (hits(MOOD_DOMINANT_ROLE_WORDS)) return 4;
  if (hits(MOOD_MINOR_ROLE_WORDS)) return 1.4;
  return 2.2;
}

/** Lighting reads as a ramp: the direction's own colours, shadow → key. */
export function moodLightingGradient(palette: MoodPaletteToken[]): string {
  const stops = [...palette]
    .sort((a, b) => moodLuminance(a.hex) - moodLuminance(b.hex))
    .map((token) => token.hex);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Atmosphere is the same colours seen through air: brightest first, every
    stop pulled toward the lightest one, so it reads as haze not as key. */
export function moodAtmosphereGradient(palette: MoodPaletteToken[]): string {
  const sorted = [...palette].sort(
    (a, b) => moodLuminance(b.hex) - moodLuminance(a.hex),
  );
  const lightest = sorted[0]?.hex ?? MOOD_PAPER;
  const stops = sorted.map((token) => moodMix(token.hex, lightest, 0.45));
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** A material chip wearing its palette colour: a wash of it for the fill, a
    darkened version of it for the border, ink for the label. */
export function moodChipStyle(hex: string): {
  background: string;
  borderColor: string;
} {
  return {
    background: moodMix(hex, MOOD_PAPER, 0.84),
    borderColor: moodMix(hex, MOOD_INK, 0.45),
  };
}

/* Shape language is one sentence of form vocabulary. Curvature words and
   edge words are counted; the winner picks one of three silhouette trios,
   an explicit "mix" word (or a tie) picks the mixed trio, and a sentence
   with no form vocabulary at all falls back to the plain text row. */
const MOOD_ROUNDED_SHAPE_WORDS = [
  "round",
  "curv",
  "soft",
  "organic",
  "arch",
  "dome",
  "bulb",
  "pill",
  "smooth",
  "oval",
  "blob",
  "taper",
  "swell",
  "billow",
];
const MOOD_ANGULAR_SHAPE_WORDS = [
  "angular",
  "wedge",
  "sharp",
  "facet",
  "geometric",
  "blocky",
  "chisel",
  "shard",
  "diagonal",
  "jagged",
  "prism",
  "crystal",
  "slab",
  "hard",
];
const MOOD_MIXED_SHAPE_WORDS = [
  "mixed",
  "blend",
  "combination",
  "contrast",
  "asymmetric",
  "varied",
  "alternat",
];

export type MoodShapeFamily = "rounded" | "angular" | "mixed";

export function moodShapeFamily(text: string): MoodShapeFamily | undefined {
  const value = text.toLowerCase();
  const count = (words: string[]): number =>
    words.filter((word) => value.includes(word)).length;
  const rounded = count(MOOD_ROUNDED_SHAPE_WORDS);
  const angular = count(MOOD_ANGULAR_SHAPE_WORDS);
  if (rounded === 0 && angular === 0) return undefined;
  if (count(MOOD_MIXED_SHAPE_WORDS) > 0 || (rounded > 0 && angular > 0)) {
    return "mixed";
  }
  return rounded > angular ? "rounded" : "angular";
}

const MOOD_GENERATOR_VERBS = new Set([
  "name",
  "create",
  "describe",
  "list",
  "generate",
  "produce",
  "write",
  "output",
  "return",
  "include",
  "ensure",
  "avoid",
  "use",
  "limit",
  "keep",
  "prefer",
  "make",
  "define",
  "choose",
  "pick",
  "provide",
  "specify",
  "state",
  "mention",
  "respond",
  "follow",
  "focus",
  "design",
  "invent",
  "imagine",
  "express",
  "deliver",
  "render",
  "explain",
  "summarize",
  "summarise",
  "restate",
  "interpret",
  "reference",
  "apply",
  "set",
]);

export function moodSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function moodWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function moodNormalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "");
}

/** True when a clause is an order aimed at the generator rather than copy
    aimed at the reader ("Name one observable accomplishment…"). */
function moodIsGeneratorClause(clause: string): boolean {
  const first = (clause.trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z-]/g, "");
  return MOOD_GENERATOR_VERBS.has(first);
}

/** Prose with the scaffolding removed. A sentence whose short label ("Player
    fantasy:", "Constraints:") introduces an instruction or a stub goes
    entirely; a long lead keeps its lead and loses only the trailing
    instruction; a bare fragment goes; everything else is left alone. */
export function moodCleanProse(text: string): string {
  return moodSentences(text)
    .flatMap((sentence) => {
      const colon = sentence.indexOf(":");
      if (colon < 0) return moodWords(sentence) < 3 ? [] : [sentence];
      const label = sentence.slice(0, colon).trim();
      const rest = sentence.slice(colon + 1).trim();
      const scaffolding = moodIsGeneratorClause(rest) || moodWords(rest) < 3;
      if (!scaffolding) return [sentence];
      if (moodWords(label) <= 5) return [];
      return [`${label}.`];
    })
    .join(" ");
}

/** A rule has to be at least a clause — the live set carried a bare
    "first-person." bullet beside full sentences. Exclusion lists are left
    alone: "photoreal noise" is a legitimate two-word entry there. */
export function moodCleanRules(rules: string[]): string[] {
  return rules.filter((rule) => moodWords(rule) >= 3);
}

/** The description minus its scaffolding and minus any sentence that is
    already rendered as a rule bullet on the same card. */
export function moodDescription(direction: VisualDirection): string[] {
  const bullets = new Set(
    [
      ...direction.visualBible.readabilityRules,
      ...direction.visualBible.prohibitedStyles,
    ].map(moodNormalize),
  );
  return moodSentences(moodCleanProse(direction.rationale)).filter(
    (sentence) => !bullets.has(moodNormalize(sentence)),
  );
}

/* --- what differs vs. what every direction says --------------------------
   Three directions arrived roughly half byte-identical: camera, composition,
   all six readability rules, all three exclusions and four of five
   description sentences were character-for-character the same, so the tabs
   made the reader compare two screenfuls of constants. The identical blocks
   are found by string comparison at render time and hoisted into one shared
   section below the card. */
export type MoodFacetKey =
  | "lighting"
  | "atmosphere"
  | "materials"
  | "textureLanguage"
  | "shapeLanguage"
  | "cameraLanguage"
  | "architecture";

const MOOD_FACET_KEYS: MoodFacetKey[] = [
  "lighting",
  "atmosphere",
  "materials",
  "textureLanguage",
  "shapeLanguage",
  "cameraLanguage",
  "architecture",
];

export const MOOD_FACET_LABELS: Record<MoodFacetKey, string> = {
  lighting: "Lighting",
  atmosphere: "Atmosphere",
  materials: "Materials",
  textureLanguage: "Texture",
  shapeLanguage: "Shape language",
  cameraLanguage: "Camera",
  architecture: "Composition",
};

export function moodFacetText(bible: MoodBible, key: MoodFacetKey): string {
  if (key === "materials") return bible.materials.join(" · ");
  return moodCleanProse(bible[key]);
}

/** Entries the first list shares with every other list, in the first list's
    order. Comparison is normalised so punctuation drift does not hide a
    duplicate. */
export function moodCommonEntries(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first || rest.length === 0) return [];
  return first.filter((entry) =>
    rest.every((list) =>
      list.some((other) => moodNormalize(other) === moodNormalize(entry)),
    ),
  );
}

export function moodWithoutCommon(
  entries: string[],
  common: string[],
): string[] {
  const drop = new Set(common.map(moodNormalize));
  return entries.filter((entry) => !drop.has(moodNormalize(entry)));
}

export type MoodSharedContent = {
  facets: MoodFacetKey[];
  description: string[];
  readabilityRules: string[];
  prohibitedStyles: string[];
};

export function moodSharedContent(
  directions: VisualDirection[],
): MoodSharedContent {
  const first = directions[0];
  if (!first || directions.length < 2) {
    return {
      facets: [],
      description: [],
      readabilityRules: [],
      prohibitedStyles: [],
    };
  }
  return {
    facets: MOOD_FACET_KEYS.filter((key) => {
      const value = moodFacetText(first.visualBible, key);
      return directions.every(
        (direction) => moodFacetText(direction.visualBible, key) === value,
      );
    }),
    description: moodCommonEntries(directions.map(moodDescription)),
    readabilityRules: moodCommonEntries(
      directions.map((direction) =>
        moodCleanRules(direction.visualBible.readabilityRules),
      ),
    ),
    prohibitedStyles: moodCommonEntries(
      directions.map((direction) => direction.visualBible.prohibitedStyles),
    ),
  };
}
