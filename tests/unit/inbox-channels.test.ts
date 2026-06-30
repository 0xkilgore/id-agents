// Inbox 2.0 — channel-aware read-model tests.
// Covers channel taxonomy/mapping, the needs-you exclusion policy
// (artifact-comment excluded per 2026-06-29), storage grouping, and the live
// GET /inbox/by-channel + drill-in routes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateInboxTables, upsertInboxItem, upsertLink,
  countInboxBySourceKind, listInboxItemsByChannel,
} from '../../src/inbox/storage.js';
import { mountInboxRoutes } from '../../src/inbox/routes.js';
import { FIXTURES, FIXTURE_LINKS } from '../../src/inbox/fixtures.js';
import {
  INBOX_CHANNELS, channelForSourceKind, sourceKindsForChannel, isInboxChannel,
  channelCountsTowardNeedsYou, groupChannelCounts, sumNeedsYouUnresolved,
  buildProvenance, type InboxByChannelResponse, type InboxChannelItemDetail,
} from '../../src/inbox/channels.js';
import type { InboxItemRow, SourceKind } from '../../src/inbox/types.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateInboxTables(adapter);
  return adapter;
}

function makeItem(phid: string, overrides: Partial<InboxItemRow>): InboxItemRow {
  const now = '2026-06-29T12:00:00.000Z';
  return {
    inbox_phid: phid,
    operator_state: 'new',
    source_kind: 'email',
    source_external_id: null,
    source_text: null,
    source_excerpt: null,
    source_subject: null,
    source_from: null,
    classification_label: null,
    classification_confidence: null,
    classification_classifier: null,
    classification_rationale: null,
    project_hint: null,
    agent_hint: null,
    origin_ref: null,
    received_at: now,
    triaged_at: null,
    resolved_at: null,
    snoozed_until: null,
    checked_off_at: null,
    checked_off_reason: null,
    source: 'index',
    parity_status: 'ok',
    generated_at: now,
    projection_version: 1,
    legacy_inbox_md_line: null,
    legacy_shadow_path: null,
    ...overrides,
  };
}

async function seedFixtures(adapter: SqliteAdapter): Promise<void> {
  for (const row of FIXTURES) await upsertInboxItem(adapter, row);
  for (const link of FIXTURE_LINKS) await upsertLink(adapter, link.inbox_phid, link.kind, link.target);
}

// An artifact-comment item that is "unresolved" — used to prove it surfaces as a
// channel but does NOT count toward the needs-you total (2026-06-29 policy).
const ARTIFACT_COMMENT_ITEM = makeItem('art-comment-01', {
  source_kind: 'artifact_comment',
  source_text: 'Follow-up comment on artifact X',
  operator_state: 'new',
  origin_ref: 'artifact:abc123',
});

