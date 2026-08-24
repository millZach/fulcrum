import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProviderPreflightError } from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureDurableSound,
  m1SoundIdempotencyKey,
  renderDeterministicWav,
  runElevenLabsSound,
} from "./durable-sound.js";

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-durable-sound-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  delete process.env.FULCRUM_ELEVENLABS_SFX_COST_USD;
  delete process.env.ELEVENLABS_API_KEY;
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const openProject = (
  budgetUsd: number,
): {
  repository: ProjectRepository;
  projectId: string;
  runId: string;
} => {
  const repository = new ProjectRepository(temporaryRoot());
  const projectId = "m1-sound";
  const runId = "m1-sound-run";
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: {
      text: "Sound palette fixture brief for tests.",
      rightsConfirmed: true,
    },
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m1",
    projectId,
    name: "M1 sound fixture",
    mode: "live",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "none",
    soundProvider: "elevenlabs",
    status: "awaiting-input",
    stage: "sound-generation",
    runId,
    budgetUsd,
    spentUsd: 0,
    conceptReplacementCount: 0,
    brief,
    createdAt,
    updatedAt: createdAt,
  });
  return { repository, projectId, runId };
};

const keyFor = (
  projectId: string,
  prompt: string,
  extras: Partial<Parameters<typeof m1SoundIdempotencyKey>[0]> = {},
) =>
  m1SoundIdempotencyKey({
    projectId,
    slotId: "core-loop-foley",
    sourceRevisionIds: ["plan-1", "dir-1"],
    attempt: 0,
    mode: "live",
    soundProvider: "elevenlabs",
    prompt,
    durationSeconds: 1.6,
    loop: false,
    ...extras,
  });

describe("renderDeterministicWav", () => {
  it("emits identical bytes across runs, a valid RIFF header, and distinct prompts", () => {
    const first = renderDeterministicWav("greenhouse drip foley");
    const second = renderDeterministicWav("greenhouse drip foley");
    const other = renderDeterministicWav("reliquary stone scrape");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(other))).toBe(false);
    expect(Buffer.from(first.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(first.subarray(8, 12)).toString("ascii")).toBe("WAVE");
    expect(Buffer.from(first.subarray(12, 16)).toString("ascii")).toBe("fmt ");
    expect(Buffer.from(first.subarray(36, 40)).toString("ascii")).toBe("data");
    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(22_050);
    expect(view.getUint16(34, true)).toBe(16);
    expect(first.byteLength).toBeGreaterThan(22_050 * 2);
    expect(first.byteLength).toBeLessThanOrEqual(44 + 22_050 * 2 * 2);
  });
});

describe("m1SoundIdempotencyKey", () => {
  it("changes when prompt, duration, or loop change", () => {
    const base = {
      projectId: "p1",
      slotId: "ambience-bed",
      sourceRevisionIds: ["rev-a", "rev-b"],
      attempt: 0,
      mode: "live" as const,
      soundProvider: "elevenlabs" as const,
      prompt: "looping greenhouse bed",
      durationSeconds: 8,
      loop: true,
    };
    const first = m1SoundIdempotencyKey(base);
    expect(
      m1SoundIdempotencyKey({ ...base, prompt: "edited greenhouse bed" }),
    ).not.toBe(first);
    expect(m1SoundIdempotencyKey({ ...base, durationSeconds: 6 })).not.toBe(
      first,
    );
    expect(m1SoundIdempotencyKey({ ...base, loop: false })).not.toBe(first);
    expect(m1SoundIdempotencyKey(base)).toBe(first);
  });
});

