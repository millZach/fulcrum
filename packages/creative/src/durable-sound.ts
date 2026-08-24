import { createHash } from "node:crypto";

import {
  ArtifactRefSchema,
  decideDurableSubmission,
  isProviderPreflightError,
  ProviderPreflightError,
  type ArtifactRef,
  type ProductionOutcome,
  type ProviderMode,
  type SoundProvider,
  type SubmissionRecord,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";

export const ELEVENLABS_SFX_COST_ENV = "FULCRUM_ELEVENLABS_SFX_COST_USD";
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
export const ELEVENLABS_SOUND_MODEL = "eleven_text_to_sound_v2";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
export const ELEVENLABS_SOUND_URL =
  "https://api.elevenlabs.io/v1/sound-generation";
export const ELEVENLABS_PROMPT_INFLUENCE = 0.3;
export const DEFAULT_ELEVENLABS_SFX_COST_USD = 0.05;
export const FULCRUM_WAV_MODEL = "fulcrum-wav-v1";

const SAMPLE_RATE = 22_050;

export type DurableSoundResult = {
  bytes: Uint8Array;
  model: string;
  costUsd: number;
  artifact: ArtifactRef;
  mediaType: string;
  promptHash: string;
};

export type SoundGenerationInput = {
  text: string;
  durationSeconds: number;
  loop: boolean;
};

export type SoundGenerationResult = {
  bytes: Uint8Array;
  model: string;
  mediaType: string;
};

export type SoundGenerationRunner = (
  input: SoundGenerationInput,
) => Promise<SoundGenerationResult>;

export const promptHashFor = (prompt: string): string =>
  createHash("sha256").update(prompt).digest("hex");

export const m1SoundIdempotencyKey = (input: {
  projectId: string;
  slotId: string;
  sourceRevisionIds: string[];
  attempt: number;
  mode: ProviderMode;
  soundProvider: SoundProvider;
  prompt: string;
  durationSeconds: number;
  loop: boolean;
}): string => {
  const lineage = createHash("sha256")
    .update([...new Set(input.sourceRevisionIds)].join("|"))
    .digest("hex");
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        prompt: input.prompt,
        durationSeconds: input.durationSeconds,
        loop: input.loop,
      }),
    )
    .digest("hex");
  return `m1-sound:${input.projectId}:${input.slotId}:${lineage}:${input.attempt}:${input.mode}:${input.soundProvider}:${payloadHash}`;
};

export const elevenLabsSfxCostUsd = (
  environment: NodeJS.ProcessEnv = process.env,
): number => {
  const amount = Number(
    environment[ELEVENLABS_SFX_COST_ENV] ?? DEFAULT_ELEVENLABS_SFX_COST_USD,
  );
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ProviderPreflightError(
      "payload-invalid",
      `${ELEVENLABS_SFX_COST_ENV} must be a finite non-negative number.`,
    );
  }
  return amount;
};

export const elevenLabsSoundGenerationRequest = (input: {
  text: string;
  durationSeconds: number;
  loop: boolean;
  apiKey: string;
}): {
  method: "POST";
  url: string;
  headers: { "Content-Type": "application/json"; "xi-api-key": string };
  body: {
    text: string;
    duration_seconds: number;
    prompt_influence: number;
    model_id: string;
    loop: boolean;
  };
} => {
  const url = new URL(ELEVENLABS_SOUND_URL);
  url.searchParams.set("output_format", ELEVENLABS_OUTPUT_FORMAT);
  return {
    method: "POST",
    url: url.toString(),
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": input.apiKey,
    },
    body: {
      text: input.text,
      duration_seconds: input.durationSeconds,
      prompt_influence: ELEVENLABS_PROMPT_INFLUENCE,
      model_id: ELEVENLABS_SOUND_MODEL,
      loop: input.loop,
    },
  };
};

const requireElevenLabsApiKey = (
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const apiKey = environment[ELEVENLABS_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new ProviderPreflightError(
      "provider-unconfigured",
      "ElevenLabs sound generation requires ELEVENLABS_API_KEY.",
    );
  }
  return apiKey;
};

export const runElevenLabsSound: SoundGenerationRunner = async (input) => {
  const apiKey = requireElevenLabsApiKey();
  const request = elevenLabsSoundGenerationRequest({
    text: input.text,
    durationSeconds: input.durationSeconds,
    loop: input.loop,
    apiKey,
  });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!response.ok)
    throw new Error(`ElevenLabs sound generation failed (${response.status}).`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    model: ELEVENLABS_SOUND_MODEL,
    mediaType: "audio/mpeg",
  };
};

const writeInt16LE = (view: DataView, offset: number, value: number): void => {
  view.setInt16(offset, value, true);
};

const writeUint16LE = (view: DataView, offset: number, value: number): void => {
  view.setUint16(offset, value, true);
};

const writeUint32LE = (view: DataView, offset: number, value: number): void => {
  view.setUint32(offset, value, true);
};

