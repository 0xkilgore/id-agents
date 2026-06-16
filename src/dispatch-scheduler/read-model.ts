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

export async function readDispatches(
  adapter: DbAdapterLike,
  teamId: string,
  status: DispatchReadStatus,
  limit: number,
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
            side_effect, allow_auto_retry
       FROM dispatch_scheduler_queue
       WHERE team_id = ? AND status IN (${placeholders})
       ORDER BY COALESCE(completed_at, started_at, updated_at, not_before_at) DESC,
                dispatch_phid DESC
       LIMIT ?`,
    [teamId, ...statuses, limit],
  );
  return rows.map(rowToDispatch);
}

export async function readDispatchById(
  adapter: DbAdapterLike,
  teamId: string,
  dispatchId: string,
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
            side_effect, allow_auto_retry
       FROM dispatch_scheduler_queue
       WHERE team_id = ? AND (dispatch_phid = ? OR query_id = ? OR agent_query_id = ?)
       LIMIT 1`,
    [teamId, dispatchId, dispatchId, dispatchId],
  );
  return rows[0] ? rowToDispatch(rows[0]) : null;
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
  const artifacts = dedupeArtifactsByPath([...dispatchArtifacts, ...queryArtifacts, ...outputArtifacts])
    .sort((a, b) => String(b.modified_at ?? b.completed_at ?? '').localeCompare(String(a.modified_at ?? a.completed_at ?? '')))
    .slice(0, limit);
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

function rowToDispatch(row: DispatchDbRow): DispatchReadRow {
  const history = parseJsonArray(row.clarification_history_json);
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
