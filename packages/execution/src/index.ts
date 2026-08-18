import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ExecutionProvider,
  ExecutionProviderSchema,
  type ImageProvider,
} from "@fulcrum/domain";
import OpenAI from "openai";
import { z } from "zod";

export type ExecutionProviderStatus = {
  provider: ExecutionProvider;
  access: "subscription" | "api";
  ready: boolean;
  installed: boolean;
  authenticated: boolean;
  capabilities: {
    imageGeneration: boolean;
  };
  detail: string;
};

export type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
};

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

export type OpenAIApiRunner = (input: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
}) => Promise<string>;

export type SubscriptionImageResult = {
  bytes: Uint8Array;
  model: string;
  costUsd: number;
};

export type SubscriptionImageRunner = (input: {
  prompt: string;
}) => Promise<SubscriptionImageResult>;

export const DEFAULT_OPENAI_API_MODEL = "gpt-5.6-terra";

type ResolvedCommand = { executable: string; prefix: string[] };

const providerCommand: Partial<Record<ExecutionProvider, string>> = {
  claude: "claude",
  openai: "codex",
  grok: "grok",
  opencode: "opencode",
};

const unwrapNpmLauncher = (launcher: string): ResolvedCommand | undefined => {
  try {
    const contents = readFileSync(launcher, "utf8");
    const match = /%dp0%\\([^"\r\n]+\.js)/i.exec(contents);
    if (!match?.[1]) return undefined;
    const script = path.resolve(path.dirname(launcher), match[1]);
    return { executable: process.execPath, prefix: [script] };
  } catch {
    return undefined;
  }
};

const resolveCommand = (command: string): ResolvedCommand | undefined => {
  const lookup =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], {
          encoding: "utf8",
          windowsHide: true,
        })
      : spawnSync("which", [command], { encoding: "utf8" });
  if (lookup.status !== 0 || !lookup.stdout) return undefined;
  const candidates = lookup.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (/\.cmd$/i.test(candidate)) {
      const unwrapped = unwrapNpmLauncher(candidate);
      if (unwrapped) return unwrapped;
      continue;
    }
    if (process.platform !== "win32" || /\.(?:exe|com)$/i.test(candidate)) {
      return { executable: candidate, prefix: [] };
    }
  }
  return undefined;
};

const runResolvedSync = (
  command: ResolvedCommand,
  args: string[],
): CommandResult => {
  const result = spawnSync(command.executable, [...command.prefix, ...args], {
    encoding: "utf8",
    timeout: 4_000,
    windowsHide: true,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
};

const statusFor = (provider: ExecutionProvider): ExecutionProviderStatus => {
  if (provider === "openai-api") {
    const missingConfiguration = ["OPENAI_API_KEY"].filter(
      (name) => !process.env[name],
    );
    const model =
      process.env.FULCRUM_OPENAI_API_MODEL ?? DEFAULT_OPENAI_API_MODEL;
    return {
      provider,
      access: "api",
      ready: missingConfiguration.length === 0,
      installed: true,
      authenticated: Boolean(process.env.OPENAI_API_KEY),
      capabilities: {
        imageGeneration: Boolean(process.env.OPENAI_API_KEY),
      },
      detail:
        missingConfiguration.length === 0
          ? `OpenAI API · ${model}`
          : `OpenAI API fallback needs ${missingConfiguration.join(" · ")}`,
    };
  }
  const commandName = providerCommand[provider];
  if (!commandName) throw new Error(`Unknown execution provider: ${provider}`);
  const command = resolveCommand(commandName);
  if (!command) {
    return {
      provider,
      access: "subscription",
      ready: false,
      installed: false,
      authenticated: false,
      capabilities: { imageGeneration: false },
      detail: `${commandName} client is not installed`,
    };
  }
  let result: CommandResult;
  let authenticated = false;
  let imageGeneration = false;
  switch (provider) {
    case "claude": {
      result = runResolvedSync(command, ["auth", "status"]);
      try {
        authenticated =
          result.status === 0 &&
          z.object({ loggedIn: z.boolean() }).parse(JSON.parse(result.stdout))
            .loggedIn;
      } catch {
        authenticated = false;
      }
      break;
    }
    case "openai":
      result = runResolvedSync(command, ["login", "status"]);
      authenticated =
        result.status === 0 &&
        /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`);
      if (authenticated) {
        const features = runResolvedSync(command, ["features", "list"]);
        imageGeneration =
          features.status === 0 &&
          /^image_generation\s+\S+\s+true\s*$/im.test(features.stdout);
      }
      break;
    case "grok":
      result = runResolvedSync(command, ["models"]);
      authenticated = result.status === 0 && result.stdout.trim().length > 0;
      break;
    case "opencode":
      result = runResolvedSync(command, ["auth", "list"]);
      const authOutput = `${result.stdout}\n${result.stderr}`.trim();
      authenticated =
        result.status === 0 &&
        authOutput.length > 0 &&
        !/(?:0 credentials|no credentials|not connected)/i.test(authOutput);
      break;
  }
  return {
    provider,
    access: "subscription",
    ready: authenticated,
    installed: true,
    authenticated,
    capabilities: { imageGeneration },
    detail: authenticated
      ? "Subscription client is signed in"
      : `Run ${commandName} and sign in to your subscription`,
  };
};

export const inspectExecutionProviders = (): ExecutionProviderStatus[] =>
  ExecutionProviderSchema.options.map(statusFor);

export const preferredOpenAIProvider = (
  providers: ExecutionProviderStatus[],
): ExecutionProvider =>
  providers.find(({ provider }) => provider === "openai")?.ready
    ? "openai"
    : "openai-api";

export const preferredOpenAIImageProvider = (
  providers: ExecutionProviderStatus[],
): ImageProvider => {
  const subscription = providers.find(({ provider }) => provider === "openai");
  return subscription?.ready && subscription.capabilities.imageGeneration
    ? "openai-subscription"
    : "openai-gpt-image-2";
};

export const runCommand: CommandRunner = async (spec) => {
  const resolved = resolveCommand(spec.command);
  if (!resolved) throw new Error(`${spec.command} is not installed.`);
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(
      resolved.executable,
      [...resolved.prefix, ...spec.args],
      {
        cwd: spec.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${spec.command} timed out.`));
    }, spec.timeoutMs ?? 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    child.stdin.end(spec.stdin);
  });
};

