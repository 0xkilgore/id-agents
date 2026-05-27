// P6 Agent Performance Telemetry — unit tests for storage and ingest.
// Uses in-memory SQLite via better-sqlite3.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateTelemetryTables,
  insertEvent,
  queryEvents,
  upsertSnapshot,
  getSnapshots,
  upsertSignal,
  querySignals,
  getCursor,
  setCursor,
} from '../../src/telemetry/storage.js';
import { ingestDispatchOps, ingestArtifactOps, ingestStuckDetector } from '../../src/telemetry/ingest.js';
import type { TelemetryEvent, PerformanceSnapshot, AgentSignal } from '../../src/telemetry/types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let adapter: SqliteAdapter;

function freshAdapter(): SqliteAdapter {
  return new SqliteAdapter(':memory:');
}

function seedDispatchQueue(adapter: SqliteAdapter) {
  // Create a minimal dispatch_scheduler_queue table
  (adapter as any)['db']?.exec?.(`
    CREATE TABLE IF NOT EXISTS dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      query_id TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      failure_kind TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      bounce_count INTEGER NOT NULL DEFAULT 0,
      team_id TEXT NOT NULL DEFAULT 'default',
      from_actor TEXT NOT NULL DEFAULT 'test',
      channel TEXT NOT NULL DEFAULT 'test',
      subject TEXT NOT NULL DEFAULT 'test',
      body_markdown TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'anthropic',
      runtime TEXT NOT NULL DEFAULT 'claude-code-cli',
      priority INTEGER NOT NULL DEFAULT 5,
      not_before_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      result_json TEXT,
      target_url TEXT,
      usage_policy_snapshot_json TEXT,
      failure_detail TEXT,
      last_bounce_json TEXT,
      bounce_history_json TEXT NOT NULL DEFAULT '[]',
      agent_query_id TEXT
    )
  `);
}

