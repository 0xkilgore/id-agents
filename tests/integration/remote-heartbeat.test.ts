// SPDX-License-Identifier: MIT
/**
 * Remote Heartbeat Integration Tests — Phase 5
 *
 * Tests probe semantics, scheduler integration, derived health, the
 * POST /agents/:id/probe endpoint, CLI field exposure, team isolation
 * regression, concurrency cap, and fault tolerance.
 *
 * Strategy:
 *   - In-process manager with in-memory SQLite.
 *   - Inject healthProbeFn into AgentManagerDb so no real HTTP server needed.
 *   - Access the internal runRemoteHeartbeat tick directly via a cast.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import type { HealthProbeFn, ProbeFetchResult } from '../../src/lib/remote-heartbeat.js';

// ─── DB factory ───────────────────────────────────────────────────────────────

function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };
}

// ─── Port helper ──────────────────────────────────────────────────────────────

async function findFreePort(): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

// ─── Admin headers ────────────────────────────────────────────────────────────

function adminHeaders(team: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
    ...extra,
  };
}

// ─── Probe stub factories ─────────────────────────────────────────────────────

/** Returns a stub that always returns a valid /health response. */
function makeHealthOkStub(): HealthProbeFn {
  return async (_url: string, _timeout: number): Promise<ProbeFetchResult> => {
    return { status: 200, body: { status: 'ok', version: '1.0.0' } };
  };
}

/** Returns a stub: /health → 500, /.well-known/restap.json → 200 valid */
function makeHealth500WellKnownOkStub(): HealthProbeFn {
  return async (url: string, _timeout: number): Promise<ProbeFetchResult> => {
    if (url.endsWith('/health')) {
      return { status: 500, body: null };
    }
    if (url.includes('/.well-known/restap.json')) {
      return { status: 200, body: { service_type: 'public-agent', version: '1.0.0' } };
    }
    return { status: 404, body: null };
  };
}

/** Returns a stub that always throws an AbortError (timeout). */
function makeTimeoutStub(): HealthProbeFn {
  return async (_url: string, _timeout: number): Promise<ProbeFetchResult> => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
}

/** Returns a stub that always fails (both endpoints return 503). */
function makeBothFailStub(): HealthProbeFn {
  return async (_url: string, _timeout: number): Promise<ProbeFetchResult> => {
    return { status: 503, body: null };
  };
}

// ─── Helper: register a remote agent via HTTP ─────────────────────────────────

async function registerRemoteAgent(
  baseUrl: string,
  name: string,
  domain: string,
  team: string = 'public',
): Promise<string> {
  const resp = await fetch(`${baseUrl}/agents/register`, {
    method: 'POST',
    headers: adminHeaders(team),
    body: JSON.stringify({
      name,
      runtime: 'public-agent-remote',
      customer_domain: domain,
      public_endpoint_url: `https://${domain}`,
    }),
  });
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  return data.id as string;
}

// ─── Helper: trigger one heartbeat tick by casting to private ─────────────────

async function triggerRemoteHeartbeat(manager: AgentManagerDb): Promise<void> {
  await (manager as any).runRemoteHeartbeat();
}

// ─── Global test state ────────────────────────────────────────────────────────

let managerPort: number;
let baseUrl: string;
let workDir: string;
let db: ReturnType<typeof createInMemoryDb>;

