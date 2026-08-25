import {
  ConceptViewDocumentSchema,
  MultiviewConceptSetSchema,
  type AssetBatchEntry,
  type ConceptViewRole,
  type RevisionRef,
} from "@fulcrum/domain";

const ROLE_ORDER: readonly ConceptViewRole[] = [
  "front",
  "left",
  "back",
  "right",
];

export type MultiviewSummary =
  | { kind: "hidden" }
  | {
      kind: "collapsed";
      label: string;
      revision: RevisionRef;
    };

export type MultiviewLoading = {
  kind: "loading";
  label: string;
  revisionId: string;
};

export type MultiviewReady = {
  kind: "ready";
  revisionId: string;
  anchorHash: string;
  anchorUri: string;
  views: Array<{
    role: ConceptViewRole;
    label: string;
    revisionId: string;
    imageUri: string;
    imageHash: string;
    prompt: string;
    promptHash: string;
  }>;
};

export const multiviewSummary = (
  entry: Pick<AssetBatchEntry, "multiviewConceptSet"> | undefined,
): MultiviewSummary =>
  entry?.multiviewConceptSet
    ? {
        kind: "collapsed",
        label: "3D inputs · 4 views",
        revision: entry.multiviewConceptSet,
      }
    : { kind: "hidden" };

export const multiviewLoading = (revision: RevisionRef): MultiviewLoading => ({
  kind: "loading",
  label: "Loading 3D inputs…",
  revisionId: revision.revisionId,
});

type FetchJson = (uri: string) => Promise<unknown>;

const materializeMultiview = async (
  revision: RevisionRef,
  fetchJson: FetchJson,
): Promise<MultiviewReady> => {
  const setResult = MultiviewConceptSetSchema.safeParse(
    await fetchJson(revision.artifact.uri),
  );
  if (!setResult.success)
    throw new Error(
      `Multiview concept set artifact at ${revision.artifact.uri} is invalid.`,
      { cause: setResult.error },
    );
  const set = setResult.data;
  const documents = await Promise.all(
    set.views.map(async (view) => {
      const documentResult = ConceptViewDocumentSchema.safeParse(
        await fetchJson(view.revision.artifact.uri),
      );
      if (!documentResult.success)
        throw new Error(
          `Concept view artifact at ${view.revision.artifact.uri} is invalid.`,
          { cause: documentResult.error },
        );
      return { view, document: documentResult.data };
    }),
  );
  const byRole = new Map(documents.map((entry) => [entry.view.role, entry]));

  return {
    kind: "ready",
    revisionId: revision.revisionId,
    anchorHash: set.anchorConcept.image.sha256,
    anchorUri: set.anchorConcept.image.uri,
    views: ROLE_ORDER.flatMap((role) => {
      const entry = byRole.get(role);
      if (!entry) return [];
      return [
        {
          role,
          label: role[0]!.toUpperCase() + role.slice(1),
          revisionId: entry.view.revision.revisionId,
          imageUri: entry.view.image.uri,
          imageHash: entry.view.image.sha256,
          prompt: entry.document.prompt,
          promptHash: entry.document.promptHash,
        },
      ];
    }),
  };
};

export const createMultiviewViewLoader = (fetchJson: FetchJson) => {
  const cache = new Map<string, Promise<MultiviewReady>>();
  return (revision: RevisionRef): Promise<MultiviewReady> => {
    const existing = cache.get(revision.revisionId);
    if (existing) return existing;
    const pending = materializeMultiview(revision, fetchJson);
    cache.set(revision.revisionId, pending);
    return pending;
  };
};
