// Inbox 2.0 — tests for storage, ops, and evaluator.

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateInboxTables,
  upsertInboxItem, getInboxItem, listInboxItems, countInboxItems,
  countReceivedSince, getOldestUnresolved, getNewestReceived,
  upsertLink, getLinks,
  appendAuditEvent, getAuditEvents,
  appendPolicyViolation, getPolicyViolations, listAllPolicyViolations,
  appendRoutingDecision, getRoutingDecisions,
  updateOperatorState,
} from '../../src/inbox/storage.js';
import {
  applyClassifyInboxItem, applyProposeRoute,
  applySnooze, applyCheckOff, applyAuditNote,
} from '../../src/inbox/ops.js';
import { evaluateInboxRouting, DEFAULT_ROUTING_RULES } from '../../src/inbox/evaluator.js';
import { FIXTURES, FIXTURE_LINKS } from '../../src/inbox/fixtures.js';
import type { ClassifyInboxItemOp, InboxRoutingRule } from '../../src/inbox/types.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateInboxTables(adapter);
  return adapter;
}

async function seedFixtures(adapter: SqliteAdapter): Promise<void> {
  for (const row of FIXTURES) {
    await upsertInboxItem(adapter, row);
  }
  for (const link of FIXTURE_LINKS) {
    await upsertLink(adapter, link.inbox_phid, link.kind, link.target);
  }
}

