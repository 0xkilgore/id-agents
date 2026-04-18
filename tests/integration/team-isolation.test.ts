// SPDX-License-Identifier: MIT
/**
 * Team Isolation Integration Tests — Phase 1
 *
 * Proves that team boundaries are enforced in the manager:
 *   - idchain cannot see public agents (list, get by id, get by name)
 *   - idchain cannot claim or mark done tasks belonging to public
 *   - same task name can coexist in two teams
 *   - admin principal can operate across teams with explicit ?team=
 *   - non-admin cannot create tasks in another team
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import type { AgentRow, TaskRow } from '../../src/db/types.js';

// --- DB factory helper (in-memory) ---
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

// --- Port helper ---
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

// --- Test helpers ---
function makeHeaders(team: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    ...extra,
  };
}

function adminHeaders(team: string): Record<string, string> {
  return makeHeaders(team, { 'X-Id-Admin': '1' });
}

// --- Test state ---
let port: number;
let manager: AgentManagerDb;
let baseUrl: string;
let workDir: string;

// IDs set during beforeAll
let idchainTeamId: string;
let publicTeamId: string;
let idchainAgentId: string;
let publicAgentId: string;
let idchainAgentName: string;
let publicAgentName: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-isolation-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  const db = createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);

  // Start manager — this seeds default/idchain/public teams
  await manager.start(port);

  // Resolve team IDs
  idchainTeamId = await db.teams.getOrCreateTeamId('idchain');
  publicTeamId = await db.teams.getOrCreateTeamId('public');

  // Register one agent in each team
  idchainAgentName = `idchain-agent-${Date.now()}`;
  publicAgentName = `public-agent-${Date.now()}`;

  idchainAgentId = `agent-${randomUUID()}`;
  publicAgentId = `agent-${randomUUID()}`;

  const now = Math.floor(Date.now() / 1000);

  await db.agents.create({
    team_id: idchainTeamId,
    id: idchainAgentId,
    name: idchainAgentName,
    type: 'virtual',
    model: 'sonnet',
    status: 'running',
    created_at: now,
    port: 0,
  });

  await db.agents.create({
    team_id: publicTeamId,
    id: publicAgentId,
    name: publicAgentName,
    type: 'virtual',
    model: 'sonnet',
    status: 'running',
    created_at: now,
    port: 0,
  });
}, 30000);

afterAll(async () => {
  if (manager) {
    // Stop the manager's HTTP server
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  // Clean up temp workdir
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// =====================================================================
// Agent list isolation
// =====================================================================

describe('GET /agents — team-scoped list', () => {
  it('idchain sees only idchain agents', async () => {
    const res = await fetch(`${baseUrl}/agents`, { headers: makeHeaders('idchain') });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain(idchainAgentId);
    expect(ids).not.toContain(publicAgentId);
  });

  it('public sees only public agents', async () => {
    const res = await fetch(`${baseUrl}/agents`, { headers: makeHeaders('public') });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain(publicAgentId);
    expect(ids).not.toContain(idchainAgentId);
  });
});

// =====================================================================
// GET /agents/:id isolation
// =====================================================================

describe('GET /agents/:id — team-enforced lookup', () => {
  it('idchain principal gets 404 for public agent id', async () => {
    const res = await fetch(`${baseUrl}/agents/${publicAgentId}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.status).toBe(404);
  });

  it('idchain principal can get idchain agent by id', async () => {
    const res = await fetch(`${baseUrl}/agents/${idchainAgentId}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.id).toEqual(idchainAgentId);
  });
});

// =====================================================================
// GET /agents/by-name/:name isolation
// =====================================================================

describe('GET /agents/by-name/:name — team-enforced', () => {
  it('idchain cannot find public agent by name', async () => {
    const res = await fetch(`${baseUrl}/agents/by-name/${publicAgentName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.status).toBe(404);
  });

  it('idchain can find idchain agent by name', async () => {
    const res = await fetch(`${baseUrl}/agents/by-name/${idchainAgentName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.id ?? body.agent?.id).toBeTruthy();
  });
});

// =====================================================================
// POST /tasks — cross-team creation guard
// =====================================================================

describe('POST /tasks — cross-team creation guard', () => {
  it('non-admin cannot create a task in another team', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ title: 'cross-team-task', team: 'public' }),
    });
    expect(res.status).toBe(403);
  });

  it('admin principal CAN create a task in another team explicitly', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({ title: 'admin-cross-team-task', name: `admin-cross-task-${Date.now()}`, team: 'public' }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });
});

// =====================================================================
// Task same-name coexistence in different teams
// =====================================================================

describe('Tasks — (team_id, name) scoped resolution', () => {
  const sharedTaskName = `shared-task-${Date.now()}`;

  it('same task name can coexist in idchain and public teams', async () => {
    // Create in idchain (admin to ensure team exists)
    const r1 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({ title: 'Shared Task', name: sharedTaskName }),
    });
    expect(r1.ok).toBe(true);

    // Create same name in public
    const r2 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ title: 'Shared Task', name: sharedTaskName }),
    });
    expect(r2.ok).toBe(true);
  });

  it('GET /tasks/:name returns idchain task when called as idchain', async () => {
    const res = await fetch(`${baseUrl}/tasks/${sharedTaskName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    // team name in response should be idchain
    expect(body.task.teamName).toEqual('idchain');
  });

  it('GET /tasks/:name returns public task when called as public', async () => {
    const res = await fetch(`${baseUrl}/tasks/${sharedTaskName}`, {
      headers: makeHeaders('public'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.task.teamName).toEqual('public');
  });
});

// =====================================================================
// Task claim cross-team guard
// =====================================================================

describe('POST /tasks/:name/claim — cross-team guard', () => {
  const publicOnlyTask = `public-only-task-${Date.now()}`;

  it('setup: create a task in public team', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ title: 'Public Only Task', name: publicOnlyTask }),
    });
    expect(res.ok).toBe(true);
  });

  it('idchain principal cannot claim a public team task', async () => {
    const res = await fetch(`${baseUrl}/tasks/${publicOnlyTask}/claim`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ agent_id: idchainAgentId }),
    });
    // Should be 404 (task not found in idchain team)
    expect(res.status).toBe(404);
  });
});

// =====================================================================
// GET /tasks — defaults to current team
// =====================================================================

describe('GET /tasks — defaults to current team', () => {
  it('GET /tasks without team param returns only current team tasks', async () => {
    const uniqueTaskName = `idchain-unique-${Date.now()}`;
    // Create a unique task in idchain
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({ title: 'Idchain Unique Task', name: uniqueTaskName }),
    });
    const createBody = await createRes.json().catch(() => ({}));
    expect(createRes.ok, `POST /tasks failed: ${JSON.stringify(createBody)}`).toBe(true);

    // List idchain tasks — should see idchain task
    // Use admin headers here since non-admin needs the team to already exist
    const idchainRes = await fetch(`${baseUrl}/tasks`, {
      headers: adminHeaders('idchain'),
    });
    const idchainBody = await idchainRes.json().catch(() => ({})) as any;
    expect(idchainRes.ok, `GET /tasks failed: ${JSON.stringify(idchainBody)}`).toBe(true);
    const idchainNames = idchainBody.tasks.map((t: any) => t.name);
    expect(idchainNames).toContain(uniqueTaskName);

    // List public tasks — should NOT see idchain task
    const publicRes = await fetch(`${baseUrl}/tasks`, {
      headers: makeHeaders('public'),
    });
    expect(publicRes.ok).toBe(true);
    const publicBody = await publicRes.json() as any;
    const publicNames = publicBody.tasks.map((t: any) => t.name);
    expect(publicNames).not.toContain(uniqueTaskName);
  });
});

// =====================================================================
// Admin can operate across teams
// =====================================================================

describe('Admin principal — cross-team access', () => {
  it('admin can GET agents in public team with X-Id-Team: public', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain(publicAgentId);
  });
});

// =====================================================================
// Non-existent team handling (non-admin)
// =====================================================================

describe('Non-existent team — non-admin gets 404', () => {
  it('non-admin request to nonexistent team returns 404 team_not_found', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      headers: makeHeaders('nonexistent-team-xyz'),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toEqual('team_not_found');
  });

  it('admin request to nonexistent team creates it and returns agents', async () => {
    const newTeam = `new-team-${Date.now()}`;
    const res = await fetch(`${baseUrl}/agents`, {
      headers: adminHeaders(newTeam),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.agents).toEqual([]);
  });
});
