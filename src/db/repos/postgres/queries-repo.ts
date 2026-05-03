// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { QueriesRepository } from '../../db-service.js';
import type { InboxOwnerKind, QueryRow } from '../../types.js';

function resolveQueryOwnership(
  teamId: string,
  agentId: string | null,
  override?: { owner_kind: InboxOwnerKind; owner_id: string },
): { owner_kind: InboxOwnerKind; owner_id: string } {
  if (override) return override;
  if (agentId != null && agentId !== '') {
    if (agentId.startsWith('manager-')) {
      return { owner_kind: 'manager', owner_id: teamId };
    }
    return { owner_kind: 'agent', owner_id: agentId };
  }
  throw new Error('PgQueriesRepo: ownership override required when agentId is null');
}

export class PgQueriesRepo implements QueriesRepository {
  constructor(private db: DbAdapter) {}

  async getById(agentId: string, queryId: string): Promise<QueryRow | null> {
    const { rows } = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE agent_id = $1 AND query_id = $2`,
      [agentId, queryId],
    );
    return rows[0] ?? null;
  }

  async getByQueryIdForTeam(teamId: string, queryId: string): Promise<QueryRow | null> {
    const { rows } = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE team_id = $1 AND query_id = $2
       LIMIT 1`,
      [teamId, queryId],
    );
    return rows[0] ?? null;
  }

  async expireStale(cutoffCreated: number, statuses: string[]): Promise<QueryRow[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map((_, i) => `$${i + 3}`).join(', ');
    const { rows } = await this.db.query<QueryRow>(
      `UPDATE queries
       SET status = 'expired', completed = $1
       WHERE status IN (${placeholders}) AND created < $2
       RETURNING team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id`,
      [Date.now(), cutoffCreated, ...statuses],
    );
    return rows;
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
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
       ON CONFLICT (team_id, query_id) DO NOTHING`,
      [teamId, queryId, agentId, prompt, created, sessionId || null, own.owner_kind, own.owner_id],
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
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (team_id, query_id)
       DO UPDATE SET agent_id = EXCLUDED.agent_id,
                     status = EXCLUDED.status,
                     completed = EXCLUDED.completed,
                     result = EXCLUDED.result,
                     error = EXCLUDED.error,
                     session_id = EXCLUDED.session_id,
                     owner_kind = EXCLUDED.owner_kind,
                     owner_id = EXCLUDED.owner_id`,
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
      `UPDATE queries SET status = 'completed', completed = $3, result = $4
       WHERE team_id = $1 AND query_id = $2 AND status = 'pending'`,
      [teamId, queryId, completed, result],
    );
  }

  async markFailed(
    teamId: string,
    queryId: string,
    completed: number,
    error: string | null,
  ): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE queries SET status = 'failed', completed = $3, error = $4
       WHERE team_id = $1 AND query_id = $2 AND status = 'pending'`,
      [teamId, queryId, completed, error ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async findTeam(queryId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ team_id: string }>(
      `SELECT team_id FROM queries WHERE query_id = $1 LIMIT 1`,
      [queryId],
    );
    return rows[0]?.team_id ?? null;
  }

  async getPending(agentId: string): Promise<QueryRow[]> {
    const { rows } = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE agent_id = $1 AND status IN ('pending', 'processing')
       ORDER BY created ASC`,
      [agentId],
    );
    return rows;
  }

  async getPendingByOwner(teamId: string, ownerKind: InboxOwnerKind, ownerId: string): Promise<QueryRow[]> {
    const { rows } = await this.db.query<QueryRow>(
      `SELECT team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id
       FROM queries
       WHERE team_id = $1 AND owner_kind = $2 AND owner_id = $3 AND status IN ('pending', 'processing')
       ORDER BY created ASC`,
      [teamId, ownerKind, ownerId],
    );
    return rows;
  }

  async cancel(agentId: string, completed: number): Promise<string[]> {
    const { rows } = await this.db.query<{ query_id: string }>(
      `SELECT query_id FROM queries
       WHERE agent_id = $1 AND status IN ('pending', 'processing')`,
      [agentId],
    );

    if (rows.length === 0) return [];

    const queryIds = rows.map(r => r.query_id);

    await this.db.query(
      `UPDATE queries SET status = 'cancelled', completed = $2
       WHERE agent_id = $1 AND status IN ('pending', 'processing')`,
      [agentId, completed],
    );

    return queryIds;
  }
}
