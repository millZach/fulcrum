import { randomUUID } from "node:crypto";

import {
  classifyFocusedDirectionChange,
  M1CreativeDevelopment,
} from "@fulcrum/creative";
import { z } from "zod";

import {
  AnswerFrontierRoundInputSchema,
  ChangeVisualDirectionInputSchema,
  ConceptSetSchema,
  ConceptPlanSchema,
  ConfirmConceptPlanInputSchema,
  ConfirmSharedUnderstandingInputSchema,
  CreateProjectInputSchema,
  GameDesignSpecSchema,
  InterrogationStateSchema,
  M1ConceptDocumentSchema,
  M1ApprovalInputSchema,
  ProjectSnapshotSchema,
  RegenerateConceptInputSchema,
  ReplaceVisualDirectionInputSchema,
  ReviseGameDesignSpecInputSchema,
  SelectConceptRevisionInputSchema,
  VisualDirectionSetSchema,
  type ApprovalDecision,
  type ProjectSnapshot,
  type ProjectState,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";

const now = (): string => new Date().toISOString();

const publicActor = "local-creative-director";

export class M1Coordinator {
  private readonly creative: M1CreativeDevelopment;

  constructor(readonly repository: ProjectRepository) {
    this.creative = new M1CreativeDevelopment(repository);
  }

  async create(input: unknown): Promise<ProjectSnapshot> {
    const parsed = CreateProjectInputSchema.parse(input);
    if (parsed.milestone !== "m1")
      throw new Error("M1 project creation requires milestone m1.");
    if (parsed.mode !== "replay")
      throw new Error(
        "Live M1 is not yet authorized or supported. Use replay mode for this implementation slice.",
      );

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
    const started = this.creative.beginInterrogation({
      projectId,
      runId,
      brief: parsed.brief,
    });
    this.repository.createProject({
      schemaVersion: 1,
      milestone: "m1",
      projectId,
      name: "M1 Creative Project",
      mode: parsed.mode,
      assetProvider: parsed.assetProvider,
      orchestratorProvider: parsed.orchestratorProvider,
      implementationProvider: parsed.implementationProvider,
      imageProvider: parsed.imageProvider,
      status: "awaiting-input",
      stage: "interrogation",
      runId,
      budgetUsd: parsed.budgetUsd,
      spentUsd: 0,
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
      milestone: "m1",
      mode: "replay",
      budgetUsd: parsed.budgetUsd,
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

  advance(projectId: string): ProjectSnapshot {
    this.requireM1(projectId);
    return this.snapshot(projectId);
  }

  answerFrontier(projectId: string, input: unknown): ProjectSnapshot {
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
    const next = this.creative.answerCurrentFrontier({
      projectId,
      runId: state.runId,
      brief,
      interrogation,
      roundId: parsed.roundId,
      answers: parsed.answers,
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
  }

  confirmSharedUnderstanding(
    projectId: string,
    input: unknown,
  ): ProjectSnapshot {
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
    const artifacts = this.creative.confirmSharedUnderstanding({
      projectId,
      runId: state.runId,
      brief: this.briefText(state),
      interrogation: current,
      confirmedBy: publicActor,
    });
    this.repository.saveProject({
      ...state,
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
      return this.blockAfterDecision(
        state,
        { gameDesignApproval: decision },
        "game-design-not-approved",
        "The Game Design Spec must be approved before visual directions can be generated.",
      );

    const visualDirectionSet = await this.creative.generateVisualDirections({
      projectId,
      runId: state.runId,
      gameDesignSpec: target,
    });
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
  }

  reviseGameDesign(projectId: string, input: unknown): ProjectSnapshot {
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
    const revised = this.creative.reviseGameDesignSpec({
      projectId,
      runId: state.runId,
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
    const replacement = await this.creative.replaceUnselectedDirection({
      projectId,
      runId: state.runId,
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
    const changed = await this.creative.makeFocusedDirectionChange({
      projectId,
      runId: state.runId,
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
    if (rebasedConceptSet) {
      const rebased = ConceptSetSchema.parse(
        this.repository.resolveRevision(rebasedConceptSet),
      );
      const exhausted = rebased.slots.filter(
        (slot) =>
          !slot.selectedRevisionId &&
          (state.conceptRegenerationCounts?.[slot.slotId] ?? 0) >= 1,
      );
      if (exhausted.length > 0)
        throw new Error(
          `The direction change would stale concept slots whose regeneration allowance is already used: ${exhausted
            .map((slot) => slot.slotId)
            .join(", ")}.`,
        );
    }
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
      focusedDirectionChangeCount: (state.focusedDirectionChangeCount ?? 0) + 1,
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
      return this.blockAfterDecision(
        state,
        { directionApproval: decision },
        "visual-direction-not-approved",
        "A visual direction must be approved before concepts can be generated.",
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
    const conceptPlan = this.requireRef(
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
    });
    const concepts = ConceptSetSchema.parse(
      this.repository.resolveRevision(conceptSet),
    );
    this.repository.saveProject({
      ...state,
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
    const count = state.conceptRegenerationCounts?.[parsed.slotId] ?? 0;
    if (count >= 1)
      throw new Error(
        `Concept slot ${parsed.slotId} has already been regenerated.`,
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
    const next = await this.creative.regenerateConceptSlot({
      projectId,
      runId: state.runId,
      gameDesignSpec: this.requireRef(
        state.gameDesignSpec,
        "The project has no approved Game Design Spec.",
      ),
      conceptSet: current,
      slotId: parsed.slotId,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
    });
    this.repository.saveProject({
      ...state,
      conceptSet: next,
      conceptRegenerationCounts: {
        ...(state.conceptRegenerationCounts ?? {}),
        [parsed.slotId]: count + 1,
      },
    });
    this.event(projectId, state.runId, "concept.regenerated", {
      slotId: parsed.slotId,
      previousConceptSetRevisionId: current.revisionId,
      conceptSetRevisionId: next.revisionId,
    });
    return this.snapshot(projectId);
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
      return this.blockAfterDecision(
        state,
        { conceptSetApproval: decision },
        "concept-set-not-approved",
        "The concept set was not approved.",
      );
    this.repository.saveProject({
      ...state,
      conceptSetApproval: decision,
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
    return ProjectSnapshotSchema.parse({
      state,
      briefText,
      ...(state.interrogation
        ? {
            interrogation: InterrogationStateSchema.parse(
              this.repository.resolveRevision(state.interrogation),
            ),
          }
        : {}),
      ...(gameDesignSpec ? { gameDesignSpec } : {}),
      ...(visualDirections ? { visualDirections } : {}),
      ...(selectedBible ? { visualBible: selectedBible } : {}),
      ...(conceptPlan ? { conceptPlan } : {}),
      ...(conceptSet ? { conceptSet, conceptDocuments } : {}),
    });
  }

  private requireM1(projectId: string): ProjectState {
    const state = this.repository.getProject(projectId);
    if (state.milestone !== "m1")
      throw new Error(`Project ${projectId} is not an M1 project.`);
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
      targetType: "game-design" | "visual-direction" | "concept-set";
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

  private blockAfterDecision(
    state: ProjectState,
    decision: Partial<
      Pick<
        ProjectState,
        "gameDesignApproval" | "directionApproval" | "conceptSetApproval"
      >
    >,
    code: string,
    message: string,
  ): ProjectSnapshot {
    this.repository.saveProject({
      ...state,
      ...decision,
      status: "blocked",
      stage: "blocked",
      blockedReason: { code, message, recoverable: false },
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
