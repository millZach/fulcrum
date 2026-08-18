import { randomUUID } from "node:crypto";

import {
  FulcrumSceneSpecV0Schema,
  type FulcrumSceneSpecV0,
  type RevisionRef,
  type VisualBible,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";

export class SceneAuthoring {
  constructor(private readonly repository: ProjectRepository) {}

  compose(input: {
    projectId: string;
    runId: string;
    asset: RevisionRef;
    visualBible: RevisionRef;
  }): { revision: RevisionRef; scene: FulcrumSceneSpecV0 } {
    const bible = this.repository.resolveRevision<VisualBible>(
      input.visualBible,
    );
    const color = (name: string, fallback: string) =>
      bible.palette.find((entry) => entry.name === name)?.hex ?? fallback;
    const scene: FulcrumSceneSpecV0 = FulcrumSceneSpecV0Schema.parse({
      schema: "fulcrum.scene",
      version: 0,
      sceneId: randomUUID(),
      units: "meters",
      coordinates: { handedness: "right", up: "+Y", forward: "-Z" },
      environment: {
        background: color("Night basalt", "#171A21"),
        fog: { color: color("Fog blue", "#253646"), near: 9, far: 32 },
        ground: { radius: 13, color: "#11161d" },
      },
      camera: {
        position: [6.6, 4.7, 7.8],
        target: [0, 1.25, 0],
        fieldOfViewDegrees: 38,
      },
      lighting: [
        { id: "moon-fill", kind: "ambient", color: "#7895b0", intensity: 0.65 },
        {
          id: "warm-key",
          kind: "directional",
          color: "#ffd0a0",
          intensity: 3.2,
          position: [4.5, 7, 4],
        },
        {
          id: "cyan-rim",
          kind: "point",
          color: color("Core cyan", "#5DE4E7"),
          intensity: 13,
          position: [0, 2.1, 1.5],
        },
      ],
      entities: [
        {
          id: "hero-reliquary",
          name: "Ancient Reliquary",
          assetRevisionId: input.asset.revisionId,
          transform: {
            position: [0, 0, 0],
            rotationEulerRadians: [0, 0.18, 0],
            scale: [1, 1, 1],
          },
          tags: ["hero", "objective", "interactive"],
        },
      ],
      systems: ["orbit-review-camera", "artifact-integrity"],
      navigation: { enabled: false },
      spawnPoints: [{ id: "review-spawn", position: [5.5, 0, 6.5] }],
      interactionZones: [
        { id: "reliquary-zone", entityId: "hero-reliquary", radius: 2.2 },
      ],
    });
    const revision = this.repository.writeRevision({
      projectId: input.projectId,
      entityId: `${input.projectId}:visual-slice-scene`,
      kind: "fulcrum-scene-v0",
      value: scene,
      runId: input.runId,
    });
    this.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: "scene.composed",
      payload: {
        revisionId: revision.revisionId,
        assetRevisionId: input.asset.revisionId,
      },
    });
    return { revision, scene };
  }
}
