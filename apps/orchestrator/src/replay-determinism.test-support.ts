import type { ArtifactRef, RevisionRef } from "@fulcrum/domain";
import type { ProjectRepository } from "@fulcrum/project";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isArtifactRef = (value: unknown): value is ArtifactRef =>
  isRecord(value) &&
  typeof value.artifactId === "string" &&
  typeof value.sha256 === "string" &&
  typeof value.mediaType === "string" &&
  typeof value.byteLength === "number";

const isRevisionRef = (value: unknown): value is RevisionRef =>
  isRecord(value) &&
  typeof value.revisionId === "string" &&
  isArtifactRef(value.artifact) &&
  value.artifact.mediaType === "application/json";

const IDENTITY_KEYS = new Set([
  "approvalId",
  "artifactId",
  "conceptPlanId",
  "conceptSetId",
  "conceptViewId",
  "decisionId",
  "directionSetId",
  "evaluationId",
  "eventId",
  "externalJobId",
  "findingId",
  "reportId",
  "requestId",
  "runId",
  "turntableId",
  "workflowRunId",
]);

const REVISION_ID_KEY = /(?:^revisionId$|RevisionId$|RevisionIds$)/;

export const replayDeterminismRecord = (
  repository: ProjectRepository,
  roots: unknown[],
) => {
  const revisions = new Map<string, RevisionRef>();

  const addRevisionId = (revisionId: string): void => {
    if (revisions.has(revisionId)) return;
    try {
      const revision = repository.getRevision(revisionId);
      revisions.set(revisionId, revision);
    } catch {
      // Some domain IDs deliberately end in "RevisionId" without naming a
      // repository revision. Only stored revisions belong in this closure.
    }
  };

  const collect = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => collect(entry, key));
      return;
    }
    if (!isRecord(value)) {
      if (typeof value === "string" && key && REVISION_ID_KEY.test(key))
        addRevisionId(value);
      return;
    }
    if (isRevisionRef(value)) revisions.set(value.revisionId, value);
    for (const [childKey, child] of Object.entries(value))
      collect(child, childKey);
  };

  roots.forEach((root) => collect(root));
  const documents: Array<{ revision: RevisionRef; value: unknown }> = [];
  for (let index = 0; index < revisions.size; index += 1) {
    const revision = [...revisions.values()][index]!;
    const value = repository.resolveRevision(revision);
    documents.push({ revision, value });
    collect(value);
  }

  const identities = new Map<string, string>();
  const projectIds: string[] = [];
  const collectProjectIds = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectProjectIds(entry, key));
      return;
    }
    if (!isRecord(value)) {
      if (
        typeof value === "string" &&
        key === "projectId" &&
        !projectIds.includes(value)
      )
        projectIds.push(value);
      return;
    }
    for (const [childKey, child] of Object.entries(value))
      collectProjectIds(child, childKey);
  };
  [...roots, ...documents].forEach((value) => collectProjectIds(value));
  projectIds.forEach((projectId, index) =>
    identities.set(projectId, `<projectId:${index + 1}>`),
  );

  const documentByRevisionId = new Map(
    documents.map(({ revision, value }) => [revision.revisionId, value]),
  );
  const jsonHashes = new Set(
    [...revisions.values()].map((revision) => revision.artifact.sha256),
  );
  const semanticSortValue = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key && REVISION_ID_KEY.test(key)) return "<revision>";
      if (key && IDENTITY_KEYS.has(key)) return `<${key}>`;
      if (jsonHashes.has(value)) return "<json-artifact>";
      let stable = value.replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
        "<timestamp>",
      );
      for (const [projectId, label] of identities)
        stable = stable.split(projectId).join(label);
      return stable;
    }
    if (Array.isArray(value))
      return value.map((entry) => semanticSortValue(entry, key));
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [
          childKey,
          semanticSortValue(value[childKey], childKey),
        ]),
    );
  };
  const revisionSortKey = (revision: RevisionRef): string =>
    JSON.stringify(
      semanticSortValue(documentByRevisionId.get(revision.revisionId)),
    );

  const stableEntityId = (entityId: string): string => {
    let stable = entityId;
    for (const [projectId, label] of identities)
      stable = stable.split(projectId).join(label);
    return stable;
  };
  const revisionGroups = new Map<string, RevisionRef[]>();
  for (const revision of revisions.values()) {
    const groupKey = `${revision.kind}:${stableEntityId(revision.entityId)}`;
    const group = revisionGroups.get(groupKey) ?? [];
    group.push(revision);
    revisionGroups.set(groupKey, group);
  }
  for (const [groupKey, group] of [...revisionGroups.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    group
      .sort((left, right) =>
        revisionSortKey(left).localeCompare(revisionSortKey(right)),
      )
      .forEach((revision, index) =>
        identities.set(
          revision.revisionId,
          `<revision:${groupKey}:${index + 1}>`,
        ),
      );
  }

  const orderedDocuments = documents.sort((left, right) =>
    identities
      .get(left.revision.revisionId)!
      .localeCompare(identities.get(right.revision.revisionId)!),
  );
  const registerIdentity = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => registerIdentity(entry, key));
      return;
    }
    if (!isRecord(value)) {
      if (
        typeof value === "string" &&
        key &&
        (IDENTITY_KEYS.has(key) || REVISION_ID_KEY.test(key)) &&
        !identities.has(value)
      )
        identities.set(value, `<${key}:${identities.size + 1}>`);
      return;
    }
    for (const [childKey, child] of Object.entries(value))
      registerIdentity(child, childKey);
  };
  [...orderedDocuments, ...roots].forEach((value) => registerIdentity(value));

  const jsonArtifactLabels = new Map<string, string>();
  for (const revision of revisions.values())
    jsonArtifactLabels.set(
      revision.artifact.sha256,
      `<json-artifact:${identities.get(revision.revisionId)}>`,
    );

  const replaceKnownValues = (input: string): string => {
    let value = input.replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
      "<timestamp>",
    );
    const replacements = [
      ...jsonArtifactLabels.entries(),
      ...identities.entries(),
    ].sort(([left], [right]) => right.length - left.length);
    for (const [identity, label] of replacements)
      value = value.split(identity).join(label);
    return value;
  };

  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return replaceKnownValues(value);
    if (Array.isArray(value)) return value.map(normalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .map((key) => ({ key, stableKey: replaceKnownValues(key) }))
        .sort((left, right) => left.stableKey.localeCompare(right.stableKey))
        .map(({ key, stableKey }) => [stableKey, normalize(value[key])]),
    );
  };

  const binaryArtifacts = new Map<string, ArtifactRef>();
  const collectBinaryArtifacts = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectBinaryArtifacts);
      return;
    }
    if (!isRecord(value)) return;
    if (isArtifactRef(value) && value.mediaType !== "application/json")
      binaryArtifacts.set(`${value.mediaType}:${value.sha256}`, value);
    Object.values(value).forEach(collectBinaryArtifacts);
  };
  [...roots, ...orderedDocuments].forEach(collectBinaryArtifacts);

  return {
    rawArtifacts: [...binaryArtifacts.values()]
      .sort((left, right) =>
        `${left.mediaType}:${left.sha256}`.localeCompare(
          `${right.mediaType}:${right.sha256}`,
        ),
      )
      .map((artifact) => ({
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        bytes: Buffer.from(repository.readArtifact(artifact)).toString(
          "base64",
        ),
      })),
    canonicalLineage: JSON.stringify(
      normalize({
        roots,
        documents: orderedDocuments,
      }),
    ),
  };
};
