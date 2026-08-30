import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const LocalRigManifestSchema = z.object({
  schemaVersion: z.literal(1),
  archetypes: z.record(
    z.string().min(1),
    z.object({
      script: z.string().min(1),
      description: z.string().min(1),
      provenance: z.string().min(1),
    }),
  ),
});

export const LOCAL_RIG_OUTPUT_MIN_BYTES = 4 * 1024;
export const LOCAL_RIG_TIMEOUT_MS = 10 * 60 * 1_000;

const MAX_DIAGNOSTIC_CHARS = 32_000;
const DEFAULT_BLENDER_BIN = "/snap/bin/blender";
const DEFAULT_RIG_LIBRARY_DIR = fileURLToPath(
  new URL("../../../tools/rigging", import.meta.url),
);

export type LocalRigStartInput = {
  sourceGlb: Uint8Array;
  /** Omit to select the manifest's default biped rig. */
  archetype?: string | undefined;
};

export type LocalRigStartedJob = {
  jobId: string;
  archetype: string;
};

export type LocalRigJobState =
  | { status: "running"; progress: number }
  | {
      status: "succeeded";
      outputGlb: Uint8Array;
      stdout: string;
      stderr: string;
    }
  | { status: "failed"; error: string; stdout: string; stderr: string };

/**
 * The lifecycle owns durable job metadata; this seam owns the operating-system
 * process. Tests and replay worlds inject a deterministic implementation.
 */
export interface LocalRigRunner {
  start(input: LocalRigStartInput): Promise<LocalRigStartedJob>;
  inspect(jobId: string): Promise<LocalRigJobState>;
  dispose?(jobId: string): Promise<void>;
}

export type BlenderLocalRigRunnerOptions = {
  blenderBin?: string;
  rigLibraryDir?: string;
  timeoutMs?: number;
};

type MutableDiagnostics = { stdout: string; stderr: string };

type TrackedLocalRigJob = {
  process: ChildProcessWithoutNullStreams;
  workDir: string;
  outputPath: string;
  diagnostics: MutableDiagnostics;
  result: LocalRigJobState;
  timedOut: boolean;
  timeout: NodeJS.Timeout;
  killTimeout?: NodeJS.Timeout;
};

const appendDiagnostic = (current: string, chunk: Buffer): string => {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_DIAGNOSTIC_CHARS
    ? next
    : next.slice(next.length - MAX_DIAGNOSTIC_CHARS);
};

