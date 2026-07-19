// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { CheckinsRepository } from '../../db-service.js';
import type {
  CheckinRow,
  CheckinStatus,
  MutableCheckinFields,
  TaskRow,
} from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';
import { CANONICAL_TASK_TERMINAL_REASON, classifyCheckinRecurrenceSuppression } from '../../../checkins/recurrence-suppression.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const TERMINAL_STATUSES: ReadonlyArray<CheckinStatus> = ['closed', 'expired'];
const RECORD_ONLY_CHAIN_THRESHOLD = 3;

export class SqliteCheckinsRepo implements CheckinsRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(row: CheckinRow): Promise<void> {
    if (row.linked_task_id !== null) {
      await this.assertSameTeamTask(row.linked_task_id, row.team_id);
    }
    await this.db.query(
      `INSERT INTO checkins
         (id, team_id, owner_agent_id, created_by_agent_id, linked_task_id,
          interval_seconds, priority, status, close_when, max_iterations,
          iteration_count, next_fire_at, snooze_until, ttl_expires_at,
          last_fire_at, last_event_seq, note, created_at, updated_at,
          closed_at, closed_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.team_id,
        row.owner_agent_id,
        row.created_by_agent_id,
        row.linked_task_id,
        row.interval_seconds,
        row.priority,
        row.status,
        stringifyJson(row.close_when),
        row.max_iterations,
        row.iteration_count,
        row.next_fire_at,
        row.snooze_until,
        row.ttl_expires_at,
        row.last_fire_at,
        row.last_event_seq,
        row.note,
        row.created_at,
        row.updated_at,
        row.closed_at,
        row.closed_reason,
      ],
    );
  }

  async get(id: string, teamId: string): Promise<CheckinRow | null> {
    const { rows } = await this.db.query<any>(
      `SELECT * FROM checkins WHERE id = ? AND team_id = ?`,
      [id, teamId],
    );
    return rows[0] ? parseRow(rows[0]) : null;
  }

  async list(filters: {
    teamId: string;
    owner?: string;
    linkedTaskId?: string;
    status?: CheckinStatus | CheckinStatus[];
    dueBefore?: number;
    limit?: number;
  }): Promise<CheckinRow[]> {
    const params: unknown[] = [filters.teamId];
    let sql = `SELECT * FROM checkins WHERE team_id = ?`;

    if (filters.owner !== undefined) {
      sql += ` AND owner_agent_id = ?`;
      params.push(filters.owner);
    }
    if (filters.linkedTaskId !== undefined) {
      sql += ` AND linked_task_id = ?`;
      params.push(filters.linkedTaskId);
    }
    if (filters.status !== undefined) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length > 0) {
        const placeholders = statuses.map(() => '?').join(', ');
        sql += ` AND status IN (${placeholders})`;
        params.push(...statuses);
      }
    }
    if (filters.dueBefore !== undefined) {
      sql += ` AND next_fire_at IS NOT NULL AND next_fire_at <= ?`;
      params.push(filters.dueBefore);
    }

    sql += filters.dueBefore !== undefined
      ? ` ORDER BY next_fire_at ASC`
      : ` ORDER BY updated_at DESC`;
    sql += ` LIMIT ?`;
    params.push(clampLimit(filters.limit));

    const { rows } = await this.db.query<any>(sql, params);
    return rows.map(parseRow);
  }

  async updateFields(id: string, teamId: string, fields: MutableCheckinFields): Promise<void> {
    if (fields.linked_task_id !== undefined && fields.linked_task_id !== null) {
      await this.assertSameTeamTask(fields.linked_task_id, teamId);
    }

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [fields.updated_at];

    const push = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };

    if (fields.owner_agent_id !== undefined) push('owner_agent_id', fields.owner_agent_id);
    if (fields.linked_task_id !== undefined) push('linked_task_id', fields.linked_task_id);
    if (fields.interval_seconds !== undefined) push('interval_seconds', fields.interval_seconds);
    if (fields.priority !== undefined) push('priority', fields.priority);
    if (fields.status !== undefined) push('status', fields.status);
    if (fields.close_when !== undefined) push('close_when', stringifyJson(fields.close_when));
    if (fields.max_iterations !== undefined) push('max_iterations', fields.max_iterations);
    if (fields.iteration_count !== undefined) push('iteration_count', fields.iteration_count);
    if (fields.next_fire_at !== undefined) push('next_fire_at', fields.next_fire_at);
    if (fields.snooze_until !== undefined) push('snooze_until', fields.snooze_until);
    if (fields.ttl_expires_at !== undefined) push('ttl_expires_at', fields.ttl_expires_at);
    if (fields.last_fire_at !== undefined) push('last_fire_at', fields.last_fire_at);
    if (fields.last_event_seq !== undefined) push('last_event_seq', fields.last_event_seq);
    if (fields.note !== undefined) push('note', fields.note);
    if (fields.closed_at !== undefined) push('closed_at', fields.closed_at);
    if (fields.closed_reason !== undefined) push('closed_reason', fields.closed_reason);

    params.push(id, teamId);
    await this.db.query(
      `UPDATE checkins SET ${sets.join(', ')} WHERE id = ? AND team_id = ?`,
      params,
    );
  }

  async close(id: string, teamId: string, closedAt: number, reason: string): Promise<boolean> {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const { rowCount } = await this.db.query(
      `UPDATE checkins
         SET status = 'closed',
             closed_at = ?,
             closed_reason = ?,
             next_fire_at = NULL,
             snooze_until = NULL,
             updated_at = ?
       WHERE id = ?
         AND team_id = ?
         AND status NOT IN (${placeholders})`,
      [closedAt, reason, closedAt, id, teamId, ...TERMINAL_STATUSES],
    );
    return (rowCount ?? 0) > 0;
  }

  async closeForTerminalTask(
    taskId: string,
    teamId: string,
    closedAt: number,
    reason: string,
  ): Promise<number> {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const { rowCount } = await this.db.query(
      `UPDATE checkins
         SET status = 'closed',
             closed_at = ?,
             closed_reason = ?,
             next_fire_at = NULL,
             snooze_until = NULL,
             updated_at = ?
       WHERE linked_task_id = ?
         AND team_id = ?
         AND status NOT IN (${placeholders})`,
      [closedAt, reason, closedAt, taskId, teamId, ...TERMINAL_STATUSES],
    );
    return rowCount ?? 0;
  }

  async claimDue(teamId: string, now: number, limit: number): Promise<CheckinRow[]> {
    // Reconcile linked checkins before selecting work. This is deliberately
    // done at the claim boundary so a terminal/stale row can never escape to
    // the due service and create one more receipt.
    await this.db.query(
      `UPDATE checkins
         SET status = 'closed',
             closed_at = ?,
             closed_reason = 'canonical_task_terminal',
             next_fire_at = NULL,
             snooze_until = NULL,
             updated_at = ?
       WHERE team_id = ?
         AND status IN ('active', 'snoozed')
         AND next_fire_at IS NOT NULL
         AND next_fire_at <= ?
         AND linked_task_id IN (
           SELECT id FROM tasks WHERE team_id = ? AND status = 'done'
         )`,
      [now, now, teamId, now, teamId],
    );

    await this.db.query(
      `UPDATE checkins
         SET status = 'closed',
             closed_at = ?,
             closed_reason = 'record_only_chain_exhausted',
             next_fire_at = NULL,
             snooze_until = NULL,
             updated_at = ?
       WHERE team_id = ?
         AND status IN ('active', 'snoozed')
         AND next_fire_at IS NOT NULL
         AND next_fire_at <= ?
         AND iteration_count >= ?
         AND last_fire_at IS NOT NULL
         AND linked_task_id IN (
           SELECT id FROM tasks
            WHERE team_id = ?
              AND status = 'doing'
              AND (updated_at * 1000) <= checkins.last_fire_at
         )`,
      [now, now, teamId, now, RECORD_ONLY_CHAIN_THRESHOLD, teamId],
    );

    const { rows } = await this.db.query<any>(
      `SELECT * FROM checkins
         WHERE team_id = ?
           AND status IN ('active', 'snoozed')
           AND next_fire_at IS NOT NULL
           AND next_fire_at <= ?
         ORDER BY next_fire_at ASC
         LIMIT ?`,
      [teamId, now, clampLimit(limit)],
    );
    const due = rows.map(parseRow);
    const taskMap = await this.loadLinkedTasks(due);
    const claimed: CheckinRow[] = [];
    for (const row of due) {
      const task = row.linked_task_id ? taskMap.get(row.linked_task_id) ?? null : null;
      const suppressionReason = task ? classifyCheckinRecurrenceSuppression(task) : null;
      if (suppressionReason) {
        await this.close(row.id, row.team_id, now, suppressionReason);
        continue;
      }
      if (task && this.shouldExhaustRecordOnlyChain(row, task)) {
        await this.close(row.id, row.team_id, now, 'record_only_chain_exhausted');
        continue;
      }
      claimed.push(row);
    }
    return claimed;
  }

  private shouldExhaustRecordOnlyChain(row: CheckinRow, task: Pick<TaskRow, "status" | "updated_at">): boolean {
    return task.status === 'doing'
      && row.iteration_count >= RECORD_ONLY_CHAIN_THRESHOLD
      && row.last_fire_at !== null
      && (task.updated_at * 1000) <= row.last_fire_at;
  }

  private async loadLinkedTasks(rows: readonly CheckinRow[]): Promise<Map<string, TaskRow>> {
    const ids = [...new Set(rows.map((row) => row.linked_task_id).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const { rows: taskRows } = await this.db.query<TaskRow>(
      `SELECT id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track
         FROM tasks
        WHERE id IN (${placeholders})`,
      ids,
    );
    return new Map(taskRows.map((task) => [task.id, task]));
  }

  async delete(id: string, teamId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM checkins WHERE id = ? AND team_id = ?`,
      [id, teamId],
    );
    return (rowCount ?? 0) > 0;
  }

  private async assertSameTeamTask(taskId: string, teamId: string): Promise<void> {
    const { rows } = await this.db.query<{ team_id: string | null }>(
      `SELECT team_id FROM tasks WHERE id = ?`,
      [taskId],
    );
    if (rows.length === 0) {
      throw new Error(`linked_task_id "${taskId}" not found`);
    }
    if (rows[0].team_id !== teamId) {
      throw new Error(
        `linked_task_id "${taskId}" belongs to a different team (cross-team checkin links are not allowed)`,
      );
    }
  }
}

