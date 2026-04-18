// SPDX-License-Identifier: MIT
/**
 * Remote Runtime Integration Tests — Phase 2
 *
 * Proves the public-agent-remote runtime entry and its guardrails:
 *   - Registry: getRuntime returns correct deploymentShape, isRemoteEndpointRuntime gates
 *   - POST /agents/spawn with remote runtime → 400 runtime_not_spawnable
 *   - POST /agents/register with valid remote payload → 201, correct shape in GET /agents
 *   - Lifecycle commands on a registered remote agent → error lifecycle_not_supported_for_remote
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
import {
  getRuntimeProfile,
  isRemoteEndpointRuntime,
  getAvailableRuntimes,
} from '../../src/runtime/registry.js';

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

// --- Header helpers ---
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
let publicTeamId: string;

// ID set during registration test
let registeredRemoteAgentId: string;
let registeredRemoteAgentName: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-runtime-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  const db = createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);

  await manager.start(port);

  publicTeamId = await db.teams.getOrCreateTeamId('public');
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

// =====================================================================
// 1. Runtime registry unit checks (no HTTP)
// =====================================================================

describe('Runtime registry — public-agent-remote', () => {
  it('getRuntime("public-agent-remote") returns deploymentShape: remote-endpoint', () => {
    const profile = getRuntimeProfile('public-agent-remote');
    expect(profile).toBeDefined();
    expect(profile.id).toBe('public-agent-remote');
    expect(profile.deploymentShape).toBe('remote-endpoint');
    expect(profile.sessionPolicy).toBe('remote-owned');
    expect(profile.auth.mode).toBe('ssh-tunnel');
    expect(profile.capabilities.supportsResume).toBe(false);
    expect(profile.capabilities.supportsPlugins).toBe(false);
    expect(profile.capabilities.supportsAllowedTools).toBe(false);
  });

  it('isRemoteEndpointRuntime("public-agent-remote") === true', () => {
    expect(isRemoteEndpointRuntime('public-agent-remote')).toBe(true);
  });

  it('isRemoteEndpointRuntime returns false for all local-process runtimes', () => {
    const localRuntimes = ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex'];
    for (const rt of localRuntimes) {
      expect(isRemoteEndpointRuntime(rt)).toBe(false);
    }
  });

  it('isRemoteEndpointRuntime returns false for undefined/unknown', () => {
    expect(isRemoteEndpointRuntime(undefined)).toBe(false);
    expect(isRemoteEndpointRuntime('nonexistent-runtime')).toBe(false);
  });

  it('public-agent-remote appears in getAvailableRuntimes()', () => {
    expect(getAvailableRuntimes()).toContain('public-agent-remote');
  });

  it('local-process runtimes have deploymentShape: local-process', () => {
    for (const rt of ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex']) {
      const profile = getRuntimeProfile(rt);
      expect(profile.deploymentShape).toBe('local-process');
    }
  });
});

// =====================================================================
// 2. POST /agents/spawn guardrail
// =====================================================================

describe('POST /agents/spawn — remote runtime rejected', () => {
  it('returns 400 runtime_not_spawnable for public-agent-remote', async () => {
    const res = await fetch(`${baseUrl}/agents/spawn`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: `test-remote-spawn-${Date.now()}`,
        runtime: 'public-agent-remote',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('runtime_not_spawnable');
  });

  it('no agent record is created after rejected spawn', async () => {
    const uniqueName = `no-spawn-leak-${Date.now()}`;
    await fetch(`${baseUrl}/agents/spawn`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ name: uniqueName, runtime: 'public-agent-remote' }),
    });
    const listRes = await fetch(`${baseUrl}/agents`, { headers: adminHeaders('public') });
    const listBody = await listRes.json() as any;
    const names = listBody.agents.map((a: any) => a.alias ?? a.name);
    expect(names).not.toContain(uniqueName);
  });
});

// =====================================================================
// 3. POST /agents/register — remote payload
// =====================================================================

describe('POST /agents/register — public-agent-remote', () => {
  it('returns 400 when name is missing', async () => {
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        runtime: 'public-agent-remote',
        customer_domain: 'test.example.com',
        public_endpoint_url: 'https://test.example.com',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('missing_field');
  });

  it('returns 400 when customer_domain is missing', async () => {
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: `no-domain-${Date.now()}`,
        runtime: 'public-agent-remote',
        public_endpoint_url: 'https://test.example.com',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('missing_field');
  });

  it('returns 400 when public_endpoint_url is missing', async () => {
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: `no-url-${Date.now()}`,
        runtime: 'public-agent-remote',
        customer_domain: 'test.example.com',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('missing_field');
  });

  it('returns 400 for an unparseable public_endpoint_url', async () => {
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: `bad-url-${Date.now()}`,
        runtime: 'public-agent-remote',
        customer_domain: 'test.example.com',
        public_endpoint_url: 'not a url',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid_url');
  });

  it('registers a valid remote agent and returns 201 with correct shape', async () => {
    registeredRemoteAgentName = `remote-agent-${Date.now()}`;
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: registeredRemoteAgentName,
        runtime: 'public-agent-remote',
        customer_domain: 'docs.customer.com',
        public_endpoint_url: 'https://docs.customer.com',
        internal_endpoint_url: 'http://localhost:3100',
        ssh_target: 'user@vps.example.com',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;

    // Capture for use in later tests
    registeredRemoteAgentId = body.id;
    expect(registeredRemoteAgentId).toBeTruthy();

    expect(body.runtime).toBe('public-agent-remote');
    expect(body.deploymentShape).toBe('remote-endpoint');
    expect(body.status).toBe('registered');
    expect(body.port).toBeNull();
    expect(body.url).toBeNull();
    expect(body.health).toBe('unknown');
    expect(body.customer_domain).toBe('docs.customer.com');
    expect(body.public_endpoint_url).toBe('https://docs.customer.com');
    expect(body.internal_endpoint_url).toBe('http://localhost:3100');
    expect(body.ssh_target).toBe('user@vps.example.com');
  });

  it('returns 409 if the same name is registered twice in the same team', async () => {
    // First registration should already have been done above
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: registeredRemoteAgentName,
        runtime: 'public-agent-remote',
        customer_domain: 'docs2.customer.com',
        public_endpoint_url: 'https://docs2.customer.com',
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('name_conflict');
  });
});

// =====================================================================
// 4. GET /agents — remote agent appears with correct shape
// =====================================================================

describe('GET /agents — remote agent list shape', () => {
  it('remote agent appears in GET /agents with deploymentShape=remote-endpoint', async () => {
    const res = await fetch(`${baseUrl}/agents`, { headers: adminHeaders('public') });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const remoteAgent = body.agents.find((a: any) => a.id === registeredRemoteAgentId);
    expect(remoteAgent).toBeDefined();
    expect(remoteAgent.deploymentShape).toBe('remote-endpoint');
    expect(remoteAgent.port).toBeNull();
    expect(remoteAgent.status).toBe('registered');
  });

  it('remote agent health is unknown', async () => {
    const res = await fetch(`${baseUrl}/agents`, { headers: adminHeaders('public') });
    const body = await res.json() as any;
    const remoteAgent = body.agents.find((a: any) => a.id === registeredRemoteAgentId);
    expect(remoteAgent?.health).toBe('unknown');
  });
});

// =====================================================================
// 5. Lifecycle guardrail on registered remote agent
// =====================================================================

describe('Lifecycle commands on remote agent', () => {
  async function sendCommand(command: string) {
    return fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command }),
    });
  }

  it('start returns lifecycle_not_supported_for_remote error', async () => {
    const res = await sendCommand(`/agent ${registeredRemoteAgentName} start`);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('lifecycle_not_supported_for_remote');
  });

  it('stop returns lifecycle_not_supported_for_remote error', async () => {
    const res = await sendCommand(`/agent ${registeredRemoteAgentName} stop`);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('lifecycle_not_supported_for_remote');
  });

  it('rebuild returns lifecycle_not_supported_for_remote error', async () => {
    const res = await sendCommand(`/agent ${registeredRemoteAgentName} rebuild`);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('lifecycle_not_supported_for_remote');
  });
});
