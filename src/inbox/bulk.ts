// PT5 (2026-06-24) — Inbox bulk triage.
//
// Operators triage the inbox in batches: select N items and route / archive /
// mark-acted them in one action. Rather than invent new state, the three bulk
// actions fold onto the existing inbox state machine + ops:
//   - route       -> a primary routing decision (same shape as PROPOSE_ROUTE)
//   - archive     -> operator_state 'filed'      (the existing "filed away" state)
//   - mark_acted  -> operator_state 'checked_off' (the existing "acted on" state)
//
// Each item is applied independently and the per-item outcome is collected, so a
// missing or already-resolved item never aborts the batch. validate + summarize
// are pure (unit-testable without a DB); applyBulkInboxAction does the I/O.

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db/db-adapter.js';
import type { OperatorState } from './types.js';
import {
  getInboxItem,
  updateOperatorState,
  appendAuditEvent,
  appendRoutingDecision,
} from './storage.js';

export type BulkInboxAction = 'route' | 'archive' | 'mark_acted';

/** The supported bulk actions, in canonical order. */
export const BULK_INBOX_ACTIONS: BulkInboxAction[] = ['route', 'archive', 'mark_acted'];

export interface BulkInboxRequest {
  action: BulkInboxAction;
  phids: string[];
  actor_id: string;
  ts: string;
  reason?: string | null;
  // route-only params:
  action_type?: string;
  action_target?: string | null;
  rule_id?: string | null;
}

export interface BulkItemResult {
  inbox_phid: string;
  /** True when the action mutated the item. */
  applied: boolean;
  /** Resulting operator_state when applied (route leaves state unchanged). */
  state?: OperatorState | null;
  /** Why the item was skipped or failed: already_archived | already_acted | not_found. */
  reason?: string;
}

export interface BulkInboxSummary {
  action: BulkInboxAction;
  total: number;
  applied: number;
  skipped: number;
  failed: number;
}

export interface BulkInboxResult {
  summary: BulkInboxSummary;
  results: BulkItemResult[];
}

/** Trim + drop empties + de-duplicate, preserving first-seen order. */
export function normalizePhids(phids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phids ?? []) {
    const p = String(raw ?? '').trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Pure: validate a bulk request. Returns a list of human-readable errors ([] = ok). */
export function validateBulkInboxRequest(req: BulkInboxRequest): string[] {
  const errors: string[] = [];
  if (!BULK_INBOX_ACTIONS.includes(req.action)) {
    errors.push(`action must be one of: ${BULK_INBOX_ACTIONS.join(', ')}`);
  }
  if (normalizePhids(req.phids).length === 0) {
    errors.push('phids must contain at least one non-empty id');
  }
  if (req.action === 'route' && !req.action_type?.trim()) {
    errors.push('action_type is required for action "route"');
  }
  return errors;
}

/** Pure: fold per-item results into a batch summary. */
export function summarizeBulk(action: BulkInboxAction, results: BulkItemResult[]): BulkInboxSummary {
  let applied = 0;
  let failed = 0;
  for (const r of results) {
    if (r.applied) applied++;
    else if (r.reason === 'not_found') failed++;
  }
  return {
    action,
    total: results.length,
    applied,
    skipped: results.length - applied - failed,
    failed,
  };
}

/**
 * Apply a bulk triage action across many inbox items. Validates first (throws on
 * an invalid request, mirroring the single-item ops), then applies each item
 * independently so one bad/absent/already-resolved item never aborts the batch.
 */
export async function applyBulkInboxAction(adapter: DbAdapter, req: BulkInboxRequest): Promise<BulkInboxResult> {
  const errors = validateBulkInboxRequest(req);
  if (errors.length > 0) throw new Error(`Invalid bulk inbox request: ${errors.join('; ')}`);

  const phids = normalizePhids(req.phids);
  const results: BulkItemResult[] = [];

  for (const phid of phids) {
    const item = await getInboxItem(adapter, phid);
    if (!item) {
      results.push({ inbox_phid: phid, applied: false, reason: 'not_found' });
      continue;
    }
    results.push(await applyOne(adapter, req, phid, item.operator_state));
  }

  return { summary: summarizeBulk(req.action, results), results };
}

async function applyOne(
  adapter: DbAdapter,
  req: BulkInboxRequest,
  phid: string,
  currentState: OperatorState,
): Promise<BulkItemResult> {
  switch (req.action) {
    case 'archive': {
      if (currentState === 'filed') return { inbox_phid: phid, applied: false, reason: 'already_archived' };
      await updateOperatorState(adapter, phid, 'filed', { resolved_at: req.ts });
      await audit(adapter, phid, 'ARCHIVE', req, `Archived (bulk) — operator_state → filed`);
      return { inbox_phid: phid, applied: true, state: 'filed' };
    }
    case 'mark_acted': {
      if (currentState === 'checked_off') return { inbox_phid: phid, applied: false, reason: 'already_acted' };
      const reason = req.reason?.trim() || 'bulk mark-acted';
      await updateOperatorState(adapter, phid, 'checked_off', { checked_off_at: req.ts, checked_off_reason: reason });
      await audit(adapter, phid, 'MARK_ACTED', req, `Marked acted (bulk): ${reason}`);
      return { inbox_phid: phid, applied: true, state: 'checked_off' };
    }
    case 'route': {
      await appendRoutingDecision(adapter, {
        inbox_phid: phid,
        rule_id: req.rule_id ?? null,
        action_type: req.action_type!,
        action_target: req.action_target ?? null,
        actor_id: req.actor_id,
        reason: req.reason ?? 'bulk route',
        input_revision: `bulk-${req.ts}`,
        is_primary: true,
        decided_at: req.ts,
      });
      await audit(adapter, phid, 'PROPOSE_ROUTE', req, `Route (bulk): ${req.action_type} → ${req.action_target ?? '(none)'}`);
      return { inbox_phid: phid, applied: true, state: currentState };
    }
  }
}

async function audit(adapter: DbAdapter, phid: string, opType: string, req: BulkInboxRequest, summary: string): Promise<void> {
  await appendAuditEvent(adapter, {
    inbox_phid: phid,
    op_id: `bulk-${opType.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    op_type: opType,
    actor_id: req.actor_id,
    ts: req.ts,
    reason: req.reason ?? null,
    summary,
    input_revision: null,
    links_json: null,
  });
}
