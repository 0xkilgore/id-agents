// Doc-model substrate — slice 1: artifacts as documents.
//
// An artifact's content + frontmatter-equivalent metadata + comment/receipt
// history live entirely as an append-only operation log in
// `doc_model_document_op`, reduced by `projectArtifactDocument` into a
// read-model. Nothing here reads a file from disk: the projection is the
// only supported read path, so a console (or any other read surface) built
// against it never has to grep markdown-on-disk.
//
// Shaped for a later lift onto Powerhouse Switchboard's document-model
// (see standing OSS posture — direct lift, AGPL accepted): the mapping is
// document_id -> PHDocument.id, doc_type -> documentType, op_type ->
// action.type, payload_json -> action.input, revision -> the reducer's
// operation index. Migrating means replacing this table pair with a
// Switchboard-backed store and re-pointing `projectArtifactDocument` at its
// reducer output; callers of the projection shape do not change.

import type { DbAdapter } from "../db/db-adapter.js";
import type { ActorRef, ArtifactEntry, ArtifactProvenance, EntryStamp, EntryStampAudience, EntryStampKind } from "../outputs/entry.js";
import { buildProvenanceFromOpLog, finalizeEntryProvenance, parseActorRef } from "./provenance.js";
import { localHealthVisualState } from "../local-search/visual-state.js";

export const ARTIFACT_DOCUMENT_SCHEMA_VERSION = "doc_model.artifact_document.v1" as const;

export type ArtifactDocumentOpType = "artifact_authored" | "comment_appended" | "receipt_appended";
export type ArtifactDocumentAvailability = "present" | "missing" | "unknown";
export type ArtifactDocumentReceiptKind = "approve" | "reject" | "ship_attempted" | "ship_blocked";
export type { EntryStampAudience, EntryStampKind, EntryStamp };

export interface ArtifactAuthoredOpPayload {
  title: string;
  tag: string | null;
  content: string;
  source_link: string | null;
  availability: ArtifactDocumentAvailability;
  audience: EntryStampAudience;
  kind: EntryStampKind;
  project: string | null;
}

export interface ArtifactCommentOpPayload {
  body: string;
}

export interface ArtifactReceiptOpPayload {
  kind: ArtifactDocumentReceiptKind;
  note: string | null;
}

export interface ArtifactDocumentProjection {
  schema_version: typeof ARTIFACT_DOCUMENT_SCHEMA_VERSION;
  document_id: string;
  doc_type: "artifact";
  owner_agent: string;
  revision: number;
  /** Maestra's stamping convention — drives which of the five console surfaces this document appears on. */
  stamp: EntryStamp;
  project: string | null;
  frontmatter: {
    title: string;
    tag: string | null;
    source_link: string | null;
    availability: ArtifactDocumentAvailability;
    authored_by: string;
    authored_at: string;
  };
  content: string;
  comments: Array<{ op_id: number; actor: string; ts: string; body: string }>;
  receipts: Array<{ op_id: number; actor: string; ts: string; kind: ArtifactDocumentReceiptKind; note: string | null }>;
  /** Generic DV2 provenance over the same op log, for cross-kind (ArtifactEntry) compatibility. */
  provenance: ArtifactProvenance;
  op_count: number;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  document_id: string;
  team_id: string;
  doc_type: string;
  owner_agent: string;
  revision: number;
  audience: EntryStampAudience;
  kind: EntryStampKind;
  project: string | null;
  created_at: string;
  updated_at: string;
}

interface OpRow {
  op_id: number;
  document_id: string;
  revision: number;
  op_type: ArtifactDocumentOpType;
  actor: string;
  ts: string;
  payload_json: string;
}

export async function migrateDocModelDocumentTables(adapter: DbAdapter): Promise<void> {
  const autoIncrementPrimaryKey = adapter.dialect === "postgres"
    ? "BIGSERIAL PRIMARY KEY"
    : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const exec = async (sql: string) => {
    if (adapter.dialect === "sqlite" && typeof (adapter as unknown as { exec?: (s: string) => void }).exec === "function") {
      (adapter as unknown as { exec: (s: string) => void }).exec(sql);
    } else {
      await adapter.query(sql);
    }
  };

  await exec(`
    CREATE TABLE IF NOT EXISTS doc_model_document (
      document_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      owner_agent TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      audience TEXT NOT NULL,
      kind TEXT NOT NULL,
      project TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS doc_model_document_op (
      op_id ${autoIncrementPrimaryKey},
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      op_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS doc_model_document_op_by_doc ON doc_model_document_op(document_id, op_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS doc_model_document_by_team ON doc_model_document(team_id, doc_type, updated_at)`);
  // Surface-projection lookups (Now/Reports filter on audience+kind; Projects groups by project).
  await exec(`CREATE INDEX IF NOT EXISTS doc_model_document_by_stamp ON doc_model_document(team_id, audience, kind, updated_at)`);
  await exec(`CREATE INDEX IF NOT EXISTS doc_model_document_by_project ON doc_model_document(team_id, project, updated_at)`);
}

