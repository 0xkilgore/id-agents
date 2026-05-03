// SPDX-License-Identifier: MIT

import type { NewsRepository } from '../../db-service.js';
import type { InboxOwnerKind, NewsItemRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

function resolveNewsOwnership(
  teamId: string,
  agentId: string,
  item: { owner_kind?: InboxOwnerKind; owner_id?: string },
): { owner_kind: InboxOwnerKind; owner_id: string } {
  if (item.owner_kind != null && item.owner_id != null) {
    return { owner_kind: item.owner_kind, owner_id: item.owner_id };
  }
  if (agentId.startsWith('manager-')) {
    return { owner_kind: 'manager', owner_id: teamId };
  }
  return { owner_kind: 'agent', owner_id: agentId };
}

export class SqliteNewsRepo implements NewsRepository {
  constructor(private readonly db: DbAdapter) {}

  private parseNewsRow(row: any): NewsItemRow | null {
    if (!row) return null;
    const agent_id = String(row.agent_id ?? '');
    const team_id = String(row.team_id ?? '');
    const owner_kind: InboxOwnerKind =
      row.owner_kind === 'manager' || row.owner_kind === 'agent'
        ? row.owner_kind
        : agent_id.startsWith('manager-')
          ? 'manager'
          : 'agent';
    const owner_id =
      row.owner_id != null && String(row.owner_id) !== ''
        ? String(row.owner_id)
        : owner_kind === 'manager'
          ? team_id
          : agent_id;
    return {
      ...row,
      team_id,
      agent_id,
      owner_kind,
      owner_id,
      data: parseJsonObject(row.data),
    };
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
      kind?: 'talk' | 'notify';
      reply_expected?: boolean;
      owner_kind?: InboxOwnerKind;
      owner_id?: string;
    },
  ): Promise<void> {
    const replyExpected =
      item.reply_expected !== undefined
        ? item.reply_expected
        : item.kind === 'talk'
          ? true
          : item.kind === 'notify'
            ? false
            : null;
    const own = resolveNewsOwnership(teamId, agentId, item);
    await this.db.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id, kind, reply_expected, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId,
        agentId,
        item.timestamp,
        item.type,
        item.message ?? null,
        item.data ? stringifyJson(item.data) : null,
        item.query_id ?? null,
        item.kind ?? null,
        replyExpected === null ? null : replyExpected ? 1 : 0,
        own.owner_kind,
        own.owner_id,
      ],
    );
  }

  async poll(
    agentId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE agent_id = ? AND timestamp > ?';
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

  async pollByOwner(
    teamId: string,
    ownerKind: InboxOwnerKind,
    ownerId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE team_id = ? AND owner_kind = ? AND owner_id = ? AND timestamp > ?';
    const params: unknown[] = [teamId, ownerKind, ownerId, since];

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

  async pollSinceId(
    agentId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE agent_id = ? AND id > ?';
    const params: unknown[] = [agentId, sinceId];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY id ASC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async pollSinceIdByOwner(
    teamId: string,
    ownerKind: InboxOwnerKind,
    ownerId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE team_id = ? AND owner_kind = ? AND owner_id = ? AND id > ?';
    const params: unknown[] = [teamId, ownerKind, ownerId, sinceId];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY id ASC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async getRecent(teamId: string, types: string[], limit: number): Promise<NewsItemRow[]> {
    const placeholders = types.map(() => '?').join(', ');
    const r = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, message, timestamp, data, kind, reply_expected, owner_kind, owner_id
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
      `SELECT id, type, timestamp, message, data, team_id, agent_id, query_id, kind, reply_expected, owner_kind, owner_id
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