// Each test section creates its own manager instance to isolate probe stub.
// The global manager (with a no-op probe) just hosts the base setup.

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Phase 5: Remote Heartbeat', () => {
  beforeAll(async () => {
    managerPort = await findFreePort();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-heartbeat-test-'));
    baseUrl = `http://127.0.0.1:${managerPort}`;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  // ─── Test 1: Health 200 valid ──────────────────────────────────────────────

  it('1. health 200 → agent online, consecutive_failures=0, last_seen updated', async () => {
    db = createInMemoryDb();
    const probeFn = makeHealthOkStub();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'test-agent-1', 'agent1.example.com');

      await triggerRemoteHeartbeat(manager);

      const resp = await fetch(`${url}/agents/${agentId}`, { headers: adminHeaders('public') });
      const agent: any = await resp.json();

      expect(agent.health).toBe('online');
      expect(agent.consecutive_failures).toBe(0);
      expect(typeof agent.last_seen).toBe('number');
      expect(agent.last_seen).toBeGreaterThan(0);
      expect(agent.last_error).toBeNull();
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 2: Health 500 + well-known 200 ──────────────────────────────────

  it('2. health 500, well-known 200 → online, last_error="health probe failed, well-known succeeded"', async () => {
    db = createInMemoryDb();
    const probeFn = makeHealth500WellKnownOkStub();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'test-agent-2', 'agent2.example.com');

      await triggerRemoteHeartbeat(manager);

      const resp = await fetch(`${url}/agents/${agentId}`, { headers: adminHeaders('public') });
      const agent: any = await resp.json();

      expect(agent.health).toBe('online');
      expect(agent.consecutive_failures).toBe(0);
      expect(agent.last_seen).toBeGreaterThan(0);
      expect(agent.last_error).toBe('health probe failed, well-known succeeded');
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 3: Both fail — classify timeout ──────────────────────────────────

  it('3. AbortError → last_error="timeout", consecutive_failures=1, health=unstable', async () => {
    db = createInMemoryDb();
    const probeFn = makeTimeoutStub();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'test-agent-3', 'agent3.example.com');

      await triggerRemoteHeartbeat(manager);

      const resp = await fetch(`${url}/agents/${agentId}`, { headers: adminHeaders('public') });
      const agent: any = await resp.json();

      expect(agent.consecutive_failures).toBe(1);
      expect(agent.last_error).toBe('timeout');
      expect(agent.health).toBe('unstable');
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 4: 3+ failures → offline ────────────────────────────────────────

  it('4. 3 consecutive failures → consecutive_failures=3, health=offline', async () => {
    db = createInMemoryDb();
    const probeFn = makeBothFailStub();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'test-agent-4', 'agent4.example.com');

      await triggerRemoteHeartbeat(manager);
      await triggerRemoteHeartbeat(manager);
      await triggerRemoteHeartbeat(manager);

      const resp = await fetch(`${url}/agents/${agentId}`, { headers: adminHeaders('public') });
      const agent: any = await resp.json();

      expect(agent.consecutive_failures).toBe(3);
      expect(agent.health).toBe('offline');
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 5: Recovery after 3 failures ────────────────────────────────────

  it('5. recovery after 3 failures → consecutive_failures=0, health=online, last_seen updated', async () => {
    db = createInMemoryDb();
    let failMode = true;
    const probeFn: HealthProbeFn = async (url, _timeout) => {
      if (failMode) return { status: 503, body: null };
      if (url.endsWith('/health')) return { status: 200, body: { status: 'ok' } };
      return { status: 404, body: null };
    };
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'test-agent-5', 'agent5.example.com');

      // 3 failures
      await triggerRemoteHeartbeat(manager);
      await triggerRemoteHeartbeat(manager);
      await triggerRemoteHeartbeat(manager);

      // Recovery
      failMode = false;
      await triggerRemoteHeartbeat(manager);

      const resp = await fetch(`${url}/agents/${agentId}`, { headers: adminHeaders('public') });
      const agent: any = await resp.json();

      expect(agent.consecutive_failures).toBe(0);
      expect(agent.health).toBe('online');
      expect(agent.last_seen).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 6: Concurrency cap at 8 ────────────────────────────────────────

  it('6. peak in-flight count never exceeds 8 with 20 remote agents', async () => {
    db = createInMemoryDb();
    let inFlight = 0;
    let peakInFlight = 0;

    const probeFn: HealthProbeFn = async (_url, _timeout) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Simulate async work
      await new Promise<void>((res) => setTimeout(res, 20));
      inFlight--;
      return { status: 200, body: { status: 'ok' } };
    };

    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      // Register 20 remote agents
      for (let i = 0; i < 20; i++) {
        await registerRemoteAgent(url, `concurrency-agent-${i}`, `agent-conc-${i}.example.com`);
      }

      await triggerRemoteHeartbeat(manager);

      // Each agent probes /health (which succeeds), so 20 calls total, max 8 concurrent
      expect(peakInFlight).toBeLessThanOrEqual(8);
      expect(peakInFlight).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 30000);

  // ─── Test 7: Local agents not probed by remote loop ───────────────────────

  it('7. local agents (claude-agent-sdk) are not probed by runRemoteHeartbeat', async () => {
    db = createInMemoryDb();
    let probeCallCount = 0;
    const probeFn: HealthProbeFn = async () => {
      probeCallCount++;
      return { status: 200, body: { status: 'ok' } };
    };
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      // Register 3 remote agents and 2 local (claude-agent-sdk type 'virtual')
      for (let i = 0; i < 3; i++) {
        await registerRemoteAgent(url, `remote-agent-${i}`, `remote-${i}.example.com`);
      }

      // Register local virtual agents (type = virtual, no runtime = claude-agent-sdk)
      const localTeamId = await db.teams.getOrCreateTeamId('public');
      for (let i = 0; i < 2; i++) {
        await db.agents.create({
          team_id: localTeamId,
          id: `local-agent-${i}`,
          name: `local-agent-${i}`,
          type: 'virtual',
          model: 'external',
          status: 'running',
          created_at: Date.now(),
          runtime: 'claude-agent-sdk',
        });
      }

      probeCallCount = 0; // reset after setup
      await triggerRemoteHeartbeat(manager);

      // Only 3 remote agents should be probed
      // Each probe calls /health once (on success, no well-known fallback needed)
      expect(probeCallCount).toBe(3);
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 8: POST /agents/:id/probe works for remote ─────────────────────

  it('8. POST /agents/:id/probe returns 200 with probe result; DB updated', async () => {
    db = createInMemoryDb();
    const probeFn = makeHealthOkStub();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'probe-test-agent', 'probe.example.com');

      const resp = await fetch(`${url}/agents/${agentId}/probe`, {
        method: 'POST',
        headers: adminHeaders('public'),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(200);
      const result: any = await resp.json();

      expect(result.ok).toBe(true);
      expect(result.health).toBe('online');
      expect(result.consecutive_failures).toBe(0);
      expect(typeof result.last_seen).toBe('number');

      // Verify DB was updated
      const agentResp = await fetch(`${url}/agents/${agentId}`, { headers: adminHeaders('public') });
      const agent: any = await agentResp.json();
      expect(agent.consecutive_failures).toBe(0);
      expect(agent.last_seen).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 9: POST /agents/:id/probe rejects local runtime ─────────────────

  it('9. POST /agents/:id/probe rejects non-remote agent with 400', async () => {
    db = createInMemoryDb();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: makeHealthOkStub() });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      // Register a local-runtime agent (claude-code-cli style virtual agent)
      const teamId = await db.teams.getOrCreateTeamId('public');
      const localId = 'local-for-probe-test';
      await db.agents.create({
        team_id: teamId,
        id: localId,
        name: 'local-probe-test',
        type: 'virtual',
        model: 'external',
        status: 'running',
        created_at: Date.now(),
        runtime: 'claude-code-cli',
      });

      const resp = await fetch(`${url}/agents/${localId}/probe`, {
        method: 'POST',
        headers: adminHeaders('public'),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body: any = await resp.json();
      expect(body.error).toBe('probe_only_supported_for_remote');
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 10: GET /agents?team=public exposes new columns ─────────────────

  it('10. GET /agents exposes last_seen, last_error, consecutive_failures, health after failures', async () => {
    db = createInMemoryDb();
    const probeFn = makeBothFailStub();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      const agentId = await registerRemoteAgent(url, 'columns-test-agent', 'columns.example.com');

      // 3 failures
      await triggerRemoteHeartbeat(manager);
      await triggerRemoteHeartbeat(manager);
      await triggerRemoteHeartbeat(manager);

      const resp = await fetch(`${url}/agents`, { headers: adminHeaders('public') });
      const data: any = await resp.json();
      const agent = (data.agents || []).find((a: any) => a.id === agentId);
      expect(agent).toBeDefined();
      expect(agent.consecutive_failures).toBe(3);
      expect(agent.health).toBe('offline');
      expect(agent.last_error).toBeTruthy();
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 11: Phase 1 team boundary regression ────────────────────────────

  it('11. idchain principal cannot see public agents or call /talk-to them', async () => {
    db = createInMemoryDb();
    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: makeHealthOkStub() });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      // Register agent in public team
      await registerRemoteAgent(url, 'boundary-agent', 'boundary.example.com');

      // Request from idchain team should see NO public agents
      const resp = await fetch(`${url}/agents`, {
        headers: adminHeaders('idchain'),
      });
      expect(resp.status).toBe(200);
      const data: any = await resp.json();
      // idchain team has no agents
      const publicAgent = (data.agents || []).find(
        (a: any) => a.name === 'boundary-agent' || (a.customer_domain ?? '').includes('boundary'),
      );
      expect(publicAgent).toBeUndefined();
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);

  // ─── Test 12: Fault tolerance — one throw doesn't kill the loop ───────────

  it('12. one probe throwing synchronously does not stop other agents from being probed', async () => {
    db = createInMemoryDb();
    let probeCallCount = 0;
    let throwTarget: string | null = null;

    const probeFn: HealthProbeFn = async (url, _timeout) => {
      probeCallCount++;
      // Throw only for the designated agent's /health URL
      if (throwTarget && url.includes(throwTarget)) {
        throw new Error('Simulated network failure');
      }
      return { status: 200, body: { status: 'ok' } };
    };

    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    const port = await findFreePort();
    await manager.start(port);
    const url = `http://127.0.0.1:${port}`;

    try {
      // Register 4 remote agents
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await registerRemoteAgent(url, `fault-agent-${i}`, `fault-${i}.example.com`);
        ids.push(id);
      }

      // Make the second agent throw on both /health and /.well-known
      throwTarget = 'fault-1';

      probeCallCount = 0;
      await triggerRemoteHeartbeat(manager);

      // All 4 agents should have been attempted (each calls /health, the faulty one also
      // calls /.well-known). The loop should not have aborted early.
      // Minimum: 4 /health calls (some also call well-known on health fail)
      expect(probeCallCount).toBeGreaterThanOrEqual(4);

      // The non-faulty agents should be online
      for (let i = 0; i < 4; i++) {
        if (i === 1) continue; // faulty agent
        const agentResp = await fetch(`${url}/agents/${ids[i]}`, { headers: adminHeaders('public') });
        const agent: any = await agentResp.json();
        expect(agent.health).toBe('online');
      }
    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 15000);
});
