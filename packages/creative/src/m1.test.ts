import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ConceptSetSchema,
  GameDesignSpecSchema,
  InterrogationStateSchema,
  M1ConceptDocumentSchema,
  VisualDirectionSetSchema,
  type GameDesignSpec,
  type InterrogationState,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it } from "vitest";

import {
  M1CreativeDevelopment,
  classifyFocusedDirectionChange,
  type ArchitectureDecisionRecord,
  type ConceptPlan,
  type FocusedDirectionChange,
  type ProjectGlossary,
  type SkillProvisioningRecord,
} from "./m1.js";

const roots: string[] = [];
const repositories: ProjectRepository[] = [];

const createHarness = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-m1-creative-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  repositories.push(repository);
  const context = {
    projectId: `project-${roots.length}`,
    runId: `run-${roots.length}`,
  };
  repository.reserveProject(context.projectId);
  return {
    repository,
    creative: new M1CreativeDevelopment(repository),
    context,
  };
};

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const answerValue = (branchId: string): string => {
  const values: Record<string, string> = {
    "experience.player-promise":
      "Restore the storm beacon and guide the stranded fleet home",
    "gameplay.core-loop":
      "Explore the flooded arena, collect charge, defend the beacon, then escape",
    "scope.proof-boundary":
      "One keeper, one flooded arena, and one complete beacon defense",
    "presentation.camera-readability":
      "A top-down camera keeps routes, threats, and the beacon visible",
    "gameplay.success-failure":
      "The fleet arrives when the beacon fills; rising water removes safe routes",
    "scope.consequential-tradeoff":
      "Keep navigable water routes legible over adding dense storm decoration",
    "scope.adr-qualification":
      "Yes, this is hard to reverse after environment production and surprising without the route-readability tradeoff context",
    "scope.constraint-resolution":
      "Protect the navigable route silhouette whenever weather effects obscure it",
  };
  return values[branchId] ?? `Resolve ${branchId}`;
};

const resolveInterrogation = (
  repository: ProjectRepository,
  creative: M1CreativeDevelopment,
  context: { projectId: string; runId: string },
  brief: string,
  initial: RevisionRef,
  answer: (branchId: string) => string = answerValue,
): RevisionRef => {
  let revision = initial;
  for (let guard = 0; guard < 10; guard += 1) {
    const state = InterrogationStateSchema.parse(
      repository.resolveRevision<InterrogationState>(revision),
    );
    if (state.frontier.length === 0) return revision;
    const round = state.rounds.at(-1)!;
    revision = creative.answerCurrentFrontier({
      ...context,
      brief,
      interrogation: revision,
      roundId: round.roundId,
      answers: state.frontier.map((question) => ({
        questionId: question.questionId,
        value: answer(question.branchId),
      })),
    });
  }
  throw new Error("Interrogation did not converge.");
};

const createApprovedIntent = (
  repository: ProjectRepository,
  creative: M1CreativeDevelopment,
  context: { projectId: string; runId: string },
  brief: string,
  answer: (branchId: string) => string = answerValue,
) => {
  const started = creative.beginInterrogation({ ...context, brief });
  const resolved = resolveInterrogation(
    repository,
    creative,
    context,
    brief,
    started.interrogation,
    answer,
  );
  return creative.confirmSharedUnderstanding({
    ...context,
    brief,
    interrogation: resolved,
    confirmedBy: "Zach",
  });
};

const CONSTRAINT_BRIEF =
  "Design a strict top-down survival game where a lone storm keeper restores a beacon in a flooded arena; routes must remain readable while dense weather sells the danger.";

