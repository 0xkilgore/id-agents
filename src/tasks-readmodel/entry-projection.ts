// I-1 doc-model proof-cut — pure Tasks projection + read-model envelope.
//
// taskRowToEntry() maps a `tasks` substrate row into the typed TaskEntry;
// buildTasksEntriesEnvelope() wraps a page of entries in the shared
// read-model.v1 envelope. Pure + deterministic (no I/O, no clock for the
// projection) so the read route stays a thin SQL→projection adapter, exactly
// like the artifacts read-model.

import type { TaskRow } from "../db/types.js";
import type {
  ActorRef,
  EntryProvenance,
  ProvenanceRevision,
  ReadModelEnvelope,
} from "../outputs/entry.js";
import {
  buildTaskBands,
  classifyTaskBand,
  extractTaskScheduleFacts,
  summarizeTaskRows,
  todayIso,
  type TaskBand,
  type TaskBandSummary,
} from "./bands.js";
import type { TaskEntry } from "./entry.js";
import { summarizeTaskReconciliation, taskReconciliationFacts } from "../task-reconciliation/currentness.js";
import type { TaskReconciliationSummary } from "../task-reconciliation/currentness.js";

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

/** Append `by` to `acc` if that actor isn't already present (by type:id). */
function addContributor(acc: ActorRef[], seen: Set<string>, by: ActorRef): void {
  const key = `${by.type}:${by.id}`;
  if (!seen.has(key)) {
    seen.add(key);
    acc.push(by);
  }
}

/**
 * Build the DV2 provenance for a task from the row itself. Tasks have no op log
 * (unlike artifacts), so the created/modified chain is derived from the row's
 * timestamps + actors: a `created` revision, a `modified` revision when the row
 * has been touched since creation (folded to `completed` when that touch closed
 * the task), and a distinct `completed` revision when completion happened later.
 * `source_dispatch_phid`/`derived_from` are reserved (null/[]) until tasks carry
 * a dispatch link — same posture as the artifacts entry.
 */
export function taskProvenance(
  row: TaskRow,
  createdBy: ActorRef,
  updatedBy: ActorRef,
  owner: ActorRef | null,
): EntryProvenance {
  const revisions: ProvenanceRevision[] = [];
  const createdAt = epochToIso(row.created_at);
  revisions.push({ at: createdAt, by: createdBy, note: "created" });

  const updatedAt = epochToIso(row.updated_at);
  const completedAt = row.completed_at != null ? epochToIso(row.completed_at) : null;
  if (updatedAt !== createdAt) {
    const closedHere = completedAt !== null && completedAt === updatedAt;
    revisions.push({ at: updatedAt, by: updatedBy, note: closedHere ? "completed" : "modified" });
  }
  if (completedAt !== null && completedAt !== updatedAt && completedAt !== createdAt) {
    revisions.push({ at: completedAt, by: owner ?? updatedBy, note: "completed" });
  }

  const contributors: ActorRef[] = [];
  const seen = new Set<string>();
  for (const rev of revisions) addContributor(contributors, seen, rev.by);

  return {
    actor_ref: createdBy,
    source: row.name,
    origin: "substrate",
    source_dispatch_phid: null,
    derived_from: [],
    revisions,
    contributors,
  };
}

/**
 * Project a `tasks` row into a typed TaskEntry. `agentNames` maps an agent id
 * to its display name (so actors read as the human-facing agent name rather
 * than the opaque id); unknown ids fall back to the raw id.
 */
export function taskRowToEntry(
  row: TaskRow,
  agentNames: Map<string, string> = new Map(),
  today: string = todayIso(),
): TaskEntry {
  const resolve = (id: string) => agentNames.get(id) ?? id;
  const owner: ActorRef | null = row.owner ? agentActor(resolve(row.owner)) : null;
  const createdBy: ActorRef = row.created_by
    ? agentActor(resolve(row.created_by))
    : { type: "system", id: "system" };
  const updatedBy: ActorRef = owner ?? createdBy;
  const facts = extractTaskScheduleFacts(row);
  const band = classifyTaskBand(facts, today);
  const reconciliation = taskReconciliationFacts(row, { today });

  return {
    phid: row.uuid || row.id,
    kind: "task",
    schema_version: 1,
    display_id: row.name,
    display_title: reconciliation.title.display_title,
    full_title: reconciliation.title.full_title,
    title: row.title,
    task_status: row.status,
    body_markdown: row.description ?? "",
    priority: facts.priority,
    due_iso: facts.due_iso,
    done: facts.done,
    archived: facts.archived,
    band,
    project: null,
    track: row.track ?? "(unassigned)",
    owner,
    created_at: epochToIso(row.created_at),
    created_by: createdBy,
    updated_at: epochToIso(row.updated_at),
    updated_by: updatedBy,
    completed_at: row.completed_at != null ? epochToIso(row.completed_at) : null,
    currentness: reconciliation.currentness,
    title_audit: reconciliation.title,
    source_dispatch_phid: null,
    links: [],
    provenance: taskProvenance(row, createdBy, updatedBy, owner),
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
  page: { limit: number; offset: number; today?: string },
): ReadModelEnvelope<TaskEntry> & {
  summary: TaskBandSummary;
  task_reconciliation: TaskReconciliationSummary;
  bands: Array<TaskBand<TaskEntry>>;
  today: string;
} {
  const today = page.today ?? todayIso();
  const items = rows
    .slice(page.offset, page.offset + page.limit)
    .map((row) => taskRowToEntry(row, agentNames, today));
  return {
    schema_version: "read-model.v1",
    generated_at: new Date().toISOString(),
    today,
    items,
    count: items.length,
    limit: page.limit,
    offset: page.offset,
    summary: summarizeTaskRows(rows, today),
    task_reconciliation: summarizeTaskReconciliation(rows, { today }),
    bands: buildTaskBands(items, (item) => item.band),
    source: { read_path: "substrate", projection: "task_entries" },
    parity: { status: "unchecked" },
  };
}
