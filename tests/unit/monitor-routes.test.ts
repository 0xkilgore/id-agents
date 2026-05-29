import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { mountMonitorRoutes } from '../../src/monitor/routes.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';

let adapter: SqliteAdapter;
let server: Server;
let port: number;

function freshAdapter(): SqliteAdapter {
  return new SqliteAdapter(':memory:');
}

function setupTables(a: SqliteAdapter): void {
  a.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      port_start INTEGER NOT NULL DEFAULT 4101,
      port_end INTEGER NOT NULL DEFAULT 4125,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      model TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      working_directory TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      registry TEXT,
      metadata TEXT,
      deleted_at INTEGER,
      runtime TEXT DEFAULT 'claude-agent-sdk',
      token_id TEXT,
      domain TEXT,
      api_key TEXT,
      customer_domain TEXT,
      public_endpoint_url TEXT,
      internal_endpoint_url TEXT,
      ssh_target TEXT,
      last_seen INTEGER,
      last_probed_at INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
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
    );

    CREATE TABLE IF NOT EXISTS dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      query_id TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      from_actor TEXT NOT NULL,
      channel TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      provider TEXT NOT NULL,
      runtime TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL,
      not_before_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      bounce_count INTEGER NOT NULL DEFAULT 0,
      last_bounce_json TEXT,
      bounce_history_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      agent_query_id TEXT,
      usage_policy_snapshot_json TEXT,
      failure_kind TEXT,
      failure_detail TEXT,
      target_url TEXT,
      result_json TEXT,
      promote INTEGER NOT NULL DEFAULT 1,
      promotion_strategy TEXT NOT NULL DEFAULT 'auto',
      promotion_required_reason TEXT,
      promotion_result_json TEXT,
      promotion_input_json TEXT
    );

    INSERT INTO teams (id, name) VALUES ('t1', 'default');
  `);
}

async function startServer(a: SqliteAdapter): Promise<number> {
  const app = express();
  mountMonitorRoutes(app, a);
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

beforeEach(async () => {
  adapter = freshAdapter();
  setupTables(adapter);
  port = await startServer(adapter);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await adapter.close();
});

describe('GET /monitor/fleet', () => {
  it('returns manager row plus registered agents', async () => {
    // Add two agents
    adapter.exec(`
      INSERT INTO agents (id, team_id, name, type, model, port, endpoint, status, created_at, metadata, last_probed_at)
      VALUES
        ('a1', 't1', 'roger', 'worker', 'claude', 4111, 'http://localhost:4111', 'running', ${Date.now()}, '{"pid": 1234}', ${Date.now()}),
        ('a2', 't1', 'cto', 'worker', 'claude', 4113, 'http://localhost:4113', 'running', ${Date.now()}, '{}', ${Date.now() - 200000})
    `);

    const res = await fetch(`http://localhost:${port}/monitor/fleet`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.generated_at).toBeGreaterThan(0);
    expect(body.agents).toHaveLength(3); // manager + roger + cto

    // Manager row
    const mgr = body.agents.find((a: { agent: string }) => a.agent === 'manager');
    expect(mgr).toBeDefined();
    expect(mgr.status).toBe('up');
    expect(mgr.source).toBe('manager-health');
    expect(mgr.pid).toBeGreaterThan(0);

    // Roger — recently probed, should be up
    const roger = body.agents.find((a: { agent: string }) => a.agent === 'roger');
    expect(roger).toBeDefined();
    expect(roger.status).toBe('up');
    expect(roger.pid).toBe(1234);
    expect(roger.port).toBe(4111);

    // CTO — stale probe (200s old), should be down
    const cto = body.agents.find((a: { agent: string }) => a.agent === 'cto');
    expect(cto).toBeDefined();
    expect(cto.status).toBe('down');
  });

  it('returns only manager when no agents registered', async () => {
    const res = await fetch(`http://localhost:${port}/monitor/fleet`);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent).toBe('manager');
  });
});

