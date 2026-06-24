import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';

import type { DbAdapterLike } from '../supervisor/manager-source-reader.js';

const ACTIVE_STATUSES = ['queued', 'in_flight', 'bounced', 'needs_clarification', 'resume_delivery_failed'];
const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
const ALL_STATUSES = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];

export type DispatchReadStatus = 'active' | 'terminal' | 'all';

export interface DispatchReadRow {
  id: string;
  dispatch_id: string;
  dispatch_phid: string;
  query_id: string | null;
  agent_query_id: string | null;
  target_agent: string;
  agent_id: string;
  status: string;
  title: string;
  subject: string;
  task_name: string | null;
  queued_at: string | null;
  in_flight_at: string | null;
  done_at: string | null;
  completed_at: string | null;
  updated_at: string;
  failure_kind: string | null;
  failure_detail: string | null;
  // T-RECON.2: the superseding dispatch_phid when this failed work was redone.
  supersede_link: string | null;
  needs_input: {
    clarification_id: string | null;
    active: unknown | null;
    history: unknown[];
    resume_delivery_status: string | null;
  };
  promotion: {
    promote: boolean;
    strategy: string | null;
    required_reason: string | null;
    input: unknown | null;
    result: unknown | null;
  };
  // Recovery-state posture so /ops can distinguish landed/recovering from
  // needs-attention. Additive; legacy rows read as a clean "none" posture.
  recovery: {
    status: string;
    attempts: number;
    reason: string | null;
    side_effect: string;
    allow_auto_retry: boolean;
  };
  // Landed-evidence so operators can tell a reconciled/landed dispatch from
  // one that still needs intervention without re-parsing result_json.
  evidence: {
    artifact_path: string | null;
    promotion_result: unknown | null;
  };
  // Cn-EVE.1 (2026-06-16): false_expire_recovered ledger classification.
  // A dispatch is "false_expire_recovered" when it was originally reported
  // failed/expired (failure_kind set) but the auto-recovery wiring (see
  // dispatch-recovery/service.ts, commit 387f03b) found on-disk evidence
  // that the work actually shipped — commit SHA on main, an artifact at a
  // recorded path, or a successful promotion result — and flipped the row
  // to status='done' with recovery_status in {landed_reconciled, verified_done}.
  // This block surfaces that classification + the preserved original failure
  // reason + the structured evidence so /dispatches consumers (Kapelle UI,
  // Sentinel spot-checks) can render "recovered" without re-deriving the
  // logic. Null when the dispatch was not auto-recovered (i.e., normal done /
  // still failed / never failed).
  recovery_classification: {
    false_expire_recovered: boolean;
    original_failure_reason: {
      kind: string | null;
      detail: string | null;
    } | null;
    recovery_evidence: {
      kind: "commit_evidence" | "artifact" | "promotion" | "unknown";
      commit_sha: string | null;
      artifact_path: string | null;
      promotion_sha: string | null;
      reason_text: string | null;
    };
  } | null;
  // T13.2 (2026-06-17, phid:disp-1e2819f568b08704): derived effective_state
  // per cto/output/2026-06-16-dispatch-failure-state-taxonomy-scope.md.
  // The UI uses this (not raw `status`) to decide row treatment + sort
  // order so the dispatch queue stops painting all failures red. Derived
  // purely from existing scheduler+recovery fields. supersede_link is
  // not yet on the schema (documented as v2 follow-up); rate-limit/
  // provider retries without supersede evidence fall to
  // failed_needs_operator (the safe direction per the scope §7).
  effective_state:
    | "failed_work_landed_recoverable"
    | "moot_or_superseded"
    | "failed_needs_operator"
    | "queued"
    | "in_flight"
    | "done"
    | "done_recovered"
    | string; // string fallback preserves forwards-compat with unknown raw states
  // Companion sort signal. UI groups `needs_operator=true` to the top
  // regardless of `effective_state`. Per the scope §"Needs-You Flag".
  needs_operator: boolean;
  // T13.3 (2026-06-24, phid:disp-dab6b426faa23147): server-derived sort
  // band per the scope §"Default Sort Policy" `groupRank`. A small integer
  // 0..5 the console (T13.4) and the page-title counts order rows by, so the
  // taxonomy is derived once here instead of re-implemented client-side.
  // Lower sorts higher:
  //   0 = needs you (any needs_operator row, regardless of effective_state)
  //   1 = in_flight (healthy)        2 = queued (ready)
  //   3 = done_recovered / failed_work_landed_recoverable (collapsed)
  //   4 = done (collapsed)           5 = moot_or_superseded (bottom)
  // Pure function of (effective_state, needs_operator) — both already on this
  // row — so it can never disagree with them. See deriveSortGroup().
  sort_group: number;
  source_metadata: {
    source: 'dispatch_scheduler_queue';
    team_id: string;
    from_actor: string | null;
    channel: string | null;
    provider: string | null;
    runtime: string | null;
    priority: number | null;
    attempt_count: number | null;
    bounce_count: number | null;
    not_before_at: string | null;
  };
  source: 'manager-http';
}

