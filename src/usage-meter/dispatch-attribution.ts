// Resolve a usage event's dispatch_id → project/task attribution.
//
// Usage events carry `dispatch_id` (the dispatch_phid). The dispatch queue row
// carries the `subject`, which encodes the project as `[project: X]`. Joining
// the two lets the daily report attribute tokens by project and by task without
// any new per-event tagging — the dispatch_id the events already carry is the
// join key.

import type { DbAdapter } from "../db/db-adapter.js";
import { parseProjectFromSubject, type DispatchAttribution } from "./daily-report.js";

interface DispatchRow {
  dispatch_phid: string;
  subject: string | null;
}

/**
 * Load `{ project, task }` for each dispatch_id, by reading the dispatch queue
 * subjects. Unknown dispatch_ids simply don't appear in the map (the report
 * buckets them as unattributed). Chunked IN clauses keep the query bounded.
 */
export async function loadDispatchAttributions(
  adapter: DbAdapter,
  dispatchIds: Iterable<string>,
): Promise<Map<string, DispatchAttribution>> {
  const ids = [...new Set([...dispatchIds].filter((d) => typeof d === "string" && d.length > 0))];
  const out = new Map<string, DispatchAttribution>();
  if (ids.length === 0) return out;

  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { rows } = await adapter.query<DispatchRow>(
      `SELECT dispatch_phid, subject FROM dispatch_scheduler_queue WHERE dispatch_phid IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      out.set(row.dispatch_phid, {
        project: parseProjectFromSubject(row.subject),
        task: row.subject ?? null,
      });
    }
  }
  return out;
}
