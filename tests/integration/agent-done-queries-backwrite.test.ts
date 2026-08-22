// SPDX-License-Identifier: MIT
/**
 * Integration tests for the queries-row back-write on POST /agent-done.
 *
 * Reproduces the 2026-06-13 read-model gap (cane artifact
 * `output/2026-06-13-query-row-not-resolved-after-dispatch-done.md`):
 * historically, when the scheduler closed `dispatch_scheduler_queue` via
 * /agent-done, the corresponding `queries` row was NEVER updated. Result:
 * /query/<id> stayed `status=pending` forever even though the dispatch
 * was done. CTO dispatch query_1781370010051_n1hjeqq and Maestra
 * dispatch query_1781370010083_9v4sj6q on 2026-06-13 are the reference
 * reproduction IDs.
 *
 * Fix: /agent-done now back-writes the matching queries row by
 * manager-side query_id. These tests pin the contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'node:crypto';

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
import { artifactIdFromPath, getArtifact, getArtifactBodyCache } from '../../src/outputs/storage.js';
import { flushPendingReportCandidateOutbox } from '../../src/report-publishing/outbox.js';

const TEAM = 'agent-done-queries-backwrite-test';

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

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

async function insertAgentDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint?: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, endpoint ?? null, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

describe('POST /agent-done — queries-row back-write', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let defaultTeamId: string;
  let coderAgentId: string;
  let prevSchedulerEnabled: string | undefined;
  let prevReportPromotionRequestDir: string | undefined;
  let prevReportPromotionAllowedRoot: string | undefined;
  let reportPromotionRequestDir: string;

  async function enqueueDispatch(): Promise<{ ok: boolean; dispatch_phid: string; query_id: string }> {
    const res = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ from_actor: 'cane', to_agent: 'coder', message: 'hi' }),
    });
    return res.json() as Promise<{ ok: boolean; dispatch_phid: string; query_id: string }>;
  }

  /**
   * Mirror the production wrap: when manager dispatches to an agent, BOTH a
   * dispatch_scheduler_queue row AND a queries row are created with the
   * same manager-side query_id. The strict-match test only set up the
   * former; this test sets up both so we can verify the back-write hits
   * the latter on closeout.
   */
  async function setupDispatchWithQueryRow(): Promise<{ dispatch_phid: string; query_id: string }> {
    const enq = await enqueueDispatch();
    // Insert the parallel queries row (status='pending') just like the
    // /talk wrap path does in production.
    await db.queries.create(
      defaultTeamId,
      enq.query_id,
      coderAgentId,
      'test prompt',
      Date.now(),
    );
    return { dispatch_phid: enq.dispatch_phid, query_id: enq.query_id };
  }

  beforeAll(async () => {
    prevSchedulerEnabled = process.env.DISPATCH_SCHEDULER_ENABLED;
    prevReportPromotionRequestDir = process.env.REPORT_PROMOTION_REQUEST_DIR;
    prevReportPromotionAllowedRoot = process.env.REPORT_PROMOTION_ALLOWED_ROOT;
    process.env.DISPATCH_SCHEDULER_ENABLED = 'false';

    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-done-queries-backwrite-test-'));
    reportPromotionRequestDir = path.join(fs.realpathSync.native(workDir), 'report-promotion-requests');
    fs.mkdirSync(reportPromotionRequestDir, { mode: 0o700 });
    process.env.REPORT_PROMOTION_REQUEST_DIR = reportPromotionRequestDir;
    process.env.REPORT_PROMOTION_ALLOWED_ROOT = fs.realpathSync.native(workDir);
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    defaultTeamId = await db.teams.getOrCreateTeamId('default');
    coderAgentId = await insertAgentDirect(db, defaultTeamId, 'coder', 'http://127.0.0.1:19999');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (prevSchedulerEnabled === undefined) delete process.env.DISPATCH_SCHEDULER_ENABLED;
    else process.env.DISPATCH_SCHEDULER_ENABLED = prevSchedulerEnabled;
    if (prevReportPromotionRequestDir === undefined) delete process.env.REPORT_PROMOTION_REQUEST_DIR;
    else process.env.REPORT_PROMOTION_REQUEST_DIR = prevReportPromotionRequestDir;
    if (prevReportPromotionAllowedRoot === undefined) delete process.env.REPORT_PROMOTION_ALLOWED_ROOT;
    else process.env.REPORT_PROMOTION_ALLOWED_ROOT = prevReportPromotionAllowedRoot;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
    await db.adapter.query(`DELETE FROM queries`);
  });

  it('marks the matching queries row as completed on success and stores the result', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();

    // Sanity: pre-closeout the queries row is pending (reproduces the bug
    // shape exactly as Chris observed on 2026-06-13).
    const before = await db.queries.getByQueryIdForTeam(defaultTeamId, query_id);
    expect(before).not.toBeNull();
    expect(before!.status).toBe('pending');
    expect(before!.completed).toBeNull();

    const result = {
      artifact_path: '/abs/path/to/output.md',
      task: 'kapelle-architecture-review',
    };

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: dispatch_phid,
        query_id,
        success: true,
        result,
      }),
    });
    expect(res.status).toBe(200);
    const legacyBody = await res.json() as any;
    expect(legacyBody.receipt).not.toHaveProperty('report_candidate');

    const after = await db.queries.getByQueryIdForTeam(defaultTeamId, query_id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('completed');
    expect(after!.completed).not.toBeNull();
    expect(after!.result).not.toBeNull();
    expect(after!.result!.artifact_path).toBe('/abs/path/to/output.md');
    expect(after!.result!.task).toBe('kapelle-architecture-review');
  });

  it('registers an agent-done artifact with stable detail/copy/download URLs and cached body metadata', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();
    const artifactPath = path.join(workDir, 'output', 'cash-flow-addendum.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# Cash-Flow Preview Correction Addendum\n\nCOBRA and BOXX detail.\n');
    const artifactId = artifactIdFromPath(artifactPath);

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: dispatch_phid,
        query_id,
        success: true,
        agent: 'finances',
        result: {
          artifact_path: artifactPath,
          title: 'Cash-Flow Preview Correction Addendum - COBRA + BOXX LT Lots',
          project: 'finances',
          source_host: 'M4',
        },
      }),
    });
    expect(res.status).toBe(200);

    const catalog = await getArtifact(db.adapter, artifactId);
    expect(catalog).toMatchObject({
      artifact_id: artifactId,
      agent: 'finances',
      project_ref: 'finances',
      dispatch_ref: dispatch_phid,
      source_host: 'M4',
      media_type: 'text/markdown',
      availability: 'present',
      abs_path: artifactPath,
    });
    expect(catalog?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog?.source_mtime).toBeTruthy();

    fs.unlinkSync(artifactPath);
    const cached = await getArtifactBodyCache(db.adapter, artifactId);
    expect(cached).toMatchObject({
      artifact_id: artifactId,
      media_type: 'text/markdown',
      body_truncated: 0,
      body_error: null,
    });
    expect(cached?.body_text).toContain('COBRA and BOXX detail');
  });

  it('marks the matching queries row as failed on success=false with the error string', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: dispatch_phid,
        query_id,
        success: false,
        failure_kind: 'agent_error',
        error: 'agent crashed mid-run',
      }),
    });
    expect(res.status).toBe(200);

    const after = await db.queries.getByQueryIdForTeam(defaultTeamId, query_id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('failed');
    expect(after!.completed).not.toBeNull();
    expect(after!.error).toBe('agent crashed mid-run');
  });

  it('succeeds when no queries row exists (best-effort; back-write must not block dispatch closeout)', async () => {
    // Enqueue ONLY the dispatch (no parallel queries row inserted).
    // Reproduces the historical state where the manager dispatched but
    // forgot to create the queries row — the dispatch closeout must still
    // succeed even though the back-write has nothing to write.
    const enq = await enqueueDispatch();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        result: { artifact_path: '/abs/no-row.md' },
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe('done');
  });

  it('repro: CTO + Maestra 2026-06-13 dispatch IDs — both queries should be completed after /agent-done', async () => {
    // Models the exact bug Chris observed on 2026-06-13:
    //   CTO   dispatch query_1781370010051_n1hjeqq stays pending despite done
    //   Maestra dispatch query_1781370010083_9v4sj6q stays pending despite done
    //
    // The fix is the same back-write for both. This test runs them in
    // sequence and verifies both queries rows transition.
    const ctoEnq = await enqueueDispatch();
    await db.queries.create(defaultTeamId, ctoEnq.query_id, coderAgentId, 'CTO prompt', Date.now());

    const maestraEnq = await enqueueDispatch();
    await db.queries.create(defaultTeamId, maestraEnq.query_id, coderAgentId, 'Maestra prompt', Date.now());

    // Both pending before closeout.
    expect((await db.queries.getByQueryIdForTeam(defaultTeamId, ctoEnq.query_id))!.status).toBe('pending');
    expect((await db.queries.getByQueryIdForTeam(defaultTeamId, maestraEnq.query_id))!.status).toBe('pending');

    // Close CTO first.
    const ctoRes = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: ctoEnq.dispatch_phid,
        query_id: ctoEnq.query_id,
        success: true,
        result: { artifact_path: '/cto/output/2026-06-13-kapelle-code-review.md' },
      }),
    });
    expect(ctoRes.status).toBe(200);

    // Close Maestra second.
    const maestraRes = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: maestraEnq.dispatch_phid,
        query_id: maestraEnq.query_id,
        success: true,
        result: { artifact_path: '/agent-platform/output/2026-06-13-kapelle-positioning.md' },
      }),
    });
    expect(maestraRes.status).toBe(200);

    // Both should now be completed with their respective artifacts.
    const ctoAfter = await db.queries.getByQueryIdForTeam(defaultTeamId, ctoEnq.query_id);
    const maestraAfter = await db.queries.getByQueryIdForTeam(defaultTeamId, maestraEnq.query_id);

    expect(ctoAfter!.status).toBe('completed');
    expect(ctoAfter!.result!.artifact_path).toBe('/cto/output/2026-06-13-kapelle-code-review.md');

    expect(maestraAfter!.status).toBe('completed');
    expect(maestraAfter!.result!.artifact_path).toBe('/agent-platform/output/2026-06-13-kapelle-positioning.md');
  });

  it('records a byte-bound report request and returns an idempotent receipt without a private path', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();
    const artifactPath = path.join(fs.realpathSync.native(workDir), 'output', 'cleveland-park-decision.md');
    const artifactBody = '# Cleveland Park decision\n\nVerified report body stays in the artifact.\n';
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, artifactBody);
    const payload = {
      dispatch_id: dispatch_phid,
      query_id,
      success: true,
      result: { artifact_path: artifactPath, title: 'Cleveland Park decision' },
      report_candidate: {
        schema_version: 'report-candidate.v1',
        project_ref: 'project:cleveland-park',
        attention: { request: 'DECIDE', reason_code: 'operator_decision', reason: 'Choose the bounded path.' },
      },
    };

    const first = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.receipt.report_candidate).toMatchObject({
      schema_version: 'report-candidate-receipt.v1',
      status: 'recorded',
      report_ref: `report:dispatch:${dispatch_phid}`,
      error: null,
    });
    expect(firstBody.receipt.report_candidate).not.toHaveProperty('request_path');
    const requestPath = path.join(reportPromotionRequestDir, `${firstBody.receipt.report_candidate.candidate_id}.json`);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    expect(request).toMatchObject({
      schemaVersion: 'report-promotion-request.v2',
      contentPath: artifactPath,
      title: 'Cleveland Park decision',
      reportRef: `report:dispatch:${dispatch_phid}`,
      expectedContentHash: crypto.createHash('sha256').update(artifactBody).digest('hex'),
      expectedByteSize: Buffer.byteLength(artifactBody),
      projectRef: 'project:cleveland-park',
      producer: { kind: 'SERVICE', id: 'agent-manager', label: 'Agent Manager' },
    });
    expect(JSON.stringify(request)).not.toContain('Verified report body stays in the artifact.');

    const retry = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      receipt: { report_candidate: { status: 'already_recorded', error: null } },
    });
  });

  it('rejects malformed or conflicting artifact claims before terminal completion', async () => {
    const malformedDispatch = await setupDispatchWithQueryRow();
    const artifactPath = path.join(fs.realpathSync.native(workDir), 'output', 'malformed-candidate.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# Candidate\n');
    const malformed = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: malformedDispatch.dispatch_phid,
        query_id: malformedDispatch.query_id,
        success: true,
        artifact_path: artifactPath,
        report_candidate: {
          schema_version: 'report-candidate.v1',
          attention: { request: 'NONE', reason: 'must not be inferred' },
        },
      }),
    });
    expect(malformed.status).toBe(400);
    expect((await (manager as any).dispatchScheduler.reactor.getByPhid(malformedDispatch.dispatch_phid)).status).not.toBe('done');

    const conflictDispatch = await setupDispatchWithQueryRow();
    const conflicting = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: conflictDispatch.dispatch_phid,
        query_id: conflictDispatch.query_id,
        success: true,
        artifact_path: artifactPath,
        result: { artifact_path: path.join(path.dirname(artifactPath), 'different.md') },
        report_candidate: { schema_version: 'report-candidate.v1', attention: { request: 'NONE' } },
      }),
    });
    expect(conflicting.status).toBe(400);
    expect(await conflicting.json()).toMatchObject({ error: 'AGENT_DONE_ARTIFACT_PATH_CONFLICT' });
    expect((await (manager as any).dispatchScheduler.reactor.getByPhid(conflictDispatch.dispatch_phid)).status).not.toBe('done');
  });

  it('rejects missing candidate content and fails closed when artifact admission is unconfigured', async () => {
    const missingDispatch = await setupDispatchWithQueryRow();
    const missingPath = path.join(fs.realpathSync.native(workDir), 'output', 'missing.md');
    const missing = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: missingDispatch.dispatch_phid,
        query_id: missingDispatch.query_id,
        success: true,
        result: { artifact_path: missingPath },
        report_candidate: { schema_version: 'report-candidate.v1', attention: { request: 'NONE' } },
      }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'REPORT_CANDIDATE_ARTIFACT_INVALID' });

    const unconfiguredDispatch = await setupDispatchWithQueryRow();
    const artifactPath = path.join(fs.realpathSync.native(workDir), 'output', 'unconfigured-root.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# Candidate\n');
    const configuredRoot = process.env.REPORT_PROMOTION_ALLOWED_ROOT;
    delete process.env.REPORT_PROMOTION_ALLOWED_ROOT;
    try {
      const response = await fetch(`${baseUrl}/agent-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
        body: JSON.stringify({
          dispatch_id: unconfiguredDispatch.dispatch_phid,
          query_id: unconfiguredDispatch.query_id,
          success: true,
          artifact_path: artifactPath,
          report_candidate: { schema_version: 'report-candidate.v1', attention: { request: 'NONE' } },
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'REPORT_CANDIDATE_ALLOWED_ROOT_NOT_CONFIGURED' });
    } finally {
      if (configuredRoot === undefined) delete process.env.REPORT_PROMOTION_ALLOWED_ROOT;
      else process.env.REPORT_PROMOTION_ALLOWED_ROOT = configuredRoot;
    }
    expect((await (manager as any).dispatchScheduler.reactor.getByPhid(unconfiguredDispatch.dispatch_phid)).status).not.toBe('done');
  });

  it('keeps an unconfigured handoff as a durable outbox entry and recovers it later', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();
    const artifactPath = path.join(fs.realpathSync.native(workDir), 'output', 'unconfigured-handoff.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# Durable candidate\n');
    const configuredDirectory = process.env.REPORT_PROMOTION_REQUEST_DIR;
    delete process.env.REPORT_PROMOTION_REQUEST_DIR;
    try {
      const response = await fetch(`${baseUrl}/agent-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
        body: JSON.stringify({
          dispatch_id: dispatch_phid,
          query_id,
          success: true,
          artifact_path: artifactPath,
          report_candidate: { schema_version: 'report-candidate.v1', attention: { request: 'NONE' } },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: 'done',
        receipt: { report_candidate: { status: 'not_configured' } },
      });
    } finally {
      if (configuredDirectory === undefined) delete process.env.REPORT_PROMOTION_REQUEST_DIR;
      else process.env.REPORT_PROMOTION_REQUEST_DIR = configuredDirectory;
    }
    expect(await flushPendingReportCandidateOutbox(db.adapter, reportPromotionRequestDir)).toEqual({
      attempted: 1,
      exported: 1,
      failed: 0,
    });
    const outbox = await db.adapter.query<{ report_candidate_export_status: string }>(
      `SELECT report_candidate_export_status FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [dispatch_phid],
    );
    expect(outbox.rows[0].report_candidate_export_status).toMatch(/recorded|already_recorded/);
  });

  it('quarantines a malformed outbox row without starving a later valid row', async () => {
    const configuredDirectory = process.env.REPORT_PROMOTION_REQUEST_DIR;
    delete process.env.REPORT_PROMOTION_REQUEST_DIR;
    const dispatches: Array<{ dispatch_phid: string; query_id: string }> = [];
    try {
      for (const suffix of ['corrupt', 'healthy']) {
        const dispatch = await setupDispatchWithQueryRow();
        dispatches.push(dispatch);
        const artifactPath = path.join(fs.realpathSync.native(workDir), 'output', `outbox-${suffix}.md`);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, `# Outbox ${suffix}\n`);
        const response = await fetch(`${baseUrl}/agent-done`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
          body: JSON.stringify({
            dispatch_id: dispatch.dispatch_phid,
            query_id: dispatch.query_id,
            success: true,
            artifact_path: artifactPath,
            report_candidate: { schema_version: 'report-candidate.v1', attention: { request: 'NONE' } },
          }),
        });
        expect(response.status).toBe(200);
      }
    } finally {
      if (configuredDirectory === undefined) delete process.env.REPORT_PROMOTION_REQUEST_DIR;
      else process.env.REPORT_PROMOTION_REQUEST_DIR = configuredDirectory;
    }
    await db.adapter.query(
      `UPDATE dispatch_scheduler_queue SET report_candidate_request_json = ? WHERE dispatch_phid = ?`,
      [JSON.stringify({ schemaVersion: 'report-promotion-request.v2' }), dispatches[0].dispatch_phid],
    );
    expect(await flushPendingReportCandidateOutbox(db.adapter, reportPromotionRequestDir)).toEqual({
      attempted: 2,
      exported: 1,
      failed: 1,
    });
    const rows = await db.adapter.query<{ dispatch_phid: string; report_candidate_export_status: string }>(
      `SELECT dispatch_phid, report_candidate_export_status FROM dispatch_scheduler_queue`,
    );
    expect(rows.rows.find((row) => row.dispatch_phid === dispatches[0].dispatch_phid)?.report_candidate_export_status).toBe('quarantined');
    expect(rows.rows.find((row) => row.dispatch_phid === dispatches[1].dispatch_phid)?.report_candidate_export_status).toMatch(/recorded|already_recorded/);
  });

  it('preserves one terminal winner across simultaneous candidate-success and failure closeouts', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();
    const artifactPath = path.join(fs.realpathSync.native(workDir), 'output', 'success-failure-race.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# Success/failure race\n');
    const headers = { 'Content-Type': 'application/json', 'X-Id-Team': TEAM };
    const [successResponse, failureResponse] = await Promise.all([
      fetch(`${baseUrl}/agent-done`, {
        method: 'POST', headers,
        body: JSON.stringify({
          dispatch_id: dispatch_phid,
          query_id,
          success: true,
          artifact_path: artifactPath,
          report_candidate: { schema_version: 'report-candidate.v1', attention: { request: 'NONE' } },
        }),
      }),
      fetch(`${baseUrl}/agent-done`, {
        method: 'POST', headers,
        body: JSON.stringify({
          dispatch_id: dispatch_phid,
          query_id,
          success: false,
          failure_kind: 'agent_error',
          error: 'simultaneous failure',
        }),
      }),
    ]);
    expect([successResponse.status, failureResponse.status].sort()).toEqual([200, 409]);
    const stored = await db.adapter.query<{
      status: string;
      result_json: string | null;
      report_candidate_request_json: string | null;
      failure_detail: string | null;
    }>(
      `SELECT status, result_json, report_candidate_request_json, failure_detail
         FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [dispatch_phid],
    );
    if (stored.rows[0].status === 'done') {
      expect(stored.rows[0].report_candidate_request_json).toContain('report-promotion-request.v2');
      expect(stored.rows[0].failure_detail).toBeNull();
    } else {
      expect(stored.rows[0]).toMatchObject({
        status: 'failed',
        result_json: null,
        report_candidate_request_json: null,
        failure_detail: 'simultaneous failure',
      });
    }
  });
});
