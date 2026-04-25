// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { DeliverFn } from '../../src/lib/ssh-deliver.js';
import type { IdChainRegisterResult } from '../../src/onchain/idchain-register.js';

function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
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

async function findFreePort(): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

describe('wallet opt-in manager integration', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let port: number;
  let registerCalls: Array<{ sublabel?: string }> = [];

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-wallet-int-'));
    db = createInMemoryDb();
    registerCalls = [];

    const deliverFn: DeliverFn = async () => ({ ok: true });
    const registerOnIdChainFn = async (opts: {
      sublabel?: string;
      textRecords?: Record<string, string>;
      privateKey?: string;
      wallet?: string;
    }): Promise<IdChainRegisterResult> => {
      registerCalls.push({ sublabel: opts.sublabel });
      return {
        domain: `${opts.sublabel || 'agent'}.wallet-test.xid.eth`,
        label: 'agent-wallet-test',
        txHash: `0x${'ab'.repeat(32)}`,
        chainId: 8453,
        chain: 'Base',
      };
    };

    manager = new AgentManagerDb(workDir, db as any, {
      deliverFn,
      registerOnIdChainFn: registerOnIdChainFn as any,
    });
    await manager.start(port);
    await db.teams.getOrCreateTeamId('public');
    process.env.PRIVATE_KEY = '0x' + 'aa'.repeat(32);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PRIVATE_KEY;
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
    await db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function registerRemoteAgent(name: string, opts?: { wallet?: boolean }) {
    const resp = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name,
        runtime: 'public-agent-remote',
        customer_domain: `${name}.example.com`,
        public_endpoint_url: `https://${name}.example.com`,
        ...(opts && Object.prototype.hasOwnProperty.call(opts, 'wallet') ? { wallet: opts.wallet } : {}),
      }),
    });
    expect(resp.status).toBe(201);
    return resp.json() as Promise<{ id: string; name: string }>;
  }

  it('does not auto-provision remote wallets during onchain register when wallet is not enabled', async () => {
    const agent = await registerRemoteAgent('walletless-remote');
    const getOrCreate = vi.fn(() => ({ walletName: 'public-walletless-remote', address: '0x1111' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const regResp = await fetch(`${baseUrl}/agents/${agent.id}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    });
    expect(regResp.ok).toBe(true);
    expect(registerCalls.length).toBe(1);
    expect(getOrCreate).not.toHaveBeenCalled();

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, {
      headers: adminHeaders('public'),
    });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.wallet).toBe(false);
    expect(detail.metadata?.ows_wallet).toBeUndefined();
    expect(detail.metadata?.ows_address).toBeUndefined();
  });

  it('auto-provisions remote wallets during onchain register when wallet is enabled', async () => {
    const agent = await registerRemoteAgent('wallet-enabled-remote', { wallet: true });
    const getOrCreate = vi.fn(() => ({ walletName: 'public-wallet-enabled-remote', address: '0x2222' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const regResp = await fetch(`${baseUrl}/agents/${agent.id}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    });
    expect(regResp.ok).toBe(true);
    expect(getOrCreate).toHaveBeenCalledWith('public', 'wallet-enabled-remote');

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, {
      headers: adminHeaders('public'),
    });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.wallet).toBe(true);
    expect(detail.metadata?.ows_wallet).toBe('public-wallet-enabled-remote');
    expect(detail.metadata?.ows_address).toBe('0x2222');
  });

  it('provisions wallets on demand through the /remote /agent command surface', async () => {
    const agent = await registerRemoteAgent('wallet-command-remote');
    const getOrCreate = vi.fn(() => ({ walletName: 'public-wallet-command-remote', address: '0x3333' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const remoteResp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command: '/agent wallet-command-remote wallet provision' }),
    });
    expect(remoteResp.ok).toBe(true);
    const remoteBody = await remoteResp.json() as any;
    expect(remoteBody.ok).toBe(true);
    expect(remoteBody.result.status).toBe('provisioned');
    expect(remoteBody.result.ows_wallet).toBe('public-wallet-command-remote');
    expect(getOrCreate).toHaveBeenCalledWith('public', 'wallet-command-remote');

    const againResp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command: '/agent wallet-command-remote wallet provision' }),
    });
    const againBody = await againResp.json() as any;
    expect(againBody.result.status).toBe('already-provisioned');

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, {
      headers: adminHeaders('public'),
    });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.wallet).toBe(true);
    expect(detail.metadata?.ows_wallet).toBe('public-wallet-command-remote');
    expect(detail.metadata?.ows_address).toBe('0x3333');
  });
});
