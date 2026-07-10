// SPDX-License-Identifier: MIT

/**
 * Wakeup-service event producers.
 *
 * Thin wrappers around `db.events.insert(...)` that emit one event_log row
 * per lifecycle transition for tasks and queries. Topics, envelope fields,
 * and payload policy follow output/wakeup-service-design.md.
 *
 * Producers swallow no errors — callers should already be inside the same
 * try/catch that handles the lifecycle write so that an event-log failure
 * surfaces in the same place as the underlying state change.
 */

import type { CheckinsRepository, EventsRepository } from '../db/db-service.js';
import type { CheckinPriority } from '../db/types.js';

export const TASK_CLAIMED = 'task:claimed';
export const TASK_CREATED = 'task:created';
export const TASK_COMPLETED = 'task:completed';
export const DISPATCH_QUEUED = 'dispatch:queued';
export const DISPATCH_IN_FLIGHT = 'dispatch:in_flight';
export const DISPATCH_BOUNCED = 'dispatch:bounced';
export const DISPATCH_FAILED = 'dispatch:failed';
export const DISPATCH_DONE = 'dispatch:done';
export const ARTIFACT_REGISTERED = 'artifact:registered';
export const QUERY_DELIVERED = 'query:delivered';
export const QUERY_FAILED = 'query:failed';
export const QUERY_EXPIRED = 'query:expired';
export const CHECKIN_CREATED = 'checkin:created';
export const CHECKIN_CLOSED = 'checkin:closed';
export const CHECKIN_SNOOZED = 'checkin:snoozed';
export const CHECKIN_DUE = 'checkin:due';
export const CHECKIN_EXPIRED = 'checkin:expired';

const PREVIEW_MAX = 280;

export interface TaskClaimedInput {
  teamId: string;
  taskUuid: string;
  taskName: string;
  title?: string | null;
  ownerAgentId: string;
  occurredAt: number;
}

export interface TaskCreatedInput {
  teamId: string;
  taskUuid: string;
  taskName: string;
  title?: string | null;
  createdByAgentId?: string | null;
  occurredAt: number;
}

export interface TaskCompletedInput {
  teamId: string;
  taskUuid: string;
  taskName: string;
  title?: string | null;
  ownerAgentId: string | null;
  actorAgentId: string | null;
  occurredAt: number;
}

export interface DispatchStatusInput {
  teamId: string;
  dispatchId: string;
  queryId: string;
  toAgent: string;
  fromActor: string;
  subject?: string | null;
  status: string;
  occurredAt: number;
  failureKind?: string | null;
  failureDetail?: string | null;
  artifactPath?: string | null;
}

export interface ArtifactRegisteredInput {
  teamId: string;
  artifactId: string;
  dispatchId?: string | null;
  agent?: string | null;
  title?: string | null;
  absPath?: string | null;
  availability?: string | null;
  inserted: boolean;
  occurredAt: number;
}

export interface QueryDeliveredInput {
  teamId: string;
  queryId: string;
  agentId: string | null;
  occurredAt: number;
  messagePreview?: string | null;
}

export interface QueryFailedInput {
  teamId: string;
  queryId: string;
  agentId: string | null;
  occurredAt: number;
  reason?: string | null;
}

export interface QueryExpiredInput {
  teamId: string;
  queryId: string;
  agentId: string | null;
  occurredAt: number;
}

export async function emitTaskClaimed(
  events: EventsRepository,
  input: TaskClaimedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: TASK_CLAIMED,
    actor_agent_id: input.ownerAgentId,
    subject_kind: 'task',
    subject_id: input.taskUuid,
    occurred_at: input.occurredAt,
    data: {
      task_name: input.taskName,
      task_uuid: input.taskUuid,
      status: 'doing',
      owner: input.ownerAgentId,
      ...(input.title ? { title_preview: truncate(input.title) } : {}),
    },
  });
}

export async function emitTaskCreated(
  events: EventsRepository,
  input: TaskCreatedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: TASK_CREATED,
    actor_agent_id: input.createdByAgentId ?? null,
    subject_kind: 'task',
    subject_id: input.taskUuid,
    occurred_at: input.occurredAt,
    data: {
      task_name: input.taskName,
      task_uuid: input.taskUuid,
      status: 'todo',
      owner: null,
      ...(input.title ? { title_preview: truncate(input.title) } : {}),
    },
  });
}

