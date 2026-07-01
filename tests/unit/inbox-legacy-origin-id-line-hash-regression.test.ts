// T-QA — regression: inbox legacy_origin_id backfill is line-hash stable (locks 1de95f9).
//
// Pins the id-agents inbox.md projection contract from commit 1de95f9:
// legacy rows are keyed by a stable sha256 line hash (inbox_phid = inbox-md-<hash>),
// legacy_origin_id is the full source line (never line-<n>), and re-importing inbox.md
// is idempotent even when line numbers shift above an unchanged row.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateInboxTables, getInboxItem, countInboxItems } from '../../src/inbox/storage.js';
import { parseInboxMdLine, projectInboxMd } from '../../src/inbox/projection.js';

const ITEM_LINE =
  '- [ ] [2026-05-27 10:00] [email] #task — Backfill idempotency probe';

function mdPhid(line: string): string {
  return `inbox-md-${parseInboxMdLine(line)!.lineHash}`;
}

describe('inbox legacy_origin_id line-hash regression (locks 1de95f9)', () => {
  let adapter: SqliteAdapter;
  let tmpDir: string;
  let mdPath: string;

  beforeEach(() => {
    adapter = new SqliteAdapter(':memory:');
    migrateInboxTables(adapter);
    tmpDir = mkdtempSync(join(tmpdir(), 'inbox-line-hash-regression-'));
    mdPath = join(tmpDir, 'inbox.md');
  });

  it('keys inbox_phid on the stable line hash, not a positional line-<n> id', async () => {
    writeFileSync(mdPath, `# Inbox\n${ITEM_LINE}\n`);

    await projectInboxMd(adapter, mdPath);

    const item = await getInboxItem(adapter, mdPhid(ITEM_LINE));
    expect(item).not.toBeNull();
    expect(item!.inbox_phid).toBe(mdPhid(ITEM_LINE));
    expect(item!.inbox_phid).toMatch(/^inbox-md-[0-9a-f]{16}$/);
    expect(item!.inbox_phid).not.toMatch(/line-\d+/);
  });

  it('stores legacy_origin_id as the full inbox.md line (origin_ref null), never line-<n>', async () => {
    writeFileSync(mdPath, `# Inbox\n${ITEM_LINE}\n`);

    await projectInboxMd(adapter, mdPath);

    const item = (await getInboxItem(adapter, mdPhid(ITEM_LINE)))!;
    expect(item.origin_ref).toBeNull();
    expect(item.legacy_inbox_md_line).toBe(ITEM_LINE);
    expect(item.legacy_inbox_md_line).not.toMatch(/^line-\d+$/);

    const servedLegacyOriginId = item.origin_ref ?? item.legacy_inbox_md_line;
    expect(servedLegacyOriginId).toBe(ITEM_LINE);
  });

  it('re-importing inbox.md is idempotent (no duplicate rows on re-run)', async () => {
    writeFileSync(mdPath, `# Inbox\n${ITEM_LINE}\n`);

    await projectInboxMd(adapter, mdPath);
    await projectInboxMd(adapter, mdPath);

    expect(await countInboxItems(adapter)).toBe(1);
  });

  it('keeps the same phid when unrelated lines are inserted above the row', async () => {
    writeFileSync(mdPath, `# Inbox\n${ITEM_LINE}\n`);
    await projectInboxMd(adapter, mdPath);
    const phidBefore = mdPhid(ITEM_LINE);

    writeFileSync(
      mdPath,
      `# Inbox
## Processed 2026-06-28
- [x] [2026-06-28 08:00] #note — unrelated header row
${ITEM_LINE}
`,
    );
    await projectInboxMd(adapter, mdPath);

    expect(await countInboxItems(adapter)).toBe(2);
    const item = await getInboxItem(adapter, phidBefore);
    expect(item).not.toBeNull();
    expect(item!.legacy_inbox_md_line).toBe(ITEM_LINE);
    expect(item!.inbox_phid).toBe(phidBefore);
  });
});
