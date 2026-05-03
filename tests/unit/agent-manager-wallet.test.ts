// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function makeManager() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-wallet-unit-'));
  const db = await createInMemoryDb();
  const manager = new AgentManagerDb(workDir, db as any);
  return { manager, db, workDir };
}

describe('AgentManagerDb wallet helpers', () => {
  const workDirs: string[] = [];
  const dbs: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      await dbs.pop()!.close();
    }
    while (workDirs.length > 0) {
      fs.rmSync(workDirs.pop()!, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('strips provisioned wallet metadata when wallet opt-in is false', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const getOrCreate = vi.fn(() => ({ walletName: 'idchain-coder', address: '0x1234' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const result = (manager as any).resolveWalletMetadata('idchain', 'coder', {
      name: 'coder',
      wallet: true,
      ows_wallet: 'old-wallet',
      ows_address: '0xold',
    }, false);

    expect(result.wallet).toBeNull();
    expect(result.metadata.wallet).toBe(false);
    expect(result.metadata.ows_wallet).toBeUndefined();
    expect(result.metadata.ows_address).toBeUndefined();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it('provisions wallet metadata only when opted in and only then injects OWS_WALLET into spawn env', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const getOrCreate = vi.fn(() => ({ walletName: 'idchain-coder', address: '0x1234' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const withWallet = (manager as any).resolveWalletMetadata('idchain', 'coder', {
      name: 'coder',
    }, true);
    const envWithWallet = (manager as any).buildLocalAgentEnv('idchain', 4101, {
      runtime: 'codex-cli',
      metadata: withWallet.metadata,
    }, 'gpt-5', 'tok-1');
    const envWithoutWallet = (manager as any).buildLocalAgentEnv('idchain', 4101, {
      runtime: 'codex-cli',
      metadata: { name: 'coder', wallet: false },
    }, 'gpt-5', 'tok-1');

    expect(getOrCreate).toHaveBeenCalledWith('idchain', 'coder');
    expect(withWallet.metadata.wallet).toBe(true);
    expect(withWallet.metadata.ows_wallet).toBe('idchain-coder');
    expect(withWallet.metadata.ows_address).toBe('0x1234');
    expect(envWithWallet.OWS_WALLET).toBe('idchain-coder');
    expect(envWithoutWallet.OWS_WALLET).toBeUndefined();
  });
});
