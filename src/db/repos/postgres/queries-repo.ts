// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { QueriesRepository } from '../../db-service.js';
import type { QueryRow } from '../../types.js';

export class PgQueriesRepo implements QueriesRepository {
  constructor(private db: DbAdapter) {}

  async getById(teamId: string, agentId: string, queryId: string): Promise<QueryRow | null> {
    const { rows } = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id
       FROM queries
       WHERE team_id = $1 AND agent_id = $2 AND query_id = $3`,
      [teamId, agentId, queryId],
    );
    return rows[0] ?? null;
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
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       ON CONFLICT (team_id, agent_id, query_id) DO NOTHING`,
      [teamId, queryId, agentId, prompt, created, sessionId || null],
    );
  }

  async upsert(
    teamId: string,
    agentId: string,
    query: Partial<QueryRow> & { query_id: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (team_id, agent_id, query_id)
       DO UPDATE SET status = EXCLUDED.status,
                     completed = EXCLUDED.completed,
                     result = EXCLUDED.result,
                     error = EXCLUDED.error,
                     session_id = EXCLUDED.session_id`,
      [
        teamId,
        agentId,
        query.query_id,
        query.status || 'pending',
        query.prompt || null,
        query.created || Date.now(),
        query.completed || null,
        query.result || null,
        query.error || null,
        query.session_id || null,
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
      `UPDATE queries SET status = 'completed', completed = $3, result = $4
       WHERE team_id = $1 AND query_id = $2 AND status = 'pending'`,
      [teamId, queryId, completed, result],
    );
  }

  async findTeam(queryId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ team_id: string }>(
      `SELECT team_id FROM queries WHERE query_id = $1 LIMIT 1`,
      [queryId],
    );
    return rows[0]?.team_id ?? null;
  }

  async getPending(teamId: string, agentId: string): Promise<QueryRow[]> {
    const { rows } = await this.db.query<QueryRow>(
      `SELECT query_id, status, prompt, created, completed, result, error, session_id
       FROM queries
       WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')
       ORDER BY created ASC`,
      [teamId, agentId],
    );
    return rows;
  }

  async cancel(teamId: string, agentId: string, completed: number): Promise<string[]> {
    // Find all pending/processing queries for this agent
    const { rows } = await this.db.query<{ query_id: string }>(
      `SELECT query_id FROM queries
       WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')`,
      [teamId, agentId],
    );

    if (rows.length === 0) return [];

    const queryIds = rows.map(r => r.query_id);

    // Update queries to cancelled status
    await this.db.query(
      `UPDATE queries SET status = 'cancelled', completed = $3
       WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')`,
      [teamId, agentId, completed],
    );

    return queryIds;
  }
}
