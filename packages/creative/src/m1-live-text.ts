import { createHash } from "node:crypto";

import {
  GAME_NAME_CANDIDATE_COUNT,
  GAME_NAME_MAX_CHARS,
  GameDesignSpecSchema,
  PaletteTokenSchema,
  ProviderPreflightError,
  isProviderUsageError,
  isProviderPreflightError,
  readsImageAttachments,
  type ArtifactRef,
  type ExecutionProvider,
  type GameDesignSpec,
  type InterrogationQuestion,
  type InterrogationState,
  type ProviderMode,
  type RevisionRef,
  type SubmissionRecord,
} from "@fulcrum/domain";
import type { ModelExecution, VisionFrameInput } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { z } from "zod";

import { subscriptionQuotaError } from "./provider-usage.js";

/** The orchestrator seam. `generateStructuredVision` is optional because only
 *  two of the five execution providers can read an image, and because most
 *  test doubles only ever needed the text call. When it is absent the text
 *  call still runs — the images are simply not delivered, which the caller
 *  reports rather than hides. */
export type StructuredModelExecution = Pick<
  ModelExecution,
  "generateStructured"
> &
  Partial<Pick<ModelExecution, "generateStructuredVision">>;

export const M1_INTERROGATION_ROUND_CAP = 6;

export const INTERROGATION_BRANCH_VOCABULARY = [
  "experience.player-promise",
  "gameplay.core-loop",
  "scope.proof-boundary",
  "presentation.camera-readability",
  "gameplay.success-failure",
  "scope.consequential-tradeoff",
  "scope.adr-qualification",
  "scope.constraint-resolution",
] as const;

export const assertDistinctDirectionIdentities = (
  directions: Array<{ slug: string; name: string }>,
): void => {
  const slugs = directions.map((direction) => direction.slug);
  const names = directions.map((direction) => direction.name);
  if (
    new Set(slugs).size !== directions.length ||
    new Set(names).size !== directions.length
  ) {
    throw new Error(
      "The selected execution provider returned no valid structured result.",
    );
  }
};

export const LiveQuestionDraftSchema = z.object({
  branchId: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
    .min(3)
    .max(80),
  prompt: z.string().min(12).max(600),
  recommendation: z.string().min(8).max(400),
});
export type LiveQuestionDraft = z.infer<typeof LiveQuestionDraftSchema>;

export const LiveInterrogationFirstRoundSchema = z.object({
  questions: z.array(LiveQuestionDraftSchema).min(2).max(4),
});
export type LiveInterrogationFirstRound = z.infer<
  typeof LiveInterrogationFirstRoundSchema
>;

export const LiveInterrogationNextRoundSchema = z
  .object({
    understandingComplete: z.boolean(),
    questions: z.array(LiveQuestionDraftSchema).max(4),
  })
  .superRefine((value, context) => {
    if (!value.understandingComplete && value.questions.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ask 2-4 questions when shared understanding is not complete.",
        path: ["questions"],
      });
    }
  });
export type LiveInterrogationNextRound = z.infer<
  typeof LiveInterrogationNextRoundSchema
>;

/** Live output only. Domain `InformationOrigin.reference` stays optional. */
export const LiveStatementOriginSchema = z.object({
  source: z.enum(["brief", "user", "research", "fulcrum"]),
  reference: z.string().min(1),
});

const liveDesignStatement = <K extends "fact" | "assumption">(kind: K) =>
  z.object({
    statementId: z.string().min(1),
    text: z.string().min(1),
    kind: z.literal(kind),
    origin: LiveStatementOriginSchema,
  });

/** Strict-mode Game Design Spec: every origin must cite a reference. */
export const LiveGameDesignSpecOutputSchema = GameDesignSpecSchema.extend({
  facts: z.array(liveDesignStatement("fact")),
  assumptions: z.array(liveDesignStatement("assumption")),
});
export type LiveGameDesignSpecOutput = z.infer<
  typeof LiveGameDesignSpecOutputSchema
