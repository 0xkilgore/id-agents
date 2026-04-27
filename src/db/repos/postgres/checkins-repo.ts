// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { CheckinsRepository } from '../../db-service.js';
import type {
  CheckinRow,
  CheckinStatus,
  MutableCheckinFields,
} from '../../types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const TERMINAL_STATUSES: ReadonlyArray<CheckinStatus> = ['closed', 'expired'];

export class PgCheckinsRepo implements CheckinsRepository {
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        row.id,
        row.team_id,
        row.owner_agent_id,
        row.created_by_agent_id,
        row.linked_task_id,
        row.interval_seconds,
        row.priority,
        row.status,
        row.close_when,
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
      `SELECT * FROM checkins WHERE id = $1 AND team_id = $2`,
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
    let sql = `SELECT * FROM checkins WHERE team_id = $1`;
    let paramIdx = 2;

    if (filters.owner !== undefined) {
      sql += ` AND owner_agent_id = $${paramIdx++}`;
      params.push(filters.owner);
    }
    if (filters.linkedTaskId !== undefined) {
      sql += ` AND linked_task_id = $${paramIdx++}`;
      params.push(filters.linkedTaskId);
    }
    if (filters.status !== undefined) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length > 0) {
        const placeholders = statuses.map(() => `$${paramIdx++}`).join(', ');
        sql += ` AND status IN (${placeholders})`;
        params.push(...statuses);
      }
    }
    if (filters.dueBefore !== undefined) {
      sql += ` AND next_fire_at IS NOT NULL AND next_fire_at <= $${paramIdx++}`;
      params.push(filters.dueBefore);
    }

    sql += filters.dueBefore !== undefined
      ? ` ORDER BY next_fire_at ASC`
      : ` ORDER BY updated_at DESC`;
    sql += ` LIMIT $${paramIdx++}`;
    params.push(clampLimit(filters.limit));

    const { rows } = await this.db.query<any>(sql, params);
    return rows.map(parseRow);
  }

  async updateFields(id: string, teamId: string, fields: MutableCheckinFields): Promise<void> {
    if (fields.linked_task_id !== undefined && fields.linked_task_id !== null) {
      await this.assertSameTeamTask(fields.linked_task_id, teamId);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    const push = (col: string, value: unknown) => {
      sets.push(`${col} = $${paramIdx++}`);
      params.push(value);
    };

    push('updated_at', fields.updated_at);
    if (fields.owner_agent_id !== undefined) push('owner_agent_id', fields.owner_agent_id);
    if (fields.linked_task_id !== undefined) push('linked_task_id', fields.linked_task_id);
    if (fields.interval_seconds !== undefined) push('interval_seconds', fields.interval_seconds);
    if (fields.priority !== undefined) push('priority', fields.priority);
    if (fields.status !== undefined) push('status', fields.status);
    if (fields.close_when !== undefined) push('close_when', fields.close_when);
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

    const whereId = `$${paramIdx++}`;
    const whereTeam = `$${paramIdx++}`;
    params.push(id, teamId);
    await this.db.query(
      `UPDATE checkins SET ${sets.join(', ')} WHERE id = ${whereId} AND team_id = ${whereTeam}`,
      params,
    );
  }

  async close(id: string, teamId: string, closedAt: number, reason: string): Promise<boolean> {
    const placeholders = TERMINAL_STATUSES.map((_, i) => `$${i + 6}`).join(', ');
    const { rowCount } = await this.db.query(
      `UPDATE checkins
         SET status = 'closed',
             closed_at = $1,
             closed_reason = $2,
             next_fire_at = NULL,
             snooze_until = NULL,
             updated_at = $3
       WHERE id = $4
         AND team_id = $5
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
    const placeholders = TERMINAL_STATUSES.map((_, i) => `$${i + 6}`).join(', ');
    const { rowCount } = await this.db.query(
      `UPDATE checkins
         SET status = 'closed',
             closed_at = $1,
             closed_reason = $2,
             next_fire_at = NULL,
             snooze_until = NULL,
             updated_at = $3
       WHERE linked_task_id = $4
         AND team_id = $5
         AND status NOT IN (${placeholders})`,
      [closedAt, reason, closedAt, taskId, teamId, ...TERMINAL_STATUSES],
    );
    return rowCount ?? 0;
  }

  async claimDue(teamId: string, now: number, limit: number): Promise<CheckinRow[]> {
    const { rows } = await this.db.query<any>(
      `SELECT * FROM checkins
         WHERE team_id = $1
           AND status IN ('active', 'snoozed')
           AND next_fire_at IS NOT NULL
           AND next_fire_at <= $2
         ORDER BY next_fire_at ASC
         LIMIT $3`,
      [teamId, now, clampLimit(limit)],
    );
    return rows.map(parseRow);
  }

  async delete(id: string, teamId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM checkins WHERE id = $1 AND team_id = $2`,
      [id, teamId],
    );
    return (rowCount ?? 0) > 0;
  }

  private async assertSameTeamTask(taskId: string, teamId: string): Promise<void> {
    const { rows } = await this.db.query<{ team_id: string | null }>(
      `SELECT team_id FROM tasks WHERE id = $1`,
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
    close_when: (row.close_when ?? {}) as Record<string, unknown>,
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
