import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BlenderLocalRigRunner,
  LOCAL_RIG_OUTPUT_MIN_BYTES,
  type LocalRigJobState,
} from "./local-rig.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const prepareRunner = (blenderBody: string, timeoutMs = 2_000) => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-rig-runner-test-"));
  roots.push(root);
  const library = path.join(root, "rigging");
  const blender = path.join(root, "blender");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    archetypes: {
      biped: {
        script: "biped.py",
        description: "Fixture biped",
        provenance: "Fixture",
      },
    },
  });
  mkdirSync(library);
  writeFileSync(path.join(library, "manifest.json"), manifest);
  writeFileSync(path.join(library, "biped.py"), "# fixture\n");
  writeFileSync(blender, `#!/usr/bin/env bash\nset -eu\n${blenderBody}\n`);
  chmodSync(blender, 0o755);
  return new BlenderLocalRigRunner({
    blenderBin: blender,
    rigLibraryDir: library,
    timeoutMs,
  });
};

const terminalState = async (
  runner: BlenderLocalRigRunner,
  jobId: string,
): Promise<Exclude<LocalRigJobState, { status: "running" }>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await runner.inspect(jobId);
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The fake Blender process did not finish.");
};

describe("BlenderLocalRigRunner", () => {
  it("returns a manifest-selected GLB and captures Blender diagnostics", async () => {
    const runner = prepareRunner(
      `printf 'rig complete\\n'\nprintf 'minor warning\\n' >&2\nhead -c ${LOCAL_RIG_OUTPUT_MIN_BYTES + 1} /dev/zero > "$6"`,
    );
    const started = await runner.start({
      sourceGlb: new Uint8Array([1, 2, 3]),
    });

    expect(started.archetype).toBe("biped");
    const state = await terminalState(runner, started.jobId);
    expect(state).toMatchObject({
      status: "succeeded",
      stdout: "rig complete\n",
      stderr: "minor warning\n",
      outputGlb: { byteLength: LOCAL_RIG_OUTPUT_MIN_BYTES + 1 },
    });
    await runner.dispose(started.jobId);
  });

  it("rejects a Blender output at or below the sanity floor", async () => {
    const runner = prepareRunner(
      `head -c ${LOCAL_RIG_OUTPUT_MIN_BYTES} /dev/zero > "$6"`,
    );
    const started = await runner.start({ sourceGlb: new Uint8Array([1]) });

    await expect(terminalState(runner, started.jobId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/must exceed 4096 bytes/),
    });
    await runner.dispose(started.jobId);
  });

  it("terminates Blender when the hard timeout expires", async () => {
    const runner = prepareRunner("exec sleep 5", 20);
    const started = await runner.start({ sourceGlb: new Uint8Array([1]) });

    await expect(terminalState(runner, started.jobId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/exceeded.*local rig timeout/),
    });
    await runner.dispose(started.jobId);
  });
});
