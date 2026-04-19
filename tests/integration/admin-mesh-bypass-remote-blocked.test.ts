// SPDX-License-Identifier: MIT
/**
 * F2 regression test.
 *
 * Loopback admin with `?admin=true` must NOT bridge to a `public-agent-remote`
 * runtime via the manager. Public-remote traffic lives in the DMZ — the public
 * plane uses direct HTTPS to /talk, the operator plane uses SSH tunnels. A
 * manager-proxied admin shortcut would re-build the proxy path the design
 * explicitly forbids.
 *
 * Setup mirrors tests/integration/mesh-membership.test.ts but is scoped
 * narrowly to the public-agent-remote block so this file stands on its own.
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

function createDb() {
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

const DUMMY_INTERNAL_URL = 'http://127.0.0.1:19998';

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: ReturnType<typeof createDb>;
const publicRemoteName = 'public-remote-blocked-target';

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-remote-block-'));
  baseUrl = `http://127.0.0.1:${port}`;

  db = createDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  const teamId = await db.teams.getOrCreateTeamId('idchain');

  await db.agents.create({
    team_id: teamId,
    id: 'agent_public_remote_blocked',
    name: publicRemoteName,
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: DUMMY_INTERNAL_URL,
    working_directory: null,
    status: 'running',
    created_at: Date.now(),
    metadata: {
      mesh_member: false,
      internal_url: DUMMY_INTERNAL_URL,
      deployment_shape: 'remote-endpoint',
    },
    runtime: 'public-agent-remote',
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

describe('F2: admin ?admin=true is blocked when target is public-agent-remote', () => {
  it('/talk-to?admin=true → 403 not_mesh_reachable for public-agent-remote target', async () => {
    const resp = await fetch(`${baseUrl}/talk-to?admin=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': 'idchain',
        'X-Id-Admin': '1',
      },
      body: JSON.stringify({
        to: publicRemoteName,
        message: 'diagnostic',
        from: 'admin',
        wait: false,
      }),
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.error).toBe('not_mesh_reachable');
    expect(String(body.message ?? '')).toMatch(/public-agent-remote/i);
  });
});
