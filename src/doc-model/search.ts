// DV3 — unified full-text search over the SQLite doc-model substrate.

import type { DbAdapter } from "../db/db-adapter.js";
import { toFtsMatch } from "../outputs/storage.js";

export const DOC_MODEL_SEARCH_DEFAULT_LIMIT = 50;
export const DOC_MODEL_SEARCH_MAX_LIMIT = 500;

export type DocModelSearchKind = "artifact" | "desk_item" | "task";

export const DOC_MODEL_SEARCH_KINDS: readonly DocModelSearchKind[] = [
  "artifact",
  "desk_item",
  "task",
] as const;

/**
 * RD-009: doc-model search (artifacts_fts/desk_items_fts/tasks_fts) is
 * SQLite FTS5-only today — the artifact/desk_item tables don't exist in the
 * Postgres schema at all. A Postgres-backed deployment used to get
 * `{ items: [] }` back from every query, indistinguishable from "no rows
 * matched." Surface that as an explicit, typed error instead of a masked
 * empty result.
 */
export class DocModelSearchUnsupportedError extends Error {
  constructor(dialect: string) {
    super(
      `doc-model search is not implemented for the '${dialect}' backend yet (RD-009) — ` +
        'artifacts/desk_items/tasks full-text search is SQLite FTS5-only.',
    );
    this.name = 'DocModelSearchUnsupportedError';
  }
}

export interface DocModelSearchHit {
  kind: DocModelSearchKind;
  phid: string;
  title: string;
  display_id: string | null;
  /** bm25 rank — lower is a better match (SQLite FTS5 convention). */
  score: number;
  updated_at: string;
}

function epochToIso(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function toPostgresTsQuery(raw: string): string | null {
  const tokens = (raw.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) return null;
  return tokens.map((token) => `${token}:*`).join(" & ");
}

function parseKinds(raw: string | null | undefined): DocModelSearchKind[] | null {
  if (!raw) return null;
  const allowed = new Set<string>(DOC_MODEL_SEARCH_KINDS);
  const kinds = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part): part is DocModelSearchKind => allowed.has(part));
  return kinds.length > 0 ? kinds : null;
}

export function parseDocModelSearchKinds(raw: string | null | undefined): DocModelSearchKind[] | null {
  return parseKinds(raw);
}

async function searchArtifactHits(
  adapter: DbAdapter,
  match: string,
  limit: number,
): Promise<DocModelSearchHit[]> {
  if (adapter.dialect === "postgres") {
    const { rows } = await adapter.query<{
      phid: string;
      title: string;
      display_id: string;
      score: number;
      updated_at: string;
    }>(
      `WITH q AS (SELECT to_tsquery('simple', $1) AS query)
       SELECT a.artifact_id AS phid,
              COALESCE(a.title, a.basename) AS title,
              a.basename AS display_id,
              -ts_rank_cd(
                to_tsvector('simple',
                  COALESCE(a.title, '') || ' ' || a.basename || ' ' || COALESCE(a.tag, '') || ' ' || a.agent
                ),
                q.query
              ) AS score,
              a.produced_at AS updated_at
         FROM artifacts a, q
        WHERE to_tsvector('simple',
                COALESCE(a.title, '') || ' ' || a.basename || ' ' || COALESCE(a.tag, '') || ' ' || a.agent
              ) @@ q.query
     ORDER BY score ASC, a.produced_at ASC, a.artifact_id ASC
        LIMIT $2`,
      [match, limit],
    );
    return rows.map((row) => ({
      kind: "artifact",
      phid: row.phid,
      title: row.title,
      display_id: row.display_id,
      score: row.score,
      updated_at: row.updated_at,
    }));
  }

  const { rows } = await adapter.query<{
    phid: string;
    title: string;
    display_id: string;
    score: number;
    updated_at: string;
  }>(
    `SELECT a.artifact_id AS phid,
            COALESCE(a.title, a.basename) AS title,
            a.basename AS display_id,
            bm25(artifacts_fts) AS score,
            a.produced_at AS updated_at
       FROM artifacts_fts
       JOIN artifacts a ON a.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH ?
   ORDER BY bm25(artifacts_fts)
      LIMIT ?`,
    [match, limit],
  );
  return rows.map((row) => ({
    kind: "artifact",
    phid: row.phid,
    title: row.title,
    display_id: row.display_id,
    score: row.score,
    updated_at: row.updated_at,
  }));
}