>;

export const LiveDirectionTemplateSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .min(3)
      .max(80),
    name: z.string().min(1).max(80),
    rationale: z.string().min(1).max(800),
    overallStyle: z.string().min(1).max(400),
    shapeLanguage: z.string().min(1).max(400),
    materials: z.array(z.string().min(1).max(80)).min(1).max(8),
    palette: z.array(PaletteTokenSchema).min(3).max(8),
    lighting: z.string().min(1).max(400),
    atmosphere: z.string().min(1).max(400),
    textureLanguage: z.string().min(1).max(400),
  })
  .superRefine((value, context) => {
    if (
      !value.palette.some((entry) => entry.role.trim() === "gameplay focus")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Palette must include a color whose role is "gameplay focus".',
        path: ["palette"],
      });
    }
  });
export type LiveDirectionTemplate = z.infer<typeof LiveDirectionTemplateSchema>;

export const LiveDirectionSetOutputSchema = z
  .object({
    directions: z.array(LiveDirectionTemplateSchema).length(3),
  })
  .superRefine((value, context) => {
    try {
      assertDistinctDirectionIdentities(value.directions);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error
            ? error.message
            : "Direction names and slugs must be distinct.",
        path: ["directions"],
      });
    }
  });
export type LiveDirectionSetOutput = z.infer<
  typeof LiveDirectionSetOutputSchema
>;

export const LiveFocusedDirectionOutputSchema = z.object({
  title: z.string().min(1).max(80),
  rationale: z.string().min(1).max(800),
  overallStyle: z.string().min(1).max(400),
  shapeLanguage: z.string().min(1).max(400),
  materials: z.array(z.string().min(1).max(80)).min(1).max(8),
  palette: z.array(PaletteTokenSchema).min(3).max(8),
  lighting: z.string().min(1).max(400),
  atmosphere: z.string().min(1).max(400),
  textureLanguage: z.string().min(1).max(400),
  cameraLanguage: z.string().min(1).max(400),
  readabilityRules: z.array(z.string().min(1).max(400)).min(1).max(12),
});
export type LiveFocusedDirectionOutput = z.infer<
  typeof LiveFocusedDirectionOutputSchema
>;

/** One batch of proposed titles. Distinctness is enforced here rather than
 *  left to the prompt: four candidates that repeat a name are three
 *  candidates, and the naming screen is a choice. */
export const LiveGameNamesOutputSchema = z
  .object({
    candidates: z
      .array(
        z.object({
          name: z.string().trim().min(2).max(GAME_NAME_MAX_CHARS),
          rationale: z.string().trim().min(8).max(240),
        }),
      )
      .length(GAME_NAME_CANDIDATE_COUNT),
  })
  .superRefine((value, context) => {
    const names = value.candidates.map((candidate) =>
      candidate.name.trim().toLowerCase(),
    );
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Every proposed name must be different.",
        path: ["candidates"],
      });
  });
export type LiveGameNamesOutput = z.infer<typeof LiveGameNamesOutputSchema>;

export const M1_TEXT_OPERATIONS = {
  interrogationRound: "m1-interrogation-round",
  gameNames: "m1-game-names",
  gameDesign: "m1-game-design",
  gameDesignRevise: "m1-game-design-revise",
  directions: "m1-directions",
  directionReplace: "m1-direction-replace",
  directionFocusedChange: "m1-direction-focused-change",
} as const;

export const hashText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const m1TextIdempotencyKey = (input: {
  operation: string;
  projectId: string;
  inputHash: string;
  mode: ProviderMode;
  provider: ExecutionProvider;
}): string =>
  `${input.operation}:${input.projectId}:${input.inputHash}:${input.mode}:${input.provider}`;