describe('Inbox channels — taxonomy + policy (pure)', () => {
  it('maps every source kind to a channel', () => {
    expect(channelForSourceKind('email')).toBe('email');
    expect(channelForSourceKind('telegram')).toBe('telegram');
    expect(channelForSourceKind('voice_note')).toBe('voice');
    expect(channelForSourceKind('forwarded_instruction')).toBe('forward');
    expect(channelForSourceKind('artifact_comment')).toBe('artifact-comment');
    expect(channelForSourceKind('manual_capture')).toBe('other');
    expect(channelForSourceKind('api')).toBe('other');
  });

  it('exposes the five named channels plus an `other` catch-all', () => {
    expect(INBOX_CHANNELS).toEqual(['email', 'telegram', 'voice', 'artifact-comment', 'forward', 'other']);
  });

  it('sourceKindsForChannel is the inverse of channelForSourceKind', () => {
    for (const kind of ['email', 'telegram', 'voice_note', 'forwarded_instruction', 'artifact_comment', 'manual_capture', 'api'] as SourceKind[]) {
      expect(sourceKindsForChannel(channelForSourceKind(kind))).toContain(kind);
    }
    expect(sourceKindsForChannel('other').sort()).toEqual(['api', 'manual_capture']);
    expect(sourceKindsForChannel('voice')).toEqual(['voice_note']);
  });

  it('isInboxChannel validates membership', () => {
    expect(isInboxChannel('email')).toBe(true);
    expect(isInboxChannel('artifact-comment')).toBe(true);
    expect(isInboxChannel('bogus')).toBe(false);
  });

  it('artifact-comment is excluded from needs-you; all other channels count', () => {
    expect(channelCountsTowardNeedsYou('artifact-comment')).toBe(false);
    for (const channel of INBOX_CHANNELS) {
      if (channel === 'artifact-comment') continue;
      expect(channelCountsTowardNeedsYou(channel)).toBe(true);
    }
  });

  it('groupChannelCounts zero-fills every channel and folds source kinds', () => {
    const totals = groupChannelCounts([
      { source_kind: 'email', total: 3, unresolved: 2 },
      { source_kind: 'manual_capture', total: 1, unresolved: 1 },
      { source_kind: 'api', total: 2, unresolved: 0 },
      { source_kind: 'artifact_comment', total: 5, unresolved: 5 },
    ]);
    expect([...totals.keys()].sort()).toEqual([...INBOX_CHANNELS].sort());
    expect(totals.get('email')).toEqual({ total: 3, unresolved: 2 });
    expect(totals.get('other')).toEqual({ total: 3, unresolved: 1 }); // manual + api
    expect(totals.get('artifact-comment')).toEqual({ total: 5, unresolved: 5 });
    expect(totals.get('telegram')).toEqual({ total: 0, unresolved: 0 });
  });

  it('sumNeedsYouUnresolved excludes the artifact-comment channel', () => {
    const totals = groupChannelCounts([
      { source_kind: 'email', total: 3, unresolved: 2 },
      { source_kind: 'artifact_comment', total: 5, unresolved: 5 },
    ]);
    expect(sumNeedsYouUnresolved(totals)).toBe(2);
  });

  it('buildProvenance carries source + legacy refs + needs-you flag', () => {
    const prov = buildProvenance(ARTIFACT_COMMENT_ITEM);
    expect(prov.channel).toBe('artifact-comment');
    expect(prov.source_kind).toBe('artifact_comment');
    expect(prov.projection_source).toBe('index');
    expect(prov.origin_ref).toBe('artifact:abc123');
    expect(prov.counts_toward_needs_you).toBe(false);
  });
});

describe('Inbox channels — storage', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = makeAdapter();
    await seedFixtures(adapter);
    await upsertInboxItem(adapter, ARTIFACT_COMMENT_ITEM);
  });

  it('countInboxBySourceKind returns per-kind totals + unresolved', async () => {
    const counts = await countInboxBySourceKind(adapter);
    const byKind = new Map(counts.map((c) => [c.source_kind, c]));
    // Fixtures have 4 email items (01, 06, 07?, 09). Verify email present & sane.
    expect((byKind.get('email')?.total ?? 0)).toBeGreaterThan(0);
    expect(byKind.get('artifact_comment')).toEqual({ source_kind: 'artifact_comment', total: 1, unresolved: 1 });
  });

  it('countInboxBySourceKind honors a state filter', async () => {
    const counts = await countInboxBySourceKind(adapter, { state: 'new' });
    const total = counts.reduce((s, c) => s + c.total, 0);
    expect(total).toBeGreaterThan(0);
    expect(counts.every((c) => c.total === c.unresolved || c.unresolved <= c.total)).toBe(true);
  });

  it('listInboxItemsByChannel returns only that channel’s items', async () => {
    const emailItems = await listInboxItemsByChannel(adapter, 'email');
    expect(emailItems.length).toBeGreaterThan(0);
    expect(emailItems.every((i) => i.source_kind === 'email')).toBe(true);

    const artifactItems = await listInboxItemsByChannel(adapter, 'artifact-comment');
    expect(artifactItems.map((i) => i.inbox_phid)).toEqual(['art-comment-01']);

    const voiceItems = await listInboxItemsByChannel(adapter, 'voice');
    expect(voiceItems.every((i) => i.source_kind === 'voice_note')).toBe(true);
  });

  it('listInboxItemsByChannel respects the state filter', async () => {
    const newEmail = await listInboxItemsByChannel(adapter, 'email', { state: 'new' });
    expect(newEmail.every((i) => i.operator_state === 'new')).toBe(true);
  });
});