interface DispatchDbRow {
  dispatch_phid: string;
  team_id: string;
  query_id: string | null;
  to_agent: string;
  from_actor: string | null;
  channel: string | null;
  subject: string;
  provider: string | null;
  runtime: string | null;
  priority: number | null;
  status: string;
  not_before_at: string | null;
  attempt_count: number | null;
  bounce_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_query_id: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  clarification_id: string | null;
  active_clarification_json: string | null;
  clarification_history_json: string | null;
  resume_delivery_status: string | null;
  promote: number | null;
  promotion_strategy: string | null;
  promotion_required_reason: string | null;
  promotion_input_json: string | null;
  promotion_result_json: string | null;
  result_json: string | null;
  artifact_path: string | null;
  recovery_status: string | null;
  recovery_attempts: number | null;
  recovery_reason: string | null;
  side_effect: string | null;
  allow_auto_retry: number | null;
  supersede_link: string | null;
}

export function parseDispatchReadStatus(raw: unknown): DispatchReadStatus | null {
  if (raw == null || raw === '') return 'all';
  if (raw === 'active' || raw === 'terminal' || raw === 'all') return raw;
  return null;
}

export function parseReadLimit(raw: unknown, opts: { defaultLimit?: number; maxLimit?: number } = {}): number {
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 500;
  if (raw == null || raw === '') return defaultLimit;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(maxLimit, Math.floor(n));
}

/** Trailing window for the failed-24h dashboard route (24h in ms). */
export const FAILED_24H_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Filter read-rows to dispatches that FAILED within `[now - windowMs, now]`.
 *
 * "failed" = the raw terminal status `'failed'`. Auto-recovered rows are
 * flipped to status `'done'` upstream (see `recovery_classification`), so this
 * correctly counts only dispatches that are still failed — the trailing-24h
 * count the dashboard wants (STUB-S6 / page.tsx:270 TODO). The failure instant
 * is `completed_at` (the terminal time) falling back to `updated_at`. Rows with
 * an unparseable `now` or timestamp are excluded. Pure + deterministic.
 */
