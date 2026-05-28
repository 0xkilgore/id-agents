// Inbox 2.0 — deterministic routing-rule evaluator.
// Pure function: no writes, no dispatch creation, no side effects.

import type { InboxItemRow, InboxRoutingRule, RouteDecision } from './types.js';

function matchesRule(item: InboxItemRow, rule: InboxRoutingRule): boolean {
  const m = rule.match;

  if (m.source_kind && m.source_kind.length > 0) {
    if (!m.source_kind.includes(item.source_kind)) return false;
  }

  if (m.from_address_contains && m.from_address_contains.length > 0) {
    if (!item.source_from) return false;
    const lower = item.source_from.toLowerCase();
    if (!m.from_address_contains.some(s => lower.includes(s.toLowerCase()))) return false;
  }

  if (m.title_contains && m.title_contains.length > 0) {
    const title = (item.source_subject ?? '').toLowerCase();
    if (!m.title_contains.some(s => title.includes(s.toLowerCase()))) return false;
  }

  if (m.body_contains && m.body_contains.length > 0) {
    const body = (item.source_text ?? '').toLowerCase();
    if (!m.body_contains.some(s => body.includes(s.toLowerCase()))) return false;
  }

  if (m.classification && m.classification.length > 0) {
    if (!item.classification_label) return false;
    if (!m.classification.includes(item.classification_label as any)) return false;
  }

  if (m.project_hint && m.project_hint.length > 0) {
    if (!item.project_hint) return false;
    if (!m.project_hint.includes(item.project_hint)) return false;
  }

  if (m.agent_hint && m.agent_hint.length > 0) {
    if (!item.agent_hint) return false;
    if (!m.agent_hint.includes(item.agent_hint)) return false;
  }

  return true;
}

/**
 * Evaluate routing rules against an inbox item.
 * Returns all matching decisions sorted by priority asc, then rule_id.
 * The first enabled match is marked as primary.
 */
export function evaluateInboxRouting(
  item: InboxItemRow,
  rules: InboxRoutingRule[],
  _now: Date,
): RouteDecision[] {
  const enabledRules = rules.filter(r => r.enabled);

  // Sort by priority ascending, then rule_id for stability
  const sorted = [...enabledRules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.rule_id.localeCompare(b.rule_id);
  });

  const decisions: RouteDecision[] = [];
  let primaryAssigned = false;

  for (const rule of sorted) {
    if (matchesRule(item, rule)) {
      decisions.push({
        rule_id: rule.rule_id,
        action: rule.action,
        explanation: rule.explanation,
        is_primary: !primaryAssigned,
      });
      if (!primaryAssigned) primaryAssigned = true;
    }
  }

  return decisions;
}

// ── Default routing rules (v0 — common patterns from inbox.md analysis) ──

export const DEFAULT_ROUTING_RULES: InboxRoutingRule[] = [
  {
    rule_id: 'newsletter-dismiss',
    enabled: true,
    priority: 10,
    match: { classification: ['reference'] },
    action: { type: 'propose_file', filed_ref: { kind: 'reference', label: 'Newsletter / digest', target_phid: null, legacy_path: null } },
    explanation: 'Reference items (newsletters, notifications) are filed without action.',
  },
  {
    rule_id: 'action-needs-route',
    enabled: true,
    priority: 20,
    match: { classification: ['action'] },
    action: { type: 'requires_approval', reason: 'Action items need project/agent routing decision.' },
    explanation: 'Action items require explicit routing to a project or agent.',
  },
  {
    rule_id: 'dispatch-to-agent',
    enabled: true,
    priority: 30,
    match: { classification: ['dispatch'] },
    action: { type: 'requires_approval', reason: 'Dispatch items need agent assignment confirmation.' },
    explanation: 'Dispatch-classified items need agent assignment review.',
  },
  {
    rule_id: 'duplicate-discard',
    enabled: true,
    priority: 40,
    match: { classification: ['duplicate'] },
    action: { type: 'propose_discard', reason: 'Classified as duplicate.' },
    explanation: 'Duplicates are proposed for discard.',
  },
  {
    rule_id: 'discard-proposed',
    enabled: true,
    priority: 50,
    match: { classification: ['discard'] },
    action: { type: 'propose_discard', reason: 'Classified as discard by operator or classifier.' },
    explanation: 'Items classified as discard are proposed for removal.',
  },
];
