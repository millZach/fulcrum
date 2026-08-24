import { describe, expect, it } from "vitest";

import {
  CreateProjectInputSchema,
  ProjectStateSchema,
  hasMeteredRoutes,
} from "./index.js";

const brief =
  "Create a compact lunar greenhouse stealth game with one creature and one readable escape route.";

describe("metered project routing", () => {
  it("allows M1 subscription and replay projects to omit budgetUsd", () => {
    const subscription = CreateProjectInputSchema.parse({
      milestone: "m1",
      brief,
      mode: "live",
      orchestratorProvider: "openai",
      implementationProvider: "openai",
      imageProvider: "openai-subscription",
      soundProvider: "none",
      rightsConfirmed: true,
    });
    const replay = CreateProjectInputSchema.parse({
      milestone: "m1",
      brief,
      mode: "replay",
      imageProvider: "none",
      rightsConfirmed: true,
    });

    expect(subscription.budgetUsd).toBeUndefined();
    expect(replay.budgetUsd).toBeUndefined();
    expect(hasMeteredRoutes(subscription)).toBe(false);
    expect(hasMeteredRoutes(replay)).toBe(false);
  });

  it.each([
    { orchestratorProvider: "openai-api" as const },
    { implementationProvider: "openai-api" as const },
    { imageProvider: "openai-gpt-image-2" as const },
    { soundProvider: "elevenlabs" as const },
  ])("requires budgetUsd for live metered selection %#", (route) => {
    const input = {
      milestone: "m1" as const,
      brief,
      mode: "live" as const,
      orchestratorProvider: "openai" as const,
      implementationProvider: "openai" as const,
      imageProvider: "openai-subscription" as const,
      soundProvider: "none" as const,
      rightsConfirmed: true as const,
      ...route,
    };

    expect(CreateProjectInputSchema.safeParse(input).success).toBe(false);
    expect(
      CreateProjectInputSchema.safeParse({ ...input, budgetUsd: 1 }).success,
    ).toBe(true);
  });

  it("keeps an old snapshot containing budgetUsd readable", () => {
    const createdAt = new Date().toISOString();
    const artifact = {
      artifactId: "artifact-1",
      sha256: "a".repeat(64),
      mediaType: "application/json",
      byteLength: 1,
      uri: "/api/artifacts/artifact-1",
    };
    const parsed = ProjectStateSchema.parse({
      schemaVersion: 1,
      milestone: "m1",
      projectId: "old-subscription-project",
      name: "Old subscription project",
      mode: "live",
      assetProvider: "meshy",
      orchestratorProvider: "openai",
      implementationProvider: "openai",
      imageProvider: "openai-subscription",
      soundProvider: "none",
      status: "awaiting-input",
      stage: "interrogation",
      runId: "run-1",
      budgetUsd: 1,
      spentUsd: 0,
      conceptReplacementCount: 0,
      brief: {
        entityId: "brief-1",
        revisionId: "revision-1",
        kind: "game-brief",
        artifact,
        createdAt,
        createdByRunId: "run-1",
      },
      createdAt,
      updatedAt: createdAt,
    });

    expect(parsed.budgetUsd).toBe(1);
    expect(hasMeteredRoutes(parsed)).toBe(false);
  });

  it("normalizes a new no-metered state without budgetUsd to zero", () => {
    const createdAt = new Date().toISOString();
    const parsed = ProjectStateSchema.parse({
      schemaVersion: 1,
      milestone: "m1",
      projectId: "new-replay-project",
      name: "New replay project",
      mode: "replay",
      status: "awaiting-input",
      stage: "interrogation",
      runId: "run-1",
      spentUsd: 0,
      brief: {
        entityId: "brief-1",
        revisionId: "revision-1",
        kind: "game-brief",
        artifact: {
          artifactId: "artifact-1",
          sha256: "a".repeat(64),
          mediaType: "application/json",
          byteLength: 1,
          uri: "/api/artifacts/artifact-1",
        },
        createdAt,
        createdByRunId: "run-1",
      },
      createdAt,
      updatedAt: createdAt,
    });

    expect(parsed.budgetUsd).toBe(0);
  });
});