describe("M1CreativeDevelopment interrogation", () => {
  it("provisions internal capabilities and follows the decision tree until its frontier is empty", () => {
    const { repository, creative, context } = createHarness();
    const started = creative.beginInterrogation({
      ...context,
      brief: CONSTRAINT_BRIEF,
    });
    const provisioning = repository.resolveRevision<SkillProvisioningRecord>(
      started.capabilities,
    );
    expect(provisioning.status).toBe("ready");
    expect(provisioning.capabilities.map(({ name }) => name)).toEqual([
      "grill-with-docs",
      "grilling",
      "domain-modeling",
    ]);
    expect(
      provisioning.capabilities.every(({ sha256 }) => sha256.length === 64),
    ).toBe(true);

    const initial = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    expect(initial.frontier).toHaveLength(3);
    expect(initial.frontier.every(({ recommendation }) => recommendation)).toBe(
      true,
    );
    expect(() =>
      creative.confirmSharedUnderstanding({
        ...context,
        brief: CONSTRAINT_BRIEF,
        interrogation: started.interrogation,
        confirmedBy: "Zach",
      }),
    ).toThrow(/frontier is unresolved/);

    const resolved = resolveInterrogation(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
      started.interrogation,
    );
    const finalState = InterrogationStateSchema.parse(
      repository.resolveRevision(resolved),
    );
    expect(finalState.rounds.length).toBeGreaterThanOrEqual(3);
    expect(
      finalState.rounds.some((round) =>
        round.questions.some(
          (question) => question.branchId === "scope.constraint-resolution",
        ),
      ),
    ).toBe(true);
    expect(finalState.frontier).toEqual([]);

    const shared = creative.confirmSharedUnderstanding({
      ...context,
      brief: CONSTRAINT_BRIEF,
      interrogation: resolved,
      confirmedBy: "Zach",
    });
    const spec = GameDesignSpecSchema.parse(
      repository.resolveRevision(shared.gameDesignSpec),
    );
    const glossary = repository.resolveRevision<ProjectGlossary>(
      shared.glossary,
    );
    const adr = repository.resolveRevision<ArchitectureDecisionRecord>(
      shared.adr!,
    );
    expect(spec.camera).toContain("top-down");
    expect(spec.facts[0]?.origin.source).toBe("brief");
    expect(spec.assumptions[0]?.origin.source).toBe("user");
    expect(glossary.sourceInterrogationRevisionId).toBe(
      shared.interrogation.revisionId,
    );
    expect(adr.decision).toContain("legible");
    expect(adr.sourceInterrogationRevisionId).toBe(
      shared.interrogation.revisionId,
    );
  });

  it("rejects a partial frontier instead of silently dropping decisions", () => {
    const { repository, creative, context } = createHarness();
    const started = creative.beginInterrogation({
      ...context,
      brief: CONSTRAINT_BRIEF,
    });
    const state = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    expect(() =>
      creative.answerCurrentFrontier({
        ...context,
        brief: CONSTRAINT_BRIEF,
        interrogation: started.interrogation,
        roundId: state.rounds[0]!.roundId,
        answers: [
          {
            questionId: state.frontier[0]!.questionId,
            value: "Only one answer",
          },
        ],
      }),
    ).toThrow(/Every question/);
  });

  it("creates an ADR only for a durable and surprising tradeoff", () => {
    const ordinary = createHarness();
    const ordinaryBrief =
      "Create a compact puzzle about reconnecting a clock through a small sequence of clear interactions in an abstract room.";
    const ordinaryIntent = createApprovedIntent(
      ordinary.repository,
      ordinary.creative,
      ordinary.context,
      ordinaryBrief,
      (branchId) =>
        branchId === "scope.consequential-tradeoff"
          ? "Keep it simple"
          : answerValue(branchId),
    );
    expect(ordinaryIntent.adr).toBeUndefined();

    const reversible = createHarness();
    const reversibleIntent = createApprovedIntent(
      reversible.repository,
      reversible.creative,
      reversible.context,
      CONSTRAINT_BRIEF,
      (branchId) =>
        branchId === "scope.adr-qualification"
          ? "No, this is easy to reverse and obvious without extra context"
          : answerValue(branchId),
    );
    expect(reversibleIntent.adr).toBeUndefined();

    const material = createHarness();
    const materialIntent = createApprovedIntent(
      material.repository,
      material.creative,
      material.context,
      CONSTRAINT_BRIEF,
    );
    expect(materialIntent.adr).toBeDefined();
  });

  it("revises the Game Design Spec as a traceable immutable descendant", () => {
    const { repository, creative, context } = createHarness();
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const before = repository.readArtifact(intent.gameDesignSpec.artifact);
    const change =
      "The beacon must remain readable through the storm from every safe route";
    const revision = creative.reviseGameDesignSpec({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      change,
    });
    const raw = repository.resolveRevision<
      GameDesignSpec & { sourceRevisionIds: string[] }
    >(revision);
    const revised = GameDesignSpecSchema.parse(raw);
    expect(raw.sourceRevisionIds).toEqual([intent.gameDesignSpec.revisionId]);
    expect(revised.gameplayConstraints).toContain(`${change}.`);
    expect(revised.facts).toContainEqual(
      expect.objectContaining({
        text: `${change}.`,
        kind: "fact",
        origin: expect.objectContaining({ source: "user" }),
      }),
    );
    expect(repository.readArtifact(intent.gameDesignSpec.artifact)).toEqual(
      before,
    );
    expect(revision.artifact.sha256).not.toBe(
      intent.gameDesignSpec.artifact.sha256,
    );
  });
});

