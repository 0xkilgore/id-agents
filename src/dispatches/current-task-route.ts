// SPDX-License-Identifier: MIT
/**
 * Manager route helpers for GET /dashboard/agents/current-tasks —
 * Phase 3 / Task 4.
 *
 * Lives outside agent-manager-db.ts so the selector + fallback logic
 * can be unit-tested without booting the full Express app. The route
 * file in agent-manager-db.ts is a thin Express adapter that calls
 * `buildCurrentTasksHandler(deps)` once at boot and uses the returned
 * function in the request handler.
 */

import type { Db } from '../db/db-service.js';
import type {
  AgentCurrentTaskReadModel,
  AgentCurrentTaskSnapshot,
} from './current-task-read-model.js';
import { SqliteCurrentTaskReadModel } from './sqlite-current-task-read-model.js';
import {
  VetraCurrentTaskReadModel,
  VetraReadFallbackError,
} from './vetra-current-task-read-model.js';
import { SwitchboardClient } from '../vetra/switchboard-client.js';

export function getUseVetraDispatchesFlag(env: Record<string, string | undefined>): boolean {
  return env.USE_VETRA_DISPATCHES === 'true';
}

export interface CurrentTasksResponse {
  ok: true;
  agents: AgentCurrentTaskSnapshot[];
}

export interface CurrentTasksHandlerDeps {
  sqliteModel: AgentCurrentTaskReadModel;
  vetraModel: AgentCurrentTaskReadModel | null;
  log: (msg: string) => void;
}

export type CurrentTasksHandler = (req: {
  agents: string[];
}) => Promise<CurrentTasksResponse>;

/**
 * Build the route handler from its dependencies. The selector is bound
 * at construction: `vetraModel === null` means SQLite-only behavior;
 * otherwise the handler attempts Vetra first and silently falls back to
 * SQLite (with degraded_source flipped to true) on any Vetra failure.
 */
export function buildCurrentTasksHandler(deps: CurrentTasksHandlerDeps): CurrentTasksHandler {
  const { sqliteModel, vetraModel, log } = deps;

  return async ({ agents }) => {
    if (!vetraModel) {
      const snaps = await sqliteModel.getCurrentTaskByAgent(agents);
      return { ok: true, agents: snaps };
    }
    try {
      const snaps = await vetraModel.getCurrentTaskByAgent(agents);
      return { ok: true, agents: snaps };
    } catch (err: any) {
      const reason = err instanceof VetraReadFallbackError
        ? err.message
        : `unexpected error: ${err?.message ?? String(err)}`;
      let sqliteSucceeded = false;
      let snaps: AgentCurrentTaskSnapshot[];
      try {
        snaps = await sqliteModel.getCurrentTaskByAgent(agents);
        sqliteSucceeded = true;
      } catch (sqliteErr: any) {
        // SQLite also failed — return empty snapshots flagged degraded so
        // the dashboard surface shows the indicator without 500-ing.
        snaps = agents.map((agent_id) => ({ agent_id, current_task: null, degraded_source: true }));
      }
      logCurrentTaskFallback(log, agents, reason, sqliteSucceeded);
      return {
        ok: true,
        agents: snaps.map((s) => ({ ...s, degraded_source: true })),
      };
    }
  };
}

export function logCurrentTaskFallback(
  log: (msg: string) => void,
  agentIds: string[],
  reason: string,
  sqliteSucceeded: boolean,
): void {
  // Operator-visible single-line log. Reason is a *short* summary; we
  // intentionally do not include raw GraphQL responses or response
  // previews here — those go in deeper diagnostic logs only.
  const reasonShort = reason.replace(/\s+/g, ' ').slice(0, 200);
  log(
    `[CurrentTasks] Vetra read failed agents=${agentIds.join(',')} ` +
    `reason="${reasonShort}" sqlite_succeeded=${sqliteSucceeded}`,
  );
}

/**
 * Choose the right read model implementation given the env. Returns
 * `{ sqliteModel, vetraModel }` where `vetraModel` is null when the
 * flag is off. The caller wires the result into `buildCurrentTasksHandler`.
 */
export function createCurrentTaskReadModel(
  env: Record<string, string | undefined>,
  db: Db,
): CurrentTasksHandlerDeps {
  const sqliteModel = new SqliteCurrentTaskReadModel(db);
  if (!getUseVetraDispatchesFlag(env)) {
    return { sqliteModel, vetraModel: null, log: () => {} };
  }
  const url = env.SWITCHBOARD_GRAPHQL_URL;
  if (!url) {
    return { sqliteModel, vetraModel: null, log: () => {} };
  }
  const client = new SwitchboardClient({
    graphqlUrl: url,
    accessToken: env.SWITCHBOARD_ACCESS_TOKEN ?? null,
  });
  return { sqliteModel, vetraModel: new VetraCurrentTaskReadModel(client), log: () => {} };
}