export async function emitTaskCompleted(
  events: EventsRepository,
  input: TaskCompletedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: TASK_COMPLETED,
    actor_agent_id: input.actorAgentId ?? input.ownerAgentId ?? null,
    subject_kind: 'task',
    subject_id: input.taskUuid,
    occurred_at: input.occurredAt,
    data: {
      task_name: input.taskName,
      task_uuid: input.taskUuid,
      status: 'done',
      owner: input.ownerAgentId,
      completed_at: input.occurredAt,
      ...(input.title ? { title_preview: truncate(input.title) } : {}),
    },
  });
}

export async function emitDispatchStatus(
  events: EventsRepository,
  input: DispatchStatusInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: dispatchTopicForStatus(input.status),
    actor_agent_id: input.toAgent,
    subject_kind: 'dispatch',
    subject_id: input.dispatchId,
    occurred_at: input.occurredAt,
    data: {
      dispatch_id: input.dispatchId,
      query_id: input.queryId,
      to_agent: input.toAgent,
      from_actor: input.fromActor,
      status: input.status,
      ...(input.subject ? { subject_preview: truncate(input.subject) } : {}),
      ...(input.failureKind ? { failure_kind: input.failureKind } : {}),
      ...(input.failureDetail ? { failure_detail_preview: truncate(input.failureDetail) } : {}),
      ...(input.artifactPath ? { artifact_path: input.artifactPath } : {}),
    },
  });
}

export async function emitArtifactRegistered(
  events: EventsRepository,
  input: ArtifactRegisteredInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: ARTIFACT_REGISTERED,
    actor_agent_id: input.agent ?? null,
    subject_kind: 'artifact',
    subject_id: input.artifactId,
    occurred_at: input.occurredAt,
    data: {
      artifact_id: input.artifactId,
      dispatch_id: input.dispatchId ?? null,
      agent: input.agent ?? null,
      inserted: input.inserted,
      ...(input.title ? { title_preview: truncate(input.title) } : {}),
      ...(input.absPath ? { abs_path: input.absPath } : {}),
      ...(input.availability ? { availability: input.availability } : {}),
    },
  });
}

function dispatchTopicForStatus(status: string): string {
  switch (status) {
    case 'queued':
      return DISPATCH_QUEUED;
    case 'in_flight':
      return DISPATCH_IN_FLIGHT;
    case 'bounced':
      return DISPATCH_BOUNCED;
    case 'failed':
      return DISPATCH_FAILED;
    case 'done':
      return DISPATCH_DONE;
    default:
      return `dispatch:${status}`;
  }
}

export async function emitQueryDelivered(
  events: EventsRepository,
  input: QueryDeliveredInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: QUERY_DELIVERED,
    actor_agent_id: input.agentId,
    subject_kind: 'query',
    subject_id: input.queryId,
    occurred_at: input.occurredAt,
    data: {
      query_id: input.queryId,
      status: 'delivered',
      agent: input.agentId,
      completed_at: input.occurredAt,
      ...(input.messagePreview
        ? { message_preview: truncate(input.messagePreview) }
        : {}),
    },
  });
}

export async function emitQueryFailed(
  events: EventsRepository,
  input: QueryFailedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: QUERY_FAILED,
    actor_agent_id: input.agentId,
    subject_kind: 'query',
    subject_id: input.queryId,
    occurred_at: input.occurredAt,
    data: {
      query_id: input.queryId,
      status: 'failed',
      agent: input.agentId,
      completed_at: input.occurredAt,
      ...(input.reason ? { reason_preview: truncate(input.reason) } : {}),
    },
  });
}