const writeFourCC = (
  bytes: Uint8Array,
  offset: number,
  value: string,
): void => {
  for (let index = 0; index < 4; index += 1)
    bytes[offset + index] = value.charCodeAt(index);
};

/** Deterministic 22.05 kHz 16-bit mono RIFF/WAV seeded from sha256(prompt). */
export const renderDeterministicWav = (prompt: string): Uint8Array => {
  const hash = createHash("sha256").update(prompt).digest();
  const extra = hash[4]!;
  const sampleCount = SAMPLE_RATE + Math.floor((extra * SAMPLE_RATE) / 255);
  const freq = 110 + (hash[5]! % 160);
  const noiseMix = hash[6]! / 255;
  let state =
    (hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]! | 0;
  if (state === 0) state = 0x9e3779b9;
  const pcm = new Int16Array(sampleCount);
  const attack = Math.floor(SAMPLE_RATE * 0.02);
  const release = Math.floor(SAMPLE_RATE * 0.08);
  for (let index = 0; index < sampleCount; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    const phase = ((index * freq) % SAMPLE_RATE) / SAMPLE_RATE;
    const square = phase < 0.5 ? 1 : -1;
    const noise = (state & 0xffff) / 0x8000 - 1;
    const env =
      index < attack
        ? index / attack
        : index > sampleCount - release
          ? Math.max(0, (sampleCount - index) / release)
          : 1;
    const mixed = square * (1 - noiseMix * 0.5) + noise * noiseMix * 0.5;
    pcm[index] = Math.max(
      -32767,
      Math.min(32767, Math.round(mixed * env * 18_000)),
    );
  }
  const dataBytes = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeFourCC(bytes, 0, "RIFF");
  writeUint32LE(view, 4, 36 + dataBytes);
  writeFourCC(bytes, 8, "WAVE");
  writeFourCC(bytes, 12, "fmt ");
  writeUint32LE(view, 16, 16);
  writeUint16LE(view, 20, 1);
  writeUint16LE(view, 22, 1);
  writeUint32LE(view, 24, SAMPLE_RATE);
  writeUint32LE(view, 28, SAMPLE_RATE * 2);
  writeUint16LE(view, 32, 2);
  writeUint16LE(view, 34, 16);
  writeFourCC(bytes, 36, "data");
  writeUint32LE(view, 40, dataBytes);
  for (let index = 0; index < sampleCount; index += 1)
    writeInt16LE(view, 44 + index * 2, pcm[index]!);
  return bytes;
};

const audioArtifactFromPayload = (
  payload: Record<string, unknown>,
): ArtifactRef | undefined => {
  const parsed = ArtifactRefSchema.safeParse(payload.audioArtifact);
  return parsed.success ? parsed.data : undefined;
};

const refuseBeforeProviderCall = (
  repository: ProjectRepository,
  submission: SubmissionRecord,
  error: ProviderPreflightError,
): ProductionOutcome<DurableSoundResult> => {
  repository.updateSubmission(submission.requestId, {
    status: "intent-recorded",
    payload: {
      ...submission.payload,
      preflightCode: error.code,
      error: error.message,
    },
  });
  return {
    status: "failed",
    requestId: submission.requestId,
    error: {
      code: error.code,
      message: error.message,
      recoverable: true,
    },
  };
};

const unknownLiveFailure = (
  repository: ProjectRepository,
  submission: SubmissionRecord,
  message: string,
): ProductionOutcome<DurableSoundResult> => {
  repository.updateSubmission(submission.requestId, {
    status: "submission-unknown",
    payload: { ...submission.payload, error: message },
  });
  return {
    status: "failed",
    requestId: submission.requestId,
    error: { code: "submission-unknown", message, recoverable: true },
  };
};

