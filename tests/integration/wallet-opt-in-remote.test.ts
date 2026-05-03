// SPDX-License-Identifier: MIT
/**
 * wallet-opt-in: integration tests for the on-demand
 * `/agent <name> wallet provision` /remote command.
 *
 * The deploy/sync path does not call `ows wallet create` unless an agent
 * is explicitly opted in; on-demand provisioning is the operator's
 * escape hatch when wallet was deferred at deploy time.
 *
 * These tests stub `ows` by writing a fake binary into a temp dir and
 * prepending it to PATH, so they run in CI without a real OWS install.
 * If a stub cannot be installed (Windows etc.) the tests soft-skip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
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

let port: number;
let baseUrl: string;
let workDir: string;
let owsStubDir: string;
let priorPath: string | undefined;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;
let canStubOws = false;

beforeAll(async () => {
  // Stub `ows` so we can exercise wallet provisioning without a real
  // install. The stub responds to `ows --version`, `ows wallet list`,
  // and `ows wallet create --name <n>` with deterministic output that
  // matches the parser in getOrCreateAgentWallet.
  try {
    owsStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-opt-in-stub-'));
    const stubPath = path.join(owsStubDir, 'ows');
    fs.writeFileSync(stubPath, [
      '#!/usr/bin/env bash',
      '# Test stub for ows CLI used by wallet-opt-in integration tests.',
      'case "$1" in',
      '  --version) echo "ows-stub 0.0.0"; exit 0 ;;',
      '  wallet)',
      '    case "$2" in',
      '      list) echo ""; exit 0 ;;',
      '      create)',
      '        # args: wallet create --name <walletName>',
      '        echo "Created wallet $4"',
      '        echo "  eip155:1 default → 0x000000000000000000000000000000000000abcd"',
      '        exit 0 ;;',
      '    esac ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'));
    fs.chmodSync(stubPath, 0o755);
    priorPath = process.env.PATH;
    process.env.PATH = `${owsStubDir}${path.delimiter}${process.env.PATH || ''}`;
    canStubOws = true;
  } catch {
    canStubOws = false;
  }

  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-opt-in-test-'));
  baseUrl = `http://127.0.0.1:${port}`;
  db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
  if (priorPath !== undefined) process.env.PATH = priorPath;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(owsStubDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

describe('/remote /agent <name> wallet provision', () => {
  const TEAM = 'wallet-opt-in';

  it('returns an error when OWS is not installed', async () => {
    // Temporarily move the stub out of PATH so checkOwsInstalled returns false.
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const teamId = await db.teams.getOrCreateTeamId(TEAM);
      await db.agents.create({
        team_id: teamId,
        id: 'agent_no_ows',
        name: 'no-ows-agent',
        type: 'claude',
        model: 'haiku',
        status: 'running',
        created_at: Date.now(),
      });

      const res = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ command: '/agent no-ows-agent wallet provision' }),
      });
      const body = await res.json() as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/OWS CLI not installed/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('provisions a wallet on demand and persists metadata', async () => {
    if (!canStubOws) return;
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId,
      id: 'agent_to_provision',
      name: 'provisionable',
      type: 'claude',
      model: 'haiku',
      // Explicitly opted out at deploy — exactly the case where on-demand
      // provisioning is the right escape hatch.
      metadata: { wallet: false } as Record<string, unknown>,
      status: 'running',
      created_at: Date.now(),
    });

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ command: '/agent provisionable wallet provision' }),
    });
    const body = await res.json() as { ok: boolean; result?: any; error?: string };
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe('provisioned');
    expect(body.result.ows_wallet).toBe(`${TEAM}-provisionable`);
    expect(body.result.ows_address).toMatch(/^0x/);

    const refreshed = await db.agents.getById('agent_to_provision');
    const meta = refreshed?.metadata as Record<string, unknown> | undefined;
    expect(meta?.wallet).toBe(true);
    expect(meta?.ows_wallet).toBe(`${TEAM}-provisionable`);
    expect(typeof meta?.ows_address).toBe('string');
  });

  it('is idempotent — returns already-provisioned without re-running ows', async () => {
    if (!canStubOws) return;
    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ command: '/agent provisionable wallet provision' }),
    });
    const body = await res.json() as { ok: boolean; result?: any };
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe('already-provisioned');
    expect(body.result.ows_wallet).toBe(`${TEAM}-provisionable`);
  });

  it('returns Usage error when sub-action is missing or wrong', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId,
      id: 'agent_usage',
      name: 'usage-agent',
      type: 'claude',
      model: 'haiku',
      status: 'running',
      created_at: Date.now(),
    });

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ command: '/agent usage-agent wallet bogus' }),
    });
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Usage: \/agent <name> wallet provision/);
  });

  it('rejects unknown agent names with a clear error', async () => {
    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ command: '/agent nope wallet provision' }),
    });
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not found/);
  });
});
