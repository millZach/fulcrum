import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ConceptSetSchema,
  GameDesignSpecSchema,
  GameNameCandidateSetSchema,
  InterrogationStateSchema,
  M1ConceptDocumentSchema,
  ProviderPreflightError,
  ProviderUsageError,
  VisualDirectionSetSchema,
  type GameDesignSpec,
  type GameNameCandidateSet,
  type InterrogationState,
  type RevisionRef,
  type VisualToken,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { m1ConceptImageIdempotencyKey } from "./durable-image.js";
import {
  hashText,
  interrogationTranscriptKey,
  m1TextIdempotencyKey,
} from "./m1-live-text.js";
import {
  buildConceptStyleCapsule,
  fitConceptPrompt,
  M1CreativeDevelopment,
  M1_INTERROGATION_ROUND_CAP,
  M1_TEXT_OPERATIONS,
  classifyFocusedDirectionChange,
  pinnedAspectValuesEqual,
  type ArchitectureDecisionRecord,
  type ConceptPlan,
  type FocusedDirectionChange,
  type ProjectGlossary,
  type SkillProvisioningRecord,
  type StructuredModelExecution,
} from "./m1.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

const resolveInterrogation = async (
  repository: ProjectRepository,
  creative: M1CreativeDevelopment,
  context: { projectId: string; runId: string },
  brief: string,
  initial: RevisionRef,
  answer: (branchId: string) => string = answerValue,
): Promise<RevisionRef> => {
  let revision = initial;
  for (let guard = 0; guard < 10; guard += 1) {
    const state = InterrogationStateSchema.parse(
      repository.resolveRevision<InterrogationState>(revision),
    );
    if (state.frontier.length === 0) return revision;
    const round = state.rounds.at(-1)!;
    revision = await creative.answerCurrentFrontier({
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

const createApprovedIntent = async (
  repository: ProjectRepository,
  creative: M1CreativeDevelopment,
  context: { projectId: string; runId: string },
  brief: string,
  answer: (branchId: string) => string = answerValue,
) => {
  const started = await creative.beginInterrogation({ ...context, brief });
  const resolved = await resolveInterrogation(
    repository,
    creative,
    context,
    brief,
    started.interrogation,
    answer,
  );
  return await creative.confirmSharedUnderstanding({
    ...context,
    brief,
    interrogation: resolved,
    confirmedBy: "Zach",
  });
};

const CONSTRAINT_BRIEF =
  "Design a strict top-down survival game where a lone storm keeper restores a beacon in a flooded arena; routes must remain readable while dense weather sells the danger.";

describe("M1CreativeDevelopment interrogation", () => {
  it("provisions internal capabilities and follows the decision tree until its frontier is empty", async () => {
    const { repository, creative, context } = createHarness();
    const started = await creative.beginInterrogation({
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
    await expect(
      creative.confirmSharedUnderstanding({
        ...context,
        brief: CONSTRAINT_BRIEF,
        interrogation: started.interrogation,
        confirmedBy: "Zach",
      }),
    ).rejects.toThrow(/frontier is unresolved/);

    const resolved = await resolveInterrogation(
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

    const shared = await creative.confirmSharedUnderstanding({
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

  it("rejects a partial frontier instead of silently dropping decisions", async () => {
    const { repository, creative, context } = createHarness();
    const started = await creative.beginInterrogation({
      ...context,
      brief: CONSTRAINT_BRIEF,
    });
    const state = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    await expect(
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
    ).rejects.toThrow(/Every question/);
  });

  it("creates an ADR only for a durable and surprising tradeoff", async () => {
    const ordinary = createHarness();
    const ordinaryBrief =
      "Create a compact puzzle about reconnecting a clock through a small sequence of clear interactions in an abstract room.";
    const ordinaryIntent = await createApprovedIntent(
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
    const reversibleIntent = await createApprovedIntent(
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
    const materialIntent = await createApprovedIntent(
      material.repository,
      material.creative,
      material.context,
      CONSTRAINT_BRIEF,
    );
    expect(materialIntent.adr).toBeDefined();
  });

  it("revises the Game Design Spec as a traceable immutable descendant", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const before = repository.readArtifact(intent.gameDesignSpec.artifact);
    const change =
      "The beacon must remain readable through the storm from every safe route";
    const revision = await creative.reviseGameDesignSpec({
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
  it("renders identical replay previews for identical intent in fresh projects", async () => {
    const renderFreshPreviews = async () => {
      const { repository, creative, context } = createHarness();
      const intent = await createApprovedIntent(
        repository,
        creative,
        context,
        CONSTRAINT_BRIEF,
      );
      const directionSet = await creative.generateVisualDirections({
        ...context,
        gameDesignSpec: intent.gameDesignSpec,
      });
      return VisualDirectionSetSchema.parse(
        repository.resolveRevision(directionSet),
      ).directions.map(({ preview }) => ({
        sha256: preview.artifact.sha256,
        bytes: repository.readArtifact(preview.artifact),
      }));
    };

    const first = await renderFreshPreviews();
    const second = await renderFreshPreviews();

    expect(second.map(({ sha256 }) => sha256)).toEqual(
      first.map(({ sha256 }) => sha256),
    );
    expect(second).toEqual(first);
  });

  it("treats pin ordering, whitespace, and casing as non-material", () => {
    const beforePalette = JSON.stringify([
      { name: "Deep Pine", hex: "#173B36", role: "primary mass" },
      { name: "Lantern", hex: "#F6D36B", role: "gameplay focus" },
    ]);
    const reorderedPalette = JSON.stringify([
      { name: " lantern ", hex: "#f6d36b", role: "GAMEPLAY FOCUS" },
      { name: "DEEP   PINE", hex: "#173b36", role: "Primary Mass" },
    ]);
    expect(
      pinnedAspectValuesEqual("palette", beforePalette, reorderedPalette),
    ).toBe(true);
    expect(
      pinnedAspectValuesEqual(
        "lighting",
        "Soft overcast fill with a warm objective glow",
        "  SOFT   overcast fill with a WARM objective glow  ",
      ),
    ).toBe(true);
    expect(
      pinnedAspectValuesEqual(
        "palette",
        beforePalette,
        JSON.stringify([
          { name: "Deep Pine", hex: "#173B36", role: "primary mass" },
          { name: "Lantern", hex: "#FFFFFF", role: "gameplay focus" },
        ]),
      ),
    ).toBe(false);
  });

  it("creates three distinct previews, replaces only an unselected direction, and preserves pinned aspects", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
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

  it("allows a focused-change note to repeat an unchanged pinned value", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const selected = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    ).directions[0]!;

    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      directionRevisionId: selected.revisionId,
      change:
        "Keep the palette exactly as it is and add restrained wind streaks around the objective",
      pinnedAspects: ["palette"],
    });
    const record = repository.resolveRevision<FocusedDirectionChange>(
      focused.changeRecord,
    );
    expect(record.pinnedAspects).toEqual([
      expect.objectContaining({
        name: "palette",
        before: JSON.stringify(selected.visualBible.palette),
        after: JSON.stringify(selected.visualBible.palette),
      }),
    ]);
  });

  it("refuses only after a focused change materially alters a pinned value", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const selected = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    ).directions[0]!;

    await expect(
      creative.makeFocusedDirectionChange({
        ...context,
        gameDesignSpec: intent.gameDesignSpec,
        directionSet,
        directionRevisionId: selected.revisionId,
        change:
          "Replace the soft overcast lighting with a hard midnight moonlight key",
        pinnedAspects: ["lighting"],
      }),
    ).rejects.toThrow(/altered pinned aspect lighting/i);
  });
});

describe("M1CreativeDevelopment concept inheritance", () => {
  it("plans only demanded slots and regenerates one without changing its siblings", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
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
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      brief,
    );
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
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      brief,
    );
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
    expect(refreshedDocument.basePrompt).toBe(originalDocument.basePrompt);
    expect(refreshedDocument.prompt).toBe(
      `${originalDocument.basePrompt} Focused alternate request: Keep the streaks tight to the energized mirror.`,
    );
    expect(refreshedDocument.prompt).not.toContain("wind streaks");
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
      const intent = await createApprovedIntent(
        repository,
        creative,
        context,
        brief,
      );
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
  it("does not infer a negated camera from keyword array order", async () => {
    const { repository, creative, context } = createHarness();
    const brief =
      "Design a strict side-scrolling platformer where a runner clears collapsing ledges; the side-scrolling framing must never change.";
    const intent = await createApprovedIntent(
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
    expect(
      classifyFocusedDirectionChange(
        "Keep the palette exactly as it is and add deeper volumetric shapes",
      ),
    ).toBe("shape");
    expect(
      classifyFocusedDirectionChange(
        "Add chipped volumetric forms while preserving the palette",
      ),
    ).toBe("shape");
    expect(() =>
      classifyFocusedDirectionChange(
        "Rebalance the emphasis toward the objective",
      ),
    ).toThrow(/Recognizable categories: .*lighting.*vfx/);

    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
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
    const intent = await createApprovedIntent(
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

  it("carries a focused change the capsule has no clause for into the prompt", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const selected = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    ).directions[0]!;
    const change = "Rebuild the hull material in hammered bronze";
    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      directionRevisionId: selected.revisionId,
      change,
      pinnedAspects: ["palette", "lighting"],
    });
    const changed = VisualDirectionSetSchema.parse(
      repository.resolveRevision(focused.directionSet),
    ).directions[0]!;
    const planRevision = creative.planConcepts({
      ...context,
      brief: CONSTRAINT_BRIEF,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: focused.directionSet,
      selectedDirectionRevisionId: changed.revisionId,
    });
    const prompt =
      repository.resolveRevision<ConceptPlan>(planRevision).slots[0]!.prompt!;
    /* Materials lost their own clause when the prompt got short; an explicit
       user ask must not disappear with them. */
    expect(prompt).toContain(
      "Approved material: Rebuild the hull material in hammered bronze.",
    );
  });

  it("compiles camera tokens from the approved spec instead of a three-quarter default", async () => {
    const { repository, creative, context } = createHarness();
    const intent = await createApprovedIntent(
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

const planApprovedConcepts = async (brief = CONSTRAINT_BRIEF) => {
  const { repository, creative, context } = createHarness();
  const intent = await createApprovedIntent(
    repository,
    creative,
    context,
    brief,
  );
  const directionSet = await creative.generateVisualDirections({
    ...context,
    gameDesignSpec: intent.gameDesignSpec,
  });
  const directions = VisualDirectionSetSchema.parse(
    repository.resolveRevision(directionSet),
  );
  const selected = directions.directions[0]!;
  const planRevision = creative.planConcepts({
    ...context,
    brief,
    gameDesignSpec: intent.gameDesignSpec,
    directionSet,
    selectedDirectionRevisionId: selected.revisionId,
  });
  return {
    repository,
    creative,
    context,
    intent,
    directionSet,
    selected,
    planRevision,
    plan: repository.resolveRevision<ConceptPlan>(planRevision),
  };
};

describe("M1CreativeDevelopment plan-time concept prompts", () => {
  it("stores the assembled prompt on each planned slot and sends it unchanged", async () => {
    const planned = await planApprovedConcepts();
    expect(planned.plan.slots.every((slot) => slot.prompt)).toBe(true);
    const conceptSetRevision = await planned.creative.generateConceptSet({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      directionSet: planned.directionSet,
      selectedDirectionRevisionId: planned.selected.revisionId,
      conceptPlan: planned.planRevision,
    });
    const conceptSet = ConceptSetSchema.parse(
      planned.repository.resolveRevision(conceptSetRevision),
    );
    for (const [index, slot] of conceptSet.slots.entries()) {
      const document = M1ConceptDocumentSchema.parse(
        planned.repository.resolveRevision(slot.revisions[0]!.revision),
      );
      expect(document.prompt).toBe(planned.plan.slots[index]!.prompt);
      expect(document.basePrompt).toBe(planned.plan.slots[index]!.prompt);
    }
  });

  it("sends an edited slot prompt byte-for-byte and keeps that base across regens", async () => {
    const planned = await planApprovedConcepts();
    const target = planned.plan.slots[0]!;
    const edited =
      "TASK-J-REPLAY-EDIT pixel-perfect lunar airlock, send this verbatim.";
    const overridden = planned.creative.applyConceptPlanPromptOverrides({
      ...planned.context,
      conceptPlan: planned.planRevision,
      overrides: [{ slotId: target.slotId, prompt: `  ${edited}  ` }],
    });
    const editedPlan =
      planned.repository.resolveRevision<ConceptPlan>(overridden);
    expect(editedPlan.slots[0]!.prompt).toBe(edited);
    const conceptSetRevision = await planned.creative.generateConceptSet({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      directionSet: planned.directionSet,
      selectedDirectionRevisionId: planned.selected.revisionId,
      conceptPlan: overridden,
    });
    const first = M1ConceptDocumentSchema.parse(
      planned.repository.resolveRevision(
        ConceptSetSchema.parse(
          planned.repository.resolveRevision(conceptSetRevision),
        ).slots[0]!.revisions[0]!.revision,
      ),
    );
    expect(first.prompt).toBe(edited);
    expect(first.basePrompt).toBe(edited);

    const regeneratedRevision = await planned.creative.regenerateConceptSlot({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      conceptSet: conceptSetRevision,
      slotId: target.slotId,
      notes: "Make the airlock taller",
    });
    const regenerated = ConceptSetSchema.parse(
      planned.repository.resolveRevision(regeneratedRevision),
    );
    const second = M1ConceptDocumentSchema.parse(
      planned.repository.resolveRevision(
        regenerated.slots[0]!.revisions[1]!.revision,
      ),
    );
    expect(second.basePrompt).toBe(edited);
    expect(second.prompt).toBe(
      `${edited} Focused alternate request: Make the airlock taller.`,
    );

    const twice = await planned.creative.regenerateConceptSlot({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      conceptSet: regeneratedRevision,
      slotId: target.slotId,
      notes: "Shift the key light left",
    });
    const third = M1ConceptDocumentSchema.parse(
      planned.repository.resolveRevision(
        ConceptSetSchema.parse(planned.repository.resolveRevision(twice))
          .slots[0]!.revisions[2]!.revision,
      ),
    );
    expect(third.basePrompt).toBe(edited);
    expect(third.prompt).toBe(
      `${edited} Focused alternate request: Shift the key light left.`,
    );
    expect(third.prompt).not.toContain("Make the airlock taller");
  });

  it("rejects unknown slot ids and whitespace-only prompts", async () => {
    const planned = await planApprovedConcepts();
    expect(() =>
      planned.creative.applyConceptPlanPromptOverrides({
        ...planned.context,
        conceptPlan: planned.planRevision,
        overrides: [{ slotId: "not-a-slot", prompt: "A valid prompt." }],
      }),
    ).toThrow(/no slot not-a-slot/);
    expect(() =>
      planned.creative.applyConceptPlanPromptOverrides({
        ...planned.context,
        conceptPlan: planned.planRevision,
        overrides: [{ slotId: planned.plan.slots[0]!.slotId, prompt: "   " }],
      }),
    ).toThrow(/is empty/);
  });

  it("generates a plan without slot prompts via the legacy assembly", async () => {
    const planned = await planApprovedConcepts();
    const legacyPlan = planned.repository.writeRevision({
      projectId: planned.context.projectId,
      entityId: `${planned.context.projectId}:concept-plan`,
      kind: "concept-plan",
      value: {
        sourceGameDesignRevisionId: planned.plan.sourceGameDesignRevisionId,
        sourceDirectionRevisionId: planned.plan.sourceDirectionRevisionId,
        slots: planned.plan.slots.map(({ prompt: _prompt, ...slot }) => slot),
      },
      runId: planned.context.runId,
    });
    expect(
      planned.repository
        .resolveRevision<ConceptPlan>(legacyPlan)
        .slots.every((slot) => slot.prompt === undefined),
    ).toBe(true);
    const conceptSetRevision = await planned.creative.generateConceptSet({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      directionSet: planned.directionSet,
      selectedDirectionRevisionId: planned.selected.revisionId,
      conceptPlan: legacyPlan,
    });
    const conceptSet = ConceptSetSchema.parse(
      planned.repository.resolveRevision(conceptSetRevision),
    );
    const document = M1ConceptDocumentSchema.parse(
      planned.repository.resolveRevision(
        conceptSet.slots[0]!.revisions[0]!.revision,
      ),
    );
    expect(document.prompt).toBe(planned.plan.slots[0]!.prompt);
    expect(document.basePrompt).toBe(planned.plan.slots[0]!.prompt);
  });

  it("regenerates a document without basePrompt via the legacy assembly", async () => {
    const planned = await planApprovedConcepts();
    const conceptSetRevision = await planned.creative.generateConceptSet({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      directionSet: planned.directionSet,
      selectedDirectionRevisionId: planned.selected.revisionId,
      conceptPlan: planned.planRevision,
    });
    const conceptSet = ConceptSetSchema.parse(
      planned.repository.resolveRevision(conceptSetRevision),
    );
    const target = conceptSet.slots[0]!;
    const original = M1ConceptDocumentSchema.parse(
      planned.repository.resolveRevision(target.revisions[0]!.revision),
    );
    const { basePrompt: _basePrompt, ...legacyBody } = original;
    const legacyDocument = planned.repository.writeRevision({
      projectId: planned.context.projectId,
      entityId: `${planned.context.projectId}:concept:${target.slotId}`,
      kind: "concept-document",
      value: legacyBody,
      runId: planned.context.runId,
    });
    const legacySet = planned.repository.writeRevision({
      projectId: planned.context.projectId,
      entityId: `${planned.context.projectId}:concept-set`,
      kind: "concept-set",
      value: {
        ...conceptSet,
        slots: conceptSet.slots.map((slot) =>
          slot.slotId === target.slotId
            ? {
                ...slot,
                revisions: [
                  {
                    revision: legacyDocument,
                    inheritedVisualTokens:
                      slot.revisions[0]!.inheritedVisualTokens,
                  },
                ],
              }
            : slot,
        ),
        sourceRevisionIds: [legacyDocument.revisionId],
      },
      runId: planned.context.runId,
    });
    const regeneratedRevision = await planned.creative.regenerateConceptSlot({
      ...planned.context,
      gameDesignSpec: planned.intent.gameDesignSpec,
      conceptSet: legacySet,
      slotId: target.slotId,
      notes: "Widen the door",
    });
    const regenerated = ConceptSetSchema.parse(
      planned.repository.resolveRevision(regeneratedRevision),
    );
    const latest = M1ConceptDocumentSchema.parse(
      planned.repository.resolveRevision(
        regenerated.slots[0]!.revisions[1]!.revision,
      ),
    );
    expect(latest.prompt).toContain("No text, UI, logos");
    /* The user's ask lands last on both assembly paths, so the model reads it
       after the subject, the guard, and the style capsule. */
    expect(
      latest.prompt.endsWith("Focused alternate request: Widen the door."),
    ).toBe(true);
    expect(latest.basePrompt).toBe(original.prompt);
  });

  it("changes the live idempotency key when the confirmed prompt is edited", async () => {
    const { repository, context } = createHarness();
    const runner = vi.fn(async ({ prompt }: { prompt: string }) => {
      expect(prompt.length).toBeGreaterThan(0);
      return { bytes: PNG_1x1, model: "gpt-image-2", costUsd: 0 };
    });
    const creative = new M1CreativeDevelopment(repository, runner);
    const createdAt = new Date().toISOString();
    const brief = repository.writeRevision({
      projectId: context.projectId,
      entityId: `${context.projectId}:brief`,
      kind: "game-brief",
      value: { text: CONSTRAINT_BRIEF, rightsConfirmed: true },
      runId: context.runId,
    });
    repository.createProject({
      schemaVersion: 1,
      milestone: "m1",
      projectId: context.projectId,
      name: "M1 live prompt fixture",
      mode: "live",
      assetProvider: "meshy",
      orchestratorProvider: "openai",
      implementationProvider: "openai",
      imageProvider: "openai-subscription",
      status: "awaiting-input",
      stage: "concept-planning",
      runId: context.runId,
      budgetUsd: 10,
      spentUsd: 0,
      conceptReplacementCount: 0,
      brief,
      createdAt,
      updatedAt: createdAt,
    });
    const intent = await createApprovedIntent(
      repository,
      creative,
      context,
      CONSTRAINT_BRIEF,
    );
    const directionSet = await creative.generateVisualDirections({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const directions = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    const selected = directions.directions[0]!;
    const planRevision = creative.planConcepts({
      ...context,
      brief: CONSTRAINT_BRIEF,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: selected.revisionId,
    });
    const plan = repository.resolveRevision<ConceptPlan>(planRevision);
    const first = await creative.generateConceptSet({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: selected.revisionId,
      conceptPlan: planRevision,
      mode: "live",
      imageProvider: "openai-subscription",
    });
    const firstSet = ConceptSetSchema.parse(repository.resolveRevision(first));
    const slot = firstSet.slots[0]!;
    const firstDocument = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(slot.revisions[0]!.revision),
    );
    const firstKey = m1ConceptImageIdempotencyKey({
      projectId: context.projectId,
      slotId: slot.slotId,
      sourceRevisionIds: [
        intent.gameDesignSpec.revisionId,
        selected.revisionId,
        planRevision.revisionId,
      ],
      attempt: 0,
      mode: "live",
      imageProvider: "openai-subscription",
      prompt: firstDocument.prompt,
    });
    expect(repository.getSubmissionByKey(firstKey)?.resultRevisionId).toBe(
      slot.revisions[0]!.revision.revisionId,
    );

    const edited = "TASK-J-LIVE-EDIT never reuse the unedited greenhouse image";
    const overridden = creative.applyConceptPlanPromptOverrides({
      ...context,
      conceptPlan: planRevision,
      overrides: [{ slotId: slot.slotId, prompt: edited }],
    });
    const second = await creative.generateConceptSet({
      ...context,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      selectedDirectionRevisionId: selected.revisionId,
      conceptPlan: overridden,
      mode: "live",
      imageProvider: "openai-subscription",
    });
    const secondSet = ConceptSetSchema.parse(
      repository.resolveRevision(second),
    );
    const secondDocument = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(secondSet.slots[0]!.revisions[0]!.revision),
    );
    expect(secondDocument.prompt).toBe(edited);
    const secondKey = m1ConceptImageIdempotencyKey({
      projectId: context.projectId,
      slotId: slot.slotId,
      sourceRevisionIds: [
        intent.gameDesignSpec.revisionId,
        selected.revisionId,
        overridden.revisionId,
      ],
      attempt: 0,
      mode: "live",
      imageProvider: "openai-subscription",
      prompt: edited,
    });
    expect(secondKey).not.toBe(firstKey);
    expect(repository.getSubmissionByKey(secondKey)?.resultRevisionId).toBe(
      secondSet.slots[0]!.revisions[0]!.revision.revisionId,
    );
    expect(repository.getSubmissionByKey(firstKey)?.resultRevisionId).toBe(
      slot.revisions[0]!.revision.revisionId,
    );
    expect(runner.mock.calls.some((call) => call[0].prompt === edited)).toBe(
      true,
    );
    expect(
      runner.mock.calls.filter((call) => call[0].prompt === edited),
    ).toHaveLength(1);
    expect(plan.slots[0]!.prompt).not.toBe(edited);
  });
});

const liveText = {
  mode: "live" as const,
  orchestratorProvider: "openai" as const,
};

const firstRoundQuestions = () => ({
  questions: [
    liveQuestion(
      "experience.player-promise",
      "What accomplishment closes one successful keeper session?",
      "Name one observable rescue.",
    ),
    liveQuestion(
      "gameplay.core-loop",
      "Which actions form the smallest flooded-arena loop?",
      "Choose three to five actions.",
    ),
  ],
});

const firstRoundKey = (projectId: string, provider: "openai" | "openai-api") =>
  m1TextIdempotencyKey({
    operation: M1_TEXT_OPERATIONS.interrogationRound,
    projectId,
    inputHash: hashText(
      `${interrogationTranscriptKey(CONSTRAINT_BRIEF, [])}:1`,
    ),
    mode: "live",
    provider,
  });

const liveQuestion = (
  branchId: string,
  prompt: string,
  recommendation: string,
) => ({ branchId, prompt, recommendation });

const liveSpec = (title = "Storm Beacon"): GameDesignSpec => ({
  title,
  genre: "Top-down survival",
  camera: "Top-down camera with a stable gameplay horizon",
  coreFantasy: "Restore the storm beacon and guide the stranded fleet home.",
  coreLoop: [
    "Explore the flooded arena",
    "Collect charge",
    "Defend the beacon",
  ],
  playerVerbs: ["move", "defend", "escape"],
  objective: "The fleet arrives when the beacon fills.",
  sessionMinutes: 12,
  gameplayConstraints: [
    "One keeper, one flooded arena, and one complete beacon defense.",
  ],
  facts: [
    {
      statementId: "fact-brief",
      text: "A lone storm keeper restores a beacon in a flooded arena.",
      kind: "fact",
      origin: { source: "brief", reference: "initial brief" },
    },
  ],
  assumptions: [
    {
      statementId: "assumption-scope",
      text: "One keeper is enough for the proof slice.",
      kind: "assumption",
      origin: { source: "user", reference: "scope.proof-boundary" },
    },
  ],
});

const liveDirection = (
  slug: string,
  name: string,
  style: string,
  hex: [string, string, string],
) => ({
  slug,
  name,
  rationale: `${name} interprets the approved storm-keeper fantasy.`,
  overallStyle: style,
  shapeLanguage: "Stacked readable masses with one directional gesture",
  materials: ["painted timber", "matte stone", "soft emission"],
  palette: [
    { name: "Deep pine", hex: hex[0], role: "primary mass" },
    { name: "Clay", hex: hex[1], role: "warm accent" },
    { name: "Lantern", hex: hex[2], role: "gameplay focus" },
  ],
  lighting: "Soft overcast fill with a warm objective glow",
  atmosphere: "Quiet drifting pollen and shallow teal haze",
  textureLanguage: "Broad brush planes, visible carved edges",
});

type ScriptedInput = {
  provider: string;
  systemPrompt: string;
  prompt: string;
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: unknown } | { success: false };
  };
};

const scriptedExecution = (
  resolve: (input: ScriptedInput) => unknown,
): StructuredModelExecution & { calls: ScriptedInput[] } => {
  const calls: ScriptedInput[] = [];
  return {
    calls,
    generateStructured: (async (input) => {
      const scripted = input as ScriptedInput;
      calls.push(scripted);
      const raw = resolve(scripted);
      if (raw instanceof Error) throw raw;
      const parsed = scripted.schema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          "The selected execution provider returned no valid structured result.",
        );
      return {
        value: parsed.data,
        model: "fake-m1-text",
        provider: input.provider,
      };
    }) as StructuredModelExecution["generateStructured"],
  };
};

const queuedExecution = (turns: unknown[]) =>
  scriptedExecution(() => {
    const next = turns.shift();
    if (next === undefined) throw new Error("Scripted execution is exhausted.");
    return next;
  });

describe("M1CreativeDevelopment live creative text", () => {
  it("generates the first live round at create and the next round from answers", async () => {
    const execution = queuedExecution([
      {
        questions: [
          liveQuestion(
            "experience.player-promise",
            "What should a successful beacon defense let the keeper say they accomplished?",
            "Name one observable fleet-rescue accomplishment.",
          ),
          liveQuestion(
            "gameplay.core-loop",
            "Which flooded-arena actions form the smallest satisfying loop?",
            "Choose three to five actions with failure pressure.",
          ),
        ],
      },
      {
        understandingComplete: false,
        questions: [
          liveQuestion(
            "scope.proof-boundary",
            "What is the smallest flooded-arena slice that still proves the idea?",
            "Limit the slice to one keeper, one arena, one complete defense.",
          ),
          liveQuestion(
            "presentation.camera-readability",
            "Which camera keeps routes, threats, and the beacon readable together?",
            "Use the least complex camera that preserves route silhouettes.",
          ),
        ],
      },
      { understandingComplete: true, questions: [] },
    ]);
    const { repository, context } = createHarness();
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    const started = await creative.beginInterrogation({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
    });
    const first = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    expect(first.frontier).toHaveLength(2);
    expect(first.frontier[0]?.prompt).toMatch(/beacon defense/);
    expect(execution.calls).toHaveLength(1);

    const afterFirst = await creative.answerCurrentFrontier({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: started.interrogation,
      roundId: first.rounds[0]!.roundId,
      answers: first.frontier.map((question) => ({
        questionId: question.questionId,
        value: answerValue(question.branchId),
      })),
    });
    const second = InterrogationStateSchema.parse(
      repository.resolveRevision(afterFirst),
    );
    expect(second.frontier).toHaveLength(2);
    expect(second.frontier[0]?.branchId).toBe("scope.proof-boundary");
    expect(execution.calls).toHaveLength(2);

    const afterSecond = await creative.answerCurrentFrontier({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: afterFirst,
      roundId: second.rounds.at(-1)!.roundId,
      answers: second.frontier.map((question) => ({
        questionId: question.questionId,
        value: answerValue(question.branchId),
      })),
    });
    const complete = InterrogationStateSchema.parse(
      repository.resolveRevision(afterSecond),
    );
    expect(complete.frontier).toEqual([]);
    expect(execution.calls).toHaveLength(3);
  });

  it("reuses a completed live interrogation submission instead of calling the model again", async () => {
    const execution = queuedExecution([
      {
        questions: [
          liveQuestion(
            "experience.player-promise",
            "What accomplishment closes one successful keeper session?",
            "Name one observable rescue.",
          ),
          liveQuestion(
            "gameplay.core-loop",
            "Which actions form the smallest flooded-arena loop?",
            "Choose three to five actions.",
          ),
        ],
      },
    ]);
    const { repository, context } = createHarness();
    const first = new M1CreativeDevelopment(repository, undefined, execution);
    const started = await first.beginInterrogation({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
    });
    const restart = new M1CreativeDevelopment(repository, undefined, execution);
    const again = await restart.beginInterrogation({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
    });
    expect(again.interrogation.revisionId).toBe(
      started.interrogation.revisionId,
    );
    expect(execution.calls).toHaveLength(1);
    const submissions = repository
      .listEvents(context.projectId)
      .filter(
        (event) =>
          event.type === `${M1_TEXT_OPERATIONS.interrogationRound}.completed`,
      );
    expect(submissions).toHaveLength(1);
  });

  it("forces an empty frontier after six live rounds even if the model keeps asking", async () => {
    const execution = scriptedExecution((input) => {
      const n = String(execution.calls.length);
      if (input.systemPrompt.includes("[m1-game-design]")) return liveSpec();
      if (input.systemPrompt.includes("[m1-interrogation-round]")) {
        return {
          questions: [
            liveQuestion(
              `topic.pressure${n}`,
              "What remaining flooded-arena pressure still needs a concrete rule?",
              "Name one remaining pressure with a testable rule.",
            ),
            liveQuestion(
              `topic.constraint${n}`,
              "Which leftover constraint still changes how the beacon is read?",
              "Write one leftover constraint as a production rule.",
            ),
          ],
        };
      }
      return {
        understandingComplete: false,
        questions: [
          liveQuestion(
            `topic.route${n}`,
            "What still-open route decision should the keeper resolve now?",
            "Pick one remaining route decision.",
          ),
          liveQuestion(
            `topic.weather${n}`,
            "Which leftover camera or weather rule still needs a yes-or-no call?",
            "Choose one remaining presentation rule.",
          ),
        ],
      };
    });
    const { repository, context } = createHarness();
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    let revision = (
      await creative.beginInterrogation({
        ...context,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
      })
    ).interrogation;
    for (let round = 0; round < M1_INTERROGATION_ROUND_CAP; round += 1) {
      const state = InterrogationStateSchema.parse(
        repository.resolveRevision<InterrogationState>(revision),
      );
      expect(state.frontier.length).toBeGreaterThan(0);
      const current = state.rounds.at(-1)!;
      revision = await creative.answerCurrentFrontier({
        ...context,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
        interrogation: revision,
        roundId: current.roundId,
        answers: state.frontier.map((question) => ({
          questionId: question.questionId,
          value: `Resolved ${question.branchId} with a concrete keeper rule.`,
        })),
      });
    }
    const capped = InterrogationStateSchema.parse(
      repository.resolveRevision<InterrogationState>(revision),
    );
    expect(capped.rounds).toHaveLength(M1_INTERROGATION_ROUND_CAP);
    expect(capped.frontier).toEqual([]);
    expect(execution.calls).toHaveLength(M1_INTERROGATION_ROUND_CAP);
    expect(
      repository
        .listEvents(context.projectId)
        .some((event) => event.type === "interrogation.round-cap-reached"),
    ).toBe(true);
    const confirmed = await creative.confirmSharedUnderstanding({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: revision,
      confirmedBy: "Zach",
    });
    expect(
      GameDesignSpecSchema.parse(
        repository.resolveRevision(confirmed.gameDesignSpec),
      ).title,
    ).toBe("Storm Beacon");
  });

  it("writes a schema-valid live spec and retries after invalid structured output", async () => {
    const turns: unknown[] = [
      {
        questions: [
          liveQuestion(
            "experience.player-promise",
            "What accomplishment closes one successful keeper session?",
            "Name one observable rescue.",
          ),
          liveQuestion(
            "gameplay.core-loop",
            "Which actions form the smallest flooded-arena loop?",
            "Choose three to five actions.",
          ),
        ],
      },
      { understandingComplete: true, questions: [] },
      {},
      liveSpec("Retryable Beacon Spec"),
    ];
    const execution = queuedExecution(turns);
    const { repository, context } = createHarness();
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    const started = await creative.beginInterrogation({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
    });
    const first = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    const resolved = await creative.answerCurrentFrontier({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: started.interrogation,
      roundId: first.rounds[0]!.roundId,
      answers: first.frontier.map((question) => ({
        questionId: question.questionId,
        value: answerValue(question.branchId),
      })),
    });
    await expect(
      creative.confirmSharedUnderstanding({
        ...context,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
        interrogation: resolved,
        confirmedBy: "Zach",
      }),
    ).rejects.toThrow(/could not parse a valid m1-game-design result/);
    const stillOpen = InterrogationStateSchema.parse(
      repository.resolveRevision(resolved),
    );
    expect(stillOpen.sharedUnderstanding).toBeUndefined();
    const confirmed = await creative.confirmSharedUnderstanding({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: resolved,
      confirmedBy: "Zach",
    });
    const spec = GameDesignSpecSchema.parse(
      repository.resolveRevision(confirmed.gameDesignSpec),
    );
    expect(spec.title).toBe("Retryable Beacon Spec");
    expect(spec.coreFantasy).toMatch(/storm beacon/);
    const again = await creative.confirmSharedUnderstanding({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: resolved,
      confirmedBy: "Zach",
    });
    expect(again.gameDesignSpec.revisionId).toBe(
      confirmed.gameDesignSpec.revisionId,
    );
    expect(
      execution.calls.filter((call) =>
        call.systemPrompt.includes("[m1-game-design]"),
      ),
    ).toHaveLength(2);
  });

  it("invents three live directions, honors replacement notes, and preserves pinned aspects", async () => {
    const echoedPalette = [
      { name: " LANTERN ", hex: "#f6d36b", role: "GAMEPLAY FOCUS" },
      { name: "clay", hex: "#b76647", role: "WARM ACCENT" },
      { name: "DEEP   PINE", hex: "#173b36", role: "primary mass" },
    ];
    const execution = queuedExecution([
      {
        questions: [
          liveQuestion(
            "experience.player-promise",
            "What accomplishment closes one successful keeper session?",
            "Name one observable rescue.",
          ),
          liveQuestion(
            "gameplay.core-loop",
            "Which actions form the smallest flooded-arena loop?",
            "Choose three to five actions.",
          ),
        ],
      },
      { understandingComplete: true, questions: [] },
      liveSpec(),
      {
        directions: [
          liveDirection(
            "luminous-channel",
            "Luminous Channel",
            "LIVE-DIRECTION-STYLE carved ice lanterns with graphite joints",
            ["#173B36", "#B76647", "#F6D36B"],
          ),
          liveDirection(
            "monumental-tide",
            "Monumental Tide",
            "Graphic tide-ink masses with one hard signal color",
            ["#11131A", "#D8D0B8", "#E05A47"],
          ),
          liveDirection(
            "weathered-harbor",
            "Weathered Harbor",
            "Weathered harbor plaster with quiet storm wear",
            ["#33475B", "#5E9C8B", "#F0B95A"],
          ),
        ],
      },
      liveDirection(
        "paper-theatre",
        "Paper Theatre",
        "Material-theatre paper planes honoring a copper storm lantern",
        ["#33263F", "#77A98F", "#F1A85B"],
      ),
      {
        title: "Mutated Focused Title",
        rationale: "Honor the pins while changing the wind treatment.",
        overallStyle: "Revised carved ice lanterns with graphite joints",
        shapeLanguage:
          "  STACKED readable masses with one directional gesture  ",
        materials: ["wrong plastic"],
        palette: echoedPalette,
        lighting: "Hard midnight moonlight through the storm",
        atmosphere: "Mutated atmosphere",
        textureLanguage: "Mutated texture",
        cameraLanguage: "Mutated camera",
        readabilityRules: [
          "one keeper, one flooded arena, and one complete beacon defense.",
          " KEEP traversal edges distinct from decorative surfaces ",
          "preserve the dominant silhouette at thumbnail size",
          "RESERVE the gameplay-focus color for actionable goals",
        ],
      },
    ]);
    const { repository, context } = createHarness();
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    const started = await creative.beginInterrogation({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
    });
    const first = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    const resolved = await creative.answerCurrentFrontier({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: started.interrogation,
      roundId: first.rounds[0]!.roundId,
      answers: first.frontier.map((question) => ({
        questionId: question.questionId,
        value: answerValue(question.branchId),
      })),
    });
    const intent = await creative.confirmSharedUnderstanding({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
      interrogation: resolved,
      confirmedBy: "Zach",
    });
    const directionSet = await creative.generateVisualDirections({
      ...context,
      ...liveText,
      gameDesignSpec: intent.gameDesignSpec,
    });
    const set = VisualDirectionSetSchema.parse(
      repository.resolveRevision(directionSet),
    );
    expect(
      new Set(set.directions.map((direction) => direction.name)).size,
    ).toBe(3);
    expect(
      set.directions.some((direction) =>
        direction.visualBible.overallStyle.includes("LIVE-DIRECTION-STYLE"),
      ),
    ).toBe(true);
    const reused = await creative.generateVisualDirections({
      ...context,
      ...liveText,
      gameDesignSpec: intent.gameDesignSpec,
    });
    expect(reused.revisionId).toBe(directionSet.revisionId);

    const selected = set.directions[0]!;
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
    const document = M1ConceptDocumentSchema.parse(
      repository.resolveRevision(
        ConceptSetSchema.parse(repository.resolveRevision(conceptSetRevision))
          .slots[0]!.revisions[0]!.revision,
      ),
    );
    expect(document.prompt).toContain("LIVE-DIRECTION-STYLE");
    expect(document.prompt).toMatch(/camera(?: \([^)]+\))?: [^.]*top-down/i);

    const target = set.directions[2]!;
    const replaced = await creative.replaceUnselectedDirection({
      ...context,
      ...liveText,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet,
      directionRevisionId: target.revisionId,
      selectedDirectionRevisionId: selected.revisionId,
      notes: "Use a copper storm lantern in a paper-theatre material language",
    });
    const replacedSet = VisualDirectionSetSchema.parse(
      repository.resolveRevision(replaced),
    );
    expect(
      replacedSet.directions.some(
        (direction) => direction.name === "Paper Theatre",
      ),
    ).toBe(true);
    expect(
      replacedSet.directions.some((direction) =>
        /paper|theatre|copper storm lantern/i.test(
          direction.visualBible.overallStyle,
        ),
      ),
    ).toBe(true);

    const beforePalette = JSON.stringify(selected.visualBible.palette);
    const beforeShape = selected.visualBible.shapeLanguage;
    const beforeReadability = JSON.stringify(
      selected.visualBible.readabilityRules,
    );
    const focused = await creative.makeFocusedDirectionChange({
      ...context,
      ...liveText,
      gameDesignSpec: intent.gameDesignSpec,
      directionSet: replaced,
      directionRevisionId: selected.revisionId,
      change: "Add restrained wind streaks around the active objective",
      pinnedAspects: ["palette", "shape language", "readability"],
    });
    const changed = VisualDirectionSetSchema.parse(
      repository.resolveRevision(focused.directionSet),
    ).directions[0]!;
    expect(JSON.stringify(changed.visualBible.palette)).toBe(beforePalette);
    expect(changed.visualBible.shapeLanguage).toBe(beforeShape);
    expect(JSON.stringify(changed.visualBible.readabilityRules)).toBe(
      beforeReadability,
    );
    expect(changed.visualBible.palette).not.toEqual(echoedPalette);
    const record = repository.resolveRevision<FocusedDirectionChange>(
      focused.changeRecord,
    );
    expect(
      record.pinnedAspects.every((aspect) => aspect.before === aspect.after),
    ).toBe(true);
    const focusedCall = execution.calls.find((call) =>
      call.systemPrompt.includes("[m1-direction-focused-change]"),
    );
    expect(focusedCall?.prompt).toContain('"field":"palette"');
    expect(focusedCall?.prompt).toContain('"field":"shapeLanguage"');
    expect(focusedCall?.prompt).toContain(
      "Copy every pinned value verbatim into its named field",
    );
  });

  it("reserves openai-api text budget and surfaces a typed preflight error", async () => {
    const execution = queuedExecution([
      {
        questions: [
          liveQuestion(
            "experience.player-promise",
            "What accomplishment closes one successful keeper session?",
            "Name one observable rescue.",
          ),
          liveQuestion(
            "gameplay.core-loop",
            "Which actions form the smallest flooded-arena loop?",
            "Choose three to five actions.",
          ),
        ],
      },
    ]);
    const { repository, context } = createHarness();
    const createdAt = new Date().toISOString();
    const brief = repository.writeRevision({
      projectId: context.projectId,
      entityId: `${context.projectId}:brief`,
      kind: "game-brief",
      value: { text: CONSTRAINT_BRIEF, rightsConfirmed: true },
      runId: context.runId,
    });
    repository.createProject({
      schemaVersion: 1,
      milestone: "m1",
      projectId: context.projectId,
      name: "M1 live text budget",
      mode: "live",
      assetProvider: "meshy",
      orchestratorProvider: "openai-api",
      implementationProvider: "openai",
      imageProvider: "none",
      status: "awaiting-input",
      stage: "interrogation",
      runId: context.runId,
      budgetUsd: 10,
      spentUsd: 0,
      conceptReplacementCount: 0,
      brief,
      createdAt,
      updatedAt: createdAt,
    });
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    await creative.beginInterrogation({
      ...context,
      mode: "live",
      orchestratorProvider: "openai-api",
      brief: CONSTRAINT_BRIEF,
    });
    expect(repository.getProject(context.projectId).spentUsd).toBeCloseTo(0.25);
    expect(
      repository
        .listEvents(context.projectId)
        .some((event) => event.type === "budget.reserved"),
    ).toBe(true);

    const missing = scriptedExecution(() => {
      throw new Error("codex is not installed.");
    });
    const { repository: missingRepo, context: missingContext } =
      createHarness();
    const missingCreative = new M1CreativeDevelopment(
      missingRepo,
      undefined,
      missing,
    );
    await expect(
      missingCreative.beginInterrogation({
        ...missingContext,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
      }),
    ).rejects.toBeInstanceOf(ProviderPreflightError);
  });

  it("retries a subscription live text failure after a transient provider error", async () => {
    const execution = queuedExecution([
      new Error("codex CLI timed out"),
      firstRoundQuestions(),
    ]);
    const { repository, context } = createHarness();
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    await expect(
      creative.beginInterrogation({
        ...context,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
      }),
    ).rejects.toThrow(/can be retried/);
    const failed = repository.getSubmissionByKey(
      firstRoundKey(context.projectId, "openai"),
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.payload.errorKind).toBe("transient-provider-error");
    expect(failed?.payload.error).toMatch(/codex CLI timed out/);

    const started = await creative.beginInterrogation({
      ...context,
      ...liveText,
      brief: CONSTRAINT_BRIEF,
    });
    const state = InterrogationStateSchema.parse(
      repository.resolveRevision(started.interrogation),
    );
    expect(state.frontier).toHaveLength(2);
    expect(execution.calls).toHaveLength(2);
    expect(
      repository.getSubmissionByKey(firstRoundKey(context.projectId, "openai"))
        ?.status,
    ).toBe("ready");
  });

  it("propagates subscription quota pressure with a retryable typed error", async () => {
    const execution = queuedExecution([
      Object.assign(new Error("rate_limit_exceeded"), { statusCode: 429 }),
      firstRoundQuestions(),
    ]);
    const { repository, context } = createHarness();
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );

    await expect(
      creative.beginInterrogation({
        ...context,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ProviderUsageError &&
        error.code === "subscription-quota" &&
        /subscription usage.*limited/i.test(error.message),
    );
    const failed = repository.getSubmissionByKey(
      firstRoundKey(context.projectId, "openai"),
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.payload).toEqual(
      expect.objectContaining({
        errorKind: "subscription-quota",
        usageCode: "subscription-quota",
      }),
    );
    expect(
      repository
        .listEvents(context.projectId)
        .some((event) => event.type === "budget.reserved"),
    ).toBe(false);

    await expect(
      creative.beginInterrogation({
        ...context,
        ...liveText,
        brief: CONSTRAINT_BRIEF,
      }),
    ).resolves.toBeDefined();
    expect(execution.calls).toHaveLength(2);
  });

  it("keeps a metered openai-api live text failure blocked", async () => {
    const execution = queuedExecution([
      new Error("codex CLI timed out"),
      firstRoundQuestions(),
    ]);
    const { repository, context } = createHarness();
    const createdAt = new Date().toISOString();
    const brief = repository.writeRevision({
      projectId: context.projectId,
      entityId: `${context.projectId}:brief`,
      kind: "game-brief",
      value: { text: CONSTRAINT_BRIEF, rightsConfirmed: true },
      runId: context.runId,
    });
    repository.createProject({
      schemaVersion: 1,
      milestone: "m1",
      projectId: context.projectId,
      name: "M1 metered text block",
      mode: "live",
      assetProvider: "meshy",
      orchestratorProvider: "openai-api",
      implementationProvider: "openai",
      imageProvider: "none",
      status: "awaiting-input",
      stage: "interrogation",
      runId: context.runId,
      budgetUsd: 10,
      spentUsd: 0,
      conceptReplacementCount: 0,
      brief,
      createdAt,
      updatedAt: createdAt,
    });
    const creative = new M1CreativeDevelopment(
      repository,
      undefined,
      execution,
    );
    const liveApi = {
      mode: "live" as const,
      orchestratorProvider: "openai-api" as const,
    };
    await expect(
      creative.beginInterrogation({
        ...context,
        ...liveApi,
        brief: CONSTRAINT_BRIEF,
      }),
    ).rejects.toThrow(/codex CLI timed out/);
    const blocked = repository.getSubmissionByKey(
      firstRoundKey(context.projectId, "openai-api"),
    );
    expect(blocked?.status).toBe("submission-unknown");
    expect(blocked?.payload.errorKind).toBeUndefined();

    await expect(
      creative.beginInterrogation({
        ...context,
        ...liveApi,
        brief: CONSTRAINT_BRIEF,
      }),
    ).rejects.toThrow(/will not spend again automatically/);
    expect(execution.calls).toHaveLength(1);
    expect(
      repository.getSubmissionByKey(
        firstRoundKey(context.projectId, "openai-api"),
      )?.status,
    ).toBe("submission-unknown");
  });
});

describe("fitConceptPrompt", () => {
  const guard = "No text, UI, logos, or unrelated project history.";

  it("joins short parts unchanged, guard last", () => {
    expect(fitConceptPrompt(["Alpha.", "Beta."], guard)).toBe(
      `Alpha. Beta. ${guard}`,
    );
  });

  it("caps a live-length spec at the domain limit without losing the guard", () => {
    const parts = [
      "Production concept for Gameplay Anchor.",
      `project-world (approved premise): ${"open-world recovery district with rain-dark asphalt and honest tow work ".repeat(80)}.`,
      `lighting: ${"cool overcast daylight with restrained shop fluorescents ".repeat(60)}.`,
      "readability: the objective color survives thumbnail size.",
    ];
    const prompt = fitConceptPrompt(parts, guard);
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt.endsWith(guard)).toBe(true);
    expect(prompt.startsWith("Production concept for Gameplay Anchor.")).toBe(
      true,
    );
    expect(prompt).toContain("…");
  });

  it("keeps a focused-alternate tail intact under overflow", () => {
    const tail = `Focused alternate request: Make the tower taller. ${guard}`;
    const prompt = fitConceptPrompt(
      [`style: ${"painterly folkcraft with hand-carved forms ".repeat(200)}.`],
      tail,
    );
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt.endsWith(tail)).toBe(true);
  });

  it("never exceeds the cap even when the first part alone overflows", () => {
    const prompt = fitConceptPrompt(["x".repeat(6000)], guard);
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt.endsWith(guard)).toBe(true);
  });
});

describe("buildConceptStyleCapsule", () => {
  const token = (
    category: VisualToken["category"],
    value: string,
    role?: string,
  ): VisualToken => ({
    tokenId: `${category}:${value.slice(0, 8)}`,
    category,
    value,
    ...(role ? { role } : {}),
  });

  const verboseTokens: VisualToken[] = [
    token(
      "style",
      "Painterly folkcraft with hand-carved forms. This direction was chosen because the interview surfaced a preference for warmth over spectacle, and it carries through every prop.",
    ),
    token("palette", "Deep pine #173B36", "primary mass"),
    token("palette", "Clay #B76647", "warm accent"),
    token("palette", "Bone #E8E1D2", "edge separation"),
    token("gameplay-color", "Lantern #F6D36B", "gameplay focus"),
    token("lighting", "Soft overcast fill with a warm objective glow."),
    token("atmosphere", "Quiet drifting pollen and shallow teal haze."),
    token("shape", "Rounded stacked masses cut by one clear gesture."),
    token("prohibited-style", "photoreal noise, decorative clutter."),
    token("material", "painted timber"),
    token("material", "matte stone"),
    token("surface", "Broad brush planes with visible carved edges."),
    token("scale", "Human-scale reference stays beside the objective."),
  ];

  it("condenses a verbose direction into one short capsule", () => {
    const capsule = buildConceptStyleCapsule(verboseTokens);
    expect(capsule).toBe(
      "Style: Painterly folkcraft with hand-carved forms. " +
        "Palette: Deep pine #173B36, Clay #B76647; gameplay focus Lantern #F6D36B. " +
        "Light: Soft overcast fill with a warm objective glow. " +
        "Air: Quiet drifting pollen and shallow teal haze. " +
        "Forms: Rounded stacked masses cut by one clear gesture. " +
        "Avoid: photoreal noise, decorative clutter.",
    );
    expect(capsule.length).toBeLessThanOrEqual(400);
    expect(capsule).not.toContain("the interview surfaced");
    expect(capsule).not.toContain("Bone #E8E1D2");
    expect(capsule).not.toContain("painted timber");
    expect(capsule).not.toContain("Human-scale reference");
  });

  it("never overruns its budget on paragraph-length live values", () => {
    const capsule = buildConceptStyleCapsule([
      token("style", "hand-painted stylization ".repeat(60)),
      token("palette", `Storm ${"#33475B ".repeat(40)}`, "primary mass"),
      token("lighting", "low golden break ".repeat(60)),
    ]);
    expect(capsule.length).toBeLessThanOrEqual(400);
  });
});

describe("M1 concept prompt budget", () => {
  it("keeps every planned prompt near a thousand characters", async () => {
    const planned = await planApprovedConcepts();
    for (const slot of planned.plan.slots) {
      expect(slot.prompt!.length).toBeLessThanOrEqual(1_010);
      const [subject, capsule] = slot.prompt!.split("\n\n");
      expect(
        subject!.endsWith("No text, UI, logos, or unrelated project history."),
      ).toBe(true);
      expect(capsule!.startsWith("Style: ")).toBe(true);
      /* The capsule is the only place art direction enters the prompt. */
      expect(subject).not.toContain("#");
      expect(subject).not.toContain("Palette");
    }
  });
});

describe("M1 game name decider", () => {
  const reachSignoff = async () => {
    const harness = createHarness();
    const started = await harness.creative.beginInterrogation({
      ...harness.context,
      brief: CONSTRAINT_BRIEF,
    });
    const interrogation = await resolveInterrogation(
      harness.repository,
      harness.creative,
      harness.context,
      CONSTRAINT_BRIEF,
      started.interrogation,
    );
    return { ...harness, interrogation };
  };

  const resolveSet = (
    repository: ProjectRepository,
    revision: RevisionRef,
  ): GameNameCandidateSet =>
    GameNameCandidateSetSchema.parse(repository.resolveRevision(revision));

  it("proposes a batch of distinct names drawn from the brief", async () => {
    const { repository, creative, context, interrogation } =
      await reachSignoff();
    const revision = await creative.proposeGameNames({
      ...context,
      brief: CONSTRAINT_BRIEF,
      interrogation,
    });
    const set = resolveSet(repository, revision);
    expect(set.round).toBe(1);
    expect(set.provider).toBe("replay");
    expect(set.feedback).toBeUndefined();
    expect(set.sourceInterrogationRevisionId).toBe(interrogation.revisionId);
    expect(set.candidates).toHaveLength(4);
    expect(new Set(set.candidates.map(({ name }) => name)).size).toBe(4);
    expect(set.candidates.every(({ rationale }) => rationale.length > 8)).toBe(
      true,
    );
    /* The words are the user's, not a stock fantasy vocabulary. */
    const words = set.candidates
      .flatMap(({ name }) => name.toLowerCase().split(/\s+/))
      .filter((word) => word.length > 3);
    expect(
      words.some((word) => CONSTRAINT_BRIEF.toLowerCase().includes(word)),
    ).toBe(true);
  });

  it("refuses to name a game whose interview is unresolved", async () => {
    const { creative, context } = createHarness();
    const started = await creative.beginInterrogation({
      ...context,
      brief: CONSTRAINT_BRIEF,
    });
    await expect(
      creative.proposeGameNames({
        ...context,
        brief: CONSTRAINT_BRIEF,
        interrogation: started.interrogation,
      }),
    ).rejects.toThrow(/frontier is unresolved/);
  });

  it("returns a different batch when the user steers, and never repeats a name", async () => {
    const { repository, creative, context, interrogation } =
      await reachSignoff();
    const first = await creative.proposeGameNames({
      ...context,
      brief: CONSTRAINT_BRIEF,
      interrogation,
    });
    const second = await creative.proposeGameNames({
      ...context,
      brief: CONSTRAINT_BRIEF,
      interrogation,
      previous: first,
      feedback: "Shorter, and darker.",
    });
    const third = await creative.proposeGameNames({
      ...context,
      brief: CONSTRAINT_BRIEF,
      interrogation,
      previous: second,
      feedback: "Now lose the article.",
    });
    const batches = [first, second, third].map((revision) =>
      resolveSet(repository, revision),
    );
    expect(batches.map(({ round }) => round)).toEqual([1, 2, 3]);
    expect(batches[1]!.feedback).toBe("Shorter, and darker.");
    expect(batches[1]!.previousCandidateSetRevisionId).toBe(first.revisionId);
    expect(batches[2]!.previousCandidateSetRevisionId).toBe(second.revisionId);
    const names = batches.flatMap((set) =>
      set.candidates.map(({ name }) => name),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("derives the same batch twice for the same interview and steer", async () => {
    const one = await reachSignoff();
    const two = await reachSignoff();
    const left = resolveSet(
      one.repository,
      await one.creative.proposeGameNames({
        ...one.context,
        brief: CONSTRAINT_BRIEF,
        interrogation: one.interrogation,
      }),
    );
    const right = resolveSet(
      two.repository,
      await two.creative.proposeGameNames({
        ...two.context,
        brief: CONSTRAINT_BRIEF,
        interrogation: two.interrogation,
      }),
    );
    expect(right.candidates).toEqual(left.candidates);
    expect(right.candidateSetId).toBe(left.candidateSetId);
  });

  it("titles the Game Design Spec with the decided name", async () => {
    const { repository, creative, context, interrogation } =
      await reachSignoff();
    const artifacts = await creative.confirmSharedUnderstanding({
      ...context,
      brief: CONSTRAINT_BRIEF,
      interrogation,
      confirmedBy: "Zach",
      gameName: "Beaconfall",
    });
    const spec = GameDesignSpecSchema.parse(
      repository.resolveRevision(artifacts.gameDesignSpec),
    );
    expect(spec.title).toBe("Beaconfall");
  });
});
