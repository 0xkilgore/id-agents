// SPDX-License-Identifier: MIT
/**
 * Response Redaction Integration Tests — Phase 6A
 *
 * Verifies that agentToResponse strips sensitive fields for non-admin callers
 * while returning the full record to admin principals.
 *
 * Sensitive fields tested:
 *   top-level:  ssh_target, internal_endpoint_url
 *   metadata:   auth_key_ref, ssh_private_key, ows_wallet_seed, internal_endpoint_url, ssh_target
 *   regex-net:  keys matching /private_?key/i or /secret/i
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

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;
let agentId: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'response-redaction-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  // Ensure the public team exists
  await db.teams.getOrCreateTeamId('public');

  // Register a public-agent-remote agent with all sensitive fields populated
  const resp = await fetch(`${baseUrl}/agents/register`, {
    method: 'POST',
    headers: adminHeaders('public'),
    body: JSON.stringify({
      runtime: 'public-agent-remote',
      name: 'sensitive-agent',
      customer_domain: 'sensitive.example.com',
      public_endpoint_url: 'https://sensitive.example.com',
      internal_endpoint_url: 'http://127.0.0.1:8080',
      ssh_target: 'op@host.example.com',
    }),
  });

  expect(resp.status).toBe(201);
  const body = await resp.json() as any;
  agentId = body.id;

  // Patch metadata with all sensitive keys via the metadata endpoint
  // The endpoint expects { metadata: { ... } }
  const metaResp = await fetch(`${baseUrl}/agents/${agentId}/metadata`, {
    method: 'POST',
    headers: adminHeaders('public'),
    body: JSON.stringify({
      metadata: {
        auth_key_ref: 'ref-xyz',
        ssh_private_key: 'super-secret-private-key',
        ows_wallet_seed: 'word1 word2 word3',
        my_private_key: 'another-private-key',
        api_secret: 'api-secret-value',
        safe_field: 'this-should-remain',
      },
    }),
  });
  expect(metaResp.status).toBe(200);
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Admin principal sees unredacted record', () => {
  it('GET /agents/:id returns ssh_target for admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/${agentId}`, {
      headers: adminHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ssh_target).toBe('op@host.example.com');
    expect(body.internal_endpoint_url).toBe('http://127.0.0.1:8080');
  });

  it('GET /agents/:id returns sensitive metadata keys for admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/${agentId}`, {
      headers: adminHeaders('public'),
    });
    const body = await resp.json() as any;
    expect(body.metadata?.auth_key_ref).toBe('ref-xyz');
    expect(body.metadata?.ssh_private_key).toBe('super-secret-private-key');
    expect(body.metadata?.ows_wallet_seed).toBe('word1 word2 word3');
    expect(body.metadata?.my_private_key).toBe('another-private-key');
    expect(body.metadata?.api_secret).toBe('api-secret-value');
  });

  it('GET /agents returns ssh_target for admin', async () => {
    const resp = await fetch(`${baseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    const body = await resp.json() as any;
    const agent = body.agents.find((a: any) => a.id === agentId);
    expect(agent).toBeDefined();
    expect(agent.ssh_target).toBe('op@host.example.com');
    expect(agent.internal_endpoint_url).toBe('http://127.0.0.1:8080');
  });
});

describe('Non-admin principal gets redacted record', () => {
  it('GET /agents/:id omits ssh_target for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/${agentId}`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ssh_target).toBeUndefined();
    expect(body.internal_endpoint_url).toBeUndefined();
  });

  it('GET /agents/:id omits sensitive metadata for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/${agentId}`, {
      headers: anonHeaders('public'),
    });
    const body = await resp.json() as any;
    expect(body.metadata?.auth_key_ref).toBeUndefined();
    expect(body.metadata?.ssh_private_key).toBeUndefined();
    expect(body.metadata?.ows_wallet_seed).toBeUndefined();
    // regex-net catches these:
    expect(body.metadata?.my_private_key).toBeUndefined();
    expect(body.metadata?.api_secret).toBeUndefined();
  });

  it('GET /agents/:id preserves non-sensitive metadata for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/${agentId}`, {
      headers: anonHeaders('public'),
    });
    const body = await resp.json() as any;
    expect(body.metadata?.safe_field).toBe('this-should-remain');
  });

  it('GET /agents omits ssh_target for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents`, {
      headers: anonHeaders('public'),
    });
    const body = await resp.json() as any;
    const agent = body.agents.find((a: any) => a.id === agentId);
    expect(agent).toBeDefined();
    expect(agent.ssh_target).toBeUndefined();
    expect(agent.internal_endpoint_url).toBeUndefined();
  });

  it('GET /agents omits sensitive metadata for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents`, {
      headers: anonHeaders('public'),
    });
    const body = await resp.json() as any;
    const agent = body.agents.find((a: any) => a.id === agentId);
    expect(agent.metadata?.auth_key_ref).toBeUndefined();
    expect(agent.metadata?.ssh_private_key).toBeUndefined();
  });

  it('GET /agents/by-name/:name omits sensitive fields for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/by-name/sensitive-agent`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ssh_target).toBeUndefined();
    expect(body.internal_endpoint_url).toBeUndefined();
    expect(body.metadata?.auth_key_ref).toBeUndefined();
  });

  it('GET /agents/resolve/:ref omits sensitive fields for non-admin', async () => {
    const resp = await fetch(`${baseUrl}/agents/resolve/sensitive-agent`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    const agent = body.agent || (body.agents && body.agents[0]);
    expect(agent).toBeDefined();
    expect(agent.ssh_target).toBeUndefined();
    expect(agent.metadata?.auth_key_ref).toBeUndefined();
  });
});
