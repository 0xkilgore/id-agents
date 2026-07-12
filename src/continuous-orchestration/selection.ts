// Continuous Orchestration — deterministic candidate ordering.
//
// Pure, queryable ranking: Monday North Star first, then priority, then
// operator value, then oldest-ready to prevent starvation. No side effects.

import type { BacklogItem } from "./types.js";

/** Lane key with no declared write_scope (a single shared bucket). */
export const NO_LANE_KEY = "∅"; // ∅

/**
 * The lane an item belongs to, identified by its repo/write_scope. Pool builds
 * late-bind write_scope to a concrete `/.worktrees/...` path when they fire;
 * lane accounting must collapse those paths back to the repo root so stale
 * duplicate rows cannot look like fresh distinct lane fuel.
 *
 * Items that write the same normalized scope set are the same lane; scope-less
 * items share one bucket. Stable: scopes are sorted so ordering can't make two
 * equal scope sets look distinct.
 */
export function laneKeyOf(item: BacklogItem): string {
  return item.write_scope.length ? item.write_scope.map(normalizeLaneScope).sort().join("|") : NO_LANE_KEY;
}

function normalizeLaneScope(scope: string): string {
  const worktreeMarker = "/.worktrees/";
  const worktreeAt = scope.indexOf(worktreeMarker);
  if (worktreeAt >= 0) return scope.slice(0, worktreeAt);
  return scope;
}

/** Order READY candidates highest-value first. Stable + deterministic. */
export function orderCandidates(items: BacklogItem[]): BacklogItem[] {
  return [...items].sort((a, b) => {
    // 1. North Star (Liz Monday) always leads.
    if (a.is_north_star !== b.is_north_star) return a.is_north_star ? -1 : 1;
    // 2. Priority: 1 (highest) .. 9 (lowest).
    if (a.priority !== b.priority) return a.priority - b.priority;
    // 3. Explicit operator value, higher first.
    const av = a.value_score ?? 0;
    const bv = b.value_score ?? 0;
    if (av !== bv) return bv - av;
    // 4. Older ready items first (anti-starvation).
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.item_id < b.item_id ? -1 : 1;
  });
}

/**
 * Lane-aware FAIR scheduling. Round-robin the (already priority-ordered)
 * candidates across distinct write_scope lanes so a single lane can't monopolize
 * a tick's admission slots. Within a lane the original order is preserved; lanes
 * rotate in first-seen order, which (because the input is priority-ordered) is
 * highest-priority-lane first — so the globally top item still leads (North Star
 * preserved) while the following slots spread across other lanes.
 *
 * Single-lane (or empty) input is returned unchanged: the greedy order already
 * has nothing to be fair about. Pure + deterministic.
 */
export function fairInterleaveByLane(ordered: BacklogItem[]): BacklogItem[] {
  const lanes = new Map<string, BacklogItem[]>();
  for (const item of ordered) {
    const key = laneKeyOf(item);
    const bucket = lanes.get(key);
    if (bucket) bucket.push(item);
    else lanes.set(key, [item]);
  }
  if (lanes.size <= 1) return [...ordered];

  const buckets = [...lanes.values()];
  const out: BacklogItem[] = [];
  while (out.length < ordered.length) {
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/** READY-fuel shape used by the daemon's parallel-fuel floor. */
export function readyFuel(ready: BacklogItem[]): { total: number; lanes: number } {
  return { total: ready.length, lanes: new Set(ready.map(laneKeyOf)).size };
}

/**
 * Parallel-fuel floor. The daemon refuels (auto-flesh) when READY fuel is short
 * EITHER in total OR across distinct lanes — so an unattended run keeps not just
 * "enough ready items" but "enough ready items spread across lanes" to feed the
 * parallel pool. `minReadyLanes <= 1` makes the lane floor a no-op (total-only).
 */
export function needsRefuel(
  ready: BacklogItem[],
  opts: { minReadyFuel: number; minReadyLanes: number },
): boolean {
  const { total, lanes } = readyFuel(ready);
  return total < opts.minReadyFuel || lanes < opts.minReadyLanes;
}
