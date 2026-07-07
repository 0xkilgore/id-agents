// I-1 doc-model proof-cut — Tasks read-model entry (DV1-style).
//
// The typed projection of the `tasks` substrate table that operator surfaces
// (Desk/console) query instead of walking to-do.md markdown. Mirrors the
// artifacts ArtifactEntry; reuses the shared read-model envelope + actor
// primitives so the two substrate feeds share one contract.

import type { ActorRef, AssociationEdge, EntryProvenance, PHID } from "../outputs/entry.js";

export type { ReadModelEnvelope } from "../outputs/entry.js";

/**
 * DV1-style TaskEntry — a pure projection over the `tasks` table (see
 * tasks-readmodel/entry-projection.ts). No schema migration: the substrate
 * already stores tasks; this is the typed read shape.
 */
export interface TaskEntry {
  phid: PHID;
  kind: "task";
  schema_version: 1;
  /** The operator-facing kebab handle (`tasks.name`). */
  display_id: string;
  title: string;
  task_status: "todo" | "doing" | "done";
  /** Task description; empty string when none. */
  body_markdown: string;
  /** Taskview-compatible priority token parsed from title/description. */
  priority: "high" | "med" | "low" | null;
  /** Taskview-compatible due date parsed from title/description. */
  due_iso: string | null;
  done: boolean;
  archived: boolean;
  band: "overdue" | "today" | "tomorrow" | "high_no_due" | "later" | "done";
  project: string | null;
  /** Canonical roadmap track (canonical-track-registry); '(unassigned)' when none. */
  track: string;
  /** Durable note events appended to this task. */
  task_note_count: number;
  /** Actionable reconciliation items attached to this task. */
  reconciliation_count: number;
  /** The agent the task is assigned to, if any. */
  owner: ActorRef | null;
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  completed_at: string | null;
  /** The dispatch this task originated from, when known (null until linked). */
  source_dispatch_phid: string | null;
  /** Typed associations to other entries (e.g. derived_from). Empty in v0. */
  links: AssociationEdge[];
  /** DV2 provenance — actor_ref, source dispatch, derived-from, and the
   *  created/modified chain. Shared contract with ArtifactEntry (I-1). */
  provenance: EntryProvenance;
}
