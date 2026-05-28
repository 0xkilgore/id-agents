// Inbox 2.0 — representative fixture set for testing.
// Covers: email, telegram/manual, voice, duplicate, filed reference,
// dispatch-linked, output-linked, errored, conflicted legacy.

import type { InboxItemRow, OperatorState, SourceKind, ParityStatus } from './types.js';

const now = '2026-05-27T12:00:00.000Z';

function fixture(
  phid: string,
  overrides: Partial<InboxItemRow>,
): InboxItemRow {
  return {
    inbox_phid: phid,
    operator_state: 'new' as OperatorState,
    source_kind: 'email' as SourceKind,
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
    parity_status: 'ok' as ParityStatus,
    generated_at: now,
    projection_version: 1,
    legacy_inbox_md_line: null,
    legacy_shadow_path: null,
    ...overrides,
  };
}

export const FIXTURES: InboxItemRow[] = [
  // 1. Email — newsletter, classified as reference
  fixture('fix-email-01', {
    source_kind: 'email',
    source_external_id: 'gmail:msg-001',
    source_subject: 'DealBook: Crypto in your 401(k)?',
    source_from: 'Andrew Ross Sorkin',
    source_text: 'DealBook: Crypto in your 401(k)?',
    source_excerpt: 'DealBook: Crypto in your 401(k)?',
    classification_label: 'reference',
    classification_confidence: 0.95,
    classification_classifier: 'rule',
    classification_rationale: 'Newsletter — no action required',
    operator_state: 'filed',
    resolved_at: '2026-05-27T08:00:00.000Z',
    legacy_inbox_md_line: '- [x] [2026-04-11 12:01] [email] #newsletter — DealBook: Crypto in your 401(k)?',
  }),

  // 2. Telegram/manual — task, needs route
  fixture('fix-telegram-02', {
    source_kind: 'telegram',
    source_external_id: 'tg:chat-123:msg-456',
    source_text: 'Add to do on Cleveland Park to set up parents whatsapp',
    source_excerpt: 'Add to do on Cleveland Park to set up parents whatsapp',
    classification_label: 'action',
    classification_confidence: 0.88,
    classification_classifier: 'llm',
    classification_rationale: 'Explicit task: set up parents whatsapp in Cleveland Park project',
    operator_state: 'needs_route',
    project_hint: 'cleveland-park',
    triaged_at: '2026-05-27T09:00:00.000Z',
  }),

  // 3. Voice note — idea, new
  fixture('fix-voice-03', {
    source_kind: 'voice_note',
    source_text: 'Research note for defi: Sky/MakerDAO preemptive DSR rate hikes during low-rate 22-23',
    source_excerpt: 'Sky/MakerDAO preemptive DSR rate hikes...',
    operator_state: 'new',
  }),

  // 4. Duplicate — terminal
  fixture('fix-duplicate-04', {
    source_kind: 'telegram',
    source_text: 'Nous Research pipeline + ideas → processed above',
    classification_label: 'duplicate',
    classification_classifier: 'human',
    classification_rationale: 'Duplicate of telegram item processed above',
    operator_state: 'checked_off',
    checked_off_at: '2026-05-27T10:00:00.000Z',
    checked_off_reason: 'Duplicate',
    resolved_at: '2026-05-27T10:00:00.000Z',
  }),

  // 5. Filed reference — forwarded instruction
  fixture('fix-filed-05', {
    source_kind: 'forwarded_instruction',
    source_subject: 'Fwd: 2025 Income Tax Return',
    source_from: 'Chris Powers',
    source_text: 'Fwd: 2025 Income Tax Return from Chris Powers',
    classification_label: 'reference',
    classification_classifier: 'human',
    classification_rationale: 'Tax return filed in personal/tax',
    operator_state: 'filed',
    resolved_at: '2026-05-27T10:30:00.000Z',
  }),

  // 6. Dispatch-linked — waiting on agent
  fixture('fix-dispatch-06', {
    source_kind: 'email',
    source_text: 'March Amazon transactions → dispatched to finance agent',
    source_subject: 'March Amazon transactions',
    classification_label: 'dispatch',
    classification_classifier: 'human',
    classification_rationale: 'Dispatched to finance agent for categorization report',
    operator_state: 'waiting_on_agent',
    agent_hint: 'finances',
  }),

  // 7. Output-linked — output ready
  fixture('fix-output-07', {
    source_kind: 'telegram',
    source_text: 'TN SB2237 → dispatched to politics agent for research',
    classification_label: 'action',
    classification_classifier: 'human',
    classification_rationale: 'Dispatched research completed, output ready',
    operator_state: 'output_ready',
    agent_hint: 'politics',
  }),

  // 8. Errored — voice transcription failure
  fixture('fix-errored-08', {
    source_kind: 'voice_note',
    source_text: 'voice transcription error',
    source_excerpt: 'voice transcription error',
    operator_state: 'errored',
  }),

  // 9. Conflicted legacy — drift between index and shadow
  fixture('fix-conflicted-09', {
    source_kind: 'email',
    source_text: 'Zoning variance hearing - 1107 N 5th St',
    source_subject: 'Zoning variance hearing',
    parity_status: 'drift',
    operator_state: 'needs_route',
    classification_label: 'action',
    classification_classifier: 'human',
    classification_rationale: 'Zoning hearing requires review',
    legacy_inbox_md_line: '- [x] [2026-04-14 21:15] [email] #actionable — Zoning variance hearing',
    legacy_shadow_path: null,
  }),
];

export const FIXTURE_LINKS = [
  { inbox_phid: 'fix-dispatch-06', kind: 'dispatch' as const, target: 'query_finances_amazon_march' },
  { inbox_phid: 'fix-output-07', kind: 'artifact' as const, target: 'politics/research/2026-05-11-tn-sb2237.md' },
  { inbox_phid: 'fix-output-07', kind: 'dispatch' as const, target: 'query_1778553711293_gzwugoa' },
  { inbox_phid: 'fix-filed-05', kind: 'filed' as const, target: 'personal/tax/2025/' },
  { inbox_phid: 'fix-duplicate-04', kind: 'legacy' as const, target: 'inbox.md:line-43' },
];
