import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  SOUND_PROMPT_MAX,
  isMeteredImageProvider,
  isMeteredSoundProvider,
  type ConceptPlanPromptOverride,
  type ConfigurationStatus,
  type ConfirmConceptPlanInput,
  type ConfirmSoundPlanInput,
  type CreateProjectInput,
  type ExecutionProvider,
  type ImageProvider,
  type M1ApprovalInput,
  type ProjectSnapshot,
  type ProviderMode,
  type SoundPlanPromptOverride,
  type SoundProvider,
  type VisualDirection,
} from "@fulcrum/domain";

import * as m1 from "../m1-api.js";
import { MascotStage } from "../m1-prototype/MascotStage.js";
import { AssetPlanView } from "../m2-studio/AssetPlanView.js";
import { QualityEvidencePanel } from "../m2-studio/QualityEvidencePanel.js";
import {
  VoxelCube,
  VoxelWorld,
  voxelMaxLevel,
} from "../m1-prototype/M1Prototype.js";
import "../m1-prototype/m1-prototype.css";
import "../m2-studio/asset-plan.css";
import "../m2-studio/multiview-concepts.css";
import {
  PINNED_ASPECT_OPTIONS,
  SAMPLE_M1_BRIEF,
  SOUND_RESERVE_USD,
  allSlotsSelected,
  budgetRaisePrompt,
  choreographySafetyDelay,
  choreographyStep,
  currentRound,
  describeStudioError,
  directionSha256,
  firstOpenSlotId,
  formatElapsed,
  formatUsd,
  hotbarForSnapshot,
  initialConceptReviewViewState,
  liveGeneratingCopy,
  liveSoundGeneratingCopy,
  mascotForSnapshot,
  modelWaitForSnapshot,
  modelWaitForWorking,
  projectTitle,
  recordedAnswers,
  reconcileConceptReviewView,
  routingCostNote,
  screenForSnapshot,
  selectedDirection,
  showsMeteredBudget,
  slotRevisionViews,
  soundRouteLabel,
  suggestedNextBudgetUsd,
  voxelPaletteFromTokens,
  voxelWorldView,
  type BudgetRaisePrompt,
  type M1StudioScreen,
  type ModelWaitView,
  type StudioErrorView,
} from "./snapshot-view.js";

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

