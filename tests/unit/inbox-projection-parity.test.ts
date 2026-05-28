// Inbox 2.0 — tests for projection adapter and parity report.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateInboxTables, getInboxItem, getLinks, countInboxItems } from '../../src/inbox/storage.js';
import { projectShadowJson, projectInboxMd, parseInboxMdLine, checkParity, runFullProjection } from '../../src/inbox/projection.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateInboxTables(adapter);
  return adapter;
}

describe('Inbox 2.0 — parseInboxMdLine', () => {
  it('parses a checked task line', () => {
    const result = parseInboxMdLine('- [x] [2026-04-06 07:10] [telegram] #task — Cleveland Park email → done 2026-04-06');
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(true);
    expect(result!.date).toBe('2026-04-06 07:10');
    expect(result!.channel).toBe('telegram');
    expect(result!.tag).toBe('task');
    expect(result!.text).toBe('Cleveland Park email');
    expect(result!.resolution).toBe('done 2026-04-06');
  });

  it('parses an unchecked line without channel', () => {
    const result = parseInboxMdLine('- [ ] [2026-05-27] #note — Test note');
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(false);
    expect(result!.channel).toBeNull();
    expect(result!.tag).toBe('note');
  });

  it('parses email with resolution', () => {
    const result = parseInboxMdLine('- [x] [2026-04-01 15:11] [email] #expense_receipt — Amazon orders for March → dispatched to finance agent for categorization report');
    expect(result).not.toBeNull();
    expect(result!.channel).toBe('email');
    expect(result!.tag).toBe('expense_receipt');
    expect(result!.resolution).toBe('dispatched to finance agent for categorization report');
  });

  it('returns null for non-item lines', () => {
    expect(parseInboxMdLine('# Inbox')).toBeNull();
    expect(parseInboxMdLine('## Processed 2026-03-26')).toBeNull();
    expect(parseInboxMdLine('')).toBeNull();
  });

  it('produces stable line hashes', () => {
    const line = '- [x] [2026-04-06 07:10] [telegram] #task — test';
    const r1 = parseInboxMdLine(line)!;
    const r2 = parseInboxMdLine(line)!;
    expect(r1.lineHash).toBe(r2.lineHash);
  });
});

