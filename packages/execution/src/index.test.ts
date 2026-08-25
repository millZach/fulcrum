import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  assertStrictCompatibleJsonSchema,
  createCodexSubscriptionImageRunner,
  DEFAULT_OPENAI_API_MODEL,
  ModelExecution,
  preferredOpenAIImageProvider,
  preferredOpenAIProvider,
  preferredVisionProvider,
  type CommandSpec,
  type CommandRunner,
  type ExecutionProviderStatus,
} from "./index.js";

const ResultSchema = z.object({ name: z.string(), count: z.number().int() });

describe("OpenAI strict JSON Schema guard", () => {
  it("rejects z.record output", () => {
    expect(() =>
      assertStrictCompatibleJsonSchema(
        z.toJSONSchema(z.record(z.string(), z.string())),
      ),
    ).toThrow(/\$\.propertyNames: propertyNames is not permitted/);
  });

  it("rejects map-like output after propertyNames is removed", () => {
    const schema = z.toJSONSchema(z.record(z.string(), z.string()));
    delete schema.propertyNames;

    expect(() => assertStrictCompatibleJsonSchema(schema)).toThrow(
      /\$\.additionalProperties: map-like objects/,
    );
  });

  it("rejects an object with an optional field", () => {
    expect(() =>
      assertStrictCompatibleJsonSchema(
        z.toJSONSchema(z.object({ note: z.string().optional() })),
      ),
    ).toThrow(
      /\$\.required: every object with properties must supply required/,
    );
  });

  it("accepts nullable fields in place of optional fields", () => {
    expect(() =>
      assertStrictCompatibleJsonSchema(
        z.toJSONSchema(z.object({ note: z.string().nullable() })),
      ),
    ).not.toThrow();
  });

  it.each(["openai", "openai-api"] as const)(
    "fast-fails invalid %s schemas before provider execution",
    async (provider) => {
      const runner: CommandRunner = vi.fn();
      const api = vi.fn();

      await expect(
        new ModelExecution(runner, api).generateStructured({
          provider,
          cwd: process.cwd(),
          systemPrompt: "Return a note.",
          prompt: "A note is optional.",
          schema: z.object({ note: z.string().optional() }),
        }),
      ).rejects.toThrow(/OpenAI strict JSON Schema violation/);
      expect(runner).not.toHaveBeenCalled();
      expect(api).not.toHaveBeenCalled();
    },
  );

  it.each(["claude", "grok", "opencode"] as const)(
    "does not apply the OpenAI guard to %s",
    async (provider) => {
      const runner: CommandRunner = vi.fn(async ({ command }) => ({
        status: 0,
        stdout:
          command === "claude"
            ? JSON.stringify({ structured_output: {} })
            : JSON.stringify({}),
        stderr: "",
      }));

      await expect(
        new ModelExecution(runner).generateStructured({
          provider,
          cwd: process.cwd(),
          systemPrompt: "Return a note.",
          prompt: "A note is optional.",
          schema: z.object({ note: z.string().optional() }),
        }),
      ).resolves.toMatchObject({ value: {} });
      expect(runner).toHaveBeenCalledOnce();
    },
  );
});

const status = (
  provider: ExecutionProviderStatus["provider"],
  ready: boolean,
): ExecutionProviderStatus => ({
  provider,
  access: provider === "openai-api" ? "api" : "subscription",
  ready,
  installed: ready,
  authenticated: ready,
  capabilities: { imageGeneration: false },
  detail: ready ? "ready" : "not ready",
});

