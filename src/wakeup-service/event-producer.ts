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

import type { EventsRepository } from '../db/db-service.js';

export const TASK_CLAIMED = 'task:claimed';
export const TASK_COMPLETED = 'task:completed';
export const QUERY_DELIVERED = 'query:delivered';
export const QUERY_FAILED = 'query:failed';
export const QUERY_EXPIRED = 'query:expired';

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

function truncate(text: string): string {
  if (text.length <= PREVIEW_MAX) return text;
  return text.slice(0, PREVIEW_MAX);
}
