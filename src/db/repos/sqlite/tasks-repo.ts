// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { TasksRepository } from '../../db-service.js';
import type { TaskRow } from '../../types.js';

export class SqliteTasksRepo implements TasksRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(task: TaskRow, eventScheduleIds?: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO tasks
         (id, name, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.name,
        task.team_id,
        task.title,
        task.description,
        task.status,
        task.created_by,
        task.owner,
        task.created_at,
        task.updated_at,
        task.completed_at,
      ],
    );

    if (eventScheduleIds && eventScheduleIds.length > 0) {
      const now = task.created_at;
      for (const scheduleId of eventScheduleIds) {
        await this.db.query(
          `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES (?, ?, ?)`,
          [task.id, scheduleId, now],
        );
      }
    }
  }

  async getByName(name: string): Promise<TaskRow | null> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = ?`,
      [name],
    );
    return rows[0] || null;
  }

  async list(filters?: {
    status?: 'todo' | 'doing' | 'done';
    owner?: string;
    teamId?: string | null;
  }): Promise<TaskRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.owner) {
      clauses.push('owner = ?');
      params.push(filters.owner);
    }
    if (filters?.teamId !== undefined) {
      if (filters.teamId === null) {
        clauses.push('team_id IS NULL');
      } else {
        clauses.push('team_id = ?');
        params.push(filters.teamId);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks ${where} ORDER BY updated_at DESC`,
      params,
    );
    return rows;
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
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [fields.updated_at];

    if (fields.team_id !== undefined) { sets.push('team_id = ?'); params.push(fields.team_id); }
    if (fields.owner !== undefined) { sets.push('owner = ?'); params.push(fields.owner); }
    if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
    if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
    if (fields.completed_at !== undefined) { sets.push('completed_at = ?'); params.push(fields.completed_at); }

    params.push(taskId);
    await this.db.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  async claim(taskId: string, ownerId: string, updatedAt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE tasks
       SET owner = ?, status = 'doing', updated_at = ?
       WHERE id = ? AND owner IS NULL AND status = 'todo'`,
      [ownerId, updatedAt, taskId],
    );
    return rowCount > 0;
  }

  async delete(taskId: string): Promise<void> {
    await this.db.query(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }

  async replaceEventLinks(taskId: string, scheduleIds: string[]): Promise<void> {
    await this.db.query(
      `DELETE FROM task_event_links WHERE task_id = ?`,
      [taskId],
    );
    const now = Math.floor(Date.now() / 1000);
    for (const scheduleId of scheduleIds) {
      await this.db.query(
        `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES (?, ?, ?)`,
        [taskId, scheduleId, now],
      );
    }
  }

  async listEventLinksForTask(taskId: string): Promise<Array<{ schedule_id: string }>> {
    const { rows } = await this.db.query<{ schedule_id: string }>(
      `SELECT schedule_id FROM task_event_links WHERE task_id = ?`,
      [taskId],
    );
    return rows;
  }

  async listTasksForSchedule(scheduleId: string): Promise<TaskRow[]> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN task_event_links tel ON tel.task_id = t.id
       WHERE tel.schedule_id = ?
       ORDER BY t.updated_at DESC`,
      [scheduleId],
    );
    return rows;
  }
}
