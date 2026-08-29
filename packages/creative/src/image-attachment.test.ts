import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InterrogationStateSchema, type ArtifactRef } from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  attachmentFrames,
  resolveImageAttachments,
  storeImageAttachment,
} from "./image-attachment.js";
import { M1CreativeDevelopment } from "./m1.js";
import {
  formatInterrogationTranscript,
  interrogationAttachmentFrameRefs,
  interrogationTranscriptKey,
  type StructuredModelExecution,
} from "./m1-live-text.js";

const roots: string[] = [];

const createHarness = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-attachment-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const context = {
    projectId: `project-${roots.length}`,
    runId: `run-${roots.length}`,
  };
  repository.reserveProject(context.projectId);
  return { repository, context };
};

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

const swatch = async (
  color: { r: number; g: number; b: number },
  format: "png" | "jpeg" | "webp" = "png",
): Promise<string> => {
  const image = sharp({
    create: { width: 24, height: 16, channels: 3, background: color },
  });
  const bytes = await (
    format === "png"
      ? image.png()
      : format === "jpeg"
        ? image.jpeg()
        : image.webp()
  ).toBuffer();
  return `data:image/${format};base64,${bytes.toString("base64")}`;
};

describe("storeImageAttachment", () => {
  it("normalizes every accepted clipboard format to a PNG artifact", async () => {
    const { repository, context } = createHarness();
    for (const format of ["png", "jpeg", "webp"] as const) {
      const attachment = await storeImageAttachment({
        repository,
        projectId: context.projectId,
        dataUrl: await swatch({ r: 40, g: 200, b: 190 }, format),
      });
      expect(attachment.mediaType).toBe("image/png");
      expect(attachment.uri).toBe(`/api/artifacts/${attachment.artifactId}`);
      expect(repository.readArtifact(attachment).byteLength).toBe(
        attachment.byteLength,
      );
    }
  });

  it("gives the same picture pasted twice one artifact", async () => {
    const { repository, context } = createHarness();
    const dataUrl = await swatch({ r: 22, g: 22, b: 29 });
    const first = await storeImageAttachment({
      repository,
      projectId: context.projectId,
      dataUrl,
    });
    const second = await storeImageAttachment({
      repository,
      projectId: context.projectId,
      dataUrl,
    });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.sha256).toBe(first.sha256);
  });

  it("refuses a data URL that is not an accepted image", async () => {
    const { repository, context } = createHarness();
    await expect(
      storeImageAttachment({
        repository,
        projectId: context.projectId,
        dataUrl: "data:text/html;base64,PHNjcmlwdD4=",
      }),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);
  });

  it("refuses bytes that claim to be an image but are not", async () => {
    const { repository, context } = createHarness();
    await expect(
      storeImageAttachment({
        repository,
        projectId: context.projectId,
        dataUrl: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`,
      }),
    ).rejects.toThrow(/could not be read as an image/);
  });
});

describe("resolveImageAttachments", () => {
  it("will not attach another project's artifact", async () => {
    const mine = createHarness();
    const theirs = "project-not-mine";
    mine.repository.reserveProject(theirs);
    const foreign = await storeImageAttachment({
      repository: mine.repository,
      projectId: theirs,
      dataUrl: await swatch({ r: 255, g: 115, b: 150 }),
    });
    expect(() =>
      resolveImageAttachments(mine.repository, mine.context.projectId, [
        foreign.artifactId,
      ]),
    ).toThrow(/does not exist/);
  });

  it("collapses a repeated id and caps the count", async () => {
    const { repository, context } = createHarness();
    const stored = await storeImageAttachment({
      repository,
      projectId: context.projectId,
      dataUrl: await swatch({ r: 10, g: 139, b: 129 }),
    });
    expect(
      resolveImageAttachments(repository, context.projectId, [
        stored.artifactId,
        stored.artifactId,
      ]),
    ).toHaveLength(1);
    expect(() =>
      resolveImageAttachments(
        repository,
        context.projectId,
        Array.from({ length: 5 }, () => stored.artifactId),
      ),
    ).toThrow(/at most 4 images/);
  });

  it("reads back nothing when no ids are supplied", () => {
    const { repository, context } = createHarness();
    expect(
      resolveImageAttachments(repository, context.projectId, undefined),
    ).toEqual([]);
  });
});

const artifact = (sha: string): ArtifactRef => ({
  artifactId: `artifact-${sha.slice(0, 6)}`,
  sha256: sha.padEnd(64, "0"),
  mediaType: "image/png",
  byteLength: 12,
  uri: `/api/artifacts/artifact-${sha.slice(0, 6)}`,
});

const roundsWithImages = (attachments: ArtifactRef[]) => [
  {
    roundId: "round-1",
    questions: [
      {
        questionId: "q1",
        branchId: "gameplay.core-loop",
        prompt: "Which actions form the loop?",
        recommendation: "Pick three.",
      },
      {
        questionId: "q2",
        branchId: "scope.proof-boundary",
        prompt: "What is the smallest slice?",
        recommendation: "One arena.",
      },
    ],
    answers: [
      {
        questionId: "q1",
        value: "Explore, charge, defend",
        origin: { source: "user" as const, reference: "round-1" },
      },
      {
        questionId: "q2",
        value: "It looks like this",
        origin: { source: "user" as const, reference: "round-1" },
        attachments,
      },
    ],
    createdAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:01:00.000Z",
  },
];

describe("interrogation transcript with images", () => {
  const rounds = roundsWithImages([artifact("aaa"), artifact("bbb")]);

  it("introduces delivered images by the label the frames carry", () => {
    const transcript = formatInterrogationTranscript(
      "brief",
      rounds,
      new Set(["q2"]),
    );
    expect(transcript).toContain(
      'A2 images: 2 attached, supplied to you as "A2.1", "A2.2".',
    );
    const refs = interrogationAttachmentFrameRefs(rounds, new Set(["q2"]));
    expect(refs.map((ref) => ref.label)).toEqual(["A2.1", "A2.2"]);
    expect(refs.map((ref) => ref.artifact.sha256)).toEqual([
      artifact("aaa").sha256,
      artifact("bbb").sha256,
    ]);
  });

  it("says the images are out of reach when they are not delivered", () => {
    const transcript = formatInterrogationTranscript("brief", rounds);
    expect(transcript).toContain(
      "A2 images: 2 attached by the user, not available to you on this route.",
    );
    expect(transcript).not.toContain("A2.1");
    expect(interrogationAttachmentFrameRefs(rounds, new Set())).toEqual([]);
  });

  it("leaves an image-free transcript byte-identical to before attachments", () => {
    const bare = roundsWithImages([]).map((round) => ({
      ...round,
      answers: round.answers.map(({ attachments: _drop, ...answer }) => answer),
    }));
    expect(formatInterrogationTranscript("brief", bare)).not.toContain(
      "images:",
    );
    expect(interrogationTranscriptKey("brief", bare)).toBe(
      JSON.stringify({
        brief: "brief",
        rounds: [
          {
            questions: bare[0]!.questions.map(
              ({ branchId, prompt, recommendation }) => ({
                branchId,
                prompt,
                recommendation,
              }),
            ),
            answers: bare[0]!.answers.map(({ questionId, value }) => ({
              questionId,
              value,
            })),
          },
        ],
      }),
    );
  });

  it("changes the idempotency key when a different picture is attached", () => {
    const one = interrogationTranscriptKey(
      "brief",
      roundsWithImages([artifact("aaa")]),
    );
    const other = interrogationTranscriptKey(
      "brief",
      roundsWithImages([artifact("ccc")]),
    );
    expect(one).not.toBe(other);
    /* Identity is the bytes, never the per-run artifact id. */
    expect(one).toContain(artifact("aaa").sha256);
    expect(one).not.toContain(artifact("aaa").artifactId);
  });
});

describe("attachmentFrames", () => {
  it("loads the stored bytes under the caller's label", async () => {
    const { repository, context } = createHarness();
    const stored = await storeImageAttachment({
      repository,
      projectId: context.projectId,
      dataUrl: await swatch({ r: 47, g: 208, b: 197 }),
    });
    const frames = attachmentFrames(repository, [
      { label: "A1.1", artifact: stored },
    ]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.label).toBe("A1.1");
    expect(frames[0]!.mediaType).toBe("image/png");
    expect(frames[0]!.bytes.byteLength).toBe(stored.byteLength);
  });
});

/* ---------- the end-to-end live routes ---------- */

type VisionCall = {
  frames: Array<{ label: string; bytes: Uint8Array }>;
  prompt: string;
};

const recordingExecution = (turns: unknown[]) => {
  const textPrompts: string[] = [];
  const visionCalls: VisionCall[] = [];
  const answer = (schema: { safeParse: (value: unknown) => unknown }) => {
    const next = turns.shift();
    if (next === undefined) throw new Error("Scripted execution is exhausted.");
    const parsed = schema.safeParse(next) as
      { success: true; data: unknown } | { success: false };
    if (!parsed.success)
      throw new Error(
        "The selected execution provider returned no valid structured result.",
      );
    return { value: parsed.data, model: "fake-m1-text" };
  };
  const execution = {
    textPrompts,
    visionCalls,
    generateStructured: (async (input: {
      provider: string;
      prompt: string;
      schema: { safeParse: (value: unknown) => unknown };
    }) => {
      textPrompts.push(input.prompt);
      return { ...answer(input.schema), provider: input.provider };
    }) as StructuredModelExecution["generateStructured"],
    generateStructuredVision: (async (input: {
      provider: string;
      prompt: string;
      frames: Array<{ label: string; bytes: Uint8Array }>;
      schema: { safeParse: (value: unknown) => unknown };
    }) => {
      visionCalls.push({ frames: input.frames, prompt: input.prompt });
      return { ...answer(input.schema), provider: input.provider };
    }) as NonNullable<StructuredModelExecution["generateStructuredVision"]>,
  };
  return execution;
};

const LIVE_BRIEF =
  "Design a strict top-down survival game where a lone storm keeper restores a beacon in a flooded arena; routes must remain readable while dense weather sells the danger.";

const firstRound = {
  questions: [
    {
      branchId: "experience.player-promise",
      prompt: "What accomplishment closes one successful keeper session?",
      recommendation: "Name one observable rescue.",
    },
    {
      branchId: "gameplay.core-loop",
      prompt: "Which actions form the smallest flooded-arena loop?",
      recommendation: "Choose three to five actions.",
    },
  ],
};

const answerWithImage = async (orchestratorProvider: "openai" | "claude") => {
  const { repository, context } = createHarness();
  const execution = recordingExecution([
    firstRound,
    { understandingComplete: true, questions: [] },
  ]);
  const creative = new M1CreativeDevelopment(repository, undefined, execution);
  const routing = { mode: "live" as const, orchestratorProvider };
  const started = await creative.beginInterrogation({
    ...context,
    ...routing,
    brief: LIVE_BRIEF,
  });
  const state = InterrogationStateSchema.parse(
    repository.resolveRevision(started.interrogation),
  );
  const pasted = await storeImageAttachment({
    repository,
    projectId: context.projectId,
    dataUrl: await swatch({ r: 255, g: 201, b: 74 }),
  });
  const next = await creative.answerCurrentFrontier({
    ...context,
    ...routing,
    brief: LIVE_BRIEF,
    interrogation: started.interrogation,
    roundId: state.rounds[0]!.roundId,
    answers: state.frontier.map((question, index) => ({
      questionId: question.questionId,
      value: `Answer ${index + 1}`,
      ...(index === 1 ? { attachments: [pasted] } : {}),
    })),
  });
  return {
    execution,
    pasted,
    recorded: InterrogationStateSchema.parse(repository.resolveRevision(next)),
    repository,
    projectId: context.projectId,
  };
};

describe("live interrogation attachments", () => {
  it("sends the picture to a vision-capable orchestrator and records it on the answer", async () => {
    const { execution, pasted, recorded } = await answerWithImage("openai");
    expect(execution.visionCalls).toHaveLength(1);
    const call = execution.visionCalls[0]!;
    expect(call.frames.map((frame) => frame.label)).toEqual(["A2.1"]);
    expect(call.frames[0]!.bytes.byteLength).toBe(pasted.byteLength);
    expect(call.prompt).toContain('supplied to you as "A2.1"');
    const answered = recorded.rounds[0]!.answers.find(
      (entry) => (entry.attachments?.length ?? 0) > 0,
    );
    expect(answered?.attachments?.[0]?.sha256).toBe(pasted.sha256);
  });

  it("keeps the picture but never claims a text-only route read it", async () => {
    const { execution, pasted, recorded } = await answerWithImage("claude");
    expect(execution.visionCalls).toHaveLength(0);
    /* The first prompt is the opening round; the second is the one carrying
       the answered round back to the model. */
    const prompt = execution.textPrompts.at(-1)!;
    expect(prompt).toContain("not available to you on this route");
    expect(prompt).not.toContain("A2.1");
    const answered = recorded.rounds[0]!.answers.find(
      (entry) => (entry.attachments?.length ?? 0) > 0,
    );
    expect(answered?.attachments?.[0]?.sha256).toBe(pasted.sha256);
  });

  it("records on the submission whether the images reached the model", async () => {
    for (const [provider, delivered] of [
      ["openai", true],
      ["claude", false],
    ] as const) {
      const { repository, projectId } = await answerWithImage(provider);
      const completed = repository
        .listEvents(projectId)
        .filter((entry) => entry.type === "m1-interrogation-round.completed");
      expect(completed.at(-1)?.payload).toMatchObject({
        attachmentCount: 1,
        attachmentsDelivered: delivered,
      });
    }
  });
});
