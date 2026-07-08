import type { DbAdapter } from "../db/db-adapter.js";
import type { BranchLedgerExceptionCounts, BranchLedgerFilters, BranchLedgerRow } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface BranchLedgerDbRow extends Omit<BranchLedgerRow, "is_primary_checkout"> {
  is_primary_checkout: number;
}

export interface BranchLedgerIngestResult {
  inserted: number;
  updated: number;
  rows: BranchLedgerRow[];
}

export async function migrateBranchLedgerTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS branch_ledger (
      dedupe_key TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT,
      upstream TEXT,
      base TEXT,
      remote TEXT,
      ahead INTEGER NOT NULL DEFAULT 0,
      behind INTEGER NOT NULL DEFAULT 0,
      dirty_tracked_count INTEGER NOT NULL DEFAULT 0,
      dirty_untracked_count INTEGER NOT NULL DEFAULT 0,
      worktree_path TEXT,
      is_primary_checkout INTEGER NOT NULL DEFAULT 0,
      last_commit_at TEXT,
      last_seen_at TEXT NOT NULL,
      linked_dispatch_id TEXT,
      linked_task_name TEXT,
      linked_rd TEXT,
      owner_agent TEXT,
      owner_lane TEXT,
      class_code TEXT NOT NULL,
      action_class TEXT NOT NULL,
      recommended_action TEXT,
      last_hygiene_run_id TEXT,
      last_promotion_failure_id TEXT,
      console_url TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      scanner_payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo, branch, class_code)
    )
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS branch_ledger_repo_idx ON branch_ledger(repo, last_seen_at)`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS branch_ledger_action_idx ON branch_ledger(action_class, last_seen_at)`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS branch_ledger_owner_lane_idx ON branch_ledger(owner_lane, last_seen_at)`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS branch_ledger_last_commit_idx ON branch_ledger(last_commit_at)`);
}

export async function ingestBranchLedgerScannerJson(
  adapter: DbAdapter,
  input: unknown,
  opts: { now?: string } = {},
): Promise<BranchLedgerIngestResult> {
  const now = opts.now ?? new Date().toISOString();
  const envelope = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const runId = str(envelope.run_id) ?? str(envelope.hygiene_run_id) ?? str(envelope.last_hygiene_run_id);
  const items = extractScannerItems(input);
  let inserted = 0;
  let updated = 0;
  const rows: BranchLedgerRow[] = [];

  for (const item of items) {
    const normalized = normalizeScannerItem(item, {
      now,
      runId,
      consoleBaseUrl: str(envelope.console_base_url) ?? null,
    });
    const existing = await getBranchLedgerRow(adapter, normalized.dedupe_key);
    await upsertBranchLedgerRow(adapter, normalized);
    if (existing) updated += 1;
    else inserted += 1;
    rows.push(normalized);
  }

  return { inserted, updated, rows };
}

export async function listBranchLedgerRows(
  adapter: DbAdapter,
  filters: BranchLedgerFilters = {},
): Promise<BranchLedgerRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const repo = trim(filters.repo);
  const actionClass = trim(filters.action_class);
  const ownerLane = trim(filters.owner_lane);

  if (repo) {
    where.push("repo = ?");
    params.push(repo);
  }
  if (actionClass) {
    where.push("action_class = ?");
    params.push(actionClass);
  }
  if (ownerLane) {
    where.push("(owner_lane = ? OR owner_agent = ?)");
    params.push(ownerLane, ownerLane);
  }
  if (filters.needs_chris === true) {
    where.push("action_class = 'needs_chris'");
  } else if (filters.needs_chris === false) {
    where.push("action_class != 'needs_chris'");
  }
  if (typeof filters.stale_age_days === "number" && Number.isFinite(filters.stale_age_days) && filters.stale_age_days >= 0) {
    const now = Date.parse(filters.now ?? new Date().toISOString());
    const cutoff = new Date(now - Math.floor(filters.stale_age_days) * 24 * 60 * 60 * 1000).toISOString();
    where.push("last_commit_at IS NOT NULL AND last_commit_at <= ?");
    params.push(cutoff);
  }

  const limit = clampLimit(filters.limit);
  params.push(limit);
  const { rows } = await adapter.query<BranchLedgerDbRow>(
    `SELECT * FROM branch_ledger
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY last_seen_at DESC, repo ASC, branch ASC, class_code ASC
     LIMIT ?`,
    params,
  );
  return rows.map(rowFromDb);
}

