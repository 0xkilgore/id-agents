// Resolve a usage event's dispatch_id → spend scope (Gap 2).
//
// Usage events carry `dispatch_id` (the dispatch_phid). The dispatch queue row
// carries `from_actor` — the daemon stamps every enqueue with
// `continuous-orchestration`. Joining the two attributes each event's tokens to
// the daemon's own ledger WITHOUT any new per-event tagging at ingest time (the
// transcript ingest never sees the daemon). Same join key the project/task
// attribution already uses.

import type { DbAdapter } from "../db/db-adapter.js";
import type { SpendScope } from "./types.js";

/** The from_actor the continuous-orchestration daemon stamps on its enqueues. */
export const DAEMON_AUTONOMOUS_ACTOR = "continuous-orchestration";
/** Reserved for auto-flesh LLM dispatches, if ever routed through an agent. */
export const DAEMON_FLESHING_ACTOR = "continuous-orchestration-flesher";

export interface DispatchSpend {
  spend_scope: SpendScope;
  initiator_actor: string | null;
}

/** Map a dispatch's `from_actor` to a spend scope. */
export function classifySpendScope(fromActor: string | null | undefined): SpendScope {
  if (fromActor === DAEMON_AUTONOMOUS_ACTOR) return "daemon_autonomous";
  if (fromActor === DAEMON_FLESHING_ACTOR) return "daemon_fleshing";
  return "fleet";
}

interface DispatchActorRow {
  dispatch_phid: string;
  from_actor: string | null;
}

/**
 * Load `{ spend_scope, initiator_actor }` for each dispatch_id by reading the
 * dispatch queue `from_actor`. Dispatch_ids with no matching row simply don't
 * appear in the map — the caller treats those events as `unknown` so daemon
 * spend is NEVER silently over- or under-counted. Chunked IN clauses bound the
 * query.
 */
export async function loadDispatchSpendScopes(
  adapter: DbAdapter,
  dispatchIds: Iterable<string>,
): Promise<Map<string, DispatchSpend>> {
  const ids = [...new Set([...dispatchIds].filter((d) => typeof d === "string" && d.length > 0))];
  const out = new Map<string, DispatchSpend>();
  if (ids.length === 0) return out;

  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { rows } = await adapter.query<DispatchActorRow>(
      `SELECT dispatch_phid, from_actor FROM dispatch_scheduler_queue WHERE dispatch_phid IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      out.set(row.dispatch_phid, {
        spend_scope: classifySpendScope(row.from_actor),
        initiator_actor: row.from_actor ?? null,
      });
    }
  }
  return out;
}
