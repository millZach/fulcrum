import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { VisualBibleSchema } from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it } from "vitest";

import { SceneAuthoring } from "./index.js";

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-scene-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("SceneAuthoring replay idempotency", () => {
  it("scene_composition_replay_returns_the_original_scene_revision", () => {
    const root = temporaryRoot();
    const projectId = "scene-project";
    const firstRepository = new ProjectRepository(root);
    firstRepository.reserveProject(projectId, "2026-01-01T00:00:00.000Z");
    const asset = firstRepository.writeRevision({
      projectId,
      entityId: "asset-1",
      kind: "asset-document",
      value: { assetId: "asset-1" },
      runId: "run-1",
    });
    const visualBible = firstRepository.writeRevision({
      projectId,
      entityId: "bible-1",
      kind: "visual-bible",
      value: VisualBibleSchema.parse({
        title: "Reliquary",
        overallStyle: "Painterly",
        shapeLanguage: "Heavy octagons",
        architecture: "Stone arena",
        heroProp: "Ancient reliquary",
        materials: ["stone", "bronze"],
        palette: [
          { name: "Night basalt", hex: "#171A21", role: "ground" },
          { name: "Fog blue", hex: "#253646", role: "fog" },
          { name: "Core cyan", hex: "#5DE4E7", role: "focus" },
        ],
        lighting: "Warm key and cyan rim",
        atmosphere: "Thin fog",
        cameraLanguage: "Low review orbit",
        textureLanguage: "Hand-sculpted",
        readabilityRules: ["Keep the core visible"],
        prohibitedStyles: ["photorealism"],
      }),
      runId: "run-1",
    });
    const first = new SceneAuthoring(firstRepository).compose({
      projectId,
      runId: "run-1",
      asset,
      visualBible,
    });
    firstRepository.close();

    const reconstructed = new ProjectRepository(root);
    const second = new SceneAuthoring(reconstructed).compose({
      projectId,
      runId: "run-2",
      asset,
      visualBible,
    });

    expect(second.revision).toEqual(first.revision);
    expect(second.scene).toEqual(first.scene);
    expect(
      reconstructed
        .listEvents(projectId)
        .filter(({ type }) => type === "scene.composed"),
    ).toHaveLength(1);
    reconstructed.close();
  });
});
