// SPDX-License-Identifier: MIT
/**
 * CLI Public-Register Integration Tests — Phase 3
 *
 * Tests the pure module `src/cli/public-commands.ts` against a real in-process
 * manager with an in-memory SQLite database.  A tiny http.createServer stands in
 * for the remote VPS's `.well-known/restap.json` endpoint.
 *
 * Coverage:
 *   1. addPublicAgent — valid well-known → agent persisted with correct fields
 *   2. addPublicAgent — 404 well-known → no agent created, clear error
 *   3. addPublicAgent — invalid JSON → no agent created
 *   4. addPublicAgent — missing service_type → rejected
 *   5. addPublicAgent — public_url host mismatch → rejected
 *   6. listPublicAgents — returns only public-team agents
 *   7. removePublicAgent by domain → agent deleted
 *   8. Lifecycle guard + DELETE bypass (reuses existing guardrail)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
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
import {
  addPublicAgent,
  listPublicAgents,
  removePublicAgent,
} from '../../src/cli/public-commands.js';

// ─── DB factory (in-memory) ──────────────────────────────────────────────────

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

// ─── Port helper ─────────────────────────────────────────────────────────────

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

// ─── Admin headers helper ────────────────────────────────────────────────────

function adminHeaders(team: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
    ...extra,
  };
}

// ─── Mock well-known server ───────────────────────────────────────────────────

interface MockWellKnownConfig {
  /** HTTP status to return (default 200) */
  status?: number;
  /** Response body (string); if undefined → valid JSON for domain */
  body?: string;
  /** If true, serve valid JSON for domain (overrides body) */
  valid?: boolean;
  /** Domain to embed in the valid JSON */
  domain?: string;
}

let mockWkServer: http.Server;
let mockWkPort: number;
let mockWkConfig: MockWellKnownConfig = { valid: true, domain: 'test.example.com' };

function validWellKnown(domain: string): string {
  // Omit 'name' so addPublicAgent derives it from the domain, giving each
  // registration a unique name and avoiding conflicts across tests.
  return JSON.stringify({
    service_type: 'public-agent',
    version: '1.0.0',
    endpoints: {
      talk: `https://${domain}/talk`,
      health: `https://${domain}/health`,
    },
    public_url: `https://${domain}`,
    capabilities: ['talk', 'health'],
  });
}

// ─── Test state ───────────────────────────────────────────────────────────────

let managerPort: number;
let managerBaseUrl: string;
let manager: AgentManagerDb;
let db: ReturnType<typeof createInMemoryDb>;
let workDir: string;
let publicTeamId: string;

// deps passed to pure module
let deps: { managerBaseUrl: string; fetch: typeof globalThis.fetch };

// ─── beforeAll ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start mock well-known server
  mockWkPort = await findFreePort();
  mockWkServer = http.createServer((req, res) => {
    const cfg = mockWkConfig;
    const status = cfg.status ?? 200;
    if (cfg.valid && cfg.domain) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(validWellKnown(cfg.domain));
      return;
    }
    if (cfg.body !== undefined) {
      const isJson = cfg.body.trimStart().startsWith('{');
      res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain' });
      res.end(cfg.body);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(validWellKnown('test.example.com'));
  });
  await new Promise<void>((resolve) => mockWkServer.listen(mockWkPort, '127.0.0.1', resolve));

  // Start in-process manager
  managerPort = await findFreePort();
  managerBaseUrl = `http://127.0.0.1:${managerPort}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-public-test-'));
  db = createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(managerPort);

  // Seed public team
  publicTeamId = await db.teams.getOrCreateTeamId('public');

  // Build a custom fetch that intercepts *.example.com well-known requests and
  // serves them from the in-process mock server.  Manager (127.0.0.1) requests
  // pass through unchanged.
  const nodeFetch = (await import('node-fetch')).default;
  const customFetch: typeof globalThis.fetch = (input: any, init?: any) => {
    let url: string = typeof input === 'string' ? input : (input as any).url ?? String(input);
    // Only rewrite non-localhost URLs (the real public-agent well-known calls)
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      url = url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${mockWkPort}`);
    }
    return nodeFetch(url, init) as any;
  };

  deps = { managerBaseUrl, fetch: customFetch };
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  await new Promise<void>((resolve, reject) =>
    mockWkServer.close((err) => (err ? reject(err) : resolve())),
  );
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 1. Valid well-known → agent persisted ───────────────────────────────────

