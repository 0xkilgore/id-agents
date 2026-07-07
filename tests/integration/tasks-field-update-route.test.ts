// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const TEAM = 'tasks-field-update-test';

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

async function postTask(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ task: { name: string } }>;
}

async function patchTask(baseUrl: string, name: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks/${name}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

describe('PATCH /tasks/:ref field updates', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-field-update-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    await db.teams.getOrCreateTeamId(TEAM);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM task_note_events`);
    await db.adapter.query(`DELETE FROM tasks`);
    await db.adapter.query(`DELETE FROM agents`);
    fs.rmSync(path.join(workDir, 'taskview'), { recursive: true, force: true });
    fs.mkdirSync(path.join(workDir, 'taskview'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'taskview', 'to-do.md'),
      [
        '# Taskview To-Do',
        '',
        '- [ ] Legacy taskview open item',
        '- [x] Legacy taskview done item done:2026-07-01',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  it('updates priority, due, and note through the manager task route', async () => {
    const created = await postTask(baseUrl, {
      title: 'Review manager edit flow !low due:2026-07-10',
      description: 'Existing detail',
    });

    const updated = await patchTask(baseUrl, created.task.name, {
      priority: 'high',
      due: '2026-07-12',
      note: 'Chris asked for this to move up.',
    });

    expect(updated.status).toBe(200);
    expect(updated.json.ok).toBe(true);
    expect(updated.json.task.priority).toBe('high');
    expect(updated.json.task.due_iso).toBe('2026-07-12');
    expect(updated.json.task.description).toContain('Existing detail');
    expect(updated.json.task.description).toContain('Chris asked for this to move up.');

    const single = await fetch(`${baseUrl}/tasks/${created.task.name}`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(single.task.priority).toBe('high');
    expect(single.task.due_iso).toBe('2026-07-12');

    const list = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const row = list.tasks.find((task: { name: string }) => task.name === created.task.name);
    expect(row.priority).toBe('high');
    expect(row.due_iso).toBe('2026-07-12');

    const entries = await fetch(`${baseUrl}/tasks/entries`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const entry = entries.items.find((item: { display_id: string }) => item.display_id === created.task.name);
    expect(entry.priority).toBe('high');
    expect(entry.due_iso).toBe('2026-07-12');
  });

  it('clears priority and due tokens', async () => {
    const created = await postTask(baseUrl, {
      title: 'Clear manager fields !high due:2026-07-12',
    });

    const updated = await patchTask(baseUrl, created.task.name, {
      priority: '',
      due: '',
    });

    expect(updated.status).toBe(200);
    expect(updated.json.task.priority).toBeNull();
    expect(updated.json.task.due_iso).toBeNull();
    expect(updated.json.task.title).toBe('Clear manager fields');
  });

  it('rejects invalid field values without mutating the task', async () => {
    const created = await postTask(baseUrl, { title: 'Keep unchanged !med' });
    const invalid = await patchTask(baseUrl, created.task.name, { priority: 'urgent' });

    expect(invalid.status).toBe(400);
    const single = await fetch(`${baseUrl}/tasks/${created.task.name}`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(single.task.priority).toBe('med');
  });

  it('surfaces task-note triage as a separate console lane, not inbox digest', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId,
      id: 'agent-personal',
      name: 'personal',
      type: 'claude',
      model: 'test',
      status: 'running',
      created_at: Date.now(),
      runtime: 'codex',
    });
    const created = await postTask(baseUrl, {
      title: 'Personal term-life follow-up',
      description: 'Personal agent should refire research on term-life policy options.',
    });

    const response = await fetch(`${baseUrl}/tasks/triage/review`, {
      headers: { 'X-Id-Team': TEAM },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.lane).toBe('task_triage');
    expect(json.inbox_digest).toBe('excluded');
    expect(json.review.source.inbox_digest).toBe('excluded');
    expect(json.review.summary.auto_route_candidates).toBe(1);
    expect(json.review.summary.console_lane_items).toBe(0);
    expect(json.parity.taskview).toMatchObject({
      available: true,
      total: 2,
      open: 1,
      done: 1,
    });
    expect(json.parity.manager_tasks).toMatchObject({
      total: 1,
      open: 1,
      done: 0,
    });
    expect(json.parity.dispatch_reconciliation.stuck_queued).toBe(0);
    expect(json.parity.divergence_explanations).toContain(
      'Manager done task count differs from taskview by -1; completed task migration/backfill is not one-to-one.',
    );
    expect(json.review.items[0]).toMatchObject({
      task_ref: created.task.name,
      classification: 'route_to_project_agent',
      target_agent: 'personal',
      deterministic_safe: true,
      source_surface: 'manager_task_description',
    });
    expect(json.items).toEqual([]);
  });

  it('appends durable task notes with visible routing state and read-model counts', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId,
      id: 'agent-personal',
      name: 'personal',
      type: 'claude',
      model: 'test',
      status: 'running',
      created_at: Date.now(),
      runtime: 'codex',
    });
    const created = await postTask(baseUrl, {
      title: 'Personal term-life follow-up',
    });

    const append = await fetch(`${baseUrl}/task-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        task_ref: created.task.name,
        actor_ref: 'user:chris',
        note_body: 'Personal agent should refire this and check for duplicate policy tasks.',
        source_surface: 'ops/tasks',
      }),
    });
    const appended = await append.json();

    expect(append.status).toBe(201);
    expect(appended.ok).toBe(true);
    expect(appended.task_note.task_name).toBe(created.task.name);
    expect(appended.task_note.routing_status).toBe('routed');
    expect(appended.task_note.target_agent).toBe('personal');
    expect(appended.route).toMatchObject({
      status: 'routed',
      target_agent: 'personal',
    });
    expect(appended.route.dispatch_phid).toMatch(/^phid:disp-/);

    const duplicate = await fetch(`${baseUrl}/task-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        task_ref: created.task.name,
        actor_ref: 'user:chris',
        note_body: 'Duplicate of the older policy-review task; superseded by the newer row.',
        source_surface: 'ops/tasks',
      }),
    }).then((r) => r.json());
    expect(duplicate.task_note.routing_status).toBe('queued');

    const events = await fetch(`${baseUrl}/events?topics=task:note`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(events.events).toHaveLength(2);
    expect(events.events[0].data).toMatchObject({
      note_id: appended.task_note.note_id,
      routing_status: 'routed',
      target_agent: 'personal',
    });

    const notes = await fetch(`${baseUrl}/task-notes?status=routed`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(notes.count).toBe(1);

    const tasks = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const row = tasks.tasks.find((task: { name: string }) => task.name === created.task.name);
    expect(row.task_note_count).toBe(2);
    expect(row.reconciliation_count).toBe(2);
    expect(tasks.reconciliation).toMatchObject({
      task_note_count: 2,
      duplicate_count: 1,
    });

    const entries = await fetch(`${baseUrl}/tasks/entries`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const entry = entries.items.find((item: { display_id: string }) => item.display_id === created.task.name);
    expect(entry.task_note_count).toBe(2);
    expect(entry.reconciliation_count).toBe(2);
  });

  it('runs task-note triage on demand and writes a dated operator review artifact', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId,
      id: 'agent-personal',
      name: 'personal',
      type: 'claude',
      model: 'test',
      status: 'running',
      created_at: Date.now(),
      runtime: 'codex',
    });
    await postTask(baseUrl, {
      title: 'Personal term-life follow-up',
      description: [
        'Personal agent should refire research on term-life policy options.',
        'Ask Chris whether to keep the stale carrier list.',
        'Stale note: leave unresolved until Chris confirms next action.',
      ].join('\n'),
    });

    const response = await fetch(`${baseUrl}/tasks/triage/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        auto_route: true,
        mode: 'on_demand',
        idempotency_key: 'test-task-triage-on-demand',
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.run).toMatchObject({
      mode: 'on_demand',
      idempotency_key: 'test-task-triage-on-demand',
      idempotency: 'date_artifact_overwrite_plus_dispatch_dedup_key',
    });
    expect(json.parity.taskview.available).toBe(true);
    expect(json.parity.deltas.manager_open_minus_taskview_open).toBe(0);
    expect(json.routed[0]).toMatchObject({
      target_agent: 'personal',
      ok: true,
    });
    expect(json.routed[0].dispatch_phid).toMatch(/^phid:disp-/);
    expect(json.routed[0].query_id).toMatch(/^query_/);
    expect(json.routed[0].dedup_key).toContain('task-triage:');

    const artifact = fs.readFileSync(json.artifact_path, 'utf8');
    expect(path.dirname(json.artifact_path)).toBe(path.join(workDir, 'output'));
    expect(path.basename(json.artifact_path)).toMatch(/^\d{4}-\d{2}-\d{2}-task-triage-review\.md$/);
    expect(artifact).toContain('## Deterministic routed notes');
    expect(artifact).toContain('## Source parity');
    expect(artifact).toContain('## Stale task escalations');
    expect(artifact).toContain('## Approval / review');
    expect(artifact).toContain('## Stale unresolved rows');
    expect(artifact).toContain('## Idempotency / dedup');
    expect(artifact).toContain('- taskview_available: true');
    expect(artifact).toContain('- dispatch_stuck_queued: 0');
    expect(artifact).toContain('test-task-triage-on-demand');
    expect(artifact).toContain('task-triage:');
    expect(artifact).toContain('- status: routed');
    expect(artifact).toContain('- next_action: Show in task triage lane for Chris decision');
  });
});
