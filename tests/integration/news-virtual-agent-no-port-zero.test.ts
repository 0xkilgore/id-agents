// SPDX-License-Identifier: MIT
/**
 * Regression: `/remote` `news <agent>` against a virtual / no-endpoint agent
 * row must not produce an `http://localhost:0` REST-AP catalog fetch.
 *
 * Before: the case-news handler in executeRemoteCommand only short-circuited
 * for `type === 'interactive'` rows. Virtual / remote-only rows that had no
 * `port` and no `endpoint` filled in fell through to
 * `a.endpoint || \`http://localhost:${a.port}\`` → `http://localhost:0`,
 * which the daemon then probed for `/.well-known/restap.json` on every CLI
 * news poll, spamming `[REST-AP] Could not fetch catalog from
 * http://localhost:0` into the logs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
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
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';

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
    events: new SqliteEventsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function teamHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: ReturnType<typeof createInMemoryDb>;

beforeAll(async () => {
  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-virtual-no-port-zero-test-'));
  db = createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /remote `news <virtual-agent>` does not probe http://localhost:0', () => {
  const TEAM = 'news-virtual-test';

  it('returns an empty news result without a catalog fetch when port=0 and endpoint is null', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);

    // Virtual / remote-stub row: no usable local network endpoint.
    await db.agents.create({
      team_id: teamId,
      id: 'virtual_demo',
      name: 'virtual-demo',
      type: 'virtual',
      model: '',
      port: 0,
      endpoint: null,
      working_directory: null,
      status: 'registered',
      created_at: Date.now(),
    } as any);

    // Capture stdout so we can assert no port-0 catalog fetch logs leak from
    // discoverRestAPEndpoints during this code path.
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };

    try {
      const res = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: teamHeaders(TEAM),
        body: JSON.stringify({ command: '/news virtual-demo' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; result?: { items: unknown[]; total: number } };
      expect(body.ok).toBe(true);
      expect(body.result?.items).toEqual([]);
      expect(body.result?.total).toBe(0);
    } finally {
      console.log = originalLog;
    }

    const portZeroLogs = logs.filter((l) => l.includes('http://localhost:0'));
    expect(portZeroLogs).toEqual([]);
  });
});