function Swatches({ colors }: { colors: string[] }) {
  return (
    <div className="vx-swatches" aria-label="Direction palette">
      {colors.map((color) => (
        <i key={color} style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}

function StudioError({
  view,
  busy,
  prompt,
  raiseBudgetUsd,
  onDismiss,
  onRaiseBudgetUsd,
  onRetry,
}: {
  view: StudioErrorView;
  busy: boolean;
  prompt: BudgetRaisePrompt | undefined;
  raiseBudgetUsd: number;
  onDismiss: () => void;
  onRaiseBudgetUsd: (value: number) => void;
  onRetry: () => void;
}) {
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

function BudgetChip({ project }: { project: ProjectSnapshot }) {
  if (!showsMeteredBudget(project.state)) return null;
  return (
    <span className="vx-budget">
      Spent {formatUsd(project.state.spentUsd)} /{" "}
      {formatUsd(project.state.budgetUsd)}
    </span>
  );
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
  const [budgetUsd, setBudgetUsd] = useState(1);
  const [rightsConfirmed, setRightsConfirmed] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reviseText, setReviseText] = useState("");
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
  const [raiseDraft, setRaiseDraft] = useState(2);
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

  const screen: M1StudioScreen = project ? screenForSnapshot(project) : "home";

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
      if (view.budgetRefused && retry) {
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

  useEffect(() => {
    const requested = readProjectId();
    void Promise.all([m1.getConfiguration(), m1.listProjects()])
      .then(([config, listed]) => {
        setConfiguration(config);
        const milestoneProjects =
          milestone === "m2" ? m1.m2Projects(listed) : m1.m1Projects(listed);
        setProjects(milestoneProjects);
        if (!requested) return;
        const found = milestoneProjects.find(
          ({ state }) => state.projectId === requested,
        );
        if (found) {
          setProject(found);
          return;
        }
        return m1.getProject(requested).then((snapshot) => {
          if (snapshot.state.milestone !== milestone) {
            setBootError(
              `That project is not an ${milestone.toUpperCase()} run.`,
            );
            return;
          }
          applySnapshot(snapshot);
        });
      })
      .catch((cause) =>
        setBootError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [milestone]);

  useEffect(() => {
    const projectId = project?.state.projectId;
    if (!projectId || working) return;
    let active = true;
    const refresh = () => {
      void m1
        .getProject(projectId)
        .then((snapshot) => {
          if (active) applySnapshot(snapshot);
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
  }, [project?.state.projectId, working]);

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
    setSoundRegenNotes({});
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
  const raisePrompt =
    error?.budgetRefused && pendingAction && project
      ? budgetRaisePrompt(project)
      : undefined;

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
    const input: CreateProjectInput = {
      milestone,
      brief: brief.trim(),
      ...routing,
      ...(showsMeteredBudget(routing) ? { budgetUsd } : {}),
      rightsConfirmed: true,
    };
    await mutate("create", () =>
      milestone === "m2"
        ? m1.createM2Project(input)
        : m1.createM1Project(input),
    );
  };

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
        answers: round.questions.map((question) => ({
          questionId: question.questionId,
          value: drafts[question.questionId]!.trim(),
        })),
      }),
    );
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
    if (next && allSlotsSelected(next)) setInspectingSlotId(undefined);
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

  const decideAssetPlan = async (
    decision: "approved" | "rejected" | "changes-requested",
    notes?: string,
  ) => {
    if (!project?.state.assetPlan) return;
    await mutate(
      decision === "changes-requested"
        ? "replan-assets"
        : decision === "approved"
          ? "approve-asset-plan"
          : "reject-asset-plan",
      () =>
        m1.decideAssetPlan(project.state.projectId, {
          targetType: "asset-plan",
          targetRevisionId: project.state.assetPlan!.revisionId,
          targetSha256: project.state.assetPlan!.artifact.sha256,
          decision,
          ...(notes ? { notes } : {}),
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
    setProject(null);
    writeProjectId(null, milestone);
    setError(undefined);
    setPendingAction(undefined);
  };

  const dismissError = () => {
    setError(undefined);
    setPendingAction(undefined);
  };

  const raiseBudgetAndRetry = async () => {
    if (!project || !pendingAction) return;
    if (!Number.isFinite(raiseDraft) || raiseDraft <= project.state.budgetUsd)
      return;
    const retry = pendingAction;
    const raised = await mutate("raise-budget", () =>
      m1.increaseBudget(project.state.projectId, { budgetUsd: raiseDraft }),
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
    if (screen === "home")
      return (
        <HomeScreen
          brief={brief}
          budgetUsd={budgetUsd}
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
          onCreate={() => void createProject()}
          onImageProvider={setImageProvider}
          onImplementationProvider={setImplementationProvider}
          onMode={chooseMode}
          onOpen={(next) => {
            applySnapshot(next);
          }}
          onOrchestratorProvider={setOrchestratorProvider}
          onRights={setRightsConfirmed}
          onSoundProvider={setSoundProvider}
        />
      );
    if (!project) return null;
    if (screen === "interrogation")
      return (
        <InterrogationScreen
          busy={busy}
          drafts={drafts}
          level={level}
          palette={world.palette}
          project={project}
          round={round}
          styled={world.styled}
          onChange={(questionId, value) =>
            setDrafts((current) => ({ ...current, [questionId]: value }))
          }
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
          level={level}
          palette={voxelPaletteFromTokens(direction.visualBible.palette)}
          styled
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
    if (screen === "asset-plan")
      return (
        <AssetPlanView
          busy={busy}
          project={project}
          onDecide={(decision, notes) => void decideAssetPlan(decision, notes)}
        />
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
        <CompleteScreen project={project} />
      );
    if (screen === "blocked") return <BlockedScreen project={project} />;
    return null;
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

  const conceptHost =
    screen === "concept-plan" ||
    screen === "concept-review" ||
    screen === "sound-plan" ||
    screen === "sound-review" ||
    screen === "asset-planning" ||
    screen === "asset-plan" ||
    screen === "asset-batch" ||
    screen === "complete" ||
    screen === "blocked";

  return (
    <main
      className="m1-prototype variant-b-voxel m1-studio"
      data-forged={forged ? "true" : "false"}
      data-mascot={
        milestone === "m2" &&
        ["asset-planning", "asset-plan", "asset-batch", "complete"].includes(
          screen,
        )
          ? "off"
          : mascot.visible
            ? "on"
            : "off"
      }
      data-stage={screen}
    >
      <div className="vx-paper" aria-hidden="true" />
      <header className="vx-topbar">
        <div className="vx-brand">
          <VoxelCube className="vx-cube-brand" tone="glow" />
          <span>
            <strong>FULCRUM</strong>
            <small>WORLD FORGE</small>
          </span>
        </div>
        <div className="vx-plaque">
          {project ? (
            <small
              aria-label={`${project.state.mode.toUpperCase()} · ${project.state.stage} · ORCH ${executionProviderLabels[project.state.orchestratorProvider]} · IMPL ${executionProviderLabels[project.state.implementationProvider]} · IMAGE ${imageProviderLabels[project.state.imageProvider]}`}
              className="vx-route-label"
            >
              <span>{project.state.mode.toUpperCase()}</span>
              <span>· {project.state.stage}</span>
              <span>
                · ORCH{" "}
                {executionProviderLabels[project.state.orchestratorProvider]}
              </span>
              <span className="vx-route-implementation">
                · IMPL{" "}
                {executionProviderLabels[project.state.implementationProvider]}
              </span>
              <span className="vx-route-image">
                · IMAGE {imageProviderLabels[project.state.imageProvider]}
              </span>
            </small>
          ) : (
            <small>WORLD SLOT 01</small>
          )}
          <strong>
            {title.length > 62 ? `${title.slice(0, 62)}…` : title}
          </strong>
        </div>
        <div className="vx-session">
          {project && <BudgetChip project={project} />}
          <button className="vx-session-link" onClick={goHome} type="button">
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
            prompt={raisePrompt}
            raiseBudgetUsd={raiseDraft}
            view={error}
            onDismiss={dismissError}
            onRaiseBudgetUsd={setRaiseDraft}
            onRetry={() => void raiseBudgetAndRetry()}
          />
        )}
        {conceptHost ? (
          <div className="voxel-concept-host">{renderStage()}</div>
        ) : (
          renderStage()
        )}
        {milestone === "m1" && screen === "complete" && project && (
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
        />
      </div>
      <footer className="vx-hotbar" aria-label="Workflow hotbar">
        {(project
          ? hotbar
          : [
              {
                key: "pitch",
                label: "PITCH",
                tone: "wood",
                filled: false,
                locked: false,
                active: true,
                status: "Empty slot",
              },
              {
                key: "brief",
                label: "BRIEF",
                tone: "accent",
                filled: false,
                locked: true,
                active: false,
                status: "Needs pitch",
              },
              {
                key: "style",
                label: "STYLE",
                tone: "glow",
                filled: false,
                locked: true,
                active: false,
                status: "Needs brief",
              },
              {
                key: "images",
                label: "IMAGES",
                tone: "stone",
                filled: false,
                locked: true,
                active: false,
                status: "Needs style",
              },
              {
                key: milestone === "m2" ? "assets" : "sounds",
                label: milestone === "m2" ? "ASSETS" : "SOUNDS",
                tone: "wood",
                filled: false,
                locked: true,
                active: false,
                status: "Needs images",
              },
            ]
        ).map((slot, index) => (
          <button
            className="vx-slot"
            data-active={slot.active ? "true" : "false"}
            data-filled={slot.filled ? "true" : "false"}
            data-locked={slot.locked ? "true" : "false"}
            disabled
            key={slot.key}
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
              <small>{slot.status}</small>
            </span>
          </button>
        ))}
      </footer>
    </main>
  );
}

function HomeScreen({
  brief,
  budgetUsd,
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
  onCreate,
  onImageProvider,
  onImplementationProvider,
  onMode,
  onOpen,
  onOrchestratorProvider,
  onRights,
  onSoundProvider,
}: {
  brief: string;
  budgetUsd: number;
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
  onCreate: () => void;
  onImageProvider: (provider: ImageProvider) => void;
  onImplementationProvider: (provider: ExecutionProvider) => void;
  onMode: (mode: ProviderMode) => void;
  onOpen: (project: ProjectSnapshot) => void;
  onOrchestratorProvider: (provider: ExecutionProvider) => void;
  onRights: (value: boolean) => void;
  onSoundProvider: (provider: SoundProvider) => void;
}) {
  const orchestratorReadiness = configuration?.executionProviders.find(
    ({ provider }) => provider === orchestratorProvider,
  );
  const implementationReadiness = configuration?.executionProviders.find(
    ({ provider }) => provider === implementationProvider,
  );
  const imageReadiness = configuration?.imageProviders.find(
    ({ provider }) => provider === imageProvider,
  );
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
  const showBudget = showsMeteredBudget(routing);

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
          {mode === "live" && milestone === "m1" && (
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
          )}
          <div className="vx-model-routing">
            <span className="vx-routing-heading">
              <strong>MODEL ROUTING</strong>
              <small>
                {mode === "replay"
                  ? "Replay is offline · routing stays deterministic"
                  : "Local provider readiness"}
              </small>
            </span>
            <label>
              <span>Orchestrator</span>
              <select
                aria-label="Orchestrator model provider"
                disabled={mode === "replay"}
                onChange={(event) =>
                  onOrchestratorProvider(
                    event.target.value as ExecutionProvider,
                  )
                }
                value={orchestratorProvider}
              >
                {configuration?.executionProviders.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {executionProviderLabels[entry.provider]}
                  </option>
                ))}
              </select>
              <small className={orchestratorReadiness?.ready ? "ready" : ""}>
                {mode === "replay"
                  ? "Replay is offline · fixture text is deterministic"
                  : (orchestratorReadiness?.detail ?? "Checking provider")}
              </small>
            </label>
            <label>
              <span>Implementation</span>
              <select
                aria-label="Implementation model provider"
                disabled={mode === "replay"}
                onChange={(event) =>
                  onImplementationProvider(
                    event.target.value as ExecutionProvider,
                  )
                }
                value={implementationProvider}
              >
                {configuration?.executionProviders.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {executionProviderLabels[entry.provider]}
                  </option>
                ))}
              </select>
              <small className={implementationReadiness?.ready ? "ready" : ""}>
                {mode === "replay"
                  ? "Replay is offline · saved for later milestones"
                  : `${implementationReadiness?.detail ?? "Checking provider"} · ${milestone.toUpperCase()} saves this route for later work`}
              </small>
            </label>
            <label>
              <span>Image</span>
              <select
                aria-label="Image model provider"
                disabled={mode === "replay"}
                onChange={(event) =>
                  onImageProvider(event.target.value as ImageProvider)
                }
                value={imageProvider}
              >
                {configuration?.imageProviders.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {imageProviderLabels[entry.provider]}
                  </option>
                ))}
              </select>
              <small className={imageReadiness?.ready ? "ready" : ""}>
                {mode === "replay"
                  ? "Replay is offline · no image model is called"
                  : (imageReadiness?.detail ?? "Checking provider")}
              </small>
            </label>
          </div>
          {showBudget ? (
            <label className="vx-budget-field">
              <span>Budget USD</span>
              <input
                aria-label="Budget in USD"
                min={0.01}
                onChange={(event) => onBudget(Number(event.target.value))}
                step={0.01}
                type="number"
                value={budgetUsd}
              />
              <small>Caps calls made through metered provider routes.</small>
            </label>
          ) : (
            <p className="vx-routing-cost-note">{routingCostNote(routing)}</p>
          )}
          <label className="vx-rights">
            <input
              checked={rightsConfirmed}
              onChange={(event) => onRights(event.target.checked)}
              type="checkbox"
            />
            I confirm the rights to this brief.
          </label>
          <span className="vx-composer-foot">
            <small>
              {mode === "live"
                ? imageProvider === "openai-subscription"
                  ? "Live ImageGen uses your signed-in OpenAI subscription"
                  : showBudget
                    ? "Metered calls stop at the project budget"
                    : "No image provider is called"
                : configuration?.fixtureBrief
                  ? "Replay fixtures stay on this machine"
                  : "Replay mode"}
            </small>
            <button
              className="vx-primary"
              disabled={
                busy ||
                brief.trim().length < 40 ||
                !rightsConfirmed ||
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
                  <button onClick={() => onOpen(item)} type="button">
                    <small>
                      {item.state.mode} · {item.state.stage}
                    </small>
                    <strong>{projectTitle(item)}</strong>
                    <i>
                      {showsMeteredBudget(item.state)
                        ? `${formatUsd(item.state.spentUsd)} / ${formatUsd(item.state.budgetUsd)}`
                        : "No metered spend"}
                    </i>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function InterrogationScreen({
  busy,
  drafts,
  level,
  palette,
  project,
  round,
  styled,
  onChange,
  onSubmit,
}: {
  busy: boolean;
  drafts: Record<string, string>;
  level: number;
  palette: string[];
  project: ProjectSnapshot;
  round: ReturnType<typeof currentRound>;
  styled: boolean;
  onChange: (questionId: string, value: string) => void;
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
              <span>Your answer — edit anything you disagree with</span>
              <textarea
                aria-label={question.prompt}
                onChange={(event) =>
                  onChange(question.questionId, event.target.value)
                }
                value={drafts[question.questionId] ?? ""}
              />
            </label>
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
      <div className="vx-signoff-world">
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
          Save brief & unlock the spec <i>▸</i>
        </button>
      </article>
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

function DirectionScreen({
  busy,
  changeText,
  changeUsed,
  direction,
  directions,
  level,
  palette,
  panel,
  pinnedAspects,
  project,
  replaceNotes,
  replacementUsed,
  styled,
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
  level: number;
  palette: string[];
  panel: "none" | "replace" | "change";
  styled: boolean;
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
  return (
    <section className="vx-direction">
      <header className="vx-direction-head">
        <span className="vx-kicker">
          <i />
          Look dev unlocked
        </span>
        <h1>Choose your world style.</h1>
        <p>Three visual promises — not three camera angles.</p>
      </header>
      <div className="vx-screen">
        <img
          alt={`${direction.name} visual direction`}
          src={direction.preview.artifact.uri}
        />
        <span className="vx-screen-tag">
          preview · full frame · {direction.revisionId.slice(0, 8)}
        </span>
      </div>
      <aside className="vx-spec">
        <span className="vx-tag">
          Cartridge{" "}
          {padIndex(
            directions.findIndex(
              (item) => item.revisionId === direction.revisionId,
            ),
          )}
        </span>
        <h2>{direction.name}</h2>
        <p>{direction.rationale}</p>
        <dl>
          <div>
            <dt>Shape</dt>
            <dd>{direction.visualBible.shapeLanguage}</dd>
          </div>
          <div>
            <dt>Material</dt>
            <dd>{direction.visualBible.materials.join(" · ")}</dd>
          </div>
          <div>
            <dt>Light</dt>
            <dd>{direction.visualBible.lighting}</dd>
          </div>
        </dl>
        <Swatches
          colors={direction.visualBible.palette.map((token) => token.hex)}
        />
        {panel === "replace" && (
          <label className="vx-answer">
            <span>Replace this unselected cartridge</span>
            <textarea
              onChange={(event) => onReplaceNotes(event.target.value)}
              value={replaceNotes}
            />
            <button
              className="vx-primary vx-primary-wide"
              disabled={busy || !replaceNotes.trim()}
              onClick={onSubmitReplace}
              type="button"
            >
              Replace direction <i>▸</i>
            </button>
          </label>
        )}
        {panel === "change" && (
          <div className="vx-change-form">
            <label className="vx-answer">
              <span>Focused change</span>
              <textarea
                onChange={(event) => onChangeText(event.target.value)}
                placeholder="Add restrained electrically charged wind streaks around active threats."
                value={changeText}
              />
            </label>
            <div className="vx-pins">
              {PINNED_ASPECT_OPTIONS.map((aspect) => (
                <label key={aspect}>
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
        <div className="vx-spec-actions">
          <button
            className="vx-secondary"
            disabled={busy || !canReplace}
            onClick={() =>
              onOpenPanel(panel === "replace" ? "none" : "replace")
            }
            type="button"
          >
            {replacementUsed ? "Replacement used" : "Replace this one"}
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
            disabled={busy}
            onClick={onReject}
            type="button"
          >
            Reject
          </button>
          <button
            className="vx-primary vx-primary-wide"
            disabled={busy}
            onClick={onApprove}
            type="button"
          >
            Load this world <i>▸</i>
          </button>
        </div>
      </aside>
      <nav className="vx-cartridges" aria-label="Visual directions">
        {directions.map((item, index) => (
          <button
            data-active={
              item.revisionId === direction.revisionId ? "true" : "false"
            }
            key={item.revisionId}
            onClick={() => onView(item.revisionId)}
            type="button"
          >
            <img alt="" src={item.preview.artifact.uri} />
            <span>
              <small>Cartridge {padIndex(index)}</small>
              <strong>{item.name}</strong>
            </span>
          </button>
        ))}
      </nav>
      <div className="vx-restyle" data-mascot-frame="panel">
        <VoxelWorld
          direction={{ palette }}
          level={level}
          size="sm"
          styled={styled}
        />
        <span>Your world in {direction.name}</span>
      </div>
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

function CompleteScreen({ project }: { project: ProjectSnapshot }) {
  const directionName =
    project.visualDirections?.directions.find(
      (item) =>
        item.revisionId === project.state.selectedVisualDirectionRevisionId,
    )?.name ?? project.visualBible?.title;
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

function BlockedScreen({ project }: { project: ProjectSnapshot }) {
  return (
    <section className="concept-complete">
      <span className="m1-kicker">Project blocked</span>
      <h1>{project.state.blockedReason?.code ?? "blocked"}</h1>
      <p>{project.state.blockedReason?.message}</p>
    </section>
  );
}
