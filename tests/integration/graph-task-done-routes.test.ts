// N1.4 Integration — POST /tasks/:ref/done auto-releases a downstream
// graph node via the fire-and-forget task lifecycle bridge.
//
// Spec: /Users/kilgore/Dropbox/Code/cto/output/2026-05-31-n1-4-task-done-bridge-spec.md

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'node:crypto';

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
import {
  createGraph,
  addNode,
  addEdge,
  updateGraphStatus,
  getNode,
} from '../../src/graph/storage.js';

const TEAM = 'n1-4-task-done-bridge-test';

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
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

async function insertAgentDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

async function insertTaskDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  ownerId: string | null,
): Promise<{ id: string; uuid: string; name: string }> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, 'doing', ownerId, now, now],
  );
  return { id, uuid, name };
}

// dispatch_scheduler_queue is created by `migrateSqlite(...)` with the
// real production schema. We just insert rows so the graph runner can
// resolve downstream dispatch_id lookups.
async function insertDispatchDirect(
  adapter: SqliteAdapter,
  teamId: string,
  phid: string,
  status: string,
): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
       dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
       body_markdown, provider, runtime, status, not_before_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      phid,
      teamId,
      `query_${phid}`,
      'agent',
      'test',
      'test',
      'test dispatch',
      'test body',
      'anthropic',
      'claude-code-cli',
      status,
      now,
      now,
    ],
  );
}

