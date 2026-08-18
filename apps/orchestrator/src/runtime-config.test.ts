import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeEnvironment } from "./runtime-config.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("orchestrator runtime configuration", () => {
  it("loads the repository environment when launched from its package", () => {
    const repositoryRoot = mkdtempSync(
      path.join(tmpdir(), "fulcrum-runtime-config-"),
    );
    temporaryRoots.push(repositoryRoot);
    const packageDirectory = path.join(
      repositoryRoot,
      "apps",
      "orchestrator",
      "src",
    );
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(path.join(repositoryRoot, "pnpm-workspace.yaml"), "");
    writeFileSync(
      path.join(repositoryRoot, ".env"),
      [
        "FULCRUM_PROVIDER_MODE=live",
        "MESHY_API_KEY=test-key",
        "FULCRUM_MESHY_MODEL=meshy-6",
        "FULCRUM_M0_BUDGET_USD=1.20",
      ].join("\n"),
    );
    const environment: NodeJS.ProcessEnv = {};

    const runtime = loadRuntimeEnvironment(packageDirectory, environment);

    expect(runtime.repositoryRoot).toBe(repositoryRoot);
    expect(runtime.workspaceRoot).toBe(path.join(repositoryRoot, "workspace"));
    expect(environment.FULCRUM_PROVIDER_MODE).toBe("live");
    expect(environment.MESHY_API_KEY).toBe("test-key");
    expect(environment.FULCRUM_MESHY_MODEL).toBe("meshy-6");
    expect(environment.FULCRUM_M0_BUDGET_USD).toBe("1.20");
  });
});
