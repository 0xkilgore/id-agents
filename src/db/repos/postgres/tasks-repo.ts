// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { TasksRepository } from '../../db-service.js';
import type { TaskRow } from '../../types.js';

export class PgTasksRepo implements TasksRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(task: TaskRow, eventScheduleIds?: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO tasks
         (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        task.id,
        task.name,
        task.uuid,
        task.team_id,
        task.title,
        task.description,
        task.status,
        task.created_by,
        task.owner,
        task.created_at,
        task.updated_at,
        task.completed_at,
        task.track ?? '(unassigned)',
      ],
    );

    if (eventScheduleIds && eventScheduleIds.length > 0) {
      const now = task.created_at;
      for (const scheduleId of eventScheduleIds) {
        await this.db.query(
          `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES ($1, $2, $3)`,
          [task.id, scheduleId, now],
        );
      }
    }
  }

  async getByName(name: string): Promise<TaskRow | null> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = $1`,
      [name],
    );
    return r.rows[0] || null;
  }

  async getByNameForTeam(name: string, teamId: string): Promise<TaskRow | null> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = $1 AND team_id = $2`,
      [name, teamId],
    );
    return r.rows[0] || null;
  }

  async getByUuidPrefix(prefix: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE uuid LIKE $1 ORDER BY updated_at DESC`,
      [`${prefix}%`],
    );
    return r.rows;
  }

  async list(filters?: {
    status?: 'todo' | 'doing' | 'done';
    owner?: string;
    teamId?: string | null;
  }): Promise<TaskRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters?.status) {
      clauses.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters?.owner) {
      clauses.push(`owner = $${idx++}`);
      params.push(filters.owner);
    }
    if (filters?.teamId !== undefined) {
      if (filters.teamId === null) {
        clauses.push('team_id IS NULL');
      } else {
        clauses.push(`team_id = $${idx++}`);
        params.push(filters.teamId);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks ${where} ORDER BY updated_at DESC`,
      params,
    );
    return r.rows;
  }

  async updateFields(
    taskId: string,
    fields: {
      team_id?: string | null;
      owner?: string | null;
      status?: 'todo' | 'doing' | 'done';
      title?: string;
      description?: string | null;
      completed_at?: number | null;
      updated_at: number;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    sets.push(`updated_at = $${idx++}`);
    params.push(fields.updated_at);

    if (fields.team_id !== undefined) { sets.push(`team_id = $${idx++}`); params.push(fields.team_id); }
    if (fields.owner !== undefined) { sets.push(`owner = $${idx++}`); params.push(fields.owner); }
    if (fields.status !== undefined) { sets.push(`status = $${idx++}`); params.push(fields.status); }
    if (fields.title !== undefined) { sets.push(`title = $${idx++}`); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push(`description = $${idx++}`); params.push(fields.description); }
    if (fields.completed_at !== undefined) { sets.push(`completed_at = $${idx++}`); params.push(fields.completed_at); }

    params.push(taskId);
    await this.db.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx}`,
      params,
    );
  }

  async claim(taskId: string, ownerId: string, updatedAt: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE tasks
       SET owner = $2, status = 'doing', updated_at = $3
       WHERE id = $1 AND owner IS NULL AND status = 'todo'`,
      [taskId, ownerId, updatedAt],
    );
    return r.rowCount > 0;
  }

  async delete(taskId: string): Promise<void> {
    await this.db.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  }

  async replaceEventLinks(taskId: string, scheduleIds: string[]): Promise<void> {
    await this.db.query(
      `DELETE FROM task_event_links WHERE task_id = $1`,
      [taskId],
    );
    const now = Math.floor(Date.now() / 1000);
    for (const scheduleId of scheduleIds) {
      await this.db.query(
        `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES ($1, $2, $3)`,
        [taskId, scheduleId, now],
      );
    }
  }

  async listEventLinksForTask(taskId: string): Promise<Array<{ schedule_id: string }>> {
    const r = await this.db.query<{ schedule_id: string }>(
      `SELECT schedule_id FROM task_event_links WHERE task_id = $1`,
      [taskId],
    );
    return r.rows;
  }

  async listTasksForSchedule(scheduleId: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN task_event_links tel ON tel.task_id = t.id
       WHERE tel.schedule_id = $1
       ORDER BY t.updated_at DESC`,
      [scheduleId],
    );
    return r.rows;
  }
}
