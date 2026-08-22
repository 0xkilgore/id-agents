import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgAdapter } from '../../src/db/pg-adapter.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { DispatchDocClient } from '../../src/dispatch-scheduler/dispatch-doc-client.js';
import { SqliteDispatchReactor } from '../../src/dispatch-scheduler/sqlite-dispatch-reactor.js';
import { flushPendingReportCandidateOutbox } from '../../src/report-publishing/outbox.js';

const connectionString = process.env.TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('report publishing on a live PostgreSQL database', () => {
  let pool: Pool;
  let adapter: PgAdapter;
  let root: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    adapter = new PgAdapter(pool);
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'report-publishing-postgres-live-')));
    await migratePostgres(adapter);
  });

  afterAll(async () => {
    await adapter?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('creates a fresh scheduler, claims work, commits a candidate, and flushes its outbox', async () => {
    const teamId = randomUUID();
    await adapter.query(`INSERT INTO teams (id, name) VALUES (?, ?)`, [teamId, `pg-live-${teamId}`]);
    const now = '2026-08-21T23:00:00.000Z';
    const reactor = new SqliteDispatchReactor({ adapter, teamId, now: () => now });
    const client = new DispatchDocClient({ reactor, now: () => now });
    const enqueued = await client.enqueueDispatch({
      query_id: `pg-live-${randomUUID()}`,
      to_agent: 'coder',
      from_actor: 'manager',
      channel: 'dispatch',
      subject: 'live PostgreSQL candidate',
      body_markdown: 'body',
      provider: 'anthropic',
      runtime: 'claude-code-cli',
      priority: 5,
    });
    if (!enqueued.ok) throw new Error(enqueued.detail);
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error(claimed.detail);
    expect(claimed.value.map((row) => row.dispatch_phid)).toContain(enqueued.value.dispatch_phid);

    const request = {
      schemaVersion: 'report-promotion-request.v2',
      contentPath: '/srv/id-agents/output/postgres-live.md',
      title: 'PostgreSQL live',
      reportRef: `report:dispatch:${enqueued.value.dispatch_phid}`,
      sourceRef: `kapelle-dispatch://${encodeURIComponent(enqueued.value.dispatch_phid)}`,
      expectedContentHash: 'a'.repeat(64),
      expectedByteSize: 24,
      producer: { kind: 'SERVICE', id: 'agent-manager', label: 'Agent Manager' },
      attention: { request: 'NONE' },
      occurredAt: now,
    };
    const done = await reactor.markDoneWithResult(
      enqueued.value.dispatch_phid,
      { reply: 'candidate' },
      JSON.stringify(request),
    );
    expect(done?.status).toBe('done');

    const flushed = await flushPendingReportCandidateOutbox(adapter, join(root, 'requests'));
    expect(flushed).toEqual({ attempted: 1, exported: 1, failed: 0 });
    const candidateId = createHash('sha256').update(request.sourceRef).digest('hex').slice(0, 24);
    expect(JSON.parse(readFileSync(join(root, 'requests', `${candidateId}.json`), 'utf8'))).toEqual(request);
  });
});
