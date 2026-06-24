// I-1 doc-model proof-cut — Tasks read-model entry (DV1-style).
//
// The typed projection of the `tasks` substrate table that operator surfaces
// (Desk/console) query instead of walking to-do.md markdown. Mirrors the
// artifacts ArtifactEntry; reuses the shared read-model envelope + actor
// primitives so the two substrate feeds share one contract.

import type { ActorRef, PHID } from "../outputs/entry.js";

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
  project: string | null;
  /** The agent the task is assigned to, if any. */
  owner: ActorRef | null;
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  completed_at: string | null;
}