export const interrogationTranscriptKey = (
  brief: string,
  rounds: InterrogationState["rounds"],
): string =>
  JSON.stringify({
    brief,
    rounds: rounds.map((round) => ({
      questions: round.questions.map(
        ({ branchId, prompt, recommendation }) => ({
          branchId,
          prompt,
          recommendation,
        }),
      ),
      answers: round.answers.map(({ questionId, value, attachments }) => ({
        questionId,
        value,
        /* Only when there are images, so every image-free project keeps the
           idempotency key it already had. The sha256s are the identity: a
           different picture is a different question to ask the model, the
           same picture re-pasted is not. */
        ...(attachments && attachments.length > 0
          ? { attachments: attachments.map(({ sha256 }) => sha256) }
          : {}),
      })),
    })),
  });

/** Label a delivered frame so the prompt and the image agree on a name. */
export const interrogationAttachmentLabel = (
  answerIndex: number,
  attachmentIndex: number,
): string => `A${answerIndex + 1}.${attachmentIndex + 1}`;

/**
 * The attachments to send with an interrogation call, labeled to match the
 * transcript. Walks the rounds in exactly the order
 * `formatInterrogationTranscript` numbers them, which is what keeps "A2.1" in
 * the prompt pointing at the second frame the provider receives.
 */
export const interrogationAttachmentFrameRefs = (
  rounds: InterrogationState["rounds"],
  deliveredQuestionIds: ReadonlySet<string>,
): Array<{ label: string; artifact: ArtifactRef }> => {
  const refs: Array<{ label: string; artifact: ArtifactRef }> = [];
  let answerIndex = 0;
  for (const round of rounds) {
    for (const question of round.questions) {
      if (deliveredQuestionIds.has(question.questionId)) {
        const answer = round.answers.find(
          (entry) => entry.questionId === question.questionId,
        );
        answer?.attachments?.forEach((artifact, position) =>
          refs.push({
            label: interrogationAttachmentLabel(answerIndex, position),
            artifact,
          }),
        );
      }
      answerIndex += 1;
    }
  }
  return refs;
};

/**
 * The interview as one block of text.
 *
 * `deliveredQuestionIds` names the answers whose images are being sent with
 * this very call. An answer's attachments are described either way — the
 * model should know a picture exists — but only the delivered ones are
 * introduced by label, because telling a text-only provider to "see A2.1"
 * would be an instruction it cannot follow.
 */
export const formatInterrogationTranscript = (
  brief: string,
  rounds: InterrogationState["rounds"],
  deliveredQuestionIds: ReadonlySet<string> = new Set(),
): string => {
  const answered = rounds.flatMap((round) =>
    round.questions.map((question) => {
      const answer = round.answers.find(
        (entry) => entry.questionId === question.questionId,
      );
      return {
        branchId: question.branchId,
        prompt: question.prompt,
        recommendation: question.recommendation,
        answer: answer?.value,
        questionId: question.questionId,
        attachments: answer?.attachments?.length ?? 0,
      };
    }),
  );
  const attachmentLine = (
    entry: (typeof answered)[number],
    index: number,
  ): string[] => {
    if (entry.attachments === 0) return [];
    const plural = entry.attachments === 1 ? "image" : "images";
    if (!deliveredQuestionIds.has(entry.questionId))
      return [
        `A${index + 1} ${plural}: ${entry.attachments} attached by the user, not available to you on this route.`,
      ];
    const labels = Array.from({ length: entry.attachments }, (_, position) =>
      JSON.stringify(interrogationAttachmentLabel(index, position)),
    ).join(", ");
    return [
      `A${index + 1} ${plural}: ${entry.attachments} attached, supplied to you as ${labels}.`,
    ];
  };
  const lines = [
    `Brief:\n${brief}`,
    "",
    answered.length === 0
      ? "Transcript: (none yet)"
      : [
          "Transcript:",
          ...answered.map((entry, index) =>
            [
              `Q${index + 1} [${entry.branchId}]: ${entry.prompt}`,
              `Recommendation: ${entry.recommendation}`,
              `A${index + 1}: ${entry.answer ?? "(unanswered)"}`,
              ...attachmentLine(entry, index),
            ].join("\n"),
          ),
        ].join("\n\n"),
  ];
  return lines.join("\n");
};

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