export async function countBranchLedgerExceptions(adapter: DbAdapter): Promise<BranchLedgerExceptionCounts> {
  const { rows } = await adapter.query<{
    class_code: string;
    action_class: string;
    owner_lane: string | null;
    n: number;
  }>(
    `SELECT class_code, action_class, owner_lane, COUNT(*) AS n
       FROM branch_ledger
      GROUP BY class_code, action_class, owner_lane`,
  );
  const counts: BranchLedgerExceptionCounts = {
    total: 0,
    by_class_code: {},
    by_action_class: {},
    by_owner_lane: {},
    needs_chris: 0,
    needs_fresh_branch: 0,
    owner_routed_quarantine: 0,
  };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    counts.total += n;
    counts.by_class_code[row.class_code] = (counts.by_class_code[row.class_code] ?? 0) + n;
    counts.by_action_class[row.action_class] = (counts.by_action_class[row.action_class] ?? 0) + n;
    if (row.owner_lane) counts.by_owner_lane[row.owner_lane] = (counts.by_owner_lane[row.owner_lane] ?? 0) + n;
    if (row.action_class === "needs_chris") counts.needs_chris += n;
    if (row.action_class === "needs_fresh_branch") counts.needs_fresh_branch += n;
    if (row.action_class === "owner_routed_quarantine") counts.owner_routed_quarantine += n;
  }
  return counts;
}

export async function getBranchLedgerRow(adapter: DbAdapter, dedupeKey: string): Promise<BranchLedgerRow | null> {
  const { rows } = await adapter.query<BranchLedgerDbRow>(
    `SELECT * FROM branch_ledger WHERE dedupe_key = ? LIMIT 1`,
    [dedupeKey],
  );
  return rows[0] ? rowFromDb(rows[0]) : null;
}