export async function emitQueryExpired(
  events: EventsRepository,
  input: QueryExpiredInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: QUERY_EXPIRED,
    actor_agent_id: input.agentId,
    subject_kind: 'query',
    subject_id: input.queryId,
    occurred_at: input.occurredAt,
    data: {
      query_id: input.queryId,
      status: 'expired',
      agent: input.agentId,
      completed_at: input.occurredAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Checkin lifecycle producers (output/checkin-primitive-design.md)
// ---------------------------------------------------------------------------
//
// Each producer appends one event_log row keyed by the checkin id. The
// `record*` companions also persist the assigned `seq` onto the checkin's
// `last_event_seq` column so that downstream readers (and `inspect`) can
// resolve the most recent status-changing event without a topic scan.
//
// `checkin:due` is intentionally not in this module; the dispatcher slice
// owns it and increments `iteration_count` alongside the emit.

export interface CheckinCreatedInput {
  teamId: string;
  checkinId: string;
  ownerAgentId: string | null;
  createdByAgentId: string | null;
  linkedTaskId: string | null;
  priority: CheckinPriority;
  intervalSeconds: number;
  maxIterations: number | null;
  nextFireAt: number | null;
  ttlExpiresAt: number | null;
  occurredAt: number;
}

export interface CheckinClosedInput {
  teamId: string;
  checkinId: string;
  ownerAgentId: string | null;
  linkedTaskId: string | null;
  reason: string;
  actorAgentId?: string | null;
  terminalTopic?: string | null;
  taskStatus?: string | null;
  occurredAt: number;
}

export interface CheckinSnoozedInput {
  teamId: string;
  checkinId: string;
  ownerAgentId: string | null;
  linkedTaskId: string | null;
  actorAgentId?: string | null;
  snoozeUntil: number;
  nextFireAt: number;
  occurredAt: number;
}

export async function emitCheckinCreated(
  events: EventsRepository,
  input: CheckinCreatedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: CHECKIN_CREATED,
    actor_agent_id: input.createdByAgentId ?? input.ownerAgentId ?? null,
    subject_kind: 'checkin',
    subject_id: input.checkinId,
    occurred_at: input.occurredAt,
    data: {
      checkin_id: input.checkinId,
      status: 'active',
      owner: input.ownerAgentId,
      linked_task_id: input.linkedTaskId,
      priority: input.priority,
      interval_seconds: input.intervalSeconds,
      max_iterations: input.maxIterations,
      next_fire_at: input.nextFireAt,
      ttl_expires_at: input.ttlExpiresAt,
      created_at: input.occurredAt,
    },
  });
}

export async function emitCheckinClosed(
  events: EventsRepository,
  input: CheckinClosedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: CHECKIN_CLOSED,
    actor_agent_id: input.actorAgentId ?? input.ownerAgentId ?? null,
    subject_kind: 'checkin',
    subject_id: input.checkinId,
    occurred_at: input.occurredAt,
    data: {
      checkin_id: input.checkinId,
      status: 'closed',
      owner: input.ownerAgentId,
      linked_task_id: input.linkedTaskId,
      reason: input.reason,
      closed_at: input.occurredAt,
      ...(input.terminalTopic ? { terminal_topic: input.terminalTopic } : {}),
      ...(input.taskStatus ? { task_status: input.taskStatus } : {}),
    },
  });
}

export async function emitCheckinSnoozed(
  events: EventsRepository,
  input: CheckinSnoozedInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: CHECKIN_SNOOZED,
    actor_agent_id: input.actorAgentId ?? input.ownerAgentId ?? null,
    subject_kind: 'checkin',
    subject_id: input.checkinId,
    occurred_at: input.occurredAt,
    data: {
      checkin_id: input.checkinId,
      status: 'snoozed',
      owner: input.ownerAgentId,
      linked_task_id: input.linkedTaskId,
      snooze_until: input.snoozeUntil,
      next_fire_at: input.nextFireAt,
    },
  });
}

/**
 * Emit `checkin:created` and stamp the assigned seq onto the checkin row's
 * `last_event_seq`. Use this from the create flow so the row's last-event
 * pointer is consistent with the freshly-emitted event.
 */
export async function recordCheckinCreated(
  events: EventsRepository,
  checkins: CheckinsRepository,
  input: CheckinCreatedInput,
): Promise<{ seq: number }> {
  const result = await emitCheckinCreated(events, input);
  await checkins.updateFields(input.checkinId, input.teamId, {
    last_event_seq: result.seq,
    updated_at: input.occurredAt,
  });
  return result;
}

/**
 * Emit `checkin:closed` and stamp the assigned seq onto the checkin row.
 * Note: the close itself (status / closed_at / cleared cursors) is performed
 * by `CheckinsRepository.close` or `closeForTerminalTask` — this helper only
 * records the audit event and updates `last_event_seq`.
 */
