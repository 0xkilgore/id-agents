// Inbox 2.0 — channel-aware read-model.
//
// A bounded read layer over inbox_items that groups/filters items by CHANNEL
// (email / telegram / voice / artifact-comment / forward) with a per-channel
// drill-in (detail + provenance). The channel is derived from source_kind so
// this composes on top of the existing projection with no schema change.
//
// Policy (2026-06-29): artifact-comment items are surfaced as their own channel
// but do NOT count toward the "Chris needs-you" operator surface — artifact
// comments are classified/routed/threaded, not promoted into needs-you
// decisions. The needs-you exclusion is encoded here as the canonical source of
// truth so any composing surface (Desk needs-me, CTO inbox spec) reads the same
// policy from the read-model rather than re-deriving it.

import type {
  InboxItemRow, SourceKind, OperatorState, ProjectionSource, ParityStatus,
  InboxLinkRow, InboxAuditEvent, InboxPolicyViolation, InboxRoutingDecision,
} from './types.js';

// ── Channel taxonomy ──────────────────────────────────────────────────

export const INBOX_CHANNELS = [
  'email',
  'telegram',
  'voice',
  'artifact-comment',
  'forward',
  'other',
] as const;

export type InboxChannel = (typeof INBOX_CHANNELS)[number];

// Source kinds map 1:1 (or many:1 for `other`) onto a channel.
const SOURCE_KIND_TO_CHANNEL: Record<SourceKind, InboxChannel> = {
  email: 'email',
  telegram: 'telegram',
  voice_note: 'voice',
  forwarded_instruction: 'forward',
  artifact_comment: 'artifact-comment',
  manual_capture: 'other',
  api: 'other',
};

// Channels that count toward the operator "Chris needs-you" surface.
// artifact-comment is excluded per the 2026-06-29 policy.
export const CHANNEL_COUNTS_TOWARD_NEEDS_YOU: Record<InboxChannel, boolean> = {
  email: true,
  telegram: true,
  voice: true,
  'artifact-comment': false,
  forward: true,
  other: true,
};

// Operator states treated as "unresolved" for channel counts. Matches the
// /inbox/summary `unresolved` definition (new + needs_route + waiting_on_agent).
export const UNRESOLVED_OPERATOR_STATES: readonly OperatorState[] = [
  'new',
  'needs_route',
  'waiting_on_agent',
];

export function channelForSourceKind(kind: SourceKind): InboxChannel {
  return SOURCE_KIND_TO_CHANNEL[kind] ?? 'other';
}

export function channelForItem(item: Pick<InboxItemRow, 'source_kind'>): InboxChannel {
  return channelForSourceKind(item.source_kind);
}

export function sourceKindsForChannel(channel: InboxChannel): SourceKind[] {
  return (Object.keys(SOURCE_KIND_TO_CHANNEL) as SourceKind[]).filter(
    (k) => SOURCE_KIND_TO_CHANNEL[k] === channel,
  );
}

export function isInboxChannel(value: string): value is InboxChannel {
  return (INBOX_CHANNELS as readonly string[]).includes(value);
}

export function channelCountsTowardNeedsYou(channel: InboxChannel): boolean {
  return CHANNEL_COUNTS_TOWARD_NEEDS_YOU[channel];
}

// ── Provenance ────────────────────────────────────────────────────────

export interface InboxItemProvenance {
  channel: InboxChannel;
  source_kind: SourceKind;
  // 'index' | 'reactor' — which projection path produced the row.
  projection_source: ProjectionSource;
  parity_status: ParityStatus;
  source_external_id: string | null;
  origin_ref: string | null;
  legacy_inbox_md_line: string | null;
  legacy_shadow_path: string | null;
  received_at: string;
  generated_at: string;
  projection_version: number;
  counts_toward_needs_you: boolean;
}

export function buildProvenance(item: InboxItemRow): InboxItemProvenance {
  const channel = channelForItem(item);
  return {
    channel,
    source_kind: item.source_kind,
    projection_source: item.source,
    parity_status: item.parity_status,
    source_external_id: item.source_external_id,
    origin_ref: item.origin_ref,
    legacy_inbox_md_line: item.legacy_inbox_md_line,
    legacy_shadow_path: item.legacy_shadow_path,
    received_at: item.received_at,
    generated_at: item.generated_at,
    projection_version: item.projection_version,
    counts_toward_needs_you: channelCountsTowardNeedsYou(channel),
  };
}

// ── API response shapes ───────────────────────────────────────────────

export interface InboxChannelGroup {
  channel: InboxChannel;
  counts_toward_needs_you: boolean;
  total: number;
  unresolved: number;
  // Bounded slice of items for this channel (most-recent first).
  items: InboxItemRow[];
}

export interface InboxByChannelResponse {
  schema_version: 'inbox.by_channel.v1';
  generated_at: string;
  filters: {
    channel: InboxChannel | null;
    state: OperatorState | null;
    limit: number;
    offset: number;
  };
  // Sum of `total` across every channel returned.
  total: number;
  // Sum of `unresolved` across channels that count toward needs-you
  // (i.e. excludes artifact-comment per the 2026-06-29 policy).
  needs_you_unresolved: number;
  channels: InboxChannelGroup[];
}

export interface InboxChannelItemDetail {
  schema_version: 'inbox.channel_item.v1';
  channel: InboxChannel;
  item: InboxItemRow;
  links: InboxLinkRow[];
  audit_events: InboxAuditEvent[];
  policy_violations: InboxPolicyViolation[];
  routing_decisions: InboxRoutingDecision[];
  provenance: InboxItemProvenance;
}

// ── Grouping (pure) ───────────────────────────────────────────────────

export interface ChannelCount {
  source_kind: SourceKind;
  total: number;
  unresolved: number;
}

export interface ChannelTotals {
  total: number;
  unresolved: number;
}

// Fold per-source-kind counts into a stable channel map. Every channel in
// INBOX_CHANNELS is present (zero-filled) so the response shape is stable
// regardless of which source kinds currently have rows.
export function groupChannelCounts(rows: ChannelCount[]): Map<InboxChannel, ChannelTotals> {
  const map = new Map<InboxChannel, ChannelTotals>();
  for (const channel of INBOX_CHANNELS) {
    map.set(channel, { total: 0, unresolved: 0 });
  }
  for (const row of rows) {
    const channel = channelForSourceKind(row.source_kind);
    const acc = map.get(channel)!;
    acc.total += Number(row.total) || 0;
    acc.unresolved += Number(row.unresolved) || 0;
  }
  return map;
}

// Sum of unresolved across channels that count toward the needs-you surface.
export function sumNeedsYouUnresolved(totals: Map<InboxChannel, ChannelTotals>): number {
  let sum = 0;
  for (const [channel, t] of totals) {
    if (channelCountsTowardNeedsYou(channel)) sum += t.unresolved;
  }
  return sum;
}