describe('Inbox 2.0 — Storage', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('creates tables without error', async () => {
    const { rows: tables } = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'inbox_%'",
      [],
    );
    const names = tables.map(t => t.name).sort();
    expect(names).toEqual([
      'inbox_audit_events',
      'inbox_items',
      'inbox_links',
      'inbox_policy_violations',
      'inbox_routing_decisions',
    ]);
  });

  it('upserts and retrieves an inbox item', async () => {
    await upsertInboxItem(adapter, FIXTURES[0]);
    const item = await getInboxItem(adapter, FIXTURES[0].inbox_phid);
    expect(item).not.toBeNull();
    expect(item!.source_kind).toBe('email');
    expect(item!.operator_state).toBe('filed');
  });

  it('upsert is idempotent', async () => {
    await upsertInboxItem(adapter, FIXTURES[0]);
    await upsertInboxItem(adapter, FIXTURES[0]);
    const { rows } = await adapter.query<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM inbox_items WHERE inbox_phid = $1',
      [FIXTURES[0].inbox_phid],
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it('lists items with state filter', async () => {
    await seedFixtures(adapter);
    const newItems = await listInboxItems(adapter, { state: 'new' });
    expect(newItems.length).toBeGreaterThan(0);
    expect(newItems.every(i => i.operator_state === 'new')).toBe(true);
  });

  it('counts items by state', async () => {
    await seedFixtures(adapter);
    const newCount = await countInboxItems(adapter, 'new');
    expect(newCount).toBeGreaterThan(0);
    const erroredCount = await countInboxItems(adapter, 'errored');
    expect(erroredCount).toBe(1);
  });

  it('counts received since a date', async () => {
    await seedFixtures(adapter);
    const count = await countReceivedSince(adapter, '2026-05-27T00:00:00.000Z');
    expect(count).toBeGreaterThan(0);
  });

  it('gets oldest unresolved and newest received', async () => {
    await seedFixtures(adapter);
    const oldest = await getOldestUnresolved(adapter);
    expect(oldest).not.toBeNull();
    const newest = await getNewestReceived(adapter);
    expect(newest).not.toBeNull();
  });

  it('upserts and retrieves links', async () => {
    await seedFixtures(adapter);
    const links = await getLinks(adapter, 'fix-dispatch-06');
    expect(links.length).toBeGreaterThan(0);
    expect(links.some(l => l.kind === 'dispatch')).toBe(true);
  });

  it('appends and retrieves audit events', async () => {
    await upsertInboxItem(adapter, FIXTURES[0]);
    await appendAuditEvent(adapter, {
      inbox_phid: FIXTURES[0].inbox_phid,
      op_id: 'test-op-1', op_type: 'TEST', actor_id: 'test',
      ts: '2026-05-27T12:00:00.000Z', reason: null, summary: 'Test event',
      input_revision: null, links_json: null,
    });
    const events = await getAuditEvents(adapter, FIXTURES[0].inbox_phid);
    expect(events.length).toBe(1);
    expect(events[0].op_type).toBe('TEST');
  });

  it('appends and retrieves policy violations', async () => {
    await upsertInboxItem(adapter, FIXTURES[0]);
    await appendPolicyViolation(adapter, {
      inbox_phid: FIXTURES[0].inbox_phid,
      kind: 'test_violation', message: 'Test violation', severity: 'warning',
      detected_at: '2026-05-27T12:00:00.000Z', resolved_at: null, meta_json: null,
    });
    const violations = await getPolicyViolations(adapter, FIXTURES[0].inbox_phid);
    expect(violations.length).toBe(1);
    const all = await listAllPolicyViolations(adapter, true);
    expect(all.length).toBe(1);
  });

  it('appends routing decisions with primary flag management', async () => {
    await upsertInboxItem(adapter, FIXTURES[1]);
    await appendRoutingDecision(adapter, {
      inbox_phid: FIXTURES[1].inbox_phid, rule_id: 'rule-1', action_type: 'propose_project',
      action_target: 'cleveland-park', actor_id: 'system', reason: 'First route',
      input_revision: 'rev-1', is_primary: true, decided_at: '2026-05-27T12:00:00.000Z',
    });
    await appendRoutingDecision(adapter, {
      inbox_phid: FIXTURES[1].inbox_phid, rule_id: 'rule-2', action_type: 'propose_agent',
      action_target: 'roger', actor_id: 'system', reason: 'Second route',
      input_revision: 'rev-1', is_primary: true, decided_at: '2026-05-27T12:01:00.000Z',
    });
    const decisions = await getRoutingDecisions(adapter, FIXTURES[1].inbox_phid);
    expect(decisions.length).toBe(2);
    const primaries = decisions.filter(d => d.is_primary);
    expect(primaries.length).toBe(1);
  });

  it('updates operator state', async () => {
    await upsertInboxItem(adapter, FIXTURES[0]);
    await updateOperatorState(adapter, FIXTURES[0].inbox_phid, 'snoozed', { snoozed_until: '2026-06-01T00:00:00.000Z' });
    const item = (await getInboxItem(adapter, FIXTURES[0].inbox_phid))!;
    expect(item.operator_state).toBe('snoozed');
    expect(item.snoozed_until).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('Inbox 2.0 — Ops', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = makeAdapter();
    await seedFixtures(adapter);
  });

  it('AT1: classify appends history and is idempotent by key/input_revision', async () => {
    const op: ClassifyInboxItemOp = {
      type: 'CLASSIFY_INBOX_ITEM', inbox_phid: 'fix-voice-03',
      actor: { id: 'human:chris', kind: 'human' }, ts: '2026-05-27T13:00:00.000Z',
      label: 'idea', confidence: 0.9, classifier: 'human',
      rationale: 'Voice note about DeFi research', input_revision: 'rev-1',
      idempotency_key: 'classify-test-1',
    };
    const r1 = await applyClassifyInboxItem(adapter, op);
    expect(r1.applied).toBe(true);
    const item = (await getInboxItem(adapter, 'fix-voice-03'))!;
    expect(item.classification_label).toBe('idea');
    const r2 = await applyClassifyInboxItem(adapter, op);
    expect(r2.applied).toBe(false);
    expect(r2.reason).toBe('idempotent_duplicate');
    const events = await getAuditEvents(adapter, 'fix-voice-03');
    expect(events.filter(e => e.op_type === 'CLASSIFY_INBOX_ITEM').length).toBe(1);
  });

  it('classify advances state from new to needs_route', async () => {
    await applyClassifyInboxItem(adapter, {
      type: 'CLASSIFY_INBOX_ITEM', inbox_phid: 'fix-voice-03',
      actor: { id: 'human:chris', kind: 'human' }, ts: '2026-05-27T13:00:00.000Z',
      label: 'action', confidence: null, classifier: 'human',
      rationale: 'Needs action routing', input_revision: 'rev-2',
      idempotency_key: 'classify-test-2',
    });
    const item = (await getInboxItem(adapter, 'fix-voice-03'))!;
    expect(item.operator_state).toBe('needs_route');
  });

  it('classify rejects invalid label', async () => {
    await expect(applyClassifyInboxItem(adapter, {
      type: 'CLASSIFY_INBOX_ITEM', inbox_phid: 'fix-voice-03',
      actor: { id: 'human:chris', kind: 'human' }, ts: '2026-05-27T13:00:00.000Z',
      label: 'bogus' as any, confidence: null, classifier: 'human',
      rationale: 'test', input_revision: 'rev-3', idempotency_key: 'classify-test-3',
    })).rejects.toThrow('Invalid classification label');
  });

  it('classify requires rule_id for rule classifier', async () => {
    await expect(applyClassifyInboxItem(adapter, {
      type: 'CLASSIFY_INBOX_ITEM', inbox_phid: 'fix-voice-03',
      actor: { id: 'system:rule', kind: 'system' }, ts: '2026-05-27T13:00:00.000Z',
      label: 'reference', confidence: 0.95, classifier: 'rule',
      rationale: 'Newsletter auto-classify', input_revision: 'rev-4',
      idempotency_key: 'classify-test-4',
    })).rejects.toThrow('rule_id is required');
  });

  it('AT3: propose-route records primary decision with full audit fields', async () => {
    const result = await applyProposeRoute(adapter, {
      type: 'PROPOSE_ROUTE', inbox_phid: 'fix-telegram-02',
      actor: { id: 'human:chris', kind: 'human' }, ts: '2026-05-27T13:00:00.000Z',
      rule_id: null, action_type: 'propose_project', action_target: 'cleveland-park',
      reason: 'Belongs to CP project', input_revision: 'rev-1',
      is_primary: true, idempotency_key: 'route-test-1',
    });
    expect(result.applied).toBe(true);
    const decisions = await getRoutingDecisions(adapter, 'fix-telegram-02');
    expect(decisions.length).toBe(1);
    expect(decisions[0].is_primary).toBeTruthy();
  });

  it('AT4: conflicting route decisions generate policy violation', async () => {
    await applyProposeRoute(adapter, {
      type: 'PROPOSE_ROUTE', inbox_phid: 'fix-telegram-02',
      actor: { id: 'rule:a', kind: 'system' }, ts: '2026-05-27T13:00:00.000Z',
      rule_id: 'rule-a', action_type: 'propose_project', action_target: 'cp',
      reason: 'Project match', input_revision: 'rev-1',
      is_primary: true, idempotency_key: 'route-conflict-1',
    });
    await applyProposeRoute(adapter, {
      type: 'PROPOSE_ROUTE', inbox_phid: 'fix-telegram-02',
      actor: { id: 'rule:b', kind: 'system' }, ts: '2026-05-27T13:01:00.000Z',
      rule_id: 'rule-b', action_type: 'propose_agent', action_target: 'roger',
      reason: 'Agent match', input_revision: 'rev-1',
      is_primary: true, idempotency_key: 'route-conflict-2',
    });
    const violations = await getPolicyViolations(adapter, 'fix-telegram-02');
    expect(violations.filter(v => v.kind === 'conflicting_routes').length).toBeGreaterThan(0);
  });

  it('AT9: snooze updates state and appears in audit trail', async () => {
    await applySnooze(adapter, {
      type: 'SNOOZE', inbox_phid: 'fix-telegram-02', actor_id: 'human:chris',
      ts: '2026-05-27T14:00:00.000Z', until: '2026-06-01T08:00:00.000Z',
    });
    const item = (await getInboxItem(adapter, 'fix-telegram-02'))!;
    expect(item.operator_state).toBe('snoozed');
    const events = await getAuditEvents(adapter, 'fix-telegram-02');
    expect(events.some(e => e.op_type === 'SNOOZE')).toBe(true);
  });

  it('AT9: check-off requires reason', async () => {
    await expect(applyCheckOff(adapter, {
      type: 'CHECK_OFF', inbox_phid: 'fix-telegram-02', actor_id: 'human:chris',
      ts: '2026-05-27T14:00:00.000Z', reason: '',
    })).rejects.toThrow('reason');
  });

  it('AT9: check-off updates state and audit trail', async () => {
    await applyCheckOff(adapter, {
      type: 'CHECK_OFF', inbox_phid: 'fix-telegram-02', actor_id: 'human:chris',
      ts: '2026-05-27T14:00:00.000Z', reason: 'Done manually',
    });
    const item = (await getInboxItem(adapter, 'fix-telegram-02'))!;
    expect(item.operator_state).toBe('checked_off');
    const events = await getAuditEvents(adapter, 'fix-telegram-02');
    expect(events.some(e => e.op_type === 'CHECK_OFF')).toBe(true);
  });

  it('AT9: audit note appears in audit trail', async () => {
    await applyAuditNote(adapter, {
      type: 'AUDIT_NOTE', inbox_phid: 'fix-telegram-02', actor_id: 'human:chris',
      ts: '2026-05-27T14:00:00.000Z', note: 'Need to follow up on this',
    });
    const events = await getAuditEvents(adapter, 'fix-telegram-02');
    expect(events.some(e => e.op_type === 'AUDIT_NOTE' && e.summary === 'Need to follow up on this')).toBe(true);
  });

  it('audit note rejects empty text', async () => {
    await expect(applyAuditNote(adapter, {
      type: 'AUDIT_NOTE', inbox_phid: 'fix-telegram-02', actor_id: 'human:chris',
      ts: '2026-05-27T14:00:00.000Z', note: '  ',
    })).rejects.toThrow('requires text');
  });

  it('AT10: reroute proposal does not create Dispatch', async () => {
    await applyProposeRoute(adapter, {
      type: 'PROPOSE_ROUTE', inbox_phid: 'fix-telegram-02',
      actor: { id: 'human:chris', kind: 'human' }, ts: '2026-05-27T14:00:00.000Z',
      rule_id: null, action_type: 'propose_agent', action_target: 'finances',
      reason: 'Route to finances agent instead', input_revision: 'rev-reroute-1',
      is_primary: true, idempotency_key: 'reroute-test-1',
    });
    const decisions = await getRoutingDecisions(adapter, 'fix-telegram-02');
    expect(decisions.length).toBe(1);
    expect(decisions[0].action_type).toBe('propose_agent');
  });
});

describe('Inbox 2.0 — Evaluator', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = makeAdapter();
    await seedFixtures(adapter);
  });

  it('AT2: evaluateInboxRouting is deterministic by priority + rule_id', async () => {
    const item = (await getInboxItem(adapter, 'fix-telegram-02'))!;
    const rules: InboxRoutingRule[] = [
      { rule_id: 'z-later', enabled: true, priority: 10, match: { classification: ['action'] },
        action: { type: 'propose_project', project_id: 'personal' }, explanation: 'Default' },
      { rule_id: 'a-first', enabled: true, priority: 10, match: { classification: ['action'] },
        action: { type: 'requires_approval', reason: 'Needs review' }, explanation: 'Approval' },
    ];
    const d1 = evaluateInboxRouting(item, rules, new Date());
    const d2 = evaluateInboxRouting(item, rules, new Date());
    expect(d1).toEqual(d2);
    expect(d1.length).toBe(2);
    expect(d1[0].rule_id).toBe('a-first');
    expect(d1[0].is_primary).toBe(true);
    expect(d1[1].is_primary).toBe(false);
  });

  it('evaluator skips disabled rules', async () => {
    const item = (await getInboxItem(adapter, 'fix-telegram-02'))!;
    const decisions = evaluateInboxRouting(item, [
      { rule_id: 'off', enabled: false, priority: 1, match: { classification: ['action'] },
        action: { type: 'propose_project', project_id: 'x' }, explanation: 'Disabled' },
    ], new Date());
    expect(decisions.length).toBe(0);
  });

  it('default rules produce decisions for action-classified items', async () => {
    const item = (await getInboxItem(adapter, 'fix-telegram-02'))!;
    const decisions = evaluateInboxRouting(item, DEFAULT_ROUTING_RULES, new Date());
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].is_primary).toBe(true);
  });
});

describe('Inbox 2.0 — Fixtures', () => {
  it('AT5: fixtures cover all operator states', () => {
    const states = new Set(FIXTURES.map(f => f.operator_state));
    for (const s of ['new', 'needs_route', 'waiting_on_agent', 'output_ready', 'checked_off', 'filed', 'errored']) {
      expect(states.has(s as any)).toBe(true);
    }
  });
  it('fixtures cover required source types', () => {
    const sources = new Set(FIXTURES.map(f => f.source_kind));
    for (const s of ['email', 'telegram', 'voice_note', 'forwarded_instruction']) {
      expect(sources.has(s as any)).toBe(true);
    }
  });
});
