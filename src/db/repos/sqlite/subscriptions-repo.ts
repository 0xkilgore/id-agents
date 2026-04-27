// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { SubscriptionsRepository } from '../../db-service.js';
import type { SubscriptionRow } from '../../types.js';
import { parseJsonObject } from '../../db-json.js';

export class SqliteSubscriptionsRepo implements SubscriptionsRepository {
  constructor(private readonly db: DbAdapter) {}

  async listByOwner(teamId: string, ownerAgentId: string): Promise<SubscriptionRow[]> {
    const { rows } = await this.db.query<any>(
      `SELECT id, team_id, owner_agent_id, mode, status,
              filter_json, target_json, created_at, updated_at,
              last_acked_seq, last_error, consecutive_failures
       FROM subscriptions
       WHERE team_id = ? AND owner_agent_id = ? AND status != 'deleted'
       ORDER BY created_at DESC`,
      [teamId, ownerAgentId],
    );
    return rows.map(parseSubscriptionRow);
  }
}

function parseSubscriptionRow(row: any): SubscriptionRow {
  return {
    id: row.id,
    team_id: row.team_id,
    owner_agent_id: row.owner_agent_id,
    mode: row.mode,
    status: row.status,
    filter: parseJsonObject(row.filter_json),
    target: parseJsonObject(row.target_json),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_acked_seq: row.last_acked_seq === null || row.last_acked_seq === undefined ? null : Number(row.last_acked_seq),
    last_error: row.last_error ?? null,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
  };
}
