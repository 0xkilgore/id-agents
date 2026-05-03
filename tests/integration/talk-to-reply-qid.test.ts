// SPDX-License-Identifier: MIT
/**
 * Regression test for the /talk-to sync-return path.
 *
 * Bug observed in production (query_1777393291327_cjfcyh3, agents → systemreview
 * "favorite color"):
 *   - systemreview replied within 5s, the reply landed in the agents agent's
 *     inbox, but the manager's `/talk-to` curl blocked the full 120s timeout
 *     and returned `status:pending`.
 *   - Two reply rows were written for the single fire (one on agents'
 *     inbox, one on manager-idchain inbox), both with `query_id` NULL.
 *   - The manager's `pendingReplyWaiter` was keyed on query_id and never
 *     matched because the in_reply_to never reached its resolution branch.
 *
 * The fix has three parts and this file pins all three:
 *
 *   1. The agent's POST /news handler now seeds `query_id` from
 *      `in_reply_to` so the receiver's news_items row column is populated
 *      (not just the jsonb data field).
 *
 *   2. `broadcastToManager` now hoists `in_reply_to` to the top level of
 *      the body so the manager's /news handler runs its reply-routing
 *      branch (mark query complete, emit `query:delivered`, and resolve
 *      any waiting /talk-to caller). It also sets `skip_persist:true` so
 *      the manager-inbox insert is skipped — the originating agent's
 *      /news already persisted the canonical row.
 *
 *   3. The manager's POST /news handler honors `skip_persist:true`:
 *      it skips the news_items insert under the manager-inbox identity
 *      while still running waiter resolution + queries.complete +
 *      emitQueryDelivered.
 *
 * Cases:
 *   1. Direct /news reply at receiver: the row carries `query_id` =
 *      in_reply_to (column populated, not just data).
 *   2. Manager `/news` honors `skip_persist:true`: no manager-inbox row,
 *      but queryWaiter resolves and queries.complete runs.
 *   3. End-to-end: posting a reply to agent_a's /news triggers the
 *      broadcast, the manager-side waiter resolves with the reply
 *      content, and exactly ONE reply row exists in news_items
 *      (on agent_a's inbox, not on manager-inbox).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'node:crypto';

import { AgentRestServer } from '../../src/claude-agent-server.js';
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

const TEAM = 'talkto-qid-test';

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
      const addr = server.address() as AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
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

describe('/talk-to reply: query_id populated, no duplicate, manager waiter resolves', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let teamId: string;
  let agentAId: string;
  let agentAServer: AgentRestServer;
  let agentABaseUrl: string;
  let manager: AgentManagerDb;
  let managerPort: number;
  let workDir: string;
  const savedManagerUrl = process.env.MANAGER_URL;
  const savedTeam = process.env.ID_TEAM;

  beforeAll(async () => {
    db = await createInMemoryDb();
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    agentAId = await insertAgentRow(db, teamId, 'agent_a', null);

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkto-qid-test-'));
    managerPort = await findFreePort();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(managerPort);

    // Point broadcastToManager at our test manager. ID_TEAM is required so
    // the broadcast carries the X-Id-Team header the manager's /news uses.
    process.env.MANAGER_URL = `http://127.0.0.1:${managerPort}`;
    process.env.ID_TEAM = TEAM;

    agentAServer = new AgentRestServer({
      agentName: 'agent_a',
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
      db: { db: db as any, teamId, agentId: agentAId },
    });
    await agentAServer.start(0);
    const port = ((agentAServer as any).httpServer.address() as AddressInfo).port;
    agentABaseUrl = `http://127.0.0.1:${port}`;
    await db.adapter.query(`UPDATE agents SET endpoint = ? WHERE id = ?`, [agentABaseUrl, agentAId]);
  }, 30000);

  afterAll(async () => {
    if (agentAServer) await agentAServer.stop();
    if (manager) await manager.shutdown();
    await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (savedManagerUrl === undefined) delete process.env.MANAGER_URL; else process.env.MANAGER_URL = savedManagerUrl;
    if (savedTeam === undefined) delete process.env.ID_TEAM; else process.env.ID_TEAM = savedTeam;
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM news_items`);
    await db.adapter.query(`DELETE FROM queries`);
    (manager as any).queryWaiters.clear();
  });

  it('agent /news handler populates query_id from in_reply_to on the receiver inbox row', async () => {
    const qid = `qid_${crypto.randomUUID()}`;

    // Simulate sendReplyToSender: agent B POSTs reply to agent A's /news.
    const res = await fetch(`${agentABaseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reply',
        from: 'agent_b',
        in_reply_to: qid,
        message: 'yellow',
      }),
    });
    expect(res.status).toBe(202); // trigger:true (replies default to trigger)

    // Inspect the actual news_items row written under agent_a's inbox.
    const { rows } = await db.adapter.query(
      `SELECT id, type, query_id, data, owner_kind, owner_id FROM news_items WHERE team_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 5`,
      [teamId, agentAId],
    ) as any;
    const replies = rows.filter((r: any) => r.type === 'reply');
    expect(replies.length).toBe(1); // single row, no double-write on receiver side
    expect(replies[0].query_id).toBe(qid); // column populated, not NULL
    const data = typeof replies[0].data === 'string' ? JSON.parse(replies[0].data) : replies[0].data;
    expect(data.in_reply_to).toBe(qid);
    expect(data.from).toBe('agent_b');
    // Dual-write window: agent-inbox rows must also populate the new
    // ownership columns alongside the legacy agent_id. owner_kind='agent'
    // and owner_id=<agent_a id>.
    expect(replies[0].owner_kind).toBe('agent');
    expect(replies[0].owner_id).toBe(agentAId);
  });

  it('manager /news honors skip_persist:true: no manager-inbox row but queryWaiter resolves and queries.complete runs', async () => {
    const qid = `qid_${crypto.randomUUID()}`;
    // Pre-create the query row so queries.complete has something to mark.
    await db.queries.create(teamId, qid, agentAId, 'what color?', Date.now() - 1000);

    // Pre-register a queryWaiter on the manager (mirrors what /talk-to does).
    let resolved: { from: string; message: string } | null = null;
    (manager as any).queryWaiters.set(qid, {
      resolve: (r: any) => { resolved = r; },
      reject: () => {},
      timeout: null,
    });

    // POST a reply to the manager's /news with skip_persist:true.
    const res = await fetch(`http://127.0.0.1:${managerPort}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        type: 'reply',
        from: 'agent_b',
        in_reply_to: qid,
        message: 'yellow',
        skip_persist: true,
      }),
    });
    expect([200, 201]).toContain(res.status); // manager /news returns 201 on success

    // Waiter resolved with the reply content.
    expect(resolved).not.toBeNull();
    expect((resolved as any).from).toBe('agent_b');
    expect((resolved as any).message).toBe('yellow');

    // Query row marked completed.
    const q = await db.queries.getByQueryIdForTeam(teamId, qid);
    expect(q).not.toBeNull();
    expect(q!.status).toBe('completed');

    // No manager-inbox row was written (skip_persist honored).
    const { rows } = await db.adapter.query(
      `SELECT COUNT(*) AS cnt FROM news_items WHERE team_id = ? AND type = 'reply'`,
      [teamId],
    ) as any;
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it('end-to-end: agent_a /news reply broadcasts to manager, manager waiter resolves, exactly ONE reply row in news_items', async () => {
    const qid = `qid_${crypto.randomUUID()}`;
    await db.queries.create(teamId, qid, agentAId, 'what color?', Date.now() - 1000);

    let resolved: { from: string; message: string } | null = null;
    (manager as any).queryWaiters.set(qid, {
      resolve: (r: any) => { resolved = r; },
      reject: () => {},
      timeout: null,
    });

    // Agent B's reply arriving at agent_a's /news (the production path
    // sendReplyToSender takes when senderUrl is set on the agents row).
    const res = await fetch(`${agentABaseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reply',
        from: 'agent_b',
        in_reply_to: qid,
        message: 'yellow',
      }),
    });
    expect(res.status).toBe(202);

    // The agent's addNews fires broadcastToManager fire-and-forget. Wait
    // briefly for the manager's /news handler to process it.
    const deadline = Date.now() + 2_000;
    while (resolved === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(resolved, 'manager queryWaiter must resolve from agent broadcast').not.toBeNull();
    expect((resolved as any).from).toBe('agent_b');
    expect((resolved as any).message).toBe('yellow');

    // Query row marked completed by the manager's reply-routing branch.
    const q = await db.queries.getByQueryIdForTeam(teamId, qid);
    expect(q!.status).toBe('completed');

    // Exactly ONE reply row team-wide: under agent_a's inbox, with query_id
    // populated. The manager-inbox got skip_persist:true so it didn't
    // duplicate the row. Dual-write window also requires the new ownership
    // columns alongside the legacy agent_id, so check both.
    const { rows } = await db.adapter.query(
      `SELECT agent_id, query_id, owner_kind, owner_id FROM news_items WHERE team_id = ? AND type = 'reply' ORDER BY id`,
      [teamId],
    ) as any;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(agentAId);
    expect(rows[0].query_id).toBe(qid);
    expect(rows[0].owner_kind).toBe('agent');
    expect(rows[0].owner_id).toBe(agentAId);
  }, 10000);
});
