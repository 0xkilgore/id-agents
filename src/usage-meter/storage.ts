// Usage Meter — sqlite persistence helpers.
// Idempotent event inserts, rollup upserts, gate-decision audit log.

import type { DbAdapter } from "../db/db-adapter.js";
import type {
  AgentUsageEvent,
  AgentUsageRollup,
  ProviderLimitSignal,
  Provider,
  UsageGateDecisionRecord,
  WindowKind,
} from "./types.js";

// ── Events ───────────────────────────────────────────────────────────

export interface UpsertEventResult {
  inserted: boolean;
}

export async function upsertAgentUsageEvent(
  adapter: DbAdapter,
  event: AgentUsageEvent,
): Promise<UpsertEventResult> {
  // INSERT OR IGNORE keeps idempotency by unique idempotency_key.
  const r = await adapter.query(
    `INSERT OR IGNORE INTO agent_usage_event (
       event_id, provider, agent_id, dispatch_id, query_id, session_id, model, ts,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       raw_tokens, weighted_tokens, source, confidence, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.event_id,
      event.provider,
      event.agent_id,
      event.dispatch_id,
      event.query_id,
      event.session_id,
      event.model,
      event.ts,
      event.input_tokens,
      event.output_tokens,
      event.cache_creation_input_tokens,
      event.cache_read_input_tokens,
      event.raw_tokens,
      event.weighted_tokens,
      event.source,
      event.confidence,
      event.idempotency_key,
    ],
  );
  return { inserted: r.rowCount > 0 };
}

export interface ListEventsFilter {
  since_ms?: number;
  agent_id?: string;
  limit: number;
}

export async function listRecentAgentUsageEvents(
  adapter: DbAdapter,
  filter: ListEventsFilter,
): Promise<AgentUsageEvent[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.since_ms !== undefined) {
    where.push("ts >= ?");
    params.push(filter.since_ms);
  }
  if (filter.agent_id) {
    where.push("agent_id = ?");
    params.push(filter.agent_id);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(filter.limit);
  const { rows } = await adapter.query<EventRow>(
    `SELECT * FROM agent_usage_event ${whereSql} ORDER BY ts DESC LIMIT ?`,
    params,
  );
  return rows.map(rowToEvent);
}

interface EventRow {
  event_id: string;
  provider: string;
  agent_id: string;
  dispatch_id: string | null;
  query_id: string | null;
  session_id: string | null;
  model: string | null;
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  raw_tokens: number;
  weighted_tokens: number;
  source: string;
  confidence: string;
  idempotency_key: string;
}

function rowToEvent(r: EventRow): AgentUsageEvent {
  return {
    event_id: r.event_id,
    provider: r.provider as Provider,
    agent_id: r.agent_id,
    dispatch_id: r.dispatch_id,
    query_id: r.query_id,
    session_id: r.session_id,
    model: r.model,
    ts: r.ts,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_creation_input_tokens: r.cache_creation_input_tokens,
    cache_read_input_tokens: r.cache_read_input_tokens,
    raw_tokens: r.raw_tokens,
    weighted_tokens: r.weighted_tokens,
    source: r.source as AgentUsageEvent["source"],
    confidence: r.confidence as AgentUsageEvent["confidence"],
    idempotency_key: r.idempotency_key,
  };
}

// ── Rollups ──────────────────────────────────────────────────────────

export async function upsertAgentUsageRollup(
  adapter: DbAdapter,
  rollup: AgentUsageRollup,
): Promise<void> {
  await adapter.query(
    `INSERT INTO agent_usage_rollup (
       provider, agent_id, window_kind, window_start, window_end,
       raw_tokens, weighted_tokens, requests, models_json, source_coverage_json, computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, agent_id, window_kind, window_start) DO UPDATE SET
       window_end = excluded.window_end,
       raw_tokens = excluded.raw_tokens,
       weighted_tokens = excluded.weighted_tokens,
       requests = excluded.requests,
       models_json = excluded.models_json,
       source_coverage_json = excluded.source_coverage_json,
       computed_at = excluded.computed_at`,
    [
      rollup.provider,
      rollup.agent_id,
      rollup.window_kind,
      rollup.window_start,
      rollup.window_end,
      rollup.raw_tokens,
      rollup.weighted_tokens,
      rollup.requests,
      JSON.stringify(rollup.models),
      JSON.stringify(rollup.source_coverage),
      rollup.computed_at,
    ],
  );
}

export interface GetRollupKey {
  provider: Provider;
  agent_id: string;
  window_kind: WindowKind;
  window_start: string;
}

interface RollupRow {
  provider: string;
  agent_id: string;
  window_kind: string;
  window_start: string;
  window_end: string;
  raw_tokens: number;
  weighted_tokens: number;
  requests: number;
  models_json: string;
  source_coverage_json: string;
  computed_at: string;
}

function rowToRollup(r: RollupRow): AgentUsageRollup {
  return {
    provider: r.provider as Provider,
    agent_id: r.agent_id,
    window_kind: r.window_kind as WindowKind,
    window_start: r.window_start,
    window_end: r.window_end,
    raw_tokens: r.raw_tokens,
    weighted_tokens: r.weighted_tokens,
    requests: r.requests,
    models: safeJsonArray(r.models_json),
    source_coverage: safeJsonObject(r.source_coverage_json) as Record<string, number>,
    computed_at: r.computed_at,
  };
}

export async function getAgentUsageRollup(
  adapter: DbAdapter,
  key: GetRollupKey,
): Promise<AgentUsageRollup | null> {
  const { rows } = await adapter.query<RollupRow>(
    `SELECT * FROM agent_usage_rollup
     WHERE provider = ? AND agent_id = ? AND window_kind = ? AND window_start = ?`,
    [key.provider, key.agent_id, key.window_kind, key.window_start],
  );
  return rows[0] ? rowToRollup(rows[0]) : null;
}

export async function listAgentUsageRollupsForWindow(
  adapter: DbAdapter,
  filter: { provider: Provider; window_kind: WindowKind; window_start: string },
): Promise<AgentUsageRollup[]> {
  const { rows } = await adapter.query<RollupRow>(
    `SELECT * FROM agent_usage_rollup
     WHERE provider = ? AND window_kind = ? AND window_start = ?
     ORDER BY weighted_tokens DESC`,
    [filter.provider, filter.window_kind, filter.window_start],
  );
  return rows.map(rowToRollup);
}

interface ProviderLimitRow {
  dispatch_phid: string;
  to_agent: string;
  provider: string;
  runtime: string | null;
  not_before_at: string;
  last_bounce_json: string | null;
  updated_at: string;
}

export async function listActiveProviderLimitSignals(
  adapter: DbAdapter,
  nowIso: string,
): Promise<ProviderLimitSignal[]> {
  const { rows } = await adapter.query<ProviderLimitRow>(
    `SELECT dispatch_phid, to_agent, provider, runtime, not_before_at, last_bounce_json, updated_at
       FROM dispatch_scheduler_queue
      WHERE status = 'bounced'
        AND last_bounce_json IS NOT NULL
        AND not_before_at > ?
      ORDER BY updated_at DESC
      LIMIT 50`,
    [nowIso],
  );
  const out: ProviderLimitSignal[] = [];
  for (const row of rows) {
    const bounce = safeJsonObject(row.last_bounce_json ?? "{}");
    const kind = typeof bounce.kind === "string" ? bounce.kind : "";
    const message = typeof bounce.message === "string" ? bounce.message : "";
    const lower = `${kind} ${message}`.toLowerCase();
    const isProviderLimit =
      kind === "provider_limit" ||
      kind === "provider_throttle" ||
      lower.includes("rate_limit") ||
      lower.includes("rate limit") ||
      lower.includes("usage limit") ||
      lower.includes("too many requests") ||
      lower.includes("429");
    if (!isProviderLimit) continue;
    out.push({
      provider: normalizeProvider(row.provider),
      runtime: row.runtime ?? null,
      agent: row.to_agent,
      dispatch_phid: row.dispatch_phid,
      observed_at: typeof bounce.ts === "string" ? bounce.ts : row.updated_at,
      reset_at: row.not_before_at,
      message,
      source: "scheduler_bounce",
    });
  }
  return out;
}

function normalizeProvider(raw: string): Provider {
  return raw === "anthropic" || raw === "openai" || raw === "cursor" || raw === "other"
    ? raw
    : "other";
}

// ── Gate decisions ───────────────────────────────────────────────────

export async function insertUsageGateDecision(
  adapter: DbAdapter,
  decision: UsageGateDecisionRecord,
): Promise<void> {
  await adapter.query(
    `INSERT INTO usage_gate_decision (
       id, ts, scope, agent_id, state, decision, reason,
       daily_pct, weekly_pct, policy_version, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.id,
      decision.ts,
      decision.scope,
      decision.agent_id,
      decision.state,
      decision.decision,
      decision.reason,
      decision.daily_pct,
      decision.weekly_pct,
      decision.policy_version,
      JSON.stringify(decision.metadata),
    ],
  );
}

