// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';

import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';

async function freshDb(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return adapter;
}

describe('logical agent identity bundle', () => {
  let adapter: SqliteAdapter;
  let teamsRepo: SqliteTeamsRepo;
  let agentsRepo: SqliteAgentsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    teamsRepo = new SqliteTeamsRepo(adapter);
    agentsRepo = new SqliteAgentsRepo(adapter);
    teamId = await teamsRepo.getOrCreateTeamId('default');
  });

  it('keeps finances addressable after its physical runtime session is exhausted', async () => {
    await agentsRepo.create({
      team_id: teamId,
      id: 'agent_finances_claude_session_1',
      name: 'finances',
      type: 'claude',
      model: 'claude-sonnet-4-20250514',
      runtime: 'claude-code-cli',
      status: 'running',
      port: 4254,
      created_at: 1000,
      metadata: {
        runtime_lane: 'claude-code-cli',
        provider_lane: 'anthropic',
        description: 'Finance specialist',
      },
    });

    await agentsRepo.updateStatus('agent_finances_claude_session_1', 'exhausted', {
      metadata: {
        runtime_lane: 'claude-code-cli',
        provider_lane: 'anthropic',
        exhausted_reason: 'usage_limit',
      },
    });
    await agentsRepo.deleteAgent('agent_finances_claude_session_1');

    expect(await agentsRepo.getByName(teamId, 'finances')).toBeNull();

    const logical = await agentsRepo.getLogicalIdentity(teamId, 'finances');
    expect(logical).toMatchObject({
      team_id: teamId,
      logical_agent: 'finances',
      display_name: 'finances',
    });
    expect(logical?.metadata).toMatchObject({
      description: 'Finance specialist',
    });
    expect(logical?.metadata).not.toHaveProperty('runtime_lane');
    expect(logical?.metadata).not.toHaveProperty('provider_lane');
    expect(logical?.metadata).not.toHaveProperty('exhausted_reason');
  });

  it('allows a replacement runtime lane to refresh the same logical bundle', async () => {
    await agentsRepo.create({
      team_id: teamId,
      id: 'agent_finances_claude_session_1',
      name: 'finances',
      type: 'claude',
      model: 'claude-sonnet-4-20250514',
      runtime: 'claude-code-cli',
      status: 'running',
      created_at: 1000,
      metadata: { runtime_lane: 'claude-code-cli', provider_lane: 'anthropic' },
    });
    await agentsRepo.deleteAgent('agent_finances_claude_session_1');

    await agentsRepo.create({
      team_id: teamId,
      id: 'agent_finances_codex_session_2',
      name: 'finances',
      type: 'claude',
      model: 'gpt-5.4',
      runtime: 'codex',
      status: 'running',
      created_at: 2000,
      metadata: { runtime_lane: 'codex', provider_lane: 'openai' },
    });

    const logical = await agentsRepo.getLogicalIdentity(teamId, 'finances');
    expect(logical?.logical_agent).toBe('finances');
    expect(logical?.metadata).not.toHaveProperty('runtime_lane');
    expect(logical?.metadata).not.toHaveProperty('provider_lane');
  });
});
