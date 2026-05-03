// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { NewsRepository } from '../../db-service.js';
import type { InboxOwnerKind, NewsItemRow } from '../../types.js';

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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        teamId,
        agentId,
        item.timestamp,
        item.type,
        item.message || null,
        item.data || null,
        item.query_id || null,
        item.kind || null,
        replyExpected,
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
    const params: unknown[] = [agentId, since];
    let where = `agent_id = $1 AND timestamp > $2`;

    if (opts?.queryId) {
      params.push(opts.queryId);
      where += ` AND query_id = $${params.length}`;
    }

    const limit = opts?.limit ?? 1000;
    params.push(limit);

    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, timestamp, message, data, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async pollByOwner(
    teamId: string,
    ownerKind: InboxOwnerKind,
    ownerId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    const params: unknown[] = [teamId, ownerKind, ownerId, since];
    let where = `team_id = $1 AND owner_kind = $2 AND owner_id = $3 AND timestamp > $4`;

    if (opts?.queryId) {
      params.push(opts.queryId);
      where += ` AND query_id = $${params.length}`;
    }

    const limit = opts?.limit ?? 1000;
    params.push(limit);

    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, timestamp, message, data, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async pollSinceId(
    agentId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    const params: unknown[] = [agentId, sinceId];
    let where = `agent_id = $1 AND id > $2`;

    if (opts?.queryId) {
      params.push(opts.queryId);
      where += ` AND query_id = $${params.length}`;
    }

    const limit = opts?.limit ?? 1000;
    params.push(limit);

    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, timestamp, message, data, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE ${where}
       ORDER BY id ASC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async pollSinceIdByOwner(
    teamId: string,
    ownerKind: InboxOwnerKind,
    ownerId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    const params: unknown[] = [teamId, ownerKind, ownerId, sinceId];
    let where = `team_id = $1 AND owner_kind = $2 AND owner_id = $3 AND id > $4`;

    if (opts?.queryId) {
      params.push(opts.queryId);
      where += ` AND query_id = $${params.length}`;
    }

    const limit = opts?.limit ?? 1000;
    params.push(limit);

    const { rows } = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, timestamp, message, data, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE ${where}
       ORDER BY id ASC
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
      `SELECT id, team_id, agent_id, query_id, type, message, timestamp, data, kind, reply_expected, owner_kind, owner_id
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
      `SELECT id, type, timestamp, message, data, team_id, agent_id, query_id, kind, reply_expected, owner_kind, owner_id
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
