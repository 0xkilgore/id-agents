// Merge-queue — durable storage (sqlite-only table, mirrors CO storage style).
//
// One row per MergeRequest. The worker dequeues the oldest QUEUED row per repo
// (north-star > priority > enqueued_at), holds a per-repo merge-lock, and drives
// it to a terminal state. Idempotent on idempotency_key (`repo:branch:head_sha`).

import type { DbAdapter } from "../db/db-adapter.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  mergeIdempotencyKey,
  type MergeFailure,
  type MergeRequest,
  type MergeRequestSubmission,
  type MergeState,
  type MergeStrategy,
} from "./types.js";

async function execDDL(adapter: DbAdapter, sql: string): Promise<void> {
  if (adapter.dialect === "sqlite" && typeof (adapter as unknown as { exec?: (s: string) => void }).exec === "function") {
    (adapter as unknown as { exec: (s: string) => void }).exec(sql);
  } else {
    await adapter.query(sql);
  }
}

export async function migrateMergeQueueTables(adapter: DbAdapter): Promise<void> {
  await execDDL(
    adapter,
    `
    CREATE TABLE IF NOT EXISTS merge_requests (
      mr_id            TEXT PRIMARY KEY,
      idempotency_key  TEXT NOT NULL UNIQUE,
      repo_alias       TEXT NOT NULL,
      repo_root        TEXT NOT NULL,
      pool_id          TEXT NOT NULL,
      base             TEXT NOT NULL DEFAULT 'main',
      branch           TEXT NOT NULL,
      builder          TEXT NOT NULL,
      dispatch_id      TEXT NOT NULL,
      lease_id         TEXT,
      head_sha         TEXT NOT NULL,
      strategy         TEXT NOT NULL DEFAULT 'auto',
      state            TEXT NOT NULL DEFAULT 'queued',
      attempts         INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 3,
      promoted_sha     TEXT,
      failure_json     TEXT,
      priority         INTEGER NOT NULL DEFAULT 5,
      is_north_star    INTEGER NOT NULL DEFAULT 0,
      enqueued_at      TEXT NOT NULL,
      started_at       TEXT,
      completed_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS merge_requests_drain_idx
      ON merge_requests(repo_alias, state, is_north_star, priority, enqueued_at);
  `,
  );
}

