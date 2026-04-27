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
export const TASK_COMPLETED = 'task:completed';
export const QUERY_DELIVERED = 'query:delivered';
export const QUERY_FAILED = 'query:failed';
export const QUERY_EXPIRED = 'query:expired';
export const CHECKIN_CREATED = 'checkin:created';
export const CHECKIN_CLOSED = 'checkin:closed';
export const CHECKIN_SNOOZED = 'checkin:snoozed';

const PREVIEW_MAX = 280;

export interface TaskClaimedInput {
  teamId: string;
  taskUuid: string;
  taskName: string;
  title?: string | null;
  ownerAgentId: string;
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

function truncate(text: string): string {
  if (text.length <= PREVIEW_MAX) return text;
  return text.slice(0, PREVIEW_MAX);
}
