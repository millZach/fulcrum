import { existsSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";

const findRepositoryRoot = (startDirectory: string): string => {
  let current = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error(
        `Could not locate the Fulcrum repository above ${startDirectory}.`,
      );
    current = parent;
  }
};

export const loadRuntimeEnvironment = (
  startDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): { repositoryRoot: string; workspaceRoot: string } => {
  const repositoryRoot = findRepositoryRoot(startDirectory);
  const environmentPath = path.join(repositoryRoot, ".env");
  if (existsSync(environmentPath))
    config({ path: environmentPath, processEnv: environment, quiet: true });
  const workspaceRoot = path.resolve(
    repositoryRoot,
    environment.FULCRUM_WORKSPACE_ROOT ?? "workspace",
  );
  return { repositoryRoot, workspaceRoot };
};