function extractScannerItems(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  for (const key of ["incidents", "items", "rows", "branches", "ledger"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function normalizeScannerItem(
  item: unknown,
  opts: { now: string; runId?: string | null; consoleBaseUrl?: string | null },
): BranchLedgerRow {
  const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
  const repo = required(record.repo, "repo");
  const branch = required(record.branch, "branch");
  const classCode = str(record.class_code) ?? str(record.incident_code) ?? required(record.code, "class_code");
  const dedupeKey = `${repo}:${branch}:${classCode}`;
  const ownerAgent = str(record.owner_agent) ?? str(record.owner) ?? null;
  const ownerLane = str(record.owner_lane) ?? ownerAgent;
  const actionClass = str(record.action_class) ?? str(record.action) ?? "needs_owner";
  const lastSeenAt = str(record.last_seen_at) ?? str(record.observed_at) ?? opts.now;
  const consoleUrl = str(record.console_url) ?? buildConsoleUrl(opts.consoleBaseUrl, dedupeKey);

  return {
    repo,
    branch,
    head_sha: str(record.head_sha) ?? str(record.head) ?? null,
    upstream: str(record.upstream) ?? null,
    base: str(record.base) ?? null,
    remote: str(record.remote) ?? null,
    ahead: integer(record.ahead),
    behind: integer(record.behind),
    dirty_tracked_count: integer(record.dirty_tracked_count),
    dirty_untracked_count: integer(record.dirty_untracked_count),
    worktree_path: str(record.worktree_path) ?? null,
    is_primary_checkout: bool(record.is_primary_checkout),
    last_commit_at: str(record.last_commit_at) ?? null,
    last_seen_at: lastSeenAt,
    linked_dispatch_id: str(record.linked_dispatch_id) ?? str(record.linked_dispatch) ?? null,
    linked_task_name: str(record.linked_task_name) ?? str(record.linked_task) ?? null,
    linked_rd: str(record.linked_rd) ?? null,
    owner_agent: ownerAgent,
    owner_lane: ownerLane,
    class_code: classCode,
    action_class: actionClass,
    recommended_action: str(record.recommended_action) ?? null,
    dedupe_key: dedupeKey,
    last_hygiene_run_id: str(record.last_hygiene_run_id) ?? opts.runId ?? null,
    last_promotion_failure_id: str(record.last_promotion_failure_id) ?? null,
    console_url: consoleUrl,
    evidence_json: stringifyJson(record.evidence ?? []),
    scanner_payload_json: stringifyJson(record),
    created_at: opts.now,
    updated_at: opts.now,
  };
}

async function upsertBranchLedgerRow(adapter: DbAdapter, row: BranchLedgerRow): Promise<void> {
  await adapter.query(
    `INSERT INTO branch_ledger (
       dedupe_key, repo, branch, head_sha, upstream, base, remote,
       ahead, behind, dirty_tracked_count, dirty_untracked_count,
       worktree_path, is_primary_checkout, last_commit_at, last_seen_at,
       linked_dispatch_id, linked_task_name, linked_rd, owner_agent, owner_lane,
       class_code, action_class, recommended_action, last_hygiene_run_id,
       last_promotion_failure_id, console_url, evidence_json, scanner_payload_json,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       repo = excluded.repo,
       branch = excluded.branch,
       head_sha = excluded.head_sha,
       upstream = excluded.upstream,
       base = excluded.base,
       remote = excluded.remote,
       ahead = excluded.ahead,
       behind = excluded.behind,
       dirty_tracked_count = excluded.dirty_tracked_count,
       dirty_untracked_count = excluded.dirty_untracked_count,
       worktree_path = excluded.worktree_path,
       is_primary_checkout = excluded.is_primary_checkout,
       last_commit_at = excluded.last_commit_at,
       last_seen_at = excluded.last_seen_at,
       linked_dispatch_id = excluded.linked_dispatch_id,
       linked_task_name = excluded.linked_task_name,
       linked_rd = excluded.linked_rd,
       owner_agent = excluded.owner_agent,
       owner_lane = excluded.owner_lane,
       class_code = excluded.class_code,
       action_class = excluded.action_class,
       recommended_action = excluded.recommended_action,
       last_hygiene_run_id = excluded.last_hygiene_run_id,
       last_promotion_failure_id = excluded.last_promotion_failure_id,
       console_url = excluded.console_url,
       evidence_json = excluded.evidence_json,
       scanner_payload_json = excluded.scanner_payload_json,
       updated_at = excluded.updated_at`,
    [
      row.dedupe_key, row.repo, row.branch, row.head_sha, row.upstream, row.base, row.remote,
      row.ahead, row.behind, row.dirty_tracked_count, row.dirty_untracked_count,
      row.worktree_path, row.is_primary_checkout ? 1 : 0, row.last_commit_at, row.last_seen_at,
      row.linked_dispatch_id, row.linked_task_name, row.linked_rd, row.owner_agent, row.owner_lane,
      row.class_code, row.action_class, row.recommended_action, row.last_hygiene_run_id,
      row.last_promotion_failure_id, row.console_url, row.evidence_json, row.scanner_payload_json,
      row.created_at, row.updated_at,
    ],
  );
}

function rowFromDb(row: BranchLedgerDbRow): BranchLedgerRow {
  return { ...row, is_primary_checkout: Number(row.is_primary_checkout) === 1 };
}

function required(value: unknown, name: string): string {
  const s = str(value);
  if (!s) throw new Error(`branch_ledger_ingest_missing_${name}`);
  return s;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function trim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unjsonable: true });
  }
}

function buildConsoleUrl(base: string | null | undefined, dedupeKey: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/g, "")}/ops/worktree-hygiene/branch-ledger/${encodeURIComponent(dedupeKey)}`;
}
