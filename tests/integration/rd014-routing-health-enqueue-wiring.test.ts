// SPDX-License-Identifier: MIT
/**
 * RD-014 (3rd attempt, Fable critique confirmed 07-04/07-05/07-06): the
 * enqueue-time admission gate (providersConstrainedByRoutingHealth, folded in
 * via SchedulerHandle.currentRoutingHealthConstrainedProviders) was correct
 * and unit-tested, but `setRoutingHealthSource` had ZERO production callers
 * across two prior build attempts — only its definition and two DIRECT test
 * call sites (model-policy-enqueue.test.ts) existed. A stalled/unhealthy
 * Codex lane was silently admitted work at enqueue in production.
 *
 * This test does NOT call setRoutingHealthSource directly (that was already
 * covered, and is exactly what the prior two attempts stopped short at). It
 * boots the REAL AgentManagerDb (the same start() path production runs),
 * stubs the underlying Codex fallback probe as down, fires a real unpinned
 * POST /dispatch/enqueue, and asserts the created dispatch actually resolved
 * to the fallback runtime -- proving the wiring from manager boot through to
 * dispatch-scheduler enqueue, not just that the seam compiles.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'node:crypto';

// Mocked BEFORE importing AgentManagerDb so the manager's own import of
// checkCodexFallbackHealth resolves to this mock. Cursor is left real
// (cheap with live:false, no subprocess smoke call) -- only Codex liveness
// is under test here.
const checkCodexFallbackHealthMock = vi.fn();
vi.mock('../../src/harness/codex-fallback-health.js', () => ({
  checkCodexFallbackHealth: (...args: unknown[]) => checkCodexFallbackHealthMock(...args),
}));

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

const TEAM = 'rd014-routing-health-wiring-test';
// Dedicated agent name so this test's model-policy override (added to a
// temp copy of configs/model-policy.json, restored after) never touches the
// real default/cto/maestra/sentinel/rams entries.
const TEST_AGENT = 'rd014-wiring-test-agent';
const MODEL_POLICY_PATH = path.join(process.cwd(), 'configs', 'model-policy.json');

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

async function insertAgentDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, endpoint, 'active', Date.now(), 'claude-code-cli'],
  );
  return id;
}

describe('RD-014 (3rd attempt): setRoutingHealthSource wired into production enqueue', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let originalModelPolicyJson: string;

  async function enqueue(toAgent: string): Promise<{ ok: boolean; dispatch_phid: string; query_id: string }> {
    const res = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      // Deliberately NO `runtime` field -- an unpinned enqueue, exactly what
      // the acceptance criteria requires. Pinning would bypass the model
      // policy entirely and prove nothing about this wiring.
      body: JSON.stringify({ from_actor: 'cane', to_agent: toAgent, message: 'hi' }),
    });
    return res.json() as Promise<{ ok: boolean; dispatch_phid: string; query_id: string }>;
  }

  async function resolvedRuntimeOf(phid: string): Promise<{ runtime: string; provider: string } | null> {
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(phid);
    return doc ? { runtime: doc.runtime, provider: doc.provider } : null;
  }

  beforeAll(async () => {
    // Add a dedicated codex-primary/claude-fallback entry to a temp copy of
    // the REAL model-policy.json the manager's boot code reads (hardcoded
    // path, no test-injection seam) -- additive only, every existing entry
    // (default/cto/maestra/sentinel/rams) is left byte-for-byte untouched,
    // and the original file is restored verbatim in afterAll.
    originalModelPolicyJson = fs.readFileSync(MODEL_POLICY_PATH, 'utf8');
    const policy = JSON.parse(originalModelPolicyJson);
    policy.agents[TEST_AGENT] = {
      primary: { runtime: 'codex', model: 'gpt-5.5' },
      fallback: [{ runtime: 'claude-code-cli', model: 'claude-opus-4-8' }],
    };
    fs.writeFileSync(MODEL_POLICY_PATH, JSON.stringify(policy, null, 2));

    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd014-routing-health-wiring-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    // Default mock return so the manager's OWN 60s freshness/drift-guard
    // tick (unrelated to this test) doesn't hit an undefined `.status` at
    // boot before the first `it()` configures a specific mock value.
    checkCodexFallbackHealthMock.mockResolvedValue({
      status: 'live',
      binary: '/fake/codex',
      version: '1.2.3',
      checked_at: Date.now(),
      live_checked: true,
      reason: null,
      detail: 'default boot-time mock',
    });
    await manager.start(port);

    const defaultTeamId = await db.teams.getOrCreateTeamId('default');
    await insertAgentDirect(db, defaultTeamId, TEST_AGENT, 'http://127.0.0.1:19999');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    fs.writeFileSync(MODEL_POLICY_PATH, originalModelPolicyJson);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(async () => {
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
    checkCodexFallbackHealthMock.mockReset();
  });

  it('a stalled/unavailable Codex lane is routed around at REAL enqueue (not just observed)', async () => {
    checkCodexFallbackHealthMock.mockResolvedValue({
      status: 'unavailable',
      binary: '/fake/codex',
      version: null,
      checked_at: Date.now(),
      live_checked: true,
      reason: 'cert_revoked',
      detail: 'stubbed down for RD-014 wiring test',
    });

    // The short-TTL cache (5s) is fresh per test process boot and this is
    // the first call after the mock is set, so no stale cached model can
    // mask the down status.
    const enq = await enqueue(TEST_AGENT);
    expect(enq.ok).toBe(true);

    const resolved = await resolvedRuntimeOf(enq.dispatch_phid);
    expect(resolved).not.toBeNull();
    // Primary (codex/openai) is reported down by the REAL production wiring
    // -> Codex Light-style policy falls back to claude/anthropic. Before
    // this fix, setRoutingHealthSource had no production caller, so this
    // would have resolved to codex/openai regardless (the finding this
    // dispatch is closing out).
    expect(resolved!.runtime).toBe('claude-code-cli');
    expect(resolved!.provider).toBe('anthropic');

    expect(checkCodexFallbackHealthMock).toHaveBeenCalled();
  });

  it('control: a HEALTHY Codex lane resolves to primary (codex) -- proves this reads LIVE health, not a hardcoded fallback', async () => {
    // The prior test's "down" result is cached for cachedRoutingHealthModel's
    // 5s TTL (production behavior, tested deliberately here rather than
    // worked around) -- wait it out so THIS test's fresh mock is what the
    // real cache actually re-probes, not a stale cached verdict.
    await new Promise((resolve) => setTimeout(resolve, 5200));

    checkCodexFallbackHealthMock.mockResolvedValue({
      status: 'live',
      binary: '/fake/codex',
      version: '1.2.3',
      checked_at: Date.now(),
      live_checked: true,
      reason: null,
      detail: 'stubbed healthy for RD-014 wiring test',
    });

    const enq = await enqueue(TEST_AGENT);
    const resolved = await resolvedRuntimeOf(enq.dispatch_phid);
    expect(resolved!.runtime).toBe('codex');
    expect(resolved!.provider).toBe('openai');
  });
});
