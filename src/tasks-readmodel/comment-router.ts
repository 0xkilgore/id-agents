import { createHash } from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TaskRow } from "../db/types.js";

export const TASK_COMMENT_DISPATCH_CHANNEL = "task_comment" as const;
export const TASK_COMMENT_EVENT_TOPIC = "task:comment" as const;

export type TaskCommentRouteState = "pending" | "routed" | "held" | "failed";

export interface TaskCommentEvent {
  event_id: string;
  dedupe_key: string;
  team_id: string;
  task_id: string;
  task_uuid: string;
  task_name: string;
  task_title: string;
  source_path: string | null;
  source_line: number | null;
  actor: string;
  comment_text: string;
  comment_hash: string;
  route_state: TaskCommentRouteState;
  held_reason: string | null;
  target_agent: string | null;
  target_agent_raw: string | null;
  dispatch_phid: string | null;
  query_id: string | null;
  artifact_link: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskCommentEnqueueFn {
  (input: {
    to_agent: string;
    from_actor: string;
    message: string;
    subject?: string;
    priority?: number;
    channel?: string;
    team_id?: string;
  }): Promise<{ query_id: string; dispatch_phid: string; status: "queued" }>;
}

export interface AppendTaskCommentInput {
  adapter: DbAdapter;
  enqueue?: TaskCommentEnqueueFn;
  teamId: string;
  task: TaskRow;
  actor: string;
  commentText: string;
  sourcePath?: string | null;
  sourceLine?: number | null;
  nowMs?: number;
}

export type AppendTaskCommentResult =
  | { event: TaskCommentEvent; deduped: boolean; routed: true }
  | { event: TaskCommentEvent; deduped: boolean; routed: false; held_reason: string }
  | { event: TaskCommentEvent; deduped: boolean; routed: false; error: string };

export async function migrateTaskCommentTables(adapter: DbAdapter): Promise<void> {
  const exec = async (sql: string) => {
    if (adapter.dialect === "sqlite" && typeof (adapter as unknown as { exec?: (s: string) => void }).exec === "function") {
      (adapter as unknown as { exec: (s: string) => void }).exec(sql);
    } else {
      await adapter.query(sql);
    }
  };
  const pk = adapter.dialect === "postgres" ? "TEXT PRIMARY KEY" : "TEXT PRIMARY KEY";

  await exec(`
    CREATE TABLE IF NOT EXISTS task_comment_events (
      event_id ${pk},
      dedupe_key TEXT NOT NULL UNIQUE,
      team_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_uuid TEXT NOT NULL,
      task_name TEXT NOT NULL,
      task_title TEXT NOT NULL,
      source_path TEXT,
      source_line INTEGER,
      actor TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      comment_hash TEXT NOT NULL,
      route_state TEXT NOT NULL,
      held_reason TEXT,
      target_agent TEXT,
      target_agent_raw TEXT,
      dispatch_phid TEXT,
      query_id TEXT,
      artifact_link TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await exec(`CREATE INDEX IF NOT EXISTS task_comment_events_task_idx ON task_comment_events(team_id, task_id, created_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS task_comment_events_state_idx ON task_comment_events(team_id, route_state, updated_at DESC)`);
}

export async function appendAndRouteTaskComment(input: AppendTaskCommentInput): Promise<AppendTaskCommentResult> {
  await migrateTaskCommentTables(input.adapter);
  const nowMs = input.nowMs ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  const text = input.commentText.trim();
  if (!text) throw new Error("comment_text_required");

  const comment_hash = hashText(text);
  const dedupe_key = taskCommentDedupeKey({
    teamId: input.teamId,
    taskUuid: input.task.uuid || input.task.id,
    sourcePath: input.sourcePath ?? null,
    sourceLine: input.sourceLine ?? null,
    actor: input.actor,
    commentHash: comment_hash,
  });

  const existing = await getTaskCommentByDedupeKey(input.adapter, dedupe_key);
  if (existing) {
    return stateToResult(existing, true);
  }

  const event: TaskCommentEvent = {
    event_id: `task_comment_${dedupe_key.slice(0, 20)}`,
    dedupe_key,
    team_id: input.teamId,
    task_id: input.task.id,
    task_uuid: input.task.uuid || input.task.id,
    task_name: input.task.name,
    task_title: input.task.title,
    source_path: input.sourcePath ?? null,
    source_line: input.sourceLine ?? null,
    actor: input.actor,
    comment_text: text,
    comment_hash,
    route_state: "pending",
    held_reason: null,
    target_agent: null,
    target_agent_raw: input.task.owner,
    dispatch_phid: null,
    query_id: null,
    artifact_link: null,
    created_at: now,
    updated_at: now,
  };
  await insertTaskCommentEvent(input.adapter, event);

  const owner = input.task.owner?.trim() || null;
  if (!owner) {
    const held = await updateTaskCommentRoute(input.adapter, event.event_id, {
      route_state: "held",
      held_reason: "task_owner_unknown",
      target_agent: null,
      target_agent_raw: input.task.owner ?? null,
      updated_at: now,
    });
    return { event: held, deduped: false, routed: false, held_reason: "task_owner_unknown" };
  }

  if (!input.enqueue) {
    const held = await updateTaskCommentRoute(input.adapter, event.event_id, {
      route_state: "held",
      held_reason: "scheduler_unavailable",
      target_agent: owner,
      target_agent_raw: input.task.owner ?? null,
      updated_at: now,
    });
    return { event: held, deduped: false, routed: false, held_reason: "scheduler_unavailable" };
  }

  try {
    const receipt = await input.enqueue({
      to_agent: owner,
      from_actor: input.actor,
      subject: taskCommentSubject(input.task),
      message: taskCommentMessage(input.task, event),
      priority: 5,
      channel: TASK_COMMENT_DISPATCH_CHANNEL,
      team_id: input.teamId,
    });
    const routed = await updateTaskCommentRoute(input.adapter, event.event_id, {
      route_state: "routed",
      target_agent: owner,
      target_agent_raw: input.task.owner ?? null,
      dispatch_phid: receipt.dispatch_phid,
      query_id: receipt.query_id,
      updated_at: now,
    });
    return { event: routed, deduped: false, routed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await updateTaskCommentRoute(input.adapter, event.event_id, {
      route_state: "failed",
      held_reason: message,
      target_agent: owner,
      target_agent_raw: input.task.owner ?? null,
      updated_at: now,
    });
    return { event: failed, deduped: false, routed: false, error: message };
  }
}

export async function getTaskCommentByDedupeKey(adapter: DbAdapter, dedupeKey: string): Promise<TaskCommentEvent | null> {
  const { rows } = await adapter.query<TaskCommentEvent>(
    `SELECT * FROM task_comment_events WHERE dedupe_key = ? LIMIT 1`,
    [dedupeKey],
  );
  return rows[0] ? parseTaskCommentEvent(rows[0]) : null;
}

export async function listTaskCommentEvents(
  adapter: DbAdapter,
  teamId: string,
  taskId: string,
): Promise<TaskCommentEvent[]> {
  await migrateTaskCommentTables(adapter);
  const { rows } = await adapter.query<TaskCommentEvent>(
    `SELECT * FROM task_comment_events
      WHERE team_id = ? AND task_id = ?
      ORDER BY created_at DESC, event_id DESC`,
    [teamId, taskId],
  );
  return rows.map(parseTaskCommentEvent);
}

export async function listPendingTaskCommentEvents(
  adapter: DbAdapter,
  teamId: string,
  limit = 100,
): Promise<TaskCommentEvent[]> {
  await migrateTaskCommentTables(adapter);
  const { rows } = await adapter.query<TaskCommentEvent>(
    `SELECT * FROM task_comment_events
      WHERE team_id = ? AND route_state IN ('pending', 'held', 'failed')
      ORDER BY updated_at ASC, event_id ASC
      LIMIT ?`,
    [teamId, Math.max(1, Math.min(limit, 500))],
  );
  return rows.map(parseTaskCommentEvent);
}

export function taskCommentDedupeKey(input: {
  teamId: string;
  taskUuid: string;
  sourcePath: string | null;
  sourceLine: number | null;
  actor: string;
  commentHash: string;
}): string {
  return createHash("sha256")
    .update([
      input.teamId,
      input.taskUuid,
      input.sourcePath ?? "",
      input.sourceLine == null ? "" : String(input.sourceLine),
      input.actor,
      input.commentHash,
    ].join("\0"))
    .digest("hex");
}

function hashText(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

function taskCommentSubject(task: TaskRow): string {
  return `Task comment on "${task.title}"`.slice(0, 80);
}

function taskCommentMessage(task: TaskRow, event: TaskCommentEvent): string {
  const location = event.source_path
    ? `Source: \`${event.source_path}${event.source_line == null ? "" : `:${event.source_line}`}\``
    : null;
  return [
    `${event.actor} left a comment on task **${task.title}** (\`${task.name}\`).`,
    "",
    location,
    "",
    "## Comment",
    "",
    event.comment_text,
    "",
    "## What to do",
    "",
    "Handle the task note, update the task/artifact as needed, and close the loop through the manager.",
  ].filter((line): line is string => line !== null).join("\n");
}

async function insertTaskCommentEvent(adapter: DbAdapter, event: TaskCommentEvent): Promise<void> {
  await adapter.query(
    `INSERT INTO task_comment_events
       (event_id, dedupe_key, team_id, task_id, task_uuid, task_name, task_title,
        source_path, source_line, actor, comment_text, comment_hash, route_state,
        held_reason, target_agent, target_agent_raw, dispatch_phid, query_id,
        artifact_link, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.event_id,
      event.dedupe_key,
      event.team_id,
      event.task_id,
      event.task_uuid,
      event.task_name,
      event.task_title,
      event.source_path,
      event.source_line,
      event.actor,
      event.comment_text,
      event.comment_hash,
      event.route_state,
      event.held_reason,
      event.target_agent,
      event.target_agent_raw,
      event.dispatch_phid,
      event.query_id,
      event.artifact_link,
      event.created_at,
      event.updated_at,
    ],
  );
}

async function updateTaskCommentRoute(
  adapter: DbAdapter,
  eventId: string,
  fields: Partial<Pick<TaskCommentEvent, "route_state" | "held_reason" | "target_agent" | "target_agent_raw" | "dispatch_phid" | "query_id" | "artifact_link" | "updated_at">>,
): Promise<TaskCommentEvent> {
  await adapter.query(
    `UPDATE task_comment_events
        SET route_state = COALESCE(?, route_state),
            held_reason = ?,
            target_agent = COALESCE(?, target_agent),
            target_agent_raw = COALESCE(?, target_agent_raw),
            dispatch_phid = COALESCE(?, dispatch_phid),
            query_id = COALESCE(?, query_id),
            artifact_link = COALESCE(?, artifact_link),
            updated_at = COALESCE(?, updated_at)
      WHERE event_id = ?`,
    [
      fields.route_state ?? null,
      fields.held_reason ?? null,
      fields.target_agent ?? null,
      fields.target_agent_raw ?? null,
      fields.dispatch_phid ?? null,
      fields.query_id ?? null,
      fields.artifact_link ?? null,
      fields.updated_at ?? null,
      eventId,
    ],
  );
  const { rows } = await adapter.query<TaskCommentEvent>(
    `SELECT * FROM task_comment_events WHERE event_id = ? LIMIT 1`,
    [eventId],
  );
  if (!rows[0]) throw new Error(`task_comment_event_not_found:${eventId}`);
  return parseTaskCommentEvent(rows[0]);
}

function parseTaskCommentEvent(row: TaskCommentEvent): TaskCommentEvent {
  return {
    ...row,
    source_line: row.source_line == null ? null : Number(row.source_line),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function stateToResult(event: TaskCommentEvent, deduped: boolean): AppendTaskCommentResult {
  if (event.route_state === "routed") return { event, deduped, routed: true };
  if (event.route_state === "failed") {
    return { event, deduped, routed: false, error: event.held_reason ?? "route_failed" };
  }
  return {
    event,
    deduped,
    routed: false,
    held_reason: event.held_reason ?? (event.route_state === "pending" ? "pending" : "held"),
  };
}