export const materializeLiveQuestions = (
  brief: string,
  roundIndex: number,
  drafts: LiveQuestionDraft[],
): InterrogationQuestion[] =>
  drafts.map((draft, index) => ({
    questionId: stableId(
      "question",
      `${brief}:${roundIndex}:${index}:${draft.branchId}:${draft.prompt}`,
    ),
    branchId: draft.branchId,
    prompt: draft.prompt,
    recommendation: draft.recommendation,
  }));

export const nextRoundQuestions = (
  output: LiveInterrogationNextRound,
): LiveQuestionDraft[] =>
  output.understandingComplete ? [] : output.questions;

export const interrogationFirstRoundPrompt = (brief: string): string =>
  [
    formatInterrogationTranscript(brief, []),
    "",
    "Ask the first round of questions about this specific brief.",
    "Questions must be probing, specific, and non-generic — they should not apply equally to any other game.",
    "Give each question one focused recommendation the user can accept or edit.",
    "Ask 2-4 questions.",
    `Prefer these topic ids when they still apply: ${INTERROGATION_BRANCH_VOCABULARY.join(", ")}.`,
    "Otherwise invent kebab-case or dotted topic ids such as combat.resource-pressure.",
  ].join("\n");

export const interrogationNextRoundPrompt = (
  brief: string,
  rounds: InterrogationState["rounds"],
  roundIndex: number,
  deliveredQuestionIds: ReadonlySet<string> = new Set(),
): string => {
  const asked = [
    ...new Set(
      rounds.flatMap((round) =>
        round.questions.map((question) => question.branchId),
      ),
    ),
  ];
  return [
    formatInterrogationTranscript(brief, rounds, deliveredQuestionIds),
    "",
    ...(deliveredQuestionIds.size > 0
      ? [
          "The attached images are the user's own reference material for the answers they are labeled with. Read them as evidence about this game, and let what you see there steer the next questions.",
          "",
        ]
      : []),
    `This would be round ${roundIndex} of at most ${M1_INTERROGATION_ROUND_CAP}.`,
    `Already asked topic ids: ${asked.join(", ") || "(none)"}`,
    "If shared understanding is genuinely sufficient to write a complete Game Design Spec, set understandingComplete to true.",
    "Otherwise ask 2-4 new probing questions about remaining gaps in THIS brief. Do not repeat prior topics.",
    "Each question needs one focused recommendation.",
    `Prefer these topic ids when they still apply: ${INTERROGATION_BRANCH_VOCABULARY.join(", ")}.`,
  ].join("\n");
};

/** The naming conversation. Rejected batches are passed back so a steer is a
 *  reply and not a reroll: the model sees what it already offered and what the
 *  user said about it. */
export const gameNamesPrompt = (input: {
  brief: string;
  rounds: InterrogationState["rounds"];
  feedback?: string;
  rejected: string[];
  /** Images the user pasted next to the steer, when this route can carry
   *  them. Labeled "steer image N" to match the frames. */
  steerImages?: number;
}): string =>
  [
    formatInterrogationTranscript(input.brief, input.rounds),
    "",
    `Propose ${GAME_NAME_CANDIDATE_COUNT} candidate titles for THIS game.`,
    "A title is identity: it should come from the specifics of this brief and interview, never a generic fantasy or sci-fi noun pair.",
    `Each title is at most ${GAME_NAME_MAX_CHARS} characters, is not an existing published game, and names no licensed character or brand.`,
    "Give each one a single-sentence rationale tying it to something the user actually said.",
    "Vary the shapes across the batch — a compound word, a two-word phrase, a short phrase with an article.",
    ...(input.rejected.length > 0
      ? [
          "",
          `Already proposed and not chosen: ${input.rejected.join(", ")}.`,
          "Do not repeat those. Offer materially different titles.",
        ]
      : []),
    ...(input.feedback
      ? [
          "",
          `The user's steer on the last batch:\n${input.feedback}`,
          "Honor it literally.",
        ]
      : []),
    ...(input.steerImages
      ? [
          "",
          `The user attached ${input.steerImages} image${input.steerImages === 1 ? "" : "s"} to that steer, supplied to you as ${Array.from(
            { length: input.steerImages },
            (_, index) => JSON.stringify(gameNameAttachmentLabel(index)),
          ).join(", ")}.`,
          "Treat them as tone and identity reference for the titles.",
        ]
      : []),
  ].join("\n");

