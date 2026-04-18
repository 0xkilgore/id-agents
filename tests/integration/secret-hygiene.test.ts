// SPDX-License-Identifier: MIT
/**
 * Secret Hygiene Integration Tests — Phase 6A
 *
 * Spins up a manager with seeded data and asserts that no response payload
 * contains secret-shaped strings: API keys, private keys, wallet seeds, or
 * PEM markers.
 *
 * Fake env vars are set BEFORE the manager starts so any code that accidentally
 * echoes process.env will be caught by the negative assertions.
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

// ─── Fake secrets injected into the environment ────────────────────────────────
// These are set BEFORE the manager starts. If any response accidentally echoes
// process.env.X, the negative assertions below will catch it.
const FAKE_OPENROUTER_KEY = 'sk-fake-open-router-key-for-test-xxxxxxxxxxxxxxxxxx';
const FAKE_OWS_WALLET = 'fake-ows-registrar-wallet-seed-for-test';
const FAKE_PRIVATE_KEY = '0x' + 'deadbeef'.repeat(8); // 64 hex chars after 0x
const FAKE_ID_REGISTRAR_PRIVATE_KEY = '0x' + 'cafebabe'.repeat(8);

// These are set before beforeAll so they're active during manager construction:
process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;
process.env.OWS_REGISTRAR_WALLET = FAKE_OWS_WALLET;
process.env.PRIVATE_KEY = FAKE_PRIVATE_KEY;
process.env.ID_REGISTRAR_PRIVATE_KEY = FAKE_ID_REGISTRAR_PRIVATE_KEY;

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

// ─── Secret patterns to assert absence of ─────────────────────────────────────

const FORBIDDEN_LITERALS = [
  'OPENROUTER_API_KEY',
  'OWS_REGISTRAR_WALLET',
  'ID_REGISTRAR_PRIVATE_KEY',
  'PRIVATE_KEY',
  'auth_key_ref',
  'ssh_private_key',
  'ows_wallet_seed',
  // The actual fake secret values
  FAKE_OPENROUTER_KEY,
  FAKE_OWS_WALLET,
  FAKE_PRIVATE_KEY,
  FAKE_ID_REGISTRAR_PRIVATE_KEY,
];

/** 64+ hex chars after 0x — private key length. Wallet addresses are 40 hex chars so they won't match. */
const PRIVATE_KEY_REGEX = /0x[0-9a-fA-F]{64,}/;
/** OpenAI/OpenRouter API key prefix */
const API_KEY_REGEX = /sk-[A-Za-z0-9]{20,}/;
/** PEM markers */
const PEM_REGEX = /-----BEGIN/;

function assertNoSecrets(label: string, json: string): void {
  for (const literal of FORBIDDEN_LITERALS) {
    if (json.includes(literal)) {
      throw new Error(`Secret hygiene FAIL [${label}]: response contains forbidden literal: ${literal}`);
    }
  }
  if (PRIVATE_KEY_REGEX.test(json)) {
    throw new Error(`Secret hygiene FAIL [${label}]: response contains private-key-length hex string`);
  }
  if (API_KEY_REGEX.test(json)) {
    throw new Error(`Secret hygiene FAIL [${label}]: response contains API key pattern`);
  }
  if (PEM_REGEX.test(json)) {
    throw new Error(`Secret hygiene FAIL [${label}]: response contains PEM marker`);
  }
}

// ─── Test state ───────────────────────────────────────────────────────────────

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: ReturnType<typeof createInMemoryDb>;

let publicTeamId: string;
let idchainTeamId: string;
let agentIdA: string;
let agentIdB: string;
let taskName: string;
let newsAgentId: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-hygiene-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  db = createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  publicTeamId = await db.teams.getOrCreateTeamId('public');
  idchainTeamId = await db.teams.getOrCreateTeamId('idchain');

  const now = Date.now();

  // Seed an idchain agent (no sensitive fields)
  await db.agents.create({
    team_id: idchainTeamId,
    id: 'seed-agent-idchain',
    name: 'seed-idchain',
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: 'http://127.0.0.1:9999',
    working_directory: null,
    status: 'running',
    created_at: now,
    metadata: { mesh_member: true },
    runtime: 'default',
  });
  agentIdA = 'seed-agent-idchain';

  // Seed a public-agent-remote agent WITH sensitive metadata
  const regResp = await fetch(`${baseUrl}/agents/register`, {
    method: 'POST',
    headers: adminHeaders('public'),
    body: JSON.stringify({
      runtime: 'public-agent-remote',
      name: 'hygiene-remote',
      customer_domain: 'hygiene.example.com',
      public_endpoint_url: 'https://hygiene.example.com',
      internal_endpoint_url: 'http://127.0.0.1:8090',
      ssh_target: 'deploy@hygiene.example.com',
    }),
  });
  expect(regResp.status).toBe(201);
  const regBody = await regResp.json() as any;
  agentIdB = regBody.id;

  // Add sensitive metadata via PATCH
  await fetch(`${baseUrl}/agents/${agentIdB}/metadata`, {
    method: 'POST',
    headers: adminHeaders('public'),
    body: JSON.stringify({
      metadata: {
        auth_key_ref: 'secret-ref-value',
        ssh_private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA',
        ows_wallet_seed: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
      },
    }),
  });

  // Seed an interactive (CLI) agent so news is stored
  await db.agents.create({
    team_id: publicTeamId,
    id: 'seed-cli-public',
    name: 'seed-cli',
    type: 'interactive',
    model: 'unknown',
    port: 0,
    endpoint: null,
    working_directory: null,
    status: 'running',
    created_at: now,
    metadata: {},
    runtime: 'default',
  });
  newsAgentId = 'seed-cli-public';

  // Seed a news item
  await db.news.add(publicTeamId, newsAgentId, {
    timestamp: now,
    type: 'message',
    message: 'Hello from test',
    data: { from: 'tester', message: 'Hello from test' },
    kind: 'notify',
    reply_expected: false,
  });

  // Seed a task
  const taskResp = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: adminHeaders('public'),
    body: JSON.stringify({
      title: 'Hygiene test task',
      from: 'seed-cli',
    }),
  });
  if (taskResp.status === 201) {
    const taskBody = await taskResp.json() as any;
    taskName = taskBody.task?.name;
  }
}, 30000);

