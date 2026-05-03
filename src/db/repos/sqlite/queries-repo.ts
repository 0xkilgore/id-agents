// SPDX-License-Identifier: MIT

import type { QueriesRepository } from '../../db-service.js';
import type { InboxOwnerKind, QueryRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

function resolveQueryOwnership(
  teamId: string,
  agentId: string,
  override?: { owner_kind: InboxOwnerKind; owner_id: string },
): { owner_kind: InboxOwnerKind; owner_id: string } {
  if (override) return override;
  if (agentId.startsWith('manager-')) {
    return { owner_kind: 'manager', owner_id: teamId };
  }
  return { owner_kind: 'agent', owner_id: agentId };
}

export class SqliteQueriesRepo implements QueriesRepository {
  constructor(private readonly db: DbAdapter) {}

  private parseQueryRow(row: any): QueryRow | null {
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
      result: parseJsonObject(row.result),
    };
  }

  async getById(agentId: string, queryId: string): Promise<QueryRow | null> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE agent_id = ? AND query_id = ?`,
      [agentId, queryId],
    );
    return r.rows[0] ? this.parseQueryRow(r.rows[0]) : null;
  }

  async getByQueryIdForTeam(teamId: string, queryId: string): Promise<QueryRow | null> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE team_id = ? AND query_id = ?
       LIMIT 1`,
      [teamId, queryId],
    );
    return r.rows[0] ? this.parseQueryRow(r.rows[0]) : null;
  }

  async expireStale(cutoffCreated: number, statuses: string[]): Promise<QueryRow[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const r = await this.db.query<QueryRow>(
      `UPDATE queries
       SET status = 'expired', completed = ?
       WHERE status IN (${placeholders}) AND created < ?
       RETURNING team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id`,
      [Date.now(), ...statuses, cutoffCreated],
    );
    return r.rows.map((row) => this.parseQueryRow(row)!);
  }

  async create(
    teamId: string,
    queryId: string,
    agentId: string,
    prompt: string,
    created: number,
    sessionId?: string,
    ownership?: { owner_kind: InboxOwnerKind; owner_id: string },
  ): Promise<void> {
    const own = resolveQueryOwnership(teamId, agentId, ownership);
    await this.db.query(
      `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, session_id, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
       ON CONFLICT (agent_id, query_id) DO NOTHING`,
      [teamId, queryId, agentId, prompt, created, sessionId ?? null, own.owner_kind, own.owner_id],
    );
  }

  async upsert(
    teamId: string,
    agentId: string,
    query: Partial<QueryRow> & { query_id: string },
  ): Promise<void> {
    const own =
      query.owner_kind != null && query.owner_id != null
        ? { owner_kind: query.owner_kind, owner_id: query.owner_id }
        : resolveQueryOwnership(teamId, agentId);
    await this.db.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, query_id) DO UPDATE SET
         status = excluded.status,
         completed = excluded.completed,
         result = excluded.result,
         error = excluded.error,
         session_id = excluded.session_id,
         owner_kind = excluded.owner_kind,
         owner_id = excluded.owner_id`,
      [
        teamId,
        agentId,
        query.query_id,
        query.status ?? 'pending',
        query.prompt ?? null,
        query.created ?? Date.now(),
        query.completed ?? null,
        query.result ? stringifyJson(query.result) : null,
        query.error ?? null,
        query.session_id ?? null,
        own.owner_kind,
        own.owner_id,
      ],
    );
  }

  async complete(
    teamId: string,
    queryId: string,
    completed: number,
    result: Record<string, unknown> | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE queries SET status = 'completed', completed = ?, result = ?
       WHERE team_id = ? AND query_id = ? AND status = 'pending'`,
      [completed, result ? stringifyJson(result) : null, teamId, queryId],
    );
  }

  async markFailed(
    teamId: string,
    queryId: string,
    completed: number,
    error: string | null,
  ): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE queries SET status = 'failed', completed = ?, error = ?
       WHERE team_id = ? AND query_id = ? AND status = 'pending'`,
      [completed, error ?? null, teamId, queryId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async findTeam(queryId: string): Promise<string | null> {
    const r = await this.db.query<{ team_id: string }>(
      'SELECT team_id FROM queries WHERE query_id = ? LIMIT 1',
      [queryId],
    );
    return r.rows[0]?.team_id ?? null;
  }

  async getPending(agentId: string): Promise<QueryRow[]> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE agent_id = ? AND status IN ('pending', 'processing')`,
      [agentId],
    );
    return r.rows.map((row) => this.parseQueryRow(row)!);
  }

  async getPendingByOwner(teamId: string, ownerKind: InboxOwnerKind, ownerId: string): Promise<QueryRow[]> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE team_id = ? AND owner_kind = ? AND owner_id = ? AND status IN ('pending', 'processing')
       ORDER BY created ASC`,
      [teamId, ownerKind, ownerId],
    );
    return r.rows.map((row) => this.parseQueryRow(row)!);
  }

  async cancel(agentId: string, completed: number): Promise<string[]> {
    const r = await this.db.query<{ query_id: string }>(
      `SELECT query_id FROM queries
       WHERE agent_id = ? AND status IN ('pending', 'processing')`,
      [agentId],
    );
    const queryIds = r.rows.map((row) => row.query_id);

    if (queryIds.length > 0) {
      await this.db.query(
        `UPDATE queries SET status = 'cancelled', completed = ?
         WHERE agent_id = ? AND status IN ('pending', 'processing')`,
        [completed, agentId],
      );
    }

    return queryIds;
  }
}
