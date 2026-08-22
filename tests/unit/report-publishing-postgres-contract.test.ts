import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DbAdapter, QueryResult } from '../../src/db/db-adapter.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { DispatchDocClient } from '../../src/dispatch-scheduler/dispatch-doc-client.js';
import { SqliteDispatchReactor } from '../../src/dispatch-scheduler/sqlite-dispatch-reactor.js';
import { flushPendingReportCandidateOutbox } from '../../src/report-publishing/outbox.js';

class RecordingPostgresAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const;
  readonly statements: string[] = [];

  async query<T = unknown>(sql: string): Promise<QueryResult<T>> {
    this.statements.push(sql);
    return { rows: [], rowCount: 0 };
  }

  async close(): Promise<void> {}
}

describe('report candidate PostgreSQL contract', () => {
  it('migrates every column referenced by adapter-neutral terminal closeouts', async () => {
    const adapter = new RecordingPostgresAdapter();
    await migratePostgres(adapter);
    const migrationSql = adapter.statements.join('\n');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS report_candidate_request_json text');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS report_candidate_export_status text');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS report_candidate_export_attempted_at text');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS report_candidate_export_error text');
  });

  it('runs legacy and candidate terminal closeouts plus the outbox through a postgres-dialect adapter', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'report-publishing-postgres-parity-')));
    const sqlite = new SqliteAdapter(join(root, 'parity.db'));
    try {
      await migrateSqlite(sqlite);
      await sqlite.query(`INSERT INTO teams (id, name) VALUES ('team-pg-parity', 'pg parity')`);
      const postgresAdapter: DbAdapter = {
        dialect: 'postgres',
        query: (sql, params) => sqlite.query(sql, params),
        close: async () => {},
      };
      const reactor = new SqliteDispatchReactor({
        adapter: postgresAdapter,
        teamId: 'team-pg-parity',
        now: () => '2026-08-21T20:00:00.000Z',
      });
      const client = new DispatchDocClient({ reactor, now: () => '2026-08-21T20:00:00.000Z' });
      const input = {
        to_agent: 'coder',
        from_actor: 'manager',
        channel: 'dispatch',
        subject: 'postgres parity',
        body_markdown: 'body',
        provider: 'anthropic' as const,
        runtime: 'claude-code-cli' as const,
        priority: 5,
      };

      const legacy = await client.enqueueDispatch({ ...input, query_id: 'pg-legacy' });
      if (!legacy.ok) throw new Error('legacy enqueue failed');
      await client.claimForStart({ limit: 1 });
      await reactor.markDoneWithResult(legacy.value.dispatch_phid, { reply: 'legacy' }, null);

      const candidate = await client.enqueueDispatch({ ...input, query_id: 'pg-candidate' });
      if (!candidate.ok) throw new Error('candidate enqueue failed');
      await client.claimForStart({ limit: 1 });
      const request = {
        schemaVersion: 'report-promotion-request.v2',
        contentPath: '/srv/id-agents/output/postgres-parity.md',
        title: 'PostgreSQL parity',
        reportRef: `report:dispatch:${candidate.value.dispatch_phid}`,
        sourceRef: `kapelle-dispatch://${encodeURIComponent(candidate.value.dispatch_phid)}`,
        expectedContentHash: 'a'.repeat(64),
        expectedByteSize: 24,
        producer: { kind: 'SERVICE', id: 'agent-manager', label: 'Agent Manager' },
        attention: { request: 'NONE' },
        occurredAt: '2026-08-21T20:00:00.000Z',
      };
      await reactor.markDoneWithResult(candidate.value.dispatch_phid, { reply: 'candidate' }, JSON.stringify(request));
      const flushed = await flushPendingReportCandidateOutbox(postgresAdapter, join(root, 'requests'));
      expect(flushed).toEqual({ attempted: 1, exported: 1, failed: 0 });
      const stored = await postgresAdapter.query<{
        dispatch_phid: string;
        status: string;
        report_candidate_request_json: string | null;
        report_candidate_export_status: string | null;
      }>(
        `SELECT dispatch_phid, status, report_candidate_request_json, report_candidate_export_status
           FROM dispatch_scheduler_queue ORDER BY query_id`,
      );
      expect(stored.rows.find((row) => row.dispatch_phid === legacy.value.dispatch_phid)).toMatchObject({
        status: 'done',
        report_candidate_request_json: null,
        report_candidate_export_status: null,
      });
      expect(stored.rows.find((row) => row.dispatch_phid === candidate.value.dispatch_phid)).toMatchObject({
        status: 'done',
        report_candidate_request_json: JSON.stringify(request),
        report_candidate_export_status: 'recorded',
      });
      const candidateId = createHash('sha256').update(request.sourceRef).digest('hex').slice(0, 24);
      expect(JSON.parse(readFileSync(join(root, 'requests', `${candidateId}.json`), 'utf8'))).toEqual(request);
    } finally {
      await sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