describe("M1CreativeDevelopment visual direction", () => {
  it("creates three distinct previews, replaces only an unselected direction, and preserves pinned aspects", async () => {
    const { repository, creative, context } = createHarness();
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSetRevision = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const set = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSetRevision),
    );
    expect(set.directions).toHaveLength(3);
    expect(new Set(set.directions.map(({ name }) => name)).size).toBe(3);
    expect(
      new Set(set.directions.map(({ visualBible }) => visualBible.overallStyle))
        .size,
    ).toBe(3);
    for (const direction of set.directions) {
      expect(direction.preview.sourceGameDesignRevisionId).toBe(
        intent.gameDesignSpec.revisionId,
      );
      expect(direction.preview.sourceVisualBibleRevisionId).toBe(
        direction.revisionId,
      );
      expect(direction.preview.artifact.mediaType).toBe("image/png");
      expect(
        repository.readArtifact(direction.preview.artifact).byteLength,
      ).toBeGreaterThan(1_000);
    }

    const selected = set.directions[0]!;
    const target = set.directions[2]!;
    await expect(
      creative.replaceUnselectedDirection({
        ...context,
        gameDesignSpec: intent.gameDesignSpec,
        directionSet: directionSetRevision,
        directionRevisionId: selected.revisionId,
        selectedDirectionRevisionId: selected.revisionId,
        notes: "Use a small material-theatre interpretation",
      }),
    ).rejects.toThrow(/selected direction cannot be replaced/);
    const replacedRevision = await creative.replaceUnselectedDirection({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: directionSetRevision,
      directionRevisionId: target.revisionId,
      selectedDirectionRevisionId: selected.revisionId,
      notes: "Use a small material-theatre interpretation",
    });
    const replaced = VisualDirectionSetSchema.parse(
      repository.resolveRevision(replacedRevision),
    );
    expect(replaced.directions[0]).toEqual(selected);
    expect(
      replaced.directions.some(
        ({ name }) => name === "Redirected Material Theatre",
      ),
    ).toBe(true);

    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: replacedRevision,
      directionRevisionId: selected.revisionId,
      change: "Add restrained wind streaks around the active objective",
      pinnedAspects: ["palette", "shape language", "readability"],
    });
    const changedSet = VisualDirectionSetSchema.parse(
      repository.resolveRevision(focused.directionSet),
    );
    const changed = changedSet.directions[0]!;
    expect(changed.visualBible.palette).toEqual(selected.visualBible.palette);
    expect(changed.visualBible.shapeLanguage).toBe(
      selected.visualBible.shapeLanguage,
    );
    expect(changed.visualBible.readabilityRules).toEqual(
      selected.visualBible.readabilityRules,
    );
    expect(changed.visualBible.tokens.at(-1)?.value).toContain("wind streaks");
    const record = repository.resolveRevision<FocusedDirectionChange>(
      focused.changeRecord,
    );
    expect(
      record.pinnedAspects.every(({ before, after }) => before === after),
    ).toBe(true);
  });
});