describe("ensureDurableSound", () => {
  it("reserves budget on a successful fake ElevenLabs run and does not spend twice", async () => {
    const { repository, projectId, runId } = openProject(1);
    const prompt = "A readable greenhouse airlock hiss";
    const idempotencyKey = keyFor(projectId, prompt);
    const runner = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3, 4]),
      model: "eleven_text_to_sound_v2",
      mediaType: "audio/mpeg",
    }));

    const first = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });
    const second = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(second.requestId).toBe(first.requestId);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getProject(projectId).spentUsd).toBe(0.05);
    expect(
      repository
        .listEvents(projectId)
        .some((event) => event.type === "budget.reserved"),
    ).toBe(true);
    repository.close();
  });

  it("does not reuse an unedited clip after the prompt changes", async () => {
    const { repository, projectId, runId } = openProject(1);
    const original = "unedited greenhouse hiss";
    const edited = "edited greenhouse hiss, never reuse the first clip";
    const runner = vi.fn(async ({ text }: { text: string }) => ({
      bytes: new TextEncoder().encode(text),
      model: "eleven_text_to_sound_v2",
      mediaType: "audio/mpeg",
    }));

    const first = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey: keyFor(projectId, original),
      prompt: original,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });
    const second = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey: keyFor(projectId, edited),
      prompt: edited,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(second.requestId).not.toBe(first.requestId);
    expect(runner).toHaveBeenCalledTimes(2);
    if (first.status === "ready" && second.status === "ready") {
      expect(Buffer.from(first.value.bytes).toString()).toBe(original);
      expect(Buffer.from(second.value.bytes).toString()).toBe(edited);
    }
    repository.close();
  });

  it("refuses a budget-exhausted key without calling the provider, then proceeds after the cap is raised", async () => {
    const { repository, projectId, runId } = openProject(0.05);
    repository.reserveBudget(projectId, 0.05, "exhaust the cap");
    const prompt = "A readable greenhouse airlock hiss";
    const idempotencyKey = keyFor(projectId, prompt);
    const runner = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      model: "eleven_text_to_sound_v2",
      mediaType: "audio/mpeg",
    }));

    const refused = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });
    expect(refused.status).toBe("failed");
    if (refused.status === "failed")
      expect(refused.error.code).toBe("budget-refused");
    expect(runner).not.toHaveBeenCalled();
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "intent-recorded",
    );

    const project = repository.getProject(projectId);
    repository.saveProject({ ...project, budgetUsd: 1 });
    const retried = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });
    expect(retried.status).toBe("ready");
    expect(retried.requestId).toBe(refused.requestId);
    expect(runner).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("marks a generic live runner throw as submission-unknown and does not retry", async () => {
    const { repository, projectId, runId } = openProject(1);
    const prompt = "A readable greenhouse airlock hiss";
    const idempotencyKey = keyFor(projectId, prompt);
    const runner = vi.fn(async () => {
      throw new Error("elevenlabs exploded");
    });

    const outcome = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error.code).toBe("submission-unknown");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "submission-unknown",
    );

    const retried = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
      runner,
    });
    expect(retried.status).toBe("failed");
    expect(runner).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("preflights when ELEVENLABS_API_KEY is missing and does not call fetch", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { repository, projectId, runId } = openProject(1);
    const prompt = "A readable greenhouse airlock hiss";
    const idempotencyKey = keyFor(projectId, prompt);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey,
      prompt,
      durationSeconds: 1.6,
      loop: false,
      mode: "live",
      soundProvider: "elevenlabs",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("provider-unconfigured");
      expect(outcome.error.message).toMatch(/ELEVENLABS_API_KEY/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
      "intent-recorded",
    );
    vi.unstubAllGlobals();
    repository.close();
  });

  it("renders a WAV through the none provider with zero spend", async () => {
    const { repository, projectId, runId } = openProject(1);
    const prompt = "looping greenhouse bed";
    const outcome = await ensureDurableSound({
      repository,
      projectId,
      runId,
      idempotencyKey: keyFor(projectId, prompt, {
        mode: "replay",
        soundProvider: "none",
      }),
      prompt,
      durationSeconds: 8,
      loop: true,
      mode: "replay",
      soundProvider: "none",
    });
    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      expect(outcome.value.mediaType).toBe("audio/wav");
      expect(outcome.value.model).toBe("fulcrum-wav-v1");
      expect(outcome.value.costUsd).toBe(0);
      expect(
        Buffer.from(outcome.value.bytes.subarray(0, 4)).toString("ascii"),
      ).toBe("RIFF");
    }
    expect(repository.getProject(projectId).spentUsd).toBe(0);
    repository.close();
  });

  it("does not invoke the default ElevenLabs runner from this suite", () => {
    expect(runElevenLabsSound.name).toBe("runElevenLabsSound");
  });
});