async function searchDeskHits(
  adapter: DbAdapter,
  match: string,
  limit: number,
): Promise<DocModelSearchHit[]> {
  if (adapter.dialect === "postgres") {
    const { rows } = await adapter.query<{
      phid: string;
      title: string;
      score: number;
      updated_at: string;
    }>(
      `WITH q AS (SELECT to_tsquery('simple', $1) AS query)
       SELECT d.desk_item_id AS phid,
              d.label AS title,
              -ts_rank_cd(
                to_tsvector('simple',
                  d.label || ' ' || d.body_md || ' ' || d.kind || ' ' || COALESCE(d.source_ref, '')
                ),
                q.query
              ) AS score,
              COALESCE(d.dismissed_at, d.added_at) AS updated_at
         FROM desk_items d, q
        WHERE to_tsvector('simple',
                d.label || ' ' || d.body_md || ' ' || d.kind || ' ' || COALESCE(d.source_ref, '')
              ) @@ q.query
     ORDER BY score ASC, COALESCE(d.dismissed_at, d.added_at) ASC, d.desk_item_id ASC
        LIMIT $2`,
      [match, limit],
    );
    return rows.map((row) => ({
      kind: "desk_item",
      phid: row.phid,
      title: row.title,
      display_id: row.phid,
      score: row.score,
      updated_at: row.updated_at,
    }));
  }

  const { rows } = await adapter.query<{
    phid: string;
    title: string;
    score: number;
    updated_at: string;
  }>(
    `SELECT d.desk_item_id AS phid,
            d.label AS title,
            bm25(desk_items_fts) AS score,
            COALESCE(d.dismissed_at, d.added_at) AS updated_at
       FROM desk_items_fts
       JOIN desk_items d ON d.rowid = desk_items_fts.rowid
      WHERE desk_items_fts MATCH ?
   ORDER BY bm25(desk_items_fts)
      LIMIT ?`,
    [match, limit],
  );
  return rows.map((row) => ({
    kind: "desk_item",
    phid: row.phid,
    title: row.title,
    display_id: row.phid,
    score: row.score,
    updated_at: row.updated_at,
  }));
}

async function searchTaskHits(
  adapter: DbAdapter,
  match: string,
  limit: number,
): Promise<DocModelSearchHit[]> {
  if (adapter.dialect === "postgres") {
    const { rows } = await adapter.query<{
      phid: string;
      title: string;
      display_id: string;
      score: number;
      updated_at: number;
    }>(
      `WITH q AS (SELECT to_tsquery('simple', $1) AS query)
       SELECT COALESCE(NULLIF(t.uuid, ''), t.id) AS phid,
              t.title AS title,
              t.name AS display_id,
              -ts_rank_cd(
                to_tsvector('simple',
                  t.name || ' ' || t.title || ' ' || COALESCE(t.description, '') || ' ' || COALESCE(t.track, '') || ' ' || t.status
                ),
                q.query
              ) AS score,
              t.updated_at AS updated_at
         FROM tasks t, q
        WHERE to_tsvector('simple',
                t.name || ' ' || t.title || ' ' || COALESCE(t.description, '') || ' ' || COALESCE(t.track, '') || ' ' || t.status
              ) @@ q.query
     ORDER BY score ASC, t.updated_at ASC, t.id ASC
        LIMIT $2`,
      [match, limit],
    );
    return rows.map((row) => ({
      kind: "task",
      phid: row.phid,
      title: row.title,
      display_id: row.display_id,
      score: row.score,
      updated_at: epochToIso(row.updated_at),
    }));
  }

  const { rows } = await adapter.query<{
    phid: string;
    title: string;
    display_id: string;
    score: number;
    updated_at: number;
  }>(
    `SELECT COALESCE(NULLIF(t.uuid, ''), t.id) AS phid,
            t.title AS title,
            t.name AS display_id,
            bm25(tasks_fts) AS score,
            t.updated_at AS updated_at
       FROM tasks_fts
       JOIN tasks t ON t.rowid = tasks_fts.rowid
      WHERE tasks_fts MATCH ?
   ORDER BY bm25(tasks_fts)
      LIMIT ?`,
    [match, limit],
  );
  return rows.map((row) => ({
    kind: "task",
    phid: row.phid,
    title: row.title,
    display_id: row.display_id,
    score: row.score,
    updated_at: epochToIso(row.updated_at),
  }));
}

export async function searchDocModel(
  adapter: DbAdapter,
  query: string,
  opts: {
    limit?: number;
    offset?: number;
    kinds?: DocModelSearchKind[] | null;
  } = {},
): Promise<{ items: DocModelSearchHit[]; limit: number; offset: number }> {
  const limit = Math.min(Math.max(opts.limit ?? DOC_MODEL_SEARCH_DEFAULT_LIMIT, 1), DOC_MODEL_SEARCH_MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const match = adapter.dialect === "postgres" ? toPostgresTsQuery(query) : toFtsMatch(query);
  if (!match) {
    return { items: [], limit, offset };
  }

  if (adapter.dialect !== "sqlite" && adapter.dialect !== "postgres") {
    throw new DocModelSearchUnsupportedError(adapter.dialect);
  }

  const kinds = opts.kinds ?? [...DOC_MODEL_SEARCH_KINDS];
  const fetchCap = Math.min(limit + offset, DOC_MODEL_SEARCH_MAX_LIMIT);
  const merged: DocModelSearchHit[] = [];

  if (kinds.includes("artifact")) {
    merged.push(...(await searchArtifactHits(adapter, match, fetchCap)));
  }
  if (kinds.includes("desk_item")) {
    merged.push(...(await searchDeskHits(adapter, match, fetchCap)));
  }
  if (kinds.includes("task")) {
    merged.push(...(await searchTaskHits(adapter, match, fetchCap)));
  }

  merged.sort((a, b) => a.score - b.score || a.updated_at.localeCompare(b.updated_at));
  return { items: merged.slice(offset, offset + limit), limit, offset };
}
