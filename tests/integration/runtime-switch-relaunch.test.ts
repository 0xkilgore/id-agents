// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

async function createDb() {
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
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

describe('runtime switch and relaunch routes', () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let previousAnthropicKey: string | undefined;

  beforeEach(async () => {
    previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    db = await createDb();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-switch-relaunch-'));
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentDir = path.join(workDir, 'maestra-workdir');
    fs.mkdirSync(path.join(agentDir, 'output'), { recursive: true });
    await db.agents.create({
      team_id: teamId,
      id: 'agent_maestra',
      name: 'maestra',
      type: 'claude',
      model: 'gpt-5.5',
      port: 0,
      endpoint: 'http://localhost:4109',
      working_directory: agentDir,
      status: 'running',
      created_at: Date.now(),
      runtime: 'codex',
      metadata: {
        runtime: 'codex',
        skills: ['inter-agent'],
        allowed_tools: ['Read'],
        catalog: { role: 'orchestrator', desiredModel: 'gpt-5.5' },
      },
    });
    await db.adapter.query(
      `INSERT INTO agent_runtime_policy
        (team_id, logical_agent, allowed_lanes_json, fallback_order_json, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        teamId,
        'maestra',
        JSON.stringify(['anthropic']),
        JSON.stringify([
          { runtime: 'claude-agent-sdk', model: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
        ]),
        'test allowed runtime',
        Date.now(),
        Date.now(),
      ],
    );

    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({
      success: true,
      pid: 12345,
      logFile: '/tmp/maestra.log',
    });
    (manager as any).killAgentProcess = async () => ({ killed: [], skipped: [] });
    await manager.start(port);
  });

  afterEach(async () => {
    (manager as any).dispatchScheduler?.stop?.();
    (manager as any).schedulerService?.stop?.();
    (manager as any).dispatchVerificationJob?.stop?.();
    (manager as any).dispatchRecoveryService?.stop?.();
    if ((manager as any).healthCheckInterval) clearInterval((manager as any).healthCheckInterval);
    if ((manager as any).freshnessMonitorInterval) clearInterval((manager as any).freshnessMonitorInterval);
    if ((manager as any).fleetBlockageMonitorInterval) clearInterval((manager as any).fleetBlockageMonitorInterval);
    if ((manager as any).retentionInterval) clearInterval((manager as any).retentionInterval);
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 300);
    });
    await db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    if (previousAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
  });

  it('switches desired runtime policy first, then relaunches in the same working directory', async () => {
    const res = await fetch(`${baseUrl}/agents/maestra/runtime/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'claude-agent-sdk', model: 'claude-haiku-4-5-20251001' }),
    });
    const body = await res.json() as any;

    expect(res.status, JSON.stringify(body, null, 2)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.policy_updated_first).toBe(true);
    expect(body.relaunch.workingDirectory).toBe(path.join(workDir, 'maestra-workdir'));
    expect(body.timeline.map((e: any) => e.step).indexOf('policy_update')).toBeLessThan(
      body.timeline.map((e: any) => e.step).indexOf('spawn'),
    );

    const policy = await db.adapter.query<any>(
      `SELECT allowed_lanes_json, fallback_order_json FROM agent_runtime_policy WHERE logical_agent = ?`,
      ['maestra'],
    );
    expect(JSON.parse(policy.rows[0].allowed_lanes_json)).toEqual(['anthropic']);
    expect(JSON.parse(policy.rows[0].fallback_order_json)[0]).toMatchObject({
      runtime: 'claude-agent-sdk',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
    });

    const agent = await db.agents.getById('agent_maestra');
    expect(agent?.runtime).toBe('claude-agent-sdk');
    expect(agent?.model).toBe('claude-haiku-4-5-20251001');
    expect(agent?.working_directory).toBe(path.join(workDir, 'maestra-workdir'));

    const events = await db.events.query({ teamId: agent!.team_id, topics: ['agent.runtime.switch'] });
    expect(events).toHaveLength(1);
    expect((events[0].data as any).timeline.some((e: any) => e.step === 'policy_update')).toBe(true);
  });

  it('dry-run relaunch reports preflight without spawning', async () => {
    const res = await fetch(`${baseUrl}/agents/maestra/relaunch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preserve_context: true,
        runtime: 'claude-agent-sdk',
        model: 'claude-haiku-4-5-20251001',
        dry_run: true,
      }),
    });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.dry_run).toBe(true);
    expect(body.relaunch.workingDirectory).toBe(path.join(workDir, 'maestra-workdir'));
    expect(body.timeline.map((e: any) => e.step)).toContain('dry_run');
  });

  it('blocks on stale in-flight readiness rows with a concrete reason', async () => {
    const teamId = (await db.agents.getById('agent_maestra'))!.team_id;
    await db.adapter.query(
      `INSERT INTO orchestration_backlog_item
        (item_id, team_id, title, to_agent, dispatch_body, readiness_state, risk_class, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'in_flight', 'routine', ?, ?)`,
      ['item_stale', teamId, 'stale maestra work', 'maestra', 'do work', new Date().toISOString(), new Date().toISOString()],
    );

    const res = await fetch(`${baseUrl}/agents/maestra/relaunch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preserve_context: true,
        runtime: 'claude-agent-sdk',
        model: 'claude-haiku-4-5-20251001',
        dry_run: true,
      }),
    });
    const body = await res.json() as any;

    expect(res.status).toBe(409);
    expect(body.code).toBe('stale_readiness_row');
    expect(body.error).toContain('item_stale');
    expect(body.preflight.blockers[0].detail.item_id).toBe('item_stale');
  });

  it('serves routing health at the slash alias used by live probes', async () => {
    (manager as any).cachedRoutingHealthModel = async (teamName: string) => ({
      schema_version: 'routing-health-v1',
      team: teamName,
      summary: { severity: 'ok', healthy: true, runtimes_down: [] },
    });

    const res = await fetch(`${baseUrl}/routing/health`, {
      headers: { 'X-Id-Team': 'default' },
    });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.schema_version).toBe('routing-health-v1');
    expect(body.summary.healthy).toBe(true);
  });
});