afterAll(async () => {
  // Clean up fake env vars
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OWS_REGISTRAR_WALLET;
  delete process.env.PRIVATE_KEY;
  delete process.env.ID_REGISTRAR_PRIVATE_KEY;

  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Secret hygiene — non-admin responses', () => {
  it('GET /agents?team=public contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/agents`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    assertNoSecrets('GET /agents (public, anon)', text);
  });

  it('GET /agents?team=idchain contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/agents`, {
      headers: anonHeaders('idchain'),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    assertNoSecrets('GET /agents (idchain, anon)', text);
  });

  it('GET /agents/:id (public-agent-remote) contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/agents/${agentIdB}`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    assertNoSecrets(`GET /agents/${agentIdB} (anon)`, text);
  });

  it('GET /news contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/news`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    assertNoSecrets('GET /news (public, anon)', text);
  });

  it('GET /tasks contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/tasks`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    assertNoSecrets('GET /tasks (public, anon)', text);
  });

  it('GET /agents/status contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/agents/status`, {
      headers: anonHeaders('public'),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    assertNoSecrets('GET /agents/status (public, anon)', text);
  });
});

describe('Secret hygiene — admin responses', () => {
  it('GET /agents (admin) contains no ENV var names or values', async () => {
    // Admin gets full records but should NEVER echo raw env var names as field values.
    // The sensitive data in agent records is the stored values (ssh_target etc.),
    // not raw process.env.OPENROUTER_API_KEY strings.
    const resp = await fetch(`${baseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    const text = await resp.text();
    // Only check that raw env var names are not echoed as field keys in JSON
    // (admin CAN see stored ssh_target etc. — that's intentional)
    expect(text).not.toContain('OPENROUTER_API_KEY');
    expect(text).not.toContain('OWS_REGISTRAR_WALLET');
    expect(text).not.toContain('ID_REGISTRAR_PRIVATE_KEY');
    // The fake values themselves should also not appear
    expect(text).not.toContain(FAKE_OPENROUTER_KEY);
    expect(text).not.toContain(FAKE_PRIVATE_KEY);
    expect(text).not.toContain(FAKE_ID_REGISTRAR_PRIVATE_KEY);
  });

  it('GET /tasks (admin) contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/tasks`, {
      headers: adminHeaders('public'),
    });
    const text = await resp.text();
    expect(text).not.toContain(FAKE_OPENROUTER_KEY);
    expect(text).not.toContain(FAKE_PRIVATE_KEY);
  });
});

describe('Secret hygiene — individual task and by-name routes', () => {
  it('GET /tasks/:ref contains no secrets', async () => {
    if (!taskName) return; // Task creation may have been skipped
    const resp = await fetch(`${baseUrl}/tasks/${taskName}`, {
      headers: anonHeaders('public'),
    });
    if (resp.status === 200) {
      const text = await resp.text();
      assertNoSecrets(`GET /tasks/${taskName} (anon)`, text);
    }
  });

  it('GET /agents/by-name/:name contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/agents/by-name/hygiene-remote`, {
      headers: anonHeaders('public'),
    });
    if (resp.status === 200) {
      const text = await resp.text();
      assertNoSecrets('GET /agents/by-name/hygiene-remote (anon)', text);
    }
  });

  it('GET /agents/resolve/:ref contains no secrets', async () => {
    const resp = await fetch(`${baseUrl}/agents/resolve/hygiene-remote`, {
      headers: anonHeaders('public'),
    });
    if (resp.status === 200) {
      const text = await resp.text();
      assertNoSecrets('GET /agents/resolve/hygiene-remote (anon)', text);
    }
  });
});
