// SPDX-License-Identifier: MIT
// Backward-compatible re-exports from new db module
export { createDb, migrateDb } from './db/index.js';
export type { Db, DbAdapter, QueryResult, AgentRow, LogicalAgentIdentityRow, TeamRow, QueryRow, NewsItemRow } from './db/index.js';

/**
 * Legacy helper — wraps db.teams.getOrCreateTeamId() for callers that still
 * pass the old (db, teamName) signature.
 */
import type { Db } from './db/index.js';
export async function getOrCreateTeamId(db: Db, teamName: string): Promise<string> {
  return db.teams.getOrCreateTeamId(teamName);
}
