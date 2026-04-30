// SPDX-License-Identifier: MIT
/**
 * Integration tests for `/agents probe` and `/agent <name> probe`.
 *
 * These probes must be end-to-end: POST `/talk`, capture `query_id`,
 * then wait for `/query/:id` to reach `completed` or `failed`.
 * A shallow success on the initial `/talk` 202 would miss the exact
 * auth-failure class this command exists to surface.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

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
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      server.close(() => resolve(address.port));
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

type StubMode = 'ok' | 'failed';

async function startProbeStub(mode: StubMode): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const port = await findFreePort();
  let pollCount = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'POST' && url.pathname === '/talk') {
      req.resume();
      req.on('end', () => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          query_id: `${mode}-query`,
          status: 'processing',
        }));
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === `/${'query'}/${mode}-query`) {
      pollCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (mode === 'ok') {
        if (pollCount < 2) {
          res.end(JSON.stringify({ id: `${mode}-query`, status: 'processing' }));
          return;
        }
        res.end(JSON.stringify({
          id: `${mode}-query`,
          status: 'completed',
          result: { result: 'OK' },
        }));
        return;
      }

      res.end(JSON.stringify({
        id: `${mode}-query`,
        status: 'failed',
        error: '401: Invalid authentication credentials',
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withManager(
  run: (ctx: {
    baseUrl: string;
    db: ReturnType<typeof createInMemoryDb>;
  }) => Promise<void>,
): Promise<void> {
  const db = createInMemoryDb();
  const managerPort = await findFreePort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-probe-command-'));
  const manager = new AgentManagerDb(workDir, db as any);
  await manager.start(managerPort);

  try {
    await run({ baseUrl: `http://127.0.0.1:${managerPort}`, db });
  } finally {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('/remote probe commands', () => {
  afterAll(() => {
    // Explicit no-op so the suite mirrors other integration files.
  });

  it('probes running agents end-to-end and reports query failures from /query/:id', async () => {
    const TEAM = 'probe-team';
    const okStub = await startProbeStub('ok');
    const failedStub = await startProbeStub('failed');

    try {
      await withManager(async ({ baseUrl, db }) => {
        const teamId = await db.teams.getOrCreateTeamId(TEAM);
        await db.agents.create({
          team_id: teamId,
          id: 'healthy-agent',
          name: 'healthy-agent',
          type: 'claude',
          model: 'gpt-5.4',
          status: 'running',
          runtime: 'codex',
          endpoint: okStub.baseUrl,
          port: Number(new URL(okStub.baseUrl).port),
          created_at: Date.now(),
          metadata: { local: true },
        });
        await db.agents.create({
          team_id: teamId,
          id: 'broken-agent',
          name: 'broken-agent',
          type: 'claude',
          model: 'gpt-5.4',
          status: 'running',
          runtime: 'codex',
          endpoint: failedStub.baseUrl,
          port: Number(new URL(failedStub.baseUrl).port),
          created_at: Date.now(),
          metadata: { local: true },
        });
        await db.agents.create({
          team_id: teamId,
          id: 'stopped-agent',
          name: 'stopped-agent',
          type: 'claude',
          model: 'gpt-5.4',
          status: 'stopped',
          runtime: 'codex',
          endpoint: 'http://127.0.0.1:1',
          port: 1,
          created_at: Date.now(),
          metadata: { local: true },
        });

        const response = await fetch(`${baseUrl}/remote`, {
          method: 'POST',
          headers: adminHeaders(TEAM),
          body: JSON.stringify({ command: '/agents probe' }),
        });
        expect(response.ok).toBe(true);

        const body = await response.json() as {
          ok: boolean;
          result: {
            team: string;
            probed: number;
            passed: number;
            failed: number;
            results: Array<{ name: string; status: string; duration_ms: number; error?: string }>;
          };
        };

        expect(body.ok).toBe(true);
        expect(body.result.team).toBe(TEAM);
        expect(body.result.probed).toBe(2);
        expect(body.result.passed).toBe(1);
        expect(body.result.failed).toBe(1);
        const byName = Object.fromEntries(
          body.result.results.map((result) => [result.name, result]),
        );
        expect(byName['healthy-agent']).toEqual(expect.objectContaining({
          name: 'healthy-agent',
          status: 'ok',
        }));
        expect(byName['broken-agent']).toEqual(expect.objectContaining({
          name: 'broken-agent',
          status: 'failed',
          error: '401: Invalid authentication credentials',
        }));
      });
    } finally {
      await okStub.close();
      await failedStub.close();
    }
  }, 15000);

  it('supports /agent <name> probe for a single named agent', async () => {
    const TEAM = 'probe-single-team';
    const okStub = await startProbeStub('ok');

    try {
      await withManager(async ({ baseUrl, db }) => {
        const teamId = await db.teams.getOrCreateTeamId(TEAM);
        await db.agents.create({
          team_id: teamId,
          id: 'solo-agent',
          name: 'solo-agent',
          type: 'claude',
          model: 'gpt-5.4',
          status: 'running',
          runtime: 'codex',
          endpoint: okStub.baseUrl,
          port: Number(new URL(okStub.baseUrl).port),
          created_at: Date.now(),
          metadata: { local: true },
        });

        const response = await fetch(`${baseUrl}/remote`, {
          method: 'POST',
          headers: adminHeaders(TEAM),
          body: JSON.stringify({ command: '/agent solo-agent probe' }),
        });
        expect(response.ok).toBe(true);

        const body = await response.json() as {
          ok: boolean;
          result: {
            team: string;
            probed: number;
            passed: number;
            failed: number;
            results: Array<{ name: string; status: string; duration_ms: number }>;
          };
        };

        expect(body.ok).toBe(true);
        expect(body.result.team).toBe(TEAM);
        expect(body.result.probed).toBe(1);
        expect(body.result.passed).toBe(1);
        expect(body.result.failed).toBe(0);
        expect(body.result.results).toEqual([
          expect.objectContaining({ name: 'solo-agent', status: 'ok' }),
        ]);
      });
    } finally {
      await okStub.close();
    }
  }, 15000);
});
