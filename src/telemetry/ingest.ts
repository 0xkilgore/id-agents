// SPDX-License-Identifier: MIT
// P6 Agent Performance Telemetry — ingest modules.
// Each ingestor reads a canonical source and writes idempotent telemetry events.

import crypto from 'crypto';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import type { DbAdapter } from '../db/db-adapter.js';
import { insertEvent, getCursor, setCursor } from './storage.js';
import type { TelemetryEvent, Confidence } from './types.js';

function makeEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// 1. Dispatch Ops — state transitions from dispatch_scheduler_queue
// ---------------------------------------------------------------------------

interface DispatchRow {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  failure_kind: string | null;
  attempt_count: number;
  bounce_count: number;
}

export async function ingestDispatchOps(adapter: DbAdapter): Promise<number> {
  const { rows } = await adapter.query<DispatchRow>(
    `SELECT dispatch_phid, query_id, to_agent, status, started_at, completed_at,
            updated_at, failure_kind, attempt_count, bounce_count
     FROM dispatch_scheduler_queue
     ORDER BY updated_at ASC`,
  );

  let count = 0;
  for (const row of rows) {
    // Emit one event per dispatch per status
    const key = `dispatch.state_changed:${row.dispatch_phid}:${row.status}`;
    const ts = row.updated_at ? new Date(row.updated_at).getTime() : Date.now();

    const evt: TelemetryEvent = {
      event_id: makeEventId(),
      kind: 'dispatch.state_changed',
      agent_id: row.to_agent,
      dispatch_id: row.dispatch_phid,
      query_id: row.query_id,
      ts,
      source: 'dispatch_ops',
      confidence: 'canonical',
      payload_json: JSON.stringify({
        to_state: row.status,
        failure_kind: row.failure_kind,
        attempt_count: row.attempt_count,
        bounce_count: row.bounce_count,
        started_at: row.started_at,
        completed_at: row.completed_at,
      }),
      idempotency_key: key,
    };

    if (await insertEvent(adapter, evt)) count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// 2. Usage Meter — read from the usage-meter v2 endpoint (or last cached)
// ---------------------------------------------------------------------------

interface UsageMeterAgentEntry {
  agent: string;
  daily_weighted_tokens: number;
  weekly_weighted_tokens: number;
  requests_today: number;
}

export async function ingestUsageMeter(
  adapter: DbAdapter,
  usageMeterUrl = 'http://127.0.0.1:4255',
): Promise<number> {
  let data: { agents?: UsageMeterAgentEntry[]; generated_at?: string } | null = null;
  let confidence: Confidence = 'canonical';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${usageMeterUrl}/usage`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      data = (await res.json()) as any;
    }
  } catch {
    // Usage meter unreachable — record as missing
  }

  if (!data?.agents || !Array.isArray(data.agents)) {
    // Emit a single coverage-missing event
    const key = `usage.coverage_missing:${new Date().toISOString().slice(0, 13)}`;
    const evt: TelemetryEvent = {
      event_id: makeEventId(),
      kind: 'usage.coverage_missing',
      agent_id: '_system',
      dispatch_id: null,
      query_id: null,
      ts: Date.now(),
      source: 'usage_meter_v2',
      confidence: 'missing',
      payload_json: JSON.stringify({ reason: 'usage-meter unreachable or empty' }),
      idempotency_key: key,
    };
    await insertEvent(adapter, evt);
    return 0;
  }

  const generatedAt = data.generated_at || new Date().toISOString();
  const windowKey = generatedAt.slice(0, 13); // hourly granularity
  let count = 0;

  for (const entry of data.agents) {
    const key = `usage.window_observed:${entry.agent}:${windowKey}`;
    const evt: TelemetryEvent = {
      event_id: makeEventId(),
      kind: 'usage.window_observed',
      agent_id: entry.agent,
      dispatch_id: null,
      query_id: null,
      ts: new Date(generatedAt).getTime() || Date.now(),
      source: 'usage_meter_v2',
      confidence,
      payload_json: JSON.stringify({
        daily_weighted_tokens: entry.daily_weighted_tokens,
        weekly_weighted_tokens: entry.weekly_weighted_tokens,
        requests_today: entry.requests_today,
      }),
      idempotency_key: key,
    };
    if (await insertEvent(adapter, evt)) count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// 3. Artifact Ops — from queries/news that indicate artifact creation
// ---------------------------------------------------------------------------

export async function ingestArtifactOps(adapter: DbAdapter): Promise<number> {
  // Look for agent-done news items that contain artifact_path
  const { rows } = await adapter.query<{
    id: number;
    agent_id: string | null;
    query_id: string | null;
    timestamp: number;
    data: string | null;
    message: string | null;
  }>(
    `SELECT id, agent_id, query_id, timestamp, data, message
     FROM news_items
     WHERE (type = 'agent_done' OR message LIKE '%artifact%')
     ORDER BY timestamp ASC`,
  );

  let count = 0;
  for (const row of rows) {
    const agentId = row.agent_id || '_unknown';
    let parsed: any = {};
    try { parsed = JSON.parse(row.data || '{}'); } catch {}

    const artifactPath = parsed.artifact_path || null;
    if (!artifactPath && !parsed.tl_dr) continue;

    const key = `artifact.created:${agentId}:${row.id}`;
    const evt: TelemetryEvent = {
      event_id: makeEventId(),
      kind: 'artifact.created',
      agent_id: agentId,
      dispatch_id: null,
      query_id: row.query_id,
      ts: row.timestamp,
      source: 'artifact_ops',
      confidence: 'canonical',
      payload_json: JSON.stringify({
        artifact_path: artifactPath,
        tl_dr: parsed.tl_dr,
      }),
      idempotency_key: key,
    };
    if (await insertEvent(adapter, evt)) count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// 4. Stuck Detector — walk cane/output/dispatch-hangs/*.md
// ---------------------------------------------------------------------------

export async function ingestStuckDetector(
  adapter: DbAdapter,
  dispatchHangsDir: string,
): Promise<number> {
  if (!existsSync(dispatchHangsDir)) return 0;

  const lastCursor = await getCursor(adapter, 'stuck_detector');
  const files = readdirSync(dispatchHangsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  const newFiles = lastCursor
    ? files.filter(f => f > lastCursor)
    : files;

  if (newFiles.length === 0) return 0;

  let count = 0;
  for (const file of newFiles) {
    const filePath = path.join(dispatchHangsDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Parse query IDs from the report
    const queryIdRe = /query_id `([^`]+)`/g;
    const queryMatches = content.matchAll(queryIdRe);
    for (const match of queryMatches) {
      const queryId = match[1];
      const escaped = queryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Extract agent — look for "target agent:** `<name>`" after the query_id line
      const agentRe = new RegExp('query_id `' + escaped + '`[\\s\\S]*?target agent:\\*\\* `([^`]+)`');
      const agentMatch = content.match(agentRe);
      const agentId = agentMatch?.[1] || '_unknown';

      // Extract PID state
      const pidRe = new RegExp('query_id `' + escaped + '`[\\s\\S]*?state `([^`]+)`');
      const pidMatch = content.match(pidRe);
      const pidState = pidMatch?.[1] || null;

      // Extract news count
      const newsRe = new RegExp('query_id `' + escaped + '`[\\s\\S]*?news events[^:]*:\\*\\* (\\d+)');
      const newsMatch = content.match(newsRe);
      const newsCount = newsMatch ? parseInt(newsMatch[1]) : null;

      const key = `dispatch.stuck_detected:${queryId}:${file}`;
      const evt: TelemetryEvent = {
        event_id: makeEventId(),
        kind: 'dispatch.stuck_detected',
        agent_id: agentId,
        dispatch_id: null,
        query_id: queryId,
        ts: Date.now(),
        source: 'stuck_detector',
        confidence: 'derived',
        payload_json: JSON.stringify({
          report_file: filePath,
          pid_state: pidState,
          news_count: newsCount,
        }),
        idempotency_key: key,
      };
      if (await insertEvent(adapter, evt)) count++;
    }
  }

  // Update cursor to last file processed
  if (newFiles.length > 0) {
    await setCursor(adapter, 'stuck_detector', newFiles[newFiles.length - 1]);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Run all ingestors
// ---------------------------------------------------------------------------

export interface IngestResult {
  dispatch_ops: number;
  usage_meter: number;
  artifact_ops: number;
  stuck_detector: number;
  total: number;
}

export async function runAllIngestors(
  adapter: DbAdapter,
  opts: { dispatchHangsDir: string; usageMeterUrl?: string },
): Promise<IngestResult> {
  const dispatch_ops = await ingestDispatchOps(adapter);
  const usage_meter = await ingestUsageMeter(adapter, opts.usageMeterUrl);
  const artifact_ops = await ingestArtifactOps(adapter);
  const stuck_detector = await ingestStuckDetector(adapter, opts.dispatchHangsDir);
  return {
    dispatch_ops,
    usage_meter,
    artifact_ops,
    stuck_detector,
    total: dispatch_ops + usage_meter + artifact_ops + stuck_detector,
  };
}
