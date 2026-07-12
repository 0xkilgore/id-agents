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
    process.env.DISPATCH_SCHEDULER_ENABLED = 'false';

    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-done-queries-backwrite-test-'));
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

  it('registers an HTML agent-done artifact and serves it by stable id after the source file disappears', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();
    const artifactPath = path.join(workDir, 'output', 'portfolio-preview.html');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '<!doctype html><html><body><h1>Finance Preview</h1></body></html>');
    const artifactId = artifactIdFromPath(artifactPath);

    const doneRes = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: dispatch_phid,
        query_id,
        success: true,
        agent: 'finances',
        result: {
          artifact_path: artifactPath,
          title: 'Finance HTML Preview',
          project_ref: 'finances',
        },
      }),
    });
    expect(doneRes.status).toBe(200);
    const doneBody = await doneRes.json() as any;
    expect(doneBody.receipt.artifact_registration).toMatchObject({
      artifact_id: artifactId,
      source_path: artifactPath,
      freshness: 'current',
      cached_body: true,
      body_unavailable: false,
      stable_url: `/artifacts/${encodeURIComponent(artifactId)}/detail`,
      copy_text_url: `/artifacts/${encodeURIComponent(artifactId)}/copy-text`,
      download_url: `/artifacts/${encodeURIComponent(artifactId)}/download`,
    });

    const catalog = await getArtifact(db.adapter, artifactId);
    expect(catalog).toMatchObject({
      artifact_id: artifactId,
      agent: 'finances',
      project_ref: 'finances',
      dispatch_ref: dispatch_phid,
      media_type: 'text/html',
      availability: 'present',
      abs_path: artifactPath,
    });
    expect(catalog?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog?.source_mtime).toBeTruthy();

    fs.unlinkSync(artifactPath);

    const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/detail`, {
      headers: { 'X-Id-Team': 'default' },
    });
    if (detailRes.status !== 200) {
      throw new Error(`detail route failed: ${detailRes.status} ${await detailRes.text()}`);
    }
    const detail = await detailRes.json() as any;
    expect(detail.body).toMatchObject({
      kind: 'html',
      source: 'artifact_body_cache',
    });
    expect(detail.body.text).toContain('<h1>Finance Preview</h1>');
    expect(detail.delivery).toMatchObject({
      bodyRenderable: true,
      bodyUnavailable: false,
      freshness: 'current',
    });

    const copyRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/copy-text`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(copyRes.status).toBe(200);
    expect(await copyRes.text()).toContain('<h1>Finance Preview</h1>');

    const downloadRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toContain('text/html');
    expect(await downloadRes.text()).toContain('<h1>Finance Preview</h1>');
  });

  it('returns explicit body_unavailable registration metadata when an artifact body cannot be reached', async () => {
    const { dispatch_phid, query_id } = await setupDispatchWithQueryRow();
    const artifactPath = path.join(workDir, 'output', 'missing-finance-report.html');
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
          title: 'Missing Finance Report',
          project: 'finances',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.receipt.artifact_registration).toMatchObject({
      artifact_id: artifactId,
      source_path: artifactPath,
      freshness: 'body_unavailable',
      cached_body: false,
      body_unavailable: true,
      body_error: 'ENOENT',
    });

    const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/detail`, {
      headers: { 'X-Id-Team': 'default' },
    });
    if (detailRes.status !== 200) {
      throw new Error(`detail route failed: ${detailRes.status} ${await detailRes.text()}`);
    }
    const detail = await detailRes.json() as any;
    expect(detail.delivery).toMatchObject({
      bodyRenderable: false,
      bodyUnavailable: true,
      freshness: 'body_unavailable',
    });
    expect(detail.body).toMatchObject({
      kind: 'missing',
      text: null,
    });
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
});