/** Label a delivered naming-steer frame. */
export const gameNameAttachmentLabel = (index: number): string =>
  `steer image ${index + 1}`;

export const gameDesignSpecPrompt = (
  brief: string,
  rounds: InterrogationState["rounds"],
  gameName?: string,
): string =>
  [
    formatInterrogationTranscript(brief, rounds),
    "",
    ...(gameName
      ? [
          `The user has already chosen this game's title: ${gameName}.`,
          `Use it verbatim as the spec title and write a spec the title fits.`,
          "",
        ]
      : []),
    "Write a complete Game Design Spec for this project.",
    "Every schema field is required, including facts and assumptions with origins.",
    'Every origin.reference is required: cite a brief quote, an answer number, or "fulcrum-assumption".',
    "The spec must be responsive to the user's answers, not a generic template.",
    "Do not invent licensed characters or brands. Declare assumptions explicitly.",
  ].join("\n");

export const reviseGameDesignPrompt = (
  previous: GameDesignSpec,
  change: string,
): string =>
  [
    "Previous Game Design Spec:",
    JSON.stringify(previous),
    "",
    `Requested change:\n${change}`,
    "",
    "Apply the requested change and return a complete Game Design Spec.",
    "Keep unrelated fields. Preserve existing fact and assumption identities unless the change replaces them.",
    'Every origin.reference is required: cite a brief quote, an answer number, or "fulcrum-assumption".',
  ].join("\n");

export const visualDirectionSetPrompt = (spec: GameDesignSpec): string =>
  [
    "Approved Game Design Spec:",
    JSON.stringify(spec),
    "",
    "Invent THREE materially different visual directions for THIS approved game.",
    "Each direction is a full template: name, kebab-case slug, rationale, overallStyle, shapeLanguage, materials, palette, lighting, atmosphere, textureLanguage.",
    'Palette entries need a name, a #RRGGBB hex, and a role. Include one color whose role is exactly "gameplay focus".',
    "Names and slugs must all be distinct. Interpret the approved fantasy, camera, and constraints — do not reuse generic stock styles.",
  ].join("\n");

export const replaceDirectionPrompt = (input: {
  spec: GameDesignSpec;
  kept: Array<{ name: string; slug: string; overallStyle: string }>;
  notes: string;
}): string =>
  [
    "Approved Game Design Spec:",
    JSON.stringify(input.spec),
    "",
    "Directions to keep (the replacement must differ in name, slug, and overall style):",
    JSON.stringify(input.kept),
    "",
    `User replacement notes:\n${input.notes}`,
    "",
    "Generate one replacement direction as a full template honoring the notes.",
    'Palette entries need a name, a #RRGGBB hex, and a role. Include one color whose role is exactly "gameplay focus".',
  ].join("\n");

export const focusedDirectionPrompt = (input: {
  spec: GameDesignSpec;
  change: string;
  pinnedAspects: Array<{ name: string; field: string; value: unknown }>;
  current: unknown;
}): string =>
  [
    "Approved Game Design Spec:",
    JSON.stringify(input.spec),
    "",
    "Current direction:",
    JSON.stringify(input.current),
    "",
    `Focused change:\n${input.change}`,
    "",
    "Pinned aspects are listed with their exact output field and current value:",
    JSON.stringify(input.pinnedAspects),
    "",
    "Copy every pinned value verbatim into its named field, even when the focused-change note mentions that aspect only to say keep or preserve it.",
    "Return the full focused-direction fields. Change only unpinned fields needed to honor the request.",
  ].join("\n");

