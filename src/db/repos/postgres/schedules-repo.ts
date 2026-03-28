// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { SchedulesRepository } from '../../db-service.js';
import type { ScheduleDefinitionRow, ScheduleRunRow } from '../../types.js';

export class PgSchedulesRepo implements SchedulesRepository {
  constructor(private readonly db: DbAdapter) {}

  // ---------------------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------------------

  async upsertDefinition(def: ScheduleDefinitionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO schedule_definitions (
         id, kind, title, description, active, message, delivery_mode, timezone,
         catch_up_policy, dedupe_window_seconds, interval_seconds,
         anchor_at, max_runs, expires_at, local_time_seconds,
         local_date, days_of_week, source_type, source_key,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
       )
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         active = EXCLUDED.active,
         message = EXCLUDED.message,
         delivery_mode = EXCLUDED.delivery_mode,
         timezone = EXCLUDED.timezone,
         catch_up_policy = EXCLUDED.catch_up_policy,
         dedupe_window_seconds = EXCLUDED.dedupe_window_seconds,
         interval_seconds = EXCLUDED.interval_seconds,
         anchor_at = EXCLUDED.anchor_at,
         max_runs = EXCLUDED.max_runs,
         expires_at = EXCLUDED.expires_at,
         local_time_seconds = EXCLUDED.local_time_seconds,
         local_date = EXCLUDED.local_date,
         days_of_week = EXCLUDED.days_of_week,
         source_type = EXCLUDED.source_type,
         source_key = EXCLUDED.source_key,
         updated_at = EXCLUDED.updated_at`,
      [
        def.id,
        def.kind,
        def.title,
        def.description,
        def.active,
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
    const r = await this.db.query<ScheduleDefinitionRow>(
      `SELECT * FROM schedule_definitions WHERE id = $1`,
      [scheduleId],
    );
    return r.rows[0] || null;
  }

  async listActiveDefinitions(): Promise<ScheduleDefinitionRow[]> {
    const r = await this.db.query<ScheduleDefinitionRow>(
      `SELECT * FROM schedule_definitions WHERE active = true ORDER BY created_at ASC`,
    );
    return r.rows;
  }

  async listAllDefinitions(): Promise<ScheduleDefinitionRow[]> {
    const r = await this.db.query<ScheduleDefinitionRow>(
      `SELECT * FROM schedule_definitions ORDER BY created_at ASC`,
    );
    return r.rows;
  }

  async listSchedulesForAgent(agentId: string): Promise<ScheduleDefinitionRow[]> {
    const r = await this.db.query<ScheduleDefinitionRow>(
      `SELECT d.*
       FROM schedule_definitions d
       JOIN schedule_targets t ON t.schedule_id = d.id
       WHERE t.agent_id = $1 AND d.active = true
       ORDER BY d.created_at ASC`,
      [agentId],
    );
    return r.rows;
  }

  async setActive(scheduleId: string, active: boolean): Promise<void> {
    await this.db.query(
      `UPDATE schedule_definitions SET active = $2, updated_at = $3 WHERE id = $1`,
      [scheduleId, active, Math.floor(Date.now() / 1000)],
    );
  }

  async deleteDefinition(scheduleId: string): Promise<void> {
    await this.db.query(`DELETE FROM schedule_runs WHERE schedule_id = $1`, [scheduleId]);
    await this.db.query(`DELETE FROM schedule_targets WHERE schedule_id = $1`, [scheduleId]);
    await this.db.query(`DELETE FROM schedule_definitions WHERE id = $1`, [scheduleId]);
  }

  async deleteBySource(sourceType: string, sourceKeyPrefix?: string): Promise<void> {
    let where = `source_type = $1`;
    const params: unknown[] = [sourceType];

    if (sourceKeyPrefix) {
      params.push(sourceKeyPrefix);
      where += ` AND source_key LIKE $2 || '%'`;
    }

    // Gather ids to cascade-delete targets and runs
    const r = await this.db.query<{ id: string }>(
      `SELECT id FROM schedule_definitions WHERE ${where}`,
      params,
    );
    const ids = r.rows.map((row) => row.id);

    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      await this.db.query(
        `DELETE FROM schedule_runs WHERE schedule_id IN (${placeholders})`,
        ids,
      );
      await this.db.query(
        `DELETE FROM schedule_targets WHERE schedule_id IN (${placeholders})`,
        ids,
      );
      await this.db.query(
        `DELETE FROM schedule_definitions WHERE id IN (${placeholders})`,
        ids,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------

  async replaceTargets(scheduleId: string, agentIds: string[]): Promise<void> {
    await this.db.query(
      `DELETE FROM schedule_targets WHERE schedule_id = $1`,
      [scheduleId],
    );

    for (const agentId of agentIds) {
      await this.db.query(
        `INSERT INTO schedule_targets (schedule_id, agent_id) VALUES ($1, $2)`,
        [scheduleId, agentId],
      );
    }
  }

  async listTargets(scheduleId: string): Promise<string[]> {
    const r = await this.db.query<{ agent_id: string }>(
      `SELECT agent_id FROM schedule_targets WHERE schedule_id = $1`,
      [scheduleId],
    );
    return r.rows.map((row) => row.agent_id);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  async insertRun(run: ScheduleRunRow): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO schedule_runs (schedule_id, agent_id, scheduled_key, scheduled_at, fired_at, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
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
    return r.rowCount > 0;
  }

  async updateRunStatus(
    scheduleId: string,
    agentId: string,
    scheduledKey: string,
    status: 'pending' | 'sent' | 'failed' | 'skipped',
    error?: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE schedule_runs
       SET status = $4, error = $5
       WHERE schedule_id = $1 AND agent_id = $2 AND scheduled_key = $3`,
      [scheduleId, agentId, scheduledKey, status, error ?? null],
    );
  }

  async listRuns(scheduleId: string, limit?: number): Promise<ScheduleRunRow[]> {
    const r = await this.db.query<ScheduleRunRow>(
      `SELECT * FROM schedule_runs
       WHERE schedule_id = $1
       ORDER BY fired_at DESC
       LIMIT $2`,
      [scheduleId, limit ?? 50],
    );
    return r.rows;
  }

  async countRuns(scheduleId: string, agentId: string): Promise<number> {
    const r = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schedule_runs
       WHERE schedule_id = $1 AND agent_id = $2 AND status = 'sent'`,
      [scheduleId, agentId],
    );
    return parseInt(r.rows[0]?.count || '0', 10);
  }
}
