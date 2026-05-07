// SPDX-License-Identifier: MIT
//
// Spec 053 — PgDispatchesRepo. Postgres dialect of DispatchesRepository.
// Mirrors src/db/repos/sqlite/dispatches-repo.ts; differences are limited
// to placeholder syntax ($N vs ?) and IDENTITY/RETURNING semantics.

import type { DbAdapter } from '../../db-adapter.js';
import type {
  CreateDispatchInput,
  DispatchListFilters,
  DispatchesRepository,
} from '../../db-service.js';
import type { DispatchRow, DispatchStatus, VerifyStatus } from '../../types.js';

export class PgDispatchesRepo implements DispatchesRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(input: CreateDispatchInput): Promise<number> {
    const result = await this.db.query<{ id: number }>(
      `INSERT INTO dispatches
         (team_id, dispatched_at, from_actor, to_agent, channel, message,
          query_id, status, verify_signal_json, parent_dispatch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9)
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
      `SELECT * FROM dispatches WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(filters?: DispatchListFilters): Promise<DispatchRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    const next = () => `$${++p}`;
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      clauses.push(`status IN (${statuses.map(() => next()).join(',')})`);
      params.push(...statuses);
    }
    if (filters?.to_agent) {
      clauses.push(`to_agent = ${next()}`); params.push(filters.to_agent);
    }
    if (filters?.from_actor) {
      clauses.push(`from_actor = ${next()}`); params.push(filters.from_actor);
    }
    if (filters?.verify_status) {
      clauses.push(`verify_status = ${next()}`); params.push(filters.verify_status);
    }
    if (filters?.since !== undefined) {
      clauses.push(`dispatched_at >= ${next()}`); params.push(filters.since);
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
      `UPDATE dispatches SET status = $1 WHERE id = $2`,
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
             responded_at = $1,
             response = $2,
             artifact_path = $3,
             verify_signal_json = $4,
             verify_status = $5,
             verify_last_checked = $6,
             verify_failures_json = $7
       WHERE id = $8`,
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
         SET verify_status = $1, verify_last_checked = $2, verify_failures_json = $3
       WHERE id = $4`,
      [fields.verify_status, fields.verify_last_checked, fields.verify_failures_json, id],
    );
  }

  async findStale(cutoff: number, _perAgentThresholds?: Record<string, number>): Promise<DispatchRow[]> {
    const { rows } = await this.db.query<DispatchRow>(
      `SELECT * FROM dispatches WHERE status = 'in_flight' AND dispatched_at < $1 ORDER BY dispatched_at ASC`,
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
             OR (verify_status = 'pass' AND verify_last_checked < $1)
           )
         ORDER BY verify_last_checked ASC
         LIMIT 50`,
      [now - staleAfterMs],
    );
    return rows;
  }
}
