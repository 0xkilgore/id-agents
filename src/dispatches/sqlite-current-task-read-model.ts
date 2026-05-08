// SPDX-License-Identifier: MIT
/**
 * SqliteCurrentTaskReadModel — projects local `dispatches` rows into the
 * AgentCurrentTaskSnapshot contract for the dashboard fleet cards.
 *
 * Used as the default behind USE_VETRA_DISPATCHES=false and as the silent
 * fallback when Vetra reads fail. `degraded_source` is always false here;
 * the manager route flips it to `true` only when fallback was forced from
 * a Vetra failure.
 *
 * Plan: docs/superpowers/plans/2026-05-08-vetra-readside-dashboard.md
 * Phase 1 / Task 2.
 */

import type { Db } from '../db/db-service.js';
import type { DispatchRow } from '../db/types.js';
import type {
  AgentCurrentTaskReadModel,
  AgentCurrentTaskSnapshot,
} from './current-task-read-model.js';
import { extractCurrentTaskTitle } from './current-task-title.js';

export class SqliteCurrentTaskReadModel implements AgentCurrentTaskReadModel {
  constructor(private readonly db: Db) {}

  async getCurrentTaskByAgent(agentIds: string[]): Promise<AgentCurrentTaskSnapshot[]> {
    if (agentIds.length === 0) return [];
    const rows = await this.db.dispatches.listLatestOpenByAgents(agentIds);
    const byAgent = new Map<string, DispatchRow>();
    for (const r of rows) byAgent.set(r.to_agent, r);

    return agentIds.map((agentId) => {
      const row = byAgent.get(agentId);
      if (!row) {
        return { agent_id: agentId, current_task: null, degraded_source: false };
      }
      return {
        agent_id: agentId,
        current_task: {
          source: 'sqlite',
          dispatch_id: row.id,
          query_id: row.query_id,
          title: extractCurrentTaskTitle(row.message ?? ''),
          started_at: new Date(row.dispatched_at).toISOString(),
          status: row.status === 'in_flight' ? 'in_flight' : 'queued',
          waiting_on_human: false,
          verify_status: row.verify_status,
          artifact_path: row.artifact_path,
        },
        degraded_source: false,
      };
    });
  }
}
