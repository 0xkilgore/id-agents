// Continuous Orchestration — deterministic candidate ordering.
//
// Pure, queryable ranking: Monday North Star first, then priority, then
// operator value, then oldest-ready to prevent starvation. No side effects.

import type { BacklogItem } from "./types.js";

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