interface MergeRequestRow {
  mr_id: string;
  idempotency_key: string;
  repo_alias: string;
  repo_root: string;
  pool_id: string;
  base: string;
  branch: string;
  builder: string;
  dispatch_id: string;
  lease_id: string | null;
  head_sha: string;
  strategy: string;
  state: string;
  attempts: number;
  max_attempts: number;
  promoted_sha: string | null;
  failure_json: string | null;
  priority: number;
  is_north_star: number;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToMr(r: MergeRequestRow): MergeRequest {
  let failure: MergeFailure | null = null;
  if (r.failure_json) {
    try {
      failure = JSON.parse(r.failure_json) as MergeFailure;
    } catch {
      failure = null;
    }
  }
  return {
    mr_id: r.mr_id,
    idempotency_key: r.idempotency_key,
    repo_alias: r.repo_alias as MergeRequest["repo_alias"],
    repo_root: r.repo_root,
    pool_id: r.pool_id as MergeRequest["pool_id"],
    base: r.base,
    branch: r.branch,
    builder: r.builder,
    dispatch_id: r.dispatch_id,
    lease_id: r.lease_id,
    head_sha: r.head_sha,
    strategy: r.strategy as MergeStrategy,
    state: r.state as MergeState,
    attempts: Number(r.attempts),
    max_attempts: Number(r.max_attempts),
    promoted_sha: r.promoted_sha,
    failure,
    priority: Number(r.priority),
    is_north_star: Number(r.is_north_star) === 1,
    enqueued_at: r.enqueued_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
  };
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function branchSlug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export async function getMergeRequest(adapter: DbAdapter, mrId: string): Promise<MergeRequest | null> {
  const r = await adapter.query<MergeRequestRow>(`SELECT * FROM merge_requests WHERE mr_id = $1`, [mrId]);
  return r.rows[0] ? rowToMr(r.rows[0]) : null;
}

export async function getByIdempotencyKey(adapter: DbAdapter, key: string): Promise<MergeRequest | null> {
  const r = await adapter.query<MergeRequestRow>(`SELECT * FROM merge_requests WHERE idempotency_key = $1`, [key]);
  return r.rows[0] ? rowToMr(r.rows[0]) : null;
}

export interface EnqueueResult {
  mr: MergeRequest;
  created: boolean;
}

/**
 * Enqueue a builder's merge submission. Idempotent on `repo:branch:head_sha`:
 * a re-submit of an existing key returns the existing MR (no second row, no
 * double-merge). A new head_sha is a distinct key and a new MR.
 */
export async function enqueueMergeRequest(
  adapter: DbAdapter,
  sub: MergeRequestSubmission,
  opts?: { now?: () => Date; idGen?: () => string },
): Promise<EnqueueResult> {
  const base = sub.base ?? "main";
  const key = mergeIdempotencyKey(sub.repo_alias, sub.branch, sub.head_sha);
  const existing = await getByIdempotencyKey(adapter, key);
  if (existing) return { mr: existing, created: false };

  const ts = nowIso(opts?.now);
  const shortDisp = sub.dispatch_id.replace(/[^a-zA-Z0-9]+/g, "").slice(-8) || "nodisp";
  // Include a head_sha fragment so a post-rebase resubmit (same branch+dispatch,
  // new head_sha → new idempotency_key) also gets a distinct mr_id.
  const headFrag = sub.head_sha.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 8) || "nohead";
  const mrId =
    opts?.idGen?.() ??
    `mr_${ts.slice(0, 10).replace(/-/g, "")}_${shortDisp}_${branchSlug(sub.branch)}_${headFrag}`;
  const strategy: MergeStrategy = sub.strategy ?? "auto";

  await adapter.query(
    `INSERT INTO merge_requests (
       mr_id, idempotency_key, repo_alias, repo_root, pool_id, base, branch, builder,
       dispatch_id, lease_id, head_sha, strategy, state, attempts, max_attempts,
       promoted_sha, failure_json, priority, is_north_star, enqueued_at, started_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',0,$13,NULL,NULL,$14,$15,$16,NULL,NULL)`,
    [
      mrId,
      key,
      sub.repo_alias,
      sub.repo_root,
      sub.pool_id,
      base,
      sub.branch,
      sub.builder,
      sub.dispatch_id,
      sub.lease_id ?? null,
      sub.head_sha,
      strategy,
      DEFAULT_MAX_ATTEMPTS,
      sub.priority ?? 5,
      sub.is_north_star ? 1 : 0,
      ts,
    ],
  );
  const mr = await getMergeRequest(adapter, mrId);
  if (!mr) throw new Error(`enqueueMergeRequest: row vanished after insert (${mrId})`);
  return { mr, created: true };
}

/**
 * The next MergeRequest a worker should drain for a repo: oldest QUEUED,
 * north-star first, then priority asc, then enqueued_at asc. Read-only (the
 * worker transitions it to "merging" under the repo lock).
 */
export async function dequeueOldestQueued(adapter: DbAdapter, repoAlias: string): Promise<MergeRequest | null> {
  // 'conflict' is a retryable state (rebase hit a conflict, budget remained) —
  // it re-enters the drain alongside fresh 'queued' items.
  const r = await adapter.query<MergeRequestRow>(
    `SELECT * FROM merge_requests
       WHERE repo_alias = $1 AND state IN ('queued','conflict')
       ORDER BY is_north_star DESC, priority ASC, enqueued_at ASC
       LIMIT 1`,
    [repoAlias],
  );
  return r.rows[0] ? rowToMr(r.rows[0]) : null;
}

export interface MergeRequestPatch {
  state?: MergeState;
  attempts?: number;
  promoted_sha?: string | null;
  failure?: MergeFailure | null;
  head_sha?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export async function updateMergeRequest(
  adapter: DbAdapter,
  mrId: string,
  patch: MergeRequestPatch,
): Promise<MergeRequest | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    params.push(val);
  };
  if (patch.state !== undefined) set("state", patch.state);
  if (patch.attempts !== undefined) set("attempts", patch.attempts);
  if (patch.promoted_sha !== undefined) set("promoted_sha", patch.promoted_sha);
  if (patch.failure !== undefined) set("failure_json", patch.failure ? JSON.stringify(patch.failure) : null);
  if (patch.head_sha !== undefined) set("head_sha", patch.head_sha);
  if (patch.started_at !== undefined) set("started_at", patch.started_at);
  if (patch.completed_at !== undefined) set("completed_at", patch.completed_at);
  if (sets.length === 0) return getMergeRequest(adapter, mrId);
  params.push(mrId);
  await adapter.query(`UPDATE merge_requests SET ${sets.join(", ")} WHERE mr_id = $${i}`, params);
  return getMergeRequest(adapter, mrId);
}

export async function listMergeRequests(
  adapter: DbAdapter,
  filter?: { repo_alias?: string; state?: MergeState },
): Promise<MergeRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filter?.repo_alias) {
    where.push(`repo_alias = $${i++}`);
    params.push(filter.repo_alias);
  }
  if (filter?.state) {
    where.push(`state = $${i++}`);
    params.push(filter.state);
  }
  const sql = `SELECT * FROM merge_requests${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY enqueued_at ASC`;
  const r = await adapter.query<MergeRequestRow>(sql, params);
  return r.rows.map(rowToMr);
}
