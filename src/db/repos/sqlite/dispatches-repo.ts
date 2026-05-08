// SPDX-License-Identifier: MIT
//
// Spec 053 — SqliteDispatchesRepo. Single source of truth for dispatched
// units of work and their typed verification state. Modeled on
// SqliteTasksRepo.

import type { DbAdapter } from '../../db-adapter.js';
import type {
  CreateDispatchInput,
  DispatchListFilters,
  DispatchesRepository,
} from '../../db-service.js';
import type { DispatchRow, DispatchStatus, VerifyStatus } from '../../types.js';

export class SqliteDispatchesRepo implements DispatchesRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(input: CreateDispatchInput): Promise<number> {
    const result = await this.db.query<{ id: number }>(
      `INSERT INTO dispatches
         (team_id, dispatched_at, from_actor, to_agent, channel, message,
          query_id, status, verify_signal_json, parent_dispatch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
       RETURNING id`,
      [
        input.team_id,
        input.dispatched_at,
        input.from_actor,
        input.to_agent,
        input.channel,
        input.message,
        input.query_id,
        input.verify_signal_json,
        input.parent_dispatch_id,
      ],
    );
    return result.rows[0]!.id;
  }

  async getById(id: number): Promise<DispatchRow | null> {
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(filters?: DispatchListFilters): Promise<DispatchRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (filters?.to_agent) {
      clauses.push('to_agent = ?'); params.push(filters.to_agent);
    }
    if (filters?.from_actor) {
      clauses.push('from_actor = ?'); params.push(filters.from_actor);
    }
    if (filters?.verify_status) {
      clauses.push('verify_status = ?'); params.push(filters.verify_status);
    }
    if (filters?.since !== undefined) {
      clauses.push('dispatched_at >= ?'); params.push(filters.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters?.limit ? `LIMIT ${filters.limit}` : 'LIMIT 200';
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches ${where} ORDER BY dispatched_at DESC ${limit}`,
      params,
    );
    return rows;
  }

  async setStatus(id: number, status: DispatchStatus): Promise<void> {
    await this.db.query(
      `UPDATE dispatches SET status = ? WHERE id = ?`,
      [status, id],
    );
  }

  async recordDone(id: number, fields: {
    responded_at: number;
    response: string | null;
    artifact_path: string | null;
    verify_signal_json: string | null;
    verify_status: VerifyStatus;
    verify_last_checked: number;
    verify_failures_json: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE dispatches
       SET status = 'done',
           responded_at = ?,
           response = ?,
           artifact_path = ?,
           verify_signal_json = ?,
           verify_status = ?,
           verify_last_checked = ?,
           verify_failures_json = ?
       WHERE id = ?`,
      [
        fields.responded_at,
        fields.response,
        fields.artifact_path,
        fields.verify_signal_json,
        fields.verify_status,
        fields.verify_last_checked,
        fields.verify_failures_json,
        id,
      ],
    );
  }

  async updateVerify(id: number, fields: {
    verify_status: VerifyStatus;
    verify_last_checked: number;
    verify_failures_json: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE dispatches
         SET verify_status = ?, verify_last_checked = ?, verify_failures_json = ?
       WHERE id = ?`,
      [fields.verify_status, fields.verify_last_checked, fields.verify_failures_json, id],
    );
  }

  async findStale(cutoff: number, _perAgentThresholds?: Record<string, number>): Promise<DispatchRow[]> {
    // v1: single global cutoff. Per-agent thresholds become a follow-up.
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches WHERE status = 'in_flight' AND dispatched_at < ? ORDER BY dispatched_at ASC`,
      [cutoff],
    );
    return rows;
  }

  async findReverifyCandidates(now: number, staleAfterMs: number): Promise<DispatchRow[]> {
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches
       WHERE status = 'done'
         AND verify_signal_json IS NOT NULL
         AND (
           verify_status = 'pending'
           OR (verify_status = 'pass' AND verify_last_checked < ?)
         )
       ORDER BY verify_last_checked ASC
       LIMIT 50`,
      [now - staleAfterMs],
    );
    return rows;
  }

  async listLatestOpenByAgents(agentIds: string[]): Promise<DispatchRow[]> {
    if (agentIds.length === 0) return [];
    const placeholders = agentIds.map(() => '?').join(',');
    // Pick the newest open row per to_agent. Subquery first finds (agent, max
    // dispatched_at) for the open statuses, then we join back to fetch the
    // full row. Status filter is intentionally repeated on the outer join so
    // an out-of-band status flip can't surface a closed row.
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT d.*
         FROM dispatches d
         JOIN (
           SELECT to_agent, MAX(dispatched_at) AS max_at
             FROM dispatches
            WHERE status IN ('queued', 'in_flight')
              AND to_agent IN (${placeholders})
            GROUP BY to_agent
         ) latest
           ON latest.to_agent = d.to_agent
          AND latest.max_at   = d.dispatched_at
        WHERE d.status IN ('queued', 'in_flight')
        ORDER BY d.dispatched_at DESC`,
      agentIds,
    );
    // Defense in depth: ties on max(dispatched_at) for a single agent could
    // surface multiple rows. Keep the highest id per agent so callers get a
    // single deterministic snapshot.
    const seen = new Set<string>();
    const out: DispatchRow[] = [];
    for (const r of rows.sort((a, b) => (b.id - a.id))) {
      if (seen.has(r.to_agent)) continue;
      seen.add(r.to_agent);
      out.push(r);
    }
    return out;
  }
}
