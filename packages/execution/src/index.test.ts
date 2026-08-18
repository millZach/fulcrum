import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCodexSubscriptionImageRunner,
  DEFAULT_OPENAI_API_MODEL,
  ModelExecution,
  preferredOpenAIImageProvider,
  preferredOpenAIProvider,
  type CommandRunner,
  type ExecutionProviderStatus,
} from "./index.js";

const ResultSchema = z.object({ name: z.string(), count: z.number().int() });

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
    const runner: CommandRunner = vi.fn(async ({ args }) => {
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
});

describe("preferredOpenAIProvider", () => {
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
