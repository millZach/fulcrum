import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  GAME_NAME_MAX_CHARS,
  SOUND_PROMPT_MAX,
  isMeteredImageProvider,
  isMeteredSoundProvider,
  type ApprovalGate,
  type ArtifactRef,
  type ConceptPlanPromptOverride,
  type ConfigurationStatus,
  type ConfirmConceptPlanInput,
  type ConfirmSoundPlanInput,
  type CreateProjectInput,
  type ExecutionProvider,
  type ImageProvider,
  type M1ApprovalInput,
  type ProjectSnapshot,
  type ProjectStage,
  type ProjectStatus,
  type ProviderMode,
  type SoundPlanPromptOverride,
  type SoundProvider,
  type VisualDirection,
} from "@fulcrum/domain";

import * as m1 from "../m1-api.js";
import { MascotStage } from "../m1-prototype/MascotStage.js";
import { AssetGatePrototype } from "../m2-studio/AssetGatePrototype.js";
import { MeshySettings } from "../m2-studio/MeshySettings.js";
import { QualityEvidencePanel } from "../m2-studio/QualityEvidencePanel.js";
import {
  VoxelCube,
  VoxelWorld,
  voxelMaxLevel,
} from "../m1-prototype/M1Prototype.js";
import "../m1-prototype/m1-prototype.css";
import "../m2-studio/multiview-concepts.css";
import {
  DEFAULT_METERED_BUDGET_USD,
  HOTBAR_STAGE_LABELS,
  MESHY_CREDIT_RAISE_STEP,
  MOOD_FACET_LABELS,
  MOOD_INK,
  PINNED_ASPECT_OPTIONS,
  SAMPLE_M1_BRIEF,
  SOUND_RESERVE_USD,
  allSlotsSelected,
  assetFlowOwner,
  attachmentDeliveryNote,
  attachmentLimitMessage,
  attachmentRoom,
  blockedBudgetKind,
  clipboardCarriesText,
  budgetRaisePrompt,
  choreographySafetyDelay,
  choreographyStep,
  currentRound,
  currentStageKey,
  describeStudioError,
  directionSha256,
  firstOpenSlotId,
  formatElapsed,
  formatUsd,
  hotbarForSnapshot,
  hotbarNavigation,
  initialConceptReviewViewState,
  liveGeneratingCopy,
  liveSoundGeneratingCopy,
  mascotForSnapshot,
  meshyCreditMeterView,
  meshyCreditRaisePrompt,
  modelWaitForSnapshot,
  modelWaitForWorking,
  moodAtmosphereGradient,
  moodChipStyle,
  moodCleanRules,
  moodDescription,
  moodFacetText,
  moodLightingGradient,
  moodPaletteWeight,
  moodShapeFamily,
  moodSharedContent,
  moodWithoutCommon,
  nextReviewSlotId,
  pastedImageItems,
  projectTitle,
  recordedAnswers,
  reconcileConceptReviewView,
  reviewGateRescue,
  routingCostNote,
  screenForSnapshot,
  selectedDirection,
  showsMeshyCreditBudget,
  showsMeteredBudget,
  slotRevisionViews,
  soundRouteLabel,
  stageHistoryScreen,
  stageHistoryUsesConceptHost,
  studioCreateProjectInput,
  studioHrefForProject,
  studioStatus,
  suggestedNextBudgetUsd,
  suggestedNextMeshyCredits,
  usdSpendMeterView,
  voxelPaletteFromTokens,
  voxelWorldView,
  worldCardMeta,
  type BudgetRaisePrompt,
  type HotbarNavSlot,
  type HotbarSlot,
  type HotbarStageKey,
  type M1StudioScreen,
  type MeshyCreditRaisePrompt,
  type ModelWaitView,
  type MoodBible,
  type MoodFacetKey,
  type MoodPaletteToken,
  type MoodShapeFamily,
  type RecordedAnswer,
  type SpendMeterView,
  type StageHistoryScreen,
  type StudioErrorView,
} from "./snapshot-view.js";

/** The `attachments` key for the naming screen's steer box. Answer boxes key
 *  themselves by questionId, so this only has to avoid colliding with one. */
const NAME_FEEDBACK_KEY = "name-feedback";

type PendingStudioAction =
  | {
      kind: "generate";
      conceptPlanRevisionId: string;
      promptOverrides?: ConfirmConceptPlanInput["promptOverrides"];
    }
  | {
      kind: "regenerate";
      conceptSetRevisionId: string;
      slotId: string;
      notes?: string;
    }
  | {
      kind: "generate-sounds";
      soundPlanRevisionId: string;
      promptOverrides?: ConfirmSoundPlanInput["promptOverrides"];
    }
  | {
      kind: "regenerate-sound";
      soundSetRevisionId: string;
      slotId: string;
      notes?: string;
    };

const SLOT_PROMPT_MAX_HEIGHT_PX = 192;

