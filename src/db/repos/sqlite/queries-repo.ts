// SPDX-License-Identifier: MIT

import type { QueriesRepository } from '../../db-service.js';
import type { InboxOwnerKind, QueryRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { stringifyJson } from '../../db-json.js';
import { normalizeQueryRow, resolveQueryOwnership } from '../query-row-normalize.js';

export class SqliteQueriesRepo implements QueriesRepository {
  constructor(private readonly db: DbAdapter) {}

  private parseQueryRow(row: any): QueryRow | null {
    return normalizeQueryRow(row);
  }

  async getById(agentId: string, queryId: string): Promise<QueryRow | null> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id, last_output_at, manager_dispatch_id, manager_query_id
       FROM queries
       WHERE agent_id = ? AND query_id = ?`,
      [agentId, queryId],
    );
    return r.rows[0] ? this.parseQueryRow(r.rows[0]) : null;
  }

  async getByQueryIdForTeam(teamId: string, queryId: string): Promise<QueryRow | null> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id, last_output_at, manager_dispatch_id, manager_query_id
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
    agentId: string | null,
    prompt: string,
    created: number,
    sessionId?: string,
    ownership?: { owner_kind: InboxOwnerKind; owner_id: string },
  ): Promise<void> {
    const own = resolveQueryOwnership(teamId, agentId, ownership);
    await this.db.query(
      `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, session_id, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
       ON CONFLICT (team_id, query_id) DO NOTHING`,
      [teamId, queryId, agentId, prompt, created, sessionId ?? null, own.owner_kind, own.owner_id],
    );
  }

  async upsert(
    teamId: string,
    agentId: string | null,
    query: Partial<QueryRow> & { query_id: string },
  ): Promise<void> {
    const own =
      query.owner_kind != null && query.owner_id != null
        ? { owner_kind: query.owner_kind, owner_id: query.owner_id }
        : resolveQueryOwnership(teamId, agentId);
    await this.db.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id, manager_dispatch_id, manager_query_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, query_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         status = excluded.status,
         completed = excluded.completed,
         result = excluded.result,
         error = excluded.error,
         session_id = excluded.session_id,
         owner_kind = excluded.owner_kind,
         owner_id = excluded.owner_id,
         manager_dispatch_id = COALESCE(excluded.manager_dispatch_id, queries.manager_dispatch_id),
         manager_query_id = COALESCE(excluded.manager_query_id, queries.manager_query_id)`,
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
        query.manager_dispatch_id ?? null,
        query.manager_query_id ?? null,
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
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id, last_output_at, manager_dispatch_id, manager_query_id
       FROM queries
       WHERE agent_id = ? AND status IN ('pending', 'processing')
       ORDER BY created ASC`,
      [agentId],
    );
    return r.rows.map((row) => this.parseQueryRow(row)!);
  }

  async getPendingByOwner(teamId: string, ownerKind: InboxOwnerKind, ownerId: string): Promise<QueryRow[]> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id, last_output_at, manager_dispatch_id, manager_query_id
       FROM queries
       WHERE team_id = ? AND owner_kind = ? AND owner_id = ? AND status IN ('pending', 'processing')
       ORDER BY created ASC`,
      [teamId, ownerKind, ownerId],
    );
    return r.rows.map((row) => this.parseQueryRow(row)!);
  }

  async recordOutput(teamId: string, queryId: string, ts: number): Promise<void> {
    await this.db.query(
      `UPDATE queries SET last_output_at = ?
       WHERE team_id = ? AND query_id = ? AND status IN ('pending', 'processing')`,
      [ts, teamId, queryId],
    );
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