export const interrogationFirstRoundSystemPrompt = [
  "[m1-interrogation-round]",
  "You are Fulcrum's interrogation interviewer.",
  "Grill the user about THIS game idea with specific, non-generic questions.",
  "Return only JSON matching the schema.",
].join("\n");

export const interrogationNextRoundSystemPrompt = [
  "[m1-interrogation-next]",
  "You are Fulcrum's interrogation interviewer continuing a recorded interview.",
  "Stop when shared understanding is genuinely sufficient.",
  "Return only JSON matching the schema.",
].join("\n");

export const gameNamesSystemPrompt = [
  "[m1-game-names]",
  "You name games. The title is the game's identity, so it must come from this specific brief and interview.",
  "Never propose the title of an existing published game, and never use a licensed character or brand.",
  "Return only JSON matching the schema.",
].join("\n");

export const gameDesignSystemPrompt = [
  "[m1-game-design]",
  "You are Fulcrum's game-design writer.",
  "Convert the brief and interview into a complete Game Design Spec.",
  "Return only JSON matching the schema.",
].join("\n");

export const gameDesignReviseSystemPrompt = [
  "[m1-game-design-revise]",
  "You are Fulcrum's game-design writer applying a requested revision.",
  "Return only JSON matching the schema.",
].join("\n");

export const directionsSystemPrompt = [
  "[m1-directions]",
  "You are Fulcrum's visual director.",
  "Invent three materially different directions for the approved game.",
  "Return only JSON matching the schema.",
].join("\n");

export const replaceDirectionSystemPrompt = [
  "[m1-direction-replace]",
  "You are Fulcrum's visual director replacing one unselected direction.",
  "Return only JSON matching the schema.",
].join("\n");

export const focusedDirectionSystemPrompt = [
  "[m1-direction-focused-change]",
  "You are Fulcrum's visual director applying a focused change.",
  "The prompt names each pinned output field. Reproduce every pinned value verbatim and change only unpinned fields.",
  "Return only JSON matching the schema.",
].join("\n");

const INVALID_STRUCTURED_MESSAGE =
  "The selected execution provider returned no valid structured result.";

export const isInvalidStructuredOutput = (error: unknown): boolean => {
  if (error instanceof z.ZodError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(INVALID_STRUCTURED_MESSAGE) ||
    /invalid structured/i.test(message)
  );
};

const subscriptionProviderName = (provider: ExecutionProvider): string =>
  ({
    claude: "Claude",
    openai: "OpenAI",
    grok: "Grok",
    opencode: "OpenCode",
    "openai-api": "OpenAI API",
  })[provider];

export const throwTextProviderError = (
  error: unknown,
  provider: ExecutionProvider,
): never => {
  if (isProviderPreflightError(error)) throw error;
  if (isProviderUsageError(error)) throw error;
  if (provider !== "openai-api") {
    const quota = subscriptionQuotaError(
      error,
      subscriptionProviderName(provider),
    );
    if (quota) throw quota;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /is not installed/i.test(message) ||
    /OPENAI_API_KEY/i.test(message) ||
    /not signed in|not authenticated|sign in to your subscription/i.test(
      message,
    )
  ) {
    throw new ProviderPreflightError("provider-unconfigured", message);
  }
  throw error instanceof Error ? error : new Error(message);
};

const selectedModel = (provider: ExecutionProvider): string | undefined =>
  provider === "openai-api"
    ? process.env.FULCRUM_OPENAI_API_MODEL
    : process.env[`FULCRUM_${provider.toUpperCase()}_ORCHESTRATOR_MODEL`];

const textReserveUsd = (): number =>
  Number(process.env.FULCRUM_OPENAI_TEXT_RESERVE_USD ?? "0.25");