/**
 * Author a new artifact document: creates the document row and appends the
 * one `artifact_authored` op that carries content + frontmatter. Idempotent
 * on `document_id` — a retry of the same author call is a no-op, matching
 * the `/artifacts/register` catalog's re-POST semantics.
 */
export async function authorArtifactDocument(
  adapter: DbAdapter,
  input: {
    teamId: string;
    documentId: string;
    ownerAgent: string;
    actor: string;
    title: string;
    tag: string | null;
    content: string;
    sourceLink: string | null;
    availability: ArtifactDocumentAvailability;
    audience: EntryStampAudience;
    kind: EntryStampKind;
    project: string | null;
    now?: string;
  },
): Promise<{ inserted: boolean }> {
  const now = input.now ?? new Date().toISOString();
  const inserted = await adapter.query(
    `INSERT INTO doc_model_document (document_id, team_id, doc_type, owner_agent, revision, audience, kind, project, created_at, updated_at)
     VALUES ($1, $2, 'artifact', $3, 1, $4, $5, $6, $7, $8)
     ON CONFLICT(document_id) DO NOTHING`,
    [input.documentId, input.teamId, input.ownerAgent, input.audience, input.kind, input.project, now, now],
  );
  if ((inserted.rowCount ?? 0) === 0) return { inserted: false };

  const payload: ArtifactAuthoredOpPayload = {
    title: input.title,
    tag: input.tag,
    content: input.content,
    source_link: input.sourceLink,
    availability: input.availability,
    audience: input.audience,
    kind: input.kind,
    project: input.project,
  };
  await adapter.query(
    `INSERT INTO doc_model_document_op (document_id, revision, op_type, actor, ts, payload_json)
     VALUES ($1, 1, 'artifact_authored', $2, $3, $4)`,
    [input.documentId, input.actor, now, JSON.stringify(payload)],
  );
  return { inserted: true };
}