// Best-effort bridge runs asynchronously after the HTTP response.
// Poll the downstream node state with a short timeout.
async function pollNodeState(
  adapter: SqliteAdapter,
  nodeId: string,
  expected: string,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const node = await getNode(adapter, nodeId);
    last = node?.state ?? '';
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

describe('POST /tasks/:ref/done — task-done graph bridge (N1.4)', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let ownerAgentId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1-4-task-bridge-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    ownerAgentId = await insertAgentDirect(db, teamId, 'coder');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM tasks`);
    (db.adapter as any).exec(`DELETE FROM dispatch_graph_decision`);
    (db.adapter as any).exec(`DELETE FROM dispatch_graph_edge`);
    (db.adapter as any).exec(`DELETE FROM dispatch_graph_node`);
    (db.adapter as any).exec(`DELETE FROM dispatch_graph`);
    (db.adapter as any).exec(`DELETE FROM dispatch_scheduler_queue`);
  });

  it('auto-releases a downstream dispatch node when the upstream task completes', async () => {
    const task = await insertTaskDirect(db, teamId, 'auto-release', ownerAgentId);
    await insertDispatchDirect(db.adapter, teamId, 'phid:downstream-auto', 'queued');

    // Build a graph: task node -> downstream dispatch node (task_done edge).
    const graph = await createGraph(db.adapter, 'task-gates-dispatch', { kind: 'test' });
    await updateGraphStatus(db.adapter, graph.graph_id, 'active');
    const taskNode = await addNode(db.adapter, graph.graph_id, 'upstream task', 'task', {
      task_phid: task.id,
      state: 'pending_dependencies',
    });
    const downstream = await addNode(db.adapter, graph.graph_id, 'downstream', 'dispatch', {
      dispatch_id: 'phid:downstream-auto',
      state: 'pending_dependencies',
    });
    await addEdge(db.adapter, graph.graph_id, taskNode.node_id, downstream.node_id,
      'waits_on', { type: 'task_done', task_phid: task.id });

    // Confirm downstream starts blocked (no manual evaluate).
    expect((await getNode(db.adapter, downstream.node_id))!.state).toBe('pending_dependencies');

    // Complete the task via the HTTP route.
    const res = await fetch(`${baseUrl}/tasks/${task.name}/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    // The bridge is fire-and-forget — poll briefly for the release.
    const finalState = await pollNodeState(db.adapter, downstream.node_id, 'queued', 3000);
    expect(finalState).toBe('queued');

    // The task node itself should have been projected to `done`.
    const taskNodeAfter = await getNode(db.adapter, taskNode.node_id);
    expect(taskNodeAfter!.state).toBe('done');
  });

  it('keeps downstream blocked when the upstream task is still doing (no completion event)', async () => {
    const task = await insertTaskDirect(db, teamId, 'still-doing', ownerAgentId);
    await insertDispatchDirect(db.adapter, teamId, 'phid:downstream-still', 'queued');

    const graph = await createGraph(db.adapter, 'still-doing', { kind: 'test' });
    await updateGraphStatus(db.adapter, graph.graph_id, 'active');
    const taskNode = await addNode(db.adapter, graph.graph_id, 'task', 'task', {
      task_phid: task.id,
      state: 'pending_dependencies',
    });
    const downstream = await addNode(db.adapter, graph.graph_id, 'down', 'dispatch', {
      dispatch_id: 'phid:downstream-still',
      state: 'pending_dependencies',
    });
    await addEdge(db.adapter, graph.graph_id, taskNode.node_id, downstream.node_id,
      'waits_on', { type: 'task_done', task_phid: task.id });

    // Wait a brief moment to give any spurious bridge call time to run.
    await new Promise((r) => setTimeout(r, 200));
    expect((await getNode(db.adapter, downstream.node_id))!.state).toBe('pending_dependencies');
  });

  it('a graph with no node linked to the completed task is a no-op', async () => {
    const task = await insertTaskDirect(db, teamId, 'unlinked', ownerAgentId);
    await insertDispatchDirect(db.adapter, teamId, 'phid:noop', 'queued');

    // Graph references a different task — must not be touched.
    const graph = await createGraph(db.adapter, 'unrelated', { kind: 'test' });
    await updateGraphStatus(db.adapter, graph.graph_id, 'active');
    const otherTask = await insertTaskDirect(db, teamId, 'other-task', ownerAgentId);
    const taskNode = await addNode(db.adapter, graph.graph_id, 'other', 'task', {
      task_phid: otherTask.id,
      state: 'pending_dependencies',
    });
    const downstream = await addNode(db.adapter, graph.graph_id, 'down', 'dispatch', {
      dispatch_id: 'phid:noop',
      state: 'pending_dependencies',
    });
    await addEdge(db.adapter, graph.graph_id, taskNode.node_id, downstream.node_id,
      'waits_on', { type: 'task_done', task_phid: otherTask.id });

    const res = await fetch(`${baseUrl}/tasks/${task.name}/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    // Brief wait + assert downstream still blocked.
    await new Promise((r) => setTimeout(r, 300));
    expect((await getNode(db.adapter, downstream.node_id))!.state).toBe('pending_dependencies');
  });

  it('duplicate task completion does not duplicate transitions (idempotent)', async () => {
    const task = await insertTaskDirect(db, teamId, 'idem-task', ownerAgentId);
    await insertDispatchDirect(db.adapter, teamId, 'phid:downstream-idem', 'queued');

    const graph = await createGraph(db.adapter, 'idem', { kind: 'test' });
    await updateGraphStatus(db.adapter, graph.graph_id, 'active');
    const taskNode = await addNode(db.adapter, graph.graph_id, 'task', 'task', {
      task_phid: task.id,
      state: 'pending_dependencies',
    });
    const downstream = await addNode(db.adapter, graph.graph_id, 'down', 'dispatch', {
      dispatch_id: 'phid:downstream-idem',
      state: 'pending_dependencies',
    });
    await addEdge(db.adapter, graph.graph_id, taskNode.node_id, downstream.node_id,
      'waits_on', { type: 'task_done', task_phid: task.id });

    // First completion releases downstream.
    const r1 = await fetch(`${baseUrl}/tasks/${task.name}/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(r1.status).toBe(200);

    const released = await pollNodeState(db.adapter, downstream.node_id, 'queued', 3000);
    expect(released).toBe('queued');

    // Snapshot decision count before second call.
    const beforeCount = await db.adapter.query<{ c: number }>(
      'SELECT COUNT(*) as c FROM dispatch_graph_decision WHERE graph_id = $1',
      [graph.graph_id],
    );
    const before = beforeCount.rows[0].c;

    // Second POST — task is already done. Status here is up to the route's
    // resolveTaskRef behavior; what matters for N1.4 is that the bridge
    // does not duplicate transitions.
    await fetch(`${baseUrl}/tasks/${task.name}/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    await new Promise((r) => setTimeout(r, 300));

    const afterCount = await db.adapter.query<{ c: number }>(
      'SELECT COUNT(*) as c FROM dispatch_graph_decision WHERE graph_id = $1',
      [graph.graph_id],
    );
    expect(afterCount.rows[0].c).toBe(before);

    // Downstream stays `queued`, not re-released.
    expect((await getNode(db.adapter, downstream.node_id))!.state).toBe('queued');
  });
});
