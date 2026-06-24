// I-1 doc-model proof-cut — pure Tasks projection + read-model envelope.
//
// taskRowToEntry() maps a `tasks` substrate row into the typed TaskEntry;
// buildTasksEntriesEnvelope() wraps a page of entries in the shared
// read-model.v1 envelope. Pure + deterministic (no I/O, no clock for the
// projection) so the read route stays a thin SQL→projection adapter, exactly
// like the artifacts read-model.

import type { TaskRow } from "../db/types.js";
import type { ActorRef, ReadModelEnvelope } from "../outputs/entry.js";
import type { TaskEntry } from "./entry.js";

/** Convert a stored epoch timestamp (seconds OR milliseconds) to ISO-8601. */
function epochToIso(value: number): string {
  // tasks.* timestamps are epoch seconds; tolerate ms (13-digit) defensively.
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

/** An agent actor for a resolved (or raw) agent identifier. */
function agentActor(idOrName: string): ActorRef {
  return { type: "agent", id: idOrName };
}

/**
 * Project a `tasks` row into a typed TaskEntry. `agentNames` maps an agent id
 * to its display name (so actors read as the human-facing agent name rather
 * than the opaque id); unknown ids fall back to the raw id.
 */
export function taskRowToEntry(
  row: TaskRow,
  agentNames: Map<string, string> = new Map(),
): TaskEntry {
  const resolve = (id: string) => agentNames.get(id) ?? id;
  const owner: ActorRef | null = row.owner ? agentActor(resolve(row.owner)) : null;
  const createdBy: ActorRef = row.created_by
    ? agentActor(resolve(row.created_by))
    : { type: "system", id: "system" };

  return {
    phid: row.uuid || row.id,
    kind: "task",
    schema_version: 1,
    display_id: row.name,
    title: row.title,
    task_status: row.status,
    body_markdown: row.description ?? "",
    project: null,
    owner,
    created_at: epochToIso(row.created_at),
    created_by: createdBy,
    updated_at: epochToIso(row.updated_at),
    updated_by: owner ?? createdBy,
    completed_at: row.completed_at != null ? epochToIso(row.completed_at) : null,
  };
}

/**
 * Wrap a page of task rows in the shared read-model.v1 envelope. Rows are
 * projected in the order given (the query orders by updated_at DESC) and sliced
 * by limit/offset — the substrate read path for GET /tasks/entries.
 */
export function buildTasksEntriesEnvelope(
  rows: TaskRow[],
  agentNames: Map<string, string>,
  page: { limit: number; offset: number },
): ReadModelEnvelope<TaskEntry> {
  const items = rows
    .slice(page.offset, page.offset + page.limit)
    .map((row) => taskRowToEntry(row, agentNames));
  return {
    schema_version: "read-model.v1",
    generated_at: new Date().toISOString(),
    items,
    count: items.length,
    limit: page.limit,
    offset: page.offset,
    source: { read_path: "substrate", projection: "task_entries" },
    parity: { status: "unchecked" },
  };
}
