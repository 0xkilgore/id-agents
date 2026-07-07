// SPDX-License-Identifier: MIT

import crypto from "crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import { parseJsonObject, stringifyJson } from "../db/db-json.js";

export type TaskNoteRoutingStatus = "queued" | "routed" | "route_failed" | "consumed";

export interface TaskNoteEventRow {
  note_id: string;
  team_id: string;
  task_ref: string;
  task_uuid: string | null;
  task_name: string | null;
  source_path: string | null;
  source_project: string | null;
  line_number: number | null;
  actor_ref: string;
  note_body: string;
  routing_status: TaskNoteRoutingStatus;
  target_agent: string | null;
  route_error: string | null;
  dispatch_phid: string | null;
  query_id: string | null;
  consumed_by: string | null;
  consumed_at: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: Record<string, unknown>;
}

export interface CreateTaskNoteInput {
  team_id: string;
  task_ref: string;
  task_uuid?: string | null;
  task_name?: string | null;
  source_path?: string | null;
  source_project?: string | null;
  line_number?: number | null;
  actor_ref: string;
  note_body: string;
  target_agent?: string | null;
  routing_status?: TaskNoteRoutingStatus;
  route_error?: string | null;
  metadata?: Record<string, unknown>;
  nowIso?: string;
}

export async function migrateTaskNoteTables(adapter: DbAdapter): Promise<void> {
  if (adapter.dialect === "postgres") {
    await adapter.query(`
      CREATE TABLE IF NOT EXISTS task_note_events (
        note_id text PRIMARY KEY,
        team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        task_ref text NOT NULL,
        task_uuid text,
        task_name text,
        source_path text,
        source_project text,
        line_number integer,
        actor_ref text NOT NULL,
        note_body text NOT NULL,
        routing_status text NOT NULL,
        target_agent text,
        route_error text,
        dispatch_phid text,
        query_id text,
        consumed_by text,
        consumed_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await adapter.query(`CREATE INDEX IF NOT EXISTS task_note_events_team_status_idx ON task_note_events(team_id, routing_status, created_at);`);
    await adapter.query(`CREATE INDEX IF NOT EXISTS task_note_events_team_task_idx ON task_note_events(team_id, task_ref, created_at);`);
    await addColumnIfMissing(adapter, "task_note_events", "dispatch_phid", "text");
    await addColumnIfMissing(adapter, "task_note_events", "query_id", "text");
    return;
  }

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS task_note_events (
      note_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      task_ref TEXT NOT NULL,
      task_uuid TEXT,
      task_name TEXT,
      source_path TEXT,
      source_project TEXT,
      line_number INTEGER,
      actor_ref TEXT NOT NULL,
      note_body TEXT NOT NULL,
      routing_status TEXT NOT NULL,
      target_agent TEXT,
      route_error TEXT,
      dispatch_phid TEXT,
      query_id TEXT,
      consumed_by TEXT,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_note_events_team_status_idx ON task_note_events(team_id, routing_status, created_at);`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_note_events_team_task_idx ON task_note_events(team_id, task_ref, created_at);`);
  await addColumnIfMissing(adapter, "task_note_events", "dispatch_phid", "TEXT");
  await addColumnIfMissing(adapter, "task_note_events", "query_id", "TEXT");
}

export function taskNoteId(input: {
  team_id: string;
  task_ref: string;
  source_path?: string | null;
  source_project?: string | null;
  line_number?: number | null;
  actor_ref: string;
  note_body: string;
}): string {
  const seed = [
    "task-note:v1",
    input.team_id,
    input.task_ref,
    input.source_path ?? "",
    input.source_project ?? "",
    input.line_number ?? "",
    input.actor_ref,
    input.note_body.trim(),
  ].join("\n");
  return `tnote_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

export async function createTaskNoteEvent(
  adapter: DbAdapter,
  input: CreateTaskNoteInput,
): Promise<{ event: TaskNoteEventRow; idempotent: boolean }> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const note_id = taskNoteId(input);
  const params = [
    note_id,
    input.team_id,
    input.task_ref,
    input.task_uuid ?? null,
    input.task_name ?? null,
    input.source_path ?? null,
    input.source_project ?? null,
    input.line_number ?? null,
    input.actor_ref,
    input.note_body.trim(),
    input.routing_status ?? "queued",
    input.target_agent ?? null,
    input.route_error ?? null,
    nowIso,
    nowIso,
    stringifyJson(input.metadata ?? {}),
  ];

  if (adapter.dialect === "postgres") {
    const inserted = await adapter.query(
      `INSERT INTO task_note_events
        (note_id, team_id, task_ref, task_uuid, task_name, source_path, source_project, line_number,
         actor_ref, note_body, routing_status, target_agent, route_error, created_at, updated_at, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
       ON CONFLICT (note_id) DO NOTHING`,
      params,
    );
    const event = await getTaskNoteEvent(adapter, input.team_id, note_id);
    return { event: event!, idempotent: (inserted.rowCount ?? 0) === 0 };
  }

  const inserted = await adapter.query(
    `INSERT OR IGNORE INTO task_note_events
      (note_id, team_id, task_ref, task_uuid, task_name, source_path, source_project, line_number,
       actor_ref, note_body, routing_status, target_agent, route_error, created_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params,
  );
  const event = await getTaskNoteEvent(adapter, input.team_id, note_id);
  return { event: event!, idempotent: (inserted.rowCount ?? 0) === 0 };
}

export async function listTaskNoteEvents(
  adapter: DbAdapter,
  opts: { teamId: string; status?: string; limit?: number },
): Promise<TaskNoteEventRow[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
  const params: unknown[] = [opts.teamId];
  let sql = `SELECT * FROM task_note_events WHERE team_id = ${adapter.dialect === "postgres" ? "$1" : "?"}`;
  if (opts.status) {
    params.push(opts.status);
    sql += adapter.dialect === "postgres" ? ` AND routing_status = $2` : ` AND routing_status = ?`;
  }
  params.push(limit);
  sql += adapter.dialect === "postgres"
    ? ` ORDER BY created_at ASC LIMIT $${params.length}`
    : ` ORDER BY created_at ASC LIMIT ?`;
  const { rows } = await adapter.query<any>(sql, params);
  return rows.map(parseTaskNoteRow);
}

export async function updateTaskNoteRouting(
  adapter: DbAdapter,
  opts: {
    teamId: string;
    noteId: string;
    routingStatus: TaskNoteRoutingStatus;
    targetAgent?: string | null;
    routeError?: string | null;
    dispatchPhid?: string | null;
    queryId?: string | null;
    nowIso?: string;
  },
): Promise<TaskNoteEventRow | null> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const params = [
    opts.routingStatus,
    opts.targetAgent ?? null,
    opts.routeError ?? null,
    opts.dispatchPhid ?? null,
    opts.queryId ?? null,
    nowIso,
    opts.teamId,
    opts.noteId,
  ];
  const sql = adapter.dialect === "postgres"
    ? `UPDATE task_note_events
       SET routing_status = $1, target_agent = $2, route_error = $3, dispatch_phid = $4, query_id = $5, updated_at = $6
       WHERE team_id = $7 AND note_id = $8
       RETURNING *`
    : `UPDATE task_note_events
       SET routing_status = ?, target_agent = ?, route_error = ?, dispatch_phid = ?, query_id = ?, updated_at = ?
       WHERE team_id = ? AND note_id = ?
       RETURNING *`;
  const { rows } = await adapter.query<any>(sql, params);
  return rows[0] ? parseTaskNoteRow(rows[0]) : null;
}

export async function consumeTaskNoteEvent(
  adapter: DbAdapter,
  opts: { teamId: string; noteId: string; consumer: string; nowIso?: string },
): Promise<{ event: TaskNoteEventRow | null; claimed: boolean }> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const params = adapter.dialect === "postgres"
    ? [nowIso, opts.consumer, opts.teamId, opts.noteId]
    : [nowIso, opts.consumer, opts.teamId, opts.noteId];
  const sql = adapter.dialect === "postgres"
    ? `UPDATE task_note_events
       SET routing_status = 'consumed', consumed_at = $1, consumed_by = $2, updated_at = $1
       WHERE team_id = $3 AND note_id = $4 AND consumed_at IS NULL AND routing_status IN ('queued', 'routed', 'route_failed')
       RETURNING *`
    : `UPDATE task_note_events
       SET routing_status = 'consumed', consumed_at = ?, consumed_by = ?, updated_at = ?
       WHERE team_id = ? AND note_id = ? AND consumed_at IS NULL AND routing_status IN ('queued', 'routed', 'route_failed')
       RETURNING *`;
  const sqliteParams = [nowIso, opts.consumer, nowIso, opts.teamId, opts.noteId];
  const { rows } = await adapter.query<any>(sql, adapter.dialect === "postgres" ? params : sqliteParams);
  if (rows[0]) return { event: parseTaskNoteRow(rows[0]), claimed: true };
  const event = await getTaskNoteEvent(adapter, opts.teamId, opts.noteId);
  return { event, claimed: false };
}

async function getTaskNoteEvent(adapter: DbAdapter, teamId: string, noteId: string): Promise<TaskNoteEventRow | null> {
  const sql = adapter.dialect === "postgres"
    ? `SELECT * FROM task_note_events WHERE team_id = $1 AND note_id = $2`
    : `SELECT * FROM task_note_events WHERE team_id = ? AND note_id = ?`;
  const { rows } = await adapter.query<any>(sql, [teamId, noteId]);
  return rows[0] ? parseTaskNoteRow(rows[0]) : null;
}

function parseTaskNoteRow(row: any): TaskNoteEventRow {
  return {
    note_id: row.note_id,
    team_id: row.team_id,
    task_ref: row.task_ref,
    task_uuid: row.task_uuid ?? null,
    task_name: row.task_name ?? null,
    source_path: row.source_path ?? null,
    source_project: row.source_project ?? null,
    line_number: row.line_number == null ? null : Number(row.line_number),
    actor_ref: row.actor_ref,
    note_body: row.note_body,
    routing_status: row.routing_status,
    target_agent: row.target_agent ?? null,
    route_error: row.route_error ?? null,
    dispatch_phid: row.dispatch_phid ?? null,
    query_id: row.query_id ?? null,
    consumed_by: row.consumed_by ?? null,
    consumed_at: row.consumed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata_json: parseJsonObject(row.metadata_json),
  };
}

async function addColumnIfMissing(adapter: DbAdapter, table: string, column: string, type: string): Promise<void> {
  if (adapter.dialect === "postgres") {
    await adapter.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    return;
  }

  const { rows } = await adapter.query<any>(`SELECT name FROM pragma_table_info('${table}')`);
  if (!rows.some((row) => row.name === column)) {
    await adapter.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
