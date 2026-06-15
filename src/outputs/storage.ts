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
  ArtifactOpRow,
  ArtifactOpType,
  ArtifactReviewStateRow,
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
      shipped_at TEXT,
      shipped_by TEXT,
      ship_blockers_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS artifact_operations (
      op_id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT,
      source_link TEXT
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS artifact_ops_by_artifact ON artifact_operations(artifact_id, op_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS artifact_ops_by_ts ON artifact_operations(ts)`);

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
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS artifacts_by_agent_time ON artifacts(agent, produced_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS artifacts_by_basename ON artifacts(basename)`);
}

// ── Catalog read/write ────────────────────────────────────────────

export async function getArtifact(
  adapter: DbAdapter,
  artifactId: string,
): Promise<ArtifactCatalogRow | null> {
  const { rows } = await adapter.query<ArtifactCatalogRow>(
    `SELECT artifact_id, basename, agent, tag, abs_path, title, produced_at,
            source, availability, created_at, updated_at
       FROM artifacts WHERE artifact_id = ?`,
    [artifactId],
  );
  return rows[0] ?? null;
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
      created_at: nowIso,
      updated_at: nowIso,
    };
    await adapter.query(
      `INSERT INTO artifacts
         (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.artifact_id, row.basename, row.agent, row.tag, row.abs_path,
        row.title, row.produced_at, row.source, row.availability,
        row.created_at, row.updated_at,
      ],
    );
    return { row, inserted: true };
  }

  // Merge: only overwrite fields the caller explicitly supplied; preserve
  // earliest produced_at (first writer wins for the canonical timestamp).
  const merged: ArtifactCatalogRow = {
    ...existing,
    basename: req.basename ?? existing.basename,
    agent: req.agent ?? existing.agent,
    tag: req.tag !== undefined ? (req.tag ?? null) : existing.tag,
    abs_path: req.abs_path ?? existing.abs_path,
    title: req.title !== undefined ? (req.title ?? null) : existing.title,
    produced_at: existing.produced_at, // first-writer wins
    source: req.source ?? existing.source,
    availability: req.availability ?? existing.availability,
    updated_at: nowIso,
  };
  await adapter.query(
    `UPDATE artifacts
       SET basename = ?, agent = ?, tag = ?, abs_path = ?, title = ?,
           source = ?, availability = ?, updated_at = ?
     WHERE artifact_id = ?`,
    [
      merged.basename, merged.agent, merged.tag, merged.abs_path, merged.title,
      merged.source, merged.availability, merged.updated_at, merged.artifact_id,
    ],
  );
  return { row: merged, inserted: false };
}

// ── Read helpers ───────────────────────────────────────────────────

export async function getReviewState(
  adapter: DbAdapter,
  artifactId: string,
): Promise<ArtifactReviewStateRow | null> {
  const { rows } = await adapter.query<ArtifactReviewStateRow>(
    `SELECT artifact_id, source_link, first_viewed_at, last_viewed_at,
            viewed_by_last, viewed_count, approved_at, approved_by,
            approval_note, shipped_at, shipped_by, ship_blockers_json,
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

export async function listOperations(
  adapter: DbAdapter,
  artifactId: string,
  limit: number,
  offset: number,
): Promise<ArtifactOpRow[]> {
  const { rows } = await adapter.query<ArtifactOpRow>(
    `SELECT op_id, artifact_id, op_type, actor, ts, payload_json, source_link
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
  };

  const params: unknown[] = [];
  let agentWhere = "";
  if (filters.agent) {
    agentWhere = " WHERE a.agent = ?";
    params.push(filters.agent);
  }
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
            a.availability AS cat_availability
       FROM artifacts a
  FULL OUTER JOIN artifact_review_state rs ON rs.artifact_id = a.artifact_id
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
          approval_note, shipped_at, shipped_by, ship_blockers_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
           approved_by = ?, approval_note = ?, shipped_at = ?,
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
): Promise<number> {
  await adapter.query(
    `INSERT INTO artifact_operations (artifact_id, op_type, actor, ts, payload_json, source_link)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [artifactId, opType, actor, nowIso, payloadJson, sourceLink],
  );
  // Return the new op_id. SQLite-style last-insert-rowid via a follow-up read.
  const { rows } = await adapter.query<{ op_id: number }>(
    `SELECT op_id FROM artifact_operations
      WHERE artifact_id = ? ORDER BY op_id DESC LIMIT 1`,
    [artifactId],
  );
  return Number(rows[0]?.op_id ?? 0);
}
