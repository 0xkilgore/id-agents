// PT5 (2026-06-24) — Inbox bulk triage: route / archive / mark-acted over many
// items at once. The three bulk actions fold onto the existing inbox state
// machine: route -> a primary routing decision; archive -> operator_state
// 'filed'; mark_acted -> operator_state 'checked_off'. Pure validate + summarize
// are unit-tested directly; the DB applier is tested against an in-memory adapter
// seeded with the standard fixtures (same harness as inbox-storage-ops).

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateInboxTables, upsertInboxItem, getInboxItem, getAuditEvents, getRoutingDecisions } from '../../src/inbox/storage.js';
import { FIXTURES } from '../../src/inbox/fixtures.js';
import {
  BULK_INBOX_ACTIONS,
  validateBulkInboxRequest,
  summarizeBulk,
  applyBulkInboxAction,
  type BulkInboxRequest,
  type BulkItemResult,
} from '../../src/inbox/bulk.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateInboxTables(adapter);
  return adapter;
}

async function seed(adapter: SqliteAdapter): Promise<void> {
  for (const row of FIXTURES) await upsertInboxItem(adapter, row);
}

const base: Omit<BulkInboxRequest, 'action' | 'phids'> = { actor_id: 'human:chris', ts: '2026-06-24T12:00:00.000Z' };

describe('PT5 — validateBulkInboxRequest (pure)', () => {
  it('accepts a well-formed route request', () => {
    expect(validateBulkInboxRequest({ ...base, action: 'route', phids: ['a'], action_type: 'dispatch', action_target: 'finance' })).toEqual([]);
  });

  it('accepts archive / mark_acted without route params', () => {
    expect(validateBulkInboxRequest({ ...base, action: 'archive', phids: ['a'] })).toEqual([]);
    expect(validateBulkInboxRequest({ ...base, action: 'mark_acted', phids: ['a'] })).toEqual([]);
  });

  it('rejects an unknown action', () => {
    const errs = validateBulkInboxRequest({ ...base, action: 'nuke' as never, phids: ['a'] });
    expect(errs.join()).toMatch(/action/);
  });

  it('rejects an empty phid list (incl. after dedupe/trim)', () => {
    expect(validateBulkInboxRequest({ ...base, action: 'archive', phids: [] }).join()).toMatch(/phids/);
    expect(validateBulkInboxRequest({ ...base, action: 'archive', phids: ['', '  '] }).join()).toMatch(/phids/);
  });

  it('rejects route without an action_type', () => {
    expect(validateBulkInboxRequest({ ...base, action: 'route', phids: ['a'] }).join()).toMatch(/action_type/);
  });

  it('exposes exactly the three supported actions', () => {
    expect(BULK_INBOX_ACTIONS).toEqual(['route', 'archive', 'mark_acted']);
  });
});

describe('PT5 — summarizeBulk (pure)', () => {
  it('counts applied / skipped / failed and total', () => {
    const results: BulkItemResult[] = [
      { inbox_phid: 'a', applied: true, state: 'filed' },
      { inbox_phid: 'b', applied: false, reason: 'already_archived' },
      { inbox_phid: 'c', applied: false, reason: 'not_found' },
    ];
    const s = summarizeBulk('archive', results);
    expect(s).toEqual({ action: 'archive', total: 3, applied: 1, skipped: 1, failed: 1 });
  });
});

describe('PT5 — applyBulkInboxAction (DB)', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = makeAdapter();
    await seed(adapter);
  });

  it('mark_acted moves items to checked_off and writes an audit event each', async () => {
    const r = await applyBulkInboxAction(adapter, { ...base, action: 'mark_acted', phids: ['fix-voice-03', 'fix-telegram-02'] });
    expect(r.summary).toMatchObject({ action: 'mark_acted', total: 2, applied: 2, skipped: 0, failed: 0 });
    expect((await getInboxItem(adapter, 'fix-voice-03'))!.operator_state).toBe('checked_off');
    expect((await getInboxItem(adapter, 'fix-telegram-02'))!.operator_state).toBe('checked_off');
    const events = await getAuditEvents(adapter, 'fix-voice-03');
    expect(events.some(e => e.op_type === 'MARK_ACTED')).toBe(true);
  });

  it('skips an item already in the target state (idempotent no-op)', async () => {
    // fix-duplicate-04 is already checked_off in the fixtures.
    const r = await applyBulkInboxAction(adapter, { ...base, action: 'mark_acted', phids: ['fix-duplicate-04'] });
    expect(r.summary).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
    expect(r.results[0].reason).toBe('already_acted');
  });

  it('archive moves items to filed; already-filed is skipped', async () => {
    const r = await applyBulkInboxAction(adapter, { ...base, action: 'archive', phids: ['fix-telegram-02', 'fix-email-01'] });
    expect(r.summary).toMatchObject({ applied: 1, skipped: 1 });
    expect((await getInboxItem(adapter, 'fix-telegram-02'))!.operator_state).toBe('filed');
    expect(r.results.find(x => x.inbox_phid === 'fix-email-01')!.reason).toBe('already_archived');
  });

  it('route records a primary routing decision per item', async () => {
    const r = await applyBulkInboxAction(adapter, {
      ...base, action: 'route', phids: ['fix-voice-03'],
      action_type: 'dispatch', action_target: 'finance', reason: 'bulk route',
    });
    expect(r.summary).toMatchObject({ applied: 1, failed: 0 });
    const decisions = await getRoutingDecisions(adapter, 'fix-voice-03');
    expect(decisions.some(d => d.action_type === 'dispatch' && d.action_target === 'finance')).toBe(true);
  });

  it('reports a missing item as failed (not_found), still processing the rest', async () => {
    const r = await applyBulkInboxAction(adapter, { ...base, action: 'archive', phids: ['fix-voice-03', 'nope-99'] });
    expect(r.summary).toMatchObject({ total: 2, applied: 1, failed: 1 });
    expect(r.results.find(x => x.inbox_phid === 'nope-99')!.reason).toBe('not_found');
  });

  it('dedupes repeated phids so each item is acted on once', async () => {
    const r = await applyBulkInboxAction(adapter, { ...base, action: 'mark_acted', phids: ['fix-voice-03', 'fix-voice-03', ' fix-voice-03 '] });
    expect(r.summary.total).toBe(1);
  });

  it('throws on an invalid request (empty phids)', async () => {
    await expect(applyBulkInboxAction(adapter, { ...base, action: 'archive', phids: [] })).rejects.toThrow(/phids/);
  });
});