export const ensureDurableSound = async (input: {
  repository: ProjectRepository;
  projectId: string;
  runId: string;
  idempotencyKey: string;
  prompt: string;
  durationSeconds: number;
  loop: boolean;
  mode: ProviderMode;
  soundProvider: SoundProvider;
  runner?: SoundGenerationRunner;
}): Promise<ProductionOutcome<DurableSoundResult>> => {
  const provider = input.soundProvider;
  const promptHash = promptHashFor(input.prompt);
  const prior = input.repository.getSubmissionByKey(input.idempotencyKey);
  if (prior?.status === "ready") {
    const artifact = audioArtifactFromPayload(prior.payload);
    const model =
      typeof prior.payload.model === "string" ? prior.payload.model : undefined;
    const costUsd =
      typeof prior.payload.costUsd === "number"
        ? prior.payload.costUsd
        : undefined;
    const mediaType =
      typeof prior.payload.mediaType === "string"
        ? prior.payload.mediaType
        : artifact?.mediaType;
    if (!artifact || !model || costUsd === undefined || !mediaType) {
      return {
        status: "failed",
        requestId: prior.requestId,
        error: {
          code: "sound-generation-failed",
          message:
            "The previous sound clip is marked ready without a stored artifact.",
          recoverable: true,
        },
      };
    }
    return {
      status: "ready",
      requestId: prior.requestId,
      value: {
        bytes: input.repository.readArtifact(artifact),
        model,
        costUsd,
        artifact,
        mediaType,
        promptHash,
      },
    };
  }

  const decision = decideDurableSubmission(prior, input.mode);
  if (decision.kind === "ready") {
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code: "sound-generation-failed",
        message:
          "The previous sound clip is marked ready without a stored artifact.",
        recoverable: true,
      },
    };
  }
  if (decision.kind === "terminal-failed") {
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code:
          decision.submission.status === "submission-unknown"
            ? "submission-unknown"
            : "sound-generation-failed",
        message:
          decision.submission.status === "submission-unknown"
            ? "The live sound request may have reached ElevenLabs before interruption; Fulcrum will not spend again automatically."
            : "The previous sound job failed and requires user-directed regeneration.",
        recoverable: true,
      },
    };
  }
  if (decision.kind === "unknown-interruption") {
    input.repository.updateSubmission(decision.submission.requestId, {
      status: "submission-unknown",
    });
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code: "submission-unknown",
        message:
          "The live sound request may have reached ElevenLabs before interruption; Fulcrum will not spend again automatically.",
        recoverable: true,
      },
    };
  }
  if (decision.kind === "inspect") {
    return {
      status: "failed",
      requestId: decision.submission.requestId,
      error: {
        code: "sound-generation-failed",
        message:
          "Sound generation has no external job to inspect; this submission cannot be polled.",
        recoverable: true,
      },
    };
  }

  const submission =
    decision.submission ??
    input.repository.recordSubmissionIntent({
      projectId: input.projectId,
      operation: "m1-sound-effect",
      provider: provider === "none" ? "fulcrum-wav" : provider,
      idempotencyKey: input.idempotencyKey,
      payload: {
        prompt: input.prompt,
        durationSeconds: input.durationSeconds,
        loop: input.loop,
        promptHash,
      },
    });

  try {
    const runner = input.runner ?? runElevenLabsSound;
    if (provider === "elevenlabs" && runner === runElevenLabsSound)
      requireElevenLabsApiKey();
    const reservedCost = provider === "elevenlabs" ? elevenLabsSfxCostUsd() : 0;
    if (reservedCost > 0) {
      input.repository.reserveBudget(
        input.projectId,
        reservedCost,
        "ElevenLabs sound generation",
      );
    }

    const {
      preflightCode: _preflightCode,
      error: _preflightError,
      ...intentPayload
    } = submission.payload;
    input.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...intentPayload,
        providerCallStartedAt: new Date().toISOString(),
      },
    });

    let generated: SoundGenerationResult;
    try {
      generated =
        provider === "none"
          ? {
              bytes: renderDeterministicWav(input.prompt),
              model: FULCRUM_WAV_MODEL,
              mediaType: "audio/wav",
            }
          : await runner({
              text: input.prompt,
              durationSeconds: input.durationSeconds,
              loop: input.loop,
            });
    } catch (error) {
      if (isProviderPreflightError(error))
        return refuseBeforeProviderCall(input.repository, submission, error);
      const message = error instanceof Error ? error.message : String(error);
      if (provider === "elevenlabs" && input.mode === "live")
        return unknownLiveFailure(input.repository, submission, message);
      input.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: { ...submission.payload, error: message },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: {
          code: "sound-generation-failed",
          message,
          recoverable: true,
        },
      };
    }

    const artifact = input.repository.putArtifact(
      input.projectId,
      generated.bytes,
      generated.mediaType,
    );
    const current =
      input.repository.getSubmissionByKey(input.idempotencyKey) ?? submission;
    input.repository.updateSubmission(submission.requestId, {
      status: "ready",
      payload: {
        ...current.payload,
        model: generated.model,
        costUsd: reservedCost,
        mediaType: generated.mediaType,
        audioArtifact: artifact,
        promptHash,
        durationSeconds: input.durationSeconds,
        loop: input.loop,
      },
    });
    input.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: "sound.generated",
      payload: {
        requestId: submission.requestId,
        audioArtifactId: artifact.artifactId,
        costUsd: reservedCost,
        provider,
        model: generated.model,
        durationSeconds: input.durationSeconds,
        promptHash,
      },
    });
    return {
      status: "ready",
      requestId: submission.requestId,
      value: {
        bytes: generated.bytes,
        model: generated.model,
        costUsd: reservedCost,
        artifact,
        mediaType: generated.mediaType,
        promptHash,
      },
    };
  } catch (error) {
    if (isProviderPreflightError(error))
      return refuseBeforeProviderCall(input.repository, submission, error);
    const message = error instanceof Error ? error.message : String(error);
    if (provider === "elevenlabs" && input.mode === "live")
      return unknownLiveFailure(input.repository, submission, message);
    input.repository.updateSubmission(submission.requestId, {
      status: "failed",
      payload: { ...submission.payload, error: message },
    });
    return {
      status: "failed",
      requestId: submission.requestId,
      error: {
        code: "sound-generation-failed",
        message,
        recoverable: true,
      },
    };
  }
};
