// SPDX-License-Identifier: MIT
/**
 * Mesh Membership Enforcement Integration Tests — Phase 6A
 *
 * Verifies that the mesh-membership gate in handleMessage correctly:
 *   - Blocks /talk-to and /news-to to agents with metadata.mesh_member === false (403)
 *   - Allows admin bypass via ?admin=true query parameter
 *   - Default-true: pre-Phase-4 agents without mesh_member flag still receive messages
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

// Agent IDs seeded for tests
let meshAgentName: string;   // mesh_member: true (or absent) — should route
let nonMeshAgentName: string; // mesh_member: false, runtime:'default' — admin ?admin=true can still bypass
let prePh4AgentName: string;  // no mesh_member key at all — should default to true
let publicRemoteAgentName: string; // runtime:'public-agent-remote' — admin bypass must NOT work

// A dummy endpoint so resolveTargetAgent returns a non-null URL.
// It won't be reachable (connection refused) but the mesh gate fires before forwardToAgent.
const DUMMY_INTERNAL_URL = 'http://127.0.0.1:19998';

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-membership-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  const teamId = await db.teams.getOrCreateTeamId('idchain');

  const now = Date.now();

  // Agent A: explicit mesh_member:true (idchain agent)
  meshAgentName = 'mesh-agent-a';
  await db.agents.create({
    team_id: teamId,
    id: `agent_mesh_a`,
    name: meshAgentName,
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: DUMMY_INTERNAL_URL,
    working_directory: null,
    status: 'running',
    created_at: now,
    metadata: {
      mesh_member: true,
      internal_url: DUMMY_INTERNAL_URL,
    },
    runtime: 'default',
  });

  // Agent B: mesh_member:false with default runtime — admin bypass stays legal here.
  nonMeshAgentName = 'non-mesh-agent-b';
  await db.agents.create({
    team_id: teamId,
    id: `agent_non_mesh_b`,
    name: nonMeshAgentName,
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: DUMMY_INTERNAL_URL,
    working_directory: null,
    status: 'running',
    created_at: now,
    metadata: {
      mesh_member: false,
      internal_url: DUMMY_INTERNAL_URL,
    },
    runtime: 'default',
  });

  // Agent D: runtime:'public-agent-remote' — admin bypass must be blocked per F2.
  publicRemoteAgentName = 'public-remote-agent-d';
  await db.agents.create({
    team_id: teamId,
    id: `agent_public_remote_d`,
    name: publicRemoteAgentName,
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: DUMMY_INTERNAL_URL,
    working_directory: null,
    status: 'running',
    created_at: now,
    metadata: {
      mesh_member: false,
      internal_url: DUMMY_INTERNAL_URL,
      deployment_shape: 'remote-endpoint',
    },
    runtime: 'public-agent-remote',
  });

  // Agent C: no mesh_member key (pre-Phase-4 agent)
  prePh4AgentName = 'pre-ph4-agent-c';
  await db.agents.create({
    team_id: teamId,
    id: `agent_preph4_c`,
    name: prePh4AgentName,
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: DUMMY_INTERNAL_URL,
    working_directory: null,
    status: 'running',
    created_at: now,
    metadata: {
      // No mesh_member key — pre-Phase-4 style
      internal_url: DUMMY_INTERNAL_URL,
    },
    runtime: 'default',
  });
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

describe('Non-admin /talk-to mesh gate', () => {
  it('blocks /talk-to to non-mesh agent (mesh_member:false) with 403', async () => {
    const resp = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: anonHeaders('idchain'),
      body: JSON.stringify({
        to: nonMeshAgentName,
        message: 'hello',
        from: 'test',
        wait: false,
      }),
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
  });

  it('allows /talk-to to mesh agent (mesh_member:true)', async () => {
    const resp = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: anonHeaders('idchain'),
      body: JSON.stringify({
        to: meshAgentName,
        message: 'hello',
        from: 'test',
        wait: false,
      }),
    });
    // Will fail with 500 or similar (no real server) but NOT 403
    expect(resp.status).not.toBe(403);
    const body = await resp.json() as any;
    expect(body.error).not.toBe('not_mesh_reachable');
  });

  it('allows /talk-to to pre-Phase-4 agent (no mesh_member key — defaults true)', async () => {
    const resp = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: anonHeaders('idchain'),
      body: JSON.stringify({
        to: prePh4AgentName,
        message: 'hello',
        from: 'test',
        wait: false,
      }),
    });
    // Should not be 403 — pre-Phase-4 agents default to mesh_member=true
    expect(resp.status).not.toBe(403);
    const body = await resp.json() as any;
    expect(body.error).not.toBe('not_mesh_reachable');
  });
});

describe('Non-admin /news-to mesh gate', () => {
  it('blocks /news-to to non-mesh agent with 403', async () => {
    const resp = await fetch(`${baseUrl}/news-to`, {
      method: 'POST',
      headers: anonHeaders('idchain'),
      body: JSON.stringify({
        to: nonMeshAgentName,
        message: 'hello',
        from: 'test',
      }),
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
  });
});

describe('Admin bypass via ?admin=true', () => {
  it('admin with ?admin=true bypasses mesh gate (gets further in pipeline)', async () => {
    const resp = await fetch(`${baseUrl}/talk-to?admin=true`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({
        to: nonMeshAgentName,
        message: 'diagnostic ping',
        from: 'admin',
        wait: false,
      }),
    });
    // Should NOT be 403 — admin bypass is active
    // (Will fail at network level since DUMMY_INTERNAL_URL has no server, → 500 or similar)
    expect(resp.status).not.toBe(403);
    const body = await resp.json() as any;
    expect(body.error).not.toBe('not_mesh_reachable');
  });

  it('admin WITHOUT ?admin=true still gets 403 (bypass is opt-in)', async () => {
    const resp = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({
        to: nonMeshAgentName,
        message: 'hello',
        from: 'admin',
        wait: false,
      }),
    });
    // Admin without ?admin=true still hits the mesh gate
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
  });
});

describe('F2: admin ?admin=true cannot bridge to public-agent-remote', () => {
  it('admin ?admin=true → 403 not_mesh_reachable when target runtime is public-agent-remote', async () => {
    const resp = await fetch(`${baseUrl}/talk-to?admin=true`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({
        to: publicRemoteAgentName,
        message: 'diagnostic ping',
        from: 'admin',
        wait: false,
      }),
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
    // Public-remote-specific message; confirms the block reason
    expect(typeof body.message).toBe('string');
    expect(body.message).toMatch(/public-agent-remote/i);
  });

  it('admin ?admin=true on non-remote mesh-less target still bypasses (escape hatch preserved)', async () => {
    const resp = await fetch(`${baseUrl}/talk-to?admin=true`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({
        to: nonMeshAgentName,
        message: 'diagnostic ping',
        from: 'admin',
        wait: false,
      }),
    });
    expect(resp.status).not.toBe(403);
    const body = await resp.json() as any;
    expect(body.error).not.toBe('not_mesh_reachable');
  });
});

describe('Deprecated /message route mesh gate', () => {
  it('blocks /message to non-mesh agent with 403', async () => {
    const resp = await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: anonHeaders('idchain'),
      body: JSON.stringify({
        to: nonMeshAgentName,
        message: 'hello',
        from: 'test',
      }),
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
  });
});