describe("ModelExecution", () => {
  it("normalizes Claude structured output behind one interface", async () => {
    const runner: CommandRunner = vi.fn(async () => ({
      status: 0,
      stdout: JSON.stringify({
        structured_output: { name: "reliquary", count: 1 },
      }),
      stderr: "",
    }));
    const result = await new ModelExecution(runner).generateStructured({
      provider: "claude",
      cwd: process.cwd(),
      systemPrompt: "Plan the asset.",
      prompt: "One hero prop.",
      schema: ResultSchema,
    });
    expect(result.value).toEqual({ name: "reliquary", count: 1 });
    expect(result.provider).toBe("claude");
  });

  it("uses Codex's schema and output files without exposing them to callers", async () => {
    const runner: CommandRunner = vi.fn(async ({ args }: CommandSpec) => {
      const outputIndex = args.indexOf("--output-last-message");
      const outputPath = args[outputIndex + 1];
      if (!outputPath) throw new Error("Missing Codex output path.");
      writeFileSync(outputPath, JSON.stringify({ name: "arena", count: 2 }));
      return { status: 0, stdout: "", stderr: "" };
    });
    const result = await new ModelExecution(runner).generateStructured({
      provider: "openai",
      cwd: process.cwd(),
      systemPrompt: "Plan the arena.",
      prompt: "Two landmarks.",
      schema: ResultSchema,
    });
    expect(result.value).toEqual({ name: "arena", count: 2 });
    expect(result.model).toBe("subscription-default");
  });

  it("removes only Claude's unsupported schema draft marker", async () => {
    let claudeSchema: unknown;
    let codexSchema: unknown;
    const runner: CommandRunner = vi.fn(async ({ command, args }) => {
      if (command === "claude") {
        const schemaIndex = args.indexOf("--json-schema");
        const schemaPayload = args[schemaIndex + 1];
        if (!schemaPayload) throw new Error("Missing Claude schema payload.");
        claudeSchema = JSON.parse(schemaPayload);
        return {
          status: 0,
          stdout: JSON.stringify({
            structured_output: { name: "reliquary", count: 1 },
          }),
          stderr: "",
        };
      }
      if (command === "codex") {
        const schemaIndex = args.indexOf("--output-schema");
        const schemaPath = args[schemaIndex + 1];
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = args[outputIndex + 1];
        if (!schemaPath || !outputPath)
          throw new Error("Missing Codex structured output paths.");
        codexSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
        writeFileSync(
          outputPath,
          JSON.stringify({ name: "reliquary", count: 1 }),
        );
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const execution = new ModelExecution(runner);

    await execution.generateStructured({
      provider: "claude",
      cwd: process.cwd(),
      systemPrompt: "Plan the asset.",
      prompt: "One hero prop.",
      schema: ResultSchema,
    });
    await execution.generateStructured({
      provider: "openai",
      cwd: process.cwd(),
      systemPrompt: "Plan the asset.",
      prompt: "One hero prop.",
      schema: ResultSchema,
    });

    const expectedCodexSchema = z.toJSONSchema(ResultSchema);
    const expectedClaudeSchema = { ...expectedCodexSchema };
    delete expectedClaudeSchema.$schema;
    expect(claudeSchema).toEqual(expectedClaudeSchema);
    expect(claudeSchema).not.toHaveProperty("$schema");
    expect(codexSchema).toEqual(expectedCodexSchema);
  });

  it("uses the OpenAI API adapter through the same structured interface", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const api = vi.fn(async () =>
      JSON.stringify({ name: "fallback", count: 3 }),
    );
    try {
      const result = await new ModelExecution(
        undefined,
        api,
      ).generateStructured({
        provider: "openai-api",
        cwd: process.cwd(),
        systemPrompt: "Plan safely.",
        prompt: "Use the fallback.",
        schema: ResultSchema,
      });
      expect(result.value).toEqual({ name: "fallback", count: 3 });
      expect(result.model).toBe(DEFAULT_OPENAI_API_MODEL);
      expect(api).toHaveBeenCalledOnce();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("structured vision execution", () => {
  const frames = [
    {
      label: "front",
      mediaType: "image/png" as const,
      bytes: Uint8Array.from([137, 80, 78, 71, 1]),
    },
    {
      label: "back",
      mediaType: "image/png" as const,
      bytes: Uint8Array.from([137, 80, 78, 71, 2]),
    },
  ];

  it("codex_runner_writes_frames_and_parses_strict_output", async () => {
    const runner: CommandRunner = vi.fn(async ({ args }: CommandSpec) => {
      const imagePaths = args.flatMap((argument, index) =>
        argument === "--image" && args[index + 1] ? [args[index + 1]!] : [],
      );
      expect(imagePaths.map((framePath) => readFileSync(framePath))).toEqual(
        frames.map((frame) => Buffer.from(frame.bytes)),
      );
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      if (!outputPath) throw new Error("Missing vision output path.");
      writeFileSync(
        outputPath,
        JSON.stringify({ name: "reliquary", count: 8 }),
      );
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await new ModelExecution(runner).generateStructuredVision({
      provider: "openai",
      cwd: process.cwd(),
      systemPrompt: "Judge only the supplied turntable.",
      prompt: "Evaluate the asset.",
      frames,
      schema: ResultSchema,
      idempotencyKey: "vision:asset-1",
    });

    expect(result).toMatchObject({
      value: { name: "reliquary", count: 8 },
      provider: "openai",
      model: "subscription-default",
    });
  });

  it("api_runner_sends_image_inputs_and_idempotency_key", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const api = vi.fn(async (input) => {
      expect(input.frames).toEqual(frames);
      expect(input.idempotencyKey).toBe("vision:asset-1");
      return JSON.stringify({ name: "reliquary", count: 8 });
    });
    try {
      const result = await new ModelExecution(
        undefined,
        api,
      ).generateStructuredVision({
        provider: "openai-api",
        cwd: process.cwd(),
        systemPrompt: "Judge only the supplied turntable.",
        prompt: "Evaluate the asset.",
        frames,
        schema: ResultSchema,
        idempotencyKey: "vision:asset-1",
      });

      expect(result.value).toEqual({ name: "reliquary", count: 8 });
      expect(api).toHaveBeenCalledOnce();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("preferred_route_uses_subscription_then_api", () => {
    expect(
      preferredVisionProvider([
        status("openai", true),
        status("openai-api", true),
      ]),
    ).toBe("openai");
    expect(
      preferredVisionProvider([
        status("openai", false),
        status("openai-api", true),
      ]),
    ).toBe("openai-api");
    expect(
      preferredVisionProvider([
        status("openai", false),
        status("openai-api", false),
      ]),
    ).toBeUndefined();
  });

  it("does_not_fallback_after_subscription_call_started", async () => {
    const runner: CommandRunner = vi.fn(async () => {
      throw new Error("Codex connection ended after submission.");
    });
    const api = vi.fn(async () =>
      JSON.stringify({ name: "should-not-run", count: 0 }),
    );

    await expect(
      new ModelExecution(runner, api).generateStructuredVision({
        provider: "openai",
        cwd: process.cwd(),
        systemPrompt: "Judge only the supplied turntable.",
        prompt: "Evaluate the asset.",
        frames,
        schema: ResultSchema,
        idempotencyKey: "vision:asset-1",
      }),
    ).rejects.toThrow(/connection ended/i);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("Codex subscription ImageGen", () => {
  it("keeps subscription image generation behind the image runner interface", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const runner: CommandRunner = vi.fn(async (spec) => {
      expect(spec.command).toBe("codex");
      expect(spec.args).toContain("image_generation");
      expect(spec.stdin).toContain("$imagegen");
      writeFileSync(path.join(spec.cwd, "concept.png"), png);
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await createCodexSubscriptionImageRunner(runner)({
      prompt: "A readable stone reliquary",
    });

    expect(result.bytes).toEqual(png);
    expect(result.model).toBe("gpt-image-2");
    expect(result.costUsd).toBe(0);
  });

  it("places edit targets inside the isolated ImageGen workspace", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const runner: CommandRunner = vi.fn(async (spec) => {
      const referencePath = path.join(spec.cwd, "reference-01.png");
      expect(readFileSync(referencePath)).toEqual(png);
      expect(spec.stdin).toContain(`Image 1 (edit target): ${referencePath}`);
      expect(spec.stdin).toContain("Use Image 1 as the edit target");
      writeFileSync(path.join(spec.cwd, "concept.png"), png);
      return { status: 0, stdout: "", stderr: "" };
    });

    await createCodexSubscriptionImageRunner(runner)({
      prompt: "Change only the coat silhouette.",
      referenceImages: [{ bytes: png, mediaType: "image/png" }],
    });
  });
});

describe("preferredOpenAIProvider", () => {
  it("prefers the signed-in OpenAI subscription", () => {
    expect(
      preferredOpenAIProvider([
        status("openai", true),
        status("openai-api", true),
      ]),
    ).toBe("openai");
  });

  it("falls back to OpenAI API when the subscription is unavailable", () => {
    expect(
      preferredOpenAIProvider([
        status("openai", false),
        status("openai-api", false),
      ]),
    ).toBe("openai-api");
  });

  it("prefers subscription ImageGen when Codex advertises the capability", () => {
    const openAI = status("openai", true);
    openAI.capabilities.imageGeneration = true;
    expect(preferredOpenAIImageProvider([openAI])).toBe("openai-subscription");
  });

  it("falls back to GPT Image 2 API without subscription ImageGen", () => {
    expect(preferredOpenAIImageProvider([status("openai", false)])).toBe(
      "openai-gpt-image-2",
    );
  });
});
