// SPDX-License-Identifier: MIT

import type { QueriesRepository } from '../../db-service.js';
import type { QueryRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

export class SqliteQueriesRepo implements QueriesRepository {
  constructor(private readonly db: DbAdapter) {}

  private parseQueryRow(row: any): QueryRow | null {
    if (!row) return null;
    return { ...row, result: parseJsonObject(row.result) };
  }

  async getById(agentId: string, queryId: string): Promise<QueryRow | null> {
    const r = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id
       FROM queries
       WHERE agent_id = ? AND query_id = ?`,
      [agentId, queryId],
    );
    return r.rows[0] ? this.parseQueryRow(r.rows[0]) : null;
  }

  async create(
    teamId: string,
    queryId: string,
    agentId: string,
    prompt: string,
    created: number,
    sessionId?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, session_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (agent_id, query_id) DO NOTHING`,
      [teamId, queryId, agentId, prompt, created, sessionId ?? null],
    );
  }

  async upsert(
    teamId: string,
    agentId: string,
    query: Partial<QueryRow> & { query_id: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, query_id) DO UPDATE SET
         status = excluded.status,
         completed = excluded.completed,
         result = excluded.result,
         error = excluded.error,
         session_id = excluded.session_id`,
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

  async findTeam(queryId: string): Promise<string | null> {
    const r = await this.db.query<{ team_id: string }>(
      'SELECT team_id FROM queries WHERE query_id = ? LIMIT 1',
      [queryId],
    );
    return r.rows[0]?.team_id ?? null;
  }

  async getPending(agentId: string): Promise<QueryRow[]> {
    const r = await this.db.query<QueryRow>(
      `SELECT query_id, status, prompt, created, completed, result, error, session_id
       FROM queries
       WHERE agent_id = ? AND status IN ('pending', 'processing')`,
      [agentId],
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
