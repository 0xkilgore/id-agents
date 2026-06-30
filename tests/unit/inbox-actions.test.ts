// Inbox 2.0 — contract tests for the operator ACTIONS wired to real backends:
// triage -> task, route -> dispatch, mark-read persists. Exercises both the ops
// and the HTTP routes (wired + unwired/501).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateInboxTables, upsertInboxItem, getInboxItem, getLinks, getAuditEvents,
} from '../../src/inbox/storage.js';
import {
  triageInboxToTask, routeInboxToDispatch, markInboxRead, InboxActionError,
} from '../../src/inbox/actions.js';
import { mountInboxRoutes } from '../../src/inbox/routes.js';
import type { InboxItemRow } from '../../src/inbox/types.js';
import type { TaskRow } from '../../src/db/types.js';
import type { TasksRepository } from '../../src/db/db-service.js';
import type { EnqueueInputV2, EnqueueResult } from '../../src/dispatch-scheduler/manager-integration.js';

class TestTasksRepo implements TasksRepository {
  created: TaskRow[] = [];
  constructor(private readonly adapter: SqliteAdapter) {}
  async create(task: TaskRow): Promise<void> {
    this.created.push(task);
    await this.adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [task.id, task.name, task.uuid, task.team_id, task.title, task.description, task.status,
       task.created_by, task.owner, task.created_at, task.updated_at, task.completed_at, task.track],
    );
  }
  async getByName(): Promise<TaskRow | null> { return null; }
  async getByNameForTeam(): Promise<TaskRow | null> { return null; }
  async getByUuidPrefix(): Promise<TaskRow[]> { return []; }
  async list(): Promise<TaskRow[]> { return this.created; }
  async updateFields(): Promise<void> {}
  async claim(): Promise<boolean> { return false; }
  async delete(): Promise<void> {}
  async replaceEventLinks(): Promise<void> {}
  async listEventLinksForTask(): Promise<Array<{ schedule_id: string }>> { return []; }
}

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateInboxTables(adapter);
  adapter.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, uuid TEXT, team_id TEXT,
      title TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
      created_by TEXT, owner TEXT, created_at INTEGER, updated_at INTEGER,
      completed_at INTEGER, track TEXT
    )`);
  return adapter;
}

function makeItem(phid: string, overrides: Partial<InboxItemRow> = {}): InboxItemRow {
  const now = '2026-06-29T12:00:00.000Z';
  return {
    inbox_phid: phid, operator_state: 'new', source_kind: 'telegram',
    source_external_id: null, source_text: 'Set up parents whatsapp', source_excerpt: null,
    source_subject: null, source_from: null, classification_label: null,
    classification_confidence: null, classification_classifier: null, classification_rationale: null,
    project_hint: 'cleveland-park', agent_hint: null, origin_ref: null, received_at: now,
    triaged_at: null, resolved_at: null, snoozed_until: null, checked_off_at: null,
    checked_off_reason: null, source: 'index', parity_status: 'ok', generated_at: now,
    projection_version: 1, legacy_inbox_md_line: null, legacy_shadow_path: null, ...overrides,
  };
}

function stubEnqueue() {
  return vi.fn(async (_input: EnqueueInputV2): Promise<EnqueueResult> => ({
    query_id: 'query-inbox-1', dispatch_phid: 'phid:disp-inbox-1', status: 'queued',
  }));
}

describe('Inbox actions — ops', () => {
  let adapter: SqliteAdapter;
  let tasks: TestTasksRepo;
  beforeEach(async () => {
    adapter = makeAdapter();
    tasks = new TestTasksRepo(adapter);
    await upsertInboxItem(adapter, makeItem('itm-1'));
  });

  it('triage -> creates a real task, links it, advances state, audits', async () => {
    const r = await triageInboxToTask(adapter, { tasks }, {
      inbox_phid: 'itm-1', team_id: 'team-default', title: 'Set up parents whatsapp',
      ts: '2026-06-29T12:05:00.000Z',
    });
    expect(r.action).toBe('task');
    expect(tasks.created).toHaveLength(1);
    expect(tasks.created[0].team_id).toBe('team-default');
    expect(tasks.created[0].track).toBe('cleveland-park'); // from project_hint
    const item = (await getInboxItem(adapter, 'itm-1'))!;
    expect(item.operator_state).toBe('needs_route');
    expect(item.triaged_at).toBe('2026-06-29T12:05:00.000Z');
    const links = await getLinks(adapter, 'itm-1');
    expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task', target: r.task_name })]));
    const audit = await getAuditEvents(adapter, 'itm-1');
    expect(audit.some((e) => e.op_type === 'TRIAGE_TO_TASK')).toBe(true);
  });

  it('triage throws 501 when tasks backend is not wired', async () => {
    await expect(triageInboxToTask(adapter, {}, { inbox_phid: 'itm-1', team_id: 't' }))
      .rejects.toMatchObject({ status: 501 });
  });

  it('triage throws 404 for an unknown item', async () => {
    await expect(triageInboxToTask(adapter, { tasks }, { inbox_phid: 'nope', team_id: 't' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('route -> creates a real dispatch, links it, sets waiting_on_agent, audits', async () => {
    const enqueueDispatch = stubEnqueue();
    const r = await routeInboxToDispatch(adapter, { enqueueDispatch }, {
      inbox_phid: 'itm-1', to_agent: 'roger', team_id: 'team-default',
      ts: '2026-06-29T12:06:00.000Z',
    });
    expect(r.action).toBe('dispatch');
    expect(r.dispatch_phid).toBe('phid:disp-inbox-1');
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
    const arg = enqueueDispatch.mock.calls[0][0];
    expect(arg.to_agent).toBe('roger');
    expect(arg.team_id).toBe('team-default');
    expect(arg.dedup_key).toBe('inbox-route:itm-1:roger');
    expect(arg.causation?.source_event_id).toBe('itm-1');
    const item = (await getInboxItem(adapter, 'itm-1'))!;
    expect(item.operator_state).toBe('waiting_on_agent');
    expect(item.agent_hint).toBe('roger');
    const links = await getLinks(adapter, 'itm-1');
    expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'dispatch', target: 'phid:disp-inbox-1' })]));
    const audit = await getAuditEvents(adapter, 'itm-1');
    expect(audit.some((e) => e.op_type === 'ROUTE_TO_DISPATCH')).toBe(true);
  });

  it('route throws 501 when dispatch backend is not wired', async () => {
    await expect(routeInboxToDispatch(adapter, {}, { inbox_phid: 'itm-1', to_agent: 'roger' }))
      .rejects.toMatchObject({ status: 501 });
  });

  it('route throws 400 without a target agent', async () => {
    await expect(routeInboxToDispatch(adapter, { enqueueDispatch: stubEnqueue() }, { inbox_phid: 'itm-1', to_agent: '' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('mark-read persists read_at, survives re-read, and is idempotent', async () => {
    const r1 = await markInboxRead(adapter, { inbox_phid: 'itm-1', ts: '2026-06-29T12:07:00.000Z' });
    expect(r1.read_at).toBe('2026-06-29T12:07:00.000Z');
    expect(r1.already_read).toBe(false);
    // Survives reload (fresh SELECT).
    const item = (await getInboxItem(adapter, 'itm-1'))!;
    expect(item.read_at).toBe('2026-06-29T12:07:00.000Z');
    // Idempotent: second mark keeps the first timestamp, reports already_read.
    const r2 = await markInboxRead(adapter, { inbox_phid: 'itm-1', ts: '2026-06-29T13:00:00.000Z' });
    expect(r2.read_at).toBe('2026-06-29T12:07:00.000Z');
    expect(r2.already_read).toBe(true);
    const audit = await getAuditEvents(adapter, 'itm-1');
    expect(audit.filter((e) => e.op_type === 'MARK_READ').length).toBe(1); // audited once
  });
});

describe('Inbox actions — HTTP routes', () => {
  let adapter: SqliteAdapter;
  let tasks: TestTasksRepo;
  let enqueueDispatch: ReturnType<typeof stubEnqueue>;
  let server: Server;
  let base: string;

  async function boot(deps: Parameters<typeof mountInboxRoutes>[2]) {
    const app = express();
    app.use(express.json());
    mountInboxRoutes(app, adapter, deps);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    adapter = makeAdapter();
    tasks = new TestTasksRepo(adapter);
    enqueueDispatch = stubEnqueue();
    await upsertInboxItem(adapter, makeItem('itm-1'));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await adapter.close();
  });

  it('POST /inbox/items/:phid/triage creates a task', async () => {
    await boot({ tasks, resolveTeamId: async () => 'team-default' });
    const res = await fetch(`${base}/inbox/items/itm-1/triage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Parents whatsapp' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe('task');
    expect(tasks.created).toHaveLength(1);
  });

  it('POST /inbox/items/:phid/route creates a dispatch', async () => {
    await boot({ enqueueDispatch, resolveTeamId: async () => 'team-default' });
    const res = await fetch(`${base}/inbox/items/itm-1/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_agent: 'roger' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatch_phid).toBe('phid:disp-inbox-1');
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
  });

  it('POST /inbox/items/:phid/mark-read persists', async () => {
    await boot({});
    const res = await fetch(`${base}/inbox/items/itm-1/mark-read`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.read_at).toBe('string');
    const item = (await getInboxItem(adapter, 'itm-1'))!;
    expect(item.read_at).toBe(body.read_at);
  });

  it('returns 501 when the tasks backend is not wired', async () => {
    await boot({}); // no tasks dep
    const res = await fetch(`${base}/inbox/items/itm-1/triage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(501);
  });

  it('returns 404 for an unknown item', async () => {
    await boot({ tasks, resolveTeamId: async () => 'team-default' });
    const res = await fetch(`${base}/inbox/items/nope/triage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
