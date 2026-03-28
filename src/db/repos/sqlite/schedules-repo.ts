// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { SchedulesRepository } from '../../db-service.js';
import type { ScheduleDefinitionRow, ScheduleRunRow } from '../../types.js';

export class SqliteSchedulesRepo implements SchedulesRepository {
  constructor(private readonly db: DbAdapter) {}

  // ---------------------------------------------------------------------------
  // Row helpers — map SQLite INTEGER active (1/0) to boolean
  // ---------------------------------------------------------------------------

  private parseRow(row: any): ScheduleDefinitionRow | null {
    if (!row) return null;
    return {
      ...row,
      active: row.active === 1 || row.active === true,
    };
  }

  private parseRows(rows: any[]): ScheduleDefinitionRow[] {
    return rows.map(r => this.parseRow(r)!);
  }

  // ---------------------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------------------

  async upsertDefinition(def: ScheduleDefinitionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO schedule_definitions
         (id, kind, title, description, active, message, delivery_mode, timezone,
          catch_up_policy, dedupe_window_seconds, interval_seconds, anchor_at,
          max_runs, expires_at, local_time_seconds, local_date, days_of_week,
          source_type, source_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         kind                 = excluded.kind,
         title                = excluded.title,
         description          = excluded.description,
         active               = excluded.active,
         message              = excluded.message,
         delivery_mode        = excluded.delivery_mode,
         timezone             = excluded.timezone,
         catch_up_policy      = excluded.catch_up_policy,
         dedupe_window_seconds = excluded.dedupe_window_seconds,
         interval_seconds     = excluded.interval_seconds,
         anchor_at            = excluded.anchor_at,
         max_runs             = excluded.max_runs,
         expires_at           = excluded.expires_at,
         local_time_seconds   = excluded.local_time_seconds,
         local_date           = excluded.local_date,
         days_of_week         = excluded.days_of_week,
         source_type          = excluded.source_type,
         source_key           = excluded.source_key,
         updated_at           = excluded.updated_at`,
      [
        def.id,
        def.kind,
        def.title,
        def.description,
        def.active ? 1 : 0,
        def.message,
        def.delivery_mode,
        def.timezone,
        def.catch_up_policy,
        def.dedupe_window_seconds,
        def.interval_seconds,
        def.anchor_at,
        def.max_runs,
        def.expires_at,
        def.local_time_seconds,
        def.local_date,
        def.days_of_week,
        def.source_type,
        def.source_key,
        def.created_at,
        def.updated_at,
      ],
    );
  }

  async getDefinition(scheduleId: string): Promise<ScheduleDefinitionRow | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM schedule_definitions WHERE id = ?`,
      [scheduleId],
    );
    return this.parseRow(rows[0]);
  }

  async listActiveDefinitions(): Promise<ScheduleDefinitionRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM schedule_definitions WHERE active = 1`,
    );
    return this.parseRows(rows);
  }

  async listSchedulesForAgent(agentId: string): Promise<ScheduleDefinitionRow[]> {
    const { rows } = await this.db.query(
      `SELECT d.* FROM schedule_definitions d
       JOIN schedule_targets t ON t.schedule_id = d.id
       WHERE t.agent_id = ? AND d.active = 1`,
      [agentId],
    );
    return this.parseRows(rows);
  }

  async setActive(scheduleId: string, active: boolean): Promise<void> {
    await this.db.query(
      `UPDATE schedule_definitions SET active = ?, updated_at = ? WHERE id = ?`,
      [active ? 1 : 0, Math.floor(Date.now() / 1000), scheduleId],
    );
  }

  async deleteDefinition(scheduleId: string): Promise<void> {
    await this.db.query(`DELETE FROM schedule_runs WHERE schedule_id = ?`, [scheduleId]);
    await this.db.query(`DELETE FROM schedule_targets WHERE schedule_id = ?`, [scheduleId]);
    await this.db.query(`DELETE FROM schedule_definitions WHERE id = ?`, [scheduleId]);
  }

  async deleteBySource(sourceType: string, sourceKeyPrefix?: string): Promise<void> {
    let whereSql: string;
    let params: unknown[];

    if (sourceKeyPrefix) {
      whereSql = `source_type = ? AND source_key LIKE ?`;
      params = [sourceType, sourceKeyPrefix + '%'];
    } else {
      whereSql = `source_type = ?`;
      params = [sourceType];
    }

    // Fetch matching ids so we can cascade to targets and runs
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM schedule_definitions WHERE ${whereSql}`,
      params,
    );

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');

    await this.db.query(`DELETE FROM schedule_runs WHERE schedule_id IN (${placeholders})`, ids);
    await this.db.query(`DELETE FROM schedule_targets WHERE schedule_id IN (${placeholders})`, ids);
    await this.db.query(`DELETE FROM schedule_definitions WHERE id IN (${placeholders})`, ids);
  }

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------

  async replaceTargets(scheduleId: string, agentIds: string[]): Promise<void> {
    await this.db.query(
      `DELETE FROM schedule_targets WHERE schedule_id = ?`,
      [scheduleId],
    );

    for (const agentId of agentIds) {
      await this.db.query(
        `INSERT INTO schedule_targets (schedule_id, agent_id) VALUES (?, ?)`,
        [scheduleId, agentId],
      );
    }
  }

  async listTargets(scheduleId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ agent_id: string }>(
      `SELECT agent_id FROM schedule_targets WHERE schedule_id = ?`,
      [scheduleId],
    );
    return rows.map(r => r.agent_id);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  async insertRun(run: ScheduleRunRow): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT OR IGNORE INTO schedule_runs
         (schedule_id, agent_id, scheduled_key, scheduled_at, fired_at, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        run.schedule_id,
        run.agent_id,
        run.scheduled_key,
        run.scheduled_at,
        run.fired_at,
        run.status,
        run.error,
      ],
    );
    return rowCount > 0;
  }

  async updateRunStatus(
    scheduleId: string,
    agentId: string,
    scheduledKey: string,
    status: 'pending' | 'sent' | 'failed' | 'skipped',
    error?: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE schedule_runs SET status = ?, error = ?
       WHERE schedule_id = ? AND agent_id = ? AND scheduled_key = ?`,
      [status, error ?? null, scheduleId, agentId, scheduledKey],
    );
  }

  async listRuns(scheduleId: string, limit?: number): Promise<ScheduleRunRow[]> {
    const limitClause = limit ? `LIMIT ?` : '';
    const params: unknown[] = [scheduleId];
    if (limit) params.push(limit);

    const { rows } = await this.db.query<ScheduleRunRow>(
      `SELECT * FROM schedule_runs
       WHERE schedule_id = ?
       ORDER BY fired_at DESC
       ${limitClause}`,
      params,
    );
    return rows;
  }

  async countRuns(scheduleId: string, agentId: string): Promise<number> {
    const { rows } = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM schedule_runs
       WHERE schedule_id = ? AND agent_id = ? AND status = 'sent'`,
      [scheduleId, agentId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}
