import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GameDesignSpecSchema,
  SoundPlanSchema,
  VisualDirectionSetSchema,
  type GameDesignSpec,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it } from "vitest";

import { M1CreativeDevelopment } from "./m1.js";
import { deriveSoundPlan } from "./sound-palette.js";
import {
  InterrogationStateSchema,
  type InterrogationState,
  type RevisionRef,
} from "@fulcrum/domain";

const roots: string[] = [];
const repositories: ProjectRepository[] = [];

const createHarness = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-sound-palette-"));
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

const GREENHOUSE_BRIEF =
  "Create a first-person stealth game in a cramped lunar greenhouse. The player cannot use weapons, must escape within eight minutes, and must read colorblind-safe alerts despite near-dark lighting and one pursuing creature.";

const RELIQUARY_BRIEF =
  "Create a stylized third-person fantasy extraction arena centered on an ancient stone reliquary. The reliquary is a squat, readable hero prop made from weathered dark stone, restrained bronze bands, and a cyan crystal core.";

const answerValue = (branchId: string, brief: string): string => {
  if (brief.includes("greenhouse")) {
    const values: Record<string, string> = {
      "experience.player-promise":
        "Slip the pursuer and reach the airlock alive",
      "gameplay.core-loop": "Read the rows, hide, and escape the greenhouse",
      "scope.proof-boundary":
        "One greenhouse room, one pursuer, one eight-minute escape",
      "presentation.camera-readability":
        "A first-person camera keeps alerts readable in the dark",
      "gameplay.success-failure":
        "The airlock opens when the timer still has time; being seen ends the run",
      "scope.consequential-tradeoff":
        "Readability must win whenever the required darkness hides an alert",
      "scope.adr-qualification":
        "Yes, this is hard to reverse after environment production and surprising without the readability tradeoff context",
      "scope.constraint-resolution":
        "Keep colorblind-safe alerts brighter than the near-dark foliage",
    };
    return values[branchId] ?? `Resolve ${branchId}`;
  }
  const values: Record<string, string> = {
    "experience.player-promise": "Wake the reliquary and extract its cyan core",
    "gameplay.core-loop":
      "Enter the arena, charge the reliquary, and extract before it seals",
    "scope.proof-boundary": "One player, one arena, one complete extraction",
    "presentation.camera-readability":
      "An elevated three-quarter camera keeps the reliquary visible",
    "gameplay.success-failure":
      "Extraction succeeds when the core is claimed; the seal ends a failed run",
    "scope.consequential-tradeoff":
      "The reliquary silhouette must stay readable over adding arena ornament",
    "scope.adr-qualification":
      "Yes, this is hard to reverse after environment production and surprising without the silhouette tradeoff context",
    "scope.constraint-resolution":
      "Keep the cyan core the brightest element during combat",
  };
  return values[branchId] ?? `Resolve ${branchId}`;
};

const resolveInterrogation = async (
  repository: ProjectRepository,
  creative: M1CreativeDevelopment,
  context: { projectId: string; runId: string },
  brief: string,
  initial: RevisionRef,
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
        value: answerValue(question.branchId, brief),
      })),
    });
  }
  throw new Error("Interrogation did not converge.");
};

const planFromBrief = async (brief: string) => {
  const { repository, creative, context } = createHarness();
  const started = await creative.beginInterrogation({
    ...context,
    brief,
    mode: "replay",
    orchestratorProvider: "openai",
  });
  const interrogation = await resolveInterrogation(
    repository,
    creative,
    context,
    brief,
    started.interrogation,
  );
  const artifacts = await creative.confirmSharedUnderstanding({
    ...context,
    brief,
    interrogation,
    confirmedBy: "test",
  });
  const directionSet = await creative.generateVisualDirections({
    ...context,
    gameDesignSpec: artifacts.gameDesignSpec,
  });
  const directions = VisualDirectionSetSchema.parse(
    repository.resolveRevision(directionSet),
  );
  const selected = directions.directions[0]!;
  const planRevision = creative.planSounds({
    ...context,
    gameDesignSpec: artifacts.gameDesignSpec,
    directionSet,
    selectedDirectionRevisionId: selected.revisionId,
  });
  const plan = SoundPlanSchema.parse(repository.resolveRevision(planRevision));
  const spec = GameDesignSpecSchema.parse(
    repository.resolveRevision<GameDesignSpec>(artifacts.gameDesignSpec),
  );
  return {
    repository,
    creative,
    context,
    artifacts,
    directionSet,
    selected,
    planRevision,
    plan,
    spec,
  };
};

