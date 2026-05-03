// SPDX-License-Identifier: MIT
/**
 * Registry Pull Discovery-Only Integration Tests — Phase 6A
 *
 * Verifies that /registry/pull correctly marks public-agent identities as
 * discovery-only: visible in /agents but NOT routable via /talk-to.
 *
 * Implementation: Option A — mesh_member:false + discovery_only:true in metadata.
 * The mesh-membership gate in handleMessage blocks routing; no new DB column needed.
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

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
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

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

function anonHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
  };
}

// ─── Mock indexer server ──────────────────────────────────────────────────────

const MOCK_TOKEN_ID = '999';
const MOCK_REGISTRY = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
const MOCK_CHAIN_ID = 11155111;

function makeMockIndexerServer(port: number): http.Server {
  return http.createServer((req, res) => {
    // Respond to any /api/agents/<agentId> request
    if (req.url && req.url.startsWith('/api/agents/')) {
      const agentData = {
        agentId: MOCK_TOKEN_ID,
        mintNumber: MOCK_TOKEN_ID,
        registryAddress: MOCK_REGISTRY,
        chainId: MOCK_CHAIN_ID,
        endpointType: 'public-agent',
        endpoint: 'https://public-agent.example.com',
        agentAccount: '0xAbcDef1234567890',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agentData));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
}

// ─── Test state ───────────────────────────────────────────────────────────────

let managerPort: number;
let indexerPort: number;
let managerBaseUrl: string;
let indexerBaseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;
let mockIndexer: http.Server;

beforeAll(async () => {
  managerPort = await findFreePort();
  indexerPort = await findFreePort();
  managerBaseUrl = `http://127.0.0.1:${managerPort}`;
  indexerBaseUrl = `http://127.0.0.1:${indexerPort}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pull-test-'));

  // Start mock indexer
  mockIndexer = makeMockIndexerServer(indexerPort);
  await new Promise<void>((resolve) => mockIndexer.listen(indexerPort, '127.0.0.1', resolve));

  // Start manager
  db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(managerPort);

  // Ensure teams exist
  await db.teams.getOrCreateTeamId('public');
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  await new Promise<void>((resolve, reject) =>
    mockIndexer.close((err) => (err ? reject(err) : resolve())),
  );
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Registry pull — public-agent discovery-only semantics', () => {
  let pulledAgentId: string;

  it('POST /registry/pull with public-agent service_type succeeds', async () => {
    const resp = await fetch(`${managerBaseUrl}/registry/pull`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        baseUrl: indexerBaseUrl,
        agentIds: [MOCK_TOKEN_ID],
        chainId: MOCK_CHAIN_ID,
        registryAddress: MOCK_REGISTRY,
        spawn: false,
      }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    // Log for debugging: body.discovery.fetched and body.discovery.upserted
    const fetched = body.fetched ?? body.discovery?.fetched ?? 0;
    const upserted = body.upserted ?? body.discovery?.upserted ?? 0;
    const errors = body.errors ?? body.discovery?.errors ?? [];
    if (errors.length > 0) {
      console.error('Registry pull errors:', errors);
    }
    expect(fetched).toBeGreaterThanOrEqual(1);
    expect(upserted).toBeGreaterThanOrEqual(1);
  });

  it('imported public-agent is visible in GET /agents', async () => {
    const resp = await fetch(`${managerBaseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;

    const imported = body.agents.find((a: any) =>
      a.tokenId === MOCK_TOKEN_ID || a.token_id === MOCK_TOKEN_ID
    );
    expect(imported).toBeDefined();
    pulledAgentId = imported.id;
  });

  it('imported public-agent has mesh_member:false in metadata', async () => {
    expect(pulledAgentId).toBeDefined();
    const resp = await fetch(`${managerBaseUrl}/agents/${pulledAgentId}`, {
      headers: adminHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.metadata?.mesh_member).toBe(false);
  });

  it('imported public-agent has discovery_only:true in metadata', async () => {
    expect(pulledAgentId).toBeDefined();
    const resp = await fetch(`${managerBaseUrl}/agents/${pulledAgentId}`, {
      headers: adminHeaders('public'),
    });
    const body = await resp.json() as any;
    expect(body.metadata?.discovery_only).toBe(true);
  });

  it('/talk-to to imported public-agent returns 403 not_mesh_reachable', async () => {
    expect(pulledAgentId).toBeDefined();

    // The pulled agent has a name with special characters (registry format) that can't
    // be used directly as a routing ref. Set a clean alias in metadata so the routing
    // lookup can find the agent by name.
    const cleanAlias = 'pulled-public-agent-test';
    await fetch(`${managerBaseUrl}/agents/${pulledAgentId}/metadata`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        metadata: { alias: cleanAlias },
      }),
    });

    // Attempt to route to it — should be blocked by mesh gate
    const talkResp = await fetch(`${managerBaseUrl}/talk-to`, {
      method: 'POST',
      headers: anonHeaders('public'),
      body: JSON.stringify({
        to: cleanAlias,
        message: 'hello',
        from: 'test',
        wait: false,
      }),
    });
    expect(talkResp.status).toBe(403);
    const body = await talkResp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
  });
});