export async function recordCheckinClosed(
  events: EventsRepository,
  checkins: CheckinsRepository,
  input: CheckinClosedInput,
): Promise<{ seq: number }> {
  const result = await emitCheckinClosed(events, input);
  await checkins.updateFields(input.checkinId, input.teamId, {
    last_event_seq: result.seq,
    updated_at: input.occurredAt,
  });
  return result;
}

/**
 * Emit `checkin:snoozed` and stamp the assigned seq onto the checkin row.
 * The snooze state mutation (status/snooze_until/next_fire_at) is the
 * caller's responsibility — typically a single `updateFields` that also
 * carries `last_event_seq` from the returned `seq`.
 */
export async function recordCheckinSnoozed(
  events: EventsRepository,
  checkins: CheckinsRepository,
  input: CheckinSnoozedInput,
): Promise<{ seq: number }> {
  const result = await emitCheckinSnoozed(events, input);
  await checkins.updateFields(input.checkinId, input.teamId, {
    last_event_seq: result.seq,
    updated_at: input.occurredAt,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Dispatcher producers (fire / expire) — used by the checkin due-service tick.
// `record*` companions are intentionally omitted; the dispatcher batches the
// `last_event_seq` update with the rest of the row mutation in a single
// `updateFields` call.
// ---------------------------------------------------------------------------

export interface CheckinDueInput {
  teamId: string;
  checkinId: string;
  ownerAgentId: string | null;
  linkedTaskId: string | null;
  priority: CheckinPriority;
  intervalSeconds: number;
  iterationCount: number;
  maxIterations: number | null;
  nextFireAt: number | null;
  snoozeUntil: number | null;
  ttlExpiresAt: number | null;
  lastFireAt: number | null;
  occurredAt: number;
  /** Compact snapshot of the linked task at fire time, if available. */
  linkedTask?: {
    id: string;
    name: string;
    title: string;
    status: string;
    assignee?: string | null;
  } | null;
  /** Action URLs the consumer can call back into. */
  actions?: Record<string, string>;
}

export interface CheckinExpiredInput {
  teamId: string;
  checkinId: string;
  ownerAgentId: string | null;
  linkedTaskId: string | null;
  reason: 'max_iterations' | 'ttl' | string;
  iterationCount: number;
  maxIterations: number | null;
  ttlExpiresAt: number | null;
  occurredAt: number;
}

export async function emitCheckinDue(
  events: EventsRepository,
  input: CheckinDueInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: CHECKIN_DUE,
    actor_agent_id: 'schedule',
    subject_kind: 'checkin',
    subject_id: input.checkinId,
    occurred_at: input.occurredAt,
    data: {
      checkin_id: input.checkinId,
      owner: input.ownerAgentId,
      linked_task: input.linkedTask ?? (input.linkedTaskId ? { id: input.linkedTaskId } : null),
      priority: input.priority,
      iteration_count: input.iterationCount,
      max_iterations: input.maxIterations,
      interval_seconds: input.intervalSeconds,
      last_fire_at: input.lastFireAt,
      next_fire_at: input.nextFireAt,
      snooze_until: input.snoozeUntil,
      ttl_expires_at: input.ttlExpiresAt,
      ...(input.actions ? { actions: input.actions } : {}),
    },
  });
}

export async function emitCheckinExpired(
  events: EventsRepository,
  input: CheckinExpiredInput,
): Promise<{ seq: number }> {
  return events.insert({
    team_id: input.teamId,
    topic: CHECKIN_EXPIRED,
    actor_agent_id: 'schedule',
    subject_kind: 'checkin',
    subject_id: input.checkinId,
    occurred_at: input.occurredAt,
    data: {
      checkin_id: input.checkinId,
      status: 'expired',
      owner: input.ownerAgentId,
      linked_task_id: input.linkedTaskId,
      reason: input.reason,
      iteration_count: input.iterationCount,
      max_iterations: input.maxIterations,
      ttl_expires_at: input.ttlExpiresAt,
      closed_at: input.occurredAt,
    },
  });
}

function truncate(text: string): string {
  if (text.length <= PREVIEW_MAX) return text;
  return text.slice(0, PREVIEW_MAX);
}
