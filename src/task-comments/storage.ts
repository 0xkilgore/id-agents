import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TaskRow } from "../db/types.js";

export const TASK_COMMENT_EVENT_TOPIC = "task_comment" as const;
export const TASK_COMMENT_DISPATCH_CHANNEL = "task_comment" as const;

export type TaskCommentRoutingStatus = "pending" | "routed" | "failed";

export interface TaskCommentRoutingResult {
  target_agent: string;
  status: TaskCommentRoutingStatus;
  dispatch_phid: string | null;
  query_id: string | null;
  error: string | null;
  routed_at: string | null;
}

export interface TaskCommentRow {
  id: string;
  team_id: string;
  task_id: string;
  task_uuid: string | null;
  task_name: string;
  task_title: string;
  source_path: string | null;
  source_line: number | null;
  comment_text: string;
  actor: string;
  occurred_at: number;
  hash: string;
  event_seq: number | null;
  routing_status: TaskCommentRoutingStatus;
  routing_results_json: string;
  created_at: number;
  updated_at: number;
}

export interface TaskCommentView {
  id: string;
  task_id: string;
  task_uuid: string | null;
  task_name: string;
  task_title: string;
  source_path: string | null;
  source_line: number | null;
  text: string;
  actor: string;
  timestamp: string;
  hash: string;
  event_seq: number | null;
  routing_status: TaskCommentRoutingStatus;
  routing_results: TaskCommentRoutingResult[];
  created_at: string;
  updated_at: string;
}

export interface AppendTaskCommentInput {
  teamId: string;
  task: TaskRow;
  sourcePath?: string | null;
  sourceLine?: number | null;
  text: string;
  actor: string;
  occurredAtMs?: number;
}

export interface AppendTaskCommentResult {
  row: TaskCommentRow;
  inserted: boolean;
}

export async function migrateTaskCommentTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS task_comment_events (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_uuid TEXT,
      task_name TEXT NOT NULL,
      task_title TEXT NOT NULL,
      source_path TEXT,
      source_line INTEGER,
      comment_text TEXT NOT NULL,
      actor TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      hash TEXT NOT NULL,
      event_seq INTEGER,
      routing_status TEXT NOT NULL DEFAULT 'pending',
      routing_results_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(team_id, hash)
    )
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_comment_events_task_idx ON task_comment_events(team_id, task_id, occurred_at)`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_comment_events_status_idx ON task_comment_events(team_id, routing_status, updated_at)`);
}

export function stableTaskCommentHash(input: {
  teamId: string;
  taskUuid: string | null;
  taskId: string;
  sourcePath: string | null;
  sourceLine: number | null;
  actor: string;
  text: string;
}): string {
  const stable = {
    team_id: input.teamId,
    task: input.taskUuid || input.taskId,
    source_path: input.sourcePath || "",
    source_line: input.sourceLine ?? null,
    actor: input.actor.trim(),
    text: normalizeCommentText(input.text),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export async function appendTaskComment(
  adapter: DbAdapter,
  input: AppendTaskCommentInput,
): Promise<AppendTaskCommentResult> {
  const text = input.text.trim();
  const actor = input.actor.trim();
  const sourcePath = input.sourcePath?.trim() || null;
  const sourceLine = input.sourceLine != null && Number.isFinite(input.sourceLine)
    ? Math.max(1, Math.floor(input.sourceLine))
    : null;
  const occurredAt = input.occurredAtMs ?? Date.now();
  const hash = stableTaskCommentHash({
    teamId: input.teamId,
    taskUuid: input.task.uuid ?? null,
    taskId: input.task.id,
    sourcePath,
    sourceLine,
    actor,
    text,
  });
  const id = `task_comment_${hash.slice(0, 24)}`;
  const now = Date.now();

  const inserted = await adapter.query(
    `INSERT INTO task_comment_events
       (id, team_id, task_id, task_uuid, task_name, task_title, source_path, source_line,
        comment_text, actor, occurred_at, hash, event_seq, routing_status,
        routing_results_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', '[]', ?, ?)
     ON CONFLICT(team_id, hash) DO NOTHING`,
    [
      id,
      input.teamId,
      input.task.id,
      input.task.uuid ?? null,
      input.task.name,
      input.task.title,
      sourcePath,
      sourceLine,
      text,
      actor,
      occurredAt,
      hash,
      now,
      now,
    ],
  );

  const row = await getTaskCommentByHash(adapter, input.teamId, hash);
  if (!row) throw new Error("task comment insert/read failed");
  return { row, inserted: (inserted.rowCount ?? 0) > 0 };
}

export async function getTaskCommentByHash(
  adapter: DbAdapter,
  teamId: string,
  hash: string,
): Promise<TaskCommentRow | null> {
  const { rows } = await adapter.query<TaskCommentRow>(
    `SELECT * FROM task_comment_events WHERE team_id = ? AND hash = ?`,
    [teamId, hash],
  );
  return rows[0] ?? null;
}

export async function setTaskCommentEventSeq(
  adapter: DbAdapter,
  id: string,
  eventSeq: number,
): Promise<void> {
  await adapter.query(
    `UPDATE task_comment_events SET event_seq = ?, updated_at = ? WHERE id = ?`,
    [eventSeq, Date.now(), id],
  );
}

export async function updateTaskCommentRouting(
  adapter: DbAdapter,
  id: string,
  status: TaskCommentRoutingStatus,
  results: TaskCommentRoutingResult[],
): Promise<void> {
  await adapter.query(
    `UPDATE task_comment_events
     SET routing_status = ?, routing_results_json = ?, updated_at = ?
     WHERE id = ?`,
    [status, JSON.stringify(results), Date.now(), id],
  );
}

export async function listTaskCommentsForTask(
  adapter: DbAdapter,
  teamId: string,
  taskId: string,
): Promise<TaskCommentRow[]> {
  const { rows } = await adapter.query<TaskCommentRow>(
    `SELECT * FROM task_comment_events
     WHERE team_id = ? AND task_id = ?
     ORDER BY occurred_at ASC, created_at ASC`,
    [teamId, taskId],
  );
  return rows;
}

export async function listPendingTaskComments(
  adapter: DbAdapter,
  teamId: string,
  limit = 100,
): Promise<TaskCommentRow[]> {
  const { rows } = await adapter.query<TaskCommentRow>(
    `SELECT * FROM task_comment_events
     WHERE team_id = ? AND routing_status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
    [teamId, Math.max(1, Math.min(Math.floor(limit), 500))],
  );
  return rows;
}

export function taskCommentView(row: TaskCommentRow): TaskCommentView {
  return {
    id: row.id,
    task_id: row.task_id,
    task_uuid: row.task_uuid ?? null,
    task_name: row.task_name,
    task_title: row.task_title,
    source_path: row.source_path ?? null,
    source_line: row.source_line ?? null,
    text: row.comment_text,
    actor: row.actor,
    timestamp: new Date(row.occurred_at).toISOString(),
    hash: row.hash,
    event_seq: row.event_seq ?? null,
    routing_status: row.routing_status,
    routing_results: parseRoutingResults(row.routing_results_json),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export function parseRoutingResults(raw: string | null | undefined): TaskCommentRoutingResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRoutingResult) : [];
  } catch {
    return [];
  }
}

function isRoutingResult(v: unknown): v is TaskCommentRoutingResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.target_agent === "string" && typeof r.status === "string";
}

function normalizeCommentText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