function seedNewsItems(adapter: SqliteAdapter) {
  (adapter as any)['db']?.exec?.(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      port_start INTEGER NOT NULL DEFAULT 4101,
      port_end INTEGER NOT NULL DEFAULT 4125,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO teams (id, name) VALUES ('t1', 'default');

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'interactive',
      model TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      working_directory TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL DEFAULT 0,
      runtime TEXT,
      deleted_at INTEGER,
      last_seen INTEGER
    );
    INSERT OR IGNORE INTO agents (id, team_id, name) VALUES ('roger', 't1', 'roger');

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL DEFAULT 't1',
      agent_id TEXT,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      kind TEXT,
      reply_expected INTEGER,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT ''
    )
  `);
}

beforeEach(() => {
  adapter = freshAdapter();
  migrateTelemetryTables(adapter);
});

afterEach(async () => {
  await adapter.close();
});

// ---------------------------------------------------------------------------
// Storage tests
// ---------------------------------------------------------------------------

describe('telemetry storage', () => {
  it('inserts an event and queries it back', async () => {
    const evt: TelemetryEvent = {
      event_id: 'evt_1',
      kind: 'dispatch.state_changed',
      agent_id: 'roger',
      dispatch_id: 'disp_1',
      query_id: 'q_1',
      ts: 1000,
      source: 'dispatch_ops',
      confidence: 'canonical',
      payload_json: '{"to_state":"completed"}',
      idempotency_key: 'key_1',
    };
    const inserted = await insertEvent(adapter, evt);
    expect(inserted).toBe(true);

    const events = await queryEvents(adapter, { agentId: 'roger' });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('dispatch.state_changed');
  });

  it('idempotent insert returns false on duplicate key', async () => {
    const evt: TelemetryEvent = {
      event_id: 'evt_1',
      kind: 'test',
      agent_id: 'roger',
      dispatch_id: null,
      query_id: null,
      ts: 1000,
      source: 'dispatch_ops',
      confidence: 'canonical',
      payload_json: '{}',
      idempotency_key: 'dup_key',
    };
    expect(await insertEvent(adapter, evt)).toBe(true);
    // Same idempotency_key, different event_id
    const evt2 = { ...evt, event_id: 'evt_2' };
    expect(await insertEvent(adapter, evt2)).toBe(false);
  });

  it('re-running ingestion does not duplicate events', async () => {
    const evt: TelemetryEvent = {
      event_id: 'evt_1',
      kind: 'test',
      agent_id: 'roger',
      dispatch_id: null,
      query_id: null,
      ts: 1000,
      source: 'dispatch_ops',
      confidence: 'canonical',
      payload_json: '{}',
      idempotency_key: 'rerun_key',
    };
    await insertEvent(adapter, evt);
    await insertEvent(adapter, { ...evt, event_id: 'evt_2' });
    const events = await queryEvents(adapter, { agentId: 'roger' });
    expect(events).toHaveLength(1);
  });

  it('upserts and reads snapshots', async () => {
    const snap: PerformanceSnapshot = {
      agent_id: 'roger',
      window_kind: 'day',
      window_start: '2026-05-27T05:00:00Z',
      dispatches_started: 3,
      dispatches_completed: 2,
      dispatches_failed: 0,
      dispatches_stuck: 1,
      needs_clarification_count: 0,
      artifacts_created: 1,
      weighted_tokens: 150000,
      high_burn_no_output_events: 0,
      cto_corrections_count: 0,
      operator_revision_requests: 0,
      source_coverage_json: '{}',
      computed_at: new Date().toISOString(),
    };
    await upsertSnapshot(adapter, snap);
    const snaps = await getSnapshots(adapter, { windowKind: 'day', windowStart: '2026-05-27T05:00:00Z' });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].dispatches_started).toBe(3);

    // Upsert again with updated values
    snap.dispatches_completed = 3;
    await upsertSnapshot(adapter, snap);
    const snaps2 = await getSnapshots(adapter, { windowKind: 'day', windowStart: '2026-05-27T05:00:00Z' });
    expect(snaps2).toHaveLength(1);
    expect(snaps2[0].dispatches_completed).toBe(3);
  });

  it('upserts and queries signals', async () => {
    const sig: AgentSignal = {
      id: 'signal:dispatch-stuck:q_1',
      kind: 'dispatch_stuck',
      severity: 'warning',
      agent_id: 'cto',
      subject: 'q_1',
      title: 'Dispatch stuck for 10m',
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      source_refs_json: '["file.md"]',
      confidence: 'derived',
      resolved_at: null,
    };
    await upsertSignal(adapter, sig);
    const sigs = await querySignals(adapter, { kind: 'dispatch_stuck' });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].agent_id).toBe('cto');
  });

  it('filters signals by severity and agent', async () => {
    await upsertSignal(adapter, {
      id: 'sig1', kind: 'dispatch_stuck', severity: 'warning', agent_id: 'roger',
      subject: null, title: 'stuck', first_seen_at: '2026-01-01', last_seen_at: '2026-01-01',
      source_refs_json: '[]', confidence: 'canonical', resolved_at: null,
    });
    await upsertSignal(adapter, {
      id: 'sig2', kind: 'high_burn_no_output', severity: 'warning', agent_id: 'cto',
      subject: null, title: 'burn', first_seen_at: '2026-01-01', last_seen_at: '2026-01-01',
      source_refs_json: '[]', confidence: 'derived', resolved_at: null,
    });

    const rogerSigs = await querySignals(adapter, { agentId: 'roger' });
    expect(rogerSigs).toHaveLength(1);
    expect(rogerSigs[0].id).toBe('sig1');

    const stuckOnly = await querySignals(adapter, { kind: 'dispatch_stuck' });
    expect(stuckOnly).toHaveLength(1);
  });

  it('cursor get/set', async () => {
    expect(await getCursor(adapter, 'stuck_detector')).toBeNull();
    await setCursor(adapter, 'stuck_detector', '2026-05-27T19-34-12Z-all.md');
    expect(await getCursor(adapter, 'stuck_detector')).toBe('2026-05-27T19-34-12Z-all.md');
    // Update
    await setCursor(adapter, 'stuck_detector', '2026-05-28T00-00-00Z-all.md');
    expect(await getCursor(adapter, 'stuck_detector')).toBe('2026-05-28T00-00-00Z-all.md');
  });
});

// ---------------------------------------------------------------------------
// Ingest tests
// ---------------------------------------------------------------------------

describe('ingestDispatchOps', () => {
  it('creates one event per dispatch per status', async () => {
    seedDispatchQueue(adapter);
    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue (dispatch_phid, query_id, to_agent, status, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ['disp_1', 'q_1', 'roger', 'completed', '2026-05-27T12:00:00Z'],
    );
    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue (dispatch_phid, query_id, to_agent, status, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ['disp_2', 'q_2', 'cto', 'processing', '2026-05-27T12:01:00Z'],
    );

    const count = await ingestDispatchOps(adapter);
    expect(count).toBe(2);

    // Re-run is idempotent
    const count2 = await ingestDispatchOps(adapter);
    expect(count2).toBe(0);

    const events = await queryEvents(adapter, {});
    expect(events).toHaveLength(2);
  });
});

describe('ingestArtifactOps', () => {
  it('creates events from agent_done news items', async () => {
    seedNewsItems(adapter);
    await adapter.query(
      `INSERT INTO news_items (agent_id, timestamp, type, data, query_id, team_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['roger', Date.now(), 'agent_done', JSON.stringify({ artifact_path: '/output/report.md', tl_dr: 'Built the thing' }), 'q_1', 't1'],
    );

    const count = await ingestArtifactOps(adapter);
    expect(count).toBe(1);

    // Re-run is idempotent
    expect(await ingestArtifactOps(adapter)).toBe(0);
  });
});

