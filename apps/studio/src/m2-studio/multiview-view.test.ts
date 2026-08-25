import { describe, expect, it, vi } from "vitest";

import type {
  AssetBatchEntry,
  ConceptViewDocument,
  ConceptViewRole,
  MultiviewConceptSet,
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
    sha256: revisionId[0]!.repeat(64),
    mediaType: "application/json",
    byteLength: 12,
    uri,
  },
  createdAt: "2026-08-24T00:00:00.000Z",
  createdByRunId: "run-1",
});

const multiviewRef = revision("multiview-r1", "/set.json");
const roles: ConceptViewRole[] = ["right", "back", "front", "left"];
const viewRefs = Object.fromEntries(
  roles.map((role) => [role, revision(`${role}-r1`, `/${role}.json`)]),
) as Record<ConceptViewRole, ReturnType<typeof revision>>;

const set = {
  multiviewConceptSetId: "hero:views",
  assetId: "hero",
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
    guidance: { role },
    revision: viewRefs[role],
    image: {
      artifactId: `${role}-image`,
      sha256: role[0]!.repeat(64),
      mediaType: "image/png",
      byteLength: 20,
      uri: `/api/artifacts/${role}-image`,
    },
  })),
} as MultiviewConceptSet;

const documentFor = (role: ConceptViewRole) =>
  ({
    conceptViewId: `hero:${role}`,
    assetId: "hero",
    guidance: { role },
    prompt: `Exact ${role} identity-preserving prompt`,
    promptHash: role[0]!.repeat(64),
    image: set.views.find((view) => view.role === role)!.image,
  }) as ConceptViewDocument;

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
});
