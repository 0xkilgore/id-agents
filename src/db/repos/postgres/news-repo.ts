// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { NewsRepository } from '../../db-service.js';
import type { NewsItemRow } from '../../types.js';

export class PgNewsRepo implements NewsRepository {
  constructor(private db: DbAdapter) {}

  async add(
    teamId: string,
    agentId: string,
    item: {
      timestamp: number;
      type: string;
      message?: string;
      data?: Record<string, unknown>;
      query_id?: string;
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        teamId,
        agentId,
        item.timestamp,
        item.type,
        item.message || null,
        item.data || null,
        item.query_id || null,
      ],
    );
  }

  async poll(
    teamId: string,
    agentId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    const params: unknown[] = [teamId, agentId, since];
    let where = `team_id = $1 AND agent_id = $2 AND timestamp > $3`;

    if (opts?.queryId) {
      params.push(opts.queryId);
      where += ` AND query_id = $${params.length}`;
    }

    const limit = opts?.limit ?? 1000;
    params.push(limit);

    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, timestamp, message, data
       FROM news_items
       WHERE ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async getRecent(teamId: string, types: string[], limit: number): Promise<NewsItemRow[]> {
    // Build dynamic IN clause: $2, $3, ... for each type
    const placeholders = types.map((_, i) => `$${i + 2}`).join(', ');
    const params: unknown[] = [teamId, ...types, limit];
    const limitIdx = params.length;

    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT id, query_id, type, message, timestamp, data
       FROM news_items
       WHERE team_id = $1 AND type IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT $${limitIdx}`,
      params,
    );
    return rows;
  }

  async fetchForArchive(teamId: string, before: number): Promise<NewsItemRow[]> {
    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT type, timestamp, message, data, agent_id, query_id
       FROM news_items
       WHERE team_id = $1 AND timestamp < $2
       ORDER BY timestamp ASC`,
      [teamId, before],
    );
    return rows;
  }

  async deleteArchived(teamId: string, before: number): Promise<void> {
    await this.db.query(
      `DELETE FROM news_items WHERE team_id = $1 AND timestamp < $2`,
      [teamId, before],
    );
  }
}