describe('ingestStuckDetector', () => {
  it('parses stuck detector markdown reports', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
    const reportContent = `# Stuck-dispatch detector — 2026-05-27T19-34-12Z

**1 stuck dispatch detected.**

## 1. query_id \`query_1779909853472_hqmjv23\`

- **status:** \`pending\`
- **age:** 9m
- **target agent:** \`cto\` (port 4102)  ·  status \`idle\`
- **process:** PID 12345  ·  state \`Ss\`  ·  RSS 5000 KB
- **news events for query_id:** 1
- **last news event:** 8m ago
`;
    writeFileSync(join(tmpDir, '2026-05-27T19-34-12Z-all.md'), reportContent);

    const count = await ingestStuckDetector(adapter, tmpDir);
    expect(count).toBe(1);

    // Check the event
    const events = await queryEvents(adapter, { kind: 'dispatch.stuck_detected' });
    expect(events).toHaveLength(1);
    expect(events[0].agent_id).toBe('cto');
    expect(events[0].confidence).toBe('derived');

    const payload = JSON.parse(events[0].payload_json);
    expect(payload.pid_state).toBe('Ss');
    expect(payload.news_count).toBe(1);

    // Re-run is idempotent
    expect(await ingestStuckDetector(adapter, tmpDir)).toBe(0);

    // Cursor was set
    expect(await getCursor(adapter, 'stuck_detector')).toBe('2026-05-27T19-34-12Z-all.md');

    rmSync(tmpDir, { recursive: true });
  });

  it('missing usage-meter data shows source_coverage missing', async () => {
    // This is tested via source_coverage in the rollup test below, but
    // we verify the coverage_missing event is emitted.
    // ingestUsageMeter with a bad URL will produce a coverage_missing event
    const { ingestUsageMeter } = await import('../../src/telemetry/ingest.js');
    await ingestUsageMeter(adapter, 'http://127.0.0.1:1'); // unreachable
    const events = await queryEvents(adapter, { kind: 'usage.coverage_missing' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].confidence).toBe('missing');
  });
});
