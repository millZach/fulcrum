import { createHash } from "node:crypto";

import {
  GameDesignSpecSchema,
  ProviderPreflightCodeSchema,
  ProviderPreflightError,
  SOUND_PROMPT_MAX,
  SoundDocumentSchema,
  SoundPlanSchema,
  SoundSetSchema,
  VisualDirectionSetSchema,
  type GameDesignSpec,
  type ProviderMode,
  type RevisionRef,
  type SoundDocument,
  type SoundPlan,
  type SoundSet,
  type SoundProvider,
  type StructuredVisualBible,
  type VisualDirection,
  type VisualDirectionSet,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";

import {
  ensureDurableSound,
  m1SoundIdempotencyKey,
  promptHashFor,
  type SoundGenerationRunner,
} from "./durable-sound.js";
import type { M1CreativeContext } from "./m1.js";

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

const sentence = (value: string): string => {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
};

const clipPrompt = (text: string, max = SOUND_PROMPT_MAX): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  const sliced = cleaned.slice(0, max);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > 40 ? sliced.slice(0, lastSpace) : sliced).trim();
};

const focusedAlternateRequest = (note: string): string =>
  `Focused alternate request: ${sentence(note)}`;

const writeRevision = <T>(
  repository: ProjectRepository,
  context: M1CreativeContext,
  entity: string,
  kind: string,
  value: T,
): RevisionRef =>
  repository.writeRevision({
    projectId: context.projectId,
    entityId: `${context.projectId}:${entity}`,
    kind,
    value,
    runId: context.runId,
  });

const selectedDirection = (
  set: VisualDirectionSet,
  revisionId: string,
): VisualDirection => {
  const direction = set.directions.find(
    (candidate) => candidate.revisionId === revisionId,
  );
  if (!direction)
    throw new Error(`Direction revision ${revisionId} is not in this set.`);
  return direction;
};

const paletteMood = (bible: StructuredVisualBible): string =>
  bible.palette
    .map((token) => `${token.name} (${token.role}, ${token.hex})`)
    .join(", ");

const firstConstraint = (spec: GameDesignSpec): string =>
  spec.gameplayConstraints[0] ?? spec.genre;

export const deriveSoundPlan = (input: {
  spec: GameDesignSpec;
  direction: VisualDirection;
  sourceGameDesignRevisionId: string;
  sourceDirectionRevisionId: string;
}): SoundPlan => {
  const bible = input.direction.visualBible;
  const atmosphere = bible.atmosphere;
  const materials = bible.materials.join(", ");
  const mood = paletteMood(bible);
  const lighting = bible.lighting;
  const style = bible.overallStyle;
  const loop = input.spec.coreLoop.join("; ");
  const verbs = input.spec.playerVerbs.join(", ");
  const slots: SoundPlan["slots"] = [
    {
      slotId: "core-loop-foley",
      title: "Core-loop foley",
      purpose: "Action foley for the repeatable playable loop",
      durationSeconds: 1.6,
      loop: false,
      prompt: clipPrompt(
        `Short foley of ${verbs} during ${loop}. ${atmosphere} ${style}. Materials: ${materials}. Palette: ${mood}.`,
      ),
    },
    {
      slotId: "success-sting",
      title: "Objective sting",
      purpose: "Success cue when the player completes the objective",
      durationSeconds: 2.2,
      loop: false,
      prompt: clipPrompt(
        `Bright short sting for accomplishing ${input.spec.objective} in ${input.spec.title}. ${atmosphere} ${lighting}. Palette: ${mood}.`,
      ),
    },
    {
      slotId: "ambience-bed",
      title: "Ambience bed",
      purpose: "Looping environmental bed for the playable space",
      durationSeconds: 8,
      loop: true,
      prompt: clipPrompt(
        `Looping ambience: ${atmosphere}. ${bible.architecture}. Materials: ${materials}. ${lighting}. Palette: ${mood}. Genre: ${input.spec.genre}.`,
      ),
    },
    {
      slotId: "ui-feedback",
      title: "UI feedback tick",
      purpose: "Readable interface confirmation tick",
      durationSeconds: 0.6,
      loop: false,
      prompt: clipPrompt(
        `Tiny UI tick for readable ${input.spec.camera} feedback in ${input.spec.title}. ${style}. Palette: ${mood}. ${input.spec.coreFantasy}`,
      ),
    },
    {
      slotId: "failure-cue",
      title: "Failure cue",
      purpose: "Stall or failure cue when the loop breaks",
      durationSeconds: 1.8,
      loop: false,
      prompt: clipPrompt(
        `Low stall cue when ${input.spec.objective} fails under ${firstConstraint(input.spec)}. ${atmosphere}. Materials: ${materials}. Palette: ${mood}.`,
      ),
    },
  ];
  return SoundPlanSchema.parse({
    sourceGameDesignRevisionId: input.sourceGameDesignRevisionId,
    sourceDirectionRevisionId: input.sourceDirectionRevisionId,
    slots,
  });
};