describe('GET /monitor/completions', () => {
  it('returns in-flight and recent completions from news events', async () => {
    const now = Date.now();
    const receivedTs = now - 480_000; // 8 minutes ago
    const completedTs = now - 10_000; // 10 seconds ago

    // Insert query.received (in-flight)
    adapter.exec(`
      INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id, owner_id)
      VALUES
        ('t1', 'roger', ${now - 60_000}, 'query.received', 'Query from manager', '{"from":"manager"}', 'q-inflight', 'roger')
    `);

    // Insert matched pair (completed)
    adapter.exec(`
      INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id, owner_id)
      VALUES
        ('t1', 'roger', ${receivedTs}, 'query.received', 'Query from cto', '{"from":"cto"}', 'q-done', 'roger'),
        ('t1', 'roger', ${completedTs}, 'query.completed', 'Completed', '{}', 'q-done', 'roger')
    `);

    const res = await fetch(`http://localhost:${port}/monitor/completions`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.generated_at).toBeGreaterThan(0);

    // In-flight
    expect(body.in_flight.length).toBeGreaterThanOrEqual(1);
    const inflight = body.in_flight.find((r: { query_id: string }) => r.query_id === 'q-inflight');
    expect(inflight).toBeDefined();
    expect(inflight.elapsed_ms).toBeGreaterThan(50_000);

    // Completed
    expect(body.recent_completions.length).toBeGreaterThanOrEqual(1);
    const comp = body.recent_completions.find((r: { query_id: string }) => r.query_id === 'q-done');
    expect(comp).toBeDefined();
    expect(comp.duration_ms).toBe(completedTs - receivedTs);
    expect(comp.from).toBe('cto');
  });

  it('returns promotion outcomes from dispatch queue', async () => {
    const now = new Date().toISOString();
    adapter.exec(`
      INSERT INTO dispatch_scheduler_queue
        (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown,
         provider, runtime, status, not_before_at, updated_at, completed_at, promote, promotion_result_json)
      VALUES
        ('phid:test-promo', 't1', 'q-promo', 'roger', 'manager', 'talk', 'Build X', '',
         'anthropic', 'claude-code-cli', 'done', '${now}', '${now}', '${now}', 1,
         '{"required":true,"completed":true,"repos":[{"source_branch":"feat-x","promoted_sha":"abc123","remote_main_sha":"abc123","pushed":true,"verified":true,"base":"main"}]}')
    `);

    const res = await fetch(`http://localhost:${port}/monitor/completions`);
    const body = await res.json();

    expect(body.promotion_outcomes.length).toBeGreaterThanOrEqual(1);
    const promo = body.promotion_outcomes.find((p: { branch: string }) => p.branch === 'feat-x');
    expect(promo).toBeDefined();
    expect(promo.commit).toBe('abc123');
    expect(promo.promoted_to_main).toBe(true);
    expect(promo.pushed).toBe(true);
    expect(promo.verified).toBe(true);
  });

  it('enforces the 18s artifact test: duration from event timestamps, not observation', async () => {
    const now = Date.now();
    // Query received 8 minutes ago.
    const receivedTs = now - 480_000;
    // Completed 18 seconds ago.
    const completedTs = now - 18_000;

    adapter.exec(`
      INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id, owner_id)
      VALUES
        ('t1', 'roger', ${receivedTs}, 'query.received', 'Test', '{"from":"manager"}', 'q-18s', 'roger'),
        ('t1', 'roger', ${completedTs}, 'query.completed', 'Done', '{}', 'q-18s', 'roger')
    `);

    const res = await fetch(`http://localhost:${port}/monitor/completions`);
    const body = await res.json();

    const comp = body.recent_completions.find((r: { query_id: string }) => r.query_id === 'q-18s');
    expect(comp).toBeDefined();

    // Duration MUST be ~8 minutes (~462000ms), NOT 18 seconds.
    const expectedDuration = completedTs - receivedTs; // 462000
    expect(comp.duration_ms).toBe(expectedDuration);
    expect(comp.duration_ms).toBeGreaterThan(400_000);
    expect(comp.duration_ms).not.toBe(18_000);
  });

  it('respects recent_limit param', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      adapter.exec(`
        INSERT INTO news_items (team_id, agent_id, timestamp, type, query_id, owner_id)
        VALUES
          ('t1', 'roger', ${now - (i + 1) * 60000}, 'query.received', 'ql-${i}', 'roger'),
          ('t1', 'roger', ${now - i * 60000}, 'query.completed', 'ql-${i}', 'roger')
      `);
    }

    const res = await fetch(`http://localhost:${port}/monitor/completions?recent_limit=2`);
    const body = await res.json();
    expect(body.recent_completions.length).toBeLessThanOrEqual(2);
  });

  it('returns source coverage rows', async () => {
    const now = Date.now();
    adapter.exec(`
      INSERT INTO news_items (team_id, agent_id, timestamp, type, query_id, owner_id)
      VALUES ('t1', 'roger', ${now - 1000}, 'query.received', 'q-cov', 'roger')
    `);

    const res = await fetch(`http://localhost:${port}/monitor/completions`);
    const body = await res.json();

    const cov = body.source_coverage.find((r: { agent: string }) => r.agent === 'roger');
    expect(cov).toBeDefined();
    expect(cov.news_seen).toBe(true);
    expect(cov.newest_news_ts).toBeGreaterThan(0);
  });
});