const imageBytesFromOutput = (output: string): Uint8Array | undefined => {
  const dataUrl = /data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)/i.exec(
    output,
  )?.[1];
  if (dataUrl) return Buffer.from(dataUrl, "base64");

  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    try {
      const roots: unknown[] = [JSON.parse(line)];
      while (roots.length > 0) {
        const value = roots.pop();
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) {
          roots.push(...value);
          continue;
        }
        const record = value as Record<string, unknown>;
        if (
          record.type === "image" &&
          typeof record.data === "string" &&
          record.data.length > 50
        ) {
          return Buffer.from(record.data, "base64");
        }
        roots.push(...Object.values(record));
      }
    } catch {
      // Human-readable progress lines are intentionally ignored.
    }
  }
  return undefined;
};

export const createCodexSubscriptionImageRunner =
  (runner: CommandRunner = runCommand): SubscriptionImageRunner =>
  async ({ prompt }) => {
    const temporary = mkdtempSync(path.join(tmpdir(), "fulcrum-imagegen-"));
    const outputPath = path.join(temporary, "concept.png");
    try {
      const result = await runner({
        command: "codex",
        args: [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--enable",
          "image_generation",
          "--json",
          "--color",
          "never",
          "-",
        ],
        cwd: temporary,
        timeoutMs: 360_000,
        stdin: [
          "Use the installed $imagegen skill and its ImageGen tool.",
          "Generate exactly one square 1024x1024 production concept image from the prompt below.",
          `Save or copy the final image as a PNG at this exact path: ${outputPath}`,
          "Use the signed-in OpenAI subscription. Do not call an API endpoint directly and do not read API keys.",
          "Do not create any other files or implement code.",
          "Prompt:",
          prompt,
        ].join("\n\n"),
      });
      if (result.status !== 0) {
        throw new Error(
          result.stderr.trim() || "Codex ImageGen execution failed.",
        );
      }
      const bytes = existsSync(outputPath)
        ? readFileSync(outputPath)
        : imageBytesFromOutput(result.stdout);
      if (!bytes || bytes.byteLength < 50) {
        throw new Error(
          "Codex ImageGen completed without a readable image. Update Codex or select the OpenAI API image route.",
        );
      }
      return { bytes, model: "gpt-image-2", costUsd: 0 };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  };

export const runCodexSubscriptionImage = createCodexSubscriptionImageRunner();

export const runOpenAIApi: OpenAIApiRunner = async (input) => {
  const client = new OpenAI({ apiKey: input.apiKey });
  const response = await client.responses.create({
    model: input.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.prompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "fulcrum_structured_output",
        schema: input.jsonSchema,
        strict: true,
      },
    },
  });
  if (!response.output_text)
    throw new Error("OpenAI API returned no structured output.");
  return response.output_text;
};

const parseJsonString = (value: string): unknown => {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
};

