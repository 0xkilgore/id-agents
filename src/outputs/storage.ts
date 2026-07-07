// Kapelle B11 manager-side backend foundation — outputs/storage.ts
//
// DDL + CRUD for three SQLite tables:
//   - artifact_review_state    (one row per artifact; lazily created)
//   - artifact_operations      (append-only audit log)
//   - artifacts                (catalog: title, basename, agent, produced_at, abs_path)
//
// All tables carry `source_link` / `source` so the manager projection can
// be rebuilt from upstream truth (delivery-log / Reactor / agent-done
// callbacks) if drift is detected.

import { createHash } from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type {
  ArtifactAvailability,
  ArtifactCatalogRow,
  ArtifactDraftRow,
  ArtifactOpRow,
  ArtifactOpType,
  ArtifactReviewStateRow,
  ArtifactSourceEvidenceRow,
  CaneDraftPayload,
  OutputsInboxRow,
  RegisterArtifactRequest,
} from "./types.js";

// Derive a stable artifact_id from an absolute path. Same path → same id,
// across machines and across days. Used by /deliver, /agent-done, and the
// delivery-log backfill so all writers converge on one id per artifact.
export function artifactIdFromPath(absPath: string): string {
  const h = createHash("sha256").update(absPath).digest("hex").slice(0, 16);
  return `art-${h}`;
}

// ── DDL (idempotent) ───────────────────────────────────────────────