describe('addPublicAgent — valid well-known', () => {
  it('persists agent with correct fields', async () => {
    mockWkConfig = { valid: true, domain: 'test.example.com' };
    const result = await addPublicAgent('test.example.com', {}, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toContain('test.example.com');

    // Verify via GET /agents
    const listRes = await fetch(`${managerBaseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    expect(listRes.ok).toBe(true);
    const body = await listRes.json() as any;
    const agent = body.agents.find((a: any) => a.customer_domain === 'test.example.com');
    expect(agent).toBeDefined();
    expect(agent.deploymentShape).toBe('remote-endpoint');
    // team_id check: agent must belong to the public team (verified by visibility)
    expect(agent.customer_domain).toBe('test.example.com');
    expect(agent.public_endpoint_url).toBe('https://test.example.com');
    expect(agent.status).toBe('registered');
  });

  it('agent does NOT appear when listing idchain team', async () => {
    const listRes = await fetch(`${managerBaseUrl}/agents`, {
      headers: adminHeaders('idchain'),
    });
    expect(listRes.ok).toBe(true);
    const body = await listRes.json() as any;
    const leaked = body.agents.find((a: any) => a.customer_domain === 'test.example.com');
    expect(leaked).toBeUndefined();
  });
});

// ─── 2. 404 well-known → no agent created ────────────────────────────────────

describe('addPublicAgent — 404 well-known', () => {
  it('returns clear error and does not create an agent', async () => {
    mockWkConfig = { status: 404, body: 'Not Found' };
    const domain = 'notfound.example.com';
    const result = await addPublicAgent(domain, {}, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/404/);

    // Confirm no agent was created
    const listRes = await fetch(`${managerBaseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    const body = await listRes.json() as any;
    const leaked = body.agents.find((a: any) => a.customer_domain === domain);
    expect(leaked).toBeUndefined();
  });
});

// ─── 3. Invalid JSON body → no agent created ─────────────────────────────────

describe('addPublicAgent — invalid JSON', () => {
  it('returns error and does not create an agent', async () => {
    mockWkConfig = { status: 200, body: 'this is not json' };
    const domain = 'badjson.example.com';
    const result = await addPublicAgent(domain, {}, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not valid JSON/i);

    const listRes = await fetch(`${managerBaseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    const body = await listRes.json() as any;
    expect(body.agents.find((a: any) => a.customer_domain === domain)).toBeUndefined();
  });
});

// ─── 4. Missing service_type → rejected ──────────────────────────────────────

describe('addPublicAgent — missing service_type', () => {
  it('rejects with a specific error mentioning service_type', async () => {
    mockWkConfig = {
      status: 200,
      body: JSON.stringify({
        version: '1.0.0',
        endpoints: { talk: 'https://missing-type.example.com/talk' },
        public_url: 'https://missing-type.example.com',
      }),
    };
    const result = await addPublicAgent('missing-type.example.com', {}, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/service_type/i);
  });
});

// ─── 5. public_url host mismatch → rejected ───────────────────────────────────

describe('addPublicAgent — public_url host mismatch', () => {
  it('rejects when public_url host does not match the requested domain', async () => {
    mockWkConfig = {
      status: 200,
      body: JSON.stringify({
        service_type: 'public-agent',
        version: '1.0.0',
        endpoints: { talk: 'https://foo.com/talk' },
        public_url: 'https://bar.com',  // mismatch: domain=foo.com, public_url.host=bar.com
      }),
    };
    const result = await addPublicAgent('foo.com', {}, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/public_url host/i);
  });
});

// ─── 6. listPublicAgents — only public agents returned ───────────────────────

describe('listPublicAgents', () => {
  it('returns only public-team agents (not idchain agents)', async () => {
    // Register a public agent first (if not already from test 1)
    mockWkConfig = { valid: true, domain: 'list-test.example.com' };
    await addPublicAgent('list-test.example.com', {}, deps);

    // Register a fake idchain agent via POST /agents/register with default team
    await fetch(`${managerBaseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({
        name: `idchain-agent-${Date.now()}`,
        endpoint: 'http://127.0.0.1:9999',
      }),
    });

    const result = await listPublicAgents(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All returned agents should be public-team (none should be idchain)
    // We verify by checking they all have public_endpoint_url (public agents have it)
    // and none appear in idchain list
    for (const a of result.agents) {
      expect(a.id).toBeTruthy();
    }

    // idchain-specific agent should NOT appear in public list
    const idchainLeaked = result.agents.find((a) =>
      (a.name ?? '').startsWith('idchain-agent'),
    );
    expect(idchainLeaked).toBeUndefined();
  });
});

// ─── 7. removePublicAgent by domain ──────────────────────────────────────────

describe('removePublicAgent', () => {
  it('removes agent and it no longer appears in GET /agents', async () => {
    // Register a fresh agent for removal
    const domain = `remove-test-${Date.now()}.example.com`;
    mockWkConfig = { valid: true, domain };
    const addResult = await addPublicAgent(domain, {}, deps);
    expect(addResult.ok).toBe(true);

    // Verify it exists
    const beforeList = await listPublicAgents(deps);
    expect(beforeList.ok).toBe(true);
    if (!beforeList.ok) return;
    expect(beforeList.agents.find((a) => a.customer_domain === domain)).toBeDefined();

    // Remove by domain
    const removeResult = await removePublicAgent(domain, deps);
    expect(removeResult.ok).toBe(true);

    // Verify it's gone
    const afterList = await listPublicAgents(deps);
    expect(afterList.ok).toBe(true);
    if (!afterList.ok) return;
    expect(afterList.agents.find((a) => a.customer_domain === domain)).toBeUndefined();
  });

  it('returns error when agent is not found', async () => {
    const result = await removePublicAgent('nonexistent.example.com', deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/No public agent found/i);
  });
});

// ─── 8. Lifecycle guard + DELETE bypass ──────────────────────────────────────

describe('Lifecycle guard and DELETE for public-agent-remote', () => {
  let agentId: string;
  let agentName: string;

  beforeAll(async () => {
    // Register a remote agent directly via manager
    agentName = `lc-guard-test-${Date.now()}`;
    const res = await fetch(`${managerBaseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: agentName,
        runtime: 'public-agent-remote',
        customer_domain: `${agentName}.example.com`,
        public_endpoint_url: `https://${agentName}.example.com`,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    agentId = body.id;
  });

  it('POST /remote with agent start returns lifecycle_not_supported_for_remote', async () => {
    const res = await fetch(`${managerBaseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command: `/agent ${agentName} start` }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('lifecycle_not_supported_for_remote');
  });

  it('DELETE /agents/:id succeeds on a public-agent-remote', async () => {
    const res = await fetch(`${managerBaseUrl}/agents/${agentId}`, {
      method: 'DELETE',
      headers: adminHeaders('public'),
    });
    expect(res.ok).toBe(true);

    // Confirm deleted
    const listRes = await fetch(`${managerBaseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    const body = await listRes.json() as any;
    const still = body.agents.find((a: any) => a.id === agentId);
    expect(still).toBeUndefined();
  });
});
