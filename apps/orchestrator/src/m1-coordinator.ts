import { randomUUID } from "node:crypto";

import {
  classifyFocusedDirectionChange,
  isM1LiveAuthorized,
  m1LiveAuthorizationMessage,
  M1CreativeDevelopment,
  resolveImageAttachments,
  storeImageAttachment,
  type SoundGenerationRunner,
  type StructuredModelExecution,
} from "@fulcrum/creative";
import {
  runCodexSubscriptionImage,
  type ExecutionProviderStatus,
  type StructuredVisionExecution,
  type SubscriptionImageRunner,
} from "@fulcrum/execution";
import {
  StagedAssetLifecycle,
  type StagedAssetAdapter,
} from "@fulcrum/production";
import { z } from "zod";

import {
  AnswerFrontierRoundInputSchema,
  attachmentsReachOrchestrator,
  AssetQualityEvidenceSchema,
  DeterministicAssetReportSchema,
  RegenerationDecisionReportSchema,
  SemanticAssetReportSchema,
  TurntableManifestSchema,
  AssetPlanSchema,
  ChangeVisualDirectionInputSchema,
  ConceptSetSchema,
  ConceptPlanSchema,
  ConfirmConceptPlanInputSchema,
  ConfirmSharedUnderstandingInputSchema,
  CommitGameNameInputSchema,
  ConfirmSoundPlanInputSchema,
  ContinueIntoM2InputSchema,
  CreateProjectInputSchema,
  GameDesignSpecSchema,
  GameNameCandidateSetSchema,
  GameNameDecisionSchema,
  M1_CONTINUATION_ISSUES,
  m1ContinuationIssue,
  projectNeedsBudget,
  projectNeedsMeshyCredits,
  InterrogationStateSchema,
  M1ConceptDocumentSchema,
  M1ApprovalInputSchema,
  ProjectSnapshotSchema,
  RegenerateConceptInputSchema,
  RegenerateSoundInputSchema,
  SoundDocumentSchema,
  SoundPlanSchema,
  SoundSetSchema,
  StoreImageAttachmentInputSchema,
  ReplaceVisualDirectionInputSchema,
  ReviseGameDesignSpecInputSchema,
  SelectConceptRevisionInputSchema,
  SuggestGameNamesInputSchema,
  VisualDirectionSetSchema,
  type ApprovalDecision,
  type ApprovalTargetType,
  type AssetQualityEvidence,
  type ContinuationProvenance,
  type M1InFlight,
  type M1InFlightAction,
  type ProjectSnapshot,
  type ProjectState,
  type RevisionRef,
  type StoredImageAttachment,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";

const now = (): string => new Date().toISOString();

const replayLatencyMs = (): number => {
  // FULCRUM_REPLAY_LATENCY_MS slows replay-only creative actions so wait states can be tested without paid calls.
  const value = Number(process.env.FULCRUM_REPLAY_LATENCY_MS ?? "0");
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const delay = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const publicActor = "local-creative-director";

export const qualityEvidenceFor = (
  repository: ProjectRepository,
  state: ProjectState,
): Record<string, AssetQualityEvidence> | undefined => {
  if (!state.assetBatch) return undefined;
  const evidence = Object.fromEntries(
    Object.keys(state.assetBatch).map((assetId) => [
      assetId,
      {
        deterministicReports: [],
        turntables: [],
        semanticReports: [],
        decisions: [],
        events: [],
      },
    ]),
  ) as Record<string, AssetQualityEvidence>;
  const seen = new Map(
    Object.keys(evidence).map((assetId) => [
      assetId,
      {
        deterministic: new Set<string>(),
        turntables: new Set<string>(),
        semantic: new Set<string>(),
        decisions: new Set<string>(),
      },
    ]),
  );

  const addRevision = (
    assetId: string,
    kind: "deterministic" | "turntables" | "semantic" | "decisions",
    revisionId: string,
  ) => {
    const target = evidence[assetId];
    const known = seen.get(assetId)?.[kind];
    if (!target || !known || known.has(revisionId)) return;
    const revision = repository.getRevision(revisionId);
    const value = repository.resolveRevision(revision);
    if (kind === "deterministic")
      target.deterministicReports.push(
        DeterministicAssetReportSchema.parse(value),
      );
    if (kind === "turntables")
      target.turntables.push(TurntableManifestSchema.parse(value));
    if (kind === "semantic")
      target.semanticReports.push(SemanticAssetReportSchema.parse(value));
    if (kind === "decisions")
      target.decisions.push({
        revisionId,
        report: RegenerationDecisionReportSchema.parse(value),
      });
    known.add(revisionId);
  };

  for (const event of repository.listEvents(state.projectId)) {
    const assetId = event.payload.assetId;
    if (typeof assetId !== "string" || !evidence[assetId]) continue;
    evidence[assetId].events.push(event);
    if (
      event.type === "asset.deterministic-quality-completed" &&
      typeof event.payload.reportRevisionId === "string"
    )
      addRevision(assetId, "deterministic", event.payload.reportRevisionId);
    if (
      event.type === "asset.turntable-rendered" &&
      typeof event.payload.turntableRevisionId === "string"
    )
      addRevision(assetId, "turntables", event.payload.turntableRevisionId);
    if (
      event.type === "asset.semantic-evaluation-completed" &&
      typeof event.payload.semanticReportRevisionId === "string"
    )
      addRevision(assetId, "semantic", event.payload.semanticReportRevisionId);
    if (
      event.type === "asset.regeneration-strategy-selected" &&
      typeof event.payload.decisionRevisionId === "string"
    )
      addRevision(assetId, "decisions", event.payload.decisionRevisionId);
  }

  for (const [assetId, entry] of Object.entries(state.assetBatch)) {
    if (entry.deterministicReport)
      addRevision(
        assetId,
        "deterministic",
        entry.deterministicReport.revisionId,
      );
    if (entry.turntable)
      addRevision(assetId, "turntables", entry.turntable.revisionId);
    if (entry.semanticReport)
      addRevision(assetId, "semantic", entry.semanticReport.revisionId);
    if (entry.decision)
      addRevision(assetId, "decisions", entry.decision.revisionId);
  }

  return Object.fromEntries(
    Object.entries(evidence).map(([assetId, value]) => [
      assetId,
      AssetQualityEvidenceSchema.parse(value),
    ]),
  );
};

export type M1CoordinatorOptions = {
  imageRunner?: SubscriptionImageRunner;
  execution?: StructuredModelExecution;
  soundRunner?: SoundGenerationRunner;
  /** Injected by tests to drive the staged gate without a real provider. */
  stagedAssetAdapter?: StagedAssetAdapter;
  stagedVisionExecution?: StructuredVisionExecution;
  stagedVisionProviderStatuses?: ExecutionProviderStatus[];
};

export class M1Coordinator {
  private readonly creative: M1CreativeDevelopment;
  readonly stagedAssets: StagedAssetLifecycle;
  private readonly inFlight = new Map<
    string,
    {
      marker: M1InFlight;
      dedupeKey: string;
      promise: Promise<ProjectSnapshot>;
    }
  >();

  constructor(
    readonly repository: ProjectRepository,
    options: M1CoordinatorOptions = {},
  ) {
    this.creative = new M1CreativeDevelopment(
      repository,
      options.imageRunner ?? runCodexSubscriptionImage,
      options.execution,
      options.soundRunner,
    );
    this.stagedAssets = new StagedAssetLifecycle(repository, {
      ...(options.stagedAssetAdapter
        ? { adapter: options.stagedAssetAdapter }
        : {}),
      ...(options.stagedVisionExecution
        ? { visionExecution: options.stagedVisionExecution }
        : {}),
      ...(options.stagedVisionProviderStatuses
        ? { visionProviderStatuses: options.stagedVisionProviderStatuses }
        : {}),
    });
  }

  /**
   * The staged asset gate's write surface. Each of these can spend credits, so
   * each one is its own explicit call rather than a flag on `advance`.
   */
  async startAssetStage(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    this.requireM2(projectId);
    await this.stagedAssets.start(projectId, input);
    return this.snapshot(projectId);
  }

  async pollAssetStage(
    projectId: string,
    assetId: string,
  ): Promise<ProjectSnapshot> {
    this.requireM2(projectId);
    await this.stagedAssets.poll(projectId, assetId);
    return this.snapshot(projectId);
  }

  async decideAssetStage(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    this.requireM2(projectId);
    await this.stagedAssets.decide(projectId, input);
    return this.snapshot(projectId);
  }

  updateMeshyConfig(projectId: string, input: unknown): ProjectSnapshot {
    this.requireM2(projectId);
    this.stagedAssets.updateConfig(projectId, input);
    return this.snapshot(projectId);
  }

  /**
   * The Images stage's approved reference views. Free — it writes bytes and a
   * revision, and spends nothing — but it decides what the next geometry task
   * will be built from, so it is a real route rather than browser state.
   */
  async storeAssetReferences(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    this.requireM2(projectId);
    await this.stagedAssets.recordReferences(projectId, input);
    return this.snapshot(projectId);
  }

  /** Free of Meshy work: classifies the already-approved front reference. */
  async detectAssetBiped(
    projectId: string,
    assetId: string,
  ): Promise<ProjectSnapshot> {
    this.requireM2(projectId);
    await this.stagedAssets.detectBiped(projectId, assetId);
    return this.snapshot(projectId);
  }

  /** A post-plan human decision; it changes no plan revision or counter. */
  overrideAssetRigEligibility(
    projectId: string,
    input: unknown,
  ): ProjectSnapshot {
    this.requireM2(projectId);
    this.stagedAssets.overrideRigEligibility(projectId, input);
    return this.snapshot(projectId);
  }

  private requireM2(projectId: string): ProjectState {
    const state = this.repository.getProject(projectId);
    if (state.milestone !== "m2")
      throw new Error(`Project ${projectId} has no staged asset gate.`);
    return state;
  }

  private creativeContext(state: {
    projectId: string;
    runId: string;
    mode: ProjectState["mode"];
    orchestratorProvider: ProjectState["orchestratorProvider"];
  }) {
    return {
      projectId: state.projectId,
      runId: state.runId,
      mode: state.mode,
      orchestratorProvider: state.orchestratorProvider,
    };
  }

  private runModelAction(
    projectId: string,
    action: M1InFlightAction,
    input: unknown,
    run: () => Promise<ProjectSnapshot>,
  ): Promise<ProjectSnapshot> {
    const dedupeKey = `${action}:${JSON.stringify(input)}`;
    const current = this.inFlight.get(projectId);
    if (current) {
      if (current.dedupeKey === dedupeKey) return current.promise;
      return Promise.reject(
        new Error(
          `Project ${projectId} is already processing ${current.marker.action}.`,
        ),
      );
    }

    const marker: M1InFlight = { action, startedAt: now() };
    let promise!: Promise<ProjectSnapshot>;
    promise = Promise.resolve()
      .then(async () => {
        const state = this.requireM1(projectId);
        if (state.mode === "replay") await delay(replayLatencyMs());
        return await run();
      })
      .finally(() => {
        if (this.inFlight.get(projectId)?.promise === promise)
          this.inFlight.delete(projectId);
      });
    this.inFlight.set(projectId, { marker, dedupeKey, promise });
    return promise;
  }

  async create(input: unknown): Promise<ProjectSnapshot> {
    const parsed = CreateProjectInputSchema.parse(input);
    if (parsed.milestone !== "m1" && parsed.milestone !== "m2")
      throw new Error("Creative project creation requires milestone m1 or m2.");
    if (parsed.mode === "live") {
      if (!isM1LiveAuthorized()) throw new Error(m1LiveAuthorizationMessage());
      if (parsed.imageProvider !== "openai-subscription")
        throw new Error(
          "Live M1 concept generation uses the signed-in OpenAI subscription ImageGen route. Set imageProvider to openai-subscription. M1 does not start a paid image-to-3D job.",
        );
    }

    const projectId = randomUUID();
    const runId = randomUUID();
    const createdAt = now();
    this.repository.reserveProject(projectId, createdAt);
    const brief = this.repository.writeRevision({
      projectId,
      entityId: `${projectId}:brief`,
      kind: "game-brief",
      value: { text: parsed.brief, rightsConfirmed: parsed.rightsConfirmed },
      runId,
    });
    if (parsed.mode === "replay") await delay(replayLatencyMs());
    const started = await this.creative.beginInterrogation({
      projectId,
      runId,
      brief: parsed.brief,
      mode: parsed.mode,
      orchestratorProvider: parsed.orchestratorProvider,
    });
    this.repository.createProject({
      schemaVersion: 1,
      milestone: parsed.milestone,
      projectId,
      name: `${parsed.milestone.toUpperCase()} Creative Project`,
      mode: parsed.mode,
      assetProvider: parsed.assetProvider,
      orchestratorProvider: parsed.orchestratorProvider,
      implementationProvider: parsed.implementationProvider,
      imageProvider: parsed.imageProvider,
      soundProvider:
        parsed.milestone === "m2" || parsed.mode === "replay"
          ? "none"
          : parsed.soundProvider,
      status: "awaiting-input",
      stage: "interrogation",
      runId,
      maxConcurrentExternalJobs: parsed.maxConcurrentExternalJobs,
      budgetUsd: parsed.budgetUsd ?? 0,
      spentUsd: 0,
      ...(parsed.meshyCreditBudget !== undefined
        ? {
            meshyCreditBudget: parsed.meshyCreditBudget,
            meshyCreditsReserved: 0,
            meshyCreditsConsumed: 0,
          }
        : {}),
      conceptReplacementCount: 0,
      directionReplacementCount: 0,
      focusedDirectionChangeCount: 0,
      conceptRegenerationCounts: {},
      brief,
      creativeCapabilities: started.capabilities,
      interrogation: started.interrogation,
      decisionRecords: [],
      createdAt,
      updatedAt: createdAt,
    });
    this.event(projectId, runId, "project.created", {
      milestone: parsed.milestone,
      mode: parsed.mode,
      ...(parsed.budgetUsd !== undefined
        ? { budgetUsd: parsed.budgetUsd }
        : {}),
      ...(parsed.meshyCreditBudget !== undefined
        ? { meshyCreditBudget: parsed.meshyCreditBudget }
        : {}),
      rightsConfirmed: true,
    });
    this.event(projectId, runId, "creative.capabilities-provisioned", {
      revisionId: started.capabilities.revisionId,
      status: "ready",
    });
    this.event(projectId, runId, "interrogation.started", {
      revisionId: started.interrogation.revisionId,
    });
    return this.snapshot(projectId);
  }

  /**
   * Seeds a new M2 world from a finished M1 one. M2 reuses M1's interrogation,
   * Game Design Spec, visual direction, concept plan, concept generation, and
   * concept-set approval, and skips M1 sound work — so a world that cleared the
   * concept-set gate already holds everything asset planning reads.
   *
   * The approved package is *referenced*, never copied: revisions and artifacts
   * are content-addressed and globally resolvable, and every concept document
   * cites the exact approved Game Design Spec revision in its ancestors. Minting
   * fresh revisions here would rewrite those IDs and break the lineage the
   * planner validates. What is genuinely new is the approval record: an approval
   * carries a project ID, and the planner requires the decision to belong to the
   * project it is planning for. So the three creative approvals are re-issued
   * against the same immutable revisions and hashes.
   *
   * The source world is never written to. Nothing is generated or submitted:
   * the descendant lands at `asset-planning` and waits to be advanced.
   */
  continueIntoM2(projectId: string, input: unknown): ProjectSnapshot {
    const parsed = ContinueIntoM2InputSchema.parse(input);
    const source = this.repository.getProject(projectId);
    const issue = m1ContinuationIssue(source);
    if (issue) throw new Error(M1_CONTINUATION_ISSUES[issue]);
    if (source.mode === "live" && !isM1LiveAuthorized())
      throw new Error(m1LiveAuthorizationMessage());

    const routing = {
      milestone: "m2",
      mode: source.mode,
      orchestratorProvider: source.orchestratorProvider,
      implementationProvider: source.implementationProvider,
      imageProvider: source.imageProvider,
      soundProvider: "none",
    } as const;
    const meshyCreditBudget =
      parsed.meshyCreditBudget ?? source.meshyCreditBudget;
    if (
      projectNeedsMeshyCredits({
        milestone: "m2",
        mode: source.mode,
        assetProvider: source.assetProvider,
      }) &&
      meshyCreditBudget === undefined
    )
      throw new Error(
        "A live M2 world needs its own Meshy credit cap before it can plan a batch.",
      );
    const budgetUsd = parsed.budgetUsd ?? source.budgetUsd;
    if (projectNeedsBudget(routing) && !(budgetUsd > 0))
      throw new Error("A positive USD budget is required for metered routes.");

    const gameDesignSpec = source.gameDesignSpec!;
    const visualBible = source.visualBible!;
    const conceptSet = source.conceptSet!;
    const spec = GameDesignSpecSchema.parse(
      this.repository.resolveRevision(gameDesignSpec),
    );
    const continuedProjectId = randomUUID();
    const runId = randomUUID();
    const createdAt = now();
    const continuedFrom: ContinuationProvenance = {
      projectId: source.projectId,
      milestone: source.milestone,
      runId: source.runId,
      name: source.name,
      gameDesignSpecRevisionId: gameDesignSpec.revisionId,
      visualDirectionRevisionId: visualBible.revisionId,
      conceptSetRevisionId: conceptSet.revisionId,
      continuedAt: createdAt,
    };

    this.repository.reserveProject(continuedProjectId, createdAt);
    const carryApproval = (
      targetType: ApprovalTargetType,
      revision: RevisionRef,
    ): ApprovalDecision =>
      this.repository.recordApproval({
        approvalId: randomUUID(),
        projectId: continuedProjectId,
        targetType,
        targetRevisionId: revision.revisionId,
        targetSha256: revision.artifact.sha256,
        decision: "approved",
        notes: `Carried into M2 from ${source.name} (${source.projectId}).`,
        decidedBy: publicActor,
        decidedAt: createdAt,
      });
    const gameDesignApproval = carryApproval("game-design", gameDesignSpec);
    const directionApproval = carryApproval("visual-direction", visualBible);
    const conceptSetApproval = carryApproval("concept-set", conceptSet);

    this.repository.createProject({
      schemaVersion: 1,
      milestone: "m2",
      projectId: continuedProjectId,
      name: spec.title,
      mode: source.mode,
      assetProvider: source.assetProvider,
      orchestratorProvider: source.orchestratorProvider,
      implementationProvider: source.implementationProvider,
      imageProvider: source.imageProvider,
      soundProvider: "none",
      status: "active",
      stage: "asset-planning",
      runId,
      maxConcurrentExternalJobs:
        parsed.maxConcurrentExternalJobs ??
        source.maxConcurrentExternalJobs ??
        2,
      budgetUsd,
      spentUsd: 0,
      ...(meshyCreditBudget !== undefined
        ? {
            meshyCreditBudget,
            meshyCreditsReserved: 0,
            meshyCreditsConsumed: 0,
          }
        : {}),
      conceptReplacementCount: source.conceptReplacementCount,
      directionReplacementCount: source.directionReplacementCount ?? 0,
      focusedDirectionChangeCount: source.focusedDirectionChangeCount ?? 0,
      conceptRegenerationCounts: source.conceptRegenerationCounts ?? {},
      brief: source.brief,
      ...(source.creativeCapabilities
        ? { creativeCapabilities: source.creativeCapabilities }
        : {}),
      ...(source.interrogation ? { interrogation: source.interrogation } : {}),
      ...(source.gameNameCandidates
        ? { gameNameCandidates: source.gameNameCandidates }
        : {}),
      ...(source.gameName ? { gameName: source.gameName } : {}),
      gameDesignSpec,
      ...(source.projectGlossary
        ? { projectGlossary: source.projectGlossary }
        : {}),
      decisionRecords: source.decisionRecords ?? [],
      visualDirectionSet: source.visualDirectionSet!,
      selectedVisualDirectionRevisionId:
        source.selectedVisualDirectionRevisionId!,
      ...(source.focusedDirectionChange
        ? { focusedDirectionChange: source.focusedDirectionChange }
        : {}),
      visualBible,
      ...(source.conceptPlan ? { conceptPlan: source.conceptPlan } : {}),
      conceptSet,
      gameDesignApproval,
      directionApproval,
      conceptSetApproval,
      continuedFrom,
      createdAt,
      updatedAt: createdAt,
    });

    this.event(continuedProjectId, runId, "project.created", {
      milestone: "m2",
      mode: source.mode,
      ...(budgetUsd > 0 ? { budgetUsd } : {}),
      ...(meshyCreditBudget !== undefined ? { meshyCreditBudget } : {}),
      rightsConfirmed: true,
      continuedFromProjectId: source.projectId,
    });
    this.event(continuedProjectId, runId, "project.continued-into-m2", {
      ...continuedFrom,
      approvalIds: [
        gameDesignApproval.approvalId,
        directionApproval.approvalId,
        conceptSetApproval.approvalId,
      ],
      stage: "asset-planning",
    });
    return this.snapshot(continuedProjectId);
  }

  advance(projectId: string): ProjectSnapshot {
    this.requireM1(projectId);
    return this.snapshot(projectId);
  }

  /**
   * Park a pasted image against a project.
   *
   * Deliberately not a `runModelAction`: uploading is not a model call, it
   * changes no project state, and the user is mid-sentence in a text box —
   * making a paste contend with the project mutex would make typing fail for
   * reasons the box could not explain. The bytes land in the same
   * content-addressed store as every generated artifact, so a duplicate paste
   * is free and the ref is servable at once.
   */
  async storeAttachment(
    projectId: string,
    input: unknown,
  ): Promise<StoredImageAttachment> {
    const parsed = StoreImageAttachmentInputSchema.parse(input);
    const state = this.requireM1(projectId);
    const attachment = await storeImageAttachment({
      repository: this.repository,
      projectId,
      dataUrl: parsed.dataUrl,
    });
    this.event(projectId, state.runId, "attachment.stored", {
      artifactId: attachment.artifactId,
      sha256: attachment.sha256,
      byteLength: attachment.byteLength,
    });
    return {
      attachment,
      reachesModel: attachmentsReachOrchestrator(state),
    };
  }

  async answerFrontier(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = AnswerFrontierRoundInputSchema.parse(input);
    const state = this.requireStage(projectId, "interrogation");
    const interrogation = this.requireRef(
      state.interrogation,
      "The project has no active interrogation.",
    );
    this.requireExpectedRevision(
      interrogation,
      parsed.interrogationRevisionId,
      "interrogation",
    );
    const brief = this.briefText(state);
    return this.runModelAction(projectId, "answers", parsed, async () => {
      const next = await this.creative.answerCurrentFrontier({
        ...this.creativeContext(state),
        brief,
        interrogation,
        roundId: parsed.roundId,
        answers: parsed.answers.map((answer) => ({
          questionId: answer.questionId,
          value: answer.value,
          attachments: resolveImageAttachments(
            this.repository,
            projectId,
            answer.attachmentArtifactIds,
          ),
        })),
      });
      this.repository.saveProject({
        ...state,
        interrogation: next,
        status: "awaiting-input",
      });
      this.event(projectId, state.runId, "interrogation.frontier-answered", {
        roundId: parsed.roundId,
        previousRevisionId: interrogation.revisionId,
        revisionId: next.revisionId,
        answerCount: parsed.answers.length,
      });
      return this.snapshot(projectId);
    });
  }

  async confirmSharedUnderstanding(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = ConfirmSharedUnderstandingInputSchema.parse(input);
    const state = this.requireStage(projectId, "interrogation");
    const current = this.requireRef(
      state.interrogation,
      "The project has no active interrogation.",
    );
    this.requireExpectedRevision(
      current,
      parsed.interrogationRevisionId,
      "interrogation",
    );
    /* Signing off the interview no longer writes the spec. The game's name is
       part of its identity, so it is decided in conversation first, and the
       spec is written against the decided name by `commitGameName`. */
    return this.runModelAction(projectId, "confirm", parsed, async () => {
      const gameNameCandidates = await this.creative.proposeGameNames({
        ...this.creativeContext(state),
        brief: this.briefText(state),
        interrogation: current,
      });
      this.repository.saveProject({
        ...state,
        gameNameCandidates,
        status: "awaiting-input",
        stage: "interrogation",
      });
      this.event(projectId, state.runId, "game-name.candidates-proposed", {
        gameNameCandidatesRevisionId: gameNameCandidates.revisionId,
        round: 1,
      });
      return this.snapshot(projectId);
    });
  }

  /** A steered batch. The conversation is repeatable: every round keeps the
   *  earlier titles out of the running and records what was asked for. */
  async suggestGameNames(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = SuggestGameNamesInputSchema.parse(input);
    const state = this.requireStage(projectId, "interrogation");
    const current = this.requireRef(
      state.gameNameCandidates,
      "This project has no proposed names to steer.",
    );
    if (state.gameName) throw new Error("This project already has a name.");
    this.requireExpectedRevision(
      current,
      parsed.gameNameCandidatesRevisionId,
      "name candidates",
    );
    const interrogation = this.requireRef(
      state.interrogation,
      "The project has no active interrogation.",
    );
    return this.runModelAction(projectId, "suggest-names", parsed, async () => {
      const gameNameCandidates = await this.creative.proposeGameNames({
        ...this.creativeContext(state),
        brief: this.briefText(state),
        interrogation,
        previous: current,
        feedback: parsed.feedback,
        attachments: resolveImageAttachments(
          this.repository,
          projectId,
          parsed.attachmentArtifactIds,
        ),
      });
      const set = GameNameCandidateSetSchema.parse(
        this.repository.resolveRevision(gameNameCandidates),
      );
      this.repository.saveProject({
        ...state,
        gameNameCandidates,
        status: "awaiting-input",
        stage: "interrogation",
      });
      this.event(projectId, state.runId, "game-name.candidates-proposed", {
        gameNameCandidatesRevisionId: gameNameCandidates.revisionId,
        previousCandidateSetRevisionId: current.revisionId,
        round: set.round,
        feedback: parsed.feedback,
      });
      return this.snapshot(projectId);
    });
  }

  /** The name wins, and the spec is written under it. */
  async commitGameName(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = CommitGameNameInputSchema.parse(input);
    const state = this.requireStage(projectId, "interrogation");
    const candidates = this.requireRef(
      state.gameNameCandidates,
      "This project has no proposed names to choose from.",
    );
    if (state.gameName) throw new Error("This project already has a name.");
    this.requireExpectedRevision(
      candidates,
      parsed.gameNameCandidatesRevisionId,
      "name candidates",
    );
    const interrogation = this.requireRef(
      state.interrogation,
      "The project has no active interrogation.",
    );
    const set = GameNameCandidateSetSchema.parse(
      this.repository.resolveRevision(candidates),
    );
    const chosen = parsed.candidateId
      ? set.candidates.find(
          (candidate) => candidate.candidateId === parsed.candidateId,
        )
      : undefined;
    if (parsed.candidateId && !chosen)
      throw new Error("That name is not in the current batch.");
    const name = chosen ? chosen.name : parsed.name!.trim();
    const decision = GameNameDecisionSchema.parse({
      name,
      origin: chosen ? "candidate" : "custom",
      ...(chosen ? { candidateId: chosen.candidateId } : {}),
      sourceCandidateSetRevisionId: candidates.revisionId,
      rounds: set.round,
      decidedBy: publicActor,
      decidedAt: now(),
    });
    return this.runModelAction(projectId, "name-game", parsed, async () => {
      /* The spec is written first: a model failure here must leave the world
         exactly where it was, with the batch still on screen and nothing
         recorded about a name that never took. */
      const artifacts = await this.creative.confirmSharedUnderstanding({
        ...this.creativeContext(state),
        brief: this.briefText(state),
        interrogation,
        confirmedBy: publicActor,
        gameName: decision.name,
      });
      const gameName = this.repository.writeRevision({
        projectId,
        entityId: `${projectId}:game-name`,
        kind: "game-name-decision",
        value: decision,
        runId: state.runId,
      });
      this.event(projectId, state.runId, "game-name.decided", {
        gameNameRevisionId: gameName.revisionId,
        name: decision.name,
        origin: decision.origin,
        rounds: decision.rounds,
      });
      this.repository.saveProject({
        ...state,
        name: decision.name,
        gameName,
        interrogation: artifacts.interrogation,
        gameDesignSpec: artifacts.gameDesignSpec,
        projectGlossary: artifacts.glossary,
        decisionRecords: artifacts.adr
          ? [...(state.decisionRecords ?? []), artifacts.adr]
          : (state.decisionRecords ?? []),
        status: "awaiting-approval",
        stage: "game-design-approval",
      });
      this.event(projectId, state.runId, "interrogation.shared-understanding", {
        interrogationRevisionId: artifacts.interrogation.revisionId,
        gameDesignSpecRevisionId: artifacts.gameDesignSpec.revisionId,
        glossaryRevisionId: artifacts.glossary.revisionId,
        ...(artifacts.adr
          ? { decisionRecordRevisionId: artifacts.adr.revisionId }
          : {}),
      });
      return this.snapshot(projectId);
    });
  }

  async approveGameDesign(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = M1ApprovalInputSchema.parse({
      ...(input as object),
      targetType: "game-design",
    });
    const state = this.requireStage(projectId, "game-design-approval");
    const target = this.requireRef(
      state.gameDesignSpec,
      "The project has no Game Design Spec.",
    );
    this.requireApprovalTarget(
      target,
      parsed.targetRevisionId,
      parsed.targetSha256,
    );
    if (
      parsed.decision === "approved" &&
      state.gameDesignApproval?.decision === "changes-requested" &&
      state.gameDesignApproval.targetRevisionId === target.revisionId
    )
      throw new Error(
        "Revise the Game Design Spec before approving a changes-requested revision.",
      );
    if (parsed.decision === "approved")
      return this.runModelAction(projectId, "approve-gds", parsed, async () => {
        const decision = this.recordDecision(state, parsed);
        this.event(projectId, state.runId, "approval.game-design-decided", {
          decision: decision.decision,
          targetRevisionId: decision.targetRevisionId,
        });
        const visualDirectionSet = await this.creative.generateVisualDirections(
          {
            ...this.creativeContext(state),
            gameDesignSpec: target,
          },
        );
        this.repository.saveProject({
          ...state,
          gameDesignApproval: decision,
          visualDirectionSet,
          status: "awaiting-approval",
          stage: "visual-direction-approval",
        });
        this.event(projectId, state.runId, "visual-directions.generated", {
          directionSetRevisionId: visualDirectionSet.revisionId,
          count: 3,
        });
        return this.snapshot(projectId);
      });

    const decision = this.recordDecision(state, parsed);
    this.event(projectId, state.runId, "approval.game-design-decided", {
      decision: decision.decision,
      targetRevisionId: decision.targetRevisionId,
    });
    if (decision.decision === "changes-requested") {
      this.repository.saveProject({
        ...state,
        gameDesignApproval: decision,
        status: "awaiting-approval",
        stage: "game-design-approval",
      });
      return this.snapshot(projectId);
    }
    if (decision.decision === "rejected")
      return this.reopenGate(
        state,
        { gameDesignApproval: decision },
        "game-design-approval",
      );

    throw new Error("Unsupported Game Design Spec approval decision.");
  }

  async reviseGameDesign(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = ReviseGameDesignSpecInputSchema.parse(input);
    const state = this.requireStage(projectId, "game-design-approval");
    const current = this.requireRef(
      state.gameDesignSpec,
      "The project has no Game Design Spec.",
    );
    this.requireExpectedRevision(
      current,
      parsed.gameDesignSpecRevisionId,
      "Game Design Spec",
    );
    if (state.gameDesignApproval?.decision !== "changes-requested")
      throw new Error(
        "The Game Design Spec can be revised here only after changes are requested.",
      );
    return this.runModelAction(projectId, "revise", parsed, async () => {
      const revised = await this.creative.reviseGameDesignSpec({
        ...this.creativeContext(state),
        gameDesignSpec: current,
        change: parsed.change,
      });
      const { gameDesignApproval: _priorApproval, ...base } = state;
      this.repository.saveProject({
        ...base,
        gameDesignSpec: revised,
        status: "awaiting-approval",
        stage: "game-design-approval",
      });
      this.event(projectId, state.runId, "game-design.revised", {
        sourceRevisionId: current.revisionId,
        revisionId: revised.revisionId,
      });
      return this.snapshot(projectId);
    });
  }

  async replaceDirection(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = ReplaceVisualDirectionInputSchema.parse(input);
    const state = this.requireStage(projectId, "visual-direction-approval");
    if ((state.directionReplacementCount ?? 0) >= 1)
      throw new Error("The M1 direction replacement allowance has been used.");
    const directionSet = this.requireRef(
      state.visualDirectionSet,
      "The project has no visual direction set.",
    );
    this.requireExpectedRevision(
      directionSet,
      parsed.directionSetRevisionId,
      "visual direction set",
    );
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision(directionSet),
    );
    const target = set.directions.find(
      (direction) => direction.revisionId === parsed.directionRevisionId,
    );
    if (!target)
      throw new Error("The requested direction is not in the current set.");
    if (state.selectedVisualDirectionRevisionId === target.revisionId)
      throw new Error("The selected direction cannot be replaced.");
    const comparisonDirection =
      state.selectedVisualDirectionRevisionId ??
      set.directions.find(
        (direction) => direction.revisionId !== target.revisionId,
      )?.revisionId;
    if (!comparisonDirection)
      throw new Error("A comparison direction is required before replacement.");
    return this.runModelAction(projectId, "replace", parsed, async () => {
      const replacement = await this.creative.replaceUnselectedDirection({
        ...this.creativeContext(state),
        gameDesignSpec: this.requireRef(
          state.gameDesignSpec,
          "The project has no approved Game Design Spec.",
        ),
        directionSet,
        directionRevisionId: target.revisionId,
        selectedDirectionRevisionId: comparisonDirection,
        notes: parsed.notes,
      });
      this.repository.saveProject({
        ...state,
        visualDirectionSet: replacement,
        directionReplacementCount: (state.directionReplacementCount ?? 0) + 1,
      });
      this.event(projectId, state.runId, "visual-direction.replaced", {
        sourceDirectionRevisionId: target.revisionId,
        directionSetRevisionId: replacement.revisionId,
      });
      return this.snapshot(projectId);
    });
  }

  async changeDirection(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = ChangeVisualDirectionInputSchema.parse(input);
    const state = this.requireOneOfStages(projectId, [
      "visual-direction-approval",
      "concept-set-approval",
    ]);
    if ((state.focusedDirectionChangeCount ?? 0) >= 1)
      throw new Error(
        "The M1 focused direction-change allowance has been used.",
      );
    if (
      state.selectedVisualDirectionRevisionId &&
      state.selectedVisualDirectionRevisionId !== parsed.directionRevisionId
    )
      throw new Error(
        "A focused change may only revise the selected direction.",
      );
    const currentSet = this.requireRef(
      state.visualDirectionSet,
      "The project has no visual direction set.",
    );
    this.requireExpectedRevision(
      currentSet,
      parsed.directionSetRevisionId,
      "visual direction set",
    );
    const before = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision(currentSet),
    );
    const source = before.directions.find(
      (direction) => direction.revisionId === parsed.directionRevisionId,
    );
    if (!source)
      throw new Error("The requested direction is not in the current set.");
    try {
      classifyFocusedDirectionChange(parsed.change);
    } catch (error) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["change"],
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
    return this.runModelAction(projectId, "change", parsed, async () => {
      const changed = await this.creative.makeFocusedDirectionChange({
        ...this.creativeContext(state),
        gameDesignSpec: this.requireRef(
          state.gameDesignSpec,
          "The project has no approved Game Design Spec.",
        ),
        directionSet: currentSet,
        directionRevisionId: parsed.directionRevisionId,
        change: parsed.change,
        pinnedAspects: parsed.pinnedAspects,
      });
      const after = VisualDirectionSetSchema.parse(
        this.repository.resolveRevision(changed.directionSet),
      );
      const selected = after.directions.find(
        (direction) => direction.directionId === source.directionId,
      );
      if (!selected)
        throw new Error(
          "The focused direction revision is missing from its set.",
        );
      const visualBible = this.repository.getRevision(selected.revisionId);
      const rebasedConceptSet = state.conceptSet
        ? this.creative.rebaseConceptSetForDirectionChange({
            projectId,
            runId: state.runId,
            conceptSet: state.conceptSet,
            directionSet: changed.directionSet,
            previousDirectionRevisionId: source.revisionId,
            newDirectionRevisionId: selected.revisionId,
          })
        : undefined;
      const {
        directionApproval: _priorDirectionApproval,
        conceptSetApproval: _priorConceptSetApproval,
        ...base
      } = state;
      this.repository.saveProject({
        ...base,
        visualDirectionSet: changed.directionSet,
        selectedVisualDirectionRevisionId: selected.revisionId,
        visualBible,
        focusedDirectionChange: changed.changeRecord,
        focusedDirectionChangeCount:
          (state.focusedDirectionChangeCount ?? 0) + 1,
        ...(rebasedConceptSet ? { conceptSet: rebasedConceptSet } : {}),
        status: "awaiting-approval",
        stage: "visual-direction-approval",
      });
      this.event(projectId, state.runId, "visual-direction.focused-change", {
        sourceDirectionRevisionId: source.revisionId,
        resultDirectionRevisionId: selected.revisionId,
        directionSetRevisionId: changed.directionSet.revisionId,
        changeRecordRevisionId: changed.changeRecord.revisionId,
        pinnedAspectCount: parsed.pinnedAspects.length,
        ...(rebasedConceptSet
          ? { conceptSetRevisionId: rebasedConceptSet.revisionId }
          : {}),
      });
      return this.snapshot(projectId);
    });
  }

  async approveDirection(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = M1ApprovalInputSchema.parse({
      ...(input as object),
      targetType: "visual-direction",
    });
    const state = this.requireStage(projectId, "visual-direction-approval");
    const directionSet = this.requireRef(
      state.visualDirectionSet,
      "The project has no visual direction set.",
    );
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision(directionSet),
    );
    const selected = set.directions.find(
      (direction) => direction.revisionId === parsed.targetRevisionId,
    );
    if (!selected)
      throw new Error(
        "The approval target is not in the current direction set.",
      );
    if (
      state.selectedVisualDirectionRevisionId &&
      state.selectedVisualDirectionRevisionId !== selected.revisionId
    )
      throw new Error(
        "The approval must target the selected visual direction.",
      );
    const visualBible = this.repository.getRevision(selected.revisionId);
    this.requireApprovalTarget(
      visualBible,
      parsed.targetRevisionId,
      parsed.targetSha256,
    );
    const decision = this.recordDecision(state, parsed);
    this.event(projectId, state.runId, "approval.visual-direction-decided", {
      decision: decision.decision,
      targetRevisionId: decision.targetRevisionId,
    });
    if (decision.decision === "changes-requested") {
      this.repository.saveProject({
        ...state,
        directionApproval: decision,
        status: "awaiting-approval",
        stage: "visual-direction-approval",
      });
      return this.snapshot(projectId);
    }
    if (decision.decision === "rejected")
      return this.reopenGate(
        state,
        { directionApproval: decision },
        "visual-direction-approval",
      );

    const existingConceptSet = state.conceptSet
      ? ConceptSetSchema.parse(
          this.repository.resolveRevision(state.conceptSet),
        )
      : undefined;
    if (existingConceptSet) {
      if (existingConceptSet.sourceDirectionRevisionId !== selected.revisionId)
        throw new Error(
          "The rebased concept set does not descend from this visual direction.",
        );
      this.repository.saveProject({
        ...state,
        selectedVisualDirectionRevisionId: selected.revisionId,
        visualBible,
        directionApproval: decision,
        status: "awaiting-approval",
        stage: "concept-set-approval",
      });
      this.event(projectId, state.runId, "concept-set.direction-approved", {
        conceptSetRevisionId: state.conceptSet!.revisionId,
        directionRevisionId: selected.revisionId,
      });
      return this.snapshot(projectId);
    }

    const gameDesignSpec = this.requireRef(
      state.gameDesignSpec,
      "The project has no approved Game Design Spec.",
    );
    const conceptPlan = this.creative.planConcepts({
      projectId,
      runId: state.runId,
      brief: this.briefText(state),
      gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: selected.revisionId,
    });
    this.repository.saveProject({
      ...state,
      selectedVisualDirectionRevisionId: selected.revisionId,
      visualBible,
      directionApproval: decision,
      conceptPlan,
      status: "awaiting-input",
      stage: "concept-planning",
    });
    this.event(projectId, state.runId, "concept-plan.completed", {
      conceptPlanRevisionId: conceptPlan.revisionId,
      slotCount: ConceptPlanSchema.parse(
        this.repository.resolveRevision(conceptPlan),
      ).slots.length,
    });
    return this.snapshot(projectId);
  }

  async confirmConceptPlan(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = ConfirmConceptPlanInputSchema.parse(input);
    const state = this.requireStage(projectId, "concept-planning");
    let conceptPlan = this.requireRef(
      state.conceptPlan,
      "The project has no concept plan.",
    );
    this.requireExpectedRevision(
      conceptPlan,
      parsed.conceptPlanRevisionId,
      "concept plan",
    );
    const directionSet = this.requireRef(
      state.visualDirectionSet,
      "The project has no visual direction set.",
    );
    const selectedDirectionRevisionId = state.selectedVisualDirectionRevisionId;
    if (!selectedDirectionRevisionId)
      throw new Error("The project has no selected visual direction.");
    return this.runModelAction(projectId, "generate", parsed, async () => {
      const shownPlan = ConceptPlanSchema.parse(
        this.repository.resolveRevision(conceptPlan),
      );
      const effectiveOverrides = (parsed.promptOverrides ?? []).filter(
        (override) => {
          const slot = shownPlan.slots.find(
            (candidate) => candidate.slotId === override.slotId,
          );
          const trimmed = override.prompt.trim();
          if (!trimmed) return true;
          if (!slot) return true;
          return trimmed !== slot.prompt;
        },
      );
      if (effectiveOverrides.length > 0) {
        const editedSlotIds = [
          ...new Set(effectiveOverrides.map((override) => override.slotId)),
        ];
        conceptPlan = this.creative.applyConceptPlanPromptOverrides({
          projectId,
          runId: state.runId,
          conceptPlan,
          overrides: effectiveOverrides,
        });
        this.repository.saveProject({
          ...this.repository.getProject(projectId),
          conceptPlan,
        });
        this.event(projectId, state.runId, "concept-plan.edited", {
          conceptPlanRevisionId: conceptPlan.revisionId,
          editedSlotIds,
        });
      }
      const conceptSet = await this.creative.generateConceptSet({
        projectId,
        runId: state.runId,
        gameDesignSpec: this.requireRef(
          state.gameDesignSpec,
          "The project has no approved Game Design Spec.",
        ),
        directionSet,
        selectedDirectionRevisionId,
        conceptPlan,
        mode: state.mode,
        imageProvider: state.imageProvider,
      });
      const concepts = ConceptSetSchema.parse(
        this.repository.resolveRevision(conceptSet),
      );
      const latest = this.repository.getProject(projectId);
      this.repository.saveProject({
        ...latest,
        conceptPlan,
        conceptSet,
        conceptRegenerationCounts: Object.fromEntries(
          concepts.slots.map((slot) => [slot.slotId, 0]),
        ),
        status: "awaiting-approval",
        stage: "concept-set-approval",
      });
      this.event(projectId, state.runId, "concept-plan.confirmed", {
        conceptPlanRevisionId: conceptPlan.revisionId,
      });
      this.event(projectId, state.runId, "concept-set.completed", {
        conceptSetRevisionId: conceptSet.revisionId,
        sourceDirectionRevisionId: selectedDirectionRevisionId,
      });
      return this.snapshot(projectId);
    });
  }

  async regenerateConcept(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = RegenerateConceptInputSchema.parse(input);
    const state = this.requireStage(projectId, "concept-set-approval");
    const current = this.requireRef(
      state.conceptSet,
      "The project has no concept set.",
    );
    this.requireExpectedRevision(
      current,
      parsed.conceptSetRevisionId,
      "concept set",
    );
    const setBefore = ConceptSetSchema.parse(
      this.repository.resolveRevision(current),
    );
    if (
      !state.selectedVisualDirectionRevisionId ||
      setBefore.sourceDirectionRevisionId !==
        state.selectedVisualDirectionRevisionId
    )
      throw new Error(
        "The concept set is not based on the current selected direction.",
      );
    if (!setBefore.slots.some((slot) => slot.slotId === parsed.slotId))
      throw new Error(`Concept slot ${parsed.slotId} does not exist.`);
    return this.runModelAction(projectId, "regenerate", parsed, async () => {
      const next = await this.creative.regenerateConceptSlot({
        projectId,
        runId: state.runId,
        gameDesignSpec: this.requireRef(
          state.gameDesignSpec,
          "The project has no approved Game Design Spec.",
        ),
        conceptSet: current,
        slotId: parsed.slotId,
        mode: state.mode,
        imageProvider: state.imageProvider,
        ...(parsed.notes ? { notes: parsed.notes } : {}),
      });
      const latest = this.repository.getProject(projectId);
      const count = latest.conceptRegenerationCounts?.[parsed.slotId] ?? 0;
      this.repository.saveProject({
        ...latest,
        conceptSet: next,
        conceptRegenerationCounts: {
          ...(latest.conceptRegenerationCounts ?? {}),
          [parsed.slotId]: count + 1,
        },
      });
      this.event(projectId, state.runId, "concept.regenerated", {
        slotId: parsed.slotId,
        previousConceptSetRevisionId: current.revisionId,
        conceptSetRevisionId: next.revisionId,
      });
      return this.snapshot(projectId);
    });
  }

  selectConcept(projectId: string, input: unknown): ProjectSnapshot {
    const parsed = SelectConceptRevisionInputSchema.parse(input);
    const state = this.requireStage(projectId, "concept-set-approval");
    const current = this.requireRef(
      state.conceptSet,
      "The project has no concept set.",
    );
    this.requireExpectedRevision(
      current,
      parsed.conceptSetRevisionId,
      "concept set",
    );
    const next = this.creative.selectConceptRevision({
      projectId,
      runId: state.runId,
      conceptSet: current,
      slotId: parsed.slotId,
      conceptRevisionId: parsed.conceptRevisionId,
    });
    this.repository.saveProject({ ...state, conceptSet: next });
    this.event(projectId, state.runId, "concept.revision-selected", {
      slotId: parsed.slotId,
      conceptRevisionId: parsed.conceptRevisionId,
      previousConceptSetRevisionId: current.revisionId,
      conceptSetRevisionId: next.revisionId,
    });
    return this.snapshot(projectId);
  }

  approveConceptSet(projectId: string, input: unknown): ProjectSnapshot {
    const parsed = M1ApprovalInputSchema.parse({
      ...(input as object),
      targetType: "concept-set",
    });
    const state = this.requireStage(projectId, "concept-set-approval");
    const target = this.requireRef(
      state.conceptSet,
      "The project has no concept set.",
    );
    this.requireApprovalTarget(
      target,
      parsed.targetRevisionId,
      parsed.targetSha256,
    );
    const set = ConceptSetSchema.parse(this.repository.resolveRevision(target));
    if (
      state.directionApproval?.decision !== "approved" ||
      state.directionApproval.targetRevisionId !==
        set.sourceDirectionRevisionId ||
      state.selectedVisualDirectionRevisionId !== set.sourceDirectionRevisionId
    )
      throw new Error(
        "The concept set does not descend from the current approved visual direction.",
      );
    const approvedDirection = this.repository.getRevision(
      set.sourceDirectionRevisionId,
    );
    if (
      state.directionApproval.targetSha256 !==
        approvedDirection.artifact.sha256 ||
      state.visualBible?.revisionId !== approvedDirection.revisionId ||
      state.visualBible.artifact.sha256 !== approvedDirection.artifact.sha256
    )
      throw new Error(
        "The concept set's source direction hash does not match the current approval.",
      );
    for (const slot of set.slots) {
      if (!slot.selectedRevisionId)
        throw new Error("Every concept slot must have a selected revision.");
      const selected = slot.revisions.find(
        ({ revision }) => revision.revisionId === slot.selectedRevisionId,
      );
      if (!selected)
        throw new Error(
          `Concept slot ${slot.slotId} has an invalid selection.`,
        );
      if (selected.staleReason)
        throw new Error(
          `Concept slot ${slot.slotId} has a stale selected revision: ${selected.staleReason}`,
        );
    }
    const decision = this.recordDecision(state, parsed);
    this.event(projectId, state.runId, "approval.concept-set-decided", {
      decision: decision.decision,
      targetRevisionId: decision.targetRevisionId,
    });
    if (decision.decision === "changes-requested") {
      this.repository.saveProject({
        ...state,
        conceptSetApproval: decision,
        status: "awaiting-approval",
        stage: "concept-set-approval",
      });
      return this.snapshot(projectId);
    }
    if (decision.decision === "rejected")
      return this.reopenGate(
        state,
        { conceptSetApproval: decision },
        "concept-set-approval",
      );
    if (state.milestone === "m2") {
      this.repository.saveProject({
        ...state,
        conceptSetApproval: decision,
        status: "active",
        stage: "asset-planning",
      });
      return this.snapshot(projectId);
    }
    const directionSet = this.requireRef(
      state.visualDirectionSet,
      "The project has no visual direction set.",
    );
    const selectedDirectionRevisionId = state.selectedVisualDirectionRevisionId;
    if (!selectedDirectionRevisionId)
      throw new Error("The project has no selected visual direction.");
    const soundPlan = this.creative.planSounds({
      projectId,
      runId: state.runId,
      gameDesignSpec: this.requireRef(
        state.gameDesignSpec,
        "The project has no approved Game Design Spec.",
      ),
      directionSet,
      selectedDirectionRevisionId,
    });
    this.repository.saveProject({
      ...state,
      conceptSetApproval: decision,
      soundPlan,
      soundRegenerationCounts: {},
      status: "awaiting-input",
      stage: "sound-planning",
    });
    this.event(projectId, state.runId, "sound-plan.created", {
      soundPlanRevisionId: soundPlan.revisionId,
      slotCount: SoundPlanSchema.parse(
        this.repository.resolveRevision(soundPlan),
      ).slots.length,
    });
    return this.snapshot(projectId);
  }

  async confirmSoundPlan(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = ConfirmSoundPlanInputSchema.parse(input);
    const state = this.requireStage(projectId, "sound-planning");
    let soundPlan = this.requireRef(
      state.soundPlan,
      "The project has no sound plan.",
    );
    this.requireExpectedRevision(
      soundPlan,
      parsed.soundPlanRevisionId,
      "sound plan",
    );
    const directionSet = this.requireRef(
      state.visualDirectionSet,
      "The project has no visual direction set.",
    );
    const selectedDirectionRevisionId = state.selectedVisualDirectionRevisionId;
    if (!selectedDirectionRevisionId)
      throw new Error("The project has no selected visual direction.");
    const shownPlan = SoundPlanSchema.parse(
      this.repository.resolveRevision(soundPlan),
    );
    const effectiveOverrides = (parsed.promptOverrides ?? []).filter(
      (override) => {
        const slot = shownPlan.slots.find(
          (candidate) => candidate.slotId === override.slotId,
        );
        const trimmed = override.prompt.trim();
        if (!trimmed) return true;
        if (!slot) return true;
        return trimmed !== slot.prompt;
      },
    );
    return this.runModelAction(
      projectId,
      "generate-sounds",
      parsed,
      async () => {
        if (effectiveOverrides.length > 0) {
          const editedSlotIds = [
            ...new Set(effectiveOverrides.map((override) => override.slotId)),
          ];
          soundPlan = this.creative.applySoundPlanPromptOverrides({
            projectId,
            runId: state.runId,
            soundPlan,
            overrides: effectiveOverrides,
          });
          this.repository.saveProject({
            ...this.repository.getProject(projectId),
            soundPlan,
          });
          this.event(projectId, state.runId, "sound-plan.edited", {
            soundPlanRevisionId: soundPlan.revisionId,
            editedSlotIds,
          });
        }
        const soundSet = await this.creative.generateSoundSet({
          projectId,
          runId: state.runId,
          gameDesignSpec: this.requireRef(
            state.gameDesignSpec,
            "The project has no approved Game Design Spec.",
          ),
          directionSet,
          selectedDirectionRevisionId,
          soundPlan,
          mode: state.mode,
          soundProvider: state.soundProvider,
        });
        const sounds = SoundSetSchema.parse(
          this.repository.resolveRevision(soundSet),
        );
        const latest = this.repository.getProject(projectId);
        this.repository.saveProject({
          ...latest,
          soundPlan,
          soundSet,
          soundRegenerationCounts: Object.fromEntries(
            sounds.slots.map((slot) => [slot.slotId, 0]),
          ),
          status: "awaiting-approval",
          stage: "sound-set-approval",
        });
        this.event(projectId, state.runId, "sound-plan.confirmed", {
          soundPlanRevisionId: soundPlan.revisionId,
        });
        this.event(projectId, state.runId, "sound-set.completed", {
          soundSetRevisionId: soundSet.revisionId,
          sourceDirectionRevisionId: selectedDirectionRevisionId,
        });
        return this.snapshot(projectId);
      },
    );
  }

  async regenerateSound(
    projectId: string,
    input: unknown,
  ): Promise<ProjectSnapshot> {
    const parsed = RegenerateSoundInputSchema.parse(input);
    const state = this.requireStage(projectId, "sound-set-approval");
    const current = this.requireRef(
      state.soundSet,
      "The project has no sound set.",
    );
    this.requireExpectedRevision(
      current,
      parsed.soundSetRevisionId,
      "sound set",
    );
    const setBefore = SoundSetSchema.parse(
      this.repository.resolveRevision(current),
    );
    if (!setBefore.slots.some((slot) => slot.slotId === parsed.slotId))
      throw new Error(`Sound slot ${parsed.slotId} does not exist.`);
    return this.runModelAction(
      projectId,
      "regenerate-sound",
      parsed,
      async () => {
        const next = await this.creative.regenerateSoundSlot({
          projectId,
          runId: state.runId,
          soundSet: current,
          slotId: parsed.slotId,
          mode: state.mode,
          soundProvider: state.soundProvider,
          ...(parsed.notes ? { notes: parsed.notes } : {}),
        });
        const latest = this.repository.getProject(projectId);
        const count = latest.soundRegenerationCounts?.[parsed.slotId] ?? 0;
        this.repository.saveProject({
          ...latest,
          soundSet: next,
          soundRegenerationCounts: {
            ...(latest.soundRegenerationCounts ?? {}),
            [parsed.slotId]: count + 1,
          },
        });
        this.event(projectId, state.runId, "sound.regenerated", {
          slotId: parsed.slotId,
          previousSoundSetRevisionId: current.revisionId,
          soundSetRevisionId: next.revisionId,
        });
        return this.snapshot(projectId);
      },
    );
  }

  approveSoundSet(projectId: string, input: unknown): ProjectSnapshot {
    const parsed = M1ApprovalInputSchema.parse({
      ...(input as object),
      targetType: "sound-set",
    });
    const state = this.requireStage(projectId, "sound-set-approval");
    const target = this.requireRef(
      state.soundSet,
      "The project has no sound set.",
    );
    this.requireApprovalTarget(
      target,
      parsed.targetRevisionId,
      parsed.targetSha256,
    );
    const set = SoundSetSchema.parse(this.repository.resolveRevision(target));
    if (
      state.conceptSetApproval?.decision !== "approved" ||
      !state.selectedVisualDirectionRevisionId ||
      set.sourceDirectionRevisionId !== state.selectedVisualDirectionRevisionId
    )
      throw new Error(
        "The sound set does not descend from the current approved visual direction.",
      );
    if (
      state.soundPlan &&
      set.sourceSoundPlanRevisionId !== state.soundPlan.revisionId
    )
      throw new Error(
        "The sound set does not descend from the current sound plan.",
      );
    for (const slot of set.slots) {
      if (!slot.selectedRevisionId)
        throw new Error("Every sound slot must have a selected revision.");
      const selected = slot.revisions.find(
        ({ revision }) => revision.revisionId === slot.selectedRevisionId,
      );
      if (!selected)
        throw new Error(`Sound slot ${slot.slotId} has an invalid selection.`);
      if (selected.staleReason)
        throw new Error(
          `Sound slot ${slot.slotId} has a stale selected revision: ${selected.staleReason}`,
        );
    }
    const decision = this.recordDecision(state, parsed);
    this.event(projectId, state.runId, "approval.sound-set-decided", {
      decision: decision.decision,
      targetRevisionId: decision.targetRevisionId,
    });
    if (decision.decision === "changes-requested") {
      this.repository.saveProject({
        ...state,
        soundSetApproval: decision,
        status: "awaiting-approval",
        stage: "sound-set-approval",
      });
      return this.snapshot(projectId);
    }
    if (decision.decision === "rejected")
      return this.reopenGate(
        state,
        { soundSetApproval: decision },
        "sound-set-approval",
      );
    this.repository.saveProject({
      ...state,
      soundSetApproval: decision,
      status: "complete",
      stage: "complete",
    });
    return this.snapshot(projectId);
  }

  snapshot(projectId: string): ProjectSnapshot {
    const state = this.requireM1(projectId);
    const briefText = this.briefText(state);
    const visualDirections = state.visualDirectionSet
      ? VisualDirectionSetSchema.parse(
          this.repository.resolveRevision(state.visualDirectionSet),
        )
      : undefined;
    const selectedBible = visualDirections?.directions.find(
      (direction) =>
        direction.revisionId === state.selectedVisualDirectionRevisionId,
    )?.visualBible;
    const gameDesignSpec = state.gameDesignSpec
      ? GameDesignSpecSchema.parse(
          this.repository.resolveRevision(state.gameDesignSpec),
        )
      : undefined;
    const conceptSet = state.conceptSet
      ? ConceptSetSchema.parse(
          this.repository.resolveRevision(state.conceptSet),
        )
      : undefined;
    const conceptPlan = state.conceptPlan
      ? ConceptPlanSchema.parse(
          this.repository.resolveRevision(state.conceptPlan),
        )
      : undefined;
    const soundPlan = state.soundPlan
      ? SoundPlanSchema.parse(this.repository.resolveRevision(state.soundPlan))
      : undefined;
    const soundSet = state.soundSet
      ? SoundSetSchema.parse(this.repository.resolveRevision(state.soundSet))
      : undefined;
    const soundDocuments = soundSet
      ? Object.fromEntries(
          soundSet.slots.map((slot) => [
            slot.slotId,
            slot.revisions.map(({ revision }) =>
              SoundDocumentSchema.parse(
                this.repository.resolveRevision(revision),
              ),
            ),
          ]),
        )
      : undefined;
    const conceptDocuments = conceptSet
      ? Object.fromEntries(
          conceptSet.slots.map((slot) => [
            slot.slotId,
            slot.revisions.map(({ revision }) =>
              M1ConceptDocumentSchema.parse(
                this.repository.resolveRevision(revision),
              ),
            ),
          ]),
        )
      : undefined;
    const assetPlan = state.assetPlan
      ? AssetPlanSchema.parse(this.repository.resolveRevision(state.assetPlan))
      : undefined;
    return ProjectSnapshotSchema.parse({
      state,
      briefText,
      ...(this.inFlight.get(projectId)
        ? { inFlight: this.inFlight.get(projectId)!.marker }
        : {}),
      ...(state.interrogation
        ? {
            interrogation: InterrogationStateSchema.parse(
              this.repository.resolveRevision(state.interrogation),
            ),
          }
        : {}),
      ...(state.gameNameCandidates
        ? {
            gameNameCandidates: GameNameCandidateSetSchema.parse(
              this.repository.resolveRevision(state.gameNameCandidates),
            ),
          }
        : {}),
      ...(state.gameName
        ? {
            gameName: GameNameDecisionSchema.parse(
              this.repository.resolveRevision(state.gameName),
            ),
          }
        : {}),
      ...(gameDesignSpec ? { gameDesignSpec } : {}),
      ...(visualDirections ? { visualDirections } : {}),
      ...(visualDirections
        ? {
            visualDirectionRevisions: Object.fromEntries(
              visualDirections.directions.map((direction) => [
                direction.revisionId,
                this.repository.getRevision(direction.revisionId),
              ]),
            ),
          }
        : {}),
      ...(selectedBible ? { visualBible: selectedBible } : {}),
      ...(conceptPlan ? { conceptPlan } : {}),
      ...(conceptSet ? { conceptSet, conceptDocuments } : {}),
      ...(soundPlan ? { soundPlan } : {}),
      ...(soundSet ? { soundSet, soundDocuments } : {}),
      ...(assetPlan ? { assetPlan } : {}),
      ...(state.milestone === "m2" && state.assetBatch
        ? {
            assetQualityEvidence: qualityEvidenceFor(this.repository, state),
          }
        : {}),
      ...(state.milestone === "m2"
        ? {
            meshyConfig: this.stagedAssets.config(projectId),
            ...(assetPlan
              ? { assetStages: this.stagedAssets.views(projectId) }
              : {}),
            ...(state.assetReferenceSets
              ? {
                  assetReferenceSets:
                    this.stagedAssets.referenceSets(projectId),
                }
              : {}),
          }
        : {}),
    });
  }

  private requireM1(projectId: string): ProjectState {
    const state = this.repository.getProject(projectId);
    if (state.milestone !== "m1" && state.milestone !== "m2")
      throw new Error(`Project ${projectId} has no creative front.`);
    return state;
  }

  private requireStage(
    projectId: string,
    stage: ProjectState["stage"],
  ): ProjectState {
    const state = this.requireM1(projectId);
    if (state.stage !== stage)
      throw new Error(`This project is not in the ${stage} stage.`);
    return state;
  }

  private requireOneOfStages(
    projectId: string,
    stages: ProjectState["stage"][],
  ): ProjectState {
    const state = this.requireM1(projectId);
    if (!stages.includes(state.stage))
      throw new Error(
        `This project is not in one of the allowed stages: ${stages.join(", ")}.`,
      );
    return state;
  }

  private briefText(state: ProjectState): string {
    return this.repository.resolveRevision<{ text: string }>(state.brief).text;
  }

  private requireRef(
    reference: RevisionRef | undefined,
    message: string,
  ): RevisionRef {
    if (!reference) throw new Error(message);
    return reference;
  }

  private requireExpectedRevision(
    current: RevisionRef,
    expectedRevisionId: string,
    label: string,
  ): void {
    if (current.revisionId !== expectedRevisionId)
      throw new Error(
        `The ${label} changed after this view loaded. Refresh before submitting again.`,
      );
  }

  private requireApprovalTarget(
    target: RevisionRef,
    revisionId: string,
    sha256: string,
  ): void {
    if (target.revisionId !== revisionId || target.artifact.sha256 !== sha256)
      throw new Error(
        "The approval target does not match the current immutable revision.",
      );
  }

  private recordDecision(
    state: ProjectState,
    input: {
      targetType:
        "game-design" | "visual-direction" | "concept-set" | "sound-set";
      targetRevisionId: string;
      targetSha256: string;
      decision: "approved" | "rejected" | "changes-requested";
      notes?: string | undefined;
    },
  ): ApprovalDecision {
    return this.repository.recordApproval({
      approvalId: randomUUID(),
      projectId: state.projectId,
      targetType: input.targetType,
      targetRevisionId: input.targetRevisionId,
      targetSha256: input.targetSha256,
      decision: input.decision,
      ...(input.notes ? { notes: input.notes } : {}),
      decidedBy: publicActor,
      decidedAt: now(),
    });
  }

  /**
   * A rejection is a decision, not a failure: the gate stays open on the same
   * revisions so the human can change a selection, approve, or reject again.
   * Nothing is generated here.
   */
  private reopenGate(
    state: ProjectState,
    decision: Partial<
      Pick<
        ProjectState,
        | "gameDesignApproval"
        | "directionApproval"
        | "conceptSetApproval"
        | "soundSetApproval"
      >
    >,
    stage: ProjectState["stage"],
  ): ProjectSnapshot {
    this.repository.saveProject({
      ...state,
      ...decision,
      status: "awaiting-approval",
      stage,
      blockedReason: undefined,
    });
    return this.snapshot(state.projectId);
  }

  private event(
    projectId: string,
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.repository.appendEvent({ projectId, runId, type, payload });
  }
}

export { M1Coordinator as CreativeFrontCoordinator };
