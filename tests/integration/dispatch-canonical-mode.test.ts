// SPDX-License-Identifier: MIT
/**
 * Integration tests for Task 10 of the dispatch-canonical plan:
 *   DISPATCH_CANONICAL_MODE env flag + startup log. The manager parses the
 *   flag once at boot, exposes it on the instance as `dispatchCanonicalMode`,
 *   and emits a structured `[Manager] dispatch_canonical_mode=<mode>` line
 *   on stdout so operators can confirm the rollout phase from the log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { parseDispatchCanonicalMode } from '../../src/dispatch-scheduler/policy.js';

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
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
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

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

describe('parseDispatchCanonicalMode (unit)', () => {
  it('defaults to shadow when unset', () => {
    expect(parseDispatchCanonicalMode({})).toBe('shadow');
  });

  it('returns enforce when DISPATCH_CANONICAL_MODE=enforce', () => {
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: 'enforce' })).toBe('enforce');
  });

  it('is case-insensitive', () => {
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: 'ENFORCE' })).toBe('enforce');
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: 'Shadow' })).toBe('shadow');
  });

  it('falls back to shadow on any unrecognized value', () => {
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: 'strict' })).toBe('shadow');
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: '' })).toBe('shadow');
  });
});

describe('manager logs dispatch_canonical_mode on start', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let workDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalMode = process.env.DISPATCH_CANONICAL_MODE;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
  });

  afterEach(async () => {
    if (manager) await stopManager(manager);
    logSpy.mockRestore();
    if (originalMode === undefined) {
      delete process.env.DISPATCH_CANONICAL_MODE;
    } else {
      process.env.DISPATCH_CANONICAL_MODE = originalMode;
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('logs dispatch_canonical_mode=shadow by default', async () => {
    delete process.env.DISPATCH_CANONICAL_MODE;
    const port = await findFreePort();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-canonical-mode-shadow-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    const matched = logSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(' '))
      .find((line) => /dispatch_canonical_mode=shadow/.test(line));
    expect(matched).toBeTruthy();
    expect(manager.dispatchCanonicalMode).toBe('shadow');
  }, 30000);

  it('logs dispatch_canonical_mode=enforce when env set to enforce', async () => {
    process.env.DISPATCH_CANONICAL_MODE = 'enforce';
    const port = await findFreePort();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-canonical-mode-enforce-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    const matched = logSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(' '))
      .find((line) => /dispatch_canonical_mode=enforce/.test(line));
    expect(matched).toBeTruthy();
    expect(manager.dispatchCanonicalMode).toBe('enforce');
  }, 30000);
});