describe('Inbox 2.0 — projectShadowJson', () => {
  let adapter: SqliteAdapter;
  let shadowDir: string;

  beforeEach(() => {
    adapter = makeAdapter();
    shadowDir = mkdtempSync(join(tmpdir(), 'inbox-shadow-'));
  });

  it('projects shadow JSON files into read tables', async () => {
    const doc = {
      documentType: 'kilgore/inbox-item',
      id: 'shadow-test-001',
      shadow: true,
      state: {
        global: {
          origin_kind: 'email',
          origin_ref: 'cane:abc123',
          received_at: '2026-05-20T16:06:22.015Z',
          received_by: 'cane',
          lifecycle_state: 'received',
          classification: 'unknown',
          classification_reason: null,
          source_subject: 'Test subject',
          source_from: 'sender@test.com',
          source_text: 'Test text content',
          source_excerpt: 'Test text content',
          source_attachments: [],
          project_hint: null,
          priority_hint: null,
          triaged_at: null,
          triaged_by: null,
          claimed_at: null,
          claimed_by: null,
          assigned_agent: null,
          dispatch_id: null,
          query_id: null,
          started_at: null,
          done_at: null,
          artifact_path: null,
          artifact_tl_dr: null,
          shadow_refs: { inbox_md: '~/Dropbox/Code/cane/taskview/inbox.md' },
          external_refs: {},
          last_error_code: null,
          last_error_message: null,
          last_error_at: null,
        },
      },
      operations: { global: [] },
    };

    writeFileSync(join(shadowDir, 'test.json'), JSON.stringify(doc));

    const result = await projectShadowJson(adapter, shadowDir);
    expect(result.projected).toBe(1);
    expect(result.errors.length).toBe(0);

    const item = await getInboxItem(adapter, 'shadow-test-001');
    expect(item).not.toBeNull();
    expect(item!.source_kind).toBe('email');
    expect(item!.operator_state).toBe('new');
    expect(item!.source_text).toBe('Test text content');
  });

  it('is idempotent on re-run', async () => {
    const doc = {
      documentType: 'kilgore/inbox-item',
      id: 'shadow-idem-001',
      state: {
        global: {
          origin_kind: 'telegram',
          origin_ref: 'tg:chat-1:msg-2',
          received_at: '2026-05-20T10:00:00.000Z',
          received_by: 'cane',
          lifecycle_state: 'received',
          classification: 'unknown',
          classification_reason: null,
          source_subject: null,
          source_from: null,
          source_text: 'Test',
          source_excerpt: 'Test',
          source_attachments: [],
          project_hint: null,
          priority_hint: null,
          triaged_at: null,
          triaged_by: null,
          claimed_at: null,
          claimed_by: null,
          assigned_agent: null,
          dispatch_id: null,
          query_id: null,
          started_at: null,
          done_at: null,
          artifact_path: null,
          artifact_tl_dr: null,
          shadow_refs: {},
          external_refs: {},
          last_error_code: null,
          last_error_message: null,
          last_error_at: null,
        },
      },
    };

    writeFileSync(join(shadowDir, 'idem.json'), JSON.stringify(doc));

    await projectShadowJson(adapter, shadowDir);
    await projectShadowJson(adapter, shadowDir); // re-run
    const count = await countInboxItems(adapter);
    expect(count).toBe(1);
  });

  it('maps dispatch-linked shadow correctly', async () => {
    const doc = {
      documentType: 'kilgore/inbox-item',
      id: 'shadow-dispatch-001',
      state: {
        global: {
          origin_kind: 'email',
          origin_ref: 'cane:dispatch1',
          received_at: '2026-05-20T10:00:00.000Z',
          received_by: 'cane',
          lifecycle_state: 'received',
          classification: 'unknown',
          classification_reason: null,
          source_subject: null,
          source_from: null,
          source_text: 'Dispatch test',
          source_excerpt: 'Dispatch test',
          source_attachments: [],
          project_hint: null,
          priority_hint: null,
          triaged_at: null,
          triaged_by: null,
          claimed_at: null,
          claimed_by: null,
          assigned_agent: 'finances',
          dispatch_id: 'disp-123',
          query_id: 'query-456',
          started_at: '2026-05-20T11:00:00.000Z',
          done_at: null,
          artifact_path: null,
          artifact_tl_dr: null,
          shadow_refs: {},
          external_refs: {},
          last_error_code: null,
          last_error_message: null,
          last_error_at: null,
        },
      },
    };

    writeFileSync(join(shadowDir, 'dispatch.json'), JSON.stringify(doc));
    await projectShadowJson(adapter, shadowDir);

    const item = (await getInboxItem(adapter, 'shadow-dispatch-001'))!;
    expect(item.operator_state).toBe('waiting_on_agent');
    expect(item.agent_hint).toBe('finances');

    const links = await getLinks(adapter, 'shadow-dispatch-001');
    expect(links.some(l => l.kind === 'dispatch' && l.target === 'disp-123')).toBe(true);
    expect(links.some(l => l.kind === 'dispatch' && l.target === 'query-456')).toBe(true);
  });

  it('handles non-existent directory gracefully', async () => {
    const result = await projectShadowJson(adapter, '/nonexistent/path');
    expect(result.projected).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe('Inbox 2.0 — projectInboxMd', () => {
  let adapter: SqliteAdapter;
  let tmpDir: string;

  beforeEach(() => {
    adapter = makeAdapter();
    tmpDir = mkdtempSync(join(tmpdir(), 'inbox-md-'));
  });

  it('projects inbox.md lines into read tables', async () => {
    const content = `# Inbox
## Processed 2026-03-26
- [x] [2026-03-24 12:59] #note — test (dupes cleared)
- [x] [2026-03-24 13:14] #task — Brainstorm yard work → added to personal to-do
- [ ] [2026-05-27 10:00] [email] #actionable — New item to review
`;
    const mdPath = join(tmpDir, 'inbox.md');
    writeFileSync(mdPath, content);

    const result = await projectInboxMd(adapter, mdPath);
    expect(result.projected).toBe(3);
    expect(result.errors.length).toBe(0);

    // Check that items were created
    const total = await countInboxItems(adapter);
    expect(total).toBe(3);

    // The unchecked item should be 'new'
    const { rows: items } = await adapter.query<{ operator_state: string }>(
      "SELECT * FROM inbox_items WHERE operator_state = 'new'",
      [],
    );
    expect(items.length).toBe(1);
  });

  it('extracts dispatch links from resolution text', async () => {
    const content = `# Inbox
- [x] [2026-04-01 15:11] [email] #expense_receipt — Amazon orders → dispatched to finance agent
`;
    const mdPath = join(tmpDir, 'inbox.md');
    writeFileSync(mdPath, content);

    await projectInboxMd(adapter, mdPath);

    // Find the projected item
    const { rows: items } = await adapter.query<{ inbox_phid: string }>(
      'SELECT inbox_phid FROM inbox_items',
      [],
    );
    expect(items.length).toBe(1);

    const links = await getLinks(adapter, items[0].inbox_phid);
    expect(links.some(l => l.kind === 'dispatch' && l.target === 'finance')).toBe(true);
  });

  it('handles non-existent file gracefully', async () => {
    const result = await projectInboxMd(adapter, '/nonexistent/inbox.md');
    expect(result.projected).toBe(0);
  });
});

describe('Inbox 2.0 — Parity', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('AT11: parity report documents included, excluded, conflicted items', async () => {
    // Seed some items from different sources
    const tmpDir = mkdtempSync(join(tmpdir(), 'inbox-parity-'));
    const shadowDir = join(tmpDir, 'shadow');
    mkdirSync(shadowDir);

    const doc = {
      documentType: 'kilgore/inbox-item',
      id: 'shadow-parity-001',
      state: {
        global: {
          origin_kind: 'email', origin_ref: 'cane:p1', received_at: '2026-05-27T12:00:00.000Z',
          received_by: 'cane', lifecycle_state: 'received', classification: 'unknown',
          classification_reason: null, source_subject: null, source_from: null,
          source_text: 'Test', source_excerpt: 'Test', source_attachments: [],
          project_hint: null, priority_hint: null, triaged_at: null, triaged_by: null,
          claimed_at: null, claimed_by: null, assigned_agent: null, dispatch_id: null,
          query_id: null, started_at: null, done_at: null, artifact_path: null,
          artifact_tl_dr: null, shadow_refs: {}, external_refs: {},
          last_error_code: null, last_error_message: null, last_error_at: null,
        },
      },
    };
    writeFileSync(join(shadowDir, 'p1.json'), JSON.stringify(doc));

    const mdContent = '- [x] [2026-05-27 10:00] [email] #task — Parity test item → done\n';
    const mdPath = join(tmpDir, 'inbox.md');
    writeFileSync(mdPath, mdContent);

    await runFullProjection(adapter, shadowDir, mdPath);
    const report = await checkParity(adapter);

    expect(report.shadow_count).toBe(1);
    expect(report.inbox_md_count).toBe(1);
    expect(report.shadow_only.length).toBe(1);
    expect(report.inbox_md_only.length).toBe(1);
  });
});
