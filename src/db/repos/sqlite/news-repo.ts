// SPDX-License-Identifier: MIT

import type { NewsRepository } from '../../db-service.js';
import type { NewsItemRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

export class SqliteNewsRepo implements NewsRepository {
  constructor(private readonly db: DbAdapter) {}

  private parseNewsRow(row: any): NewsItemRow | null {
    if (!row) return null;
    return { ...row, data: parseJsonObject(row.data) };
  }

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
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId,
        agentId,
        item.timestamp,
        item.type,
        item.message ?? null,
        item.data ? stringifyJson(item.data) : null,
        item.query_id ?? null,
      ],
    );
  }

  async poll(
    agentId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT type, timestamp, message, data FROM news_items WHERE agent_id = ? AND timestamp > ?';
    const params: unknown[] = [agentId, since];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY timestamp DESC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async getRecent(teamId: string, types: string[], limit: number): Promise<NewsItemRow[]> {
    const placeholders = types.map(() => '?').join(', ');
    const r = await this.db.query<NewsItemRow>(
      `SELECT id, query_id, type, message, timestamp, data
       FROM news_items
       WHERE team_id = ? AND type IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`,
      [teamId, ...types, limit],
    );
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async fetchForArchive(teamId: string, before: number): Promise<NewsItemRow[]> {
    const r = await this.db.query<NewsItemRow>(
      `SELECT type, timestamp, message, data, agent_id, query_id
       FROM news_items
       WHERE team_id = ? AND timestamp < ?
       ORDER BY timestamp ASC`,
      [teamId, before],
    );
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async deleteArchived(teamId: string, before: number): Promise<void> {
    await this.db.query(
      'DELETE FROM news_items WHERE team_id = ? AND timestamp < ?',
      [teamId, before],
    );
  }
}
