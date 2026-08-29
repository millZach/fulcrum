import { describe, expect, it, vi } from "vitest";

import {
  ConceptViewDocumentSchema,
  MultiviewConceptSetSchema,
  type AssetBatchEntry,
  type ConceptViewRole,
} from "@fulcrum/domain";

import {
  createMultiviewViewLoader,
  multiviewLoading,
  multiviewSummary,
} from "./multiview-view.js";

const revision = (
  revisionId: string,
  uri = `/api/artifacts/${revisionId}`,
) => ({
  entityId: revisionId,
  revisionId,
  kind: "multiview-fixture",
  artifact: {
    artifactId: `artifact:${revisionId}`,
    sha256: "a".repeat(64),
    mediaType: "application/json",
    byteLength: 12,
    uri,
  },
  createdAt: "2026-08-24T00:00:00.000Z",
  createdByRunId: "run-1",
});

const multiviewRef = revision("multiview-r1", "/set.json");
const roles: ConceptViewRole[] = ["right", "back", "front", "left"];
const roleHashes: Record<ConceptViewRole, string> = {
  front: "f".repeat(64),
  left: "d".repeat(64),
  back: "b".repeat(64),
  right: "c".repeat(64),
};
const guidanceFor = (role: ConceptViewRole) => ({
  role,
  azimuthDegrees: { front: 0, left: 90, back: 180, right: 270 }[role],
  elevationDegrees: 0,
  projection: "orthographic",
  framing: "full-subject-centered",
  background: "neutral-studio",
});
const viewRefs = Object.fromEntries(
  roles.map((role) => [role, revision(`${role}-r1`, `/${role}.json`)]),
) as Record<ConceptViewRole, ReturnType<typeof revision>>;

const set = MultiviewConceptSetSchema.parse({
  multiviewConceptSetId: "hero:views",
  assetId: "hero",
  sourceAssetPlanRevisionId: "asset-plan-r1",
  sourceConceptSetRevisionId: "concept-set-r1",
  anchorConcept: {
    revision: revision("concept-r1"),
    image: {
      artifactId: "anchor-image",
      sha256: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 20,
      uri: "/api/artifacts/anchor-image",
    },
  },
  views: roles.map((role) => ({
    role,
    guidance: guidanceFor(role),
    revision: viewRefs[role],
    image: {
      artifactId: `${role}-image`,
      sha256: roleHashes[role],
      mediaType: "image/png",
      byteLength: 20,
      uri: `/api/artifacts/${role}-image`,
    },
  })),
  sourceRevisionIds: ["asset-plan-r1", "concept-set-r1", "concept-r1"],
});

const documentFor = (role: ConceptViewRole) =>
  ConceptViewDocumentSchema.parse({
    conceptViewId: `hero:${role}`,
    assetId: "hero",
    guidance: guidanceFor(role),
    attempt: 0,
    prompt: `Exact ${role} identity-preserving prompt`,
    promptHash: roleHashes[role],
    image: set.views.find((view) => view.role === role)!.image,
    provider: "fulcrum-replay",
    model: "fixture-view-v1",
    costUsd: 0,
    sourceConceptRevisionId: "concept-r1",
    sourceRevisionIds: ["asset-plan-r1", "concept-set-r1", "concept-r1"],
    ancestors: [
      {
        revisionId: "asset-plan-r1",
        sha256: "1".repeat(64),
        kind: "asset-plan",
      },
      {
        revisionId: "concept-set-r1",
        sha256: "2".repeat(64),
        kind: "concept-set",
      },
      {
        revisionId: "concept-r1",
        sha256: "3".repeat(64),
        kind: "concept-document",
      },
    ],
    referenceArtifactHashes: ["a".repeat(64)],
    operation: "identity-preserving-concept-view",
  });

const entry = (withSet = true): AssetBatchEntry =>
  ({
    assetId: "hero",
    classification: "hero",
    current: revision("asset-r1"),
    best: revision("asset-r1"),
    attemptCount: 1,
    validated: true,
    ...(withSet ? { multiviewConceptSet: multiviewRef } : {}),
  }) as AssetBatchEntry;

describe("multiview concept disclosure", () => {
  it("gives a hero with a set a collapsed four-view summary", () => {
    expect(multiviewSummary(entry())).toEqual({
      kind: "collapsed",
      label: "3D inputs · 4 views",
      revision: multiviewRef,
    });
  });

  it("renders no disclosure for an asset without a set", () => {
    expect(multiviewSummary(entry(false))).toEqual({ kind: "hidden" });
  });

  it("marks the expanded disclosure as loading before artifacts resolve", () => {
    expect(multiviewLoading(multiviewRef)).toEqual({
      kind: "loading",
      label: "Loading 3D inputs…",
      revisionId: "multiview-r1",
    });
  });

  it("loads the set and view documents once, then orders cardinal roles", async () => {
    const fetchJson = vi.fn(async (uri: string) => {
      if (uri === "/set.json") return set;
      const role = uri.slice(1, -5) as ConceptViewRole;
      return documentFor(role);
    });
    const load = createMultiviewViewLoader(fetchJson);

    const first = await load(multiviewRef);
    const second = await load(multiviewRef);

    expect(first).toBe(second);
    expect(fetchJson).toHaveBeenCalledTimes(5);
    expect(first).toMatchObject({
      kind: "ready",
      anchorHash: "a".repeat(64),
      views: [
        { role: "front", prompt: "Exact front identity-preserving prompt" },
        { role: "left", prompt: "Exact left identity-preserving prompt" },
        { role: "back", prompt: "Exact back identity-preserving prompt" },
        { role: "right", prompt: "Exact right identity-preserving prompt" },
      ],
    });
    expect(first).not.toHaveProperty("approval");
    expect(first).not.toHaveProperty("actions");
  });

  it("rejects a malformed multiview-set artifact with a readable boundary error", async () => {
    const load = createMultiviewViewLoader(async () => ({
      views: "not-an-array",
    }));

    await expect(load(multiviewRef)).rejects.toThrow(
      "Multiview concept set artifact at /set.json is invalid.",
    );
  });

  it("rejects a malformed view-document artifact with a readable boundary error", async () => {
    const load = createMultiviewViewLoader(async (uri) => {
      if (uri === "/set.json") return set;
      if (uri === "/right.json") return { prompt: 42 };
      const role = uri.slice(1, -5) as ConceptViewRole;
      return documentFor(role);
    });

    await expect(load(multiviewRef)).rejects.toThrow(
      "Concept view artifact at /right.json is invalid.",
    );
  });
});
