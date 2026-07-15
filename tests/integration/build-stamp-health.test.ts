// T11.1 build-stamp: verify the running build identity actually shows on
// GET /health (and that the behind-origin staleness fields are present).

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

describe('GET /health build-stamp (T11.1)', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-stamp-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('exposes the running build identity (build_sha + staleness fields)', async () => {
    (manager as any).fleetFreshnessSummary = {
      fleet_behind: true,
      stale_nodes: ['kapelle-site'],
      node_count: 1,
      nodes: [{
        node_id: 'kapelle-site',
        state: 'stale',
        behind_origin: true,
        behind_origin_since: '2026-07-12T00:00:00.000Z',
        build_sha: '1111111',
        origin_main_sha: '2222222',
        release_state: {
          repo_dir: '/srv/kapelle-site',
          observed_at: '2026-07-12T00:00:00.000Z',
          status: 'red',
          checkout: {
            exists: true,
            is_git: true,
            branch: 'feature/local-ops',
            intended_branch: 'main',
            upstream: 'origin/main',
            ahead: 2,
            behind: 3,
            dirty_count: 1,
            status_short: ' M app/ops/page.tsx',
            severity: 'red',
            code: 'dirty',
            message: 'kapelle-site has 1 uncommitted change(s)',
            remediation: 'Commit or stash the listed changes, then rebuild and restart /ops from clean origin/main.',
          },
          locks: [],
          actions: ['Commit or stash the listed changes, then rebuild and restart /ops from clean origin/main.'],
        },
      }],
      coupling: {
        coordinated_redeploy_pending: false,
        coherent: true,
        target_sha: '2222222',
        running_shas: ['1111111'],
        lagging_nodes: ['kapelle-site'],
        unknown_nodes: [],
        reason: 'test fixture',
      },
    };

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(typeof body.nominal).toBe('boolean');
    expect(Array.isArray(body.nominal_reasons)).toBe(true);
    expect(body.build).toBeTruthy();
    // The SHA the running binary was built from must be present (this is the
    // exact field the operator needs to see on /health).
    expect(typeof body.build.build_sha === 'string' || body.build.build_sha === null).toBe(true);
    if (body.build.build_sha !== null) {
      expect(body.build.build_sha).toMatch(/^[0-9a-f]{7,40}$/);
    }
    // Staleness surface: all four comparison fields exist.
    expect(body.build).toHaveProperty('build_time');
    expect(body.build).toHaveProperty('local_main_sha');
    expect(body.build).toHaveProperty('origin_main_sha');
    expect(body.build).toHaveProperty('behind_origin');
    expect(body.build).toHaveProperty('source_branch_sha');
    expect(body.build).toHaveProperty('source_branch_name');
    expect(body.build.freshness).toMatchObject({
      running_manager_build_sha: body.build.build_sha,
      promoted_main_sha: body.build.origin_main_sha,
      behind_promoted_main: body.build.behind_origin,
    });
    expect(['build_stamp', 'runtime_fallback', 'unknown']).toContain(body.build.source);

    expect(body.disk).toMatchObject({
      schema_version: 'disk-headroom.v1',
      path: expect.any(String),
      state: expect.stringMatching(/^(ok|warn|critical|unknown)$/),
      min_free_bytes: expect.any(Number),
      warn_free_bytes: expect.any(Number),
    });
    expect(typeof body.disk.free_bytes === 'number' || body.disk.free_bytes === null).toBe(true);
    expect(typeof body.disk.available_bytes === 'number' || body.disk.available_bytes === null).toBe(true);
    expect(typeof body.disk.available_gib === 'number' || body.disk.available_gib === null).toBe(true);

    expect(body.supervisor).toMatchObject({
      schema_version: 'supervisor-freshness.v1',
      enabled: expect.any(Boolean),
      running: expect.any(Boolean),
      state: expect.stringMatching(/^(disabled|stopped|starting|fresh|stale|error)$/),
      required_for_nominal: expect.any(Boolean),
      nominal_mode: expect.stringMatching(/^(required|optional)$/),
      poll_interval_seconds: expect.any(Number),
      stale_after_seconds: expect.any(Number),
      last_tick_started_at: null,
      last_success_at: null,
      last_error_at: null,
      last_error: null,
      open_alert_count: expect.any(Number),
    });

    expect(body.worktree_os_policy.deploy_checkout_dependency).toMatchObject({
      state: 'satisfied',
      health: 'green',
      required_repair: 'none',
    });

    expect(body).toHaveProperty('orchestration_runtime_status');
    expect(body.orchestration_runtime_status === null || typeof body.orchestration_runtime_status === 'object').toBe(true);

    expect(body.fleet_freshness.nodes[0]).toMatchObject({
      node_id: 'kapelle-site',
      build_sha: '1111111',
      origin_main_sha: '2222222',
      behind_origin: true,
      release_state: {
        repo_dir: '/srv/kapelle-site',
        checkout: {
          branch: 'feature/local-ops',
          intended_branch: 'main',
          upstream: 'origin/main',
          ahead: 2,
          behind: 3,
          dirty_count: 1,
          code: 'dirty',
        },
      },
    });
  });
});
