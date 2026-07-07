import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

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
    events: new SqliteEventsRepo(adapter),
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

function headers(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;

beforeAll(async () => {
  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-dispatch-read-routes-'));
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
  try { await db?.close(); } catch { /* ignore */ }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('manager dispatch read routes', () => {
  it('lists active dispatches with provenance fields', async () => {
    const teamId = await db.teams.getOrCreateTeamId('dispatch-read-active');
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-active-1',
      query_id: 'query_active_1',
      to_agent: 'roger',
      status: 'needs_clarification',
      subject: 'Active route build',
      clarification_id: 'clar_1',
      active_clarification_json: JSON.stringify({
        clarification_id: 'clar_1',
        agent_id: 'roger',
        query_id: 'query_active_1',
        question: 'Which branch?',
        context: { repo: 'id-agents' },
        urgency: 'normal',
        created_at: '2026-06-04T10:00:00.000Z',
        stale_at: '2026-06-04T12:00:00.000Z',
      }),
      clarification_history_json: JSON.stringify([{ type: 'NEEDS_CLARIFICATION', clarification_id: 'clar_1' }]),
      promotion_input_json: JSON.stringify({ repo: '/repo', branch: 'feat', base: 'main', remote: 'origin' }),
    });
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-done-hidden',
      query_id: 'query_done_hidden',
      status: 'done',
      completed_at: '2026-06-04T12:30:00.000Z',
    });

    const res = await fetch(`${baseUrl}/dispatches?status=active&limit=100`, { headers: headers('dispatch-read-active') });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('active');
    expect(body.dispatches).toHaveLength(1);
    expect(body.dispatches[0]).toMatchObject({
      dispatch_id: 'phid:disp-active-1',
      query_id: 'query_active_1',
      target_agent: 'roger',
      agent_id: 'roger',
      status: 'needs_clarification',
      needs_input: {
        clarification_id: 'clar_1',
      },
      promotion: {
        promote: true,
      },
      source: 'manager-http',
    });
    expect(body.dispatches[0].promotion.input).toMatchObject({ repo: '/repo', branch: 'feat' });
  });

  it('lists terminal dispatches with failure and promotion result fields', async () => {
    const teamId = await db.teams.getOrCreateTeamId('dispatch-read-terminal');
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-terminal-1',
      query_id: 'query_terminal_1',
      to_agent: 'regina',
      status: 'failed',
      subject: 'Terminal dispatch',
      completed_at: '2026-06-04T12:00:00.000Z',
      failure_kind: 'agent_error',
      failure_detail: 'test failure detail',
      promotion_result_json: JSON.stringify({ required: true, completed: false, repos: [] }),
    });

    const res = await fetch(`${baseUrl}/dispatches?status=terminal`, { headers: headers('dispatch-read-terminal') });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.dispatches).toHaveLength(1);
    expect(body.dispatches[0]).toMatchObject({
      dispatch_id: 'phid:disp-terminal-1',
      status: 'failed',
      done_at: '2026-06-04T12:00:00.000Z',
      failure_kind: 'agent_error',
      failure_detail: 'test failure detail',
    });
    expect(body.dispatches[0].promotion.result).toMatchObject({ required: true, completed: false });
  });

  it('returns 404 for a missing dispatch detail route', async () => {
    await db.teams.getOrCreateTeamId('dispatch-read-missing');
    const res = await fetch(`${baseUrl}/dispatches/phid:disp-missing`, { headers: headers('dispatch-read-missing') });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('dispatch_not_found');
  });

  it('returns enriched dispatch-detail.v1 payload for in-flight dispatch', async () => {
    const teamId = await db.teams.getOrCreateTeamId('dispatch-read-detail');
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-detail-enriched',
      query_id: 'query_detail_enriched',
      to_agent: 'substrate-api-codex',
      status: 'in_flight',
      subject: 'Detail enrich smoke',
      started_at: '2026-06-26T10:05:00.000Z',
      body_markdown: '[project:kapelle] enrich detail payload',
      promotion_input_json: JSON.stringify({
        repo: '/repo/id-agents',
        branch: 'feat/x',
        base: 'main',
        remote: 'origin',
      }),
      result_json: JSON.stringify({ artifact_path: '/repo/id-agents/output/report.md' }),
    });

    const res = await fetch(
      `${baseUrl}/dispatches/phid:disp-detail-enriched/detail`,
      { headers: headers('dispatch-read-detail') },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('dispatch-detail.v1');
    expect(body.dispatch.dispatch_id).toBe('phid:disp-detail-enriched');
    expect(body.dispatch.write_scope).toEqual(['/repo/id-agents', '/repo/id-agents@feat/x']);
    expect(body.dispatch.message_excerpt).toMatch(/enrich detail payload/i);
    expect(body.dispatch.status_timeline.map((event: any) => event.label)).toContain('In flight');
    expect(body.dispatch.linked_artifact).toMatchObject({
      id: 'dispatch:phid:disp-detail-enriched',
      basename: 'report.md',
      source: 'result_json',
    });
  });

  it('honors limit for all dispatches', async () => {
    const teamId = await db.teams.getOrCreateTeamId('dispatch-read-limit');
    await insertDispatch(teamId, { dispatch_phid: 'phid:disp-limit-1', query_id: 'query_limit_1', status: 'queued' });
    await insertDispatch(teamId, { dispatch_phid: 'phid:disp-limit-2', query_id: 'query_limit_2', status: 'done', completed_at: '2026-06-04T12:00:00.000Z' });

    const res = await fetch(`${baseUrl}/dispatches?status=all&limit=1`, { headers: headers('dispatch-read-limit') });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.limit).toBe(1);
    expect(body.dispatches).toHaveLength(1);
  });

  it('scopes dispatches and health by team', async () => {
    const alphaId = await db.teams.getOrCreateTeamId('dispatch-read-alpha');
    const betaId = await db.teams.getOrCreateTeamId('dispatch-read-beta');
    await insertDispatch(alphaId, { dispatch_phid: 'phid:disp-alpha', query_id: 'query_alpha', status: 'queued' });
    await insertDispatch(betaId, { dispatch_phid: 'phid:disp-beta', query_id: 'query_beta', status: 'done', completed_at: '2026-06-04T12:00:00.000Z' });

    const alpha = await fetch(`${baseUrl}/dispatches?status=all`, { headers: headers('dispatch-read-alpha') });
    const alphaBody = await alpha.json() as any;
    expect(alphaBody.dispatches.map((d: any) => d.dispatch_id)).toContain('phid:disp-alpha');
    expect(alphaBody.dispatches.map((d: any) => d.dispatch_id)).not.toContain('phid:disp-beta');

    const health = await fetch(`${baseUrl}/dispatches/health`, { headers: headers('dispatch-read-beta') });
    expect(health.status).toBe(200);
    const healthBody = await health.json() as any;
    expect(healthBody.team).toBe('dispatch-read-beta');
    expect(healthBody.terminal).toBe(1);
    expect(healthBody.active).toBe(0);
  });

  it('lists artifacts from dispatch results and agent output directories', async () => {
    const teamId = await db.teams.getOrCreateTeamId('dispatch-read-artifacts');
    const agentDir = path.join(workDir, 'artifact-agent');
    const outputDir = path.join(agentDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const dispatchArtifactPath = path.join(outputDir, 'dispatch-report.md');
    const outputArtifactPath = path.join(outputDir, 'agent-report.md');
    fs.writeFileSync(dispatchArtifactPath, '# Dispatch report\n');
    fs.writeFileSync(outputArtifactPath, '# Agent report\n');

    await db.agents.create({
      team_id: teamId,
      id: 'artifact-agent-id',
      name: 'artifact-agent',
      type: 'claude',
      model: 'test',
      status: 'running',
      created_at: Date.now(),
      working_directory: agentDir,
    });
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-artifact',
      query_id: 'query_artifact',
      to_agent: 'artifact-agent',
      status: 'done',
      completed_at: '2026-06-04T13:00:00.000Z',
      result_json: JSON.stringify({ artifact_path: dispatchArtifactPath, tl_dr: 'artifact summary' }),
    });
    await db.queries.upsert(teamId, 'artifact-agent-id', {
      query_id: 'agent_query_artifact',
      status: 'completed',
      prompt: 'write report',
      created: Date.now(),
      completed: Date.now(),
      result: {
        result: `Done.\n\nOutput: [agent-report.md](${outputArtifactPath})`,
      },
      manager_dispatch_id: 'phid:disp-artifact',
      manager_query_id: 'query_artifact',
    });

    const res = await fetch(`${baseUrl}/artifacts?limit=10`, { headers: headers('dispatch-read-artifacts') });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.team).toBe('dispatch-read-artifacts');
    expect(body.source_metadata.sources).toEqual([
      'dispatch_scheduler_queue.result_json',
      'queries.result',
      'agents.working_directory/output',
    ]);
    expect(body.artifacts.map((a: any) => a.id)).toContain('dispatch:phid:disp-artifact');
    expect(body.artifacts.map((a: any) => a.id)).toContain('query:agent_query_artifact:agent-report.md');
    expect(body.artifacts.find((a: any) => a.id === 'dispatch:phid:disp-artifact')).toMatchObject({
      path: dispatchArtifactPath,
      basename: 'dispatch-report.md',
      target_agent: 'artifact-agent',
      dispatch_id: 'phid:disp-artifact',
      query_id: 'query_artifact',
      status: 'available',
      exists: true,
      tl_dr: 'artifact summary',
    });
    expect(body.artifacts.find((a: any) => a.id === 'query:agent_query_artifact:agent-report.md')).toMatchObject({
      path: outputArtifactPath,
      basename: 'agent-report.md',
      target_agent: 'artifact-agent',
      dispatch_id: 'phid:disp-artifact',
      query_id: 'agent_query_artifact',
      manager_query_id: 'query_artifact',
      status: 'available',
      exists: true,
    });
  });

  it('lists agent obligations with expected, done, late, and failed states', async () => {
    const teamId = await db.teams.getOrCreateTeamId('agent-obligations-fixture');
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-obligation-expected',
      query_id: 'query_obligation_expected',
      to_agent: 'roger',
      from_actor: 'manager',
      status: 'queued',
      subject: 'Write report',
      not_before_at: '2099-07-07T11:45:00.000Z',
      updated_at: '2099-07-07T11:45:00.000Z',
    });
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-obligation-done',
      query_id: 'query_obligation_done',
      to_agent: 'roger',
      from_actor: 'manager',
      status: 'done',
      subject: 'Prepare handoff',
      completed_at: '2026-07-07T11:50:00.000Z',
      updated_at: '2026-07-07T11:50:00.000Z',
    });
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-obligation-late-closeout',
      query_id: 'query_obligation_late',
      to_agent: 'regina',
      from_actor: 'continuous-orchestration',
      status: 'in_flight',
      subject: 'Build dispatch closeout',
      started_at: '2026-07-07T10:00:00.000Z',
      updated_at: '2026-07-07T10:00:00.000Z',
    });
    await insertDispatch(teamId, {
      dispatch_phid: 'phid:disp-obligation-failed',
      query_id: 'query_obligation_failed',
      to_agent: 'cane',
      from_actor: 'operator',
      channel: 'artifact_comment',
      status: 'failed',
      subject: 'Operator comment follow-up',
      completed_at: '2026-07-07T10:20:00.000Z',
      updated_at: '2026-07-07T10:20:00.000Z',
      failure_kind: 'agent_error',
      failure_detail: 'comment route failed',
    });

    const res = await fetch(`${baseUrl}/agent-obligations?limit=20`, { headers: headers('agent-obligations-fixture') });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('agent-obligations.v1');
    expect(body.obligations).toHaveLength(4);

    const byId = new Map(body.obligations.map((o: any) => [o.obligation_id, o]));
    expect(byId.get('agent-obligation:phid:disp-obligation-expected')).toMatchObject({
      source_kind: 'report',
      source_ref: 'query_obligation_expected',
      agent: 'roger',
      owner: 'manager',
      status: 'expected',
      stale_after: '2099-07-07T12:15:00.000Z',
      due_at: '2099-07-07T12:15:00.000Z',
    });
    expect(byId.get('agent-obligation:phid:disp-obligation-done')).toMatchObject({
      source_kind: 'handoff',
      agent: 'roger',
      status: 'done',
      stale_after: null,
      due_at: null,
      last_event_at: '2026-07-07T11:50:00.000Z',
    });
    expect(byId.get('agent-obligation:phid:disp-obligation-late-closeout')).toMatchObject({
      source_kind: 'closeout',
      agent: 'regina',
      owner: 'continuous-orchestration',
      status: 'late',
      stale_after: '2026-07-07T10:30:00.000Z',
      due_at: '2026-07-07T10:30:00.000Z',
    });
    expect(byId.get('agent-obligation:phid:disp-obligation-late-closeout').dashboard_reason)
      .toMatch(/stale missing closeout/i);
    expect(byId.get('agent-obligation:phid:disp-obligation-failed')).toMatchObject({
      source_kind: 'comment',
      source_ref: 'query_obligation_failed',
      agent: 'cane',
      owner: 'operator',
      status: 'failed',
      dashboard_reason: 'Comment follow-up failed: comment route failed',
    });

    const late = await fetch(`${baseUrl}/agent-obligations?status=late`, { headers: headers('agent-obligations-fixture') });
    const lateBody = await late.json() as any;
    expect(lateBody.obligations.map((o: any) => o.obligation_id)).toEqual([
      'agent-obligation:phid:disp-obligation-late-closeout',
    ]);
  });
});

