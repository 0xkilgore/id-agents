// SPDX-License-Identifier: MIT

import type { ScheduleDeliveryMode } from '../config-parser.js';

/**
 * A logical run produced by the schedule evaluator.
 * Represents one due execution of a schedule for one or more agents.
 */
export interface DueRun {
  scheduleId: string;
  scheduledKey: string;     // e.g. "interval:1711737600" or "calendar:2026-04-01@32400"
  scheduledAt: number;       // unix seconds — logical scheduled instant
  kind: 'heartbeat' | 'calendar';
}

/**
 * Result of attempting to dispatch a schedule run to a single agent.
 */
export interface DispatchResult {
  scheduleId: string;
  agentId: string;
  scheduledKey: string;
  success: boolean;
  error?: string;
}

/**
 * Linked task summary included in calendar schedule payloads.
 */
export interface LinkedTaskSummary {
  name: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  owner: string | null;
  team: string | null;
}

/**
 * Schedule payload sent to agents via /talk endpoint.
 */
export interface SchedulePayload {
  from: string;
  mode: ScheduleDeliveryMode;
  schedule: {
    id: string;
    kind: 'heartbeat' | 'calendar';
    title: string;
    scheduledKey: string;
  };
  message: string;
  linkedTasks?: LinkedTaskSummary[];
  dispatch_id?: number | null;
}

/**
 * Minimal agent info needed for dispatch (avoids importing full AgentRow).
 */
export interface DispatchTarget {
  id: string;
  name: string;
  endpoint: string;
  talkPath: string;
  schedulePath?: string | null;
  status: string;
}
