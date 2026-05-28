// Inbox 2.0 — typed operations (CLASSIFY_INBOX_ITEM, PROPOSE_ROUTE, snooze, check-off, audit note).

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db/db-adapter.js';
import type {
  ClassifyInboxItemOp, ProposeRouteOp,
  SnoozeOp, CheckOffOp, AuditNoteOp,
  ClassificationLabel,
} from './types.js';
import {
  getInboxItem, updateOperatorState,
  appendAuditEvent, appendRoutingDecision,
  appendPolicyViolation,
} from './storage.js';

// ── Validation helpers ──

const VALID_LABELS: ClassificationLabel[] = [
  'action', 'reference', 'idea', 'crm_ref', 'dispatch',
  'approval_needed', 'duplicate', 'discard',
];

async function requireItem(adapter: DbAdapter, phid: string) {
  const item = await getInboxItem(adapter, phid);
  if (!item) throw new Error(`Item not found: ${phid}`);
  return item;
}

// ── CLASSIFY_INBOX_ITEM ──

export async function applyClassifyInboxItem(adapter: DbAdapter, op: ClassifyInboxItemOp): Promise<{ applied: boolean; reason?: string }> {
  await requireItem(adapter, op.inbox_phid);

  if (!VALID_LABELS.includes(op.label)) {
    throw new Error(`Invalid classification label: ${op.label}`);
  }

  if (op.confidence != null && (op.confidence < 0 || op.confidence > 1)) {
    throw new Error('confidence must be in [0, 1]');
  }

  if (op.classifier === 'rule' && !op.rule_id) {
    throw new Error('rule_id is required when classifier is "rule"');
  }

  if (['llm', 'human', 'rule'].includes(op.classifier) && !op.rationale?.trim()) {
    throw new Error('rationale is required for llm/human/rule classifiers');
  }

  // Idempotency check
  const { rows: existing } = await adapter.query(
    "SELECT id FROM inbox_audit_events WHERE inbox_phid = $1 AND op_type = 'CLASSIFY_INBOX_ITEM' AND input_revision = $2 AND op_id = $3",
    [op.inbox_phid, op.input_revision, op.idempotency_key],
  );

  if (existing.length > 0) {
    return { applied: false, reason: 'idempotent_duplicate' };
  }

  await adapter.query(
    `UPDATE inbox_items SET
      classification_label = $1,
      classification_confidence = $2,
      classification_classifier = $3,
      classification_rationale = $4,
      project_hint = COALESCE($5, project_hint),
      agent_hint = COALESCE($6, agent_hint),
      triaged_at = COALESCE(triaged_at, $7)
    WHERE inbox_phid = $8`,
    [
      op.label, op.confidence, op.classifier, op.rationale,
      op.projected_project, op.projected_agent, op.ts,
      op.inbox_phid,
    ],
  );

  const item = (await getInboxItem(adapter, op.inbox_phid))!;
  if (item.operator_state === 'new') {
    await updateOperatorState(adapter, op.inbox_phid, 'needs_route');
  }

  await appendAuditEvent(adapter, {
    inbox_phid: op.inbox_phid,
    op_id: op.idempotency_key,
    op_type: 'CLASSIFY_INBOX_ITEM',
    actor_id: op.actor.id,
    ts: op.ts,
    reason: op.rationale,
    summary: `Classified as "${op.label}" by ${op.classifier} (confidence: ${op.confidence ?? 'n/a'})`,
    input_revision: op.input_revision,
    links_json: null,
  });

  return { applied: true };
}

// ── PROPOSE_ROUTE ──

