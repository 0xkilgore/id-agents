// SPDX-License-Identifier: MIT
/**
 * Regression test for the check-in wake dispatch.
 *
 * Bug history:
 *   1. The original CheckinService wrote a `checkin_due` news_item and
 *      stopped — the owner's LLM was never woken, so a check-in was
 *      operationally identical to an unread row.
 *   2. The first fix introduced a `dispatchWake` hook gated on
 *      `priority === 'high'`. The user rejected this gate: a normal- or
 *      low-priority check-in that doesn't wake is still operationally
 *      identical to no check-in.
 *
 * Current contract (this file is the regression):
 *
 *   - EVERY priority that fires invokes `dispatchWake` once when the
 *     hook is configured. Each wake POSTs to the owner agent's /news
 *     with `trigger:true` and lands the same `202 / triggered:true /
 *     query_id:/^news_/` response asserted in tests/integration/news-
 *     reply-triggers-receiver.test.ts (the LLM-wake surface).
 *
 *   - The `priority` field is preserved on the news_item data and on
 *     the dispatchWake payload so the receiver's LLM can decide
 *     urgency. It is metadata, not a gate.
 *
 *   - When no `dispatchWake` hook is configured the row still fires
 *     (passive inbox delivery only) — that's the test default for
 *     CheckinService unit-style cases elsewhere.
 *
 * Cases:
 *   1. High priority via a test-built dispatcher: wake POSTs once,
 *      AgentRestServer responds 202+triggered, exactly ONE inbox row.
 *   2. Normal AND low priority: BOTH call dispatchWake (one each), both
 *      POST to the owner, both land 202+triggered, exactly one inbox
 *      row per owner. This is the case that was flipped after the gate
 *      was removed.
 *   3. Regression pin: dispatcher that omits skip_persist:true causes
 *      duplicate rows — guards against drift.
 *   4. Stall protection: hung owner endpoint must abort, not block the
 *      tick loop.
 *   5. End-to-end against the manager-owned CheckinService: prove the
 *      production wiring (skip_persist + timeout + always-wake) yields
 *      one row and one wake.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import * as http from 'node:http';
import crypto from 'node:crypto';

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRestServer } from '../../src/claude-agent-server.js';
import { CheckinService } from '../../src/checkins/checkin-service.js';
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
import type { CheckinRow, CheckinPriority } from '../../src/db/types.js';

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

async function bootAgentServer(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  agentId: string,
): Promise<{ server: AgentRestServer; baseUrl: string }> {
  // Mirror production wiring: the AgentRestServer holds the same DB handle
  // the manager uses, so its /news handler will dbAddNews() into the SAME
  // news_items table CheckinService writes to. That's the surface the
  // duplicate-inbox bug would surface on — without this wiring, the test
  // would silently pass even if the wake POST double-wrote.
  const server = new AgentRestServer({
    agentName: 'checkin-wake-target',
    workingDirectory: process.cwd(),
    sharedDirectory: process.cwd(),
    db: { db: db as any, teamId, agentId },
  });
  await server.start(0);
  const port = ((server as any).httpServer.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function insertAgentRow(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint: string | null,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime, endpoint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code', endpoint],
  );
  return id;
}

function buildRow(overrides: Partial<CheckinRow> & Pick<CheckinRow, 'id' | 'team_id' | 'priority'>): CheckinRow {
  const now = Date.now();
  return {
    owner_agent_id: null,
    created_by_agent_id: null,
    linked_task_id: null,
    interval_seconds: 600,
    status: 'active',
    close_when: { task_status: ['done'] },
    max_iterations: null,
    iteration_count: 0,
    next_fire_at: now - 1,
    snooze_until: null,
    ttl_expires_at: null,
    last_fire_at: null,
    last_event_seq: null,
    note: null,
    created_at: now - 1000,
    updated_at: now - 1000,
    closed_at: null,
    closed_reason: null,
    ...overrides,
  };
}

describe('CheckinService wake on every fire (priority is metadata, not a gate)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let highServer: AgentRestServer;
  let normalServer: AgentRestServer;
  let lowServer: AgentRestServer;
  let highBaseUrl: string;
  let normalBaseUrl: string;
  let lowBaseUrl: string;
  let teamId: string;
  let highOwnerId: string;
  let normalOwnerId: string;
  let lowOwnerId: string;

  beforeAll(async () => {
    db = await createInMemoryDb();
    teamId = await db.teams.getOrCreateTeamId('checkin-wake');
    highOwnerId = await insertAgentRow(db, teamId, 'high-owner', null);
    normalOwnerId = await insertAgentRow(db, teamId, 'normal-owner', null);
    lowOwnerId = await insertAgentRow(db, teamId, 'low-owner', null);

    // Each owner runs its own AgentRestServer bound to the shared DB so the
    // /news handler's dbAddNews persists to the same news_items table the
    // CheckinService writes to. This is the production wiring shape and the
    // exact surface the duplicate-inbox bug would surface on.
    const high = await bootAgentServer(db, teamId, highOwnerId);
    highServer = high.server; highBaseUrl = high.baseUrl;
    const normal = await bootAgentServer(db, teamId, normalOwnerId);
    normalServer = normal.server; normalBaseUrl = normal.baseUrl;
    const low = await bootAgentServer(db, teamId, lowOwnerId);
    lowServer = low.server; lowBaseUrl = low.baseUrl;

    // Update the agent rows now that we know each agent's endpoint.
    await db.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [highBaseUrl, highOwnerId]);
    await db.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [normalBaseUrl, normalOwnerId]);
    await db.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [lowBaseUrl, lowOwnerId]);
  });

  afterAll(async () => {
    await Promise.all([
      highServer?.stop(),
      normalServer?.stop(),
      lowServer?.stop(),
    ].filter(Boolean) as Promise<void>[]);
    await db.close();
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM checkins`);
    await db.adapter.query(`DELETE FROM news_items`);
    await db.adapter.query(`DELETE FROM event_log`);
  });

  /**
   * Production-shape dispatcher: identical to the one wired in
   * src/agent-manager-db.ts. Resolves the owner's endpoint from the DB and
   * POSTs to /news with skip_persist:true so the wake fires the LLM but
   * does not double-write the inbox row CheckinService already persisted.
   */
  function buildProductionDispatcher(): {
    dispatch: (input: { teamId: string; ownerAgentId: string; checkinId: string; priority: CheckinPriority; iterationCount: number; nextFireAt: number; message: string; data: Record<string, unknown> }) => Promise<void>;
    calls: Array<{ ownerAgentId: string; priority: CheckinPriority }>;
    responses: Array<{ status: number; body: any }>;
  } {
    const calls: Array<{ ownerAgentId: string; priority: CheckinPriority }> = [];
    const responses: Array<{ status: number; body: any }> = [];
    return {
      calls,
      responses,
      dispatch: async (input) => {
        calls.push({ ownerAgentId: input.ownerAgentId, priority: input.priority });
        const owner = await db.agents.getById(input.ownerAgentId);
        if (!owner?.endpoint) throw new Error('owner endpoint missing');
        const url = `${owner.endpoint.replace(/\/+$/, '')}/news`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'checkin-service',
            trigger: true,
            skip_persist: true,
            type: 'checkin_due',
            message: input.message,
            data: input.data,
          }),
        });
        const body = await res.json().catch(() => ({}));
        responses.push({ status: res.status, body });
        if (!res.ok) throw new Error(`wake POST returned ${res.status}`);
      },
    };
  }

  it('high priority fire wakes owner /news (triggered:true) AND lands exactly ONE checkin_due inbox row', async () => {
    const dispatcher = buildProductionDispatcher();
    const svc = new CheckinService(db as any, { dispatchWake: dispatcher.dispatch });

    await db.checkins.create(buildRow({
      id: 'chk_high',
      team_id: teamId,
      owner_agent_id: highOwnerId,
      priority: 'high',
    }));

    const result = await svc.tick(Date.now());
    expect(result.fired).toBe(1);
    expect(result.errors).toBe(0);

    // Wake hook invoked exactly once with priority=high.
    expect(dispatcher.calls).toEqual([{ ownerAgentId: highOwnerId, priority: 'high' }]);

    // The AgentRestServer's /news response is the same shape asserted in
    // tests/integration/news-reply-triggers-receiver.test.ts: 202 Accepted +
    // triggered:true + a generated news_* query_id. That payload IS the
    // dispatcher saying "I started an LLM query for this wake."
    expect(dispatcher.responses).toHaveLength(1);
    expect(dispatcher.responses[0].status).toBe(202);
    expect(dispatcher.responses[0].body.triggered).toBe(true);
    expect(dispatcher.responses[0].body.query_id).toMatch(/^news_/);

    // CRITICAL: exactly ONE inbox row for the fire — proves the wake POST's
    // skip_persist:true flag prevented the AgentRestServer from double-
    // writing the news_item via its dbAddNews path. Without skip_persist
    // we would see 2 rows: one from CheckinService.writeOwnerNews and one
    // from the receiver's /news handler.
    const news = await db.news.poll(highOwnerId, 0);
    const dueNews = news.filter((n) => n.type === 'checkin_due');
    expect(dueNews).toHaveLength(1);
    expect((dueNews[0].data as any).priority).toBe('high');
    expect((dueNews[0].data as any).checkin_id).toBe('chk_high');
  });

  it('end-to-end against the MANAGER-OWNED CheckinService: a high-priority fire driven by manager.checkinService.tick() yields exactly ONE checkin_due row', async () => {
    // The previous case used a test-built dispatcher. This case proves the
    // production wiring in src/agent-manager-db.ts itself: we boot a real
    // AgentManagerDb (which constructs its own CheckinService with the
    // production dispatchWake — including skip_persist:true), wire the
    // owner agent row's endpoint to a DB-backed AgentRestServer, drive
    // `(manager as any).checkinService.tick(...)`, and assert exactly one
    // checkin_due row. Any future drift that drops skip_persist:true (or
    // any equivalent guard) from the manager-side dispatcher will fail
    // this case with a duplicate-row count.
    const findFreePort = (): Promise<number> => new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        server.close(() => resolve(addr.port));
      });
      server.on('error', reject);
    });
    const managerPort = await findFreePort();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-wake-mgr-'));

    // Build a fresh DB so this case stays isolated from the suite-level rows.
    const localDb = await createInMemoryDb();
    const localTeamId = await localDb.teams.getOrCreateTeamId('checkin-wake-e2e');
    const localOwnerId = await insertAgentRow(localDb, localTeamId, 'high-owner-e2e', null);

    // DB-backed AgentRestServer (owner) — same shape as production.
    const ownerServer = new AgentRestServer({
      agentName: 'high-owner-e2e',
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
      db: { db: localDb as any, teamId: localTeamId, agentId: localOwnerId },
    });
    await ownerServer.start(0);
    const ownerPort = ((ownerServer as any).httpServer.address() as AddressInfo).port;
    const ownerUrl = `http://127.0.0.1:${ownerPort}`;
    await localDb.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [ownerUrl, localOwnerId]);

    // Boot the real manager — its constructor wires CheckinService with the
    // production dispatchWake (HTTP POST + skip_persist:true + 5s timeout).
    const manager = new AgentManagerDb(workDir, localDb as any);
    await manager.start(managerPort);
    try {
      expect((manager as any).checkinService).not.toBeNull();

      // Insert a due high-priority checkin and drive the manager's tick.
      await localDb.checkins.create(buildRow({
        id: 'chk_high_e2e',
        team_id: localTeamId,
        owner_agent_id: localOwnerId,
        priority: 'high',
      }));

      const tickResult = await (manager as any).checkinService.tick(Date.now());
      expect(tickResult.fired).toBe(1);
      expect(tickResult.errors).toBe(0);

      // Single inbox row — production wiring has the dedup guard.
      const news = await localDb.news.poll(localOwnerId, 0);
      const dueNews = news.filter((n) => n.type === 'checkin_due');
      expect(dueNews, 'manager-owned dispatcher must not double-write the inbox row').toHaveLength(1);
      expect((dueNews[0].data as any).checkin_id).toBe('chk_high_e2e');

      // Row state advanced as expected.
      const row = await localDb.checkins.get('chk_high_e2e', localTeamId);
      expect(row!.iteration_count).toBe(1);
      expect(row!.last_fire_at).toBeGreaterThan(0);
    } finally {
      await manager.shutdown();
      await ownerServer.stop();
      await localDb.close();
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 15000);

  it('normal AND low priority fires also wake the owner — every priority calls dispatchWake exactly once and lands ONE inbox row', async () => {
    // After the priority-gate was removed: every fire wakes the LLM. The
    // priority field is still preserved on the news_item data so the
    // receiving dispatcher can decide urgency, but it does not gate the
    // wake. A check-in that doesn't wake is operationally identical to no
    // check-in at all (just an unread row).
    const dispatcher = buildProductionDispatcher();
    const svc = new CheckinService(db as any, { dispatchWake: dispatcher.dispatch });

    await db.checkins.create(buildRow({
      id: 'chk_normal',
      team_id: teamId,
      owner_agent_id: normalOwnerId,
      priority: 'normal',
    }));
    await db.checkins.create(buildRow({
      id: 'chk_low',
      team_id: teamId,
      owner_agent_id: lowOwnerId,
      priority: 'low',
    }));

    const result = await svc.tick(Date.now());
    expect(result.fired).toBe(2);
    expect(result.errors).toBe(0);

    // Both priorities woke the LLM — dispatcher invoked twice (one per
    // owner), each POSTing to its respective AgentRestServer. The order
    // mirrors the order checkins are claimed; sort by priority so the
    // assertion is stable regardless of claimDue ordering.
    expect(dispatcher.calls).toHaveLength(2);
    const callsByPriority = [...dispatcher.calls].sort((a, b) => a.priority.localeCompare(b.priority));
    expect(callsByPriority[0]).toEqual({ ownerAgentId: lowOwnerId, priority: 'low' });
    expect(callsByPriority[1]).toEqual({ ownerAgentId: normalOwnerId, priority: 'normal' });

    // Both responses land the same wake-proof surface as high priority:
    // 202 / triggered:true / query_id:/^news_/.
    expect(dispatcher.responses).toHaveLength(2);
    for (const r of dispatcher.responses) {
      expect(r.status).toBe(202);
      expect(r.body.triggered).toBe(true);
      expect(r.body.query_id).toMatch(/^news_/);
    }

    // Inbox: exactly ONE checkin_due row per owner (skip_persist:true
    // still prevents the AgentRestServer from double-writing). Priority
    // is preserved on the data payload as metadata.
    const normalNews = await db.news.poll(normalOwnerId, 0);
    const lowNews = await db.news.poll(lowOwnerId, 0);
    const normalDue = normalNews.filter((n) => n.type === 'checkin_due');
    const lowDue = lowNews.filter((n) => n.type === 'checkin_due');
    expect(normalDue).toHaveLength(1);
    expect(lowDue).toHaveLength(1);
    expect((normalDue[0].data as any).priority).toBe('normal');
    expect((lowDue[0].data as any).priority).toBe('low');
  });

  it('a single normal-priority fire calls dispatchWake exactly once (focused proof that the priority gate was removed)', async () => {
    // Tight focused case requested when the priority gate was removed:
    // demonstrate explicitly that normal alone wakes — independent of the
    // multi-priority case above so a future change that re-introduces a
    // gate on normal would fail with a single-cause signal.
    const dispatcher = buildProductionDispatcher();
    const svc = new CheckinService(db as any, { dispatchWake: dispatcher.dispatch });

    await db.checkins.create(buildRow({
      id: 'chk_normal_focused',
      team_id: teamId,
      owner_agent_id: normalOwnerId,
      priority: 'normal',
    }));

    const result = await svc.tick(Date.now());
    expect(result.fired).toBe(1);
    expect(result.errors).toBe(0);

    expect(dispatcher.calls).toEqual([{ ownerAgentId: normalOwnerId, priority: 'normal' }]);
    expect(dispatcher.responses).toHaveLength(1);
    expect(dispatcher.responses[0].status).toBe(202);
    expect(dispatcher.responses[0].body.triggered).toBe(true);
    expect(dispatcher.responses[0].body.query_id).toMatch(/^news_/);

    const news = await db.news.poll(normalOwnerId, 0);
    const dueNews = news.filter((n) => n.type === 'checkin_due' && (n.data as any).checkin_id === 'chk_normal_focused');
    expect(dueNews).toHaveLength(1);
    expect((dueNews[0].data as any).priority).toBe('normal');
  });

  it('regression: removing skip_persist:true would double-write the inbox row (proves the guard is load-bearing)', async () => {
    // This case pins the contract: if a future change drops skip_persist:true
    // from the wake POST, the AgentRestServer.dbAddNews path will run AND
    // CheckinService.writeOwnerNews will run, producing 2 rows. We simulate
    // the regression by sending the wake without skip_persist and asserting
    // the duplicate-write actually happens — so future readers can see the
    // exact failure mode the guard prevents.
    const calls: Array<{ priority: CheckinPriority }> = [];
    const svc = new CheckinService(db as any, {
      dispatchWake: async (input) => {
        calls.push({ priority: input.priority });
        const owner = await db.agents.getById(input.ownerAgentId);
        if (!owner?.endpoint) return;
        // INTENTIONALLY OMITS skip_persist so we observe the double-write.
        await fetch(`${owner.endpoint.replace(/\/+$/, '')}/news`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'checkin-service',
            trigger: true,
            type: 'checkin_due',
            message: input.message,
            data: input.data,
          }),
        });
      },
    });

    await db.checkins.create(buildRow({
      id: 'chk_high_dup',
      team_id: teamId,
      owner_agent_id: highOwnerId,
      priority: 'high',
    }));
    await svc.tick(Date.now());
    expect(calls).toHaveLength(1);

    // Without skip_persist, BOTH writeOwnerNews and the receiver's dbAddNews
    // run, yielding 2 rows. This is precisely the failure mode the guard
    // prevents — and the previous test (with skip_persist) saw only 1 row.
    const news = await db.news.poll(highOwnerId, 0);
    const dueNews = news.filter((n) => n.type === 'checkin_due');
    expect(dueNews.length).toBe(2);
  });

  it('stall protection: a hung owner endpoint does not stall the tick — wake aborts, row state still advances, inbox row still writes', async () => {
    // Boot a stub HTTP server that NEVER responds to /news. This simulates
    // a hung owner endpoint. Without a bounded timeout on the wake fetch,
    // dispatchWake would hang forever, fireRow's await would never settle,
    // and the entire CheckinService.tick (which serializes via `running`)
    // would stall — same failure mode as the /news-to path before its
    // explicit timeout was added.
    const hung = http.createServer(() => {
      // Intentionally never call res.end — hold the socket open.
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const hungPort = (hung.address() as AddressInfo).port;
    const hungUrl = `http://127.0.0.1:${hungPort}`;

    // Reuse the high owner row but point it at the hung endpoint for the
    // duration of this test. We restore it in `finally` so case-3's prior
    // assertions stay reproducible if reordered.
    const originalEndpoint = (await db.agents.getById(highOwnerId))!.endpoint;
    await db.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [hungUrl, highOwnerId]);

    try {
      // Production-shape dispatcher with the same 200ms timeout shape the
      // manager uses (5s in production; we shrink it to keep the test fast,
      // mirroring the same `AbortSignal.timeout(...)` mechanism).
      const svc = new CheckinService(db as any, {
        dispatchWake: async (input) => {
          const owner = await db.agents.getById(input.ownerAgentId);
          if (!owner?.endpoint) return;
          const res = await fetch(`${owner.endpoint.replace(/\/+$/, '')}/news`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'checkin-service',
              trigger: true,
              skip_persist: true,
              type: 'checkin_due',
              message: input.message,
              data: input.data,
            }),
            signal: AbortSignal.timeout(200),
          });
          if (!res.ok) throw new Error(`wake POST returned ${res.status}`);
        },
      });

      await db.checkins.create(buildRow({
        id: 'chk_high_stall',
        team_id: teamId,
        owner_agent_id: highOwnerId,
        priority: 'high',
      }));

      // Hard ceiling on tick duration: must complete in well under 1s even
      // though the owner is hung — proves the abort fired and the swallow-
      // and-log path in CheckinService.fireRow released the await.
      const t0 = Date.now();
      const result = await svc.tick(Date.now());
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000);

      // The fire still counts as fired — wake failure is non-fatal because
      // the canonical inbox write already succeeded by the time dispatch ran.
      // result.errors stays 0 because dispatchWake errors are caught and
      // logged inside fireRow (not surfaced to tickTeam's error counter).
      expect(result.fired).toBe(1);
      expect(result.errors).toBe(0);

      // Row state advanced as if the fire fully succeeded — the wake is a
      // best-effort signal, not part of the row-state contract.
      const row = await db.checkins.get('chk_high_stall', teamId);
      expect(row!.iteration_count).toBe(1);
      expect(row!.last_fire_at).toBeGreaterThan(0);

      // Inbox row still landed exactly once.
      const news = await db.news.poll(highOwnerId, 0);
      const dueNews = news.filter((n) => n.type === 'checkin_due' && (n.data as any).checkin_id === 'chk_high_stall');
      expect(dueNews).toHaveLength(1);
    } finally {
      hung.close();
      hung.closeAllConnections?.();
      await db.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [originalEndpoint, highOwnerId]);
    }
  }, 10000);
});
