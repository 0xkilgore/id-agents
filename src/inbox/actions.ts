// Inbox 2.0 — operator ACTIONS wired to real backends.
//
// The inbox triage/route/mark-read buttons must DO something durable, not just
// echo "queued". These ops mirror the CoS email-intake wiring (inbox-email/
// intake.ts) for the manual, operator-initiated path:
//
//   triage  -> creates a real TASK   (tasks repo) + inbox_links 'task'
//   route   -> creates a real DISPATCH (dispatch-scheduler) + inbox_links 'dispatch'
//   mark-read -> persists read_at server-side (survives reload)
//
// Backends are injected (no fixture fallback): if a dependency is absent the op
// throws a typed error and the route returns 501, rather than silently no-op'ing.

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db/db-adapter.js';
import type { TasksRepository } from '../db/db-service.js';
import type { EnqueueInputV2, EnqueueResult } from '../dispatch-scheduler/manager-integration.js';
import { buildTaskRow, draftFromManagerApi } from '../tasks-readmodel/task-draft.js';
import {
  getInboxItem, updateOperatorState, appendAuditEvent, upsertLink,
  markInboxItemRead,
} from './storage.js';

export type EnqueueDispatchFn = (
  input: EnqueueInputV2,
  opts?: { wake?: boolean },
) => Promise<EnqueueResult>;

export interface InboxActionDeps {
  tasks?: TasksRepository;
  enqueueDispatch?: EnqueueDispatchFn;
}

const DEFAULT_ACTOR = 'human:chris';

async function requireItem(adapter: DbAdapter, phid: string) {
  const item = await getInboxItem(adapter, phid);
  if (!item) throw new InboxActionError(`Item not found: ${phid}`, 404);
  return item;
}

