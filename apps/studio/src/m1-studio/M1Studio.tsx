import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ConfigurationStatus,
  CreateProjectInput,
  M1ApprovalInput,
  ProjectSnapshot,
  ProviderMode,
  VisualDirection,
} from "@fulcrum/domain";

import * as m1 from "../m1-api.js";
import { MascotStage } from "../m1-prototype/MascotStage.js";
import {
  VoxelCube,
  VoxelWorld,
  voxelMaxLevel,
} from "../m1-prototype/M1Prototype.js";
import "../m1-prototype/m1-prototype.css";
import {
  IMAGE_RESERVE_USD,
  PINNED_ASPECT_OPTIONS,
  SAMPLE_M1_BRIEF,
  allSlotsSelected,
  budgetRaisePrompt,
  currentRound,
  describeStudioError,
  directionSha256,
  firstOpenSlotId,
  formatUsd,
  hotbarForSnapshot,
  liveGeneratingCopy,
  mascotForSnapshot,
  projectTitle,
  recordedAnswers,
  screenForSnapshot,
  selectedDirection,
  slotRevisionViews,
  suggestedNextBudgetUsd,
  voxelPaletteFromTokens,
  voxelWorldView,
  type BudgetRaisePrompt,
  type M1StudioScreen,
} from "./snapshot-view.js";

type PendingStudioAction =
  | { kind: "generate"; conceptPlanRevisionId: string }
  | {
      kind: "regenerate";
      conceptSetRevisionId: string;
      slotId: string;
      notes?: string;
    };

const PROJECT_PARAM = "project";

const readProjectId = (): string | null =>
  new URLSearchParams(window.location.search).get(PROJECT_PARAM);