function SlotPromptEditor({
  value,
  onChange,
  maxLength = 4000,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, SLOT_PROMPT_MAX_HEIGHT_PX)}px`;
  }, [value]);
  return (
    <textarea
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value)}
      ref={ref}
      spellCheck={false}
      value={value}
    />
  );
}

const PROJECT_PARAM = "project";

const executionProviderLabels: Record<ExecutionProvider, string> = {
  claude: "Claude Subscription",
  openai: "OpenAI Subscription",
  "openai-api": "OpenAI API",
  grok: "Grok Subscription",
  opencode: "OpenCode Subscription",
};

const imageProviderLabels: Record<ImageProvider, string> = {
  "openai-subscription": "OpenAI Sub · Image",
  "openai-gpt-image-2": "OpenAI API · GPT Image 2",
  "custom-api": "Custom image API",
  none: "No image model",
};

/* ---------------------------------------------------------------------------
   The studio header.

   The world's name is the first and largest thing on the bar; the settings that
   never change during a session sit in a quiet meta row beneath it — a status
   pill, the LIVE/REPLAY tag and one route chip whose popover holds the full
   routing. The pieces below are the single implementations of each.
--------------------------------------------------------------------------- */

/** Vendor identity, which is the only part of a route that has to be legible
 *  at a glance. Two OpenAI routes agree even when the plans differ. */
const executionVendors: Record<ExecutionProvider, string> = {
  claude: "Claude",
  openai: "OpenAI",
  "openai-api": "OpenAI",
  grok: "Grok",
  opencode: "OpenCode",
};

const imageVendors: Record<ImageProvider, string> = {
  "openai-subscription": "OpenAI",
  "openai-gpt-image-2": "OpenAI",
  "custom-api": "Custom",
  none: "None",
};

/* Route values for the popover. No middots inside a value: the shipped strip
   joined fields with " · " and `IMAGE OpenAI Sub · Image` then parsed as two
   fields with a stray trailing "Image". */
const executionRouteLabels: Record<ExecutionProvider, string> = {
  claude: "Claude subscription",
  openai: "OpenAI subscription",
  "openai-api": "OpenAI API",
  grok: "Grok subscription",
  opencode: "OpenCode subscription",
};

const imageRouteLabels: Record<ImageProvider, string> = {
  "openai-subscription": "OpenAI subscription",
  "openai-gpt-image-2": "OpenAI API (GPT Image 2)",
  "custom-api": "Custom image API",
  none: "No image model",
};

interface RouteField {
  key: string;
  /** Micro-caps tag used when the routes disagree and go inline. */
  short: string;
  label: string;
  vendor: string;
  value: string;
}

/** Priority order from the review: the spend-relevant image route first, then
 *  orchestrator, then implementation — the reverse of what used to truncate. */
const routeFields = (state: ProjectSnapshot["state"]): RouteField[] => [
  {
    key: "image",
    short: "IMG",
    label: "Image",
    vendor: imageVendors[state.imageProvider],
    value: imageRouteLabels[state.imageProvider],
  },
  {
    key: "orchestrator",
    short: "ORCH",
    label: "Orchestrator",
    vendor: executionVendors[state.orchestratorProvider],
    value: executionRouteLabels[state.orchestratorProvider],
  },
  {
    key: "implementation",
    short: "IMPL",
    label: "Implementation",
    vendor: executionVendors[state.implementationProvider],
    value: executionRouteLabels[state.implementationProvider],
  },
];

/** The status pill: tone word, written label, one dot carrying the colour.
 *  `.vx-status-pill em` is dropped by CSS below 1400px, so the pill sheds the
 *  tone word rather than ellipsising the stage. */
function StatusPill({ state }: { state: ProjectSnapshot["state"] }) {
  const status = studioStatus(state);
  const redundant =
    status.toneLabel.toLowerCase() === status.label.toLowerCase();
  return (
    <span
      aria-label={`Status: ${status.toneLabel} — ${status.label}`}
      className="vx-status-pill"
      data-tone={status.tone}
    >
      <i aria-hidden="true" />
      {!redundant && <em aria-hidden="true">{status.toneLabel}</em>}
      <b>{status.label}</b>
    </span>
  );
}

/** Three routes, one chip. When every route is the same vendor the chip says
 *  so once ("OpenAI · all routes"); when they disagree the vendors go inline in
 *  priority order. Either way the full routing is one hover or focus away, and
 *  nothing here ever ellipsises — the chip is `nowrap` and shrink-proof. */
function RouteChip({ state }: { state: ProjectSnapshot["state"] }) {
  const fields = routeFields(state);
  const vendors = [...new Set(fields.map((field) => field.vendor))];
  const agreed = vendors.length === 1;
  const spoken = fields
    .map((field) => `${field.label} ${field.value}`)
    .join(", ");
  return (
    <span className="vx-route-chip" data-agreed={agreed ? "true" : "false"}>
      <button
        aria-label={`Routing: ${spoken}`}
        className="vx-route-chip-face"
        type="button"
      >
        {agreed ? (
          <>
            <b>{vendors[0]}</b>
            <span className="vx-route-chip-detail">all routes</span>
          </>
        ) : (
          fields.map((field) => (
            <span className="vx-route-chip-part" key={field.key}>
              <em>{field.short}</em>
              <b>{field.vendor}</b>
            </span>
          ))
        )}
        <i aria-hidden="true" />
      </button>
      <span className="vx-route-pop">
        <small>Routing</small>
        <dl>
          {fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      </span>
    </span>
  );
}

const readProjectId = (): string | null =>
  new URLSearchParams(window.location.search).get(PROJECT_PARAM);

const writeProjectId = (
  projectId: string | null,
  milestone: "m1" | "m2",
): void => {
  const url = new URL(window.location.href);
  url.searchParams.set("studio", milestone);
  if (projectId) url.searchParams.set(PROJECT_PARAM, projectId);
  else url.searchParams.delete(PROJECT_PARAM);
  window.history.replaceState({}, "", url);
};

/** The cold-start rail: nothing has happened yet, so only stage one is open.
 *  While a project is being restored nothing is current either — the rail is a
 *  skeleton until the snapshot says which stage the world is actually on. */
const emptyHotbar = (
  milestone: "m1" | "m2",
  restoring: boolean,
): HotbarSlot[] => [
  {
    key: "pitch",
    label: "PITCH",
    tone: "wood",
    filled: false,
    locked: false,
    active: !restoring,
    blocked: false,
    status: "Empty slot",
  },
  {
    key: "brief",
    label: "BRIEF",
    tone: "accent",
    filled: false,
    locked: true,
    active: false,
    blocked: false,
    status: "Needs pitch",
  },
  {
    key: "style",
    label: "COLOR & MOOD",
    tone: "glow",
    filled: false,
    locked: true,
    active: false,
    blocked: false,
    status: "Needs brief",
  },
  {
    key: "images",
    label: "IMAGES",
    tone: "stone",
    filled: false,
    locked: true,
    active: false,
    blocked: false,
    status: "Needs color & mood",
  },
  {
    key: milestone === "m2" ? "assets" : "sounds",
    label: milestone === "m2" ? "ASSETS" : "SOUNDS",
    tone: "wood",
    filled: false,
    locked: true,
    active: false,
    blocked: false,
    status: "Needs images",
  },
];

/** A blocked project's headline is a sentence, not the internal reason code.
 *  Only codes whose meaning is established in the domain get a specific line;
 *  everything else falls back to a claim that is true of every block. */
const blockedHeadline = (
  reason: { code?: string; message?: string } | undefined,
): string => {
  if (reason?.code === "submission-unknown")
    return "We don't know if your paid asset request went through.";
  /* "budget-refused" covers two caps that are raised in different currencies,
     so the headline names the one that actually ran out. */
  const budget = blockedBudgetKind(reason);
  if (budget === "meshy-credits")
    return "This run stopped at your Meshy credit cap.";
  if (budget === "usd") return "This run stopped at your metered USD cap.";
  return "Fulcrum stopped this world and needs you.";
};

function StudioError({
  view,
  busy,
  creditPrompt,
  prompt,
  raiseBudgetUsd,
  raiseCredits,
  onDismiss,
  onRaiseBudgetUsd,
  onRaiseCredits,
  onRetry,
}: {
  view: StudioErrorView;
  busy: boolean;
  creditPrompt: MeshyCreditRaisePrompt | undefined;
  prompt: BudgetRaisePrompt | undefined;
  raiseBudgetUsd: number;
  raiseCredits: number;
  onDismiss: () => void;
  onRaiseBudgetUsd: (value: number) => void;
  onRaiseCredits: (value: number) => void;
  onRetry: () => void;
}) {
  /* Meshy credits are not dollars. Both refusals arrive as "budget-refused",
     and both used to open the USD raise field — which cannot buy a credit, so
     the only recovery offered for a credit stop was one that could not work.
     The two flows are separate affordances now. */
  if (view.creditsRefused && creditPrompt) {
    const committed = creditPrompt.usedCredits + creditPrompt.reservedCredits;
    return (
      <div className="vx-error vx-error-budget" role="alert">
        <strong>Meshy credit cap reached</strong>
        <p>
          Committed {committed} of {creditPrompt.budgetCredits} Meshy credits.
          Raise the credit cap to continue. The same asset will resume and will
          not be paid for twice. Your USD budget is untouched.
        </p>
        <label className="vx-budget-field">
          <span>New Meshy credit cap</span>
          <input
            aria-label="New Meshy credit budget"
            min={creditPrompt.budgetCredits + 1}
            onChange={(event) => onRaiseCredits(Number(event.target.value))}
            step={MESHY_CREDIT_RAISE_STEP}
            type="number"
            value={raiseCredits}
          />
        </label>
        <div className="vx-error-actions">
          <button
            className="vx-primary"
            disabled={
              busy ||
              !Number.isInteger(raiseCredits) ||
              raiseCredits <= creditPrompt.budgetCredits
            }
            onClick={onRetry}
            type="button"
          >
            Raise credit cap &amp; retry <i>▸</i>
          </button>
          <button
            className="vx-secondary"
            disabled={busy}
            onClick={onDismiss}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  if (view.budgetRefused && prompt) {
    return (
      <div className="vx-error vx-error-budget" role="alert">
        <strong>Budget cap reached</strong>
        <p>
          Spent {formatUsd(prompt.spentUsd)} of {formatUsd(prompt.budgetUsd)}.
          Raise the cap to continue. The same generation will resume and will
          not spend twice.
        </p>
        <label className="vx-budget-field">
          <span>New budget USD</span>
          <input
            aria-label="New budget in USD"
            min={prompt.budgetUsd + 0.01}
            onChange={(event) => onRaiseBudgetUsd(Number(event.target.value))}
            step={0.01}
            type="number"
            value={raiseBudgetUsd}
          />
        </label>
        <div className="vx-error-actions">
          <button
            className="vx-primary"
            disabled={
              busy ||
              !Number.isFinite(raiseBudgetUsd) ||
              raiseBudgetUsd <= prompt.budgetUsd
            }
            onClick={onRetry}
            type="button"
          >
            Raise budget & retry <i>▸</i>
          </button>
          <button
            className="vx-secondary"
            disabled={busy}
            onClick={onDismiss}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  const notice = view.kind === "in-flight";
  const quota = view.kind === "quota";
  return (
    <div
      className={`vx-error vx-error-recoverable${notice ? " vx-error-notice" : ""}${quota ? " vx-error-warning" : ""}`}
      role={notice ? "status" : "alert"}
    >
      <div className="vx-error-copy">
        <strong>{view.title}</strong>
        <p>{view.message}</p>
        {view.guidance && <small>{view.guidance}</small>}
      </div>
      <button
        className="vx-secondary vx-error-dismiss"
        disabled={busy}
        onClick={onDismiss}
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}

/** A cap as a picture: a solid run of what is spent, a hatched run of what is
 *  reserved, the empty remainder, and one number — what is left. The header
 *  read "MESHY 20 USED + 20 RESERVED / 100 CREDITS", a nine-token string that
 *  had to be parsed to answer the only live question ("can I keep going?") and
 *  that grew wide enough to squeeze the plaque.
 *
 *  Compact on purpose: a 132px track plus a short label, `flex: none` and
 *  nowrap, so the header's right rail holds one width from 1366 to 2560. The
 *  full accounting is in the aria-label, so nothing is lost to a screen reader.
 *  `role="img"` rather than `<meter>`: a meter announces a bare percentage and
 *  arrives with a UA appearance to fight. */
function SpendMeter({
  compact = false,
  view,
}: {
  compact?: boolean | undefined;
  view: SpendMeterView;
}) {
  return (
    <span
      aria-label={view.ariaLabel}
      className="vx-meter-bar"
      data-compact={compact ? "true" : "false"}
      data-tone={view.tone}
      role="img"
    >
      <span className="vx-meter-track" aria-hidden="true">
        <span
          className="vx-meter-used"
          style={{ width: `${view.usedPercent}%` }}
        />
        <span
          className="vx-meter-reserved"
          style={{ width: `${view.reservedPercent}%` }}
        />
      </span>
      <b>{view.label}</b>
    </span>
  );
}

/** Which meter a world wears: Meshy credits on a live M2 Meshy world, dollars
 *  on a metered route, and nothing at all when neither cap exists. */
const worldSpendMeter = (
  project: ProjectSnapshot,
): SpendMeterView | undefined =>
  project.state.milestone === "m2" &&
  project.state.mode === "live" &&
  project.state.assetProvider === "meshy"
    ? meshyCreditMeterView(project.state)
    : showsMeteredBudget(project.state)
      ? usdSpendMeterView(project.state)
      : undefined;

/** The words shown where a meter cannot be drawn: a live M2 world with no
 *  credit cap recorded yet, and every world that never touches a metered
 *  route. */
const worldSpendNote = (project: ProjectSnapshot): string =>
  project.state.milestone === "m2" &&
  project.state.mode === "live" &&
  project.state.assetProvider === "meshy"
    ? "Meshy credit cap required"
    : "No metered spend";

/** The world card, shared by the home screen's "Resume a world" panel and the
 *  WORLDS overlay so the two lists can never drift apart. Uniform height, a
 *  one-line clamped title, and a blocked stage carrying the alert tone.
 *
 *  Both lists now hold both milestones, so the meta line leads with the world's
 *  own milestone ("M2 · LIVE · BLOCKED"). It is the same micro-caps run as
 *  before — one more term, no new furniture. */
function WorldCard({
  current,
  project,
  onOpen,
}: {
  current: boolean;
  project: ProjectSnapshot;
  onOpen: (project: ProjectSnapshot) => void;
}) {
  const status = studioStatus(project.state);
  const meter = worldSpendMeter(project);
  return (
    <button
      className="vx-world-card"
      data-current={current ? "true" : "false"}
      onClick={() => onOpen(project)}
      type="button"
    >
      <span className="vx-world-card-meta">
        <small data-alert={status.tone === "blocked" ? "true" : "false"}>
          {worldCardMeta(project.state)}
        </small>
        {current && <em className="vx-world-current">Current</em>}
      </span>
      <strong>{projectTitle(project)}</strong>
      {meter ? <SpendMeter view={meter} /> : <i>{worldSpendNote(project)}</i>}
    </button>
  );
}

/** WORLDS used to unmount the loaded project and hand the user the new-world
 *  landing page. It now opens this sheet on top of the live studio.
 *
 *  Native <dialog> + showModal() on purpose: the shell's entrance animation
 *  creates a stacking context that traps any z-indexed overlay under the
 *  hotbar, and the top layer is the only way out of it (same reason the M2
 *  credit modal is a dialog). Escape, the X and the scrim all route through
 *  `onClose`, which restores focus to the WORLDS button. */
function WorldsOverlay({
  currentProjectId,
  projects,
  onClose,
  onCreate,
  onOpen,
}: {
  currentProjectId: string;
  projects: ProjectSnapshot[];
  onClose: () => void;
  onCreate: () => void;
  onOpen: (project: ProjectSnapshot) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  /* Every 2.5s poll re-applies the loaded world, which moves it to the head of
     `projects`. Pinning it here means that reshuffle can never happen under the
     pointer while the sheet is open. */
  const current = projects.find(
    (item) => item.state.projectId === currentProjectId,
  );
  const ordered = current
    ? [current, ...projects.filter((item) => item !== current)]
    : projects;
  return (
    <dialog
      aria-labelledby="vx-worlds-title"
      className="vx-worlds-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      /* The sheet fills the dialog box edge to edge, so the dialog itself is
         only ever the click target when the scrim was clicked. */
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      ref={dialogRef}
    >
      <div className="vx-worlds-sheet">
        <header className="vx-worlds-head">
          <div className="vx-worlds-heading">
            <span className="vx-kicker">
              <i />
              Worlds
            </span>
            <h2 id="vx-worlds-title">Switch worlds</h2>
          </div>
          <div className="vx-worlds-actions">
            <button className="vx-secondary" onClick={onCreate} type="button">
              Create a new world
            </button>
            <button
              aria-label="Close worlds"
              autoFocus
              className="vx-worlds-close"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>
        {ordered.length === 0 ? (
          <div className="vx-empty-worlds">
            <strong>No other worlds yet</strong>
            <p>Create one and this list fills up as you forge.</p>
          </div>
        ) : (
          <ul className="vx-worlds-list">
            {ordered.map((item) => (
              <li key={item.state.projectId}>
                <WorldCard
                  current={item.state.projectId === currentProjectId}
                  project={item}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}

/* ---------------------------------------------------------------------------
   Settings.

   Model routing used to live only in the create form, three selects squeezed
   into a third of a narrow column each — wide enough for "Claude Subscript…"
   and no wider. It moves here, where a full-width field can hold the longest
   option, and the form keeps a one-line summary and a way back in.

   Routing is fixed at creation on the coordinator (`CreateProjectInput` carries
   the providers and no endpoint changes them afterwards), so with a world open
   this sheet is a readout and says so.

   The model *variant* — which Claude, which GPT — has no domain plumbing at
   all: `ExecutionProvider` is a vendor-and-plan enum and nothing on the wire
   carries a model id. The field below is therefore an honest disabled stub
   rather than a control that would silently do nothing.
--------------------------------------------------------------------------- */

/** The three routing selects, shared by the settings sheet's editable and
 *  read-only faces so the two can never describe routing differently. */
function RoutingFields({
  configuration,
  imageProvider,
  implementationProvider,
  milestone,
  mode,
  orchestratorProvider,
  onImageProvider,
  onImplementationProvider,
  onOrchestratorProvider,
}: {
  configuration: ConfigurationStatus | null;
  imageProvider: ImageProvider;
  implementationProvider: ExecutionProvider;
  milestone: "m1" | "m2";
  mode: ProviderMode;
  orchestratorProvider: ExecutionProvider;
  /** Omitted on an open world, where routing is a readout. */
  onImageProvider?: ((provider: ImageProvider) => void) | undefined;
  onImplementationProvider?:
    ((provider: ExecutionProvider) => void) | undefined;
  onOrchestratorProvider?: ((provider: ExecutionProvider) => void) | undefined;
}) {
  const fixed = onOrchestratorProvider === undefined;
  const replay = mode === "replay";
  const orchestratorReadiness = configuration?.executionProviders.find(
    ({ provider }) => provider === orchestratorProvider,
  );
  const implementationReadiness = configuration?.executionProviders.find(
    ({ provider }) => provider === implementationProvider,
  );
  const imageReadiness = configuration?.imageProviders.find(
    ({ provider }) => provider === imageProvider,
  );
  /* An open world's routing is not in the local configuration list's order, and
     a provider this build has never heard of must still be shown; each select
     therefore always carries its own current value as an option. */
  const executionOptions = (
    current: ExecutionProvider,
  ): ExecutionProvider[] => {
    const listed = (configuration?.executionProviders ?? []).map(
      ({ provider }) => provider,
    );
    return listed.includes(current) ? listed : [current, ...listed];
  };
  const imageOptions = (current: ImageProvider): ImageProvider[] => {
    const listed = (configuration?.imageProviders ?? []).map(
      ({ provider }) => provider,
    );
    return listed.includes(current) ? listed : [current, ...listed];
  };
  return (
    <div className="vx-model-routing vx-model-routing-wide">
      <label>
        <span>Orchestrator</span>
        <select
          aria-label="Orchestrator model provider"
          disabled={fixed || replay}
          onChange={(event) =>
            onOrchestratorProvider?.(event.target.value as ExecutionProvider)
          }
          value={orchestratorProvider}
        >
          {executionOptions(orchestratorProvider).map((provider) => (
            <option key={provider} value={provider}>
              {executionProviderLabels[provider]}
            </option>
          ))}
        </select>
        <small className={orchestratorReadiness?.ready ? "ready" : ""}>
          {fixed
            ? "Fixed when this world was created"
            : replay
              ? "Replay is offline · fixture text is deterministic"
              : (orchestratorReadiness?.detail ?? "Checking provider")}
        </small>
      </label>
      <label>
        <span>Implementation</span>
        <select
          aria-label="Implementation model provider"
          disabled={fixed || replay}
          onChange={(event) =>
            onImplementationProvider?.(event.target.value as ExecutionProvider)
          }
          value={implementationProvider}
        >
          {executionOptions(implementationProvider).map((provider) => (
            <option key={provider} value={provider}>
              {executionProviderLabels[provider]}
            </option>
          ))}
        </select>
        <small className={implementationReadiness?.ready ? "ready" : ""}>
          {fixed
            ? "Fixed when this world was created"
            : replay
              ? "Replay is offline · saved for later milestones"
              : `${implementationReadiness?.detail ?? "Checking provider"} · ${milestone.toUpperCase()} saves this route for later work`}
        </small>
      </label>
      <label>
        <span>Image</span>
        <select
          aria-label="Image model provider"
          disabled={fixed || replay}
          onChange={(event) =>
            onImageProvider?.(event.target.value as ImageProvider)
          }
          value={imageProvider}
        >
          {imageOptions(imageProvider).map((provider) => (
            <option key={provider} value={provider}>
              {imageProviderLabels[provider]}
            </option>
          ))}
        </select>
        <small className={imageReadiness?.ready ? "ready" : ""}>
          {fixed
            ? "Fixed when this world was created"
            : replay
              ? "Replay is offline · no image model is called"
              : (imageReadiness?.detail ?? "Checking provider")}
        </small>
      </label>
      {/* Not a control: nothing on the wire carries a model id, so offering a
          live one would be a promise the coordinator cannot keep. */}
      <label className="vx-routing-stub">
        <span>Model variant</span>
        <select aria-label="Model variant" disabled value="default">
          <option value="default">Provider default</option>
        </select>
        <small>
          Coming soon · Fulcrum has no per-model plumbing yet, so each route
          runs its provider&apos;s default model.
        </small>
      </label>
    </div>
  );
}

/** One line of routing for the create form, so moving the selects into the
 *  sheet does not hide what the world is about to be created with. */
const routingSummary = (routing: {
  mode: ProviderMode;
  orchestratorProvider: ExecutionProvider;
  implementationProvider: ExecutionProvider;
  imageProvider: ImageProvider;
}): string =>
  routing.mode === "replay"
    ? "Replay · deterministic fixtures on every route"
    : [
        `Orchestrator ${executionVendors[routing.orchestratorProvider]}`,
        `Implementation ${executionVendors[routing.implementationProvider]}`,
        `Image ${imageRouteLabels[routing.imageProvider]}`,
      ].join(" · ");

/** Native <dialog>, for the same reason WORLDS is one: the shell's entrance
 *  transform traps any z-indexed overlay under the hotbar, and the top layer is
 *  the only way out. Escape, the X and the scrim all route through `onClose`,
 *  which hands focus back to whichever button opened the sheet. */
function SettingsOverlay({
  configuration,
  imageProvider,
  implementationProvider,
  milestone,
  mode,
  orchestratorProvider,
  project,
  onClose,
  onImageProvider,
  onImplementationProvider,
  onOrchestratorProvider,
  onSnapshot,
}: {
  configuration: ConfigurationStatus | null;
  imageProvider: ImageProvider;
  implementationProvider: ExecutionProvider;
  milestone: "m1" | "m2";
  mode: ProviderMode;
  orchestratorProvider: ExecutionProvider;
  /** null on the home screen: the routing being edited is the next world's. */
  project: ProjectSnapshot | null;
  onClose: () => void;
  onImageProvider: (provider: ImageProvider) => void;
  onImplementationProvider: (provider: ExecutionProvider) => void;
  onOrchestratorProvider: (provider: ExecutionProvider) => void;
  /** Meshy settings are a per-world write, so the sheet returns a snapshot. */
  onSnapshot: (next: ProjectSnapshot) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  const state = project?.state;
  return (
    <dialog
      aria-labelledby="vx-settings-title"
      className="vx-worlds-dialog vx-settings-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      ref={dialogRef}
    >
      <div className="vx-worlds-sheet vx-settings-sheet">
        <header className="vx-worlds-head">
          <div className="vx-worlds-heading">
            <span className="vx-kicker">
              <i />
              Settings
            </span>
            <h2 id="vx-settings-title">Model routing</h2>
          </div>
          <div className="vx-worlds-actions">
            <button
              aria-label="Close settings"
              autoFocus
              className="vx-worlds-close"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>
        <p className="vx-settings-note">
          {state
            ? "Routing is fixed when a world is created, so this world's routes are shown for reference only. Create a new world to change them."
            : mode === "replay"
              ? "Replay runs every route from local fixtures, so routing is inert until this world is created in live mode."
              : "These routes are saved onto the next world you create. They cannot be changed after creation."}
        </p>
        {state ? (
          <RoutingFields
            configuration={configuration}
            imageProvider={state.imageProvider}
            implementationProvider={state.implementationProvider}
            milestone={milestone}
            mode={state.mode}
            orchestratorProvider={state.orchestratorProvider}
          />
        ) : (
          <RoutingFields
            configuration={configuration}
            imageProvider={imageProvider}
            implementationProvider={implementationProvider}
            milestone={milestone}
            mode={mode}
            orchestratorProvider={orchestratorProvider}
            onImageProvider={onImageProvider}
            onImplementationProvider={onImplementationProvider}
            onOrchestratorProvider={onOrchestratorProvider}
          />
        )}
        {project && <MeshySettings onSnapshot={onSnapshot} project={project} />}
      </div>
    </dialog>
  );
}

/** The header's spend readout, and the same component inside the generating
 *  screen. A world with no cap of either kind shows nothing rather than an
 *  empty track — except a live M2 Meshy world, where a missing credit cap is
 *  itself the thing to say. */
function BudgetChip({
  compact = false,
  project,
}: {
  compact?: boolean | undefined;
  project: ProjectSnapshot;
}) {
  const meter = worldSpendMeter(project);
  if (meter) return <SpendMeter compact={compact} view={meter} />;
  const meshy =
    project.state.milestone === "m2" &&
    project.state.mode === "live" &&
    project.state.assetProvider === "meshy";
  if (!meshy) return null;
  return <span className="vx-budget">Meshy credit cap required</span>;
}

function padIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** Live m:ss since the local request or coordinator-reported start time. */
function WaitClock({ startedAt }: { startedAt?: string | undefined }) {
  const localStartedAt = useRef(Date.now());
  const parsedStartedAt = startedAt ? Date.parse(startedAt) : Number.NaN;
  const origin = Number.isFinite(parsedStartedAt)
    ? parsedStartedAt
    : localStartedAt.current;
  const elapsed = () => Math.max(0, Math.floor((Date.now() - origin) / 1000));
  const [seconds, setSeconds] = useState(elapsed);
  useEffect(() => {
    setSeconds(elapsed());
    const timer = window.setInterval(() => setSeconds(elapsed()), 500);
    return () => window.clearInterval(timer);
  }, [origin]);
  return <>{formatElapsed(seconds)}</>;
}

/** "The forge is thinking" — pinned to the top of the stage while a live
 *  model call is in flight. It reveals itself only after ~0.35 s (replay
 *  transitions are near-instant and must not flash it) and pulls the stage
 *  scroller to itself exactly once per wait, when it becomes visible. */
function ModelWaitBanner({
  startedAt,
  view,
}: {
  startedAt?: string | undefined;
  view: ModelWaitView;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 380);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="vx-thinking" ref={ref} role="status" aria-live="polite">
      <span className="vx-thinking-blocks" aria-hidden="true">
        <VoxelCube tone="wood" />
        <VoxelCube tone="accent" />
        <VoxelCube tone="glow" />
        <VoxelCube tone="stone" />
      </span>
      <span className="vx-thinking-copy">
        <strong>{view.title}</strong>
        <small>{view.hint}</small>
      </span>
      <span className="vx-thinking-clock">
        <WaitClock startedAt={startedAt} />
      </span>
    </div>
  );
}

export function M1Studio({ milestone = "m1" }: { milestone?: "m1" | "m2" }) {
  const [configuration, setConfiguration] =
    useState<ConfigurationStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [bootError, setBootError] = useState("");
  /** A `project` URL param promises a project the list has not delivered yet.
   *  Until it resolves, the shell has nothing true to say, so it says nothing:
   *  the marketing hero and "No worlds yet" both wait behind this flag. */
  const [restoring, setRestoring] = useState(() => Boolean(readProjectId()));
  /** goHome must beat any request already in flight. Every async apply records
   *  the navigation it was issued under and drops its snapshot if the user has
   *  navigated since — otherwise a 2.5s poll lands ~1.5s after WORLDS and snaps
   *  the torn-down project back onto the screen. */
  const navigation = useRef(0);
  /** WORLDS opens a sheet over the loaded project instead of tearing it down.
   *  The trigger is held so every close path can hand focus back to it. */
  const [worldsOpen, setWorldsOpen] = useState(false);
  const worldsTrigger = useRef<HTMLButtonElement | null>(null);
  /** SETTINGS opens the same kind of sheet. The trigger is whichever button
   *  opened it — the header's, or the create form's routing summary. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement | null>(null);
  /** The completed stage the user has stepped back into, if any. The rail is
   *  a navigation now, not a readout — but stepping back never mutates, so this
   *  is browser-only state and the coordinator is never told. */
  const [viewedStage, setViewedStage] = useState<HotbarStageKey>();
  const [error, setError] = useState<StudioErrorView>();
  const [working, setWorking] = useState("");
  const [brief, setBrief] = useState(SAMPLE_M1_BRIEF);
  const [mode, setMode] = useState<ProviderMode>("replay");
  const [orchestratorProvider, setOrchestratorProvider] =
    useState<ExecutionProvider>("openai");
  const [implementationProvider, setImplementationProvider] =
    useState<ExecutionProvider>("openai");
  const [imageProvider, setImageProvider] = useState<ImageProvider>("none");
  const [soundProvider, setSoundProvider] = useState<SoundProvider>("none");
  const [soundRegenNotes, setSoundRegenNotes] = useState<
    Record<string, string>
  >({});
  const [budgetUsd, setBudgetUsd] = useState(DEFAULT_METERED_BUDGET_USD);
  const [meshyCreditBudget, setMeshyCreditBudget] = useState(300);
  const [rightsConfirmed, setRightsConfirmed] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Images pasted into a text box, keyed the same way `drafts` is: one entry
   *  per answer box, plus `NAME_FEEDBACK_KEY` for the naming steer. They are
   *  already stored server-side by the time they land here — the chip shows a
   *  real artifact URI, not a blob, so what the user sees is what was kept. */
  const [attachments, setAttachments] = useState<Record<string, ArtifactRef[]>>(
    {},
  );
  const [attaching, setAttaching] = useState(0);
  const [reviseText, setReviseText] = useState("");
  /** The naming conversation: which candidate is picked, what the user said
   *  about the batch, and the name they typed instead. */
  const [nameChoice, setNameChoice] = useState<string>();
  const [nameFeedback, setNameFeedback] = useState("");
  const [customName, setCustomName] = useState("");
  const [viewedDirectionId, setViewedDirectionId] = useState<string>();
  const [replaceNotes, setReplaceNotes] = useState("");
  const [changeText, setChangeText] = useState("");
  const [pinnedAspects, setPinnedAspects] = useState<string[]>([
    "palette",
    "shape language",
  ]);
  const [directionPanel, setDirectionPanel] = useState<
    "none" | "replace" | "change"
  >("none");
  const [conceptReviewView, setConceptReviewView] = useState(
    initialConceptReviewViewState,
  );
  const [pendingAction, setPendingAction] = useState<PendingStudioAction>();
  const [raiseDraft, setRaiseDraft] = useState(
    suggestedNextBudgetUsd(DEFAULT_METERED_BUDGET_USD),
  );
  const [raiseCreditsDraft, setRaiseCreditsDraft] = useState(
    MESHY_CREDIT_RAISE_STEP,
  );
  const [shown, setShown] = useState(0);
  const [forged, setForged] = useState(0);
  const [flagPlaced, setFlagPlaced] = useState(false);
  const built = useRef(0);
  /** Monotonic performance counter for Rusty: one unit = one fetch trip. */
  const [trips, setTrips] = useState(0);
  /** true while queued trips advance the shown world one level per placement
   *  (interrogation); false snaps to the full truth on placement. */
  const strideOne = useRef(false);
  const choreo = useRef<{ projectId: string | undefined; decisions: number }>({
    projectId: undefined,
    decisions: 0,
  });
  /** The one continued world this mount has already asked to plan. */
  const planningAsked = useRef<string | undefined>(undefined);

  const screen: M1StudioScreen = project ? screenForSnapshot(project) : "home";
  /** What a step back into `viewedStage` can show. Everything downstream keys
   *  off this: `undefined` means the stage is "now" and the live screen runs. */
  const historyScreen: StageHistoryScreen | undefined =
    project && viewedStage
      ? stageHistoryScreen(project, viewedStage)
      : undefined;

  const applySnapshot = (next: ProjectSnapshot) => {
    setProject(next);
    setProjects((current) => {
      const others = current.filter(
        (candidate) => candidate.state.projectId !== next.state.projectId,
      );
      return [next, ...others];
    });
    writeProjectId(next.state.projectId, milestone);
  };

  const mutate = async (
    label: string,
    run: () => Promise<ProjectSnapshot>,
    retry?: PendingStudioAction,
  ): Promise<ProjectSnapshot | undefined> => {
    setWorking(label);
    setError(undefined);
    try {
      const posted = await run();
      const fresh = await m1.getProject(posted.state.projectId);
      applySnapshot(fresh);
      setPendingAction(undefined);
      return fresh;
    } catch (cause) {
      const view = describeStudioError(cause);
      setError(view);
      if ((view.budgetRefused || view.creditsRefused) && retry) {
        if (retry.kind === "generate" && project) {
          try {
            const latest = await m1.getProject(project.state.projectId);
            applySnapshot(latest);
            setPendingAction({
              ...retry,
              conceptPlanRevisionId: latest.state.conceptPlan!.revisionId,
            });
          } catch {
            setPendingAction(retry);
          }
        } else if (retry.kind === "generate-sounds" && project) {
          try {
            const latest = await m1.getProject(project.state.projectId);
            applySnapshot(latest);
            setPendingAction({
              ...retry,
              soundPlanRevisionId: latest.state.soundPlan!.revisionId,
            });
          } catch {
            setPendingAction(retry);
          }
        } else {
          setPendingAction(retry);
        }
        setRaiseDraft(
          suggestedNextBudgetUsd(project?.state.budgetUsd ?? budgetUsd),
        );
      }
      return undefined;
    } finally {
      setWorking("");
    }
  };

  /** A world of the other milestone can only be drawn by the other studio —
   *  `milestone` is a mount-time prop, and hot-swapping it would leave every
   *  piece of state below keyed to the wrong flow. So opening one is a real
   *  navigation, and the reload mounts the right studio on the right project.
   *  `restoring` is deliberately left standing: the page is on its way out and
   *  "Restoring your world…" is the true thing to show while it goes. */
  const openInOwnStudio = (state: {
    milestone: string;
    projectId: string;
  }): void => {
    window.location.assign(studioHrefForProject(window.location.href, state));
  };

  useEffect(() => {
    const requested = readProjectId();
    const issuedAt = navigation.current;
    void Promise.all([m1.getConfiguration(), m1.listProjects()])
      .then(([config, listed]) => {
        setConfiguration(config);
        /* One list, both milestones. The mounted studio decides how a world is
         *opened*, never which worlds the user is allowed to see. */
        const worlds = m1.studioProjects(listed);
        setProjects(worlds);
        if (!requested || navigation.current !== issuedAt) {
          setRestoring(false);
          return;
        }
        const found = worlds.find(({ state }) => state.projectId === requested);
        if (found) {
          if (found.state.milestone !== milestone) {
            openInOwnStudio(found.state);
            return;
          }
          setProject(found);
          setRestoring(false);
          return;
        }
        return m1.getProject(requested).then((snapshot) => {
          if (navigation.current !== issuedAt) {
            setRestoring(false);
            return;
          }
          /* A direct link can still name the wrong studio. We know which one is
             right, so send the browser there instead of erroring — the error
             below is kept for projects that genuinely cannot be loaded. */
          if (snapshot.state.milestone !== milestone) {
            openInOwnStudio(snapshot.state);
            return;
          }
          applySnapshot(snapshot);
          setRestoring(false);
        });
      })
      .catch((cause) => {
        setRestoring(false);
        setBootError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [milestone]);

  useEffect(() => {
    const projectId = project?.state.projectId;
    if (!projectId || working) return;
    let active = true;
    const issuedAt = navigation.current;
    const refresh = () => {
      void m1
        .getProject(projectId)
        .then((snapshot) => {
          if (active && navigation.current === issuedAt)
            applySnapshot(snapshot);
        })
        .catch(() => {
          // Keep the current snapshot during a transient polling failure.
        });
    };
    const timer = window.setInterval(refresh, 2_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    /* `viewedStage` is not read here: it is a dependency so that stepping
       through the rail re-arms the poll under the fresh navigation epoch that
       `showStage` bumped. Without it the interval would keep its old epoch and
       drop every snapshot from then on. */
  }, [project?.state.projectId, working, viewedStage]);

  /* A world continued out of M1 lands at asset planning with nothing drafted
     — the continuation deliberately generates nothing — and this stage has no
     button, because natively the concept-set approval that creates the world
     also starts its planning. Continuing *is* that decision, so the studio
     asks once, here, through the same `advance` the coordinator uses.
     Restricted to continued worlds: a natively-created M2 world never sits in
     this state, and its behaviour is left exactly as it was. */
  useEffect(() => {
    const state = project?.state;
    if (
      !state ||
      !state.continuedFrom ||
      state.stage !== "asset-planning" ||
      state.status !== "active" ||
      state.assetPlan ||
      project?.inFlight ||
      working ||
      planningAsked.current === state.projectId
    )
      return;
    planningAsked.current = state.projectId;
    void mutate("plan-assets", () => m1.advanceProject(state.projectId));
  }, [
    project?.state.projectId,
    project?.state.stage,
    project?.state.status,
    project?.state.assetPlan?.revisionId,
    project?.inFlight?.action,
    working,
  ]);

  useEffect(() => {
    const frontier = project?.interrogation?.frontier ?? [];
    const revision = project?.state.interrogation?.revisionId;
    if (!revision) return;
    setDrafts((current) =>
      Object.fromEntries(
        frontier.map((question) => [
          question.questionId,
          current[question.questionId] ?? question.recommendation,
        ]),
      ),
    );
  }, [project?.state.interrogation?.revisionId]);

  useEffect(() => {
    const frontier = project?.interrogation?.frontier ?? [];
    setDrafts(
      Object.fromEntries(
        frontier.map((question) => [
          question.questionId,
          question.recommendation,
        ]),
      ),
    );
    setViewedDirectionId(project?.state.selectedVisualDirectionRevisionId);
    setDirectionPanel("none");
    setReplaceNotes("");
    setChangeText("");
    setNameChoice(undefined);
    setNameFeedback("");
    setCustomName("");
    setAttachments({});
    setSoundRegenNotes({});
    setViewedStage(undefined);
  }, [project?.state.projectId]);

  useEffect(() => {
    setConceptReviewView((current) =>
      reconcileConceptReviewView(current, project),
    );
  }, [project]);

  const snapshotWait = project ? modelWaitForSnapshot(project) : undefined;
  const effectiveWorking = working || snapshotWait?.action || "";
  const busy = effectiveWorking.length > 0;
  const waitView = working
    ? modelWaitForWorking(working, project?.state.mode ?? mode)
    : snapshotWait?.banner;
  const waitStartedAt = working ? undefined : snapshotWait?.startedAt;
  const generatingImages =
    effectiveWorking === "generate" || effectiveWorking === "regenerate";
  const generatingSounds =
    effectiveWorking === "generate-sounds" ||
    effectiveWorking === "regenerate-sound";
  const generating = generatingImages || generatingSounds;
  const direction = project
    ? selectedDirection(project, viewedDirectionId)
    : undefined;
  const round = project ? currentRound(project) : undefined;
  const answers = project ? recordedAnswers(project) : [];
  const slots = project?.conceptSet?.slots ?? [];
  const { inspectingSlotId, regenNotes, viewedRevisionId } = conceptReviewView;
  const setInspectingSlotId = (slotId: string | undefined) =>
    setConceptReviewView((current) => ({
      ...current,
      inspectingSlotId: slotId,
    }));
  const setViewedRevisionId = (revisionId: string | undefined) =>
    setConceptReviewView((current) => ({
      ...current,
      viewedRevisionId: revisionId,
    }));
  const setRegenNotes = (notes: string) =>
    setConceptReviewView((current) => ({ ...current, regenNotes: notes }));
  const activeSlotId =
    inspectingSlotId ?? (project ? firstOpenSlotId(project) : undefined);
  const activeSlot = slots.find((slot) => slot.slotId === activeSlotId);
  const revisions =
    project && activeSlot ? slotRevisionViews(project, activeSlot) : [];
  const viewedRevision =
    revisions.find((entry) => entry.revisionId === viewedRevisionId) ??
    revisions.find(
      (entry) => entry.revisionId === activeSlot?.selectedRevisionId,
    ) ??
    revisions.at(-1);
  const showPackage =
    project !== null &&
    allSlotsSelected(project) &&
    inspectingSlotId === undefined;
  const mascot = mascotForSnapshot(project, {
    slotReview: screen === "concept-review" && !showPackage,
  });
  const world = voxelWorldView(project);
  const decisions = mascot.decisions;
  built.current = decisions;
  const level = Math.min(shown, decisions);
  const hotbar = project ? hotbarForSnapshot(project) : [];
  /** The tile that stands for "now", and the rail with its navigability
   *  worked out. With no world loaded the landing page's rail is a picture of
   *  an empty ladder, so nothing on it is clickable. */
  const currentKey = project ? currentStageKey(hotbar) : undefined;
  const navigableHotbar: HotbarNavSlot[] = project
    ? hotbarNavigation(hotbar, viewedStage)
    : emptyHotbar(milestone, restoring).map((slot) => ({
        ...slot,
        navigable: false,
        viewing: false,
      }));
  const raisePrompt =
    error?.budgetRefused && pendingAction && project
      ? budgetRaisePrompt(project)
      : undefined;
  const creditRaisePrompt =
    error?.creditsRefused && pendingAction && project
      ? meshyCreditRaisePrompt(project)
      : undefined;

  /* Seed the raise fields from the cap that actually refused. They used to
     hold a constant 2, which only ever cleared the "greater than the current
     cap" check because the seeded cap was $1. */
  const suggestedRaiseUsd = raisePrompt?.suggestedBudgetUsd;
  useEffect(() => {
    if (suggestedRaiseUsd !== undefined) setRaiseDraft(suggestedRaiseUsd);
  }, [suggestedRaiseUsd]);
  const suggestedRaiseCredits = creditRaisePrompt?.suggestedBudgetCredits;
  useEffect(() => {
    if (suggestedRaiseCredits !== undefined)
      setRaiseCreditsDraft(suggestedRaiseCredits);
  }, [suggestedRaiseCredits]);

  /* The diorama earns its blocks through Rusty: a fresh snapshot only queues
     trips, and the shown level advances when he places. A reload or project
     switch instead syncs instantly — blocks already recorded on the
     coordinator render immediately, with no replayed choreography. */
  useEffect(() => {
    const projectId = project?.state.projectId;
    const prev = choreo.current;
    choreo.current = { projectId, decisions };
    const step = choreographyStep(
      prev,
      { projectId, decisions, screen },
      voxelMaxLevel,
    );
    if (step.kind === "sync") {
      setShown(decisions);
      return;
    }
    if (step.kind === "trips") {
      strideOne.current = step.stride === "level";
      setTrips((count) => count + step.count);
    }
  }, [project?.state.projectId, decisions, screen]);
  /* Safety net: if the choreography ever dies (no WebGL, hidden tab), the
     world still reaches the truth. Re-arms on every placement, so a healthy
     queue of ~11 s trips never triggers it. */
  useEffect(() => {
    const delay = choreographySafetyDelay(shown, decisions, voxelMaxLevel);
    if (delay === undefined) return;
    const timer = window.setTimeout(() => setShown(decisions), delay);
    return () => window.clearTimeout(timer);
  }, [decisions, shown]);
  useEffect(() => {
    if (!forged) return;
    const timer = window.setTimeout(() => setForged(0), 900);
    return () => window.clearTimeout(timer);
  }, [forged]);
  useEffect(() => {
    if (screen !== "complete") {
      setFlagPlaced(false);
      return;
    }
    const timer = window.setTimeout(() => setFlagPlaced(true), 13_000);
    return () => window.clearTimeout(timer);
  }, [screen]);
  const place = useCallback(() => {
    setShown((current) =>
      strideOne.current ? Math.min(current + 1, built.current) : built.current,
    );
    setForged((count) => count + 1);
  }, []);
  const plantFlag = useCallback(() => setFlagPlaced(true), []);
  const elevenLabsReady = configuration?.soundProviders.find(
    ({ provider }) => provider === "elevenlabs",
  );

  const chooseMode = (nextMode: ProviderMode) => {
    setMode(nextMode);
    setOrchestratorProvider("openai");
    setImplementationProvider("openai");
    setImageProvider(nextMode === "live" ? "openai-subscription" : "none");
  };

  const createProject = async () => {
    if (!rightsConfirmed || brief.trim().length < 40) return;
    const routing = {
      mode,
      orchestratorProvider:
        mode === "replay" ? ("openai" as const) : orchestratorProvider,
      implementationProvider:
        mode === "replay" ? ("openai" as const) : implementationProvider,
      imageProvider: mode === "live" ? imageProvider : ("none" as const),
      soundProvider:
        milestone === "m2"
          ? ("none" as const)
          : mode === "live"
            ? soundProvider
            : ("none" as const),
    };
    const input: CreateProjectInput = studioCreateProjectInput({
      milestone,
      brief,
      budgetUsd,
      meshyCreditBudget,
      ...routing,
    });
    await mutate("create", () =>
      milestone === "m2"
        ? m1.createM2Project(input)
        : m1.createM1Project(input),
    );
  };

  /* ---------- pasted images ----------

     A paste is uploaded the moment it happens rather than held until send.
     Holding it would mean the chip shows a `blob:` the server has never seen,
     and a failed send would throw the picture away with the text. Uploading
     first makes the chip a real artifact URI: what is on screen is what is
     stored, and removing it before send just leaves an unreferenced artifact
     behind, which the content-addressed store already tolerates. */
  const readAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("The image could not be read."));
      reader.onload = () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("The image could not be read."));
      reader.readAsDataURL(file);
    });

  const pasteImages = async (
    key: string,
    event: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => {
    const projectId = project?.state.projectId;
    if (!projectId) return;
    const payload = [...event.clipboardData.items];
    const items = pastedImageItems(payload);
    if (items.length === 0) return;
    /* Consume the paste only when the picture is all there was. A payload that
       also carries text still types that text into the box, so attaching an
       image never silently eats the words that came with it. */
    if (!clipboardCarriesText(payload)) event.preventDefault();
    const files = items
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    const room = attachmentRoom((attachments[key] ?? []).length);
    if (room === 0) {
      setError(describeStudioError(new Error(attachmentLimitMessage())));
      return;
    }
    setError(undefined);
    setAttaching((count) => count + 1);
    try {
      for (const file of files.slice(0, room)) {
        const stored = await m1.storeAttachment(
          projectId,
          await readAsDataUrl(file),
        );
        setAttachments((current) => {
          const existing = current[key] ?? [];
          if (
            existing.some(
              (entry) => entry.artifactId === stored.attachment.artifactId,
            )
          )
            return current;
          return { ...current, [key]: [...existing, stored.attachment] };
        });
      }
      if (files.length > room)
        setError(describeStudioError(new Error(attachmentLimitMessage())));
    } catch (cause) {
      setError(describeStudioError(cause));
    } finally {
      setAttaching((count) => count - 1);
    }
  };

  const removeAttachment = (key: string, artifactId: string) =>
    setAttachments((current) => ({
      ...current,
      [key]: (current[key] ?? []).filter(
        (entry) => entry.artifactId !== artifactId,
      ),
    }));

  const attachmentIds = (key: string): string[] =>
    (attachments[key] ?? []).map((entry) => entry.artifactId);

  const submitRound = async () => {
    if (!project || !round) return;
    const unanswered = round.questions.filter(
      (question) => !drafts[question.questionId]?.trim(),
    );
    if (unanswered.length > 0) {
      setError(
        describeStudioError(
          new Error("Every question in this round needs an answer."),
        ),
      );
      return;
    }
    await mutate("answers", () =>
      m1.answerFrontier(project.state.projectId, {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        roundId: round.roundId,
        answers: round.questions.map((question) => {
          const ids = attachmentIds(question.questionId);
          return {
            questionId: question.questionId,
            value: drafts[question.questionId]!.trim(),
            ...(ids.length > 0 ? { attachmentArtifactIds: ids } : {}),
          };
        }),
      }),
    );
    setAttachments({});
  };

  const confirmUnderstanding = async () => {
    if (!project?.state.interrogation) return;
    await mutate("confirm", () =>
      m1.confirmSharedUnderstanding(project.state.projectId, {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        confirmed: true,
      }),
    );
  };

  /** Ask for another batch. The steer is cleared on success because the next
   *  batch is the answer to it — leaving it in the box would read as pending. */
  const suggestNames = async () => {
    const candidates = project?.state.gameNameCandidates;
    if (!candidates || !nameFeedback.trim()) return;
    const next = await mutate("suggest-names", () =>
      m1.suggestGameNames(project!.state.projectId, {
        gameNameCandidatesRevisionId: candidates.revisionId,
        feedback: nameFeedback.trim(),
        ...(attachmentIds(NAME_FEEDBACK_KEY).length > 0
          ? { attachmentArtifactIds: attachmentIds(NAME_FEEDBACK_KEY) }
          : {}),
      }),
    );
    if (next) {
      setNameFeedback("");
      setNameChoice(undefined);
      setAttachments((current) => ({ ...current, [NAME_FEEDBACK_KEY]: [] }));
    }
  };

  const commitName = async () => {
    const candidates = project?.state.gameNameCandidates;
    if (!candidates) return;
    const typed = customName.trim();
    if (!typed && !nameChoice) return;
    await mutate("name-game", () =>
      m1.commitGameName(project!.state.projectId, {
        gameNameCandidatesRevisionId: candidates.revisionId,
        ...(typed ? { name: typed } : { candidateId: nameChoice! }),
      }),
    );
  };

  /* Deliberately not `mutate`: the descendant is an M2 world, and this studio
     is mounted on M1. Applying it here would render one frame of the wrong
     flow before the browser leaves. So the snapshot goes straight to the
     navigation, and — as with `openInOwnStudio` — `working` is left standing
     because the page is on its way out. */
  const continueIntoM2 = async (meshyCreditBudget?: number) => {
    if (!project) return;
    setWorking("continue-into-m2");
    setError(undefined);
    try {
      const seeded = await m1.continueIntoM2(project.state.projectId, {
        ...(meshyCreditBudget === undefined ? {} : { meshyCreditBudget }),
      });
      openInOwnStudio(seeded.state);
    } catch (cause) {
      setError(describeStudioError(cause));
      setWorking("");
    }
  };

  const decideGameDesign = async (
    decision: M1ApprovalInput["decision"],
    notes?: string,
  ) => {
    if (!project?.state.gameDesignSpec) return;
    /* Only approval triggers a model call (visual directions). The label is
       what keys the wait banner, so the fast decline paths use their own. */
    await mutate(decision === "approved" ? "approve-gds" : "gds-decision", () =>
      m1.approveGameDesign(project.state.projectId, {
        targetType: "game-design",
        targetRevisionId: project.state.gameDesignSpec!.revisionId,
        targetSha256: project.state.gameDesignSpec!.artifact.sha256,
        decision,
        ...(notes ? { notes } : {}),
      }),
    );
  };

  const submitRevise = async () => {
    if (!project?.state.gameDesignSpec || !reviseText.trim()) return;
    const next = await mutate("revise", () =>
      m1.reviseGameDesign(project.state.projectId, {
        gameDesignSpecRevisionId: project.state.gameDesignSpec!.revisionId,
        change: reviseText.trim(),
      }),
    );
    if (next) setReviseText("");
  };

  const decideDirection = async (decision: M1ApprovalInput["decision"]) => {
    if (!project || !direction) return;
    const sha256 = directionSha256(project, direction.revisionId);
    if (!sha256) {
      setError(
        describeStudioError(
          new Error(
            "This direction is missing its revision hash. Reload the project before approving.",
          ),
        ),
      );
      return;
    }
    await mutate("approve-direction", () =>
      m1.approveVisualDirection(project.state.projectId, {
        targetType: "visual-direction",
        targetRevisionId: direction.revisionId,
        targetSha256: sha256,
        decision,
      }),
    );
  };

  const submitReplace = async () => {
    if (
      !project?.state.visualDirectionSet ||
      !direction ||
      !replaceNotes.trim()
    )
      return;
    const next = await mutate("replace", () =>
      m1.replaceDirection(project.state.projectId, {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: direction.revisionId,
        notes: replaceNotes.trim(),
      }),
    );
    if (next) {
      setDirectionPanel("none");
      setReplaceNotes("");
    }
  };

  const submitChange = async () => {
    if (
      !project?.state.visualDirectionSet ||
      !direction ||
      !changeText.trim() ||
      pinnedAspects.length === 0
    )
      return;
    const next = await mutate("change", () =>
      m1.changeDirection(project.state.projectId, {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: direction.revisionId,
        change: changeText.trim(),
        pinnedAspects,
      }),
    );
    if (next) {
      setViewedDirectionId(next.state.selectedVisualDirectionRevisionId);
      setDirectionPanel("none");
      setChangeText("");
    }
  };

  const submitConceptPlan = async (
    promptOverrides?: ConfirmConceptPlanInput["promptOverrides"],
  ) => {
    if (!project?.state.conceptPlan) return;
    const overrides =
      promptOverrides && promptOverrides.length > 0
        ? promptOverrides
        : undefined;
    const retry: PendingStudioAction = {
      kind: "generate",
      conceptPlanRevisionId: project.state.conceptPlan.revisionId,
      ...(overrides ? { promptOverrides: overrides } : {}),
    };
    await mutate(
      "generate",
      () =>
        m1.confirmConceptPlan(project.state.projectId, {
          conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
          confirmed: true,
          ...(overrides ? { promptOverrides: overrides } : {}),
        }),
      retry,
    );
  };

  const submitRegenerate = async () => {
    if (!project?.state.conceptSet || !activeSlot) return;
    const retry: PendingStudioAction = {
      kind: "regenerate",
      conceptSetRevisionId: project.state.conceptSet.revisionId,
      slotId: activeSlot.slotId,
      ...(regenNotes.trim() ? { notes: regenNotes.trim() } : {}),
    };
    const next = await mutate(
      "regenerate",
      () =>
        m1.regenerateConcept(project.state.projectId, {
          conceptSetRevisionId: project.state.conceptSet!.revisionId,
          slotId: activeSlot.slotId,
          ...(regenNotes.trim() ? { notes: regenNotes.trim() } : {}),
        }),
      retry,
    );
    if (next) {
      const slot = next.conceptSet?.slots.find(
        (item) => item.slotId === activeSlot.slotId,
      );
      setViewedRevisionId(slot?.revisions.at(-1)?.revision.revisionId);
      setRegenNotes("");
    }
  };

  const keepRevision = async () => {
    if (!project?.state.conceptSet || !activeSlot || !viewedRevision) return;
    const next = await mutate("select", () =>
      m1.selectConcept(project.state.projectId, {
        conceptSetRevisionId: project.state.conceptSet!.revisionId,
        slotId: activeSlot.slotId,
        conceptRevisionId: viewedRevision.revisionId,
      }),
    );
    if (!next) return;
    /* Continue always moves. Clearing the pin only when every slot was kept
       left a revisited slot pinned, so the click re-selected the revision it
       already had and the screen sat still. */
    setInspectingSlotId(nextReviewSlotId(next, activeSlot.slotId));
    setViewedRevisionId(undefined);
  };

  const decideConceptSet = async (decision: M1ApprovalInput["decision"]) => {
    if (!project?.state.conceptSet) return;
    await mutate(
      milestone === "m2" && decision === "approved"
        ? "plan-assets"
        : "approve-set",
      () =>
        m1.approveConceptSet(project.state.projectId, {
          targetType: "concept-set",
          targetRevisionId: project.state.conceptSet!.revisionId,
          targetSha256: project.state.conceptSet!.artifact.sha256,
          decision,
        }),
    );
  };

  const submitSoundPlan = async (
    promptOverrides?: ConfirmSoundPlanInput["promptOverrides"],
  ) => {
    if (!project?.state.soundPlan) return;
    const overrides =
      promptOverrides && promptOverrides.length > 0
        ? promptOverrides
        : undefined;
    const retry: PendingStudioAction = {
      kind: "generate-sounds",
      soundPlanRevisionId: project.state.soundPlan.revisionId,
      ...(overrides ? { promptOverrides: overrides } : {}),
    };
    await mutate(
      "generate-sounds",
      () =>
        m1.confirmSoundPlan(project.state.projectId, {
          soundPlanRevisionId: project.state.soundPlan!.revisionId,
          confirmed: true,
          ...(overrides ? { promptOverrides: overrides } : {}),
        }),
      retry,
    );
  };

  const submitSoundRegenerate = async (slotId: string) => {
    if (!project?.state.soundSet) return;
    const notes = soundRegenNotes[slotId]?.trim();
    const retry: PendingStudioAction = {
      kind: "regenerate-sound",
      soundSetRevisionId: project.state.soundSet.revisionId,
      slotId,
      ...(notes ? { notes } : {}),
    };
    const next = await mutate(
      "regenerate-sound",
      () =>
        m1.regenerateSound(project.state.projectId, {
          soundSetRevisionId: project.state.soundSet!.revisionId,
          slotId,
          ...(notes ? { notes } : {}),
        }),
      retry,
    );
    if (next)
      setSoundRegenNotes((current) => {
        const updated = { ...current };
        delete updated[slotId];
        return updated;
      });
  };

  const decideSoundSet = async (decision: M1ApprovalInput["decision"]) => {
    if (!project?.state.soundSet) return;
    await mutate("approve-sounds", () =>
      m1.approveSoundSet(project.state.projectId, {
        targetType: "sound-set",
        targetRevisionId: project.state.soundSet!.revisionId,
        targetSha256: project.state.soundSet!.artifact.sha256,
        decision,
      }),
    );
  };

  const goHome = () => {
    navigation.current += 1;
    setRestoring(false);
    setProject(null);
    writeProjectId(null, milestone);
    setError(undefined);
    setPendingAction(undefined);
    setViewedStage(undefined);
  };

  /** The open dialog makes the rest of the page inert, so the trigger cannot
   *  take focus until React has removed it; the frame gives it that beat. */
  const closeWorlds = () => {
    setWorldsOpen(false);
    const trigger = worldsTrigger.current;
    if (!trigger) return;
    requestAnimationFrame(() => {
      if (trigger.isConnected) trigger.focus();
    });
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    const trigger = settingsTrigger.current;
    if (!trigger) return;
    requestAnimationFrame(() => {
      if (trigger.isConnected) trigger.focus();
    });
  };

  /** Switching worlds is a navigation: the epoch bump drops any snapshot
   *  already in flight for the world being left, exactly as goHome does. A
   *  world from the other milestone is a navigation in the browser's sense too
   *  — see `openInOwnStudio`. */
  const openWorld = (next: ProjectSnapshot) => {
    closeWorlds();
    if (next.state.projectId === project?.state.projectId) return;
    if (next.state.milestone !== milestone) {
      openInOwnStudio(next.state);
      return;
    }
    navigation.current += 1;
    setError(undefined);
    setPendingAction(undefined);
    setViewedStage(undefined);
    applySnapshot(next);
  };

  /** Stepping through the rail is a navigation too. `undefined` is "now".
   *  The epoch bump drops any snapshot issued before the step, so a poll that
   *  lands a beat later cannot move the user off the record they opened. */
  const showStage = (key: HotbarStageKey | undefined) => {
    navigation.current += 1;
    setViewedStage(key);
  };

  const dismissError = () => {
    setError(undefined);
    setPendingAction(undefined);
  };

  /** Raise whichever cap refused, then replay the same request. The two caps
   *  share a request but not a currency, so the branch is on which refusal is
   *  on screen — not on the project's routing. */
  const raiseBudgetAndRetry = async () => {
    if (!project || !pendingAction) return;
    const credits = error?.creditsRefused === true;
    if (credits) {
      if (
        !Number.isInteger(raiseCreditsDraft) ||
        raiseCreditsDraft <= (project.state.meshyCreditBudget ?? 0)
      )
        return;
    } else if (
      !Number.isFinite(raiseDraft) ||
      raiseDraft <= project.state.budgetUsd
    )
      return;
    const retry = pendingAction;
    const raised = await mutate("raise-budget", () =>
      m1.increaseBudget(
        project.state.projectId,
        credits
          ? { meshyCreditBudget: raiseCreditsDraft }
          : { budgetUsd: raiseDraft },
      ),
    );
    if (!raised) return;
    if (retry.kind === "generate") {
      await mutate(
        "generate",
        () =>
          m1.confirmConceptPlan(raised.state.projectId, {
            conceptPlanRevisionId: retry.conceptPlanRevisionId,
            confirmed: true,
            ...(retry.promptOverrides && retry.promptOverrides.length > 0
              ? { promptOverrides: retry.promptOverrides }
              : {}),
          }),
        retry,
      );
      return;
    }
    if (retry.kind === "generate-sounds") {
      await mutate(
        "generate-sounds",
        () =>
          m1.confirmSoundPlan(raised.state.projectId, {
            soundPlanRevisionId: retry.soundPlanRevisionId,
            confirmed: true,
            ...(retry.promptOverrides && retry.promptOverrides.length > 0
              ? { promptOverrides: retry.promptOverrides }
              : {}),
          }),
        retry,
      );
      return;
    }
    if (retry.kind === "regenerate-sound") {
      const next = await mutate(
        "regenerate-sound",
        () =>
          m1.regenerateSound(raised.state.projectId, {
            soundSetRevisionId: retry.soundSetRevisionId,
            slotId: retry.slotId,
            ...(retry.notes ? { notes: retry.notes } : {}),
          }),
        retry,
      );
      if (next)
        setSoundRegenNotes((current) => {
          const updated = { ...current };
          delete updated[retry.slotId];
          return updated;
        });
      return;
    }
    const next = await mutate(
      "regenerate",
      () =>
        m1.regenerateConcept(raised.state.projectId, {
          conceptSetRevisionId: retry.conceptSetRevisionId,
          slotId: retry.slotId,
          ...(retry.notes ? { notes: retry.notes } : {}),
        }),
      retry,
    );
    if (next) {
      const slot = next.conceptSet?.slots.find(
        (item) => item.slotId === retry.slotId,
      );
      setViewedRevisionId(slot?.revisions.at(-1)?.revision.revisionId);
      setRegenNotes("");
    }
  };

  const resumeBlockedProject = async (nextBudget?: number) => {
    if (!project?.state.blockedReason?.recoverable) return;
    let resumable = project;
    /* Which cap refused, from the stored refusal itself. Reading it off the
       project's routing sent a USD stop on a live M2 Meshy world into the
       credit endpoint, which raised the wrong cap and left the run blocked. */
    const budgetKind = blockedBudgetKind(project.state.blockedReason);
    if (budgetKind !== undefined) {
      const meshyCredits = budgetKind === "meshy-credits";
      const currentBudget = meshyCredits
        ? (project.state.meshyCreditBudget ?? 0)
        : project.state.budgetUsd;
      if (
        nextBudget === undefined ||
        !Number.isFinite(nextBudget) ||
        nextBudget <= currentBudget
      )
        return;
      const raised = await mutate("raise-budget", () =>
        m1.increaseBudget(
          project.state.projectId,
          meshyCredits
            ? { meshyCreditBudget: nextBudget }
            : { budgetUsd: nextBudget },
        ),
      );
      if (!raised) return;
      resumable = raised;
    }
    await mutate("resume-project", () =>
      m1.advanceProject(resumable.state.projectId),
    );
  };

  /** A rejection is a paused decision. Reopening puts the same revisions back
   *  in front of the user at the gate they rejected — no generation, no spend
   *  — so it needs no confirmation and no cap to raise. */
  const reopenReview = async (gate: ApprovalGate) => {
    if (!project) return;
    await mutate("reopen-review", () =>
      m1.reopenApprovalReview(project.state.projectId, gate),
    );
  };

  const title = project ? projectTitle(project) : "Untitled world";
  const replacementUsed = (project?.state.directionReplacementCount ?? 0) >= 1;
  const changeUsed = (project?.state.focusedDirectionChangeCount ?? 0) >= 1;
  const needsGameDesignRevise =
    project?.state.gameDesignApproval?.decision === "changes-requested" &&
    project.state.gameDesignApproval.targetRevisionId ===
      project.state.gameDesignSpec?.revisionId;

  const renderStage = () => {
    if (generating && project)
      return (
        <section className="vx-generating">
          <span className="vx-kicker">
            <i />
            {generatingSounds ? "Sound palette" : "ImageGen"}
          </span>
          <h1>
            {generatingSounds
              ? liveSoundGeneratingCopy(project.state.mode)
              : liveGeneratingCopy(project.state.mode)}
          </h1>
          <p>This can take a few minutes. Keep this page open.</p>
          <span className="vx-thinking-clock">
            <WaitClock startedAt={waitStartedAt} /> elapsed
          </span>
          {((generatingImages &&
            project.state.mode === "live" &&
            isMeteredImageProvider(project.state.imageProvider)) ||
            (generatingSounds &&
              project.state.mode === "live" &&
              isMeteredSoundProvider(project.state.soundProvider))) && (
            <BudgetChip project={project} />
          )}
        </section>
      );
    /* A `project` URL param means the shell already knows a world is coming.
       Rendering the new-world hero and "No worlds yet" for the 2–29s the list
       takes is a confident lie, so the stage stays quiet until it resolves. */
    if (screen === "home" && restoring)
      return (
        <section aria-live="polite" className="vx-restoring">
          <span className="vx-kicker">
            <i />
            Restoring
          </span>
          <strong>Restoring your world…</strong>
          <p>Reading the project this link points at from the coordinator.</p>
        </section>
      );
    if (screen === "home")
      return (
        <HomeScreen
          brief={brief}
          budgetUsd={budgetUsd}
          meshyCreditBudget={meshyCreditBudget}
          busy={busy}
          configuration={configuration}
          elevenLabsReady={elevenLabsReady}
          imageProvider={imageProvider}
          implementationProvider={implementationProvider}
          level={level}
          mode={mode}
          milestone={milestone}
          orchestratorProvider={orchestratorProvider}
          projects={projects}
          rightsConfirmed={rightsConfirmed}
          soundProvider={soundProvider}
          onBrief={setBrief}
          onBudget={setBudgetUsd}
          onMeshyCreditBudget={setMeshyCreditBudget}
          onCreate={() => void createProject()}
          onMode={chooseMode}
          onOpen={(next) => {
            if (next.state.milestone !== milestone) {
              openInOwnStudio(next.state);
              return;
            }
            applySnapshot(next);
          }}
          onOpenSettings={(trigger) => {
            settingsTrigger.current = trigger;
            setSettingsOpen(true);
          }}
          onRights={setRightsConfirmed}
          onSoundProvider={setSoundProvider}
        />
      );
    if (!project) return null;
    /* Once planning writes a plan, the asset gate owns the rest of M2. The
       workflow finalizes the plan between those stages, so there is no review
       screen between the concept package and this inventory. */
    if (assetFlowOwner(project) === "gate") {
      return (
        <AssetGatePrototype onSnapshot={applySnapshot} project={project} />
      );
    }
    if (screen === "interrogation")
      return (
        <InterrogationScreen
          attachments={attachments}
          busy={busy || attaching > 0}
          drafts={drafts}
          level={level}
          palette={world.palette}
          project={project}
          round={round}
          styled={world.styled}
          onChange={(questionId, value) =>
            setDrafts((current) => ({ ...current, [questionId]: value }))
          }
          onPaste={(questionId, event) => void pasteImages(questionId, event)}
          onRemoveAttachment={removeAttachment}
          onSubmit={() => void submitRound()}
        />
      );
    if (screen === "shared-understanding")
      return (
        <SignoffScreen
          answers={answers}
          busy={busy}
          level={level}
          palette={world.palette}
          project={project}
          styled={world.styled}
          onConfirm={() => void confirmUnderstanding()}
        />
      );
    if (screen === "game-name")
      return (
        <GameNameScreen
          attachments={attachments[NAME_FEEDBACK_KEY] ?? []}
          busy={busy || attaching > 0}
          candidateId={nameChoice}
          customName={customName}
          feedback={nameFeedback}
          project={project}
          onCandidate={(candidateId) => {
            setNameChoice(candidateId);
            setCustomName("");
          }}
          onCommit={() => void commitName()}
          onCustomName={(value) => {
            setCustomName(value);
            if (value.trim()) setNameChoice(undefined);
          }}
          onFeedback={setNameFeedback}
          onPaste={(event) => void pasteImages(NAME_FEEDBACK_KEY, event)}
          onRemoveAttachment={(artifactId) =>
            removeAttachment(NAME_FEEDBACK_KEY, artifactId)
          }
          onSuggest={() => void suggestNames()}
        />
      );
    if (screen === "game-design")
      return (
        <GameDesignScreen
          busy={busy}
          needsRevise={needsGameDesignRevise}
          project={project}
          reviseText={reviseText}
          onApprove={() => void decideGameDesign("approved")}
          onReject={() => void decideGameDesign("rejected")}
          onRequestChanges={() =>
            void decideGameDesign(
              "changes-requested",
              "Please revise the Game Design Spec.",
            )
          }
          onRevise={() => void submitRevise()}
          onReviseText={setReviseText}
        />
      );
    if (screen === "visual-direction" && direction)
      return (
        <DirectionScreen
          busy={busy}
          changeText={changeText}
          changeUsed={changeUsed}
          direction={direction}
          directions={project.visualDirections?.directions ?? []}
          panel={directionPanel}
          pinnedAspects={pinnedAspects}
          project={project}
          replaceNotes={replaceNotes}
          replacementUsed={replacementUsed}
          onApprove={() => void decideDirection("approved")}
          onChangeText={setChangeText}
          onOpenPanel={setDirectionPanel}
          onPinnedAspects={setPinnedAspects}
          onReject={() => void decideDirection("rejected")}
          onReplaceNotes={setReplaceNotes}
          onSubmitChange={() => void submitChange()}
          onSubmitReplace={() => void submitReplace()}
          onView={setViewedDirectionId}
        />
      );
    if (screen === "concept-plan")
      return (
        <ConceptPlanScreen
          busy={busy}
          project={project}
          onConfirm={(promptOverrides) =>
            void submitConceptPlan(promptOverrides)
          }
        />
      );
    if (screen === "concept-review" && showPackage)
      return (
        <PackageScreen
          busy={busy}
          project={project}
          onApprove={() => void decideConceptSet("approved")}
          onReject={() => void decideConceptSet("rejected")}
          onReview={(slotId) => {
            setInspectingSlotId(slotId);
            setViewedRevisionId(undefined);
          }}
        />
      );
    if (screen === "concept-review" && activeSlot)
      return (
        <ConceptReviewScreen
          busy={busy}
          notes={regenNotes}
          project={project}
          revisions={revisions}
          slot={activeSlot}
          viewed={viewedRevision}
          onKeep={() => void keepRevision()}
          onNotes={setRegenNotes}
          onPackage={() => setInspectingSlotId(undefined)}
          onRegenerate={() => void submitRegenerate()}
          onViewRevision={setViewedRevisionId}
          onViewSlot={(slotId) => {
            setInspectingSlotId(slotId);
            setViewedRevisionId(undefined);
          }}
        />
      );
    if (screen === "asset-planning")
      return (
        <section className="m2-batch-screen">
          <span className="m1-kicker">
            {project.state.assetPlanApproval?.decision === "changes-requested"
              ? "Asset plan · changes requested"
              : "Asset planning"}
          </span>
          <h1>
            {project.state.assetPlanApproval?.decision === "changes-requested"
              ? "Revising the production batch…"
              : "Building the production plan…"}
          </h1>
          <p>
            Fulcrum is binding every asset to the approved Game Design Spec and
            concept revisions.
          </p>
        </section>
      );
    if (screen === "asset-batch")
      return (
        <section className="m2-batch-screen">
          <span className="m1-kicker">Approved asset batch</span>
          <h1>Producing and checking each asset…</h1>
          <p>
            Dependencies run in order. Each asset keeps its deterministic gates,
            turntable evidence, semantic findings, and regeneration trail.
          </p>
        </section>
      );
    if (screen === "sound-plan")
      return (
        <SoundPlanScreen
          busy={busy}
          project={project}
          onConfirm={(promptOverrides) => void submitSoundPlan(promptOverrides)}
        />
      );
    if (screen === "sound-review")
      return (
        <SoundPlaybackScreen
          busy={busy}
          notes={soundRegenNotes}
          project={project}
          onApprove={() => void decideSoundSet("approved")}
          onNotes={(slotId, value) =>
            setSoundRegenNotes((current) => ({ ...current, [slotId]: value }))
          }
          onRegenerate={(slotId) => void submitSoundRegenerate(slotId)}
          onReject={() => void decideSoundSet("rejected")}
        />
      );
    if (screen === "complete")
      return milestone === "m2" ? (
        <M2CompleteScreen project={project} />
      ) : (
        <CompleteScreen
          busy={busy}
          project={project}
          onContinue={(meshyCreditBudget) =>
            void continueIntoM2(meshyCreditBudget)
          }
        />
      );
    if (screen === "blocked")
      return (
        <BlockedScreen
          busy={busy}
          project={project}
          onReopen={(gate) => void reopenReview(gate)}
          onResume={(nextBudgetUsd) => void resumeBlockedProject(nextBudgetUsd)}
        />
      );
    return null;
  };

  /* A completed stage, rendered from whatever the snapshot still carries.
     Nothing here is wired to a mutation: the callbacks are stubs and the
     <fieldset disabled> around the whole thing means none of them is even
     reachable. */
  const noop = () => {};
  const renderHistoryStage = () => {
    if (!project || !historyScreen) return null;
    switch (historyScreen) {
      case "pitch-record":
        return <PitchRecordScreen project={project} />;
      case "shared-understanding":
        return (
          <SignoffScreen
            answers={answers}
            busy
            level={level}
            palette={world.palette}
            project={project}
            styled={world.styled}
            onConfirm={noop}
          />
        );
      case "game-design":
        return (
          <GameDesignScreen
            busy
            needsRevise={false}
            project={project}
            reviseText=""
            onApprove={noop}
            onReject={noop}
            onRequestChanges={noop}
            onRevise={noop}
            onReviseText={noop}
          />
        );
      case "visual-direction":
        return direction ? (
          <DirectionScreen
            busy
            changeText=""
            changeUsed
            direction={direction}
            directions={project.visualDirections?.directions ?? []}
            panel="none"
            pinnedAspects={pinnedAspects}
            project={project}
            replaceNotes=""
            replacementUsed
            onApprove={noop}
            onChangeText={noop}
            onOpenPanel={noop}
            onPinnedAspects={noop}
            onReject={noop}
            onReplaceNotes={noop}
            onSubmitChange={noop}
            onSubmitReplace={noop}
            onView={setViewedDirectionId}
          />
        ) : (
          <StageRecordUnavailable stage={viewedStage} />
        );
      case "concept-review":
        return (
          <PackageScreen
            busy
            project={project}
            onApprove={noop}
            onReject={noop}
            onReview={noop}
          />
        );
      case "sound-review":
        return (
          <SoundPlaybackScreen
            busy
            notes={{}}
            project={project}
            onApprove={noop}
            onNotes={noop}
            onRegenerate={noop}
            onReject={noop}
          />
        );
      case "unavailable":
        return <StageRecordUnavailable stage={viewedStage} />;
    }
  };

  if (bootError)
    return (
      <main className="m1-prototype variant-b-voxel m1-studio">
        <div className="vx-paper" aria-hidden="true" />
        <section className="vx-generating">
          <h1>Fulcrum could not start.</h1>
          <p>{bootError}</p>
        </section>
      </main>
    );

  const conceptHost = historyScreen
    ? stageHistoryUsesConceptHost(historyScreen)
    : screen === "concept-plan" ||
      screen === "concept-review" ||
      screen === "sound-plan" ||
      screen === "sound-review" ||
      screen === "asset-planning" ||
      screen === "asset-batch" ||
      screen === "complete" ||
      screen === "blocked";

  const headerTitle = restoring
    ? "Reading this world"
    : title.length > 62
      ? `${title.slice(0, 62)}…`
      : title;

  return (
    <main
      className="m1-prototype variant-b-voxel m1-studio"
      data-forged={forged ? "true" : "false"}
      data-history={historyScreen ? "true" : "false"}
      data-mascot={
        restoring ||
        /* A completed stage is a record, not a build step: Rusty has nothing
           to place there, so he steps off rather than posing over old work. */
        historyScreen !== undefined ||
        /* Naming is a full-width reading screen with no world panel to dock
           against, so Rusty would stand in front of the commit button. */
        screen === "game-name" ||
        (milestone === "m2" &&
          ["asset-planning", "asset-batch", "complete"].includes(screen))
          ? "off"
          : mascot.visible
            ? "on"
            : "off"
      }
      data-restoring={restoring ? "true" : "false"}
      data-stage={historyScreen ?? screen}
    >
      <div className="vx-paper" aria-hidden="true" />
      {/* The world's name is line one and the largest thing on the bar; the
          settings that never change during a session — status, LIVE/REPLAY,
          routing — drop to a quiet meta row beneath it. */}
      <header className="vx-topbar">
        <div className="vx-brand">
          <VoxelCube className="vx-cube-brand" tone="glow" />
          <span>
            <strong>FULCRUM</strong>
            <small>WORLD FORGE</small>
          </span>
        </div>
        <div className="vx-plaque">
          <strong className={restoring ? "vx-plaque-skeleton" : undefined}>
            {headerTitle}
          </strong>
          {project ? (
            <span className="vx-plaque-meta">
              <StatusPill state={project.state} />
              <span className="vx-mode-tag">{project.state.mode}</span>
              <RouteChip state={project.state} />
            </span>
          ) : restoring ? (
            /* A `project` URL param promises a world the shell cannot describe
               for 2–29s, so both plaque lines run as skeleton bars: the name
               above, and one bar holding the height and width of the meta row
               it is about to become. */
            <span className="vx-plaque-meta">
              <small className="vx-plaque-skeleton vx-plaque-meta-skeleton">
                Restoring
              </small>
            </span>
          ) : (
            <small>WORLD SLOT 01</small>
          )}
        </div>
        <div className="vx-session">
          {project && <BudgetChip compact project={project} />}
          {/* Routing lives here rather than in the create form, where three
              selects shared a third of a narrow column each and clipped their
              own option text. */}
          <button
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            className="vx-session-link"
            onClick={() => setSettingsOpen(true)}
            ref={settingsTrigger}
            type="button"
          >
            Settings
          </button>
          {/* With a world loaded WORLDS is a picker, not a teardown. With none
              loaded the landing page already is the picker, so the button keeps
              its old job of returning to it. */}
          <button
            aria-expanded={project ? worldsOpen : undefined}
            aria-haspopup={project ? "dialog" : undefined}
            className="vx-session-link"
            onClick={project ? () => setWorldsOpen(true) : goHome}
            ref={worldsTrigger}
            type="button"
          >
            Worlds
          </button>
        </div>
      </header>
      <div className={conceptHost ? "vx-stage vx-stage-concepts" : "vx-stage"}>
        {waitView && (
          <ModelWaitBanner
            key={`${effectiveWorking}:${waitStartedAt ?? "local"}`}
            startedAt={waitStartedAt}
            view={waitView}
          />
        )}
        {error && (
          <StudioError
            busy={busy}
            creditPrompt={creditRaisePrompt}
            prompt={raisePrompt}
            raiseBudgetUsd={raiseDraft}
            raiseCredits={raiseCreditsDraft}
            view={error}
            onDismiss={dismissError}
            onRaiseBudgetUsd={setRaiseDraft}
            onRaiseCredits={setRaiseCreditsDraft}
            onRetry={() => void raiseBudgetAndRetry()}
          />
        )}
        {historyScreen && viewedStage ? (
          <>
            <div className="vx-history-banner" role="status">
              <span>
                <em>Viewing completed stage</em>
                <strong>{HOTBAR_STAGE_LABELS[viewedStage]}</strong>
              </span>
              <button
                className="vx-secondary"
                onClick={() => showStage(undefined)}
                type="button"
              >
                Back to now
              </button>
            </div>
            {/* One disabled fieldset around the whole record. Every control
                inside — approve, reject, regenerate, submit, retry — is
                unreachable by construction rather than by remembering to pass
                a flag into each screen. */}
            <fieldset className="vx-history-frame" disabled>
              {conceptHost ? (
                <div className="voxel-concept-host">{renderHistoryStage()}</div>
              ) : (
                renderHistoryStage()
              )}
            </fieldset>
          </>
        ) : conceptHost ? (
          <div className="voxel-concept-host">{renderStage()}</div>
        ) : (
          renderStage()
        )}
        {milestone === "m1" &&
          screen === "complete" &&
          !historyScreen &&
          project && (
            <div
              className="vx-finale"
              data-flag={flagPlaced ? "placed" : "pending"}
              data-mascot-frame="finale"
            >
              <VoxelWorld
                direction={{ palette: world.palette }}
                follows={false}
                level={voxelMaxLevel}
                size="md"
                styled={world.styled}
              />
              <span>
                World forged · {world.directionName ?? projectTitle(project)}
              </span>
            </div>
          )}
        {/* Mounted inside the stage scroller on purpose: his containing block
            is the scrolled content, so free parking and measured docks both
            move with the scene he is composed into — scrolling can never
            separate him from his perch. (A viewport-fixed mascot also nulls
            offsetParent, which silently disables every measured dock.) */}
        {/* decisions is his trip counter (one unit = one walk), not the raw
            snapshot count: reloads sync the world without queueing walks, a
            multi-answer round queues one walk per world level, and each
            carried block is aimed at the level about to appear (shown + 1). */}
        <MascotStage
          decisions={trips}
          onFlagPlaced={plantFlag}
          onPlace={place}
          placeLevel={shown + 1}
          queue
          screen={mascot.screen}
          /* The generating screen is a wait, not a build step: he sits with
             nothing to do rather than performing a fetch for a block the
             screen has nowhere to put. */
          waiting={generating}
        />
      </div>
      {/* Four visually distinct tiers, one per state: done (filled cube, ink
          label), current (paper fill, ink border, teal ring), blocked (alert
          tone) and locked (dashed, dimmed). The tier is carried by the data
          attributes, never by `:disabled` — that rule used to be declared after
          `[data-active]` and flattened all five tiles to the same 2.8:1 grey.

          The rail is a navigation as well as a readout: a stage the project has
          already been through opens that stage's record, read-only, and the
          current tile comes back to now. Future and never-reached tiles stay
          disabled, because there is nothing behind them to show.

          `data-tone` on the current tile comes from `studioStatus` — the same
          formatter behind the header pill and the world cards — so the rail
          cannot claim the forge is running while the pill says it needs you. */}
      <footer className="vx-hotbar" aria-label="Workflow hotbar">
        {navigableHotbar.map((slot, index) => (
          <button
            aria-current={slot.viewing ? "true" : undefined}
            className="vx-slot"
            data-active={slot.active ? "true" : "false"}
            data-blocked={slot.blocked ? "true" : "false"}
            data-filled={slot.filled ? "true" : "false"}
            data-locked={slot.locked ? "true" : "false"}
            data-stage={slot.key}
            data-tone={slot.statusTone ?? "none"}
            data-viewing={slot.viewing ? "true" : "false"}
            disabled={!slot.navigable}
            key={slot.key}
            onClick={() =>
              showStage(slot.key === currentKey ? undefined : slot.key)
            }
            title={
              slot.navigable
                ? slot.key === currentKey
                  ? `${slot.label} · where this world is now`
                  : `View the ${slot.label} record`
                : undefined
            }
            type="button"
          >
            <em>{index + 1}</em>
            <span className="vx-slot-item">
              {slot.filled ? (
                <VoxelCube className="vx-cube-slot" tone={slot.tone} />
              ) : (
                <i className="vx-slot-empty" />
              )}
            </span>
            <span className="vx-slot-copy">
              <strong>{slot.label}</strong>
              <small>{slot.viewing ? "Viewing record" : slot.status}</small>
            </span>
          </button>
        ))}
      </footer>
      {settingsOpen && (
        <SettingsOverlay
          configuration={configuration}
          imageProvider={imageProvider}
          implementationProvider={implementationProvider}
          milestone={milestone}
          mode={mode}
          orchestratorProvider={orchestratorProvider}
          project={project}
          onClose={closeSettings}
          onImageProvider={setImageProvider}
          onImplementationProvider={setImplementationProvider}
          onOrchestratorProvider={setOrchestratorProvider}
          onSnapshot={applySnapshot}
        />
      )}
      {worldsOpen && project && (
        <WorldsOverlay
          currentProjectId={project.state.projectId}
          projects={projects}
          onClose={closeWorlds}
          onCreate={() => {
            closeWorlds();
            goHome();
          }}
          onOpen={openWorld}
        />
      )}
    </main>
  );
}

function HomeScreen({
  brief,
  budgetUsd,
  meshyCreditBudget,
  busy,
  configuration,
  elevenLabsReady,
  imageProvider,
  implementationProvider,
  level,
  mode,
  milestone,
  orchestratorProvider,
  projects,
  rightsConfirmed,
  soundProvider,
  onBrief,
  onBudget,
  onMeshyCreditBudget,
  onCreate,
  onMode,
  onOpen,
  onOpenSettings,
  onRights,
  onSoundProvider,
}: {
  brief: string;
  budgetUsd: number;
  meshyCreditBudget: number;
  busy: boolean;
  configuration: ConfigurationStatus | null;
  elevenLabsReady: ConfigurationStatus["soundProviders"][number] | undefined;
  imageProvider: ImageProvider;
  implementationProvider: ExecutionProvider;
  level: number;
  mode: ProviderMode;
  milestone: "m1" | "m2";
  orchestratorProvider: ExecutionProvider;
  projects: ProjectSnapshot[];
  rightsConfirmed: boolean;
  soundProvider: SoundProvider;
  onBrief: (value: string) => void;
  onBudget: (value: number) => void;
  onMeshyCreditBudget: (value: number) => void;
  onCreate: () => void;
  onMode: (mode: ProviderMode) => void;
  onOpen: (project: ProjectSnapshot) => void;
  onOpenSettings: (trigger: HTMLButtonElement) => void;
  onRights: (value: boolean) => void;
  onSoundProvider: (provider: SoundProvider) => void;
}) {
  const routing = {
    mode,
    orchestratorProvider:
      mode === "replay" ? ("openai" as const) : orchestratorProvider,
    implementationProvider:
      mode === "replay" ? ("openai" as const) : implementationProvider,
    imageProvider: mode === "live" ? imageProvider : ("none" as const),
    soundProvider:
      milestone === "m2"
        ? ("none" as const)
        : mode === "live"
          ? soundProvider
          : ("none" as const),
  };
  const showBudget = showsMeteredBudget({ milestone, ...routing });
  const showMeshyCredits = showsMeshyCreditBudget({ milestone, mode });

  return (
    <section className="vx-start">
      <div className="vx-start-copy">
        <span className="vx-kicker">
          <i />
          New world · {milestone.toUpperCase()} studio
        </span>
        <h1>
          Build the game
          <br />
          one block
          <br />
          at a time.
        </h1>
        <p>
          The brief, every interrogation round, and every approval live on the
          coordinator. Reload this page mid-flow and you land exactly where the
          project is.
        </p>
        <label className="vx-composer">
          <span className="vx-composer-head">
            <strong>Name the world you want to build</strong>
            <small>{brief.trim().length} chars</small>
          </span>
          <textarea
            aria-label="Describe your project"
            onChange={(event) => onBrief(event.target.value)}
            placeholder="A game where the player…"
            value={brief}
          />
          {/* Two unlabelled 2x2 grids ran together as one four-card block, so
              neither pair read as a choice about anything. Each pair now sits
              under its own mono micro-cap, which is the same label idiom the
              routing block below already uses. */}
          <div className="vx-choice-group">
            <span className="vx-choice-label">World mode</span>
            <div className="vx-mode-row">
              <button
                className={mode === "replay" ? "selected" : ""}
                onClick={() => onMode("replay")}
                type="button"
              >
                <strong>Replay</strong>
                <small>Offline · no ImageGen spend</small>
              </button>
              <button
                className={mode === "live" ? "selected" : ""}
                onClick={() => onMode("live")}
                type="button"
              >
                <strong>Live</strong>
                <small>OpenAI subscription ImageGen</small>
              </button>
            </div>
          </div>
          {mode === "live" && milestone === "m1" && (
            <div className="vx-choice-group">
              <span className="vx-choice-label">Sound</span>
              <div className="vx-mode-row vx-sound-provider-row">
                <button
                  className={soundProvider === "elevenlabs" ? "selected" : ""}
                  onClick={() => onSoundProvider("elevenlabs")}
                  type="button"
                >
                  <strong>ElevenLabs</strong>
                  <small>
                    {elevenLabsReady?.ready
                      ? (elevenLabsReady.detail ?? "Sound effects")
                      : (elevenLabsReady?.detail ?? "Needs ELEVENLABS_API_KEY")}
                  </small>
                </button>
                <button
                  className={soundProvider === "none" ? "selected" : ""}
                  onClick={() => onSoundProvider("none")}
                  type="button"
                >
                  <strong>None</strong>
                  <small>Deterministic WAV · no spend</small>
                </button>
              </div>
            </div>
          )}
          {/* The three selects moved into SETTINGS, where a full-width field
              can hold "Claude Subscription" without clipping it. What is left
              here is the sentence that says what will be saved onto the world,
              and the way back to the sheet that changes it. */}
          {/* The summary used to share a flex row with the button, so a
              three-route sentence wrapped into the button's left edge. Heading
              and button hold the top line; the sentence gets the card's whole
              width underneath and stays one line. */}
          <div className="vx-routing-row">
            <strong className="vx-routing-row-title">Model routing</strong>
            <button
              className="vx-secondary"
              onClick={(event) => onOpenSettings(event.currentTarget)}
              type="button"
            >
              Change in settings
            </button>
            <small className="vx-routing-row-summary">
              {routingSummary(routing)}
            </small>
          </div>
          {/* Both caps can apply at once — a live M2 world buys geometry with
              Meshy credits and its planning/vision calls with dollars — and
              the form used to render these as a two-way choice, so on M2 the
              credit field won and the USD field was never shown. The seeded
              $1 was submitted anyway and the run hard-stopped after roughly
              three calls at a cap the user never chose. Every cap that will be
              submitted is now on screen. */}
          {showMeshyCredits && (
            <label className="vx-budget-field">
              <span>Meshy credit budget</span>
              <input
                aria-label="Meshy credit budget"
                min={30}
                onChange={(event) =>
                  onMeshyCreditBudget(Number(event.target.value))
                }
                step={10}
                type="number"
                value={meshyCreditBudget}
              />
              <small>
                A static Meshy 6 asset reserves 20 credits for geometry and 10
                for 4K texturing. 300 credits funds ten first-pass assets;
                regeneration and character rigging are extra.
              </small>
            </label>
          )}
          {showBudget && (
            <label className="vx-budget-field">
              <span>Metered spend cap USD</span>
              <input
                aria-label="Budget in USD"
                min={0.01}
                onChange={(event) => onBudget(Number(event.target.value))}
                step={0.01}
                type="number"
                value={budgetUsd}
              />
              <small>
                Only the metered routes you picked above are billed against
                this; subscription and local routes are not. Fulcrum stops the
                run rather than pass it, so set it to a number a whole run can
                live inside — a text call reserves $0.25 and an image $0.20.
              </small>
            </label>
          )}
          {!showMeshyCredits && !showBudget && (
            <p className="vx-routing-cost-note">{routingCostNote(routing)}</p>
          )}
          {/* The footnote used to sit in the button's row, where 240px of
              mono wrapped to two lines against the CTA. It reads as a caption
              on the spend rules above it, so it goes there — and the two
              things you actually do share the last line. */}
          <span className="vx-composer-note">
            <small>
              {mode === "live"
                ? showMeshyCredits && showBudget
                  ? "Meshy stops at the credit cap; metered calls stop at the USD cap"
                  : showMeshyCredits
                    ? "Meshy calls stop before exceeding the credit budget"
                    : showBudget
                      ? "Metered calls stop at the USD cap"
                      : imageProvider === "openai-subscription"
                        ? "Live ImageGen uses your signed-in OpenAI subscription"
                        : "Subscription and local routes only · no metered spend"
                : configuration?.fixtureBrief
                  ? "Replay fixtures stay on this machine"
                  : "Replay mode"}
            </small>
          </span>
          <span className="vx-composer-foot">
            <label className="vx-rights">
              <input
                checked={rightsConfirmed}
                onChange={(event) => onRights(event.target.checked)}
                type="checkbox"
              />
              I confirm the rights to this brief.
            </label>
            <button
              className="vx-primary"
              disabled={
                busy ||
                brief.trim().length < 40 ||
                !rightsConfirmed ||
                (showMeshyCredits &&
                  (!Number.isInteger(meshyCreditBudget) ||
                    meshyCreditBudget < 30)) ||
                (showBudget && (!Number.isFinite(budgetUsd) || budgetUsd <= 0))
              }
              onClick={onCreate}
              type="button"
            >
              Create world <i>▸</i>
            </button>
          </span>
        </label>
      </div>
      <div className="vx-home-side">
        <div className="vx-start-world">
          <VoxelWorld
            direction={{ palette: [] }}
            level={level}
            size="lg"
            styled={false}
          />
        </div>
        <div className="vx-project-list">
          <span className="vx-kicker">
            <i />
            Resume a world
          </span>
          {projects.length === 0 ? (
            <div className="vx-empty-worlds">
              <strong>No worlds yet</strong>
              <p>Create one on the left. Reloading mid-flow will restore it.</p>
            </div>
          ) : (
            <ul>
              {projects.map((item) => (
                <li key={item.state.projectId}>
                  <WorldCard current={false} project={item} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The pasted-image row under a text box.
 *
 * Two jobs, and it does not pretend to a third: show what is attached (so the
 * user can take one back out before sending), and say plainly where those
 * images go. `note` is the routing sentence — on a replay world or a
 * text-only orchestrator it says the picture is kept but unread, because a
 * thumbnail on its own would imply the model can see it.
 */
function AttachmentStrip({
  attachments,
  busy,
  note,
  onRemove,
}: {
  attachments: ArtifactRef[];
  busy: boolean;
  note: string;
  onRemove: (artifactId: string) => void;
}) {
  return (
    <div className="vx-attach">
      <ul className="vx-attach-strip">
        {attachments.map((attachment, index) => (
          <li key={attachment.artifactId}>
            <img alt={`Attached image ${index + 1}`} src={attachment.uri} />
            <button
              aria-label={`Remove attached image ${index + 1}`}
              disabled={busy}
              onClick={() => onRemove(attachment.artifactId)}
              type="button"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <small className="vx-attach-note">{note}</small>
    </div>
  );
}

/** Thumbnails on a recorded answer. Read-only: the answer is project truth. */
function RecordedAttachments({ answer }: { answer: RecordedAnswer }) {
  if (answer.attachments.length === 0) return null;
  return (
    <ul className="vx-attach-strip vx-attach-strip-recorded">
      {answer.attachments.map((attachment, index) => (
        <li key={attachment.artifactId}>
          <img alt={`Attached image ${index + 1}`} src={attachment.uri} />
        </li>
      ))}
    </ul>
  );
}

function InterrogationScreen({
  attachments,
  busy,
  drafts,
  level,
  palette,
  project,
  round,
  styled,
  onChange,
  onPaste,
  onRemoveAttachment,
  onSubmit,
}: {
  attachments: Record<string, ArtifactRef[]>;
  busy: boolean;
  drafts: Record<string, string>;
  level: number;
  palette: string[];
  project: ProjectSnapshot;
  round: ReturnType<typeof currentRound>;
  styled: boolean;
  onChange: (questionId: string, value: string) => void;
  onPaste: (
    questionId: string,
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => void;
  onRemoveAttachment: (questionId: string, artifactId: string) => void;
  onSubmit: () => void;
}) {
  const completed = (project.interrogation?.rounds ?? []).filter(
    (item) => item.completedAt !== undefined,
  );
  const questions = round?.questions ?? [];
  return (
    <section className="vx-understand vx-round">
      <aside className="vx-rail">
        <div className="vx-rail-head">
          <span className="vx-kicker">
            <i />
            Build log
          </span>
          <h2>Understand the game</h2>
        </div>
        <ol className="vx-quests">
          {completed.map((item, index) => (
            <li data-state="done" key={item.roundId}>
              <i>✓</i>
              <span>Round {index + 1} recorded</span>
            </li>
          ))}
          {questions.map((question, index) => (
            <li data-state="active" key={question.questionId}>
              <i>{index + 1}</i>
              <span>{question.branchId}</span>
            </li>
          ))}
        </ol>
        <div className="vx-rail-world" data-mascot-frame="capture">
          <VoxelWorld
            direction={{ palette }}
            level={level}
            size="sm"
            styled={styled}
          />
        </div>
        <div className="vx-meter">
          <span>
            <small>Frontier this round</small>
            <strong>
              {questions.length} question{questions.length === 1 ? "" : "s"}
            </strong>
          </span>
        </div>
      </aside>
      <article className="vx-question">
        <header>
          <span className="vx-tag">
            Round {project.interrogation?.rounds.length ?? 1}
          </span>
          <span className="vx-tag vx-tag-ghost">
            {questions.length} decisions now
          </span>
        </header>
        <h1>Answer the whole current frontier.</h1>
        <p className="vx-why">
          Fulcrum asks every question that is eligible right now. Later branches
          stay closed until these are recorded together.
        </p>
        {questions.map((question) => (
          <div className="vx-frontier-card" key={question.questionId}>
            <span className="vx-tag vx-tag-ghost">{question.branchId}</span>
            <h2>{question.prompt}</h2>
            <div className="vx-advisor">
              <span className="vx-advisor-face" aria-hidden="true">
                <i />
                <i />
              </span>
              <p>
                <strong>Forge guide</strong>
                {question.recommendation}
              </p>
            </div>
            <label className="vx-answer">
              <span>
                Your answer — edit anything you disagree with, paste an image to
                attach it
              </span>
              <textarea
                aria-label={question.prompt}
                onChange={(event) =>
                  onChange(question.questionId, event.target.value)
                }
                onPaste={(event) => onPaste(question.questionId, event)}
                value={drafts[question.questionId] ?? ""}
              />
            </label>
            {(attachments[question.questionId]?.length ?? 0) > 0 && (
              <AttachmentStrip
                attachments={attachments[question.questionId] ?? []}
                busy={busy}
                note={attachmentDeliveryNote(project.state)}
                onRemove={(artifactId) =>
                  onRemoveAttachment(question.questionId, artifactId)
                }
              />
            )}
          </div>
        ))}
        <footer>
          <small>
            Completed answers cannot be reopened. A new round may appear after
            this one is placed.
          </small>
          <button
            className="vx-primary"
            disabled={busy || questions.length === 0}
            onClick={onSubmit}
            type="button"
          >
            Place this round <i>▸</i>
          </button>
        </footer>
      </article>
    </section>
  );
}

function SignoffScreen({
  answers,
  busy,
  level,
  palette,
  project,
  styled,
  onConfirm,
}: {
  answers: ReturnType<typeof recordedAnswers>;
  busy: boolean;
  level: number;
  palette: string[];
  project: ProjectSnapshot;
  styled: boolean;
  onConfirm: () => void;
}) {
  return (
    <section className="vx-signoff">
      {/* A capture frame, like the interrogation rail's. Without one Rusty
          stood beside this diorama in free mode: his fetch had no target, so
          the block dissolved in his hands and the board only caught up with
          the recorded rounds ~11s later, out of nowhere — which read as
          "Fulcrum didn't place a block on the board". Docked, the block he
          carries lands on the plate and the brief's progress is visible on it
          the way it is on every other screen with a world. */}
      <div className="vx-signoff-world" data-mascot-frame="capture">
        <VoxelWorld
          direction={{ palette }}
          level={level}
          size="md"
          styled={styled}
        />
        <span className="vx-stamp">Brief complete</span>
      </div>
      <article className="vx-brief">
        <span className="vx-kicker">
          <i />
          World brief · review before saving
        </span>
        <h1>This is what Fulcrum understood.</h1>
        <blockquote>{project.briefText}</blockquote>
        <div className="vx-brief-rows">
          {answers.map((answer) => (
            <article key={`${answer.roundId}:${answer.question?.questionId}`}>
              <small>{answer.question?.branchId ?? answer.roundId}</small>
              <strong>{answer.value}</strong>
              <RecordedAttachments answer={answer} />
            </article>
          ))}
        </div>
        <p className="vx-why">
          Recorded answers are project truth. There is no reopen route, so edit
          is not offered here.
        </p>
        <button
          className="vx-primary vx-primary-wide"
          disabled={busy}
          onClick={onConfirm}
          type="button"
        >
          Save brief & name the game <i>▸</i>
        </button>
      </article>
    </section>
  );
}

/** The naming conversation. Four proposals with their reasons, a box to say
 *  what is wrong with them, and a box to overrule Fulcrum entirely. Nothing
 *  here is generated until the user commits a name — asking again is free. */
function GameNameScreen({
  attachments,
  busy,
  candidateId,
  customName,
  feedback,
  project,
  onCandidate,
  onCommit,
  onCustomName,
  onFeedback,
  onPaste,
  onRemoveAttachment,
  onSuggest,
}: {
  attachments: ArtifactRef[];
  busy: boolean;
  candidateId: string | undefined;
  customName: string;
  feedback: string;
  project: ProjectSnapshot;
  onCandidate: (candidateId: string) => void;
  onCommit: () => void;
  onCustomName: (value: string) => void;
  onFeedback: (value: string) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (artifactId: string) => void;
  onSuggest: () => void;
}) {
  const set = project.gameNameCandidates;
  if (!set) return null;
  const typed = customName.trim();
  const chosen = set.candidates.find(
    (candidate) => candidate.candidateId === candidateId,
  );
  const settled = typed || chosen?.name;
  return (
    <section aria-labelledby="game-name-title" className="vx-naming">
      <header className="vx-naming-head">
        <span className="vx-kicker">
          <i />
          Name · batch {set.round}
        </span>
        <h1 id="game-name-title">What is this game called?</h1>
        <p>
          The name is the first thing anyone learns about the game, so it is a
          conversation and not a coin flip. Take one of these, tell Fulcrum what
          is wrong with them, or name it yourself.
        </p>
      </header>
      <nav aria-label="Proposed names" className="vx-name-options">
        {set.candidates.map((candidate) => (
          <button
            aria-pressed={candidate.candidateId === candidateId}
            data-active={
              candidate.candidateId === candidateId && !typed ? "true" : "false"
            }
            disabled={busy}
            key={candidate.candidateId}
            onClick={() => onCandidate(candidate.candidateId)}
            type="button"
          >
            <strong>{candidate.name}</strong>
            <small>{candidate.rationale}</small>
          </button>
        ))}
      </nav>
      <div className="vx-name-panels">
        <div className="vx-name-panel">
          <label className="vx-answer">
            <span>None of these — try again with</span>
            <textarea
              onChange={(event) => onFeedback(event.target.value)}
              onPaste={onPaste}
              placeholder="Shorter. Push it darker. Lose the article."
              value={feedback}
            />
          </label>
          {attachments.length > 0 && (
            <AttachmentStrip
              attachments={attachments}
              busy={busy}
              note={attachmentDeliveryNote(project.state, "this steer")}
              onRemove={onRemoveAttachment}
            />
          )}
          <button
            className="vx-secondary"
            disabled={busy || !feedback.trim()}
            onClick={onSuggest}
            type="button"
          >
            Suggest {set.candidates.length} more
          </button>
        </div>
        <div className="vx-name-panel">
          <label className="vx-answer">
            <span>Or name it yourself</span>
            <input
              maxLength={GAME_NAME_MAX_CHARS}
              onChange={(event) => onCustomName(event.target.value)}
              placeholder="Type the name"
              type="text"
              value={customName}
            />
          </label>
          <small className="vx-name-note">
            A name you type wins over anything selected above.
          </small>
        </div>
      </div>
      <button
        className="vx-primary vx-primary-wide"
        disabled={busy || !settled}
        onClick={onCommit}
        type="button"
      >
        {settled ? `Name it ${settled}` : "Pick a name to continue"} <i>▸</i>
      </button>
    </section>
  );
}

function GameDesignScreen({
  busy,
  needsRevise,
  project,
  reviseText,
  onApprove,
  onReject,
  onRequestChanges,
  onRevise,
  onReviseText,
}: {
  busy: boolean;
  needsRevise: boolean;
  project: ProjectSnapshot;
  reviseText: string;
  onApprove: () => void;
  onReject: () => void;
  onRequestChanges: () => void;
  onRevise: () => void;
  onReviseText: (value: string) => void;
}) {
  const spec = project.gameDesignSpec;
  if (!spec) return null;
  /* A full-screen reading layout: no world panel, no Rusty (the stage hides
     him via data-mascot="off"). One centered reading column; the decision
     row stays pinned inside the card so approving never needs a hunt to the
     bottom of a long spec. */
  return (
    <section className="vx-gds-layout">
      <div className="vx-gds">
        <header>
          <span className="vx-kicker">
            <i />
            Game Design Spec
          </span>
          <h1>{spec.title}</h1>
          <p>
            {spec.genre} · {spec.camera}
          </p>
        </header>
        <div className="vx-gds-body">
          <dl>
            <div>
              <dt>Core fantasy</dt>
              <dd>{spec.coreFantasy}</dd>
            </div>
            <div>
              <dt>Objective</dt>
              <dd>{spec.objective}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{spec.sessionMinutes} minutes</dd>
            </div>
            <div>
              <dt>Loop</dt>
              <dd>{spec.coreLoop.join(" → ")}</dd>
            </div>
            <div>
              <dt>Verbs</dt>
              <dd>{spec.playerVerbs.join(" · ")}</dd>
            </div>
            <div>
              <dt>Constraints</dt>
              <dd>{spec.gameplayConstraints.join(" · ") || "None recorded"}</dd>
            </div>
          </dl>
          <div className="vx-gds-lists">
            <div>
              <small>Facts</small>
              {spec.facts.map((fact) => (
                <p key={fact.statementId}>{fact.text}</p>
              ))}
            </div>
            <div>
              <small>Assumptions</small>
              {spec.assumptions.map((item) => (
                <p key={item.statementId}>
                  {item.text}{" "}
                  <i>
                    ({item.origin.source}
                    {item.origin.reference ? ` · ${item.origin.reference}` : ""}
                    )
                  </i>
                </p>
              ))}
            </div>
          </div>
          {needsRevise && (
            <label className="vx-answer">
              <span>Revise the spec before it can be approved</span>
              <textarea
                aria-label="Game design revision"
                onChange={(event) => onReviseText(event.target.value)}
                placeholder="The proof boundary is…"
                value={reviseText}
              />
              <button
                className="vx-primary"
                disabled={busy || !reviseText.trim()}
                onClick={onRevise}
                type="button"
              >
                Record revision <i>▸</i>
              </button>
            </label>
          )}
        </div>
        <footer className="vx-gds-actions">
          <button
            className="vx-secondary"
            disabled={busy}
            onClick={onReject}
            type="button"
          >
            Reject
          </button>
          <button
            className="vx-secondary"
            disabled={busy || needsRevise}
            onClick={onRequestChanges}
            type="button"
          >
            Request changes
          </button>
          <button
            className="vx-primary"
            disabled={busy || needsRevise}
            onClick={onApprove}
            type="button"
          >
            Approve spec <i>▸</i>
          </button>
        </footer>
      </div>
    </section>
  );
}

/* === Color & Mood: turn the style bible into a picture =====================
   The mappings themselves — swatch weight, the two gradients, chip tint, the
   shape family, prose cleanup and the shared-content diff — are pure and live
   in snapshot-view.ts with their tests. What is left here is only the drawing.
   ========================================================================= */

/* Three forms on one ground line, drawn at the direction's own scale
   hierarchy: a dominant mass, a supporting form, a small one. Paths only —
   this is a diagram, not an illustration. */
const MOOD_ROUND_MASS = "M6 96 V54 a34 34 0 0 1 68 0 V96 Z";
const MOOD_ROUND_MID = "M92 96 V74 a26 26 0 0 1 52 0 V96 Z";
const MOOD_ROUND_SMALL = "M162 96 V85 a17 17 0 0 1 34 0 V96 Z";
const MOOD_ANGLE_MASS = "M6 96 L40 14 L74 96 Z";
const MOOD_ANGLE_MID = "M92 96 V58 L118 38 L144 58 V96 Z";
const MOOD_ANGLE_SMALL = "M162 96 L179 54 L196 96 Z";
/* The mixed trio needs its own middle form — a rounded shoulder cut by one
   straight diagonal. Reusing the plain gable read as the rounded trio with a
   different second shape. */
const MOOD_HYBRID_MID = "M92 96 V60 a26 26 0 0 1 26 -26 L144 62 V96 Z";
const MOOD_SILHOUETTES: Record<MoodShapeFamily, [string, string, string]> = {
  rounded: [MOOD_ROUND_MASS, MOOD_ROUND_MID, MOOD_ROUND_SMALL],
  angular: [MOOD_ANGLE_MASS, MOOD_ANGLE_MID, MOOD_ANGLE_SMALL],
  mixed: [MOOD_ROUND_MASS, MOOD_HYBRID_MID, MOOD_ANGLE_SMALL],
};

function MoodShapeDiagram({
  family,
  palette,
}: {
  family: MoodShapeFamily;
  palette: MoodPaletteToken[];
}) {
  /* Biggest silhouette wears the colour with the biggest coverage, so the
     shape diagram and the palette strip tell the same story. */
  const ordered = [...palette].sort(
    (a, b) => moodPaletteWeight(b.role) - moodPaletteWeight(a.role),
  );
  return (
    <svg
      aria-hidden="true"
      className="vx-mood-shapes"
      role="presentation"
      viewBox="0 0 202 104"
      xmlns="http://www.w3.org/2000/svg"
    >
      <line className="vx-mood-ground" x1="0" y1="97" x2="202" y2="97" />
      {MOOD_SILHOUETTES[family].map((path, index) => (
        <path
          d={path}
          fill={ordered[index % Math.max(ordered.length, 1)]?.hex ?? MOOD_INK}
          key={path}
        />
      ))}
    </svg>
  );
}

/* --- leaked model instructions ------------------------------------------
   The generator's own scaffolding reaches this screen verbatim ("Player
   fantasy: Name one observable accomplishment…", a bare "first-person."
   bullet). These filters are deliberately narrow: a sentence is only
   dropped when a label introduces an order to the generator or a stub, and
   anything we cannot classify is kept. */
/* The card renders the facets that differ, with the two that carry a mark
   (materials, shape language) last and full width. */
const MOOD_CARD_FACET_ORDER: MoodFacetKey[] = [
  "materials",
  "textureLanguage",
  "cameraLanguage",
  "architecture",
  "shapeLanguage",
];

/** One label/value row. `visual` renders the encodings — tinted chips for
    materials, a silhouette trio for shape language — and is off in the
    shared section, where the row describes three different palettes. */
function MoodFacet({
  bible,
  facet,
  idPrefix,
  visual,
}: {
  bible: MoodBible;
  facet: MoodFacetKey;
  idPrefix: string;
  visual: boolean;
}) {
  const label = MOOD_FACET_LABELS[facet];
  const text = moodFacetText(bible, facet);
  if (visual && facet === "materials") {
    return (
      <div className="vx-mood-wide">
        <dt>{label}</dt>
        <dd>
          <ul className="vx-mood-chips">
            {bible.materials.map((material, materialIndex) => (
              <li
                key={`${idPrefix}-material-${materialIndex}`}
                style={moodChipStyle(
                  bible.palette[materialIndex % bible.palette.length]?.hex ??
                    MOOD_INK,
                )}
              >
                {material}
              </li>
            ))}
          </ul>
        </dd>
      </div>
    );
  }
  const family = visual ? moodShapeFamily(bible.shapeLanguage) : undefined;
  if (facet === "shapeLanguage" && family) {
    return (
      <div className="vx-mood-wide">
        <dt>{label}</dt>
        <dd className="vx-mood-shape">
          <MoodShapeDiagram family={family} palette={bible.palette} />
          <p>{text}</p>
        </dd>
      </div>
    );
  }
  return (
    <div>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </div>
  );
}

/** Readability rules and exclusions, rendered wherever they belong — on the
    card when they are this direction's own, in the shared section when every
    direction states them. */
function MoodGuardrails({
  idPrefix,
  prohibitedStyles,
  readabilityRules,
  showEmptyExclusions,
}: {
  idPrefix: string;
  prohibitedStyles: string[];
  readabilityRules: string[];
  showEmptyExclusions: boolean;
}) {
  const hasExclusions = prohibitedStyles.length > 0;
  if (readabilityRules.length === 0 && !hasExclusions && !showEmptyExclusions) {
    return null;
  }
  return (
    <div className="vx-mood-guardrails">
      {readabilityRules.length > 0 && (
        <section>
          <h3>Readability rules</h3>
          <ul>
            {readabilityRules.map((rule, ruleIndex) => (
              <li key={`${idPrefix}-readability-${ruleIndex}`}>{rule}</li>
            ))}
          </ul>
        </section>
      )}
      {(hasExclusions || showEmptyExclusions) && (
        <section>
          <h3>Avoid</h3>
          {hasExclusions ? (
            <ul>
              {prohibitedStyles.map((rule, ruleIndex) => (
                <li key={`${idPrefix}-prohibited-${ruleIndex}`}>{rule}</li>
              ))}
            </ul>
          ) : (
            <p>No additional exclusions.</p>
          )}
        </section>
      )}
    </div>
  );
}

function DirectionScreen({
  busy,
  changeText,
  changeUsed,
  direction,
  directions,
  panel,
  pinnedAspects,
  project,
  replaceNotes,
  replacementUsed,
  onApprove,
  onChangeText,
  onOpenPanel,
  onPinnedAspects,
  onReject,
  onReplaceNotes,
  onSubmitChange,
  onSubmitReplace,
  onView,
}: {
  busy: boolean;
  changeText: string;
  changeUsed: boolean;
  direction: NonNullable<ReturnType<typeof selectedDirection>>;
  directions: VisualDirection[];
  panel: "none" | "replace" | "change";
  pinnedAspects: string[];
  project: ProjectSnapshot;
  replaceNotes: string;
  replacementUsed: boolean;
  onApprove: () => void;
  onChangeText: (value: string) => void;
  onOpenPanel: (panel: "none" | "replace" | "change") => void;
  onPinnedAspects: (value: string[]) => void;
  onReject: () => void;
  onReplaceNotes: (value: string) => void;
  onSubmitChange: () => void;
  onSubmitReplace: () => void;
  onView: (revisionId: string) => void;
}) {
  const selectedId = project.state.selectedVisualDirectionRevisionId;
  const isSelected =
    selectedId === undefined || selectedId === direction.revisionId;
  const canReplace = !replacementUsed && selectedId !== direction.revisionId;
  const directionIndex = directions.findIndex(
    (item) => item.revisionId === direction.revisionId,
  );
  /* The revealed panel renders below the action stack so the button you just
     clicked never moves out from under the cursor. It is off-screen on a short
     viewport, so bring it into view instead of pushing the buttons down. */
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel === "none") return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [panel]);
  /* Split the bible: the card carries what this direction says on its own,
     the section under it carries what all of them say. */
  const bible = direction.visualBible;
  const shared = moodSharedContent(directions);
  const ownDescription = moodWithoutCommon(
    moodDescription(direction),
    shared.description,
  );
  const ownFacets = MOOD_CARD_FACET_ORDER.filter(
    (facet) => !shared.facets.includes(facet),
  );
  const ownReadabilityRules = moodWithoutCommon(
    moodCleanRules(bible.readabilityRules),
    shared.readabilityRules,
  );
  const ownProhibitedStyles = moodWithoutCommon(
    bible.prohibitedStyles,
    shared.prohibitedStyles,
  );
  const showsLighting = !shared.facets.includes("lighting");
  const showsAtmosphere = !shared.facets.includes("atmosphere");
  const hasShared =
    shared.facets.length > 0 ||
    shared.description.length > 0 ||
    shared.readabilityRules.length > 0 ||
    shared.prohibitedStyles.length > 0;
  return (
    <section
      aria-labelledby="color-mood-title"
      className="vx-direction vx-color-mood"
    >
      <header className="vx-direction-head">
        <span className="vx-kicker">
          <i />
          Visual rules
        </span>
        <h1 id="color-mood-title">Color &amp; Mood</h1>
        <p>Choose the rules every image and asset will follow.</p>
      </header>
      <nav className="vx-mood-options" aria-label="Color & Mood directions">
        {directions.map((item, index) => (
          <button
            aria-pressed={item.revisionId === direction.revisionId}
            data-active={
              item.revisionId === direction.revisionId ? "true" : "false"
            }
            key={item.revisionId}
            onClick={() => onView(item.revisionId)}
            type="button"
          >
            <span>
              <small>Direction {padIndex(index)}</small>
              <strong>{item.name}</strong>
            </span>
            <span className="vx-mood-option-swatches" aria-hidden="true">
              {item.visualBible.palette.map((token, swatchIndex) => (
                <i
                  key={`${item.revisionId}-swatch-${swatchIndex}`}
                  style={{ backgroundColor: token.hex }}
                />
              ))}
            </span>
          </button>
        ))}
      </nav>
      <article className="vx-mood-sheet">
        <header className="vx-mood-sheet-head">
          <span className="vx-tag">Direction {padIndex(directionIndex)}</span>
          <div>
            <small>{bible.overallStyle}</small>
            <h2>{direction.name}</h2>
            {ownDescription.length > 0 && <p>{ownDescription.join(" ")}</p>}
          </div>
        </header>
        <section
          className="vx-mood-palette"
          aria-labelledby="mood-palette-title"
        >
          <header>
            <h3 id="mood-palette-title">Palette</h3>
            {/* The swatches carry the dominance now, so the caption says how
                to read them instead of promising a job you had to go find. */}
            <p>Width shows how much of the frame each color takes.</p>
          </header>
          <ul>
            {bible.palette.map((token, tokenIndex) => (
              <li
                key={`${direction.revisionId}-palette-${tokenIndex}`}
                style={{ flexGrow: moodPaletteWeight(token.role) }}
              >
                <i style={{ backgroundColor: token.hex }} />
                {/* The colour's job is ink at reading size and the hex drops
                    to a debug string; the swatch width now says the same
                    thing without being read at all. */}
                <span>
                  <strong>{token.name}</strong>
                  <span className="vx-swatch-role">{token.role}</span>
                  <small>{token.hex.toUpperCase()}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
        {(showsLighting || showsAtmosphere) && (
          <div className="vx-mood-pillars">
            {showsLighting && (
              <section>
                <small>Lighting</small>
                {/* Light and air are the two fields a reader cannot picture
                    from a sentence: paint them with the direction's own
                    colours and let the sentence be the caption. */}
                <i
                  aria-hidden="true"
                  className="vx-mood-strip"
                  style={{
                    backgroundImage: moodLightingGradient(bible.palette),
                  }}
                />
                <p>{moodFacetText(bible, "lighting")}</p>
              </section>
            )}
            {showsAtmosphere && (
              <section>
                <small>Atmosphere</small>
                <i
                  aria-hidden="true"
                  className="vx-mood-strip"
                  style={{
                    backgroundImage: moodAtmosphereGradient(bible.palette),
                  }}
                />
                <p>{moodFacetText(bible, "atmosphere")}</p>
              </section>
            )}
          </div>
        )}
        {ownFacets.length > 0 && (
          <dl className="vx-mood-rules">
            {ownFacets.map((facet) => (
              <MoodFacet
                bible={bible}
                facet={facet}
                idPrefix={direction.revisionId}
                key={facet}
                visual
              />
            ))}
          </dl>
        )}
        <MoodGuardrails
          idPrefix={direction.revisionId}
          prohibitedStyles={ownProhibitedStyles}
          readabilityRules={ownReadabilityRules}
          showEmptyExclusions={shared.prohibitedStyles.length === 0}
        />
      </article>
      {/* The directions arrived roughly half byte-identical. Whatever all of
          them state goes here, once, below the tabs — so the card above is
          only ever the case for this direction. */}
      {hasShared && (
        <section aria-labelledby="mood-shared-title" className="vx-mood-shared">
          <header>
            <span className="vx-kicker">
              <i />
              Same in all {directions.length} directions
            </span>
            <h2 id="mood-shared-title">Rules that apply to every direction</h2>
            {shared.description.length > 0 && (
              <p>{shared.description.join(" ")}</p>
            )}
          </header>
          {shared.facets.length > 0 && (
            <dl className="vx-mood-rules">
              {shared.facets.map((facet) => (
                <MoodFacet
                  bible={bible}
                  facet={facet}
                  idPrefix="mood-shared"
                  key={facet}
                  visual={false}
                />
              ))}
            </dl>
          )}
          <MoodGuardrails
            idPrefix="mood-shared"
            prohibitedStyles={shared.prohibitedStyles}
            readabilityRules={shared.readabilityRules}
            showEmptyExclusions={false}
          />
        </section>
      )}
      <aside className="vx-mood-decision" aria-label="Color & Mood decision">
        <header>
          <small>Decision</small>
          <strong>Use {direction.name}?</strong>
        </header>
        <div className="vx-mood-actions">
          <button
            className="vx-primary vx-primary-wide"
            disabled={busy}
            onClick={onApprove}
            type="button"
          >
            Use these rules <i>▸</i>
          </button>
          <button
            className="vx-secondary"
            disabled={busy || changeUsed || !isSelected}
            onClick={() => onOpenPanel(panel === "change" ? "none" : "change")}
            type="button"
          >
            {changeUsed ? "Change used" : "Focused change"}
          </button>
          <button
            className="vx-secondary"
            disabled={busy || !canReplace}
            onClick={() =>
              onOpenPanel(panel === "replace" ? "none" : "replace")
            }
            type="button"
          >
            {replacementUsed ? "Replacement used" : "Replace direction"}
          </button>
          <button
            className="vx-secondary"
            disabled={busy}
            onClick={onReject}
            type="button"
          >
            Reject
          </button>
        </div>
        {panel === "replace" && (
          <div className="vx-mood-panel" ref={panelRef}>
            <label className="vx-answer">
              <span>Replace this direction</span>
              <textarea
                onChange={(event) => onReplaceNotes(event.target.value)}
                value={replaceNotes}
              />
            </label>
            <button
              className="vx-primary vx-primary-wide"
              disabled={busy || !replaceNotes.trim()}
              onClick={onSubmitReplace}
              type="button"
            >
              Generate replacement <i>▸</i>
            </button>
          </div>
        )}
        {panel === "change" && (
          <div className="vx-mood-panel vx-change-form" ref={panelRef}>
            <label className="vx-answer">
              <span>Focused change</span>
              <textarea
                onChange={(event) => onChangeText(event.target.value)}
                placeholder="Lower the saturation, keep gameplay accents high-contrast, and soften the ambient light."
                value={changeText}
              />
            </label>
            {/* Chips, not native OS checkboxes: "pin these facets" is a
                multi-select, and a 13px default-blue tick was the only control
                in the shell that did not carry the 2px ink box. */}
            <div className="vx-pins" role="group" aria-label="Pinned aspects">
              {PINNED_ASPECT_OPTIONS.map((aspect) => (
                <label
                  data-pinned={
                    pinnedAspects.includes(aspect) ? "true" : "false"
                  }
                  key={aspect}
                >
                  <input
                    checked={pinnedAspects.includes(aspect)}
                    onChange={() =>
                      onPinnedAspects(
                        pinnedAspects.includes(aspect)
                          ? pinnedAspects.filter((item) => item !== aspect)
                          : [...pinnedAspects, aspect],
                      )
                    }
                    type="checkbox"
                  />
                  <i aria-hidden="true" />
                  Pin {aspect}
                </label>
              ))}
            </div>
            <button
              className="vx-primary vx-primary-wide"
              disabled={
                busy || !changeText.trim() || pinnedAspects.length === 0
              }
              onClick={onSubmitChange}
              type="button"
            >
              Apply focused change <i>▸</i>
            </button>
          </div>
        )}
      </aside>
    </section>
  );
}

function ConceptPlanScreen({
  busy,
  project,
  onConfirm,
}: {
  busy: boolean;
  project: ProjectSnapshot;
  onConfirm: (
    promptOverrides?: ConfirmConceptPlanInput["promptOverrides"],
  ) => void;
}) {
  const slots = project.conceptPlan?.slots ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const textFor = (slot: (typeof slots)[number]): string =>
    drafts[slot.slotId] ?? slot.prompt ?? "";
  const dirtyOverrides = (): ConceptPlanPromptOverride[] =>
    slots.flatMap((slot) => {
      if (slot.prompt === undefined) return [];
      const next = textFor(slot);
      if (next === slot.prompt) return [];
      return [{ slotId: slot.slotId, prompt: next }];
    });
  const invalidDraft = slots.some((slot) => {
    if (slot.prompt === undefined) return false;
    return textFor(slot).trim().length === 0;
  });
  const meteredImage =
    project.state.mode === "live" &&
    isMeteredImageProvider(project.state.imageProvider);
  return (
    <section className="concept-plan-review">
      <header>
        <span className="m1-kicker">Before ImageGen runs</span>
        <h1>Fulcrum proposes creating these images.</h1>
        <p>
          This list comes from the Game Design Spec you approved. Each prompt is
          sent to ImageGen exactly as written. Edit a slot before you confirm.
        </p>
        <div
          aria-hidden="true"
          className="vx-mascot-perch"
          data-mascot-frame="perch"
        />
      </header>
      <div className="concept-plan-list">
        {slots.map((slot, index) => {
          const proposed = slot.prompt;
          const draft = textFor(slot);
          const dirty = proposed !== undefined && draft !== proposed;
          return (
            <article key={slot.slotId}>
              <i>{padIndex(index)}</i>
              <span>
                <small>{slot.purpose}</small>
                <strong>{slot.name}</strong>
                <p>{slot.tokenCategories.join(" · ")}</p>
                {proposed !== undefined && (
                  <label className="slot-prompt">
                    <span>Prompt sent to ImageGen</span>
                    <SlotPromptEditor
                      onChange={(value) =>
                        setDrafts((current) => ({
                          ...current,
                          [slot.slotId]: value,
                        }))
                      }
                      value={draft}
                    />
                    {dirty && (
                      <button
                        className="slot-prompt-reset"
                        onClick={() =>
                          setDrafts((current) => {
                            const next = { ...current };
                            delete next[slot.slotId];
                            return next;
                          })
                        }
                        type="button"
                      >
                        Reset to proposed
                      </button>
                    )}
                  </label>
                )}
              </span>
            </article>
          );
        })}
      </div>
      <footer>
        <div>
          <strong>
            {meteredImage
              ? imageProviderLabels[project.state.imageProvider]
              : project.state.mode === "live"
                ? "OpenAI subscription · ImageGen"
                : "Replay · local fixtures"}
          </strong>
          <small>
            {meteredImage
              ? `Spent ${formatUsd(project.state.spentUsd)} of ${formatUsd(project.state.budgetUsd)}. Confirming the plan generates every listed image.`
              : project.state.mode === "live"
                ? "Uses your OpenAI subscription. Confirming the plan generates every listed image."
                : "Replay stays local. Confirming the plan generates every listed image."}
          </small>
        </div>
        <button
          className="m1-primary"
          disabled={busy || invalidDraft}
          onClick={() => {
            const overrides = dirtyOverrides();
            onConfirm(overrides.length > 0 ? overrides : undefined);
          }}
          type="button"
        >
          Confirm list and generate <span>→</span>
        </button>
      </footer>
    </section>
  );
}

function ConceptReviewScreen({
  busy,
  notes,
  project,
  revisions,
  slot,
  viewed,
  onKeep,
  onNotes,
  onPackage,
  onRegenerate,
  onViewRevision,
  onViewSlot,
}: {
  busy: boolean;
  notes: string;
  project: ProjectSnapshot;
  revisions: ReturnType<typeof slotRevisionViews>;
  slot: NonNullable<ProjectSnapshot["conceptSet"]>["slots"][number];
  viewed: ReturnType<typeof slotRevisionViews>[number] | undefined;
  onKeep: () => void;
  onNotes: (value: string) => void;
  onPackage: () => void;
  onRegenerate: () => void;
  onViewRevision: (revisionId: string) => void;
  onViewSlot: (slotId: string) => void;
}) {
  const slots = project.conceptSet?.slots ?? [];
  const image = viewed?.document?.image.uri;
  const stale = viewed?.staleReason;
  return (
    <section className="single-concept-review">
      <header className="single-review-heading">
        <div>
          <span className="m1-kicker">
            Image {slots.findIndex((item) => item.slotId === slot.slotId) + 1}{" "}
            of {slots.length} · {slot.purpose}
          </span>
          <h1>{slot.name}</h1>
        </div>
        <div className="review-progress">
          {slots.map((item, index) => (
            <button
              className={
                item.slotId === slot.slotId
                  ? "active"
                  : item.selectedRevisionId
                    ? "kept"
                    : ""
              }
              key={item.slotId}
              onClick={() => onViewSlot(item.slotId)}
              type="button"
            >
              <i>{item.selectedRevisionId ? "✓" : padIndex(index)}</i>
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="single-review-layout">
        <div className="single-review-visual">
          {image ? (
            <img alt={`${slot.name} concept`} src={image} />
          ) : (
            <p>No image artifact on this revision.</p>
          )}
          <div className="single-review-caption">
            <span>{viewed?.label} · full image</span>
            <small>No crop applied</small>
          </div>
        </div>
        <aside className="single-review-controls">
          <section>
            <span className="control-label">Why this image exists</span>
            <p>{slot.purpose}</p>
          </section>
          <section className="approved-context">
            <span>Approved direction</span>
            <strong>{project.visualBible?.title ?? "Visual bible"}</strong>
            <small>
              {viewed?.document?.ancestors.length ?? 0} ancestor hashes
            </small>
          </section>
          {viewed?.document?.prompt && (
            <details className="exact-prompt-sent">
              <summary>Exact prompt sent</summary>
              <pre>{viewed.document.prompt}</pre>
            </details>
          )}
          <section className="full-revision-history">
            <span className="control-label">Revision history</span>
            {revisions.map((revision) => (
              <button
                className={
                  viewed?.revisionId === revision.revisionId ? "active" : ""
                }
                key={revision.revisionId}
                onClick={() => onViewRevision(revision.revisionId)}
                type="button"
              >
                <span>
                  {revision.label}
                  {revision.staleReason ? " · stale" : ""}
                </span>
                <small>
                  {slot.selectedRevisionId === revision.revisionId
                    ? "Kept"
                    : "View full size"}
                </small>
              </button>
            ))}
          </section>
          {stale && (
            <p className="image-generation-error" role="alert">
              Stale: {stale}. This revision cannot be selected.
            </p>
          )}
          <label className="image-change-request">
            <span>Regenerate this slot</span>
            <textarea
              onChange={(event) => onNotes(event.target.value)}
              placeholder="Describe the focused change for the next revision."
              value={notes}
            />
            <small>
              Each regeneration is a new revision.{" "}
              {project.state.mode === "live"
                ? isMeteredImageProvider(project.state.imageProvider)
                  ? "The metered image route uses the project budget."
                  : "The image uses your OpenAI subscription with no metered spend."
                : "Replay stays local."}
            </small>
          </label>
          <button
            className="m1-secondary"
            disabled={busy}
            onClick={onRegenerate}
            type="button"
          >
            {project.state.mode === "live"
              ? "Generate a new revision with ImageGen"
              : "Regenerate this slot"}
          </button>
          {project.state.mode === "live" && (
            <p className="image-gen-paid-note">
              {isMeteredImageProvider(project.state.imageProvider)
                ? "Uses the selected metered image route"
                : "Uses your signed-in OpenAI subscription · no metered spend"}
            </p>
          )}
          <button
            className="m1-primary"
            disabled={busy || Boolean(stale) || !viewed}
            onClick={onKeep}
            type="button"
          >
            {slot.selectedRevisionId === viewed?.revisionId
              ? "Continue"
              : "Keep this revision and continue"}{" "}
            <span>→</span>
          </button>
          {allSlotsSelected(project) && (
            <button
              className="review-package-link"
              onClick={onPackage}
              type="button"
            >
              Review concept package
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}

function PackageScreen({
  busy,
  project,
  onApprove,
  onReject,
  onReview,
}: {
  busy: boolean;
  project: ProjectSnapshot;
  onApprove: () => void;
  onReject: () => void;
  onReview: (slotId: string) => void;
}) {
  const slots = project.conceptSet?.slots ?? [];
  return (
    <section className="concept-package-review">
      <header>
        <span className="m1-kicker">Concept package</span>
        <h1>Review the concept package.</h1>
        <p>
          Detailed image review is complete. This page only confirms which kept
          revisions will become project truth.
        </p>
        <div
          aria-hidden="true"
          className="vx-mascot-perch"
          data-mascot-frame="perch"
        />
      </header>
      <div className="package-summary-grid">
        {slots.map((slot) => {
          const views = slotRevisionViews(project, slot);
          const kept =
            views.find((item) => item.revisionId === slot.selectedRevisionId) ??
            views.at(-1);
          return (
            <article key={slot.slotId}>
              {kept?.document?.image.uri && (
                <img alt="" src={kept.document.image.uri} />
              )}
              <span>
                <small>{slot.purpose}</small>
                <strong>{slot.name}</strong>
                <i>✓ Kept · {kept?.label}</i>
              </span>
              <button onClick={() => onReview(slot.slotId)} type="button">
                Review again
              </button>
            </article>
          );
        })}
      </div>
      <footer>
        <button
          className="m1-secondary"
          disabled={busy}
          onClick={onReject}
          type="button"
        >
          Reject package
        </button>
        <button
          className="m1-primary"
          disabled={busy}
          onClick={onApprove}
          type="button"
        >
          Approve concept package <span>→</span>
        </button>
      </footer>
    </section>
  );
}

function CompleteScreen({
  busy,
  project,
  onContinue,
}: {
  busy: boolean;
  project: ProjectSnapshot;
  onContinue: (meshyCreditBudget?: number) => void;
}) {
  const directionName =
    project.visualDirections?.directions.find(
      (item) =>
        item.revisionId === project.state.selectedVisualDirectionRevisionId,
    )?.name ?? project.visualBible?.title;
  /* The world that spends Meshy credits is the descendant, not this one, so
     its cap is collected here on the same terms the create form uses. Replay
     spends nothing and is asked for nothing. */
  const needsCredits = showsMeshyCreditBudget({
    milestone: "m2",
    mode: project.state.mode,
  });
  const [meshyCreditBudget, setMeshyCreditBudget] = useState(300);
  const invalidCredits =
    needsCredits &&
    (!Number.isInteger(meshyCreditBudget) || meshyCreditBudget < 30);
  return (
    <section className="concept-complete">
      <span className="complete-mark">✓</span>
      <span className="m1-kicker">Sound palette approved</span>
      <h1>M1 is complete.</h1>
      <p>
        The kept image revisions and the sound palette are now the approved
        creative package. Nothing else was generated or selected.
      </p>
      <div className="complete-lineage">
        Game Design Spec → {directionName} Visual Bible → approved concept
        package → sound palette
      </div>
      <BudgetChip project={project} />
      <div className="vx-continue-m2">
        {needsCredits && (
          <label className="vx-budget-field">
            <span>Meshy credit budget</span>
            <input
              aria-label="Meshy credit budget"
              min={30}
              onChange={(event) =>
                setMeshyCreditBudget(Number(event.target.value))
              }
              step={10}
              type="number"
              value={meshyCreditBudget}
            />
            <small>
              300 credits funds ten first-pass assets — 20 for geometry and 10
              for 4K texturing each.
            </small>
          </label>
        )}
        <button
          className="m1-primary"
          disabled={busy || invalidCredits}
          onClick={() =>
            onContinue(needsCredits ? meshyCreditBudget : undefined)
          }
          type="button"
        >
          Continue into M2 <span>→</span> plan the asset batch
        </button>
        <small className="vx-continue-note">
          Opens a new world at asset planning with this approved package carried
          over. Nothing is generated until you approve the plan, and this world
          is left exactly as it is.
        </small>
      </div>
    </section>
  );
}

function M2CompleteScreen({ project }: { project: ProjectSnapshot }) {
  const entries = project.state.assetBatch ?? {};
  const orderedIds = [
    ...(project.assetPlan?.assets.map(({ assetId }) => assetId) ?? []),
    ...Object.keys(entries).filter(
      (assetId) =>
        !project.assetPlan?.assets.some((asset) => asset.assetId === assetId),
    ),
  ].filter((assetId) => entries[assetId] !== undefined);
  const [selectedId, setSelectedId] = useState(orderedIds[0]);
  const entry = selectedId ? entries[selectedId] : undefined;
  const asset = project.assetPlan?.assets.find(
    (candidate) => candidate.assetId === selectedId,
  );

  if (!entry)
    return (
      <section className="m2-batch-screen">
        <span className="m1-kicker">M2 batch complete</span>
        <h1>No asset evidence was included in this snapshot.</h1>
        <p>Reload the project to resolve the persisted batch reports.</p>
      </section>
    );

  return (
    <section className="m2-complete">
      <aside>
        <header>
          <span className="m1-kicker">M2 complete</span>
          <h2>Asset evidence</h2>
          <p>Select an asset to inspect its gates and cited frames.</p>
        </header>
        <nav aria-label="Produced assets">
          {orderedIds.map((assetId) => {
            const candidate = entries[assetId]!;
            const planned = project.assetPlan?.assets.find(
              (item) => item.assetId === assetId,
            );
            return (
              <button
                aria-pressed={assetId === selectedId}
                key={assetId}
                onClick={() => setSelectedId(assetId)}
                type="button"
              >
                <span>
                  <strong>{planned?.name ?? assetId}</strong>
                  <small>{candidate.classification}</small>
                </span>
                <i data-valid={candidate.validated}>
                  {candidate.validated ? "Validated" : "Needs input"}
                </i>
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="m2-complete-evidence">
        <QualityEvidencePanel
          asset={asset}
          entry={entry}
          evidence={project.assetQualityEvidence?.[entry.assetId]}
        />
      </div>
    </section>
  );
}

function SoundPlanScreen({
  busy,
  project,
  onConfirm,
}: {
  busy: boolean;
  project: ProjectSnapshot;
  onConfirm: (
    promptOverrides?: ConfirmSoundPlanInput["promptOverrides"],
  ) => void;
}) {
  const slots = project.soundPlan?.slots ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const textFor = (slot: (typeof slots)[number]): string =>
    drafts[slot.slotId] ?? slot.prompt;
  const dirtyOverrides = (): SoundPlanPromptOverride[] =>
    slots.flatMap((slot) => {
      const next = textFor(slot);
      if (next === slot.prompt) return [];
      return [{ slotId: slot.slotId, prompt: next }];
    });
  const invalidDraft = slots.some((slot) => textFor(slot).trim().length === 0);
  const liveElevenLabs =
    project.state.mode === "live" &&
    isMeteredSoundProvider(project.state.soundProvider);
  const clipCost = liveElevenLabs ? SOUND_RESERVE_USD * slots.length : 0;
  return (
    <section className="concept-plan-review sound-plan-review">
      <header>
        <span className="m1-kicker">Before sound generation runs</span>
        <h1>Fulcrum proposes this sound palette.</h1>
        <p>
          These clips come from the Game Design Spec and visual direction you
          approved. Each prompt is sent exactly as written. Edit a slot before
          you confirm.
        </p>
        <div
          aria-hidden="true"
          className="vx-mascot-perch"
          data-mascot-frame="perch"
        />
      </header>
      <div className="concept-plan-list">
        {slots.map((slot, index) => {
          const proposed = slot.prompt;
          const draft = textFor(slot);
          const dirty = draft !== proposed;
          return (
            <article key={slot.slotId}>
              <i>{padIndex(index)}</i>
              <span>
                <small>{slot.purpose}</small>
                <strong>{slot.title}</strong>
                <p>
                  {slot.durationSeconds.toFixed(1)}s{slot.loop ? " · loop" : ""}
                </p>
                <label className="slot-prompt">
                  <span>Prompt sent to sound generation</span>
                  <SlotPromptEditor
                    maxLength={SOUND_PROMPT_MAX}
                    onChange={(value) =>
                      setDrafts((current) => ({
                        ...current,
                        [slot.slotId]: value,
                      }))
                    }
                    value={draft}
                  />
                  {dirty && (
                    <button
                      className="slot-prompt-reset"
                      onClick={() =>
                        setDrafts((current) => {
                          const next = { ...current };
                          delete next[slot.slotId];
                          return next;
                        })
                      }
                      type="button"
                    >
                      Reset to proposed
                    </button>
                  )}
                </label>
              </span>
            </article>
          );
        })}
      </div>
      <footer>
        <div>
          <strong>{soundRouteLabel(project.state)}</strong>
          <small>
            {liveElevenLabs
              ? `Spent ${formatUsd(project.state.spentUsd)} of ${formatUsd(project.state.budgetUsd)}. Confirming the palette generates every listed clip and reserves ${formatUsd(clipCost)}.`
              : "Confirming the palette generates every listed clip with no metered sound spend."}
          </small>
        </div>
        <button
          className="m1-primary"
          disabled={busy || invalidDraft}
          onClick={() => {
            const overrides = dirtyOverrides();
            onConfirm(overrides.length > 0 ? overrides : undefined);
          }}
          type="button"
        >
          Confirm palette and generate <span>→</span>
        </button>
      </footer>
    </section>
  );
}

function SoundPlaybackScreen({
  busy,
  notes,
  project,
  onApprove,
  onNotes,
  onRegenerate,
  onReject,
}: {
  busy: boolean;
  notes: Record<string, string>;
  project: ProjectSnapshot;
  onApprove: () => void;
  onNotes: (slotId: string, value: string) => void;
  onRegenerate: (slotId: string) => void;
  onReject: () => void;
}) {
  const slots = project.soundSet?.slots ?? [];
  return (
    <section className="sound-playback-review">
      <header>
        <span className="m1-kicker">Sound palette</span>
        <h1>Listen to the generated clips.</h1>
        <p>
          Each clip is the prompt that was sent. Regenerate a slot with a
          focused note, then approve the palette to complete M1.
        </p>
        <div
          aria-hidden="true"
          className="vx-mascot-perch"
          data-mascot-frame="perch"
        />
      </header>
      <div className="sound-playback-list">
        {slots.map((slot, index) => {
          const documents = project.soundDocuments?.[slot.slotId] ?? [];
          const selectedIndex = slot.revisions.findIndex(
            (entry) => entry.revision.revisionId === slot.selectedRevisionId,
          );
          const selected =
            (selectedIndex >= 0 ? documents[selectedIndex] : undefined) ??
            documents.at(-1);
          const regenCount =
            project.state.soundRegenerationCounts?.[slot.slotId] ?? 0;
          return (
            <article key={slot.slotId}>
              <i>{padIndex(index)}</i>
              <span>
                <small>{slot.purpose}</small>
                <strong>{slot.title}</strong>
                {selected?.audio.uri ? (
                  <audio controls preload="metadata" src={selected.audio.uri} />
                ) : (
                  <p>No audio artifact on this revision.</p>
                )}
                {selected?.prompt && (
                  <details className="exact-prompt-sent">
                    <summary>Exact prompt sent</summary>
                    <pre>{selected.prompt}</pre>
                  </details>
                )}
                <label className="slot-prompt">
                  <span>Regenerate this slot</span>
                  <textarea
                    maxLength={1000}
                    onChange={(event) =>
                      onNotes(slot.slotId, event.target.value)
                    }
                    placeholder="Describe the focused change for the next clip."
                    rows={2}
                    value={notes[slot.slotId] ?? ""}
                  />
                </label>
                <button
                  className="m1-secondary"
                  disabled={busy}
                  onClick={() => onRegenerate(slot.slotId)}
                  type="button"
                >
                  {project.state.mode === "live" &&
                  project.state.soundProvider === "elevenlabs"
                    ? `Generate a new clip · ${formatUsd(SOUND_RESERVE_USD)}`
                    : "Regenerate this slot"}
                </button>
                {regenCount > 0 && (
                  <small>
                    {regenCount} regeneration{regenCount === 1 ? "" : "s"}
                  </small>
                )}
              </span>
            </article>
          );
        })}
      </div>
      <footer>
        <button
          className="m1-secondary"
          disabled={busy}
          onClick={onReject}
          type="button"
        >
          Reject palette
        </button>
        <button
          className="m1-primary"
          disabled={busy}
          onClick={onApprove}
          type="button"
        >
          Approve sound palette <span>→</span>
        </button>
      </footer>
    </section>
  );
}

/** A stage the project has been through, opened from the rail. The pitch has
 *  no screen of its own — the create form is not a record — so its record is
 *  the brief the world was created from and the routes it was created with. */
function PitchRecordScreen({ project }: { project: ProjectSnapshot }) {
  const fields = routeFields(project.state);
  return (
    <section className="concept-complete vx-stage-record">
      <span className="m1-kicker">Pitch · recorded</span>
      <h1>{projectTitle(project)}</h1>
      <blockquote className="vx-stage-record-brief">
        {project.briefText}
      </blockquote>
      <dl className="vx-stage-record-rows">
        <div>
          <dt>Mode</dt>
          <dd>{project.state.mode}</dd>
        </div>
        {fields.map((field) => (
          <div key={field.key}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
      <p>
        The pitch and its routes are fixed at creation. This is the record, not
        an editor.
      </p>
    </section>
  );
}

/** A stage that is behind the project but whose artifacts this snapshot does
 *  not carry. Saying so beats rendering a screen with nothing in it. */
function StageRecordUnavailable({
  stage,
}: {
  stage: HotbarStageKey | undefined;
}) {
  return (
    <section className="concept-complete vx-stage-record">
      <span className="m1-kicker">
        {stage ? HOTBAR_STAGE_LABELS[stage] : "Stage"} · no record
      </span>
      <h1>This stage&apos;s record isn&apos;t available.</h1>
      <p>
        The coordinator&apos;s snapshot for this world does not carry the
        artifacts that screen reads. Nothing is lost — the stage simply has
        nothing to show here.
      </p>
    </section>
  );
}

function BlockedScreen({
  busy,
  project,
  onReopen,
  onResume,
}: {
  busy: boolean;
  project: ProjectSnapshot;
  onReopen: (gate: ApprovalGate) => void;
  onResume: (nextBudgetUsd?: number) => void;
}) {
  const reason = project.state.blockedReason;
  /* Which cap ran out, from the refusal rather than from the routing: a live
     M2 Meshy world can also stop on its USD cap, and offering it a credit
     field there raised a cap that was not the one in the way. */
  const budgetKind = blockedBudgetKind(reason);
  const budgetRefused = budgetKind !== undefined;
  const meshyCredits = budgetKind === "meshy-credits";
  const currentBudget = meshyCredits
    ? (project.state.meshyCreditBudget ?? 0)
    : project.state.budgetUsd;
  const suggestedBudget = meshyCredits
    ? suggestedNextMeshyCredits(currentBudget)
    : suggestedNextBudgetUsd(currentBudget);
  const [nextBudget, setNextBudget] = useState(suggestedBudget);
  useEffect(() => {
    setNextBudget(suggestedBudget);
  }, [project.state.projectId, suggestedBudget]);
  const invalidBudget =
    budgetRefused &&
    (!Number.isFinite(nextBudget) ||
      nextBudget <= currentBudget ||
      (meshyCredits && !Number.isInteger(nextBudget)));
  /* A rejection is not a failure. When the block records one, the screen stops
     talking about a stopped forge and talks about the decision the user made
     and the review waiting to be reopened. Every other block — a credit cap, a
     hard failure — keeps the presentation below unchanged. */
  const rescue = reviewGateRescue(project.state);
  if (rescue)
    return (
      <section className="concept-complete vx-blocked-card vx-blocked-review">
        <span className="vx-blocked-eyebrow">
          <span className="m1-kicker">Review paused</span>
          {reason?.code && <code>{reason.code}</code>}
        </span>
        <h1>{rescue.headline}</h1>
        <p>{rescue.body}</p>
        <div className="blocked-recovery">
          <button
            className="m1-primary"
            disabled={busy}
            onClick={() => onReopen(rescue.gate)}
            type="button"
          >
            {rescue.actionLabel}
            <span>→</span>
          </button>
          <small className="vx-blocked-nospend">
            No generation, no spend — the same revisions come back exactly as
            you left them.
          </small>
        </div>
      </section>
    );
  return (
    /* The H1 is the sentence, not the reason code: `submission-unknown` set in
       26px display type was the largest thing on a money-at-risk screen. The
       code still ships — engineers and support need it — as a mono chip beside
       the eyebrow. */
    <section className="concept-complete vx-blocked-card">
      <span className="vx-blocked-eyebrow">
        <span className="m1-kicker">Project blocked</span>
        {reason?.code && <code>{reason.code}</code>}
      </span>
      <h1>{blockedHeadline(reason)}</h1>
      {reason?.message && <p>{reason.message}</p>}
      {reason?.recoverable && (
        <div className="blocked-recovery">
          {budgetRefused && (
            <label className="vx-budget-field">
              <span>
                {meshyCredits
                  ? "New Meshy credit budget"
                  : "New project cap USD"}
              </span>
              <input
                aria-label={
                  meshyCredits
                    ? "New Meshy credit budget"
                    : "New project budget in USD"
                }
                min={currentBudget + (meshyCredits ? 1 : 0.01)}
                onChange={(event) => setNextBudget(Number(event.target.value))}
                step={meshyCredits ? MESHY_CREDIT_RAISE_STEP : 0.01}
                type="number"
                value={nextBudget}
              />
              <small>
                Fulcrum stops again before spending beyond the new cap.
              </small>
            </label>
          )}
          <button
            className="m1-primary"
            disabled={busy || invalidBudget}
            onClick={() => onResume(budgetRefused ? nextBudget : undefined)}
            type="button"
          >
            {budgetRefused ? "Raise budget & resume" : "Resume project"}
            <span>→</span>
          </button>
        </div>
      )}
    </section>
  );
}
