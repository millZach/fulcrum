import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ApprovalDecisionSchema,
  ArtifactRefSchema,
  ProjectStateSchema,
  type ApprovalDecision,
  type ArtifactRef,
  type ProjectState,
  type RevisionRef,
  type SubmissionRecord,
  type SubmissionStatus,
} from "@fulcrum/domain";

type ArtifactRow = {
  artifact_id: string;
  project_id: string;
  sha256: string;
  media_type: string;
  byte_length: number;
  relative_path: string;
};

type ProjectRow = { state_json: string };
type RevisionRow = {
  revision_id: string;
  entity_id: string;
  kind: string;
  artifact_id: string;
  created_at: string;
  run_id: string;
};

type SubmissionRow = {
  request_id: string;
  project_id: string;
  operation: string;
  provider: string;
  idempotency_key: string;
  status: SubmissionStatus;
  external_job_id: string | null;
  result_revision_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

const extensionFor = (mediaType: string): string => {
  const known: Record<string, string> = {
    "application/json": "json",
    "model/gltf-binary": "glb",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "text/plain": "txt",
  };
  return known[mediaType] ?? "bin";
};

const now = () => new Date().toISOString();

export class ProjectRepository {
  readonly workspaceRoot: string;
  private readonly database: DatabaseSync;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    mkdirSync(this.workspaceRoot, { recursive: true });
    this.database = new DatabaseSync(
      path.join(this.workspaceRoot, "fulcrum.db"),
    );
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, sha256, media_type),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE IF NOT EXISTS revisions (
        revision_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id),
        FOREIGN KEY(artifact_id) REFERENCES artifacts(artifact_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        target_revision_id TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE IF NOT EXISTS submissions (
        request_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        provider TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        external_job_id TEXT,
        result_revision_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  reserveProject(projectId: string, createdAt = now()): void {
    this.database
      .prepare(
        "INSERT INTO projects (project_id, state_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        projectId,
        JSON.stringify({ bootstrapping: true }),
        createdAt,
        createdAt,
      );
  }

  createProject(state: ProjectState): ProjectState {
    const parsed = ProjectStateSchema.parse(state);
    const existing = this.database
      .prepare("SELECT state_json FROM projects WHERE project_id = ?")
      .get(parsed.projectId) as ProjectRow | undefined;
    if (existing) {
      this.database
        .prepare(
          "UPDATE projects SET state_json = ?, updated_at = ? WHERE project_id = ?",
        )
        .run(JSON.stringify(parsed), parsed.updatedAt, parsed.projectId);
    } else {
      this.database
        .prepare(
          "INSERT INTO projects (project_id, state_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          parsed.projectId,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.updatedAt,
        );
    }
    return parsed;
  }

  saveProject(state: ProjectState): ProjectState {
    const parsed = ProjectStateSchema.parse({ ...state, updatedAt: now() });
    const result = this.database
      .prepare(
        "UPDATE projects SET state_json = ?, updated_at = ? WHERE project_id = ?",
      )
      .run(JSON.stringify(parsed), parsed.updatedAt, parsed.projectId);
    if (result.changes !== 1) {
      throw new Error(`Project ${parsed.projectId} does not exist.`);
    }
    return parsed;
  }

  getProject(projectId: string): ProjectState {
    const row = this.database
      .prepare("SELECT state_json FROM projects WHERE project_id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) {
      throw new Error(`Project ${projectId} does not exist.`);
    }
    return ProjectStateSchema.parse(JSON.parse(row.state_json));
  }

  listProjects(): ProjectState[] {
    const rows = this.database
      .prepare("SELECT state_json FROM projects ORDER BY updated_at DESC")
      .all() as unknown as ProjectRow[];
    return rows.flatMap((row) => {
      const parsed = ProjectStateSchema.safeParse(JSON.parse(row.state_json));
      return parsed.success ? [parsed.data] : [];
    });
  }

  putArtifact(
    projectId: string,
    data: Uint8Array,
    mediaType: string,
  ): ArtifactRef {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const existing = this.database
      .prepare(
        "SELECT artifact_id, project_id, sha256, media_type, byte_length, relative_path FROM artifacts WHERE project_id = ? AND sha256 = ? AND media_type = ?",
      )
      .get(projectId, sha256, mediaType) as ArtifactRow | undefined;
    if (existing) {
      return this.artifactRef(existing);
    }

    const artifactId = randomUUID();
    const relativePath = path.join(
      "projects",
      projectId,
      "artifacts",
      `${sha256}.${extensionFor(mediaType)}`,
    );
    const absolutePath = path.join(this.workspaceRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, data);

    this.database
      .prepare(
        "INSERT INTO artifacts (artifact_id, project_id, sha256, media_type, byte_length, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        artifactId,
        projectId,
        sha256,
        mediaType,
        data.byteLength,
        relativePath,
        now(),
      );

    return ArtifactRefSchema.parse({
      artifactId,
      sha256,
      mediaType,
      byteLength: data.byteLength,
      uri: `/api/artifacts/${artifactId}`,
    });
  }

  getArtifactRecord(artifactId: string): {
    ref: ArtifactRef;
    absolutePath: string;
  } {
    const row = this.database
      .prepare(
        "SELECT artifact_id, project_id, sha256, media_type, byte_length, relative_path FROM artifacts WHERE artifact_id = ?",
      )
      .get(artifactId) as ArtifactRow | undefined;
    if (!row) {
      throw new Error(`Artifact ${artifactId} does not exist.`);
    }
    const absolutePath = path.resolve(this.workspaceRoot, row.relative_path);
    if (!absolutePath.startsWith(`${this.workspaceRoot}${path.sep}`)) {
      throw new Error("Artifact path escaped the workspace root.");
    }
    return { ref: this.artifactRef(row), absolutePath };
  }

  readArtifact(artifact: ArtifactRef): Uint8Array {
    const record = this.getArtifactRecord(artifact.artifactId);
    if (record.ref.sha256 !== artifact.sha256) {
      throw new Error(
        `Artifact ${artifact.artifactId} hash reference does not match storage.`,
      );
    }
    const bytes = readFileSync(record.absolutePath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== artifact.sha256) {
      throw new Error(
        `Artifact ${artifact.artifactId} failed integrity verification.`,
      );
    }
    return bytes;
  }

  writeRevision<T>(input: {
    projectId: string;
    entityId: string;
    kind: string;
    value: T;
    runId: string;
  }): RevisionRef {
    const bytes = new TextEncoder().encode(
      JSON.stringify(input.value, null, 2),
    );
    const artifact = this.putArtifact(
      input.projectId,
      bytes,
      "application/json",
    );
    const revisionId = randomUUID();
    const createdAt = now();
    this.database
      .prepare(
        "INSERT INTO revisions (revision_id, project_id, entity_id, kind, artifact_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        revisionId,
        input.projectId,
        input.entityId,
        input.kind,
        artifact.artifactId,
        input.runId,
        createdAt,
      );
    return {
      entityId: input.entityId,
      revisionId,
      kind: input.kind,
      artifact,
      createdAt,
      createdByRunId: input.runId,
    };
  }

  getRevision(revisionId: string): RevisionRef {
    const row = this.database
      .prepare(
        "SELECT revision_id, entity_id, kind, artifact_id, created_at, run_id FROM revisions WHERE revision_id = ?",
      )
      .get(revisionId) as RevisionRow | undefined;
    if (!row) {
      throw new Error(`Revision ${revisionId} does not exist.`);
    }
    const artifact = this.getArtifactRecord(row.artifact_id).ref;
    return {
      entityId: row.entity_id,
      revisionId: row.revision_id,
      kind: row.kind,
      artifact,
      createdAt: row.created_at,
      createdByRunId: row.run_id,
    };
  }

  resolveRevision<T>(revision: RevisionRef): T {
    return JSON.parse(
      new TextDecoder().decode(this.readArtifact(revision.artifact)),
    ) as T;
  }

  appendEvent(input: {
    projectId: string;
    runId: string;
    type: string;
    payload: Record<string, unknown>;
  }): void {
    this.database
      .prepare(
        "INSERT INTO events (event_id, project_id, run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.projectId,
        input.runId,
        input.type,
        JSON.stringify(input.payload),
        now(),
      );
  }

  listEvents(projectId: string): Array<{
    eventId: string;
    runId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }> {
    const rows = this.database
      .prepare(
        "SELECT event_id, run_id, event_type, payload_json, created_at FROM events WHERE project_id = ? ORDER BY created_at ASC",
      )
      .all(projectId) as unknown as Array<{
      event_id: string;
      run_id: string;
      event_type: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      type: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  recordApproval(decision: ApprovalDecision): ApprovalDecision {
    const parsed = ApprovalDecisionSchema.parse(decision);
    const revision = this.getRevision(parsed.targetRevisionId);
    if (revision.artifact.sha256 !== parsed.targetSha256) {
      throw new Error(
        "Approval target hash does not match the immutable revision.",
      );
    }
    this.database
      .prepare(
        "INSERT INTO approvals (approval_id, project_id, target_revision_id, decision_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        parsed.approvalId,
        parsed.projectId,
        parsed.targetRevisionId,
        JSON.stringify(parsed),
        parsed.decidedAt,
      );
    return parsed;
  }

  recordSubmissionIntent(input: {
    projectId: string;
    operation: string;
    provider: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): SubmissionRecord {
    const existing = this.getSubmissionByKey(input.idempotencyKey);
    if (existing) return existing;
    const timestamp = now();
    const record: SubmissionRecord = {
      requestId: randomUUID(),
      projectId: input.projectId,
      operation: input.operation,
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
      status: "intent-recorded",
      payload: input.payload,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database
      .prepare(
        "INSERT INTO submissions (request_id, project_id, operation, provider, idempotency_key, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.requestId,
        record.projectId,
        record.operation,
        record.provider,
        record.idempotencyKey,
        record.status,
        JSON.stringify(record.payload),
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getSubmissionByKey(idempotencyKey: string): SubmissionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM submissions WHERE idempotency_key = ?")
      .get(idempotencyKey) as SubmissionRow | undefined;
    return row ? this.submissionRecord(row) : undefined;
  }

  updateSubmission(
    requestId: string,
    update: {
      status: SubmissionStatus;
      externalJobId?: string;
      resultRevisionId?: string;
      payload?: Record<string, unknown>;
    },
  ): SubmissionRecord {
    const currentRow = this.database
      .prepare("SELECT * FROM submissions WHERE request_id = ?")
      .get(requestId) as SubmissionRow | undefined;
    if (!currentRow) throw new Error(`Submission ${requestId} does not exist.`);
    const current = this.submissionRecord(currentRow);
    const updated: SubmissionRecord = {
      ...current,
      status: update.status,
      payload: update.payload ?? current.payload,
      updatedAt: now(),
    };
    if (update.externalJobId !== undefined)
      updated.externalJobId = update.externalJobId;
    if (update.resultRevisionId !== undefined)
      updated.resultRevisionId = update.resultRevisionId;
    this.database
      .prepare(
        "UPDATE submissions SET status = ?, external_job_id = ?, result_revision_id = ?, payload_json = ?, updated_at = ? WHERE request_id = ?",
      )
      .run(
        updated.status,
        updated.externalJobId ?? null,
        updated.resultRevisionId ?? null,
        JSON.stringify(updated.payload),
        updated.updatedAt,
        requestId,
      );
    return updated;
  }

  reserveBudget(
    projectId: string,
    amountUsd: number,
    label: string,
  ): ProjectState {
    if (amountUsd < 0 || !Number.isFinite(amountUsd)) {
      throw new Error(
        "Budget reservation must be a finite non-negative number.",
      );
    }
    const project = this.getProject(projectId);
    if (project.spentUsd + amountUsd > project.budgetUsd) {
      throw new Error(
        `Budget exhausted: ${label} requires $${amountUsd.toFixed(2)}, but only $${(
          project.budgetUsd - project.spentUsd
        ).toFixed(2)} remains.`,
      );
    }
    const saved = this.saveProject({
      ...project,
      spentUsd: project.spentUsd + amountUsd,
    });
    this.appendEvent({
      projectId,
      runId: project.runId,
      type: "budget.reserved",
      payload: { label, amountUsd, totalReservedUsd: saved.spentUsd },
    });
    return saved;
  }

  private artifactRef(row: ArtifactRow): ArtifactRef {
    return ArtifactRefSchema.parse({
      artifactId: row.artifact_id,
      sha256: row.sha256,
      mediaType: row.media_type,
      byteLength: row.byte_length,
      uri: `/api/artifacts/${row.artifact_id}`,
    });
  }

  private submissionRecord(row: SubmissionRow): SubmissionRecord {
    const record: SubmissionRecord = {
      requestId: row.request_id,
      projectId: row.project_id,
      operation: row.operation,
      provider: row.provider,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.external_job_id) record.externalJobId = row.external_job_id;
    if (row.result_revision_id)
      record.resultRevisionId = row.result_revision_id;
    return record;
  }
}

export const createRepository = (
  root = path.resolve(process.cwd(), "workspace"),
) => new ProjectRepository(root);