describe("M1CreativeDevelopment concept inheritance", () => {
  it("plans only demanded slots and regenerates one without changing its siblings", async () => {
    const { repository, creative, context } = createHarness();
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionsRevision = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const directions = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionsRevision),
    );
    const selected = directions.directions[1]!;
    repository.writeRevision({
      projectId: context.projectId,
      entityId: `${context.projectId}:unrelated-session-history`,
      kind: "session-note",
      value: { text: "SECRET UNRELATED INTERVIEW HISTORY" },
      runId: context.runId,
    });
    const planRevision = creative.planConcepts({
      ...context,
      brief: CONSTRAINT_BRIEF,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: directionsRevision,
      selectedDirectionRevisionId: selected.revisionId,
    });
    const plan = repository.resolveRevision<ConceptPlan>(planRevision);
    expect(plan.slots).toHaveLength(3);

    const conceptSetRevision = await creative.generateConceptSet({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: directionsRevision,
      selectedDirectionRevisionId: selected.revisionId,
      conceptPlan: planRevision,
    });
    const conceptSet = ConceptSetSchema.parse(
      repository.resolveRevision(conceptSetRevision),
    );
    expect(conceptSet.sourceDirectionRevisionId).toBe(selected.revisionId);
    expect(conceptSet.slots).toHaveLength(3);
    expect(
      conceptSet.slots.every(({ selectedRevisionId }) => !selectedRevisionId),
    ).toBe(true);
    const directionAncestor = repository.getRevision(selected.revisionId);
    for (const slot of conceptSet.slots) {
      const conceptRevision = slot.revisions[0]!;
      const document = M1ConceptDocumentSchema.parse(
        repository.resolveRevision(conceptRevision.revision),
      );
      expect(document.sourceRevisionIds).toContain(
        intent.gameDesignSpec.revisionId,
      );
      expect(document.sourceRevisionIds).toContain(selected.revisionId);
      expect(document.ancestors).toContainEqual({
        revisionId: intent.gameDesignSpec.revisionId,
        sha256: intent.gameDesignSpec.artifact.sha256,
        kind: intent.gameDesignSpec.kind,
      });
      expect(document.ancestors).toContainEqual({
        revisionId: directionAncestor.revisionId,
        sha256: directionAncestor.artifact.sha256,
        kind: directionAncestor.kind,
      });
      expect(document.sourceRevisionIds).toEqual(
        document.ancestors.map(({ revisionId }) => revisionId),
      );
      expect(document.prompt).not.toContain(
        "SECRET UNRELATED INTERVIEW HISTORY",
      );
      expect(
        conceptRevision.inheritedVisualTokens.some(({ value }) =>
          document.prompt.includes(value),
        ),
      ).toBe(true);
    }

    const target = conceptSet.slots[1]!;
    const untouchedBefore = conceptSet.slots.filter(
      ({ slotId }) => slotId !== target.slotId,
    );
    const regeneratedRevision = await creative.regenerateConceptSlot({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      conceptSet: conceptSetRevision,
      slotId: target.slotId,
      notes: "Widen the safe route and reduce background spray",
    });
    const regenerated = ConceptSetSchema.parse(
      repository.resolveRevision(regeneratedRevision),
    );
    expect(
      regenerated.slots.filter(({ slotId }) => slotId !== target.slotId),
    ).toEqual(untouchedBefore);
    const changed = regenerated.slots.find(
      ({ slotId }) => slotId === target.slotId,
    )!;
    expect(changed.revisions).toHaveLength(2);
    expect(changed.selectedRevisionId).toBeUndefined();
    const latest = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(changed.revisions[1]!.revision),
    );
    expect(latest.name).toBe(`${target.name} r02`);
    expect(latest.prompt).toContain("Widen the safe route");
    const priorRevisionId = target.revisions[0]!.revision.revisionId;
    expect(latest.sourceRevisionIds).toContain(priorRevisionId);
    const priorAncestor = repository.getRevision(priorRevisionId);
    expect(latest.ancestors).toContainEqual({
      revisionId: priorAncestor.revisionId,
      sha256: priorAncestor.artifact.sha256,
      kind: priorAncestor.kind,
    });
    const selectedRevision = creative.selectConceptRevision({
      ...context,
      conceptSet: regeneratedRevision,
      slotId: target.slotId,
      conceptRevisionId: changed.revisions[1]!.revision.revisionId,
    });
    const selectedSet = ConceptSetSchema.parse(
      repository.resolveRevision(selectedRevision),
    );
    expect(
      selectedSet.slots.find(({ slotId }) => slotId === target.slotId)
        ?.selectedRevisionId,
    ).toBe(changed.revisions[1]!.revision.revisionId);
  });

  it("keeps a sparse brief to one demanded concept slot", async () => {
    const { repository, creative, context } = createHarness();
    const brief =
      "Create a concise puzzle about reconnecting a broken clock through three repeatable interactions in a quiet abstract space.";
    const intent = createApprovedIntent(repository, creative, context, brief);
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const directions = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    const plan = creative.planConcepts({
      ...context,
      brief,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: directions.directions[0]!.revisionId,
    });
    expect(repository.resolveRevision<ConceptPlan>(plan).slots).toHaveLength(1);
  });

  it("invalidates only affected descendants and requires explicit fresh selection", async () => {
    const { repository, creative, context } = createHarness();
    const brief =
      "Design a top-down puzzle arena where rotating mirrors redirect a storm beam into a sealed observatory while every traversable path stays readable.";
    const intent = createApprovedIntent(repository, creative, context, brief);
    const directionSetRevision = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const directions = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSetRevision),
    );
    const selectedDirection = directions.directions[0]!;
    const planRevision = creative.planConcepts({
      ...context,
      brief,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: directionSetRevision,
      selectedDirectionRevisionId: selectedDirection.revisionId,
    });
    const conceptSetRevision = await creative.generateConceptSet({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: directionSetRevision,
      selectedDirectionRevisionId: selectedDirection.revisionId,
      conceptPlan: planRevision,
    });
    let selectedSetRevision = conceptSetRevision;
    for (const slot of ConceptSetSchema.parse(
      repository.resolveRevision(selectedSetRevision),
    ).slots) {
      selectedSetRevision = creative.selectConceptRevision({
        ...context,
        conceptSet: selectedSetRevision,
        slotId: slot.slotId,
        conceptRevisionId: slot.revisions[0]!.revision.revisionId,
      });
    }
    const original = ConceptSetSchema.parse(
      repository.resolveRevision(selectedSetRevision),
    );
    expect(
      original.slots.every(({ selectedRevisionId }) => selectedRevisionId),
    ).toBe(true);
    expect(original.slots.map(({ slotId }) => slotId)).toEqual([
      "gameplay-anchor",
      "environment-context",
    ]);

    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: directionSetRevision,
      directionRevisionId: selectedDirection.revisionId,
      change: "Add restrained wind streaks around the energized mirror",
      pinnedAspects: ["style", "atmosphere"],
    });
    const focusedDirections = VisualDirectionSetSchema.parse(
      repository.resolveRevision(focused.directionSet),
    );
    const focusedDirection = focusedDirections.directions.find(
      ({ directionId }) => directionId === selectedDirection.directionId,
    )!;
    const rebasedRevision = creative.rebaseConceptSetForDirectionChange({
      ...context,
      conceptSet: selectedSetRevision,
      directionSet: focused.directionSet,
      previousDirectionRevisionId: selectedDirection.revisionId,
      newDirectionRevisionId: focusedDirection.revisionId,
    });
    const rebased = ConceptSetSchema.parse(
      repository.resolveRevision(rebasedRevision),
    );
    expect(rebased.sourceDirectionRevisionId).toBe(focusedDirection.revisionId);
    const staleGameplay = rebased.slots[0]!;
    expect(staleGameplay.selectedRevisionId).toBeUndefined();
    expect(staleGameplay.revisions[0]?.staleReason).toContain(
      "Inherited visual tokens changed",
    );
    expect(rebased.slots[1]).toEqual(original.slots[1]);

    await expect(
      Promise.resolve().then(() =>
        creative.selectConceptRevision({
          ...context,
          conceptSet: rebasedRevision,
          slotId: staleGameplay.slotId,
          conceptRevisionId: staleGameplay.revisions[0]!.revision.revisionId,
        }),
      ),
    ).rejects.toThrow(/stale and cannot be selected/);

    const regeneratedRevision = await creative.regenerateConceptSlot({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      conceptSet: rebasedRevision,
      slotId: staleGameplay.slotId,
      notes: "Keep the streaks tight to the energized mirror",
    });
    const regenerated = ConceptSetSchema.parse(
      repository.resolveRevision(regeneratedRevision),
    );
    const refreshed = regenerated.slots[0]!;
    expect(refreshed.revisions).toHaveLength(2);
    expect(refreshed.selectedRevisionId).toBeUndefined();
    expect(refreshed.revisions[1]?.staleReason).toBeUndefined();
    expect(regenerated.slots[1]).toEqual(original.slots[1]);
    const originalDocument = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(staleGameplay.revisions[0]!.revision),
    );
    const refreshedDocument = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(refreshed.revisions[1]!.revision),
    );
    expect(refreshedDocument.name).toBe("Gameplay Anchor r02");
    expect(refreshedDocument.prompt).not.toBe(originalDocument.prompt);
    expect(refreshedDocument.prompt).toContain("wind streaks");
    expect(refreshedDocument.sourceRevisionIds).toContain(
      focusedDirection.revisionId,
    );

    const selectedRevision = creative.selectConceptRevision({
      ...context,
      conceptSet: regeneratedRevision,
      slotId: refreshed.slotId,
      conceptRevisionId: refreshed.revisions[1]!.revision.revisionId,
    });
    const ready = ConceptSetSchema.parse(
      repository.resolveRevision(selectedRevision),
    );
    expect(
      ready.slots.every((slot) => {
        const selected = slot.revisions.find(
          ({ revision }) => revision.revisionId === slot.selectedRevisionId,
        );
        return Boolean(selected && !selected.staleReason);
      }),
    ).toBe(true);
  });
});