const invalidOutputError = (operation: string): Error =>
  new Error(
    `Fulcrum could not parse a valid ${operation} result from the orchestrator. The project is unchanged and this request can be retried.`,
  );

const transientProviderError = (operation: string): Error =>
  new Error(
    `Fulcrum could not complete ${operation} because the orchestrator request failed. The project is unchanged and this request can be retried.`,
  );

export type DurableStructuredResult<T> =
  | {
      cached: true;
      submission: SubmissionRecord;
      revision: RevisionRef;
    }
  | {
      cached: false;
      value: T;
      revision: RevisionRef;
      model: string;
      submission: SubmissionRecord;
    };

const retryableFailed = (
  prior: SubmissionRecord,
  provider: ExecutionProvider,
): boolean => {
  if (prior.status !== "failed") return false;
  if (prior.payload.errorKind === "invalid-structured-output") return true;
  return (
    provider !== "openai-api" &&
    (prior.payload.errorKind === "transient-provider-error" ||
      prior.payload.errorKind === "subscription-quota")
  );
};

const retryablePreflight = (prior: SubmissionRecord): boolean =>
  prior.status === "intent-recorded" &&
  typeof prior.payload.preflightCode === "string" &&
  typeof prior.payload.providerCallStartedAt !== "string";

export const ensureDurableStructured = async <T>(input: {
  repository: ProjectRepository;
  execution: StructuredModelExecution;
  projectId: string;
  runId: string;
  operation: string;
  mode: ProviderMode;
  provider: ExecutionProvider;
  idempotencyKey: string;
  schema: z.ZodType<T>;
  systemPrompt: string;
  prompt: string;
  /** Images the user attached to the text this call is about. Delivered only
   *  on a live provider that can read them; otherwise the call runs text-only
   *  and the submission records that they did not reach the model. */
  frames?: VisionFrameInput[];
  persist: (
    value: T,
    model: string,
  ) =>
    | { revision: RevisionRef; payload?: Record<string, unknown> }
    | Promise<{ revision: RevisionRef; payload?: Record<string, unknown> }>;
}): Promise<DurableStructuredResult<T>> => {
  const prior = input.repository.getSubmissionByKey(input.idempotencyKey);
  if (prior?.status === "ready" && prior.resultRevisionId) {
    return {
      cached: true,
      submission: prior,
      revision: input.repository.getRevision(prior.resultRevisionId),
    };
  }
  if (
    prior &&
    input.mode === "live" &&
    !retryableFailed(prior, input.provider)
  ) {
    if (retryablePreflight(prior)) {
      // Fall through and reuse the intent after a typed preflight refusal.
    } else {
      if (prior.status !== "failed" && prior.status !== "submission-unknown") {
        input.repository.updateSubmission(prior.requestId, {
          status: "submission-unknown",
        });
      }
      throw new Error(
        prior.status === "failed"
          ? "The live creative request previously failed and requires user-directed retry."
          : "The live creative request may have been submitted before interruption; Fulcrum will not spend again automatically.",
      );
    }
  }

  const providerName =
    input.mode === "replay" ? "fulcrum-replay" : input.provider;
  const submission =
    prior &&
    (retryableFailed(prior, input.provider) || retryablePreflight(prior))
      ? prior
      : (prior ??
        input.repository.recordSubmissionIntent({
          projectId: input.projectId,
          operation: input.operation,
          provider: providerName,
          idempotencyKey: input.idempotencyKey,
          payload: {
            role: "orchestrator",
            executionProvider: input.provider,
          },
        }));

  try {
    if (input.mode === "live") {
      const {
        preflightCode: _preflightCode,
        error: _preflightError,
        errorKind: _errorKind,
        ...intentPayload
      } = submission.payload;
      input.repository.updateSubmission(submission.requestId, {
        status: "pending",
        payload: intentPayload,
      });
      if (
        input.provider === "openai-api" &&
        submission.payload.budgetReserved !== true
      ) {
        input.repository.reserveBudget(
          input.projectId,
          textReserveUsd(),
          "OpenAI API orchestration",
        );
      }
      input.repository.updateSubmission(submission.requestId, {
        status: "pending",
        payload: {
          ...intentPayload,
          ...(input.provider === "openai-api" ? { budgetReserved: true } : {}),
          providerCallStartedAt: new Date().toISOString(),
        },
      });
    }

    const model = selectedModel(input.provider);
    const cwd = process.env.FULCRUM_REPOSITORY_ROOT ?? process.cwd();
    const visionFrames =
      input.mode === "live" &&
      input.frames &&
      input.frames.length > 0 &&
      readsImageAttachments(input.provider) &&
      input.execution.generateStructuredVision
        ? input.frames
        : undefined;
    const call =
      visionFrames && input.execution.generateStructuredVision
        ? input.execution.generateStructuredVision({
            provider: input.provider as "openai" | "openai-api",
            ...(model ? { model } : {}),
            cwd,
            systemPrompt: input.systemPrompt,
            prompt: input.prompt,
            frames: visionFrames,
            schema: input.schema,
            idempotencyKey: input.idempotencyKey,
          })
        : input.execution.generateStructured({
            provider: input.provider,
            ...(model ? { model } : {}),
            cwd,
            systemPrompt: input.systemPrompt,
            prompt: input.prompt,
            schema: input.schema,
          });
    const generated = await call.then(
      (result) => ({ value: result.value, model: result.model }),
      (error: unknown) => throwTextProviderError(error, input.provider),
    );
    const attachmentPayload = input.frames?.length
      ? {
          attachmentCount: input.frames.length,
          attachmentsDelivered: visionFrames !== undefined,
        }
      : {};

    const persisted = await input.persist(generated.value, generated.model);
    const current =
      input.repository.getSubmissionByKey(input.idempotencyKey) ?? submission;
    input.repository.updateSubmission(submission.requestId, {
      status: "ready",
      resultRevisionId: persisted.revision.revisionId,
      payload: {
        ...current.payload,
        ...(persisted.payload ?? {}),
        model: generated.model,
        ...attachmentPayload,
      },
    });
    input.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: `${input.operation}.completed`,
      payload: {
        requestId: submission.requestId,
        revisionId: persisted.revision.revisionId,
        model: generated.model,
        ...attachmentPayload,
      },
    });
    return {
      cached: false,
      value: generated.value,
      revision: persisted.revision,
      model: generated.model,
      submission: input.repository.getSubmissionByKey(input.idempotencyKey)!,
    };
  } catch (error) {
    if (isProviderPreflightError(error)) {
      input.repository.updateSubmission(submission.requestId, {
        status: "intent-recorded",
        payload: {
          ...submission.payload,
          preflightCode: error.code,
          error: error.message,
        },
      });
      throw error;
    }
    if (isProviderUsageError(error)) {
      const current =
        input.repository.getSubmissionByKey(input.idempotencyKey) ?? submission;
      input.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: {
          ...current.payload,
          errorKind: error.code,
          usageCode: error.code,
          error: error.message,
        },
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (input.mode === "live" && isInvalidStructuredOutput(error)) {
      input.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: {
          ...submission.payload,
          errorKind: "invalid-structured-output",
          error: message,
        },
      });
      throw invalidOutputError(input.operation);
    }
    if (input.mode === "live" && input.provider !== "openai-api") {
      input.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: {
          ...submission.payload,
          errorKind: "transient-provider-error",
          error: message,
        },
      });
      throw transientProviderError(input.operation);
    }
    input.repository.updateSubmission(submission.requestId, {
      status: input.mode === "live" ? "submission-unknown" : "failed",
      payload: {
        ...submission.payload,
        error: message,
      },
    });
    throw error instanceof Error ? error : new Error(message);
  }
};

export { GameDesignSpecSchema };