export class InboxActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InboxActionError';
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function taskNameExists(adapter: DbAdapter, teamId: string, name: string): Promise<boolean> {
  const { rows } = await adapter.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM tasks WHERE team_id = $1 AND name = $2',
    [teamId, name],
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

async function uniqueTaskName(adapter: DbAdapter, teamId: string | null, title: string): Promise<string> {
  const base = slugify(title).slice(0, 72) || 'inbox-task';
  if (!teamId) return base;
  let candidate = base;
  let suffix = 1;
  while (await taskNameExists(adapter, teamId, candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

// ── triage -> task ────────────────────────────────────────────────────

export interface TriageToTaskInput {
  inbox_phid: string;
  team_id: string | null;
  actor_id?: string;
  ts?: string;
  title?: string;
  description?: string | null;
  owner?: string | null;
  track?: string | null;
}

export interface TriageToTaskResult {
  action: 'task';
  task_name: string;
  task_id: string;
}

export async function triageInboxToTask(
  adapter: DbAdapter,
  deps: InboxActionDeps,
  input: TriageToTaskInput,
): Promise<TriageToTaskResult> {
  const item = await requireItem(adapter, input.inbox_phid);
  if (!deps.tasks) {
    throw new InboxActionError('Tasks backend not wired (no tasks repository)', 501);
  }

  const ts = input.ts ?? new Date().toISOString();
  const actor = input.actor_id ?? DEFAULT_ACTOR;
  const title = (input.title ?? item.source_subject ?? item.source_text ?? input.inbox_phid).slice(0, 120);
  const name = await uniqueTaskName(adapter, input.team_id, title);

  const task = buildTaskRow(draftFromManagerApi({
    name,
    team_id: input.team_id,
    title,
    description: input.description ?? item.source_text ?? null,
    created_by: null,
    owner: input.owner ?? null,
    track: input.track ?? item.project_hint ?? '(unassigned)',
  }));
  await deps.tasks.create(task);
  await upsertLink(adapter, input.inbox_phid, 'task', task.name);

  // Triaged into a task; advance out of 'new'. Preserve terminal states.
  if (item.operator_state === 'new') {
    await updateOperatorState(adapter, input.inbox_phid, 'needs_route', { triaged_at: ts });
  }

  await appendAuditEvent(adapter, {
    inbox_phid: input.inbox_phid,
    op_id: `triage-${randomUUID().slice(0, 8)}`,
    op_type: 'TRIAGE_TO_TASK',
    actor_id: actor,
    ts,
    reason: null,
    summary: `Triaged to task ${task.name}`,
    input_revision: null,
    links_json: JSON.stringify([{ kind: 'task', target: task.name }]),
  });

  return { action: 'task', task_name: task.name, task_id: task.id };
}

// ── route -> dispatch ─────────────────────────────────────────────────

export interface RouteToDispatchInput {
  inbox_phid: string;
  to_agent: string;
  team_id?: string | null;
  actor_id?: string;
  ts?: string;
  message?: string;
  subject?: string;
  reason?: string;
}

export interface RouteToDispatchResult {
  action: 'dispatch';
  dispatch_phid: string;
  query_id: string;
}

export async function routeInboxToDispatch(
  adapter: DbAdapter,
  deps: InboxActionDeps,
  input: RouteToDispatchInput,
): Promise<RouteToDispatchResult> {
  const item = await requireItem(adapter, input.inbox_phid);
  if (!deps.enqueueDispatch) {
    throw new InboxActionError('Dispatch backend not wired (no enqueueDispatch)', 501);
  }
  if (!input.to_agent?.trim()) {
    throw new InboxActionError('route requires a target agent (to_agent)', 400);
  }

  const ts = input.ts ?? new Date().toISOString();
  const actor = input.actor_id ?? DEFAULT_ACTOR;
  const subject = input.subject ?? item.source_subject ?? undefined;
  const message = input.message ?? item.source_text ?? item.source_excerpt ?? `Inbox item ${input.inbox_phid}`;

  const enq = await deps.enqueueDispatch({
    team_id: input.team_id ?? undefined,
    to_agent: input.to_agent,
    from_actor: actor,
    channel: 'inbox',
    subject,
    message,
    dedup_key: `inbox-route:${input.inbox_phid}:${input.to_agent}`,
    actor_ref: { kind: 'user', id: actor, label: 'Inbox operator', source: 'inbox' },
    causation: { source_event_id: input.inbox_phid },
  }, { wake: true });

  await upsertLink(adapter, input.inbox_phid, 'dispatch', enq.dispatch_phid);
  await updateOperatorState(adapter, input.inbox_phid, 'waiting_on_agent', {
    agent_hint: input.to_agent,
    triaged_at: item.triaged_at ?? ts,
  });

  await appendAuditEvent(adapter, {
    inbox_phid: input.inbox_phid,
    op_id: `route-${randomUUID().slice(0, 8)}`,
    op_type: 'ROUTE_TO_DISPATCH',
    actor_id: actor,
    ts,
    reason: input.reason ?? null,
    summary: `Routed to ${input.to_agent} (dispatch ${enq.dispatch_phid})`,
    input_revision: null,
    links_json: JSON.stringify([{ kind: 'dispatch', target: enq.dispatch_phid }]),
  });

  return { action: 'dispatch', dispatch_phid: enq.dispatch_phid, query_id: enq.query_id };
}

// ── mark-read ─────────────────────────────────────────────────────────

export interface MarkReadInput {
  inbox_phid: string;
  actor_id?: string;
  ts?: string;
}

export interface MarkReadResult {
  action: 'mark_read';
  read_at: string | null;
  already_read: boolean;
}

export async function markInboxRead(
  adapter: DbAdapter,
  input: MarkReadInput,
): Promise<MarkReadResult> {
  await requireItem(adapter, input.inbox_phid);
  const ts = input.ts ?? new Date().toISOString();
  const actor = input.actor_id ?? DEFAULT_ACTOR;

  const { read_at, already_read } = await markInboxItemRead(adapter, input.inbox_phid, ts);

  // Audit only on the first read (state-changing); re-marks are idempotent no-ops.
  if (!already_read) {
    await appendAuditEvent(adapter, {
      inbox_phid: input.inbox_phid,
      op_id: `markread-${randomUUID().slice(0, 8)}`,
      op_type: 'MARK_READ',
      actor_id: actor,
      ts,
      reason: null,
      summary: `Marked read at ${read_at}`,
      input_revision: null,
      links_json: null,
    });
  }

  return { action: 'mark_read', read_at, already_read };
}
