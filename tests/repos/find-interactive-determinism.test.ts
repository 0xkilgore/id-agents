// SPDX-License-Identifier: MIT
/**
 * Regression test for AgentsRepo.findInteractive(teamId).
 *
 * Phase 1 of cli-registry-refresh: when a team has multiple interactive
 * rows (e.g. CLI re-registered against a team after /sync re-targeted it),
 * findInteractive must pick the most recently created row deterministically.
 * Prior to the fix the SQL was `LIMIT 1` with no ORDER BY, so the row
 * returned was implementation-defined and reply routing could land on a
 * stale CLI id.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

function freshDb(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
  return adapter;
}

describe('AgentsRepo.findInteractive — deterministic newest-first selection', () => {
  let adapter: SqliteAdapter;
  let teamsRepo: SqliteTeamsRepo;
  let agentsRepo: SqliteAgentsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = freshDb();
    teamsRepo = new SqliteTeamsRepo(adapter);
    agentsRepo = new SqliteAgentsRepo(adapter);
    teamId = await teamsRepo.getOrCreateTeamId('test-team');
  });

  it('returns the newest interactive row when multiple exist', async () => {
    await agentsRepo.create({
      team_id: teamId,
      id: 'interactive_old',
      name: 'old-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 1000,
    });
    await agentsRepo.create({
      team_id: teamId,
      id: 'interactive_mid',
      name: 'mid-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 2000,
    });
    await agentsRepo.create({
      team_id: teamId,
      id: 'interactive_new',
      name: 'new-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 3000,
    });

    const found = await agentsRepo.findInteractive(teamId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe('interactive_new');
  });

  it('returns null when no interactive row exists for the team', async () => {
    await agentsRepo.create({
      team_id: teamId,
      id: 'claude_only',
      name: 'worker',
      type: 'claude',
      model: 'haiku',
      status: 'running',
      created_at: 1000,
    });

    const found = await agentsRepo.findInteractive(teamId);
    expect(found).toBeNull();
  });

  it('skips deleted interactive rows even when they are the newest', async () => {
    await agentsRepo.create({
      team_id: teamId,
      id: 'interactive_alive',
      name: 'alive-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 1000,
    });
    await agentsRepo.create({
      team_id: teamId,
      id: 'interactive_tombstoned',
      name: 'dead-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 2000,
    });
    await agentsRepo.deleteAgent('interactive_tombstoned');

    const found = await agentsRepo.findInteractive(teamId);
    expect(found?.id).toBe('interactive_alive');
  });

  it('does not bleed interactive rows across teams', async () => {
    const otherTeamId = await teamsRepo.getOrCreateTeamId('other-team');
    await agentsRepo.create({
      team_id: otherTeamId,
      id: 'interactive_other_newer',
      name: 'other-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 9999,
    });
    await agentsRepo.create({
      team_id: teamId,
      id: 'interactive_mine',
      name: 'mine-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 1000,
    });

    const found = await agentsRepo.findInteractive(teamId);
    expect(found?.id).toBe('interactive_mine');
  });
});
