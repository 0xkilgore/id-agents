// SPDX-License-Identifier: MIT
/**
 * Vetra read-side current-task contract — Phase 1 / Task 1.
 *
 * The dashboard fleet cards consume these snapshots from the manager
 * route `GET /dashboard/agents/current-tasks`. Two implementations of
 * AgentCurrentTaskReadModel exist behind the USE_VETRA_DISPATCHES flag:
 * one backed by the local SQLite dispatches table, one by the
 * Switchboard/Vetra GraphQL endpoint. Both produce the same shape so
 * the dashboard layer never special-cases the data source.
 *
 * Plan: docs/superpowers/plans/2026-05-08-vetra-readside-dashboard.md
 */

export type DispatchCardSource = 'sqlite' | 'vetra';

export type CurrentTaskStatus = 'queued' | 'in_flight';

export interface AgentCurrentTaskSnapshot {
  agent_id: string;
  current_task: {
    source: DispatchCardSource;
    dispatch_id: string | number;
    query_id: string | null;
    title: string;
    started_at: string;
    status: CurrentTaskStatus;
    waiting_on_human: boolean;
    verify_status: string | null;
    artifact_path: string | null;
  } | null;
  degraded_source: boolean;
}

export interface AgentCurrentTaskReadModel {
  getCurrentTaskByAgent(agentIds: string[]): Promise<AgentCurrentTaskSnapshot[]>;
}
