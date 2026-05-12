// SPDX-License-Identifier: MIT
/**
 * Spec 076 — thin SQLite-backed current-task endpoint.
 *
 * The full Vetra read-side (current-task-route.ts + sqlite-current-task-read-
 * model.ts + vetra-current-task-read-model.ts on the vetra-readside-dashboard
 * branch) requires the dispatches-repo + dispatch-writer infrastructure that
 * was removed from this branch during the "manager decouple" refactor. Rather
 * than fight 8+ merge conflicts to bring it back, this is a thin alternative
 * that reads CURRENT in-flight queries straight from the existing
 * `queries` table.
 *
 * Source of truth: rows in `queries` where `status = 'pending'`, joined to
 * `agents` for the name. The query that's been pending longest per agent is
 * surfaced as that agent's `current_task`. Agents with no pending row come
 * back with `current_task: null`.
 *
 * Response shape matches what the dashboard's
 * `app/api/agents/projection.ts` expects (see fetchCurrentTaskSnapshots in
 * `app/api/agents/route.ts`):
 *
 *   { ok: true, agents: [{ agent_id, current_task, degraded_source }] }
 *
 * where `current_task` is `{ title, started_at, status, source }` or null.
 *
 * Title derivation: first line of `queries.prompt` truncated to 80 chars.
 * Mirrors the deriveSubject() pattern from the dispatch beachhead so the
 * UI shows a useful "[From: x] do the thing" headline rather than a UUID.
 */

import type { Db } from '../db/db-service.js';

export interface AgentCurrentTaskSnapshot {
  agent_id: string;
  current_task: {
    title: string;
    started_at: string;
    status: 'in_flight';
    source: 'queries-pending';
    verify_status: null;
    artifact_path: null;
    waiting_on_human: false;
  } | null;
  degraded_source: boolean;
}

export interface CurrentTasksResponse {
  ok: true;
  agents: AgentCurrentTaskSnapshot[];
}

/**
 * Derive a UI-friendly title from a prompt blob. Strips a leading
 * `[From: name]` envelope if present, collapses whitespace, caps at 80.
 */
export function deriveTaskTitle(rawPrompt: string | null | undefined): string {
  if (!rawPrompt) return '';
  // Strip the `[From: …] ` envelope the /talk handler prepends so the
  // visible title reads as the message itself, not the metadata.
  const stripped = rawPrompt.replace(/^\[From:[^\]]*\]\s*/i, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? collapsed.slice(0, 79) + '…' : collapsed;
}

/**
 * Snapshot generator. Takes the full agents list (so we know what `null`
 * rows to return for idle agents) and reads `queries` for any in-flight
 * rows. Pure function — no I/O beyond the db adapter the caller passes in.
 *
 * `agentNames` filters to a subset if provided; empty/undefined means
 * "all agents the caller's team has".
 */
export async function buildCurrentTasksSnapshot(
  db: Db,
  allAgents: Array<{ id: string; name: string }>,
  agentNames?: string[] | null,
): Promise<CurrentTasksResponse> {
  const filterSet =
    agentNames && agentNames.length > 0 ? new Set(agentNames) : null;

  // Map agent_id → name so we can group the pending rows.
  const idToName = new Map<string, string>();
  for (const a of allAgents) idToName.set(a.id, a.name);

  // Pull pending rows per agent. We want the oldest pending one per agent
  // — that's the "current" task. The repo doesn't expose a "pending per
  // agent across all" method on this branch, so we read per-agent via the
  // existing getPending(agentId) entry point.
  const pendingByAgent = new Map<
    string,
    { query_id: string; prompt: string; created: number } | null
  >();
  for (const a of allAgents) {
    if (filterSet && !filterSet.has(a.name)) continue;
    try {
      const rows = await db.queries.getPending(a.id);
      // getPending returns latest-first by default in this codebase; pick
      // the OLDEST as "current" since it's the one the agent is most
      // likely still working on. If empty, set null.
      if (!rows || rows.length === 0) {
        pendingByAgent.set(a.name, null);
      } else {
        const oldest = rows.reduce((m, r) =>
          r.created < m.created ? r : m,
        );
        pendingByAgent.set(a.name, {
          query_id: oldest.query_id,
          prompt: oldest.prompt ?? '',
          created: oldest.created,
        });
      }
    } catch {
      // Per-agent read failure: report degraded for this one, keep going.
      pendingByAgent.set(a.name, null);
    }
  }

  const snapshots: AgentCurrentTaskSnapshot[] = [];
  for (const a of allAgents) {
    if (filterSet && !filterSet.has(a.name)) continue;
    const pending = pendingByAgent.get(a.name);
    if (!pending) {
      snapshots.push({
        agent_id: a.name,
        current_task: null,
        degraded_source: false,
      });
      continue;
    }
    snapshots.push({
      agent_id: a.name,
      current_task: {
        title: deriveTaskTitle(pending.prompt),
        started_at: new Date(pending.created).toISOString(),
        status: 'in_flight',
        source: 'queries-pending',
        verify_status: null,
        artifact_path: null,
        waiting_on_human: false,
      },
      degraded_source: false,
    });
  }

  return { ok: true, agents: snapshots };
}
