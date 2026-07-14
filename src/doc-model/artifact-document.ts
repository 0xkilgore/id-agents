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

export const ARTIFACT_DOCUMENT_SCHEMA_VERSION = "doc_model.artifact_document.v1" as const;

export type ArtifactDocumentOpType = "artifact_authored" | "comment_appended" | "receipt_appended";
export type ArtifactDocumentAvailability = "present" | "missing" | "unknown";
export type ArtifactDocumentReceiptKind = "approve" | "reject" | "ship_attempted" | "ship_blocked";

export interface ArtifactAuthoredOpPayload {
  title: string;
  tag: string | null;
  content: string;
  source_link: string | null;
  availability: ArtifactDocumentAvailability;
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
    now?: string;
  },
): Promise<{ inserted: boolean }> {
  const now = input.now ?? new Date().toISOString();
  const inserted = await adapter.query(
    `INSERT INTO doc_model_document (document_id, team_id, doc_type, owner_agent, revision, created_at, updated_at)
     VALUES ($1, $2, 'artifact', $3, 1, $4, $5)
     ON CONFLICT(document_id) DO NOTHING`,
    [input.documentId, input.teamId, input.ownerAgent, now, now],
  );
  if ((inserted.rowCount ?? 0) === 0) return { inserted: false };

  const payload: ArtifactAuthoredOpPayload = {
    title: input.title,
    tag: input.tag,
    content: input.content,
    source_link: input.sourceLink,
    availability: input.availability,
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
    `SELECT document_id, team_id, doc_type, owner_agent, revision, created_at, updated_at
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

  return {
    schema_version: ARTIFACT_DOCUMENT_SCHEMA_VERSION,
    document_id: doc.document_id,
    doc_type: "artifact",
    owner_agent: doc.owner_agent,
    revision: doc.revision,
    frontmatter,
    content,
    comments,
    receipts,
    op_count: opRows.length,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}