describe("M1CreativeDevelopment validation brief matrix", () => {
  it.each([
    [
      "mechanics-first",
      "Create a third-person extraction game where the player explores an arena, collects unstable cores, defends a gate, and escapes before it seals.",
    ],
    [
      "visual-first",
      "Create a quiet game in a city of folded copper towers beneath a violet sea, with a lonely lantern hero and an incomplete playable loop to resolve.",
    ],
    ["constraint-heavy", CONSTRAINT_BRIEF],
  ])(
    "produces schema-valid, brief-faithful creative artifacts for %s input",
    async (_shape, brief) => {
      const { repository, creative, context } = createHarness();
      const intent = createApprovedIntent(repository, creative, context, brief);
      const spec = GameDesignSpecSchema.parse(
        repository.resolveRevision(intent.gameDesignSpec),
      );
      expect(spec.facts[0]?.text).toContain(brief);

      const directionSet = await creative.generateVisualDirections({
        ...context,
        gameDesignSpec: intent.gameDesignSpec,
      });
      const directions = VisualDirectionSetSchema.parse(
        repository.resolveRevision(directionSet),
      );
      expect(directions.directions).toHaveLength(3);
      expect(
        new Set(
          directions.directions.map(
            ({ visualBible }) => visualBible.overallStyle,
          ),
        ).size,
      ).toBe(3);
      for (const direction of directions.directions) {
        expect(direction.rationale).toContain(brief);
        expect(direction.rationale).toContain(spec.coreFantasy);
        expect(direction.rationale).toContain(spec.camera);
        expect(direction.rationale).toContain(spec.gameplayConstraints[0]);
        expect(direction.visualBible.architecture).toContain(brief);
        expect(direction.visualBible.heroProp).toContain(spec.coreFantasy);
        expect(direction.visualBible.heroProp).toContain(spec.objective);
        expect(direction.visualBible.cameraLanguage).toContain(spec.camera);
        expect(direction.visualBible.readabilityRules).toEqual(
          expect.arrayContaining(spec.gameplayConstraints),
        );
      }

      const planRevision = creative.planConcepts({
        ...context,
        brief,
        gameDesignSpec: intent.gameDesignSpec,
        directionSet,
        selectedDirectionRevisionId: directions.directions[0]!.revisionId,
      });
      const plan = repository.resolveRevision<ConceptPlan>(planRevision);
      expect(plan.slots.length).toBeGreaterThanOrEqual(1);
      expect(plan.slots.length).toBeLessThanOrEqual(3);
      const conceptSetRevision = await creative.generateConceptSet({
        ...context,
        gameDesignSpec: intent.gameDesignSpec,
        directionSet,
        selectedDirectionRevisionId: directions.directions[0]!.revisionId,
        conceptPlan: planRevision,
      });
      const conceptSet = ConceptSetSchema.parse(
        repository.resolveRevision(conceptSetRevision),
      );
      for (const slot of conceptSet.slots) {
        const conceptRevision = slot.revisions[0]!;
        const concept = M1ConceptDocumentSchema.parse(
          repository.resolveRevision(conceptRevision.revision),
        );
        expect(concept.prompt).toContain(brief);
        expect(conceptRevision.inheritedVisualTokens).toContainEqual(
          expect.objectContaining({
            category: "project-world",
            value: expect.stringContaining(brief),
            role: "approved premise",
          }),
        );
      }
    },
  );
});

