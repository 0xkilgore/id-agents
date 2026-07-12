// I-1 task doc-model — one typed creation schema for every task source.
//
// Every task in Kapelle is born from one of a handful of sources (the manager
// POST /tasks API, the auto-attach checkin flow, schedule/loop-derived calendar
// tasks, the dispatch-approval emitter, and the taskview to-do.md CLI). Each
// used to hand-assemble a `TaskRow` literal, and they had DRIFTED: three sources
// wrote epoch-SECONDS timestamps + `task_<ms>_<rand>` ids while the approval
// emitter wrote epoch-MILLISECONDS + a bare UUID id. The read-model
// (tasks-readmodel/entry-projection.ts) only tolerated the ms drift by accident.
//
// This module makes the creation schema canonical: a source builds a typed
// `TaskDraft` via its adapter, then `buildTaskRow()` fills the boilerplate
// (id, uuid, timestamps, status derivation, track default) ONE way. The result
// is the same `TaskRow` the substrate stores and `taskRowToEntry` projects, so
// creation and read-model are one schema family (round-trip test:
// tests/unit/task-draft.test.ts).

import crypto from "crypto";
import type { TaskRow } from "../db/types.js";

/** Every place a task can be born. Each has a `draftFrom*` adapter below. */
export type TaskCreationSource =
  | "manager_api" // POST /tasks
  | "auto_attach" // auto-attach checkin task (POST /talk-to … --auto-attach)
  | "schedule_derived" // /tasks with calendar event links (loop/schedule-derived)
  | "dispatch_approval" // outputs approval-emit (dispatch/approval-derived task)
  | "taskview_cli"; // taskview to-do.md intake (markdown source, mapped on ingest)

/**
 * The canonical, source-agnostic task creation schema. Callers resolve the
 * I/O-bound fields first (slug-normalized + uniqueness-checked `name`, resolved
 * agent ids for `created_by`/`owner`, validated `track`) and hand them here;
 * `buildTaskRow` owns everything mechanical.
 */
export interface TaskDraft {
  source: TaskCreationSource;
  /** Slug, already normalized + uniqueness-resolved by the caller. */
  name: string;
  team_id: string | null;
  title: string;
  description?: string | null;
  /** Explicit status. When omitted it is derived: `owner ? 'doing' : 'todo'`. */
  status?: TaskRow["status"];
  /** Resolved creator agent id, or null (e.g. the manager service is not an agent). */
  created_by?: string | null;
  /** Resolved owner agent id, or null when unassigned. */
  owner?: string | null;
  /** Canonical roadmap track; defaults to '(unassigned)' when absent/blank. */
  track?: string | null;
}

export interface BuildTaskRowOptions {
  /** Injectable clock (ms since epoch). Defaults to Date.now(). */
  nowMs?: number;
  /** Injectable primary-key id (tests / deterministic callers). */
  id?: string;
  /** Injectable uuid (tests / deterministic callers). */
  uuid?: string;
}

export const UNASSIGNED_TRACK = "(unassigned)";

/** Canonical status derivation: an explicit status wins, else owner presence. */
export function deriveTaskStatus(draft: TaskDraft): TaskRow["status"] {
  if (draft.status) return draft.status;
  return draft.owner ? "doing" : "todo";
}

/** Canonical primary-key id: `task_<ms>_<base36-rand>` (matches the historic
 *  three-source format; the approval emitter's bare-UUID id is converged here). */
function newTaskId(nowMs: number): string {
  return `task_${nowMs}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Build a canonical `TaskRow` from a `TaskDraft`. The ONE place task boilerplate
 * is filled — id, uuid, epoch-SECONDS created/updated timestamps, null
 * completed_at, derived status, and the '(unassigned)' track default — so every
 * source produces an identical row shape with no per-source drift.
 */
export function buildTaskRow(draft: TaskDraft, opts: BuildTaskRowOptions = {}): TaskRow {
  const nowMs = opts.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  return {
    id: opts.id ?? newTaskId(nowMs),
    name: draft.name,
    uuid: opts.uuid ?? crypto.randomUUID(),
    team_id: draft.team_id,
    title: draft.title,
    description: draft.description ?? null,
    status: deriveTaskStatus(draft),
    created_by: draft.created_by ?? null,
    owner: draft.owner ?? null,
    created_at: nowSec,
    updated_at: nowSec,
    completed_at: null,
    track: draft.track?.trim() || UNASSIGNED_TRACK,
  };
}

// ── Per-source adapters ─────────────────────────────────────────────────────
// Thin, typed mappers from each source's resolved primitives into a TaskDraft.
// They are the single place a source's status/track posture is declared, so the
// 4 (now 5) creation paths converge on one schema instead of 4 literals.

/** POST /tasks — operator/agent-created, unowned by default (status todo). */
export function draftFromManagerApi(p: {
  name: string;
  team_id: string | null;
  title: string;
  description?: string | null;
  created_by?: string | null;
  owner?: string | null;
  track?: string | null;
}): TaskDraft {
  return { source: "manager_api", ...p };
}

/** Auto-attach checkin task — always owned by the target agent (status doing). */
export function draftFromAutoAttach(p: {
  name: string;
  team_id: string | null;
  title: string;
  description?: string | null;
  created_by?: string | null;
  owner: string;
}): TaskDraft {
  return { source: "auto_attach", status: "doing", ...p };
}

/** Schedule/loop-derived task (carries calendar event links). Status follows
 *  owner presence, exactly like the manager API. */
export function draftFromScheduleDerived(p: {
  name: string;
  team_id: string | null;
  title: string;
  description?: string | null;
  created_by?: string | null;
  owner?: string | null;
  track?: string | null;
}): TaskDraft {
  return { source: "schedule_derived", ...p };
}

/** Dispatch-approval emitter — manager-owned (no agent creator), unowned.
 *  Status defaults to todo; approval-emit may close non-Chris FYI rows after
 *  building the canonical row. Converged onto canonical seconds/id (was ms + UUID). */
export function draftFromDispatchApproval(p: {
  name: string;
  team_id: string | null;
  title: string;
  description?: string | null;
}): TaskDraft {
  return { source: "dispatch_approval", status: "todo", created_by: null, owner: null, ...p };
}

/** taskview to-do.md CLI intake. The markdown source carries no agent ids; an
 *  owner alias resolves upstream. Mapped here so the doc-model covers it the
 *  moment ingestion is wired (taskview currently writes markdown directly). */
export function draftFromTaskviewCli(p: {
  name: string;
  team_id: string | null;
  title: string;
  description?: string | null;
  owner?: string | null;
  track?: string | null;
}): TaskDraft {
  return { source: "taskview_cli", ...p };
}
