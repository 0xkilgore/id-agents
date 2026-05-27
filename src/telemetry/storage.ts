// SPDX-License-Identifier: MIT
// P6 Agent Performance Telemetry — storage layer.
// Append-only event table, snapshot projections, and signal store.

import type { DbAdapter } from '../db/db-adapter.js';
import type { TelemetryEvent, PerformanceSnapshot, AgentSignal, WindowKind, SignalKind, SignalSeverity, Confidence } from './types.js';

/**
 * Idempotent DDL — safe to call on every startup (CREATE IF NOT EXISTS + try/catch).
 */
export function migrateTelemetryTables(adapter: DbAdapter): void {
  const exec = (sql: string) => {
    if (adapter.dialect === 'sqlite') {
      (adapter as any).exec?.(sql) ?? adapter.query(sql);
    } else {
      adapter.query(sql);
    }
  };

  exec(`
    CREATE TABLE IF NOT EXISTS agent_telemetry_event (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      dispatch_id TEXT,
      query_id TEXT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'canonical',
      payload_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT NOT NULL UNIQUE
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS telemetry_event_agent_ts_idx ON agent_telemetry_event(agent_id, ts)`);
  exec(`CREATE INDEX IF NOT EXISTS telemetry_event_kind_idx ON agent_telemetry_event(kind, ts)`);
  exec(`CREATE INDEX IF NOT EXISTS telemetry_event_dispatch_idx ON agent_telemetry_event(dispatch_id) WHERE dispatch_id IS NOT NULL`);

  exec(`
    CREATE TABLE IF NOT EXISTS agent_performance_snapshot (
      agent_id TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_start TEXT NOT NULL,
      dispatches_started INTEGER NOT NULL DEFAULT 0,
      dispatches_completed INTEGER NOT NULL DEFAULT 0,
      dispatches_failed INTEGER NOT NULL DEFAULT 0,
      dispatches_stuck INTEGER NOT NULL DEFAULT 0,
      needs_clarification_count INTEGER NOT NULL DEFAULT 0,
      artifacts_created INTEGER NOT NULL DEFAULT 0,
      weighted_tokens INTEGER NOT NULL DEFAULT 0,
      high_burn_no_output_events INTEGER NOT NULL DEFAULT 0,
      cto_corrections_count INTEGER NOT NULL DEFAULT 0,
      operator_revision_requests INTEGER NOT NULL DEFAULT 0,
      source_coverage_json TEXT NOT NULL DEFAULT '{}',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, window_kind, window_start)
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS agent_signal (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      subject TEXT,
      title TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'canonical',
      resolved_at TEXT
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS agent_signal_agent_kind_idx ON agent_signal(agent_id, kind)`);
  exec(`CREATE INDEX IF NOT EXISTS agent_signal_kind_resolved_idx ON agent_signal(kind, resolved_at)`);
  exec(`CREATE INDEX IF NOT EXISTS agent_signal_severity_idx ON agent_signal(severity, resolved_at)`);

  // Cursor table for ingestors that need to track progress (e.g. stuck detector file cursor)
  exec(`
    CREATE TABLE IF NOT EXISTS telemetry_ingest_cursor (
      source TEXT PRIMARY KEY,
      cursor_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// Event CRUD
// ---------------------------------------------------------------------------

export async function insertEvent(adapter: DbAdapter, evt: TelemetryEvent): Promise<boolean> {
  try {
    await adapter.query(
      `INSERT INTO agent_telemetry_event (event_id, kind, agent_id, dispatch_id, query_id, ts, source, confidence, payload_json, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [evt.event_id, evt.kind, evt.agent_id, evt.dispatch_id, evt.query_id, evt.ts, evt.source, evt.confidence, evt.payload_json, evt.idempotency_key],
    );
    return true;
  } catch (err: any) {
    // Idempotency: UNIQUE constraint violation on idempotency_key means already inserted
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === '23505' || /UNIQUE constraint/i.test(err?.message ?? '')) {
      return false;
    }
    throw err;
  }
}