function parseRow(row: any): CheckinRow {
  return {
    id: row.id,
    team_id: row.team_id,
    owner_agent_id: row.owner_agent_id ?? null,
    created_by_agent_id: row.created_by_agent_id ?? null,
    linked_task_id: row.linked_task_id ?? null,
    interval_seconds: Number(row.interval_seconds),
    priority: row.priority,
    status: row.status,
    close_when: parseJsonObject(row.close_when),
    max_iterations: row.max_iterations === null || row.max_iterations === undefined
      ? null
      : Number(row.max_iterations),
    iteration_count: Number(row.iteration_count ?? 0),
    next_fire_at: row.next_fire_at === null || row.next_fire_at === undefined
      ? null
      : Number(row.next_fire_at),
    snooze_until: row.snooze_until === null || row.snooze_until === undefined
      ? null
      : Number(row.snooze_until),
    ttl_expires_at: row.ttl_expires_at === null || row.ttl_expires_at === undefined
      ? null
      : Number(row.ttl_expires_at),
    last_fire_at: row.last_fire_at === null || row.last_fire_at === undefined
      ? null
      : Number(row.last_fire_at),
    last_event_seq: row.last_event_seq === null || row.last_event_seq === undefined
      ? null
      : Number(row.last_event_seq),
    note: row.note ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    closed_at: row.closed_at === null || row.closed_at === undefined
      ? null
      : Number(row.closed_at),
    closed_reason: row.closed_reason ?? null,
  };
}

function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
