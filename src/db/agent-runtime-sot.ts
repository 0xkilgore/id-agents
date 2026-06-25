// Runtime Work-Share Slice 1 (§3) — runtime source-of-truth normalization.
//
// Problem: an agent's runtime lives in two places — the canonical
// `agents.runtime` COLUMN and an informational `metadata.runtime` COPY. They
// diverge when one is written without the other (the CTO/Regina/Rams bug).
//
// Fix: the COLUMN is the single source of truth. `metadata.runtime` is DERIVED
// from it at read time (so the API can never emit divergent values), and a
// one-time idempotent reconcile rewrites persisted metadata to match. No routing
// or runtime-selection behavior changes — this is the SoT bug fix only.

import type { DbAdapter } from "./db-adapter.js";

/**
 * Return the agent metadata with `runtime` derived from the canonical column,
 * so a read can never surface a `metadata.runtime` that disagrees with the
 * top-level runtime. Non-object metadata (null/legacy) is passed through
 * unchanged — there is no `metadata.runtime` to diverge in that case.
 */
export function deriveMetadataWithRuntime(metadata: unknown, runtime: string): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }
  return { ...(metadata as Record<string, unknown>), runtime };
}

export interface ReconcileAgentRuntimeResult {
  /** Rows whose persisted metadata.runtime now equals the canonical column. */
  reconciled: number;
  /** Rows that already agreed (no write needed) — proves idempotency. */
  already_consistent: number;
  scanned: number;
}

interface AgentRuntimeRow {
  id: string;
  runtime: string | null;
  metadata: string | null;
}

/**
 * One-time, idempotent reconcile: set `metadata.runtime := runtime` for every
 * live agent so persisted copies match the canonical column. Safe to run
 * repeatedly — a second run reconciles 0 rows. Scoped to a team when given.
 *
 * Done in app code (read → compare → write only the divergent rows) rather than
 * a blanket `json_set` UPDATE so the result reports how many actually needed
 * fixing (the idempotency signal) and so it never rewrites already-correct JSON.
 */
export async function reconcileAgentRuntime(
  adapter: DbAdapter,
  opts: { teamId?: string } = {},
): Promise<ReconcileAgentRuntimeResult> {
  const params: unknown[] = [];
  let where = "deleted_at IS NULL";
  if (opts.teamId) {
    where += " AND team_id = $1";
    params.push(opts.teamId);
  }
  const { rows } = await adapter.query<AgentRuntimeRow>(
    `SELECT id, runtime, metadata FROM agents WHERE ${where}`,
    params,
  );

  let reconciled = 0;
  let already_consistent = 0;
  for (const row of rows) {
    const runtime = row.runtime ?? "";
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        /* tolerate legacy/malformed metadata — treated as empty, then fixed */
      }
    }
    if (meta.runtime === runtime && row.metadata) {
      already_consistent += 1;
      continue;
    }
    meta.runtime = runtime;
    await adapter.query(`UPDATE agents SET metadata = $1 WHERE id = $2`, [JSON.stringify(meta), row.id]);
    reconciled += 1;
  }
  return { reconciled, already_consistent, scanned: rows.length };
}
