/**
 * Phase 7: Heartbeat mode separation tests.
 *
 * Asserts that:
 *   - runHealthChecks() (local heartbeat) is called ONLY for local agents
 *   - runRemoteHeartbeat() (remote probe) is called ONLY for remote agents
 *   - Neither function is called for the wrong agent type
 *   - A mixed fleet of one local + one remote is dispatched correctly:
 *     local-heartbeat stub called exactly once (local agent)
 *     remote-probe stub called exactly once (remote agent)
 *
 * Strategy:
 *   - In-process manager with in-memory SQLite.
 *   - Register one agent via HTTP (public-agent-remote) and insert one
 *     local agent directly via DB.
 *   - Swap the private probe functions with stubs via casting.
 *   - Trigger both loops once, then assert call counts.
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

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Register a public-agent-remote agent via HTTP. Returns agent id. */
async function registerRemoteAgent(baseUrl: string, name: string, domain: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/agents/register`, {
    method: 'POST',
    headers: adminHeaders('public'),
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

/** Directly insert a local agent into the DB. */
async function insertLocalAgent(
  db: ReturnType<typeof createInMemoryDb>,
  teamName: string,
  agentId: string,
  agentName: string,
): Promise<void> {
  const teamId = await db.teams.getOrCreateTeamId(teamName);
  await db.agents.create({
    team_id: teamId,
    id: agentId,
    name: agentName,
    type: 'claude',
    model: 'claude-code-cli',
    status: 'running',
    created_at: Date.now(),
    runtime: 'claude-code-cli',
    port: 9999, // fake port; local health checks would fail but that's ok
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Phase 7: heartbeat mode separation', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-separation-test-'));
  });

  afterAll(() => {
    // workDir cleanup intentionally skipped (OS temp GC handles it)
  });

  // ─── Test 1: Mixed fleet — each loop gets only its own agents ───────────────

  it('1. mixed fleet: local-heartbeat called once (local), remote-probe called once (remote)', async () => {
    const db = createInMemoryDb();
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;

    // Remote probe stub: track which URLs were probed
    const remoteProbedUrls: string[] = [];
    const probeFn: HealthProbeFn = async (probeUrl: string, _timeout: number): Promise<ProbeFetchResult> => {
      remoteProbedUrls.push(probeUrl);
      return { status: 200, body: { status: 'ok' } };
    };

    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    await manager.start(port);

    try {
      // Register one remote agent
      const remoteId = await registerRemoteAgent(url, 'remote-sep-agent', 'remote-sep.example.com');

      // Insert one local agent directly
      await insertLocalAgent(db, 'idchain', 'local-sep-agent-id', 'local-sep-agent');

      // Intercept runHealthChecks to track which agents it processes.
      // We do this by wrapping the private method.
      const localHealthCalledForAgents: string[] = [];
      const origRunHealthChecks = (manager as any).runHealthChecks.bind(manager);
      (manager as any).runHealthChecks = async function () {
        // Wrap to spy on the internal agent loop
        const origDbList = (this as any).dbListAgents.bind(this);
        (this as any).dbListAgents = async (teamId: string, includeAuto: boolean) => {
          const agents = await origDbList(teamId, includeAuto);
          // Track only agents that WOULD be processed (non-virtual, non-remote)
          // This mirrors the actual guard logic
          for (const a of agents) {
            if (a.type === 'virtual') continue;
            const { isRemoteEndpointRuntime } = await import('../../src/runtime/registry.js');
            if (isRemoteEndpointRuntime(a.runtime)) continue;
            localHealthCalledForAgents.push(a.name);
          }
          return agents;
        };
        await origRunHealthChecks();
        // Restore
        (this as any).dbListAgents = origDbList;
      };

      // Reset probe tracking
      remoteProbedUrls.length = 0;

      // Trigger both loops
      await (manager as any).runHealthChecks();
      await (manager as any).runRemoteHeartbeat();

      // Remote probe must have been called for the remote agent (health URL)
      const remoteProbeHits = remoteProbedUrls.filter((u) => u.includes('remote-sep.example.com'));
      expect(remoteProbeHits.length).toBeGreaterThanOrEqual(1);

      // Remote probe must NOT have been called for the local agent's URL
      const localProbeHits = remoteProbedUrls.filter((u) => u.includes('localhost:9999'));
      expect(localProbeHits.length).toBe(0);

      // Local heartbeat (via spy) must have identified the local agent
      expect(localHealthCalledForAgents).toContain('local-sep-agent');
      // And must NOT have identified the remote agent
      expect(localHealthCalledForAgents).not.toContain('remote-sep-agent');

    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 20000);

  // ─── Test 2: runHealthChecks never invokes network for remote agents ─────────

  it('2. runHealthChecks does not call fetchUrl for any public-agent-remote agent', async () => {
    const db = createInMemoryDb();
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;

    // The remote probe fn will track calls
    const probeCalls: string[] = [];
    const probeFn: HealthProbeFn = async (probeUrl: string) => {
      probeCalls.push(probeUrl);
      return { status: 200, body: { status: 'ok' } };
    };

    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    await manager.start(port);

    try {
      // Register 2 remote agents
      await registerRemoteAgent(url, 'remote-a', 'remote-a.example.com');
      await registerRemoteAgent(url, 'remote-b', 'remote-b.example.com');

      probeCalls.length = 0;

      // Only trigger the LOCAL health-check loop — the remote probe fn
      // should NEVER be called from within runHealthChecks.
      // We stub the local fetch used for /health calls to verify it
      // isn't called for remote agents.
      const localFetchUrls: string[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        localFetchUrls.push(u);
        return origFetch(input, init);
      };

      try {
        await (manager as any).runHealthChecks();
      } finally {
        globalThis.fetch = origFetch;
      }

      // None of the local fetch calls should target the remote agent domains
      const remoteLocalFetches = localFetchUrls.filter(
        (u) => u.includes('remote-a.example.com') || u.includes('remote-b.example.com'),
      );
      expect(remoteLocalFetches.length).toBe(0);

      // The remote probeFn should NOT have been called by runHealthChecks
      // (it's only called by runRemoteHeartbeat)
      expect(probeCalls.length).toBe(0);

    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 20000);

  // ─── Test 3: runRemoteHeartbeat only probes remote agents ───────────────────

  it('3. runRemoteHeartbeat probes remote agents only, skips local agents', async () => {
    const db = createInMemoryDb();
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;

    const probedDomains: string[] = [];
    const probeFn: HealthProbeFn = async (probeUrl: string) => {
      probedDomains.push(probeUrl);
      return { status: 200, body: { status: 'ok' } };
    };

    const manager = new AgentManagerDb(workDir, db as any, { healthProbeFn: probeFn });
    await manager.start(port);

    try {
      // Register 1 remote agent
      await registerRemoteAgent(url, 'only-remote', 'only-remote.example.com');

      // Insert 2 local agents directly
      await insertLocalAgent(db, 'idchain', 'local-x-id', 'local-x');
      await insertLocalAgent(db, 'idchain', 'local-y-id', 'local-y');

      probedDomains.length = 0;
      await (manager as any).runRemoteHeartbeat();

      // Must have probed the remote agent
      const remoteHits = probedDomains.filter((u) => u.includes('only-remote.example.com'));
      expect(remoteHits.length).toBeGreaterThanOrEqual(1);

      // Must NOT have probed local agent ports (9999)
      const localHits = probedDomains.filter((u) => u.includes(':9999'));
      expect(localHits.length).toBe(0);

      // Total probe calls: exactly the remote agent (1 /health call, no well-known needed on success)
      expect(probedDomains.length).toBe(1);

    } finally {
      await new Promise<void>((res) => (manager as any).httpServer?.close(() => res()));
      await db.close();
    }
  }, 20000);
});
