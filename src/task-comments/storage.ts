import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TaskRow } from "../db/types.js";

export const TASK_COMMENT_EVENT_TOPIC = "task_comment" as const;
export const TASK_COMMENT_DISPATCH_CHANNEL = "task_comment" as const;

export type TaskCommentRoutingStatus = "pending" | "routed" | "failed";
export type TaskCommentOperationState =
  | "recorded+routed"
  | "recorded-but-route-failed-with-retry"
  | "terminal-failure"
  | "not-recorded";

export interface TaskCommentRoutingResult {
  target_agent: string;
  target_agent_raw?: string | null;
  status: TaskCommentRoutingStatus;
  dispatch_phid: string | null;
  query_id: string | null;
  error: string | null;
  retryable?: boolean;
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
  client_op_id: string | null;
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
  source: string;
  timestamp: string;
  hash: string;
  client_op_id: string | null;
  event_seq: number | null;
  routing_status: TaskCommentRoutingStatus;
  operation_state: TaskCommentOperationState;
  visible_state: TaskCommentOperationState;
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
  clientOpId?: string | null;
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
      client_op_id TEXT,
      event_seq INTEGER,
      routing_status TEXT NOT NULL DEFAULT 'pending',
      routing_results_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(team_id, hash)
    )
  `);
  await addTaskCommentColumnIfMissing(adapter, "client_op_id", "TEXT");
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_comment_events_task_idx ON task_comment_events(team_id, task_id, occurred_at)`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_comment_events_status_idx ON task_comment_events(team_id, routing_status, updated_at)`);
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS task_comment_events_client_op_idx ON task_comment_events(team_id, client_op_id) WHERE client_op_id IS NOT NULL`);
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
  const clientOpId = normalizeClientOpId(input.clientOpId);
  if (clientOpId) {
    const existing = await getTaskCommentByClientOpId(adapter, input.teamId, clientOpId);
    if (existing) return { row: existing, inserted: false };
  }
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
        comment_text, actor, occurred_at, hash, client_op_id, event_seq, routing_status,
        routing_results_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', '[]', ?, ?)
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
      clientOpId,
      now,
      now,
    ],
  );

  const row = clientOpId
    ? await getTaskCommentByClientOpId(adapter, input.teamId, clientOpId)
    : await getTaskCommentByHash(adapter, input.teamId, hash);
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

export async function getTaskCommentByClientOpId(
  adapter: DbAdapter,
  teamId: string,
  clientOpId: string,
): Promise<TaskCommentRow | null> {
  const normalized = normalizeClientOpId(clientOpId);
  if (!normalized) return null;
  const { rows } = await adapter.query<TaskCommentRow>(
    `SELECT * FROM task_comment_events WHERE team_id = ? AND client_op_id = ?`,
    [teamId, normalized],
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
    [status, JSON.stringify(results.map(sanitizeRoutingResult)), Date.now(), id],
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

export function taskCommentOperationState(results: TaskCommentRoutingResult[]): TaskCommentOperationState {
  if (results.length === 0) return "recorded-but-route-failed-with-retry";
  if (results.length > 0 && results.every((r) => r.status === "routed")) return "recorded+routed";
  if (results.some((r) => r.retryable || r.status === "pending")) return "recorded-but-route-failed-with-retry";
  return "terminal-failure";
}

export function taskCommentView(row: TaskCommentRow): TaskCommentView {
  const routingResults = parseRoutingResults(row.routing_results_json);
  const operationState = taskCommentOperationState(routingResults);
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
    source: row.actor,
    timestamp: new Date(row.occurred_at).toISOString(),
    hash: row.hash,
    client_op_id: row.client_op_id ?? null,
    event_seq: row.event_seq ?? null,
    routing_status: row.routing_status,
    operation_state: operationState,
    visible_state: operationState,
    routing_results: routingResults,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export function parseRoutingResults(raw: string | null | undefined): TaskCommentRoutingResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRoutingResult).map(sanitizeRoutingResult) : [];
  } catch {
    return [];
  }
}

function sanitizeRoutingResult(result: TaskCommentRoutingResult): TaskCommentRoutingResult {
  return {
    target_agent: result.target_agent,
    target_agent_raw: result.target_agent_raw ?? null,
    status: result.status,
    dispatch_phid: result.dispatch_phid ?? null,
    query_id: result.query_id ?? null,
    error: sanitizePublicRoutingError(result.error, result.retryable),
    retryable: Boolean(result.retryable),
    routed_at: result.routed_at ?? null,
  };
}

function sanitizePublicRoutingError(error: string | null | undefined, retryable?: boolean): string | null {
  if (!error) return null;
  if (error === "scheduler_unavailable" || error === "target_agent_unresolved" || error === "task_not_found") return error;
  if (error.startsWith("agent_not_found:")) return "target_agent_unresolved";
  return retryable ? "route_failed_retryable" : "route_failed_terminal";
}

function isRoutingResult(v: unknown): v is TaskCommentRoutingResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.target_agent === "string" && typeof r.status === "string";
}

function normalizeCommentText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeClientOpId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

async function addTaskCommentColumnIfMissing(adapter: DbAdapter, column: string, definition: string): Promise<void> {
  try {
    await adapter.query(`ALTER TABLE task_comment_events ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      /duplicate column|already exists/i.test(message) ||
      /SQLITE_ERROR: duplicate column name/i.test(message)
    ) {
      return;
    }
    throw err;
  }
}
