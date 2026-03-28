// SPDX-License-Identifier: MIT

/**
 * A logical run produced by the schedule evaluator.
 * Represents one due execution of a schedule for one or more agents.
 */
export interface DueRun {
  scheduleId: string;
  scheduledKey: string;     // e.g. "interval:1711737600" or "calendar:2026-04-01@32400"
  scheduledAt: number;       // unix seconds — logical scheduled instant
  kind: 'interval' | 'calendar';
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
 * Schedule payload sent to agents via /talk endpoint.
 */
export interface SchedulePayload {
  from: 'schedule';
  schedule: {
    id: string;
    kind: 'interval' | 'calendar';
    title: string;
    scheduledKey: string;
  };
  message: string;
}

/**
 * Minimal agent info needed for dispatch (avoids importing full AgentRow).
 */
export interface DispatchTarget {
  id: string;
  name: string;
  endpoint: string;
  status: string;
}