const writeProjectId = (projectId: string | null): void => {
  const url = new URL(window.location.href);
  url.searchParams.set("studio", "m1");
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
  message,
  budgetRefused,
  busy,
  prompt,
  raiseBudgetUsd,
  onDismiss,
  onRaiseBudgetUsd,
  onRetry,
}: {
  message: string;
  budgetRefused: boolean;
  busy: boolean;
  prompt: BudgetRaisePrompt | undefined;
  raiseBudgetUsd: number;
  onDismiss: () => void;
  onRaiseBudgetUsd: (value: number) => void;
  onRetry: () => void;
}) {
  if (budgetRefused && prompt) {
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
  return (
    <div className="vx-error" role="alert">
      <strong>The forge refused this step</strong>
      <p>{message}</p>
    </div>
  );
}

function BudgetChip({
  spentUsd,
  budgetUsd,
}: {
  spentUsd: number;
  budgetUsd: number;
}) {
  return (
    <span className="vx-budget">
      Spent {formatUsd(spentUsd)} / {formatUsd(budgetUsd)}
    </span>
  );
}

function padIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function M1Studio() {
  const [configuration, setConfiguration] =
    useState<ConfigurationStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [bootError, setBootError] = useState("");
  const [error, setError] = useState("");
  const [budgetRefused, setBudgetRefused] = useState(false);
  const [working, setWorking] = useState("");
  const [brief, setBrief] = useState(SAMPLE_M1_BRIEF);
  const [mode, setMode] = useState<ProviderMode>("replay");
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
  const [inspectingSlotId, setInspectingSlotId] = useState<string>();
  const [viewedRevisionId, setViewedRevisionId] = useState<string>();
  const [regenNotes, setRegenNotes] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingStudioAction>();
  const [raiseDraft, setRaiseDraft] = useState(2);
  const [shown, setShown] = useState(0);
  const [forged, setForged] = useState(0);
  const [flagPlaced, setFlagPlaced] = useState(false);
  const built = useRef(0);

  const screen: M1StudioScreen = project ? screenForSnapshot(project) : "home";

  const applySnapshot = (next: ProjectSnapshot) => {
    setProject(next);
    setProjects((current) => {
      const others = current.filter(
        (candidate) => candidate.state.projectId !== next.state.projectId,
      );
      return [next, ...others];
    });
    writeProjectId(next.state.projectId);
  };

  const mutate = async (
    label: string,
    run: () => Promise<ProjectSnapshot>,
    retry?: PendingStudioAction,
  ): Promise<ProjectSnapshot | undefined> => {
    setWorking(label);
    setError("");
    setBudgetRefused(false);
    try {
      const posted = await run();
      const fresh = await m1.getProject(posted.state.projectId);
      applySnapshot(fresh);
      setPendingAction(undefined);
      return fresh;
    } catch (cause) {
      const view = describeStudioError(cause);
      setError(view.message);
      setBudgetRefused(view.budgetRefused);
      if (view.budgetRefused && retry) {
        setPendingAction(retry);
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
        const m1Listed = m1.m1Projects(listed);
        setProjects(m1Listed);
        if (!requested) return;
        const found = m1Listed.find(
          ({ state }) => state.projectId === requested,
        );
        if (found) {
          setProject(found);
          return;
        }
        return m1.getProject(requested).then((snapshot) => {
          if (snapshot.state.milestone !== "m1") {
            setBootError("That project is not an M1 run.");
            return;
          }
          applySnapshot(snapshot);
        });
      })
      .catch((cause) =>
        setBootError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  useEffect(() => {
    const frontier = project?.interrogation?.frontier ?? [];
    const revision = project?.state.interrogation?.revisionId;
    if (!revision) return;
    setDrafts(
      Object.fromEntries(
        frontier.map((question) => [
          question.questionId,
          question.recommendation,
        ]),
      ),
    );
  }, [project?.state.interrogation?.revisionId]);

  useEffect(() => {
    setViewedDirectionId(project?.state.selectedVisualDirectionRevisionId);
    setDirectionPanel("none");
    setReplaceNotes("");
    setChangeText("");
  }, [project?.state.visualDirectionSet?.revisionId]);

  useEffect(() => {
    setInspectingSlotId(undefined);
    setViewedRevisionId(undefined);
    setRegenNotes("");
  }, [project?.state.conceptSet?.revisionId]);

  const busy = working.length > 0;
  const generating = working === "generate" || working === "regenerate";
  const direction = project
    ? selectedDirection(project, viewedDirectionId)
    : undefined;
  const round = project ? currentRound(project) : undefined;
  const answers = project ? recordedAnswers(project) : [];
  const slots = project?.conceptSet?.slots ?? [];
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
    budgetRefused && project ? budgetRaisePrompt(project) : undefined;

  useEffect(() => {
    setShown((current) => (current > decisions ? decisions : current));
  }, [decisions]);
  useEffect(() => {
    if (shown >= decisions) return;
    const timer = window.setTimeout(() => setShown(decisions), 24_000);
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
    setShown(built.current);
    setForged((count) => count + 1);
  }, []);
  const plantFlag = useCallback(() => setFlagPlaced(true), []);
  const imageReady = configuration?.imageProviders.find(
    ({ provider }) => provider === "openai-subscription",
  );

  const createProject = async () => {
    if (!rightsConfirmed || brief.trim().length < 40) return;
    const input: CreateProjectInput = {
      milestone: "m1",
      brief: brief.trim(),
      mode,
      imageProvider: mode === "live" ? "openai-subscription" : "none",
      budgetUsd,
      rightsConfirmed: true,
    };
    await mutate("create", () => m1.createM1Project(input));
  };

  const submitRound = async () => {
    if (!project || !round) return;
    const unanswered = round.questions.filter(
      (question) => !drafts[question.questionId]?.trim(),
    );
    if (unanswered.length > 0) {
      setError("Every question in this round needs an answer.");
      setBudgetRefused(false);
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
    await mutate("approve-gds", () =>
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
        "This direction is missing its revision hash. Reload the project before approving.",
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
    await mutate("replace", () =>
      m1.replaceDirection(project.state.projectId, {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: direction.revisionId,
        notes: replaceNotes.trim(),
      }),
    );
  };

  const submitChange = async () => {
    if (
      !project?.state.visualDirectionSet ||
      !direction ||
      !changeText.trim() ||
      pinnedAspects.length === 0
    )
      return;
    await mutate("change", () =>
      m1.changeDirection(project.state.projectId, {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: direction.revisionId,
        change: changeText.trim(),
        pinnedAspects,
      }),
    );
  };

  const submitConceptPlan = async () => {
    if (!project?.state.conceptPlan) return;
    const retry: PendingStudioAction = {
      kind: "generate",
      conceptPlanRevisionId: project.state.conceptPlan.revisionId,
    };
    await mutate(
      "generate",
      () =>
        m1.confirmConceptPlan(project.state.projectId, {
          conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
          confirmed: true,
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
    await mutate("approve-set", () =>
      m1.approveConceptSet(project.state.projectId, {
        targetType: "concept-set",
        targetRevisionId: project.state.conceptSet!.revisionId,
        targetSha256: project.state.conceptSet!.artifact.sha256,
        decision,
      }),
    );
  };

  const goHome = () => {
    setProject(null);
    writeProjectId(null);
    setError("");
    setBudgetRefused(false);
    setPendingAction(undefined);
  };

  const dismissError = () => {
    setError("");
    setBudgetRefused(false);
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
          }),
        retry,
      );
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
            ImageGen
          </span>
          <h1>{liveGeneratingCopy(project.state.mode)}</h1>
          <p>This can take a few minutes. Keep this page open.</p>
          <BudgetChip
            budgetUsd={project.state.budgetUsd}
            spentUsd={project.state.spentUsd}
          />
        </section>
      );
    if (screen === "home")
      return (
        <HomeScreen
          brief={brief}
          budgetUsd={budgetUsd}
          busy={busy}
          configuration={configuration}
          imageReady={imageReady?.detail}
          level={level}
          mode={mode}
          projects={projects}
          rightsConfirmed={rightsConfirmed}
          onBrief={setBrief}
          onBudget={setBudgetUsd}
          onCreate={() => void createProject()}
          onMode={setMode}
          onOpen={(next) => {
            applySnapshot(next);
          }}
          onRights={setRightsConfirmed}
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
          level={level}
          needsRevise={needsGameDesignRevise}
          palette={world.palette}
          project={project}
          reviseText={reviseText}
          styled={world.styled}
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
          onConfirm={() => void submitConceptPlan()}
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
    if (screen === "complete") return <CompleteScreen project={project} />;
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
    screen === "complete" ||
    screen === "blocked";

  return (
    <main
      className="m1-prototype variant-b-voxel m1-studio"
      data-forged={forged ? "true" : "false"}
      data-mascot={mascot.visible ? "on" : "off"}
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
          <small>
            {project
              ? `${project.state.mode.toUpperCase()} · ${project.state.stage}`
              : "WORLD SLOT 01"}
          </small>
          <strong>
            {title.length > 62 ? `${title.slice(0, 62)}…` : title}
          </strong>
        </div>
        <div className="vx-session">
          {project && (
            <BudgetChip
              budgetUsd={project.state.budgetUsd}
              spentUsd={project.state.spentUsd}
            />
          )}
          <button className="vx-session-link" onClick={goHome} type="button">
            Worlds
          </button>
        </div>
      </header>
      <div className={conceptHost ? "vx-stage vx-stage-concepts" : "vx-stage"}>
        {error && (
          <StudioError
            budgetRefused={budgetRefused && pendingAction !== undefined}
            busy={busy}
            message={error}
            prompt={raisePrompt}
            raiseBudgetUsd={raiseDraft}
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
        {screen === "complete" && project && (
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
      </div>
      <MascotStage
        decisions={decisions}
        onFlagPlaced={plantFlag}
        onPlace={place}
        screen={mascot.screen}
      />
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
  imageReady,
  level,
  mode,
  projects,
  rightsConfirmed,
  onBrief,
  onBudget,
  onCreate,
  onMode,
  onOpen,
  onRights,
}: {
  brief: string;
  budgetUsd: number;
  busy: boolean;
  configuration: ConfigurationStatus | null;
  imageReady: string | undefined;
  level: number;
  mode: ProviderMode;
  projects: ProjectSnapshot[];
  rightsConfirmed: boolean;
  onBrief: (value: string) => void;
  onBudget: (value: number) => void;
  onCreate: () => void;
  onMode: (mode: ProviderMode) => void;
  onOpen: (project: ProjectSnapshot) => void;
  onRights: (value: boolean) => void;
}) {
  return (
    <section className="vx-start">
      <div className="vx-start-copy">
        <span className="vx-kicker">
          <i />
          New world · M1 studio
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
            <small>
              {mode === "live"
                ? (imageReady ??
                  "Live create is refused unless FULCRUM_M1_LIVE_AUTHORIZED=true.")
                : "Replay does not call ImageGen."}
            </small>
          </label>
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
                ? "Live ImageGen uses your signed-in OpenAI subscription"
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
                !Number.isFinite(budgetUsd) ||
                budgetUsd <= 0
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
                      {formatUsd(item.state.spentUsd)} /{" "}
                      {formatUsd(item.state.budgetUsd)}
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
  level,
  needsRevise,
  palette,
  project,
  reviseText,
  styled,
  onApprove,
  onReject,
  onRequestChanges,
  onRevise,
  onReviseText,
}: {
  busy: boolean;
  level: number;
  needsRevise: boolean;
  palette: string[];
  project: ProjectSnapshot;
  styled: boolean;
  reviseText: string;
  onApprove: () => void;
  onReject: () => void;
  onRequestChanges: () => void;
  onRevise: () => void;
  onReviseText: (value: string) => void;
}) {
  const spec = project.gameDesignSpec;
  if (!spec) return null;
  return (
    <section className="vx-gds-layout">
      <div className="vx-signoff-world">
        <VoxelWorld
          direction={{ palette }}
          level={level}
          size="md"
          styled={styled}
        />
      </div>
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
                  {item.origin.reference ? ` · ${item.origin.reference}` : ""})
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
  onConfirm: () => void;
}) {
  const slots = project.conceptPlan?.slots ?? [];
  return (
    <section className="concept-plan-review">
      <header>
        <span className="m1-kicker">Before ImageGen runs</span>
        <h1>Fulcrum proposes creating these images.</h1>
        <p>
          This list comes from the Game Design Spec you approved. Confirming it
          authorizes generation. The proposed list is not editable here.
        </p>
      </header>
      <div className="concept-plan-list">
        {slots.map((slot, index) => (
          <article key={slot.slotId}>
            <i>{padIndex(index)}</i>
            <span>
              <small>{slot.purpose}</small>
              <strong>{slot.name}</strong>
              <p>{slot.tokenCategories.join(" · ")}</p>
            </span>
          </article>
        ))}
      </div>
      <footer>
        <div>
          <strong>
            {project.state.mode === "live"
              ? "OpenAI subscription · ImageGen"
              : "Replay · local fixtures"}
          </strong>
          <small>
            Spent {formatUsd(project.state.spentUsd)} of{" "}
            {formatUsd(project.state.budgetUsd)}. Confirming the plan generates
            every listed image.
          </small>
        </div>
        <button
          className="m1-primary"
          disabled={busy}
          onClick={onConfirm}
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
          <BudgetChip
            budgetUsd={project.state.budgetUsd}
            spentUsd={project.state.spentUsd}
          />
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
              Each regeneration is a new revision. Live mode reserves the
              per-image cost from the project budget.
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
              Uses your signed-in OpenAI subscription ·{" "}
              {formatUsd(IMAGE_RESERVE_USD)} per image
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
        <span className="m1-kicker">Final approval</span>
        <h1>Review the concept package.</h1>
        <p>
          Detailed image review is complete. This page only confirms which kept
          revisions will become project truth.
        </p>
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
      <span className="m1-kicker">Concept package approved</span>
      <h1>M1 is complete.</h1>
      <p>
        The kept image revisions are now the approved creative package. Nothing
        else was generated or selected.
      </p>
      <div className="complete-lineage">
        Game Design Spec → {directionName} Visual Bible → approved concept
        package
      </div>
      <BudgetChip
        budgetUsd={project.state.budgetUsd}
        spentUsd={project.state.spentUsd}
      />
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