export async function migrateOutputsTables(adapter: DbAdapter): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS artifact_review_state (
      artifact_id TEXT PRIMARY KEY,
      source_link TEXT,
      first_viewed_at TEXT,
      last_viewed_at TEXT,
      viewed_by_last TEXT,
      viewed_count INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      approved_by TEXT,
      approval_note TEXT,
      rejected_at TEXT,
      rejected_by TEXT,
      reject_note TEXT,
      shipped_at TEXT,
      shipped_by TEXT,
      ship_blockers_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // T3B-1 reject columns — additive for databases created before reject existed.
  for (const col of ['rejected_at TEXT', 'rejected_by TEXT', 'reject_note TEXT']) {
    try {
      await exec(`ALTER TABLE artifact_review_state ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  await exec(`
    CREATE TABLE IF NOT EXISTS artifact_operations (
      op_id ${autoIncrementPrimaryKey},
      artifact_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT,
      source_link TEXT,
      idempotency_key TEXT
    )
  `);

  try {
    await exec(`ALTER TABLE artifact_operations ADD COLUMN idempotency_key TEXT`);
  } catch {
    /* column already exists */
  }
  await exec(`CREATE INDEX IF NOT EXISTS artifact_ops_by_artifact ON artifact_operations(artifact_id, op_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS artifact_ops_by_ts ON artifact_operations(ts)`);
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS artifact_ops_idempotency ON artifact_operations(artifact_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

  await exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id   TEXT PRIMARY KEY,
      basename      TEXT NOT NULL,
      agent         TEXT NOT NULL,
      tag           TEXT,
      abs_path      TEXT NOT NULL,
      title         TEXT,
      produced_at   TEXT NOT NULL,
      source        TEXT NOT NULL,
      availability  TEXT NOT NULL DEFAULT 'present',
      source_badges TEXT NOT NULL DEFAULT '[]',
      reconciled_at TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS artifacts_by_agent_time ON artifacts(agent, produced_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS artifacts_by_basename ON artifacts(basename)`);

  // T11.7 — accessibility columns (additive for databases created before NW-6).
  for (const col of ["source_badges TEXT NOT NULL DEFAULT '[]'", "reconciled_at TEXT"]) {
    try {
      await exec(`ALTER TABLE artifacts ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  await exec(`
    CREATE TABLE IF NOT EXISTS artifact_source_evidence (
      evidence_id   TEXT PRIMARY KEY,
      artifact_id   TEXT NOT NULL,
      source        TEXT NOT NULL,
      source_ref    TEXT NOT NULL,
      observed_at   TEXT NOT NULL,
      metadata_json TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS artifact_source_evidence_by_artifact ON artifact_source_evidence(artifact_id, source, observed_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS artifact_source_evidence_by_source_ref ON artifact_source_evidence(source, source_ref)`);

  // CANE_DRAFT_ARTIFACTS — typed draft payload side-table, keyed by artifact_id
  // (one draft per artifact). draft_id is UNIQUE so a re-poll/re-register of the
  // same Cane draft is an idempotent upsert, never a duplicate row.
  await exec(`
    CREATE TABLE IF NOT EXISTS artifact_drafts (
      artifact_id  TEXT PRIMARY KEY,
      draft_id     TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
  await exec(`CREATE INDEX IF NOT EXISTS artifact_drafts_by_draft_id ON artifact_drafts(draft_id)`);

  // L-1/L-2 — full-text search over the doc-model substrate (SQLite FTS5).
  // An external-content FTS5 index over `artifacts` (indexes the human-meaningful
  // text: title, basename, tag, agent) with triggers that keep it in sync on
  // insert/update/delete, so the existing write path (registerArtifact) is
  // untouched. `('rebuild')` backfills rows that predate the index. FTS5 is
  // SQLite-only; on any other dialect search degrades to no-op (see
  // searchArtifacts), so the index is created only under sqlite.
  if (adapter.dialect === "sqlite") {
    await exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
        title, basename, tag, agent,
        content='artifacts', content_rowid='rowid'
      );
    `);
    await exec(`
      CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
        INSERT INTO artifacts_fts(rowid, title, basename, tag, agent)
        VALUES (new.rowid, new.title, new.basename, new.tag, new.agent);
      END;
    `);
    await exec(`
      CREATE TRIGGER IF NOT EXISTS artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
        INSERT INTO artifacts_fts(artifacts_fts, rowid, title, basename, tag, agent)
        VALUES ('delete', old.rowid, old.title, old.basename, old.tag, old.agent);
      END;
    `);
    await exec(`
      CREATE TRIGGER IF NOT EXISTS artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
        INSERT INTO artifacts_fts(artifacts_fts, rowid, title, basename, tag, agent)
        VALUES ('delete', old.rowid, old.title, old.basename, old.tag, old.agent);
        INSERT INTO artifacts_fts(rowid, title, basename, tag, agent)
        VALUES (new.rowid, new.title, new.basename, new.tag, new.agent);
      END;
    `);
    // Backfill existing artifacts (idempotent — rebuild reconstructs from content).
    await exec(`INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')`);
  }
}

// ── Catalog read/write ────────────────────────────────────────────

export async function getArtifact(
  adapter: DbAdapter,
  artifactId: string,
): Promise<ArtifactCatalogRow | null> {
  const { rows } = await adapter.query<ArtifactCatalogRow>(
    `SELECT artifact_id, basename, agent, tag, abs_path, title, produced_at,
            source, availability, source_badges, reconciled_at, created_at, updated_at
       FROM artifacts WHERE artifact_id = ?`,
    [artifactId],
  );
  return rows[0] ?? null;
}

/** Filters for the artifacts catalog feed (GET /artifacts/entries). */
export interface ArtifactCatalogFilters {
  limit?: number;
  offset?: number;
  agent?: string;
  tag?: string;
  /** ISO timestamp; rows with produced_at >= since. */
  since?: string;
}

/**
 * List artifacts catalog rows, newest-first by produced_at. The substrate read
 * path for GET /artifacts/entries — pure SQL, no filesystem access. Bounded to
 * 500 rows per call (default 50).
 */
export async function listArtifactCatalog(
  adapter: DbAdapter,
  filters: ArtifactCatalogFilters = {},
): Promise<ArtifactCatalogRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.agent) {
    where.push("agent = ?");
    params.push(filters.agent);
  }
  if (filters.tag) {
    where.push("tag = ?");
    params.push(filters.tag);
  }
  if (filters.since) {
    where.push("produced_at >= ?");
    params.push(filters.since);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 10_000);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);
  const { rows } = await adapter.query<ArtifactCatalogRow>(
    `SELECT artifact_id, basename, agent, tag, abs_path, title, produced_at,
            source, availability, source_badges, reconciled_at, created_at, updated_at
       FROM artifacts${whereSql}
   ORDER BY produced_at DESC
      LIMIT ? OFFSET ?`,
    params,
  );
  return rows;
}

/**
 * Build a safe FTS5 MATCH expression from raw user input. Only Unicode
 * letter/number runs survive (every FTS5 operator/quote is stripped, so the
 * input can never break the MATCH syntax), each becomes a prefix term, ANDed
 * together. Returns null when the input has no searchable tokens.
 */
export function toFtsMatch(raw: string): string | null {
  const tokens = (raw.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(" ");
}

/**
 * Full-text search over the artifacts substrate (SQLite FTS5, L-1/L-2), ranked
 * by bm25 (best match first). Returns catalog rows for the matches. Degrades to
 * [] on a non-sqlite dialect or when the query has no searchable tokens.
 */
export async function searchArtifacts(
  adapter: DbAdapter,
  query: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ArtifactCatalogRow[]> {
  if (adapter.dialect !== "sqlite") return [];
  const match = toFtsMatch(query);
  if (!match) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { rows } = await adapter.query<ArtifactCatalogRow>(
    `SELECT a.artifact_id, a.basename, a.agent, a.tag, a.abs_path, a.title, a.produced_at,
            a.source, a.availability, a.source_badges, a.reconciled_at, a.created_at, a.updated_at
       FROM artifacts_fts
       JOIN artifacts a ON a.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH ?
   ORDER BY bm25(artifacts_fts)
      LIMIT ? OFFSET ?`,
    [match, limit, offset],
  );
  return rows;
}

export async function registerArtifact(
  adapter: DbAdapter,
  req: RegisterArtifactRequest,
  nowIso: string,
): Promise<{ row: ArtifactCatalogRow; inserted: boolean }> {
  const artifactId = req.artifact_id ?? artifactIdFromPath(req.abs_path);
  const existing = await getArtifact(adapter, artifactId);
  const availability: ArtifactAvailability = req.availability ?? "present";
  const source = req.source ?? "agent-done";

  const sourceBadges = JSON.stringify(req.source_badges ?? [source]);
  const reconciledAt = req.reconciled_at ?? null;

  if (!existing) {
    const row: ArtifactCatalogRow = {
      artifact_id: artifactId,
      basename: req.basename,
      agent: req.agent,
      tag: req.tag ?? null,
      abs_path: req.abs_path,
      title: req.title ?? null,
      produced_at: req.produced_at,
      source,
      availability,
      source_badges: sourceBadges,
      reconciled_at: reconciledAt,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await adapter.query(
      `INSERT INTO artifacts
         (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, source_badges, reconciled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.artifact_id, row.basename, row.agent, row.tag, row.abs_path,
        row.title, row.produced_at, row.source, row.availability,
        row.source_badges, row.reconciled_at, row.created_at, row.updated_at,
      ],
    );
    return { row, inserted: true };
  }

  // Merge: only overwrite fields the caller explicitly supplied; preserve
  // earliest produced_at (first writer wins for the canonical timestamp).
  //
  // Filesystem reconciliation is evidence, not stronger provenance. If an
  // artifact was already cataloged by /agent-done, delivery-log, or manual
  // /artifacts/register, seeing the same file on disk must not rewrite the
  // catalog source to "filesystem".
  const nextSource =
    req.source === "filesystem" && existing.source !== "filesystem"
      ? existing.source
      : req.source ?? existing.source;
  // Union the source badges: every source that has ever observed this artifact.
  const existingBadges = parseBadges(existing.source_badges);
  const incomingBadges = req.source_badges ?? [source];
  const mergedBadges = [...new Set([...existingBadges, ...incomingBadges])].sort();

  const merged: ArtifactCatalogRow = {
    ...existing,
    basename: req.basename ?? existing.basename,
    agent: req.agent ?? existing.agent,
    tag: req.tag !== undefined ? (req.tag ?? null) : existing.tag,
    abs_path: req.abs_path ?? existing.abs_path,
    title: req.title !== undefined ? (req.title ?? null) : existing.title,
    produced_at: existing.produced_at, // first-writer wins
    source: nextSource,
    availability: req.availability ?? existing.availability,
    source_badges: JSON.stringify(mergedBadges),
    reconciled_at: req.reconciled_at ?? existing.reconciled_at,
    updated_at: nowIso,
  };
  await adapter.query(
    `UPDATE artifacts
       SET basename = ?, agent = ?, tag = ?, abs_path = ?, title = ?,
           source = ?, availability = ?, source_badges = ?, reconciled_at = ?, updated_at = ?
     WHERE artifact_id = ?`,
    [
      merged.basename, merged.agent, merged.tag, merged.abs_path, merged.title,
      merged.source, merged.availability, merged.source_badges, merged.reconciled_at,
      merged.updated_at, merged.artifact_id,
    ],
  );
  return { row: merged, inserted: false };
}

function parseBadges(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Catalog rows sourced from the filesystem — the set the missing-sweep checks. */
export async function listFilesystemArtifacts(
  adapter: DbAdapter,
): Promise<Array<{ artifact_id: string; abs_path: string; availability: string }>> {
  const { rows } = await adapter.query<{ artifact_id: string; abs_path: string; availability: string }>(
    `SELECT artifact_id, abs_path, availability FROM artifacts WHERE source = 'filesystem'`,
  );
  return rows;
}

/** Set an artifact's availability (present/missing/unknown) + reconciled_at.
 *  The fix for "missing artifact shows 404": a vanished file becomes
 *  availability='missing' instead of disappearing/404ing. */
export async function setArtifactAvailability(
  adapter: DbAdapter,
  artifactId: string,
  availability: ArtifactAvailability,
  reconciledAt: string,
): Promise<void> {
  await adapter.query(
    `UPDATE artifacts SET availability = ?, reconciled_at = ?, updated_at = ? WHERE artifact_id = ?`,
    [availability, reconciledAt, reconciledAt, artifactId],
  );
}

export function evidenceIdForSource(source: string, sourceRef: string): string {
  const h = createHash("sha256").update(`${source}\0${sourceRef}`).digest("hex").slice(0, 24);
  return `artev-${h}`;
}

export async function upsertArtifactSourceEvidence(
  adapter: DbAdapter,
  input: {
    artifact_id: string;
    source: ArtifactSourceEvidenceRow["source"];
    source_ref: string;
    observed_at: string;
    metadata_json?: string | null;
  },
  nowIso: string,
): Promise<{ row: ArtifactSourceEvidenceRow; inserted: boolean }> {
  const evidenceId = evidenceIdForSource(input.source, input.source_ref);
  const { rows } = await adapter.query<ArtifactSourceEvidenceRow>(
    `SELECT evidence_id, artifact_id, source, source_ref, observed_at,
            metadata_json, created_at, updated_at
       FROM artifact_source_evidence
      WHERE evidence_id = ?`,
    [evidenceId],
  );
  const existing = rows[0] ?? null;
  const metadataJson = input.metadata_json ?? null;
  if (!existing) {
    const row: ArtifactSourceEvidenceRow = {
      evidence_id: evidenceId,
      artifact_id: input.artifact_id,
      source: input.source,
      source_ref: input.source_ref,
      observed_at: input.observed_at,
      metadata_json: metadataJson,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await adapter.query(
      `INSERT INTO artifact_source_evidence
         (evidence_id, artifact_id, source, source_ref, observed_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.evidence_id,
        row.artifact_id,
        row.source,
        row.source_ref,
        row.observed_at,
        row.metadata_json,
        row.created_at,
        row.updated_at,
      ],
    );
    return { row, inserted: true };
  }

  const row: ArtifactSourceEvidenceRow = {
    ...existing,
    artifact_id: input.artifact_id,
    observed_at: input.observed_at,
    metadata_json: metadataJson,
    updated_at: nowIso,
  };
  await adapter.query(
    `UPDATE artifact_source_evidence
        SET artifact_id = ?, observed_at = ?, metadata_json = ?, updated_at = ?
      WHERE evidence_id = ?`,
    [row.artifact_id, row.observed_at, row.metadata_json, row.updated_at, row.evidence_id],
  );
  return { row, inserted: false };
}

export async function listArtifactSourceEvidence(
  adapter: DbAdapter,
  artifactId: string,
): Promise<ArtifactSourceEvidenceRow[]> {
  const { rows } = await adapter.query<ArtifactSourceEvidenceRow>(
    `SELECT evidence_id, artifact_id, source, source_ref, observed_at,
            metadata_json, created_at, updated_at
       FROM artifact_source_evidence
      WHERE artifact_id = ?
   ORDER BY observed_at DESC, evidence_id ASC`,
    [artifactId],
  );
  return rows;
}

// ── Cane draft side-table (CANE_DRAFT_ARTIFACTS) ───────────────────

/** Read the typed draft payload for an artifact, or null. */
export async function getArtifactDraft(
  adapter: DbAdapter,
  artifactId: string,
): Promise<ArtifactDraftRow | null> {
  const { rows } = await adapter.query<ArtifactDraftRow>(
    `SELECT artifact_id, draft_id, payload_json, created_at, updated_at
       FROM artifact_drafts WHERE artifact_id = ?`,
    [artifactId],
  );
  return rows[0] ?? null;
}

/** Read a draft row by its stable draft_id (the idempotency anchor), or null. */
export async function getArtifactDraftByDraftId(
  adapter: DbAdapter,
  draftId: string,
): Promise<ArtifactDraftRow | null> {
  const { rows } = await adapter.query<ArtifactDraftRow>(
    `SELECT artifact_id, draft_id, payload_json, created_at, updated_at
       FROM artifact_drafts WHERE draft_id = ?`,
    [draftId],
  );
  return rows[0] ?? null;
}

/** Parse a draft row's payload_json into a typed CaneDraftPayload, or null on
 *  a malformed payload (never throws — the caller treats null as "no draft"). */
export function parseDraftPayload(row: ArtifactDraftRow | null): CaneDraftPayload | null {
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload_json) as CaneDraftPayload;
    if (!Array.isArray(p.revision_history)) p.revision_history = [];
    return p;
  } catch {
    return null;
  }
}

/** Idempotent upsert of a cane_draft payload keyed by artifact_id. The draft_id
 *  is UNIQUE; re-registering the same draft_id updates the payload in place
 *  rather than inserting a duplicate. created_at is set once; updated_at bumps. */
export async function upsertArtifactDraft(
  adapter: DbAdapter,
  artifactId: string,
  payload: CaneDraftPayload,
  nowIso: string,
): Promise<{ row: ArtifactDraftRow; inserted: boolean }> {
  const existing = await getArtifactDraft(adapter, artifactId);
  const payloadJson = JSON.stringify(payload);
  if (!existing) {
    const row: ArtifactDraftRow = {
      artifact_id: artifactId,
      draft_id: payload.draft_id,
      payload_json: payloadJson,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await adapter.query(
      `INSERT INTO artifact_drafts (artifact_id, draft_id, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.artifact_id, row.draft_id, row.payload_json, row.created_at, row.updated_at],
    );
    return { row, inserted: true };
  }
  const row: ArtifactDraftRow = {
    ...existing,
    draft_id: payload.draft_id,
    payload_json: payloadJson,
    updated_at: nowIso,
  };
  await adapter.query(
    `UPDATE artifact_drafts SET draft_id = ?, payload_json = ?, updated_at = ?
      WHERE artifact_id = ?`,
    [row.draft_id, row.payload_json, row.updated_at, row.artifact_id],
  );
  return { row, inserted: false };
}

// ── Read helpers ───────────────────────────────────────────────────

export async function getReviewState(
  adapter: DbAdapter,
  artifactId: string,
): Promise<ArtifactReviewStateRow | null> {
  const { rows } = await adapter.query<ArtifactReviewStateRow>(
    `SELECT artifact_id, source_link, first_viewed_at, last_viewed_at,
            viewed_by_last, viewed_count, approved_at, approved_by,
            approval_note, rejected_at, rejected_by, reject_note,
            shipped_at, shipped_by, ship_blockers_json,
            created_at, updated_at
       FROM artifact_review_state
      WHERE artifact_id = ?`,
    [artifactId],
  );
  return rows[0] ?? null;
}

export async function countOperations(
  adapter: DbAdapter,
  artifactId: string,
): Promise<number> {
  const { rows } = await adapter.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM artifact_operations WHERE artifact_id = ?`,
    [artifactId],
  );
  return Number(rows[0]?.cnt ?? 0);
}

/** Most-recent operation of any of the given types by a given actor on an
 *  artifact, or null. Used for the T3B-1 per-(artifact,action,actor) cooldown. */
export async function getLastOperationByActor(
  adapter: DbAdapter,
  artifactId: string,
  opTypes: ArtifactOpType[],
  actor: string,
): Promise<ArtifactOpRow | null> {
  if (opTypes.length === 0) return null;
  const placeholders = opTypes.map(() => '?').join(',');
  const { rows } = await adapter.query<ArtifactOpRow>(
    `SELECT op_id, artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key
       FROM artifact_operations
      WHERE artifact_id = ? AND actor = ? AND op_type IN (${placeholders})
      ORDER BY op_id DESC LIMIT 1`,
    [artifactId, actor, ...opTypes],
  );
  return rows[0] ?? null;
}

export async function listOperations(
  adapter: DbAdapter,
  artifactId: string,
  limit: number,
  offset: number,
): Promise<ArtifactOpRow[]> {
  const { rows } = await adapter.query<ArtifactOpRow>(
    `SELECT op_id, artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key
       FROM artifact_operations
      WHERE artifact_id = ?
   ORDER BY op_id ASC
      LIMIT ? OFFSET ?`,
    [artifactId, limit, offset],
  );
  return rows;
}

export interface InboxFilters {
  status?: OutputsInboxRow["status"];
  agent?: string;
  // CANE_DRAFT_ARTIFACTS: when "cane_draft", restrict the inbox to cane_draft
  // artifacts (those with an artifact_drafts row) AND drop the shipped ones —
  // a sent draft cannot re-surface (the approve-once-handled invariant).
  kind?: "cane_draft";
  // when true (default), include artifacts that have no review row yet
  // (i.e. never_viewed via projection). On a small/early instance we
  // primarily care about *recorded* state, so this flag exists for
  // future when an upstream backfill populates rows without ops.
  includeNeverViewed?: boolean;
}

// Listing the operator's "inbox" — artifacts needing attention.
//
// FULL OUTER JOIN of the artifacts catalog (basename/agent/produced_at/title)
// and artifact_review_state (operator interaction state) so BOTH sides are
// visible: a catalog-only artifact with no review row shows as never_viewed
// (W1-6), and a review row with no catalog entry still returns with
// availability "unknown". includeNeverViewed:false (non-default) drops the
// catalog-only never_viewed rows.
//
// The `agent` filter, when supplied, restricts to rows whose joined
// catalog row has that agent. Rows with no catalog row are excluded when
// `agent` filtering is active (we can't know what agent produced them).
export async function listInboxItems(
  adapter: DbAdapter,
  filters: InboxFilters,
  limit: number,
  offset: number,
): Promise<OutputsInboxRow[]> {
  type JoinRow = ArtifactReviewStateRow & {
    cat_basename: string | null;
    cat_agent: string | null;
    cat_tag: string | null;
    cat_abs_path: string | null;
    cat_title: string | null;
    cat_produced_at: string | null;
    cat_availability: ArtifactAvailability | null;
    cane_draft_id: string | null;
  };

  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.agent) {
    where.push("a.agent = ?");
    params.push(filters.agent);
  }
  if (filters.kind === "cane_draft") {
    // Only cane_draft artifacts, and never a shipped one (cannot re-surface).
    where.push("d.draft_id IS NOT NULL");
    where.push("rs.shipped_at IS NULL");
  }
  const agentWhere = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  params.push(Math.min(limit, 500), offset);

  // W1-6: FULL OUTER JOIN so the inbox surfaces BOTH sides of the catalog ↔
  // review-state relationship: an artifact with no review row yet (catalog-
  // only → never_viewed) AND a review row with no catalog entry (availability
  // unknown). The previous query drove off artifact_review_state, so a
  // catalog-only artifact was invisible even with includeNeverViewed:true.
  // artifact_id is coalesced because either side may be NULL for a given row.
  const { rows: joined } = await adapter.query<JoinRow>(
    `SELECT COALESCE(rs.artifact_id, a.artifact_id) AS artifact_id,
            rs.source_link, rs.first_viewed_at, rs.last_viewed_at,
            rs.viewed_by_last, rs.viewed_count, rs.approved_at, rs.approved_by,
            rs.approval_note, rs.shipped_at, rs.shipped_by, rs.ship_blockers_json,
            rs.created_at, rs.updated_at,
            a.basename     AS cat_basename,
            a.agent        AS cat_agent,
            a.tag          AS cat_tag,
            a.abs_path     AS cat_abs_path,
            a.title        AS cat_title,
            a.produced_at  AS cat_produced_at,
            a.availability AS cat_availability,
            d.draft_id     AS cane_draft_id
       FROM artifacts a
  FULL OUTER JOIN artifact_review_state rs ON rs.artifact_id = a.artifact_id
  LEFT JOIN artifact_drafts d ON d.artifact_id = COALESCE(rs.artifact_id, a.artifact_id)
       ${agentWhere}
   ORDER BY COALESCE(rs.updated_at, a.produced_at) DESC
      LIMIT ? OFFSET ?`,
    params,
  );

  // Default includes never_viewed (catalog-only) rows; explicit false excludes
  // them (mirrors the existing post-LIMIT status filter below).
  const includeNeverViewed = filters.includeNeverViewed !== false;

  const items: OutputsInboxRow[] = [];
  for (const r of joined) {
    const status = deriveStatus(r);
    if (filters.status && status !== filters.status) continue;
    if (!includeNeverViewed && status === "never_viewed") continue;
    const { rows: opAgg } = await adapter.query<{ cnt: number; last_ts: string | null }>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS last_ts
         FROM artifact_operations WHERE artifact_id = ?`,
      [r.artifact_id],
    );
    const availability: ArtifactAvailability = r.cat_availability ?? "unknown";
    items.push({
      artifact_id: r.artifact_id,
      source_link: r.source_link,
      title: r.cat_title,
      basename: r.cat_basename,
      agent: r.cat_agent,
      produced_at: r.cat_produced_at,
      abs_path: r.cat_abs_path,
      tag: r.cat_tag,
      availability,
      status,
      first_viewed_at: r.first_viewed_at,
      approved_at: r.approved_at,
      shipped_at: r.shipped_at,
      ship_blockers_json: r.ship_blockers_json,
      op_count: Number(opAgg[0]?.cnt ?? 0),
      last_op_at: opAgg[0]?.last_ts ?? null,
    });
  }
  return items;
}

// One-shot backfill: parse ~/Dropbox/Code/cane/taskview/delivery-log.md and
// upsert every row into the artifacts catalog. Idempotent on re-run.
//
// Format expected (one row per line, pipe-separated):
//   <ISO-ts> | <agent> | <tag> | <basename> | <abs_path> | "<tl_dr>"
//
// Skips comment lines (#) and rows that fail to parse. Caller passes the
// file contents — keeps the function pure and easy to test.
export interface BackfillResult {
  rows_seen: number;
  rows_parsed: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Quote-aware pipe splitter — unified with kapelle-site
 * app/ops/_lib/artifactAdapter.ts `splitPipeLine` (W1-7). A `|` inside double
 * quotes does not split the field, and an escaped quote (\") does not toggle
 * quote state. Each field is trimmed. Replaces the naive `line.split("|")`,
 * which corrupted positional columns when any field contained a pipe.
 */
export function splitPipeLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const prev = line[index - 1];
    if (char === '"' && prev !== "\\") inQuote = !inQuote;
    if (char === "|" && !inQuote) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

export async function backfillCatalogFromDeliveryLog(
  adapter: DbAdapter,
  deliveryLogText: string,
  nowIso: string,
): Promise<BackfillResult> {
  const out: BackfillResult = { rows_seen: 0, rows_parsed: 0, inserted: 0, updated: 0, skipped: 0 };
  for (const rawLine of deliveryLogText.split("\n")) {
    out.rows_seen++;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      out.skipped++;
      continue;
    }
    // Quote-aware pipe split (W1-7): a `|` inside a quoted field no longer
    // misaligns the positional columns. Take the first 5 fields, tl_dr is the
    // remainder.
    const parts = splitPipeLine(line);
    if (parts.length < 5) {
      out.skipped++;
      continue;
    }
    const [ts, agent, tag, basename, absPath, ...rest] = parts;
    if (!ts || !agent || !basename || !absPath) {
      out.skipped++;
      continue;
    }
    let title: string | null = rest.join("|").trim() || null;
    if (title?.startsWith('"') && title.endsWith('"')) {
      title = title.slice(1, -1);
    }
    out.rows_parsed++;
    const { inserted } = await registerArtifact(
      adapter,
      {
        basename,
        agent,
        tag: tag === "-" ? undefined : tag,
        abs_path: absPath,
        title: title || undefined,
        produced_at: ts,
        source: "delivery-log",
        availability: "present",
      },
      nowIso,
    );
    if (inserted) out.inserted++;
    else out.updated++;
  }
  return out;
}

export function deriveStatus(row: ArtifactReviewStateRow): OutputsInboxRow["status"] {
  if (row.shipped_at) return "shipped";
  if (row.ship_blockers_json) return "ship_blocked";
  if (row.approved_at) return "approved";
  if (row.first_viewed_at) return "viewed";
  return "never_viewed";
}

// ── Write helpers ──────────────────────────────────────────────────

// Idempotent upsert of the review-state row. Updates only the fields
// passed in patch; preserves everything else. created_at is set once;
// updated_at is bumped every call.
export async function upsertReviewState(
  adapter: DbAdapter,
  artifactId: string,
  patch: Partial<ArtifactReviewStateRow>,
  nowIso: string,
): Promise<ArtifactReviewStateRow> {
  const existing = await getReviewState(adapter, artifactId);
  if (!existing) {
    // Lazy create. Fill in patch values; everything else is null/0.
    const row: ArtifactReviewStateRow = {
      artifact_id: artifactId,
      source_link: patch.source_link ?? null,
      first_viewed_at: patch.first_viewed_at ?? null,
      last_viewed_at: patch.last_viewed_at ?? null,
      viewed_by_last: patch.viewed_by_last ?? null,
      viewed_count: patch.viewed_count ?? 0,
      approved_at: patch.approved_at ?? null,
      approved_by: patch.approved_by ?? null,
      approval_note: patch.approval_note ?? null,
      rejected_at: patch.rejected_at ?? null,
      rejected_by: patch.rejected_by ?? null,
      reject_note: patch.reject_note ?? null,
      shipped_at: patch.shipped_at ?? null,
      shipped_by: patch.shipped_by ?? null,
      ship_blockers_json: patch.ship_blockers_json ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await adapter.query(
      `INSERT INTO artifact_review_state
         (artifact_id, source_link, first_viewed_at, last_viewed_at,
          viewed_by_last, viewed_count, approved_at, approved_by,
          approval_note, rejected_at, rejected_by, reject_note,
          shipped_at, shipped_by, ship_blockers_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.artifact_id,
        row.source_link,
        row.first_viewed_at,
        row.last_viewed_at,
        row.viewed_by_last,
        row.viewed_count,
        row.approved_at,
        row.approved_by,
        row.approval_note,
        row.rejected_at,
        row.rejected_by,
        row.reject_note,
        row.shipped_at,
        row.shipped_by,
        row.ship_blockers_json,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }
  // Merge patch onto existing.
  const merged: ArtifactReviewStateRow = {
    ...existing,
    ...patch,
    artifact_id: existing.artifact_id,
    created_at: existing.created_at,
    updated_at: nowIso,
  };
  await adapter.query(
    `UPDATE artifact_review_state
       SET source_link = ?, first_viewed_at = ?, last_viewed_at = ?,
           viewed_by_last = ?, viewed_count = ?, approved_at = ?,
           approved_by = ?, approval_note = ?, rejected_at = ?,
           rejected_by = ?, reject_note = ?, shipped_at = ?,
           shipped_by = ?, ship_blockers_json = ?, updated_at = ?
     WHERE artifact_id = ?`,
    [
      merged.source_link,
      merged.first_viewed_at,
      merged.last_viewed_at,
      merged.viewed_by_last,
      merged.viewed_count,
      merged.approved_at,
      merged.approved_by,
      merged.approval_note,
      merged.rejected_at,
      merged.rejected_by,
      merged.reject_note,
      merged.shipped_at,
      merged.shipped_by,
      merged.ship_blockers_json,
      merged.updated_at,
      merged.artifact_id,
    ],
  );
  return merged;
}

export async function appendOperation(
  adapter: DbAdapter,
  artifactId: string,
  opType: ArtifactOpType,
  actor: string,
  nowIso: string,
  payloadJson: string | null,
  sourceLink: string | null,
  idempotencyKey?: string | null,
): Promise<number> {
  const normalizedKey = idempotencyKey?.trim() || null;
  if (normalizedKey) {
    const { rows } = await adapter.query<{ op_id: number }>(
      `SELECT op_id FROM artifact_operations
        WHERE artifact_id = ? AND idempotency_key = ?
        ORDER BY op_id ASC LIMIT 1`,
      [artifactId, normalizedKey],
    );
    if (rows[0]) return Number(rows[0].op_id);
  }
  await adapter.query(
    `INSERT INTO artifact_operations (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [artifactId, opType, actor, nowIso, payloadJson, sourceLink, normalizedKey],
  );
  // Return the new op_id. SQLite-style last-insert-rowid via a follow-up read.
  const { rows } = await adapter.query<{ op_id: number }>(
    `SELECT op_id FROM artifact_operations
      WHERE artifact_id = ? ORDER BY op_id DESC LIMIT 1`,
    [artifactId],
  );
  return Number(rows[0]?.op_id ?? 0);
}