export async function applyProposeRoute(adapter: DbAdapter, op: ProposeRouteOp): Promise<{ applied: boolean; reason?: string }> {
  await requireItem(adapter, op.inbox_phid);

  const { rows: existing } = await adapter.query(
    "SELECT id FROM inbox_routing_decisions WHERE inbox_phid = $1 AND actor_id = $2 AND input_revision = $3 AND reason = $4",
    [op.inbox_phid, op.actor.id, op.input_revision, op.reason],
  );

  if (existing.length > 0) {
    return { applied: false, reason: 'idempotent_duplicate' };
  }

  // Check for existing primary before appending (appendRoutingDecision clears old primaries)
  let priorPrimary: { action_type: string; action_target: string | null } | null = null;
  if (op.is_primary) {
    const { rows: priorPrimaries } = await adapter.query<{ action_type: string; action_target: string | null }>(
      'SELECT action_type, action_target FROM inbox_routing_decisions WHERE inbox_phid = $1 AND is_primary = 1',
      [op.inbox_phid],
    );
    if (priorPrimaries.length > 0) {
      priorPrimary = priorPrimaries[0];
    }
  }

  await appendRoutingDecision(adapter, {
    inbox_phid: op.inbox_phid,
    rule_id: op.rule_id,
    action_type: op.action_type,
    action_target: op.action_target,
    actor_id: op.actor.id,
    reason: op.reason,
    input_revision: op.input_revision,
    is_primary: op.is_primary,
    decided_at: op.ts,
  });

  // If we displaced a different primary route, flag a policy violation
  if (priorPrimary && (priorPrimary.action_type !== op.action_type || priorPrimary.action_target !== op.action_target)) {
    await appendPolicyViolation(adapter, {
      inbox_phid: op.inbox_phid,
      kind: 'conflicting_routes',
      message: `Conflicting primary routes: ${priorPrimary.action_type}→${priorPrimary.action_target ?? '(none)'} displaced by ${op.action_type}→${op.action_target ?? '(none)'}`,
      severity: 'warning',
      detected_at: op.ts,
      resolved_at: null,
      meta_json: JSON.stringify({ prior: priorPrimary, current: { action_type: op.action_type, action_target: op.action_target } }),
    });
  }

  await appendAuditEvent(adapter, {
    inbox_phid: op.inbox_phid,
    op_id: op.idempotency_key,
    op_type: 'PROPOSE_ROUTE',
    actor_id: op.actor.id,
    ts: op.ts,
    reason: op.reason,
    summary: `Route proposed: ${op.action_type} → ${op.action_target ?? '(none)'} (primary: ${op.is_primary})`,
    input_revision: op.input_revision,
    links_json: null,
  });

  return { applied: true };
}

// ── Snooze ──

export async function applySnooze(adapter: DbAdapter, op: SnoozeOp): Promise<void> {
  await requireItem(adapter, op.inbox_phid);

  await updateOperatorState(adapter, op.inbox_phid, 'snoozed', {
    snoozed_until: op.until,
  });

  await appendAuditEvent(adapter, {
    inbox_phid: op.inbox_phid,
    op_id: `snooze-${randomUUID().slice(0, 8)}`,
    op_type: 'SNOOZE',
    actor_id: op.actor_id,
    ts: op.ts,
    reason: op.reason ?? null,
    summary: `Snoozed until ${op.until}`,
    input_revision: null,
    links_json: null,
  });
}

// ── Check off ──

export async function applyCheckOff(adapter: DbAdapter, op: CheckOffOp): Promise<void> {
  await requireItem(adapter, op.inbox_phid);

  if (!op.reason?.trim()) {
    throw new Error('Check-off requires a reason');
  }

  await updateOperatorState(adapter, op.inbox_phid, 'checked_off', {
    checked_off_at: op.ts,
    checked_off_reason: op.reason,
  });

  await appendAuditEvent(adapter, {
    inbox_phid: op.inbox_phid,
    op_id: `checkoff-${randomUUID().slice(0, 8)}`,
    op_type: 'CHECK_OFF',
    actor_id: op.actor_id,
    ts: op.ts,
    reason: op.reason,
    summary: `Checked off: ${op.reason}`,
    input_revision: null,
    links_json: null,
  });
}

// ── Audit note ──

export async function applyAuditNote(adapter: DbAdapter, op: AuditNoteOp): Promise<void> {
  await requireItem(adapter, op.inbox_phid);

  if (!op.note?.trim()) {
    throw new Error('Audit note requires text');
  }

  await appendAuditEvent(adapter, {
    inbox_phid: op.inbox_phid,
    op_id: `note-${randomUUID().slice(0, 8)}`,
    op_type: 'AUDIT_NOTE',
    actor_id: op.actor_id,
    ts: op.ts,
    reason: null,
    summary: op.note,
    input_revision: null,
    links_json: null,
  });
}