export function failedDispatchesWithin(
  rows: DispatchReadRow[],
  now: string,
  windowMs: number = FAILED_24H_WINDOW_MS,
): DispatchReadRow[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const cutoff = nowMs - windowMs;
  return rows.filter((r) => {
    if (r.status !== 'failed') return false;
    const ts = Date.parse(r.completed_at ?? r.updated_at);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

export async function readDispatches(
  adapter: DbAdapterLike,
  teamId: string,
  status: DispatchReadStatus,
  limit: number,
  opts: DeriveOptions = {},
): Promise<DispatchReadRow[]> {
  const statuses = statusesForFilter(status);
  const placeholders = statuses.map(() => '?').join(', ');
  const { rows } = await adapter.query<DispatchDbRow>(
    `SELECT dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
            provider, runtime, priority, status, not_before_at, attempt_count,
            bounce_count, started_at, completed_at, updated_at, agent_query_id,
            failure_kind, failure_detail, clarification_id,
            active_clarification_json, clarification_history_json,
            resume_delivery_status, promote, promotion_strategy,
            promotion_required_reason, promotion_input_json,
            promotion_result_json, result_json, artifact_path,
            recovery_status, recovery_attempts, recovery_reason,
            side_effect, allow_auto_retry, supersede_link
       FROM dispatch_scheduler_queue
       WHERE team_id = ? AND status IN (${placeholders})
       ORDER BY COALESCE(completed_at, started_at, updated_at, not_before_at) DESC,
                dispatch_phid DESC
       LIMIT ?`,
    [teamId, ...statuses, limit],
  );
  return rows.map((row) => rowToDispatch(row, opts));
}

export async function readDispatchById(
  adapter: DbAdapterLike,
  teamId: string,
  dispatchId: string,
  opts: DeriveOptions = {},
): Promise<DispatchReadRow | null> {
  const { rows } = await adapter.query<DispatchDbRow>(
    `SELECT dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
            provider, runtime, priority, status, not_before_at, attempt_count,
            bounce_count, started_at, completed_at, updated_at, agent_query_id,
            failure_kind, failure_detail, clarification_id,
            active_clarification_json, clarification_history_json,
            resume_delivery_status, promote, promotion_strategy,
            promotion_required_reason, promotion_input_json,
            promotion_result_json, result_json, artifact_path,
            recovery_status, recovery_attempts, recovery_reason,
            side_effect, allow_auto_retry, supersede_link
       FROM dispatch_scheduler_queue
       WHERE team_id = ? AND (dispatch_phid = ? OR query_id = ? OR agent_query_id = ?)
       LIMIT 1`,
    [teamId, dispatchId, dispatchId, dispatchId],
  );
  return rows[0] ? rowToDispatch(rows[0], opts) : null;
}

/** Normalize an optional provider iterable into a Set for O(1) membership. */
function toSet(it: Iterable<string> | undefined): Set<string> {
  return it ? new Set(it) : new Set();
}

/**
 * T-RECON.2 one-time sweep: durably moot the existing dead constrained-provider
 * failures (the ~12 Codex "usage limit" needs_operator ghosts). Stamps
 * recovery_status='moot' on failed rows whose provider is constrained OR whose
 * failure_detail carries the Codex usage-limit signature, EXCEPT rows already
 * mooted or landed. Durable: survives later changes to constrained_providers.
 * Returns the number of rows swept.
 */
export async function sweepConstrainedProviderDead(
  adapter: DbAdapterLike,
  teamId: string,
  constrainedProviders: Iterable<string>,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const constrained = [...toSet(constrainedProviders)];
  if (constrained.length === 0) return 0;
  const providerPlaceholders = constrained.map(() => "?").join(", ");
  const includeCodexSignature = constrained.includes("openai");
  // Match: failed, not already moot/landed, and either provider IN constrained
  // or (openai constrained AND a Codex usage-limit detail).
  const codexClause = includeCodexSignature
    ? `OR failure_detail LIKE '%chatgpt.com/codex%' OR failure_detail LIKE '%hit your usage limit%'`
    : "";
  const whereTail =
    `WHERE team_id = ?
       AND status = 'failed'
       AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')
       AND ( provider IN (${providerPlaceholders}) ${codexClause} )`;

  // Count-then-update so the returned count is deterministic across adapters.
  const { rows: countRows } = await adapter.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dispatch_scheduler_queue ${whereTail}`,
    [teamId, ...constrained],
  );
  const n = Number(countRows[0]?.n ?? 0);
  if (n === 0) return 0;

  await adapter.query(
    `UPDATE dispatch_scheduler_queue
       SET recovery_status = 'moot',
           recovery_reason = COALESCE(recovery_reason, ?),
           updated_at = ?
     ${whereTail}`,
    ["constrained_provider_dead (T-RECON.2 sweep)", nowIso, teamId, ...constrained],
  );
  return n;
}

// Task 11 (dispatch-canonical): a diagnostic view of dispatches whose
// canonical lifecycle drifted from the agent-side queries projection. Each
// entry is an actionable misalignment an operator can act on: the dispatch
// is still queued in the scheduler, but the agent has already started or
// finished its half (manager_dispatch_id on a processing/completed row
// proves the agent saw the work). Without this surface the drift is
// invisible — neither /dispatches nor /query/:id alone exposes it.
export interface DispatchReconcileStuckQueuedRow {
  dispatch_id: string;
  query_id: string;
  agent_query_status: string;
}

export async function readReconciliation(
  adapter: DbAdapterLike,
  teamId: string,
): Promise<{ stuck_queued: DispatchReconcileStuckQueuedRow[] }> {
  const { rows } = await adapter.query<{
    dispatch_id: string;
    query_id: string;
    agent_query_status: string;
  }>(
    `SELECT d.dispatch_phid AS dispatch_id,
            q.query_id      AS query_id,
            q.status        AS agent_query_status
       FROM dispatch_scheduler_queue d
       JOIN queries q ON q.manager_dispatch_id = d.dispatch_phid
      WHERE d.team_id = ?
        AND d.status = 'queued'
        AND q.status IN ('processing', 'completed')
      ORDER BY d.dispatch_phid`,
    [teamId],
  );
  return { stuck_queued: rows };
}

export async function readDispatchHealth(adapter: DbAdapterLike, teamId: string): Promise<{
  status: 'ok';
  team_id: string;
  counts: Record<string, number>;
  active: number;
  terminal: number;
  needs_input: number;
  oldest_active_at: string | null;
  newest_terminal_at: string | null;
  generated_at: string;
}> {
  const { rows: countsRows } = await adapter.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*) as count
       FROM dispatch_scheduler_queue
       WHERE team_id = ?
       GROUP BY status`,
    [teamId],
  );
  const counts = Object.fromEntries(countsRows.map((r) => [r.status, Number(r.count)]));
  const active = ACTIVE_STATUSES.reduce((sum, s) => sum + Number(counts[s] ?? 0), 0);
  const terminal = TERMINAL_STATUSES.reduce((sum, s) => sum + Number(counts[s] ?? 0), 0);

  const { rows: ageRows } = await adapter.query<{
    oldest_active_at: string | null;
    newest_terminal_at: string | null;
  }>(
    `SELECT
        MIN(CASE WHEN status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
          THEN COALESCE(started_at, not_before_at, updated_at) END) AS oldest_active_at,
        MAX(CASE WHEN status IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
          THEN COALESCE(completed_at, updated_at) END) AS newest_terminal_at
       FROM dispatch_scheduler_queue
       WHERE team_id = ?`,
    [...ACTIVE_STATUSES, ...TERMINAL_STATUSES, teamId],
  );

  return {
    status: 'ok',
    team_id: teamId,
    counts,
    active,
    terminal,
    needs_input: Number(counts.needs_clarification ?? 0),
    oldest_active_at: ageRows[0]?.oldest_active_at ?? null,
    newest_terminal_at: ageRows[0]?.newest_terminal_at ?? null,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Stamp each artifact with the canonical `produced_at` and return them
 * newest-first by it. `produced_at` is the real production time, resolved as:
 *   1. the artifacts-catalog frozen produced_at (first-seen file mtime), else
 *   2. completed_at (a stable dispatch-completion time), else
 *   3. modified_at (the volatile live re-stat — last resort).
 *
 * Pure: does not mutate the input rows. This is what keeps a genuinely-old
 * artifact reading its real date (and sorting correctly) even after its file's
 * live mtime was bumped to "now" by a catalog sweep or a Dropbox re-sync.
 */
export function enrichArtifactsWithProducedAt(
  artifacts: Array<Record<string, unknown>>,
  catalogByPath: Map<string, string>,
): Array<Record<string, unknown>> {
  return artifacts
    .map((a) => {
      const producedAt =
        catalogByPath.get(String(a.path ?? '')) ??
        (a.completed_at as string | null | undefined) ??
        (a.modified_at as string | null | undefined) ??
        null;
      return { ...a, produced_at: producedAt };
    })
    .sort((a, b) => String(b.produced_at ?? '').localeCompare(String(a.produced_at ?? '')));
}

/** Batch-load frozen produced_at from the artifacts catalog, keyed by abs_path.
 *  Best-effort: returns an empty map if the catalog is unavailable. */
async function fetchCatalogProducedAt(
  adapter: DbAdapterLike,
  paths: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;
  try {
    const placeholders = paths.map(() => '?').join(', ');
    const { rows } = await adapter.query<{ abs_path: string; produced_at: string }>(
      `SELECT abs_path, produced_at FROM artifacts WHERE abs_path IN (${placeholders})`,
      paths,
    );
    for (const row of rows) {
      if (row.abs_path && row.produced_at) map.set(row.abs_path, row.produced_at);
    }
  } catch {
    /* catalog unavailable — callers fall back to completed_at/modified_at */
  }
  return map;
}

export async function readArtifacts(adapter: DbAdapterLike, teamId: string, limit: number): Promise<{
  artifacts: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  count: number;
  source_metadata: { sources: string[]; team_id: string };
}> {
  const [dispatchArtifacts, queryArtifacts, outputArtifacts] = await Promise.all([
    readDispatchResultArtifacts(adapter, teamId, limit),
    readQueryResultArtifacts(adapter, teamId, limit),
    readAgentOutputArtifacts(adapter, teamId, limit),
  ]);
  const deduped = dedupeArtifactsByPath([...dispatchArtifacts, ...queryArtifacts, ...outputArtifacts]);
  const catalogByPath = await fetchCatalogProducedAt(
    adapter,
    deduped.map((a) => String(a.path ?? '')).filter(Boolean),
  );
  const artifacts = enrichArtifactsWithProducedAt(deduped, catalogByPath).slice(0, limit);
  return {
    artifacts,
    items: artifacts,
    count: artifacts.length,
    source_metadata: {
      sources: ['dispatch_scheduler_queue.result_json', 'queries.result', 'agents.working_directory/output'],
      team_id: teamId,
    },
  };
}

async function readDispatchResultArtifacts(
  adapter: DbAdapterLike,
  teamId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await adapter.query<Pick<DispatchDbRow,
    'dispatch_phid' | 'query_id' | 'to_agent' | 'status' | 'subject' | 'completed_at' | 'updated_at' | 'result_json'
  >>(
    `SELECT dispatch_phid, query_id, to_agent, status, subject, completed_at, updated_at, result_json
       FROM dispatch_scheduler_queue
       WHERE team_id = ? AND result_json IS NOT NULL
       ORDER BY COALESCE(completed_at, updated_at) DESC
       LIMIT ?`,
    [teamId, limit],
  );
  const artifacts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const parsed = parseJsonObject(row.result_json);
    const artifactPath = typeof parsed?.artifact_path === 'string' ? parsed.artifact_path : null;
    if (!artifactPath) continue;
    const stat = safeStat(artifactPath);
    artifacts.push({
      id: `dispatch:${row.dispatch_phid}`,
      path: artifactPath,
      basename: path.basename(artifactPath),
      agent: row.to_agent,
      target_agent: row.to_agent,
      dispatch_id: row.dispatch_phid,
      query_id: row.query_id,
      status: stat?.isFile() ? 'available' : 'missing',
      exists: Boolean(stat?.isFile()),
      size_bytes: stat?.size ?? null,
      modified_at: stat?.mtime.toISOString() ?? null,
      completed_at: row.completed_at,
      title: row.subject,
      tl_dr: typeof parsed?.tl_dr === 'string' ? parsed.tl_dr : null,
      source_metadata: {
        source: 'dispatch_scheduler_queue.result_json',
        dispatch_status: row.status,
      },
    });
  }
  return artifacts;
}

async function readQueryResultArtifacts(
  adapter: DbAdapterLike,
  teamId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await adapter.query<{
    query_id: string;
    agent_id: string | null;
    agent_name: string | null;
    completed: number | null;
    result: string | null;
    manager_dispatch_id: string | null;
    manager_query_id: string | null;
  }>(
    `SELECT q.query_id, q.agent_id, a.name AS agent_name, q.completed, q.result,
            q.manager_dispatch_id, q.manager_query_id
       FROM queries q
       LEFT JOIN agents a ON a.id = q.agent_id
      WHERE q.team_id = ?
        AND q.status = 'completed'
        AND q.result IS NOT NULL
      ORDER BY q.completed DESC
      LIMIT ?`,
    [teamId, Math.max(limit * 4, limit)],
  );

  const artifacts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (artifacts.length >= limit) break;
    const parsed = parseJsonObject(row.result);
    const resultText = typeof parsed?.result === 'string'
      ? parsed.result
      : typeof row.result === 'string'
        ? row.result
        : '';
    for (const artifactPath of extractOutputPaths(resultText)) {
      if (artifacts.length >= limit) break;
      const stat = safeStat(artifactPath);
      if (!stat?.isFile()) continue;
      artifacts.push({
        id: `query:${row.query_id}:${path.basename(artifactPath)}`,
        path: artifactPath,
        basename: path.basename(artifactPath),
        agent: row.agent_name ?? row.agent_id ?? 'unknown',
        target_agent: row.agent_name ?? row.agent_id ?? 'unknown',
        dispatch_id: row.manager_dispatch_id,
        query_id: row.query_id,
        manager_query_id: row.manager_query_id,
        status: 'available',
        exists: true,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        completed_at: row.completed ? new Date(Number(row.completed)).toISOString() : null,
        source_metadata: {
          source: 'queries.result',
          agent_id: row.agent_id,
        },
      });
    }
  }
  return artifacts;
}

async function readAgentOutputArtifacts(
  adapter: DbAdapterLike,
  teamId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const { rows: agents } = await adapter.query<{
    id: string;
    name: string;
    working_directory: string | null;
  }>(
    `SELECT id, name, working_directory
       FROM agents
       WHERE team_id = ? AND deleted_at IS NULL
       ORDER BY name ASC`,
    [teamId],
  );
  const artifacts: Array<Record<string, unknown>> = [];
  for (const agent of agents) {
    if (!agent.working_directory) continue;
    const outputDir = path.join(agent.working_directory, 'output');
    if (!existsSync(outputDir)) continue;
    let entries;
    try {
      entries = readdirSync(outputDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(outputDir, entry.name);
      const stat = safeStat(filePath);
      artifacts.push({
        id: `output:${agent.id}:${entry.name}`,
        path: filePath,
        basename: entry.name,
        agent: agent.name,
        target_agent: agent.name,
        dispatch_id: null,
        query_id: null,
        status: 'available',
        exists: true,
        size_bytes: stat?.size ?? null,
        modified_at: stat?.mtime.toISOString() ?? null,
        source_metadata: {
          source: 'agents.working_directory/output',
          agent_id: agent.id,
        },
      });
    }
  }
  return artifacts
    .sort((a, b) => String(b.modified_at ?? '').localeCompare(String(a.modified_at ?? '')))
    .slice(0, limit);
}

function statusesForFilter(status: DispatchReadStatus): string[] {
  if (status === 'active') return ACTIVE_STATUSES;
  if (status === 'terminal') return TERMINAL_STATUSES;
  return ALL_STATUSES;
}

function rowToDispatch(row: DispatchDbRow, opts: DeriveOptions = {}): DispatchReadRow {
  const history = parseJsonArray(row.clarification_history_json);
  // Derive the taxonomy fields once so sort_group can never disagree with the
  // effective_state / needs_operator it is computed from.
  const effectiveState = deriveEffectiveState(row, opts);
  const needsOperator = deriveNeedsOperator(row, Date.now(), opts);
  return {
    id: row.dispatch_phid,
    dispatch_id: row.dispatch_phid,
    dispatch_phid: row.dispatch_phid,
    query_id: row.query_id,
    agent_query_id: row.agent_query_id,
    target_agent: row.to_agent,
    agent_id: row.to_agent,
    status: row.status,
    title: row.subject,
    subject: row.subject,
    task_name: null,
    queued_at: row.not_before_at,
    in_flight_at: row.started_at,
    done_at: row.completed_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    failure_kind: row.failure_kind,
    failure_detail: row.failure_detail,
    needs_input: {
      clarification_id: row.clarification_id,
      active: parseJsonOrNull(row.active_clarification_json),
      history,
      resume_delivery_status: row.resume_delivery_status,
    },
    promotion: {
      promote: row.promote == null ? true : Number(row.promote) === 1,
      strategy: row.promotion_strategy,
      required_reason: row.promotion_required_reason,
      input: parseJsonOrNull(row.promotion_input_json),
      result: parseJsonOrNull(row.promotion_result_json),
    },
    recovery: {
      status: row.recovery_status ?? 'none',
      attempts: row.recovery_attempts == null ? 0 : Number(row.recovery_attempts),
      reason: row.recovery_reason ?? null,
      side_effect: row.side_effect ?? 'none',
      allow_auto_retry: row.allow_auto_retry != null && Number(row.allow_auto_retry) === 1,
    },
    evidence: {
      artifact_path: row.artifact_path ?? null,
      promotion_result: parseJsonOrNull(row.promotion_result_json),
    },
    recovery_classification: deriveRecoveryClassification(row),
    effective_state: effectiveState,
    needs_operator: needsOperator,
    sort_group: deriveSortGroup(effectiveState, needsOperator),
    supersede_link: row.supersede_link,
    source_metadata: {
      source: 'dispatch_scheduler_queue',
      team_id: row.team_id,
      from_actor: row.from_actor,
      channel: row.channel,
      provider: row.provider,
      runtime: row.runtime,
      priority: row.priority == null ? null : Number(row.priority),
      attempt_count: row.attempt_count == null ? null : Number(row.attempt_count),
      bounce_count: row.bounce_count == null ? null : Number(row.bounce_count),
      not_before_at: row.not_before_at,
    },
    source: 'manager-http',
  };
}

/**
 * Cn-EVE.1 (2026-06-16): derive the false_expire_recovered classification
 * from the row's auto-recovery + failure fields. Pure function — exported
 * so tests can pin the contract without going through the DB.
 *
 * A row is "false_expire_recovered" when ALL of the following hold:
 *   1. status === 'done' (terminal-positive)
 *   2. recovery_status is one of {'landed_reconciled', 'verified_done'}
 *      (i.e., the auto-recovery wiring touched the row)
 *   3. failure_kind is set (the row had a real failure on the way through,
 *      which is what makes the recovery "false expire" rather than a clean
 *      completion)
 *
 * Evidence kind ranking (most specific wins):
 *   - 'commit_evidence' when recovery_status === 'verified_done' OR
 *     recovery_reason matches the "commit <sha> verified on <base>" pattern
 *   - 'artifact' when artifact_path is set and no commit evidence
 *   - 'promotion' when promotion_result.repos[0].promoted_sha is set and no
 *     commit evidence and no artifact_path
 *   - 'unknown' as a safe fallback
 *
 * Returns null for rows that were not auto-recovered (normal done / still
 * failed / never failed).
 */
export type RecoveryClassificationRow = Pick<
  DispatchDbRow,
  | "status"
  | "recovery_status"
  | "recovery_reason"
  | "failure_kind"
  | "failure_detail"
  | "artifact_path"
  | "promotion_result_json"
>;

const COMMIT_EVIDENCE_REASON_RE = /\bcommit\s+([0-9a-f]{7,40})\s+verified\s+on\b/i;

export function deriveRecoveryClassification(
  row: RecoveryClassificationRow,
): {
  false_expire_recovered: boolean;
  original_failure_reason: { kind: string | null; detail: string | null } | null;
  recovery_evidence: {
    kind: "commit_evidence" | "artifact" | "promotion" | "unknown";
    commit_sha: string | null;
    artifact_path: string | null;
    promotion_sha: string | null;
    reason_text: string | null;
  };
} | null {
  const isAutoRecovered =
    row.status === "done" &&
    (row.recovery_status === "landed_reconciled" ||
      row.recovery_status === "verified_done");
  if (!isAutoRecovered) return null;

  // No original failure → this wasn't a "false expire" — the row just got
  // recovered without ever being marked failed. Surface as not-a-recovery
  // so consumers don't render "recovered" badge on clean rows.
  const hadFailure = !!row.failure_kind && row.failure_kind.length > 0;
  if (!hadFailure) return null;

  // Extract commit SHA from recovery_reason (the canonical
  // "commit <sha> verified on <base>" shape from markRecoveryLanded).
  const reasonText = row.recovery_reason ?? null;
  const reasonMatch = reasonText ? reasonText.match(COMMIT_EVIDENCE_REASON_RE) : null;
  const commitShaFromReason = reasonMatch ? reasonMatch[1] : null;

  // Promotion SHA — first repo's promoted_sha on the promotion_result.
  let promotionSha: string | null = null;
  const promo = parseJsonOrNull(row.promotion_result_json);
  if (promo && typeof promo === "object" && !Array.isArray(promo)) {
    const repos = (promo as { repos?: unknown[] }).repos;
    if (Array.isArray(repos) && repos.length > 0) {
      const first = repos[0];
      if (first && typeof first === "object") {
        const sha = (first as { promoted_sha?: unknown }).promoted_sha;
        if (typeof sha === "string" && sha.length > 0) {
          promotionSha = sha;
        }
      }
    }
  }

  // Classify the evidence kind (most-specific wins).
  let kind: "commit_evidence" | "artifact" | "promotion" | "unknown" = "unknown";
  if (row.recovery_status === "verified_done" || commitShaFromReason) {
    kind = "commit_evidence";
  } else if (row.artifact_path) {
    kind = "artifact";
  } else if (promotionSha) {
    kind = "promotion";
  }

  return {
    false_expire_recovered: true,
    original_failure_reason: {
      kind: row.failure_kind ?? null,
      detail: row.failure_detail ?? null,
    },
    recovery_evidence: {
      kind,
      commit_sha: commitShaFromReason,
      artifact_path: row.artifact_path ?? null,
      promotion_sha: promotionSha,
      reason_text: reasonText,
    },
  };
}

/**
 * T13.2 (2026-06-17, phid:disp-1e2819f568b08704): derive `effective_state`
 * from {state, failure_kind, recovery_status, recovery_evidence} per the
 * CTO taxonomy scope at cto/output/2026-06-16-dispatch-failure-state-
 * taxonomy-scope.md §"Derivation Rules". Pure function — exported for
 * tests and future T13.4 console consumers.
 *
 * Rule order matches the scope verbatim. First matching rule wins.
 *
 * Strict-mode failure_reason enum (per spec) hasn't fully landed yet —
 * we map the existing free-text `failure_kind` values into the same
 * decision tree. `recovery_evidence` is derived from the existing
 * `recovery_classification` (Cn-EVE.1 commit 292125f).
 *
 * supersede_link is NOT yet on the schema (documented as v2 follow-up
 * in the closeout). Rules 4 and the "moot via rate-limit + supersede"
 * branch of rule 7 always evaluate as no-supersede until the column
 * lands. This means rate-limit/provider retry rows without a recovery
 * landing fall to `failed_needs_operator`, which is the safe direction
 * per scope §7 ("retryable does not mean ignorable").
 */
export type EffectiveStateRow = Pick<
  DispatchDbRow,
  | "status"
  | "recovery_status"
  | "recovery_reason"
  | "failure_kind"
  | "failure_detail"
  | "artifact_path"
  | "promotion_result_json"
  | "not_before_at"
  | "started_at"
  | "updated_at"
  | "provider"
  | "supersede_link"
>;

/**
 * T-RECON.2 (2026-06-22): options threaded into the classification so a failure
 * on a now-disabled provider mootes instead of sitting in NEEDS-YOU forever.
 */
export interface DeriveOptions {
  /** Providers intentionally disabled (model-policy constrained_providers).
   *  A failed dispatch on one of these is a dead ghost — retry is pointless,
   *  the work re-routes via Codex Light — so it mootes. */
  constrainedProviders?: Iterable<string>;
}

// The Codex usage-limit signature. Pre-Codex-Light these failed dispatches were
// mislabeled provider='anthropic'/runtime='claude-code-cli' but the underlying
// runtime was Codex; the durable signal is the chatgpt.com/codex limit URL.
const CODEX_USAGE_LIMIT_RE = /chatgpt\.com\/codex|hit your usage limit/i;

/** True when a failed row is a dead ghost on an intentionally-disabled provider. */
export function isConstrainedProviderDead(
  row: Pick<DispatchDbRow, "provider" | "failure_detail">,
  constrained: Set<string>,
): boolean {
  if (constrained.size === 0) return false;
  if (row.provider && constrained.has(row.provider)) return true;
  // openai constrained (Codex Light) → also catch Codex-usage-limit failures
  // that were recorded under a mislabeled provider.
  if (constrained.has("openai") && row.failure_detail && CODEX_USAGE_LIMIT_RE.test(row.failure_detail)) {
    return true;
  }
  return false;
}

// Strict-mode hard-failure reasons that should always surface to the
// operator (rule 6). The current data uses free-text failure_kind values;
// we accept the strict-mode names AND the common existing kinds that map
// to them.
const HARD_FAILURE_REASONS = new Set([
  "provider_auth_error",
  "context_length_error",
  "tool_error",
  "agent_refusal",
  "malformed_agent_response",
  "dispatch_id_mismatch",
  "dispatch_not_found",
  "unknown_error",
]);

// Retryable provider failure reasons (rule 7).
const RETRYABLE_PROVIDER_REASONS = new Set([
  "rate_limit_error",
  "provider_server_error",
  "provider_timeout",
]);

// Recovery statuses that prove the work landed (rule 3 / 2).
const LANDED_RECOVERY_STATUSES = new Set(["landed_reconciled", "verified_done", "retry_done"]);

// Triaged-moot recovery statuses (rule 4) — infra-death / superseded, not a
// genuine operator-action item.
const MOOT_RECOVERY_STATUSES = new Set(["moot"]);

// Recovery-terminal failure statuses (rule 5).
const RECOVERY_TERMINAL_FAILURE_STATUSES = new Set([
  "unsafe_blocked",
  "unsafe_side_effect",
  "exhausted",
  "operator_attention",
  "needs_operator",
]);

export function deriveEffectiveState(row: EffectiveStateRow, opts: DeriveOptions = {}): string {
  // Rule 1 — raw active states.
  if (row.status === "queued") return "queued";
  if (row.status === "in_flight") return "in_flight";

  // Rule 2 — done states (split done vs done_recovered).
  if (row.status === "done") {
    if (row.recovery_status && LANDED_RECOVERY_STATUSES.has(row.recovery_status)) {
      // A row that ended up `done` after the recovery wiring reconciled it
      // (the "false expire" / "lost closeout" pattern) gets done_recovered.
      // Cn-EVE.1's recovery_classification.false_expire_recovered is the
      // same signal viewed from the row side; here we just emit the label.
      // Only flag as done_recovered when there was a real prior failure —
      // otherwise it's a clean done that happened to share a marker.
      if (row.failure_kind && row.failure_kind.length > 0) {
        return "done_recovered";
      }
    }
    return "done";
  }

  // For non-failed/non-active states (cancelled, needs_clarification, etc.)
  // pass through the raw state so consumers can branch on it.
  if (row.status !== "failed") return row.status;

  // From here on, status === 'failed'.

  // Rule 3 — recovery evidence proves the work landed.
  // We accept landed_reconciled, verified_done, retry_done as landed
  // recovery statuses. The cto scope says "recovery_evidence.landed === true"
  // — the existing recovery_classification block computes that for us.
  if (row.recovery_status && LANDED_RECOVERY_STATUSES.has(row.recovery_status)) {
    return "failed_work_landed_recoverable";
  }

  // Rule 4 — triaged MOOT: a dispatch reconciled as an infra-death (scheduler
  // wedge / manager↔agent transport-exhaustion / closeout-expiry) or superseded
  // by a later run is NOT a genuine operator-action item. It carries
  // recovery_status='moot' set by the reconciler and surfaces as
  // moot_or_superseded (out of the NEEDS-YOU queue), distinct from a clean
  // done_recovered which asserts the work landed.
  if (row.recovery_status && MOOT_RECOVERY_STATUSES.has(row.recovery_status)) {
    return "moot_or_superseded";
  }

  // Rule 4a (T-RECON.2) — SUPERSEDE_LINK: the work was redone/superseded by a
  // later dispatch. The documented rule 7/4 supersede branch, now that the
  // column exists. Out of NEEDS-YOU.
  if (row.supersede_link && row.supersede_link.length > 0) {
    return "moot_or_superseded";
  }

  // Rule 4b (T-RECON.2) — CONSTRAINED-PROVIDER MOOT: a failure on a provider
  // that is intentionally disabled (model-policy constrained_providers — e.g.
  // openai while we run Codex Light) is a dead ghost. Retry is pointless; if the
  // work mattered it re-routes to the fallback. Don't make the operator triage a
  // dead-provider failure. Takes precedence over the needs_operator rules below.
  if (isConstrainedProviderDead(row, toSet(opts.constrainedProviders))) {
    return "moot_or_superseded";
  }

  // Rule 5 — recovery-terminal failure statuses always need an operator.
  if (row.recovery_status && RECOVERY_TERMINAL_FAILURE_STATUSES.has(row.recovery_status)) {
    return "failed_needs_operator";
  }

  // Rule 6 — strict-mode hard failures.
  if (row.failure_kind && HARD_FAILURE_REASONS.has(row.failure_kind)) {
    return "failed_needs_operator";
  }

  // Rule 7 — retryable provider failures without supersede or evidence.
  if (row.failure_kind && RETRYABLE_PROVIDER_REASONS.has(row.failure_kind)) {
    return "failed_needs_operator";
  }

  // Rule 8 — fallback. Unknown failures surface as needs_operator.
  return "failed_needs_operator";
}

/**
 * T13.2 needs-you flag — companion to effective_state. Per scope §"Needs-
 * You Flag", a row counts as needs_operator when:
 *   - effective_state === "failed_needs_operator"
 *   - effective_state === "queued" and queued_age >= QUEUED_STALE_MIN
 *   - effective_state === "in_flight" and silence_age >= INFLIGHT_STALE_MIN
 *
 * needs_clarification active is also a needs_operator signal but lives
 * outside this row's columns (in needs_input.active); the read row will
 * surface it via the needs_input block already. We keep this helper
 * focused on the staleness math.
 */
const QUEUED_STALE_MINUTES = 20;
const INFLIGHT_STALE_MINUTES = 45;

export function deriveNeedsOperator(
  row: EffectiveStateRow,
  nowMs: number = Date.now(),
  opts: DeriveOptions = {},
): boolean {
  const effective = deriveEffectiveState(row, opts);
  if (effective === "failed_needs_operator") return true;
  if (effective === "queued") {
    const queuedAtMs = parseDateMs(row.not_before_at);
    if (queuedAtMs == null) return false;
    return nowMs - queuedAtMs >= QUEUED_STALE_MINUTES * 60_000;
  }
  if (effective === "in_flight") {
    // "silence" age proxy: started_at + INFLIGHT_STALE_MINUTES. The scope
    // mentions last_output_at but that column is not yet on the schema
    // (T11.x output-cadence work). Use started_at as a coarse proxy until
    // last_output_at lands.
    const startedAtMs = parseDateMs(row.started_at);
    if (startedAtMs == null) return false;
    return nowMs - startedAtMs >= INFLIGHT_STALE_MINUTES * 60_000;
  }
  return false;
}

/**
 * T13.3 (2026-06-24, phid:disp-dab6b426faa23147): derive the sort band a
 * dispatch row belongs to, per cto/output/2026-06-16-dispatch-failure-state-
 * taxonomy-scope.md §"Default Sort Policy" `groupRank`. The third field the
 * scope's Build Sequence step 3 names alongside effective_state +
 * needs_operator. Pure + exported for the console (T13.4) and the page-title
 * counts so the grouping is derived once server-side, not re-implemented in
 * the UI.
 *
 * Returns a small integer (lower sorts higher), matching the scope verbatim:
 *
 *   0  needs you      — any needs_operator row, regardless of effective_state
 *                       (covers failed_needs_operator AND stale queued /
 *                       in_flight; the scope merges its
 *                       *_needs_operator variants to rank 0).
 *   1  in_flight      — healthy running work.
 *   2  queued         — ready / soon-ready work.
 *   3  recovered band — done_recovered AND failed_work_landed_recoverable
 *                       (collapsed; same rank per the scope).
 *   4  done           — clean completions (collapsed).
 *   5  moot_or_superseded — out of the way at the bottom.
 *
 * Note: `needs_operator` already folds in the stale-queued / stale-in_flight
 * timing (deriveNeedsOperator) and the failed_needs_operator state, so the
 * `needsOperator` short-circuit is the single source of the rank-0 group. The
 * active clarification signal lives in `needs_input.active` (outside this
 * row's columns, same as for needs_operator) and is layered on by the UI.
 *
 * Any state not in the scope's map (cancelled / bounced / needs_clarification
 * / resume_delivery_failed / unknown forwards-compat values) sorts into the
 * active band (rank 2) rather than collapsing into terminal history — the safe
 * direction, keeping unexpected rows visible to the operator.
 */
export function deriveSortGroup(effectiveState: string, needsOperator: boolean): number {
  if (needsOperator) return 0;
  switch (effectiveState) {
    case "failed_needs_operator":
      return 0; // defensive: always paired with needs_operator=true upstream.
    case "in_flight":
      return 1;
    case "queued":
      return 2;
    case "done_recovered":
    case "failed_work_landed_recoverable":
      return 3;
    case "done":
      return 4;
    case "moot_or_superseded":
      return 5;
    default:
      return 2;
  }
}

function parseDateMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return t;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  const parsed = parseJsonOrNull(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  const parsed = parseJsonOrNull(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJsonOrNull(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeStat(filePath: string) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function extractOutputPaths(text: string): string[] {
  const paths = new Set<string>();
  const absolutePathRe = /\/[^\s)\]]+\/output\/[^\s)\]]+\.(?:md|markdown|txt|csv|json|html|pdf)\b/g;
  for (const match of text.matchAll(absolutePathRe)) {
    paths.add(match[0]);
  }
  return Array.from(paths);
}

function dedupeArtifactsByPath(artifacts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const artifact of artifacts) {
    const key = typeof artifact.path === 'string' ? artifact.path : String(artifact.id ?? '');
    if (!key) continue;
    const prior = byPath.get(key);
    if (!prior || sourceRank(artifact) < sourceRank(prior)) {
      byPath.set(key, artifact);
    }
  }
  return Array.from(byPath.values());
}

function sourceRank(artifact: Record<string, unknown>): number {
  const metadata = artifact.source_metadata as { source?: unknown } | undefined;
  switch (metadata?.source) {
    case 'dispatch_scheduler_queue.result_json':
      return 0;
    case 'queries.result':
      return 1;
    default:
      return 2;
  }
}