export class SoundPalette {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly runner?: SoundGenerationRunner,
  ) {}

  plan(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      directionSet: RevisionRef;
      selectedDirectionRevisionId: string;
    },
  ): RevisionRef {
    const spec = GameDesignSpecSchema.parse(
      this.repository.resolveRevision<GameDesignSpec>(context.gameDesignSpec),
    );
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision<VisualDirectionSet>(context.directionSet),
    );
    const direction = selectedDirection(
      set,
      context.selectedDirectionRevisionId,
    );
    const plan = deriveSoundPlan({
      spec,
      direction,
      sourceGameDesignRevisionId: context.gameDesignSpec.revisionId,
      sourceDirectionRevisionId: context.selectedDirectionRevisionId,
    });
    return writeRevision(
      this.repository,
      context,
      "sound-plan",
      "sound-plan",
      plan,
    );
  }

  applyPromptOverrides(
    context: M1CreativeContext & {
      soundPlan: RevisionRef;
      overrides: Array<{ slotId: string; prompt: string }>;
    },
  ): RevisionRef {
    const plan = SoundPlanSchema.parse(
      this.repository.resolveRevision<SoundPlan>(context.soundPlan),
    );
    const known = new Set(plan.slots.map((slot) => slot.slotId));
    const nextPrompts = new Map(
      plan.slots.map((slot) => [slot.slotId, slot.prompt]),
    );
    for (const override of context.overrides) {
      if (!known.has(override.slotId))
        throw new Error(`Sound plan has no slot ${override.slotId}.`);
      const prompt = override.prompt.trim();
      if (!prompt)
        throw new Error(`Sound prompt for slot ${override.slotId} is empty.`);
      nextPrompts.set(override.slotId, clipPrompt(prompt));
    }
    const slots = plan.slots.map((slot) => {
      const prompt = nextPrompts.get(slot.slotId);
      return prompt === undefined ? slot : { ...slot, prompt };
    });
    return writeRevision(
      this.repository,
      context,
      "sound-plan",
      "sound-plan",
      SoundPlanSchema.parse({
        sourceGameDesignRevisionId: plan.sourceGameDesignRevisionId,
        sourceDirectionRevisionId: plan.sourceDirectionRevisionId,
        slots,
      }),
    );
  }

  async generateSet(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      directionSet: RevisionRef;
      selectedDirectionRevisionId: string;
      soundPlan: RevisionRef;
      mode?: ProviderMode;
      soundProvider?: SoundProvider;
    },
  ): Promise<RevisionRef> {
    const plan = SoundPlanSchema.parse(
      this.repository.resolveRevision<SoundPlan>(context.soundPlan),
    );
    if (
      plan.sourceGameDesignRevisionId !== context.gameDesignSpec.revisionId ||
      plan.sourceDirectionRevisionId !== context.selectedDirectionRevisionId
    )
      throw new Error("The sound plan does not descend from these approvals.");
    const mode = context.mode ?? "replay";
    const soundProvider: SoundProvider =
      mode === "replay" ? "none" : (context.soundProvider ?? "none");
    const sourceRevisionIds = [
      context.gameDesignSpec.revisionId,
      context.selectedDirectionRevisionId,
      context.soundPlan.revisionId,
    ];
    const slots = [];
    for (const slot of plan.slots) {
      const revision = await this.createSoundRevision({
        ...context,
        slot,
        sourceRevisionIds,
        attempt: 0,
        mode,
        soundProvider,
      });
      slots.push({
        slotId: slot.slotId,
        title: slot.title,
        purpose: slot.purpose,
        revisions: [{ revision }],
        selectedRevisionId: revision.revisionId,
      });
    }
    const soundSet = SoundSetSchema.parse({
      soundSetId: stableId("sound-set", context.soundPlan.revisionId),
      sourceSoundPlanRevisionId: context.soundPlan.revisionId,
      sourceDirectionRevisionId: context.selectedDirectionRevisionId,
      slots,
    });
    return writeRevision(this.repository, context, "sound-set", "sound-set", {
      ...soundSet,
      sourceRevisionIds,
    });
  }

  async regenerateSlot(
    context: M1CreativeContext & {
      soundSet: RevisionRef;
      slotId: string;
      notes?: string;
      mode?: ProviderMode;
      soundProvider?: SoundProvider;
    },
  ): Promise<RevisionRef> {
    const set = SoundSetSchema.parse(
      this.repository.resolveRevision<SoundSet>(context.soundSet),
    );
    const target = set.slots.find((slot) => slot.slotId === context.slotId);
    if (!target)
      throw new Error(`Sound slot ${context.slotId} does not exist.`);
    const previousRevision =
      target.revisions.find(
        (revision) =>
          revision.revision.revisionId === target.selectedRevisionId,
      ) ?? target.revisions.at(-1);
    if (!previousRevision)
      throw new Error("The target slot has no sound revision to regenerate.");
    const priorDocument = SoundDocumentSchema.parse(
      this.repository.resolveRevision<SoundDocument>(previousRevision.revision),
    );
    const mode = context.mode ?? "replay";
    const soundProvider: SoundProvider =
      mode === "replay" ? "none" : (context.soundProvider ?? "none");
    const slot = {
      slotId: target.slotId,
      title: target.title,
      purpose: target.purpose,
      prompt: priorDocument.basePrompt,
      durationSeconds: priorDocument.durationSeconds,
      loop: priorDocument.loop,
    };
    const revision = await this.createSoundRevision({
      ...context,
      slot,
      sourceRevisionIds: [
        ...priorDocument.sourceRevisionIds,
        previousRevision.revision.revisionId,
        context.soundSet.revisionId,
      ],
      attempt: target.revisions.length,
      mode,
      soundProvider,
      ...(context.notes ? { regenerationNote: context.notes } : {}),
    });
    const slots = set.slots.map((candidate) =>
      candidate.slotId === target.slotId
        ? {
            ...candidate,
            revisions: [...candidate.revisions, { revision }],
            selectedRevisionId: revision.revisionId,
          }
        : candidate,
    );
    return writeRevision(this.repository, context, "sound-set", "sound-set", {
      ...SoundSetSchema.parse({ ...set, slots }),
      sourceRevisionIds: [context.soundSet.revisionId, revision.revisionId],
    });
  }

  private async createSoundRevision(
    input: M1CreativeContext & {
      slot: SoundPlan["slots"][number];
      sourceRevisionIds: string[];
      attempt: number;
      mode: ProviderMode;
      soundProvider: SoundProvider;
      regenerationNote?: string;
    },
  ): Promise<RevisionRef> {
    const basePrompt = input.slot.prompt;
    const prompt = input.regenerationNote
      ? clipPrompt(
          `${basePrompt} ${focusedAlternateRequest(input.regenerationNote)}`,
          2_000,
        )
      : basePrompt;
    const idempotencyKey = m1SoundIdempotencyKey({
      projectId: input.projectId,
      slotId: input.slot.slotId,
      sourceRevisionIds: input.sourceRevisionIds,
      attempt: input.attempt,
      mode: input.mode,
      soundProvider: input.soundProvider,
      prompt,
      durationSeconds: input.slot.durationSeconds,
      loop: input.slot.loop,
    });
    const prior = this.repository.getSubmissionByKey(idempotencyKey);
    if (prior?.status === "ready" && prior.resultRevisionId)
      return this.repository.getRevision(prior.resultRevisionId);
    const outcome = await ensureDurableSound({
      repository: this.repository,
      projectId: input.projectId,
      runId: input.runId,
      idempotencyKey,
      prompt,
      durationSeconds: input.slot.durationSeconds,
      loop: input.slot.loop,
      mode: input.mode,
      soundProvider: input.soundProvider,
      ...(this.runner ? { runner: this.runner } : {}),
    });
    if (outcome.status === "failed") {
      const preflight = ProviderPreflightCodeSchema.safeParse(
        outcome.error.code,
      );
      if (preflight.success)
        throw new ProviderPreflightError(preflight.data, outcome.error.message);
      throw new Error(outcome.error.message);
    }
    if (outcome.status !== "ready")
      throw new Error("Sound generation did not return a completed clip.");
    const recorded = this.repository.getSubmissionByKey(idempotencyKey);
    if (recorded?.resultRevisionId)
      return this.repository.getRevision(recorded.resultRevisionId);
    const sourceRevisions = [...new Set(input.sourceRevisionIds)].map(
      (revisionId) => this.repository.getRevision(revisionId),
    );
    const document = SoundDocumentSchema.parse({
      soundId: `${input.projectId}:${input.slot.slotId}`,
      slotId: input.slot.slotId,
      title: `${input.slot.title} r${String(input.attempt + 1).padStart(2, "0")}`,
      basePrompt,
      prompt,
      durationSeconds: input.slot.durationSeconds,
      loop: input.slot.loop,
      audio: outcome.value.artifact,
      provider:
        input.soundProvider === "none" ? "fulcrum-wav" : input.soundProvider,
      model: outcome.value.model,
      promptHash: outcome.value.promptHash || promptHashFor(prompt),
      sourceRevisionIds: sourceRevisions.map(({ revisionId }) => revisionId),
      costUsd: outcome.value.costUsd,
    });
    const revision = writeRevision(
      this.repository,
      input,
      `sound:${input.slot.slotId}`,
      "sound-document",
      document,
    );
    this.repository.updateSubmission(outcome.requestId, {
      status: "ready",
      resultRevisionId: revision.revisionId,
      payload: recorded?.payload ?? {
        audioArtifact: outcome.value.artifact,
        model: outcome.value.model,
        costUsd: outcome.value.costUsd,
      },
    });
    return revision;
  }
}
