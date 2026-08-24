import { createHash } from "node:crypto";

import {
  GameDesignSpecSchema,
  PaletteTokenSchema,
  ProviderPreflightError,
  isProviderUsageError,
  isProviderPreflightError,
  type ExecutionProvider,
  type GameDesignSpec,
  type InterrogationQuestion,
  type InterrogationState,
  type ProviderMode,
  type RevisionRef,
  type SubmissionRecord,
} from "@fulcrum/domain";
import type { ModelExecution } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { z } from "zod";

import { subscriptionQuotaError } from "./provider-usage.js";

export type StructuredModelExecution = Pick<
  ModelExecution,
  "generateStructured"
>;

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

export const M1_TEXT_OPERATIONS = {
  interrogationRound: "m1-interrogation-round",
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
      answers: round.answers.map(({ questionId, value }) => ({
        questionId,
        value,
      })),
    })),
  });

export const formatInterrogationTranscript = (
  brief: string,
  rounds: InterrogationState["rounds"],
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
      };
    }),
  );
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
): string => {
  const asked = [
    ...new Set(
      rounds.flatMap((round) =>
        round.questions.map((question) => question.branchId),
      ),
    ),
  ];
  return [
    formatInterrogationTranscript(brief, rounds),
    "",
    `This would be round ${roundIndex} of at most ${M1_INTERROGATION_ROUND_CAP}.`,
    `Already asked topic ids: ${asked.join(", ") || "(none)"}`,
    "If shared understanding is genuinely sufficient to write a complete Game Design Spec, set understandingComplete to true.",
    "Otherwise ask 2-4 new probing questions about remaining gaps in THIS brief. Do not repeat prior topics.",
    "Each question needs one focused recommendation.",
    `Prefer these topic ids when they still apply: ${INTERROGATION_BRANCH_VOCABULARY.join(", ")}.`,
  ].join("\n");
};

export const gameDesignSpecPrompt = (
  brief: string,
  rounds: InterrogationState["rounds"],
): string =>
  [
    formatInterrogationTranscript(brief, rounds),
    "",
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
    const generated = await input.execution
      .generateStructured({
        provider: input.provider,
        ...(model ? { model } : {}),
        cwd: process.env.FULCRUM_REPOSITORY_ROOT ?? process.cwd(),
        systemPrompt: input.systemPrompt,
        prompt: input.prompt,
        schema: input.schema,
      })
      .then(
        (result) => ({ value: result.value, model: result.model }),
        (error: unknown) => throwTextProviderError(error, input.provider),
      );

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
