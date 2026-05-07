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

  async list(_filters?: DispatchListFilters): Promise<DispatchRow[]> {
    throw new Error('not yet implemented');
  }
  async setStatus(_id: number, _status: DispatchStatus): Promise<void> {
    throw new Error('not yet implemented');
  }
  async recordDone(): Promise<void> { throw new Error('not yet implemented'); }
  async updateVerify(): Promise<void> { throw new Error('not yet implemented'); }
  async findStale(): Promise<DispatchRow[]> { throw new Error('not yet implemented'); }
  async findReverifyCandidates(): Promise<DispatchRow[]> { throw new Error('not yet implemented'); }
}