export async function queryEvents(
  adapter: DbAdapter,
  opts: { agentId?: string; kind?: string; since?: number; until?: number; limit?: number },
): Promise<TelemetryEvent[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.agentId) { clauses.push(`agent_id = $${idx++}`); params.push(opts.agentId); }
  if (opts.kind) { clauses.push(`kind = $${idx++}`); params.push(opts.kind); }
  if (opts.since != null) { clauses.push(`ts >= $${idx++}`); params.push(opts.since); }
  if (opts.until != null) { clauses.push(`ts < $${idx++}`); params.push(opts.until); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 1000;
  const { rows } = await adapter.query<TelemetryEvent>(
    `SELECT * FROM agent_telemetry_event ${where} ORDER BY ts ASC LIMIT $${idx}`,
    [...params, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Snapshot CRUD
// ---------------------------------------------------------------------------

export async function upsertSnapshot(adapter: DbAdapter, snap: PerformanceSnapshot): Promise<void> {
  await adapter.query(
    `INSERT INTO agent_performance_snapshot
       (agent_id, window_kind, window_start, dispatches_started, dispatches_completed,
        dispatches_failed, dispatches_stuck, needs_clarification_count, artifacts_created,
        weighted_tokens, high_burn_no_output_events, cto_corrections_count,
        operator_revision_requests, source_coverage_json, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (agent_id, window_kind, window_start) DO UPDATE SET
       dispatches_started = excluded.dispatches_started,
       dispatches_completed = excluded.dispatches_completed,
       dispatches_failed = excluded.dispatches_failed,
       dispatches_stuck = excluded.dispatches_stuck,
       needs_clarification_count = excluded.needs_clarification_count,
       artifacts_created = excluded.artifacts_created,
       weighted_tokens = excluded.weighted_tokens,
       high_burn_no_output_events = excluded.high_burn_no_output_events,
       cto_corrections_count = excluded.cto_corrections_count,
       operator_revision_requests = excluded.operator_revision_requests,
       source_coverage_json = excluded.source_coverage_json,
       computed_at = excluded.computed_at`,
    [
      snap.agent_id, snap.window_kind, snap.window_start,
      snap.dispatches_started, snap.dispatches_completed, snap.dispatches_failed,
      snap.dispatches_stuck, snap.needs_clarification_count, snap.artifacts_created,
      snap.weighted_tokens, snap.high_burn_no_output_events, snap.cto_corrections_count,
      snap.operator_revision_requests, snap.source_coverage_json, snap.computed_at,
    ],
  );
}

export async function getSnapshots(
  adapter: DbAdapter,
  opts: { agentId?: string; windowKind: WindowKind; windowStart: string },
): Promise<PerformanceSnapshot[]> {
  const clauses = [`window_kind = $1`, `window_start = $2`];
  const params: unknown[] = [opts.windowKind, opts.windowStart];
  if (opts.agentId) {
    clauses.push(`agent_id = $3`);
    params.push(opts.agentId);
  }
  const { rows } = await adapter.query<PerformanceSnapshot>(
    `SELECT * FROM agent_performance_snapshot WHERE ${clauses.join(' AND ')}`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Signal CRUD
// ---------------------------------------------------------------------------

export async function upsertSignal(adapter: DbAdapter, sig: AgentSignal): Promise<void> {
  await adapter.query(
    `INSERT INTO agent_signal
       (id, kind, severity, agent_id, subject, title, first_seen_at, last_seen_at, source_refs_json, confidence, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       title = excluded.title,
       source_refs_json = excluded.source_refs_json,
       resolved_at = excluded.resolved_at`,
    [sig.id, sig.kind, sig.severity, sig.agent_id, sig.subject, sig.title,
     sig.first_seen_at, sig.last_seen_at, sig.source_refs_json, sig.confidence, sig.resolved_at],
  );
}

export async function querySignals(
  adapter: DbAdapter,
  opts: { kind?: SignalKind; severity?: SignalSeverity; agentId?: string; since?: string; unresolvedOnly?: boolean; limit?: number },
): Promise<AgentSignal[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.kind) { clauses.push(`kind = $${idx++}`); params.push(opts.kind); }
  if (opts.severity) { clauses.push(`severity = $${idx++}`); params.push(opts.severity); }
  if (opts.agentId) { clauses.push(`agent_id = $${idx++}`); params.push(opts.agentId); }
  if (opts.since) { clauses.push(`last_seen_at >= $${idx++}`); params.push(opts.since); }
  if (opts.unresolvedOnly) { clauses.push(`resolved_at IS NULL`); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 200;
  const { rows } = await adapter.query<AgentSignal>(
    `SELECT * FROM agent_signal ${where} ORDER BY last_seen_at DESC LIMIT $${idx}`,
    [...params, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export async function getCursor(adapter: DbAdapter, source: string): Promise<string | null> {
  const { rows } = await adapter.query<{ cursor_value: string }>(
    `SELECT cursor_value FROM telemetry_ingest_cursor WHERE source = $1`,
    [source],
  );
  return rows[0]?.cursor_value ?? null;
}

export async function setCursor(adapter: DbAdapter, source: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `INSERT INTO telemetry_ingest_cursor (source, cursor_value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (source) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`,
    [source, value, now],
  );
}