const diagnosticsSuffix = ({ stdout, stderr }: MutableDiagnostics): string => {
  const parts = [
    stdout.trim() ? `stdout:\n${stdout.trim()}` : undefined,
    stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
};

/** Launches Blender and returns as soon as the child process is running. */
export class BlenderLocalRigRunner implements LocalRigRunner {
  private readonly jobs = new Map<string, TrackedLocalRigJob>();
  private readonly blenderBin: string;
  private readonly rigLibraryDir: string;
  private readonly timeoutMs: number;

  constructor(options: BlenderLocalRigRunnerOptions = {}) {
    this.blenderBin =
      options.blenderBin ?? process.env.BLENDER_BIN ?? DEFAULT_BLENDER_BIN;
    this.rigLibraryDir = options.rigLibraryDir ?? DEFAULT_RIG_LIBRARY_DIR;
    this.timeoutMs = options.timeoutMs ?? LOCAL_RIG_TIMEOUT_MS;
  }

  async start(input: LocalRigStartInput): Promise<LocalRigStartedJob> {
    const manifest = LocalRigManifestSchema.parse(
      JSON.parse(
        await readFile(path.join(this.rigLibraryDir, "manifest.json"), "utf8"),
      ),
    );
    const archetype = input.archetype ?? "biped";
    const definition = manifest.archetypes[archetype];
    if (!definition)
      throw new Error(
        `Local rig archetype ${archetype} is not present in tools/rigging/manifest.json.`,
      );

    const scriptPath = path.resolve(this.rigLibraryDir, definition.script);
    const relativeScript = path.relative(this.rigLibraryDir, scriptPath);
    if (relativeScript.startsWith("..") || path.isAbsolute(relativeScript))
      throw new Error(
        `Local rig archetype ${archetype} points outside the rigging library.`,
      );

    const jobId = randomUUID();
    const workDir = await mkdtemp(path.join(tmpdir(), "fulcrum-local-rig-"));
    const sourcePath = path.join(workDir, "source.glb");
    const outputPath = path.join(workDir, "rigged.glb");
    const blendPath = path.join(workDir, "rigged.blend");
    await writeFile(sourcePath, input.sourceGlb);

    const child = spawn(
      this.blenderBin,
      [
        "--background",
        "--python",
        scriptPath,
        "--",
        sourcePath,
        outputPath,
        blendPath,
      ],
      { cwd: workDir, stdio: "pipe" },
    );
    const diagnostics: MutableDiagnostics = { stdout: "", stderr: "" };
    const tracked = {} as TrackedLocalRigJob;
    Object.assign(tracked, {
      process: child,
      workDir,
      outputPath,
      diagnostics,
      result: { status: "running", progress: 10 },
      timedOut: false,
      timeout: setTimeout(() => {
        tracked.timedOut = true;
        child.kill("SIGTERM");
        tracked.killTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, this.timeoutMs),
    } satisfies TrackedLocalRigJob);
    tracked.timeout.unref();
    this.jobs.set(jobId, tracked);

    child.stdout.on("data", (chunk: Buffer) => {
      diagnostics.stdout = appendDiagnostic(diagnostics.stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics.stderr = appendDiagnostic(diagnostics.stderr, chunk);
    });
    child.once("error", (error) => {
      this.fail(tracked, `Blender could not start: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      void this.finish(tracked, code, signal);
    });

    return { jobId, archetype };
  }

  async inspect(jobId: string): Promise<LocalRigJobState> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Local rig job ${jobId} is not available.`);
    return job.result;
  }

  async dispose(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    clearTimeout(job.timeout);
    if (job.killTimeout) clearTimeout(job.killTimeout);
    if (job.result.status === "running") job.process.kill("SIGKILL");
    this.jobs.delete(jobId);
    await rm(job.workDir, { recursive: true, force: true });
  }

  private fail(job: TrackedLocalRigJob, message: string): void {
    if (job.result.status !== "running") return;
    clearTimeout(job.timeout);
    if (job.killTimeout) clearTimeout(job.killTimeout);
    job.result = {
      status: "failed",
      error: `${message}${diagnosticsSuffix(job.diagnostics)}`,
      ...job.diagnostics,
    };
  }

  private async finish(
    job: TrackedLocalRigJob,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (job.result.status !== "running") return;
    clearTimeout(job.timeout);
    if (job.killTimeout) clearTimeout(job.killTimeout);
    if (job.timedOut) {
      this.fail(
        job,
        `Blender exceeded the ${Math.round(this.timeoutMs / 60_000)} minute local rig timeout.`,
      );
      return;
    }
    if (code !== 0) {
      this.fail(
        job,
        `Blender exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}.`,
      );
      return;
    }
    try {
      const outputGlb = new Uint8Array(await readFile(job.outputPath));
      if (outputGlb.byteLength <= LOCAL_RIG_OUTPUT_MIN_BYTES)
        throw new Error(
          `Blender produced ${outputGlb.byteLength} bytes; a local rig GLB must exceed ${LOCAL_RIG_OUTPUT_MIN_BYTES} bytes.`,
        );
      job.result = {
        status: "succeeded",
        outputGlb,
        ...job.diagnostics,
      };
    } catch (error) {
      this.fail(
        job,
        error instanceof Error
          ? error.message
          : "Blender did not produce a readable rigged GLB.",
      );
    }
  }
}