describe("sound plan derivation", () => {
  it("is deterministic and inherits approved direction tokens", async () => {
    const first = await planFromBrief(GREENHOUSE_BRIEF);
    const second = deriveSoundPlan({
      spec: first.spec,
      direction: first.selected,
      sourceGameDesignRevisionId: first.artifacts.gameDesignSpec.revisionId,
      sourceDirectionRevisionId: first.selected.revisionId,
    });
    expect(second).toEqual(first.plan);
    expect(first.plan.slots.length).toBeGreaterThanOrEqual(4);
    expect(first.plan.slots.length).toBeLessThanOrEqual(6);
    const joined = first.plan.slots.map((slot) => slot.prompt).join(" ");
    expect(joined).toContain(first.selected.visualBible.atmosphere);
    expect(joined).toContain(first.selected.visualBible.materials[0]!);
    expect(joined).toContain(first.selected.visualBible.palette[0]!.name);
    expect(joined).toContain(first.spec.objective);
    expect(first.plan.slots.some((slot) => slot.loop)).toBe(true);
    expect(
      first.plan.slots.find((slot) => slot.slotId === "ambience-bed")?.loop,
    ).toBe(true);
  });

  it("assembles different palettes for different projects", async () => {
    const greenhouse = await planFromBrief(GREENHOUSE_BRIEF);
    const reliquary = await planFromBrief(RELIQUARY_BRIEF);
    const greenhouseText = greenhouse.plan.slots
      .map((slot) => slot.prompt)
      .join(" ");
    const reliquaryText = reliquary.plan.slots
      .map((slot) => slot.prompt)
      .join(" ");
    expect(greenhouseText).not.toBe(reliquaryText);
    expect(greenhouseText.toLowerCase()).toMatch(/greenhouse|airlock|lunar/);
    expect(reliquaryText.toLowerCase()).toMatch(/reliquary|extract|arena/);
  });

  it("rejects unknown slot ids and whitespace-only prompts", async () => {
    const planned = await planFromBrief(GREENHOUSE_BRIEF);
    expect(() =>
      planned.creative.applySoundPlanPromptOverrides({
        ...planned.context,
        soundPlan: planned.planRevision,
        overrides: [{ slotId: "not-a-slot", prompt: "A valid prompt." }],
      }),
    ).toThrow(/no slot not-a-slot/);
    expect(() =>
      planned.creative.applySoundPlanPromptOverrides({
        ...planned.context,
        soundPlan: planned.planRevision,
        overrides: [{ slotId: planned.plan.slots[0]!.slotId, prompt: "   " }],
      }),
    ).toThrow(/is empty/);
  });

  it("writes an edited prompt onto a new plan revision", async () => {
    const planned = await planFromBrief(GREENHOUSE_BRIEF);
    const target = planned.plan.slots[0]!;
    const edited = "TASK-M-EDIT hiss of a lunar airlock seal, byte-for-byte.";
    const overridden = planned.creative.applySoundPlanPromptOverrides({
      ...planned.context,
      soundPlan: planned.planRevision,
      overrides: [{ slotId: target.slotId, prompt: `  ${edited}  ` }],
    });
    const next = SoundPlanSchema.parse(
      planned.repository.resolveRevision(overridden),
    );
    expect(overridden.revisionId).not.toBe(planned.planRevision.revisionId);
    expect(next.slots[0]!.prompt).toBe(edited);
  });
});
