// Loop registry foundation — route smoke: the manager exposes the seed catalog
// read-model at GET /loops, /loops/summary and /loops/:ref for /ops/loops.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
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
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SEED_LOOPS } from '../../src/loops/registry.js';
import { createLoopRun, loopRunPhid } from '../../src/loops/storage.js';
import type { ActorRef, LoopRunRecord, LoopRunStatus } from '../../src/loops/types.js';

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

const REPORT_NOW = '2026-07-07T21:00:00.000Z';
const REPORT_EXPECTED_FOR = '2026-07-07T18:00:00.000Z';
const REPORT_ACTOR: ActorRef = { kind: 'agent', id: 'sentinel' };

function persistedReportRun(over: {
  loop_slug: string;
  status: LoopRunStatus;
  output_path?: string | null;
  dispatch_phids?: string[];
  failure_detail?: string | null;
}): LoopRunRecord {
  const loop = SEED_LOOPS.find((l) => l.slug === over.loop_slug);
  if (!loop) throw new Error(`missing seed loop ${over.loop_slug}`);
  const idempotencyKey = `scheduled:${loop.loop_phid}:${REPORT_EXPECTED_FOR}`;
  return {
    loop_run_phid: loopRunPhid(loop.loop_phid, idempotencyKey),
    loop_phid: loop.loop_phid,
    trigger: {
      kind: 'scheduled',
      recurrence_phid: `phid:recurrence:${over.loop_slug}`,
      recurrence_instance_phid: null,
      scheduled_for: REPORT_EXPECTED_FOR,
      dedup_key: idempotencyKey,
    },
    status: over.status,
    failure_reason: over.status === 'failed' ? 'collector_failed' : null,
    failure_detail: over.failure_detail ?? null,
    step_log: [
      {
        step_id: 'collector',
        phase: 'collector',
        name: 'collect',
        status: over.status === 'failed' ? 'failed' : 'succeeded',
        started_at: REPORT_EXPECTED_FOR,
        finished_at: REPORT_NOW,
        failure_reason: over.status === 'failed' ? 'collector_failed' : null,
        detail: over.failure_detail ?? null,
        evidence_refs: [{ kind: 'query', ref: `${over.loop_slug}-ledger` }],
      },
    ],
    output_refs: over.output_path === undefined
      ? []
      : [{
          kind: 'markdown_report',
          artifact_phid: `phid:artifact:${over.loop_slug}`,
          path: over.output_path,
          href: null,
          dispatch_phids: over.dispatch_phids ?? [],
          delivery_status: 'not_applicable',
          required: true,
        }],
    spawned_dispatch_phids: over.dispatch_phids ?? [],
    idempotency_key: idempotencyKey,
    retry_of_phid: null,
    fired_at: REPORT_EXPECTED_FOR,
    queued_at: REPORT_EXPECTED_FOR,
    admitted_at: REPORT_EXPECTED_FOR,
    started_at: REPORT_EXPECTED_FOR,
    finished_at: REPORT_NOW,
    created_by: REPORT_ACTOR,
    updated_at: REPORT_NOW,
  };
}