export interface ListGateDecisionsFilter {
  limit: number;
  agent_id?: string;
  since_ms?: number;
}

interface GateDecisionRow {
  id: string;
  ts: number;
  scope: string;
  agent_id: string | null;
  state: string;
  decision: string;
  reason: string;
  daily_pct: number | null;
  weekly_pct: number | null;
  policy_version: string;
  metadata_json: string;
}

export async function listRecentUsageGateDecisions(
  adapter: DbAdapter,
  filter: ListGateDecisionsFilter,
): Promise<UsageGateDecisionRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.agent_id) {
    where.push("agent_id = ?");
    params.push(filter.agent_id);
  }
  if (filter.since_ms !== undefined) {
    where.push("ts >= ?");
    params.push(filter.since_ms);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(filter.limit);
  const { rows } = await adapter.query<GateDecisionRow>(
    `SELECT * FROM usage_gate_decision ${whereSql} ORDER BY ts DESC LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    scope: r.scope as "global" | "agent",
    agent_id: r.agent_id,
    state: r.state as UsageGateDecisionRecord["state"],
    decision: r.decision as UsageGateDecisionRecord["decision"],
    reason: r.reason,
    daily_pct: r.daily_pct,
    weekly_pct: r.weekly_pct,
    policy_version: r.policy_version,
    metadata: safeJsonObject(r.metadata_json),
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeJsonArray<T = string>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
