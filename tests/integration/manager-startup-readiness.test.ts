import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

describe('manager startup readiness ordering', () => {
  const managers: AgentManagerDb[] = [];
  const dirs: string[] = [];
  const previousEnv = {
    supervisorEnabled: process.env.SUPERVISOR_WATCH_ENABLED,
    supervisorAlertFile: process.env.SUPERVISOR_ALERT_FILE_PATH,
    startupDelay: process.env.MANAGER_STARTUP_RECOVERY_DELAY_MS,
  };

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown().catch(() => undefined)));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (previousEnv.supervisorEnabled === undefined) delete process.env.SUPERVISOR_WATCH_ENABLED;
    else process.env.SUPERVISOR_WATCH_ENABLED = previousEnv.supervisorEnabled;
    if (previousEnv.supervisorAlertFile === undefined) delete process.env.SUPERVISOR_ALERT_FILE_PATH;
    else process.env.SUPERVISOR_ALERT_FILE_PATH = previousEnv.supervisorAlertFile;
    if (previousEnv.startupDelay === undefined) delete process.env.MANAGER_STARTUP_RECOVERY_DELAY_MS;
    else process.env.MANAGER_STARTUP_RECOVERY_DELAY_MS = previousEnv.startupDelay;
  });

  it('serves truthful /health before large worktree and alert recovery fixtures are scanned', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-readiness-'));
    dirs.push(workDir);
    const worktreesDir = path.join(workDir, '.worktrees');
    fs.mkdirSync(worktreesDir);
    for (let i = 0; i < 2_000; i += 1) {
      fs.writeFileSync(path.join(worktreesDir, `fixture-${i}`), 'x');
    }
    const alertFile = path.join(workDir, 'supervisor-alerts.jsonl');
    fs.writeFileSync(alertFile, `${JSON.stringify({ type: 'open', id: 'fixture' })}\n`.repeat(20_000));
    process.env.SUPERVISOR_WATCH_ENABLED = 'true';
    process.env.SUPERVISOR_ALERT_FILE_PATH = alertFile;
    process.env.MANAGER_STARTUP_RECOVERY_DELAY_MS = '2000';

    const db = await createInMemoryDb();
    const manager = new AgentManagerDb(workDir, db as any);
    managers.push(manager);

    const port = await freePort();
    const startedAt = Date.now();
    const startup = manager.start(port);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const elapsedMs = Date.now() - startedAt;
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(body.status).toBe('ok');
    expect(['pending', 'running']).toContain(body.startup_recovery.state);
    expect(body.nominal).toBe(false);
    expect(body.nominal_reasons).toContain(`startup_recovery_${body.startup_recovery.state}`);
    await startup;
  }, 30_000);
});