const candidatesFrom = (value: unknown): unknown[] => {
  const candidates: unknown[] = [value];
  if (typeof value === "string") {
    try {
      candidates.push(parseJsonString(value));
    } catch {
      return candidates;
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "structured_output",
      "structuredOutput",
      "result",
      "output",
      "text",
      "content",
      "message",
      "part",
    ]) {
      if (record[key] !== undefined)
        candidates.push(...candidatesFrom(record[key]));
    }
  }
  return candidates;
};

const parseStructured = <T>(raw: string, schema: z.ZodType<T>): T => {
  const roots: unknown[] = [];
  try {
    roots.push(parseJsonString(raw));
  } catch {
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        roots.push(parseJsonString(line));
      } catch {
        // Non-JSON progress output is intentionally ignored.
      }
    }
  }
  for (const root of roots.reverse()) {
    for (const candidate of candidatesFrom(root)) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
  }
  throw new Error(
    "The selected execution provider returned no valid structured result.",
  );
};

export class ModelExecution {
  constructor(
    private readonly runner: CommandRunner = runCommand,
    private readonly openAIApi: OpenAIApiRunner = runOpenAIApi,
  ) {}

  async generateStructured<T>(input: {
    provider: ExecutionProvider;
    model?: string;
    cwd: string;
    systemPrompt: string;
    prompt: string;
    schema: z.ZodType<T>;
  }): Promise<{ value: T; provider: ExecutionProvider; model: string }> {
    const provider = ExecutionProviderSchema.parse(input.provider);
    if (input.model && !/^[a-zA-Z0-9._:/#-]+$/.test(input.model))
      throw new Error(
        "Execution model identifiers contain invalid characters.",
      );
    const jsonSchema = z.toJSONSchema(input.schema);
    const prompt = [
      input.systemPrompt,
      input.prompt,
      "Return only a JSON value matching this JSON Schema:",
      JSON.stringify(jsonSchema),
    ].join("\n\n");
    let raw = "";
    if (provider === "openai-api") {
      const apiKey = process.env.OPENAI_API_KEY;
      const model =
        input.model ??
        process.env.FULCRUM_OPENAI_API_MODEL ??
        DEFAULT_OPENAI_API_MODEL;
      if (!apiKey)
        throw new Error("OpenAI API execution requires OPENAI_API_KEY.");
      raw = await this.openAIApi({
        apiKey,
        model,
        systemPrompt: input.systemPrompt,
        prompt: input.prompt,
        jsonSchema,
      });
      return {
        value: parseStructured(raw, input.schema),
        provider,
        model,
      };
    } else if (provider === "claude") {
      const result = await this.runner({
        command: "claude",
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(jsonSchema),
          "--no-session-persistence",
          "--tools",
          "",
          ...(input.model ? ["--model", input.model] : []),
        ],
        cwd: input.cwd,
        stdin: prompt,
      });
      if (result.status !== 0)
        throw new Error(result.stderr.trim() || "Claude execution failed.");
      raw = result.stdout;
    } else if (provider === "openai") {
      const temporary = mkdtempSync(path.join(tmpdir(), "fulcrum-codex-"));
      const schemaPath = path.join(temporary, "schema.json");
      const outputPath = path.join(temporary, "result.json");
      writeFileSync(schemaPath, JSON.stringify(jsonSchema));
      try {
        const result = await this.runner({
          command: "codex",
          args: [
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            "--color",
            "never",
            ...(input.model ? ["--model", input.model] : []),
            "-",
          ],
          cwd: input.cwd,
          stdin: prompt,
        });
        if (result.status !== 0)
          throw new Error(result.stderr.trim() || "Codex execution failed.");
        raw = readFileSync(outputPath, "utf8");
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    } else if (provider === "grok") {
      const result = await this.runner({
        command: "grok",
        args: [
          "--no-auto-update",
          "-p",
          prompt,
          "--output-format",
          "json",
          "--sandbox",
          "read-only",
          "--no-subagents",
          "--max-turns",
          "1",
          ...(input.model ? ["--model", input.model] : []),
        ],
        cwd: input.cwd,
      });
      if (result.status !== 0)
        throw new Error(result.stderr.trim() || "Grok execution failed.");
      raw = result.stdout;
    } else {
      const result = await this.runner({
        command: "opencode",
        args: [
          "run",
          "--format",
          "json",
          "--dir",
          input.cwd,
          ...(input.model ? ["--model", input.model] : []),
          prompt,
        ],
        cwd: input.cwd,
      });
      if (result.status !== 0)
        throw new Error(result.stderr.trim() || "OpenCode execution failed.");
      raw = result.stdout;
    }
    return {
      value: parseStructured(raw, input.schema),
      provider,
      model: input.model ?? "subscription-default",
    };
  }
}