async function appendOp(
  adapter: DbAdapter,
  input: { documentId: string; opType: ArtifactDocumentOpType; actor: string; payload: unknown; now?: string },
): Promise<{ revision: number }> {
  const now = input.now ?? new Date().toISOString();
  const { rows } = await adapter.query<{ revision: number }>(
    `SELECT revision FROM doc_model_document WHERE document_id = $1`,
    [input.documentId],
  );
  const doc = rows[0];
  if (!doc) throw new Error(`unknown doc-model document: ${input.documentId}`);
  const nextRevision = doc.revision + 1;

  await adapter.query(
    `INSERT INTO doc_model_document_op (document_id, revision, op_type, actor, ts, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.documentId, nextRevision, input.opType, input.actor, now, JSON.stringify(input.payload)],
  );
  await adapter.query(
    `UPDATE doc_model_document SET revision = $1, updated_at = $2 WHERE document_id = $3`,
    [nextRevision, now, input.documentId],
  );
  return { revision: nextRevision };
}

/** Append a comment op. The document must already be authored. */
export async function appendArtifactComment(
  adapter: DbAdapter,
  input: { documentId: string; actor: string; body: string; now?: string },
): Promise<{ revision: number }> {
  const payload: ArtifactCommentOpPayload = { body: input.body };
  return appendOp(adapter, { documentId: input.documentId, opType: "comment_appended", actor: input.actor, payload, now: input.now });
}

/** Append a receipt op (approve/reject/ship_attempted/ship_blocked). */
export async function appendArtifactReceipt(
  adapter: DbAdapter,
  input: { documentId: string; actor: string; kind: ArtifactDocumentReceiptKind; note?: string | null; now?: string },
): Promise<{ revision: number }> {
  const payload: ArtifactReceiptOpPayload = { kind: input.kind, note: input.note ?? null };
  return appendOp(adapter, { documentId: input.documentId, opType: "receipt_appended", actor: input.actor, payload, now: input.now });
}

/**
 * Materialize a document purely by replaying its operation log. This is the
 * only read path a console/projection consumer should use — it never opens
 * a file.
 */
export async function projectArtifactDocument(
  adapter: DbAdapter,
  documentId: string,
): Promise<ArtifactDocumentProjection | null> {
  const { rows: docRows } = await adapter.query<DocumentRow>(
    `SELECT document_id, team_id, doc_type, owner_agent, revision, audience, kind, project, created_at, updated_at
       FROM doc_model_document WHERE document_id = $1`,
    [documentId],
  );
  const doc = docRows[0];
  if (!doc) return null;

  const { rows: opRows } = await adapter.query<OpRow>(
    `SELECT op_id, document_id, revision, op_type, actor, ts, payload_json
       FROM doc_model_document_op
      WHERE document_id = $1
      ORDER BY op_id ASC`,
    [documentId],
  );

  let frontmatter: ArtifactDocumentProjection["frontmatter"] | null = null;
  let content = "";
  const comments: ArtifactDocumentProjection["comments"] = [];
  const receipts: ArtifactDocumentProjection["receipts"] = [];

  for (const op of opRows) {
    const payload = JSON.parse(op.payload_json);
    if (op.op_type === "artifact_authored") {
      const authored = payload as ArtifactAuthoredOpPayload;
      frontmatter = {
        title: authored.title,
        tag: authored.tag,
        source_link: authored.source_link,
        availability: authored.availability,
        authored_by: op.actor,
        authored_at: op.ts,
      };
      content = authored.content;
    } else if (op.op_type === "comment_appended") {
      const comment = payload as ArtifactCommentOpPayload;
      comments.push({ op_id: op.op_id, actor: op.actor, ts: op.ts, body: comment.body });
    } else if (op.op_type === "receipt_appended") {
      const receipt = payload as ArtifactReceiptOpPayload;
      receipts.push({ op_id: op.op_id, actor: op.actor, ts: op.ts, kind: receipt.kind, note: receipt.note });
    }
  }

  if (!frontmatter) throw new Error(`doc-model document ${documentId} has no artifact_authored op`);

  const createdBy = parseActorRef(frontmatter.authored_by);
  const provenanceBase = finalizeEntryProvenance(
    buildProvenanceFromOpLog(opRows, {
      source: frontmatter.source_link,
      origin: "substrate",
      actor_ref: createdBy,
    }),
    createdBy,
  );
  const provenance: ArtifactProvenance = { ...provenanceBase, produced_by: [], references: [] };

  return {
    schema_version: ARTIFACT_DOCUMENT_SCHEMA_VERSION,
    document_id: doc.document_id,
    doc_type: "artifact",
    owner_agent: doc.owner_agent,
    revision: doc.revision,
    stamp: { audience: doc.audience, kind: doc.kind },
    project: doc.project,
    frontmatter,
    content,
    comments,
    receipts,
    provenance,
    op_count: opRows.length,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

/**
 * Map a doc-model projection onto the SAME canonical `ArtifactEntry` shape
 * the legacy filesystem-projected route (`GET /artifacts/entries`, see
 * outputs/entry-projection.ts) already emits. This is the "swap is a
 * data-source change, not a rewrite" seam: a console coded against
 * `ArtifactEntry[]` / `ReadModelEnvelope<ArtifactEntry>` does not change when
 * its source flips from the legacy projection to this one.
 */
export function artifactDocumentToEntry(projection: ArtifactDocumentProjection): ArtifactEntry {
  const lastRevision = projection.provenance.revisions[projection.provenance.revisions.length - 1];
  const createdBy: ActorRef = projection.provenance.contributors[0] ?? { type: "agent", id: projection.owner_agent };
  return {
    phid: projection.document_id,
    kind: "artifact",
    schema_version: 1,
    title: projection.frontmatter.title,
    body_markdown: projection.content,
    display_id: projection.document_id,
    artifact_kind: projection.frontmatter.tag ?? "artifact",
    project: projection.project,
    path: null,
    source_dispatch_phid: projection.provenance.source_dispatch_phid,
    produced_by_agent: projection.owner_agent,
    links: [],
    created_at: projection.created_at,
    created_by: createdBy,
    updated_at: projection.updated_at,
    updated_by: lastRevision?.by ?? createdBy,
    // Doc-model rows have no separate on-disk file to drift from — the DB op
    // log is the only source, so they are always "current".
    local_visual_state: localHealthVisualState("current", "artifact"),
    provenance: projection.provenance,
    stamp: projection.stamp,
  };
}

interface DocumentSummaryRow {
  document_id: string;
  updated_at: string;
}

/**
 * List document_ids matching a stamp/project filter, ordered by updated_at.
 * Queries the hoisted `doc_model_document` columns only (no op replay) — the
 * cheap index-backed pass surface routes use before projecting full content.
 */
export async function listArtifactDocumentIds(
  adapter: DbAdapter,
  teamId: string,
  filter: { audience?: EntryStampAudience; kind?: EntryStampKind; project?: string; order?: "asc" | "desc" } = {},
): Promise<string[]> {
  const clauses = ["team_id = $1", "doc_type = 'artifact'"];
  const params: unknown[] = [teamId];
  if (filter.audience) {
    params.push(filter.audience);
    clauses.push(`audience = $${params.length}`);
  }
  if (filter.kind) {
    params.push(filter.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (filter.project !== undefined) {
    params.push(filter.project);
    clauses.push(`project = $${params.length}`);
  }
  const order = filter.order === "desc" ? "DESC" : "ASC";
  const { rows } = await adapter.query<DocumentSummaryRow>(
    `SELECT document_id, updated_at FROM doc_model_document WHERE ${clauses.join(" AND ")} ORDER BY updated_at ${order}`,
    params,
  );
  return rows.map((row) => row.document_id);
}