describe('GET /loops registry routes', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-route-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /loops returns the seed catalog list envelope (all 17 loops)', async () => {
    const res = await fetch(`${baseUrl}/loops`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('loops-list-v1');
    // Health is now derived from the LoopRun substrate (definitions still from
    // the seed catalog), so the envelope reports `mixed`. With an empty
    // loop_runs table every loop rolls up to honest unknown/disabled — no fixture.
    expect(body.source).toBe('mixed');
    expect(body.loops).toHaveLength(17);
    expect(body.filters.owners.length).toBeGreaterThan(0);
    // every row carries the read-model identity + real (runs-derived) health
    for (const l of body.loops) {
      expect(l.loop_phid).toMatch(/^phid:loop:/);
      expect(['healthy', 'degraded', 'failed', 'disabled', 'unknown']).toContain(l.health.state);
      // empty substrate ⇒ honest emptiness, not a fabricated last run
      expect(l.health.last_run_at).toBeNull();
      expect(l.health.runs_last_7d).toBe(0);
    }
  });

  it('GET /loops?owner_agent= filters the list', async () => {
    const res = await fetch(`${baseUrl}/loops?owner_agent=sentinel`);
    const body = await res.json() as any;
    expect(body.loops.map((l: any) => l.slug).sort()).toEqual(['sentinel-verification-2h', 'task-reconciliation']);
  });

  it('GET /loops/summary returns the dashboard rollup', async () => {
    const res = await fetch(`${baseUrl}/loops/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('loops-dashboard-summary-v1');
    expect(body.total_enabled).toBe(10);
  });

  it('GET /loops/reports/due returns report obligations with status and proof fields', async () => {
    await createLoopRun(db.adapter, persistedReportRun({
      loop_slug: 'surface-feeder',
      status: 'succeeded',
      output_path: '/output/surface-feeder.md',
      dispatch_phids: ['phid:disp-surface'],
    }));
    await createLoopRun(db.adapter, persistedReportRun({
      loop_slug: 'task-reconciliation',
      status: 'failed',
      failure_detail: 'collector_failed_for_test',
    }));

    const res = await fetch(`${baseUrl}/loops/reports/due?now=${encodeURIComponent(REPORT_NOW)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('report-facts-v1');
    expect(body.definitions.map((d: any) => d.report_key)).toContain('kapelle:sentinel-verification-2h');
    expect(body.definitions.map((d: any) => d.report_key)).toContain('kapelle:product-overview-weekly');
    expect(body.definitions.map((d: any) => d.report_key)).toContain('kapelle:surface-feeder-6h');
    expect(body.definitions.map((d: any) => d.report_key)).toContain('kapelle:task-reconciliation-6h');
    expect(body.definitions.find((d: any) => d.report_key === 'worktree-hygiene:guard')).toMatchObject({
      owner_agent: 'maestra',
      cadence: { kind: 'interval_hours', every_hours: 18 },
      artifact_required: true,
      closeout_required: true,
    });
    expect(body.definitions.find((d: any) => d.report_key === 'kapelle:product-overview-weekly')).toMatchObject({
      owner_agent: 'maestra',
      artifact_required: true,
      closeout_required: true,
      closeout_requirement: 'artifact_or_ref_proof',
    });
    const sentinel = body.runs.find((r: any) => r.report_key === 'kapelle:sentinel-verification-2h');
    expect(sentinel).toMatchObject({
      status: 'late',
      owner_agent: 'sentinel',
      cadence: { kind: 'interval_hours', every_hours: 2, anchor_due_at: '2026-07-05T00:00:00.000Z' },
      freshness: 'due',
      reason: 'no_run_recorded_past_grace_window',
      artifact_link: null,
      closeout_required: true,
      closeout_requirement: 'artifact_or_ref_proof',
      loop_run_phid: null,
      artifact_refs: [],
      ref_proof: [],
    });
    const surface = body.runs.find((r: any) => r.report_key === 'kapelle:surface-feeder-6h');
    expect(surface).toMatchObject({
      status: 'done',
      owner_agent: 'maestra',
      freshness: 'fresh',
      reason: 'artifact_or_ref_proof_present',
      artifact_link: '/output/surface-feeder.md',
      artifact_refs: expect.arrayContaining([
        { kind: 'path', ref: '/output/surface-feeder.md' },
      ]),
      ref_proof: expect.arrayContaining([
        { kind: 'dispatch', ref: 'phid:disp-surface' },
      ]),
    });
    const failed = body.runs.find((r: any) => r.report_key === 'kapelle:task-reconciliation-6h');
    expect(failed).toMatchObject({
      status: 'failed',
      owner_agent: 'sentinel',
      freshness: 'stale',
      reason: 'collector_failed_for_test',
      artifact_link: null,
      closeout_required: true,
      artifact_refs: [],
    });
    expect(body.runs.find((r: any) => r.report_key === 'kapelle:library-research-biweekly')?.status).toBe('expected');
    expect(body.runs.find((r: any) => r.report_key === 'kapelle:weekly-project-report')?.status).toBe('skipped');
    expect(body.owed_now.map((r: any) => r.report_key)).toContain('kapelle:sentinel-verification-2h');
    expect(body.stale.map((r: any) => r.report_key)).toEqual(expect.arrayContaining([
      'kapelle:sentinel-verification-2h',
      'kapelle:task-reconciliation-6h',
    ]));
    expect(body.summary.expected).toBeGreaterThan(0);
    expect(body.summary.done).toBeGreaterThan(0);
    expect(body.summary.late).toBeGreaterThan(0);
    expect(body.summary.failed).toBeGreaterThan(0);
    expect(body.summary.skipped).toBeGreaterThan(0);
  });

  it('GET /loops/:ref resolves by slug and by phid; 404 otherwise', async () => {
    const bySlug = await fetch(`${baseUrl}/loops/morning-digest`);
    expect(bySlug.status).toBe(200);
    expect((await bySlug.json() as any).loop.slug).toBe('morning-digest');

    const byPhid = await fetch(`${baseUrl}/loops/phid:loop:inbox-intake`);
    expect(byPhid.status).toBe(200);
    expect((await byPhid.json() as any).loop.slug).toBe('inbox-intake');

    const missing = await fetch(`${baseUrl}/loops/not-a-loop`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error).toBe('loop_not_found');
  });
});