describe('Inbox channels — routes', () => {
  let adapter: SqliteAdapter;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    adapter = makeAdapter();
    await seedFixtures(adapter);
    await upsertInboxItem(adapter, ARTIFACT_COMMENT_ITEM);
    const app = express();
    app.use(express.json());
    mountInboxRoutes(app, adapter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await adapter.close();
  });

  it('GET /inbox/by-channel returns a stable channel-grouped payload', async () => {
    const res = await fetch(`${base}/inbox/by-channel`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxByChannelResponse;
    expect(body.schema_version).toBe('inbox.by_channel.v1');
    // Every channel present, stable order.
    expect(body.channels.map((c) => c.channel)).toEqual([...INBOX_CHANNELS]);
    const art = body.channels.find((c) => c.channel === 'artifact-comment')!;
    expect(art.total).toBe(1);
    expect(art.counts_toward_needs_you).toBe(false);
    expect(art.items.map((i) => i.inbox_phid)).toEqual(['art-comment-01']);
    // needs_you_unresolved excludes the unresolved artifact-comment item.
    const emailGroup = body.channels.find((c) => c.channel === 'email')!;
    expect(body.needs_you_unresolved).toBeGreaterThanOrEqual(emailGroup.unresolved);
    // The artifact-comment unresolved (1) must NOT be in needs_you_unresolved.
    const allUnresolved = body.channels.reduce((s, c) => s + c.unresolved, 0);
    expect(body.needs_you_unresolved).toBe(allUnresolved - art.unresolved);
  });

  it('GET /inbox/by-channel?channel=email returns only that channel', async () => {
    const res = await fetch(`${base}/inbox/by-channel?channel=email`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxByChannelResponse;
    expect(body.channels.map((c) => c.channel)).toEqual(['email']);
    expect(body.filters.channel).toBe('email');
  });

  it('GET /inbox/by-channel rejects an unknown channel', async () => {
    const res = await fetch(`${base}/inbox/by-channel?channel=bogus`);
    expect(res.status).toBe(400);
  });

  it('GET /inbox/by-channel/:channel/items/:phid drills in with provenance', async () => {
    const res = await fetch(`${base}/inbox/by-channel/artifact-comment/items/art-comment-01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxChannelItemDetail;
    expect(body.schema_version).toBe('inbox.channel_item.v1');
    expect(body.channel).toBe('artifact-comment');
    expect(body.item.inbox_phid).toBe('art-comment-01');
    expect(body.provenance.source_kind).toBe('artifact_comment');
    expect(body.provenance.counts_toward_needs_you).toBe(false);
    expect(Array.isArray(body.audit_events)).toBe(true);
  });

  it('drill-in returns links/decisions for a fixture item', async () => {
    const res = await fetch(`${base}/inbox/by-channel/email/items/fix-dispatch-06`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxChannelItemDetail;
    expect(body.channel).toBe('email');
    expect(body.links.some((l) => l.kind === 'dispatch')).toBe(true);
  });

  it('drill-in 404s an unknown phid', async () => {
    const res = await fetch(`${base}/inbox/by-channel/email/items/nope`);
    expect(res.status).toBe(404);
  });

  it('drill-in 409s on channel mismatch', async () => {
    // fix-telegram-02 is a telegram item; request it under the email channel.
    const res = await fetch(`${base}/inbox/by-channel/email/items/fix-telegram-02`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.expected_channel).toBe('telegram');
  });
});