describe("M1CreativeDevelopment correctness cluster", () => {
  it("does not infer a negated camera from keyword array order", () => {
    const { repository, creative, context } = createHarness();
    const brief =
      "Design a strict side-scrolling platformer where a runner clears collapsing ledges; the side-scrolling framing must never change.";
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      brief,
      (branchId) =>
        branchId === "presentation.camera-readability"
          ? "Keep the strict side-scrolling framing; do not use an isometric camera."
          : answerValue(branchId),
    );
    const spec = GameDesignSpecSchema.parse(
      repository.resolveRevision(intent.gameDesignSpec),
    );
    expect(spec.camera).toBe("side-scrolling");
    expect(spec.camera).not.toContain("isometric");
    expect(spec.gameplayConstraints.join(" ")).not.toContain("isometric");
  });

  it("classifies lighting stems and rejects unclassified focused changes", async () => {
    expect(
      classifyFocusedDirectionChange(
        "Replace the soft overcast fill with a hard midnight moonlight key",
      ),
    ).toBe("lighting");
    expect(
      classifyFocusedDirectionChange(
        "Add lamplight and backlight glow along the objective",
      ),
    ).toBe("lighting");
    expect(
      classifyFocusedDirectionChange(
        "Add restrained wind streaks around the active objective",
      ),
    ).toBe("vfx");
    expect(() =>
      classifyFocusedDirectionChange(
        "Rebalance the emphasis toward the objective",
      ),
    ).toThrow(/Recognizable categories: .*lighting.*vfx/);

    const { repository, creative, context } = createHarness();
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const set = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    const selected = set.directions[0]!;
    const moonlight =
      "Replace the soft overcast fill with a hard midnight moonlight key";
    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      directionRevisionId: selected.revisionId,
      change: moonlight,
      pinnedAspects: ["palette", "shape language"],
    });
    const changed = VisualDirectionSetSchema.parse(
      repository.resolveRevision(focused.directionSet),
    ).directions[0]!;
    expect(changed.visualBible.lighting).toBe(`${moonlight}.`);
    expect(
      changed.visualBible.tokens.some((token) => token.category === "vfx"),
    ).toBe(false);
    expect(
      changed.visualBible.tokens.filter(
        (token) => token.category === "lighting",
      ),
    ).toEqual([
      expect.objectContaining({
        value: `${moonlight}.`,
        role: "focused revision",
      }),
    ]);

    await expect(
      creative.makeFocusedDirectionChange({
        ...context,
        gameDesignSpec: intent.gameDesignSpec,
        directionSet,
        directionRevisionId: selected.revisionId,
        change: "Rebalance the emphasis toward the objective",
        pinnedAspects: ["palette"],
      }),
    ).rejects.toThrow(/could not be classified/);
  });

  it("replaces superseded lighting instead of concatenating it into compiled prompts", async () => {
    const { repository, creative, context } = createHarness();
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const set = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    const selected = set.directions[0]!;
    expect(selected.visualBible.lighting).toBe(
      "Soft overcast fill with a warm objective glow",
    );
    const change =
      "Use a hard midnight lighting key instead of the soft overcast fill";
    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      directionRevisionId: selected.revisionId,
      change,
      pinnedAspects: ["palette", "shape language", "readability"],
    });
    const changedSet = VisualDirectionSetSchema.parse(
      repository.resolveRevision(focused.directionSet),
    );
    const changed = changedSet.directions[0]!;
    expect(changed.visualBible.lighting).toBe(`${change}.`);
    expect(changed.visualBible.lighting).not.toContain("Soft overcast fill");
    const originalSet = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    expect(originalSet.directions[0]!.visualBible.lighting).toBe(
      "Soft overcast fill with a warm objective glow",
    );

    const planRevision = creative.planConcepts({
      ...context,
      brief: CONSTRAINT_BRIEF,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: focused.directionSet,
      selectedDirectionRevisionId: changed.revisionId,
    });
    const conceptSetRevision = await creative.generateConceptSet({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: focused.directionSet,
      selectedDirectionRevisionId: changed.revisionId,
      conceptPlan: planRevision,
    });
    const conceptSet = ConceptSetSchema.parse(
      repository.resolveRevision(conceptSetRevision),
    );
    const prompt = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(conceptSet.slots[0]!.revisions[0]!.revision),
    ).prompt;
    expect(prompt).toContain("midnight lighting key");
    expect(prompt).not.toContain(
      "Soft overcast fill with a warm objective glow",
    );
    expect(prompt).not.toMatch(/lighting: Soft overcast fill/);
  });

  it("compiles camera tokens from the approved spec instead of a three-quarter default", async () => {
    const { repository, creative, context } = createHarness();
    const intent = createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const spec = GameDesignSpecSchema.parse(
      repository.resolveRevision(intent.gameDesignSpec),
    );
    expect(spec.camera).toContain("top-down");
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const directions = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    const selected = directions.directions[0]!;
    expect(selected.visualBible.cameraLanguage).toContain("top-down");
    expect(
      selected.visualBible.tokens.find((token) => token.category === "camera")
        ?.value,
    ).toContain("top-down");
    expect(
      selected.visualBible.tokens.find((token) => token.category === "camera")
        ?.value,
    ).not.toMatch(/three-quarter/i);

    const planRevision = creative.planConcepts({
      ...context,
      brief: CONSTRAINT_BRIEF,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: selected.revisionId,
    });
    const conceptSetRevision = await creative.generateConceptSet({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: selected.revisionId,
      conceptPlan: planRevision,
    });
    const conceptSet = ConceptSetSchema.parse(
      repository.resolveRevision(conceptSetRevision),
    );
    const prompt = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(conceptSet.slots[0]!.revisions[0]!.revision),
    ).prompt;
    expect(prompt).toMatch(/camera(?: \([^)]+\))?: [^.]*top-down/i);
    expect(prompt).not.toMatch(/three-quarter/i);
  });
});