async function insertDispatch(teamId: string, overrides: Partial<{
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  from_actor: string;
  channel: string;
  status: string;
  subject: string;
  body_markdown: string;
  not_before_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  failure_kind: string | null;
  failure_detail: string | null;
  clarification_id: string | null;
  active_clarification_json: string | null;
  clarification_history_json: string;
  promotion_input_json: string | null;
  promotion_result_json: string | null;
  result_json: string | null;
}> = {}) {
  const now = '2026-06-04T11:00:00.000Z';
  const dispatchPhid = overrides.dispatch_phid ?? `phid:disp-${Math.random().toString(16).slice(2)}`;
  await db.adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
      dispatch_phid, team_id, query_id, to_agent, from_actor, channel,
      subject, body_markdown, provider, runtime, priority, status,
      not_before_at, attempt_count, bounce_count, last_bounce_json,
      bounce_history_json, started_at, completed_at, updated_at,
      agent_query_id, usage_policy_snapshot_json, failure_kind,
      failure_detail, target_url, result_json, clarification_id,
      active_clarification_json, clarification_history_json,
      resume_delivery_status, promote, promotion_strategy,
      promotion_required_reason, promotion_result_json, promotion_input_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      dispatchPhid,
      teamId,
      overrides.query_id ?? `query_${dispatchPhid.replace(/[^a-z0-9]/gi, '_')}`,
      overrides.to_agent ?? 'coder-max',
      overrides.from_actor ?? 'manager',
      overrides.channel ?? 'talk',
      overrides.subject ?? 'Dispatch read route test',
      overrides.body_markdown ?? 'Test body',
      'anthropic',
      'codex',
      5,
      overrides.status ?? 'queued',
      overrides.not_before_at ?? now,
      0,
      0,
      null,
      '[]',
      overrides.started_at ?? null,
      overrides.completed_at ?? null,
      overrides.updated_at ?? now,
      null,
      null,
      overrides.failure_kind ?? null,
      overrides.failure_detail ?? null,
      null,
      overrides.result_json ?? null,
      overrides.clarification_id ?? null,
      overrides.active_clarification_json ?? null,
      overrides.clarification_history_json ?? '[]',
      'none',
      1,
      'auto',
      null,
      overrides.promotion_result_json ?? null,
      overrides.promotion_input_json ?? null,
    ],
  );
}
