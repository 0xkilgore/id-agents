// A1 — manager "needs-Chris decisions" projection.
// (approvals cockpit scope, cto/output/2026-06-29-approvals-cockpit-scope.md)
//
// Unifies the two LIVE "needs Chris" feeds — open dispatch clarifications
// (GET /dispatches/clarifications) and needs_chris_batch build items
// (listBacklogByState state=needs_chris_batch) — into ONE typed decision queue.
// Each row is tagged by `kind` and carries SERVER-AUTHORED allowed actions
// (method + path), so the cockpit UI never guesses how to act on a row.
//
// Pure + `now`-injected (deterministic, unit-testable). The route fetches the
// two sources, maps them to the inputs below, and calls buildNeedsChrisQueue.

import type { ApprovalPolicySummary } from "../approval-policy/types.js";

export type NeedsChrisKind = "clarification" | "build_approval";

/** Per-row approval-policy verdict (T-CKPT). The Approvals surface reads the
 *  data-driven policy and annotates each build approval with whether it needs
 *  Chris and which rule(s) gated it — so the row shows *why*, not just that it's
 *  in the batch. */
export interface NeedsChrisGate {
  needs_chris: boolean;
  matched_rules: string[];
  rationale: string;
}

export type NeedsChrisActionType = "approve" | "hold" | "re_route" | "reclassify";

/** A server-authored action affordance — the UI calls method+path verbatim.
 *  `hold` is client-only (defer / leave open), so method+path are null. */
export interface NeedsChrisAction {
  action: NeedsChrisActionType;
  method: "POST" | "PATCH" | null;
  path: string | null;
  label: string;
}

export interface NeedsChrisRow {
  kind: NeedsChrisKind;
  /** RD-001 stable id: clarification_id (clarification) | item_id (build_approval). */
  id: string;
  /** Resume target for clarifications; null for build approvals. */
  dispatch_id: string | null;
  agent: string;
  summary: string;
  detail: string | null;
  urgency: string;
  age_seconds: number;
  stale_at: string | null;
  /** Convenience: the action types allowed for this kind (mirrors `actions`). */
  allowed_actions: NeedsChrisActionType[];
  /** Full action affordances (method + path) the UI invokes. */
  actions: NeedsChrisAction[];
  /** Approval-policy verdict (build approvals only; present when a classifier
   *  is supplied). Lets the surface show why a row gates to Chris. */
  gate?: NeedsChrisGate;
}

export interface NeedsChrisQueue {
  schema_version: "decisions.needs-chris.v1";
  generated_at: string;
  counts: { total: number; clarification: number; build_approval: number };
  rows: NeedsChrisRow[];
  /** The data-driven approval policy in effect (present when supplied). The
   *  surface shows this so "what needs Chris" is visible, not implicit. */
  approval_policy?: ApprovalPolicySummary;
}

/** Optional hooks so the Approvals surface can layer its data-driven approval
 *  policy onto the queue without coupling this pure projection to the loader. */
export interface BuildNeedsChrisOptions {
  /** Classify one build approval against the policy → its per-row gate verdict. */
  classifyBuildApproval?: (input: BuildApprovalInput) => NeedsChrisGate;
  /** The policy summary to embed at the top of the queue. */
  approvalPolicy?: ApprovalPolicySummary;
}

export interface ClarificationInput {
  dispatch_id: string;
  clarification_id: string | null;
  agent_id: string;
  subject: string;
  question: string;
  urgency: string;
  stale_at: string | null;
  age_seconds: number;
}

export interface BuildApprovalInput {
  item_id: string;
  title: string;
  to_agent: string | null;
  risk_class: string;
  priority: number;
  created_at?: string | null;
}

/** Clarifications: answer+resume, resume-with-redirect, or hold. */
function clarificationActions(): NeedsChrisAction[] {
  return [
    { action: "approve", method: "POST", path: "/agent-resume", label: "Answer & resume" },
    { action: "re_route", method: "POST", path: "/agent-resume", label: "Resume with redirect" },
    { action: "hold", method: null, path: null, label: "Hold (leave open)" },
  ];
}

/** Build approvals: promote/fire, re-route owner, reclassify risk, or hold. */
function buildApprovalActions(itemId: string): NeedsChrisAction[] {
  const ref = `/orchestration/backlog/${itemId}`;
  return [
    { action: "approve", method: "POST", path: `${ref}/promote`, label: "Approve & fire" },
    { action: "re_route", method: "PATCH", path: ref, label: "Re-route (to_agent)" },
    { action: "reclassify", method: "PATCH", path: ref, label: "Reclassify (risk_class)" },
    { action: "hold", method: null, path: null, label: "Hold (defer)" },
  ];
}

/** Map a build item's 1..9 priority to a coarse urgency label (1=highest). */
function priorityUrgency(priority: number): string {
  if (priority <= 2) return "high";
  if (priority <= 5) return "normal";
  return "low";
}

function ageSeconds(fromIso: string | null | undefined, nowMs: number): number {
  if (!fromIso) return 0;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/**
 * Build the unified needs-Chris decision queue. Clarifications (which block a
 * waiting agent) sort first; build approvals follow, ordered by priority then
 * age. Pure + deterministic.
 */
export function buildNeedsChrisQueue(
  clarifications: readonly ClarificationInput[],
  buildApprovals: readonly BuildApprovalInput[],
  nowIso: string,
  options: BuildNeedsChrisOptions = {},
): NeedsChrisQueue {
  const nowMs = Date.parse(nowIso);

  const clarificationRows: NeedsChrisRow[] = clarifications.map((c) => {
    const actions = clarificationActions();
    return {
      kind: "clarification",
      id: c.clarification_id ?? c.dispatch_id, // RD-001 stable id
      dispatch_id: c.dispatch_id,
      agent: c.agent_id,
      summary: c.subject,
      detail: c.question || null,
      urgency: c.urgency || "normal",
      age_seconds: c.age_seconds,
      stale_at: c.stale_at,
      allowed_actions: actions.map((a) => a.action),
      actions,
    };
  });

  const buildRows: NeedsChrisRow[] = [...buildApprovals]
    .sort((a, b) => (a.priority - b.priority) || (a.item_id < b.item_id ? -1 : 1))
    .map((b) => {
      const actions = buildApprovalActions(b.item_id);
      const row: NeedsChrisRow = {
        kind: "build_approval",
        id: b.item_id, // RD-001 stable id
        dispatch_id: null,
        agent: b.to_agent ?? "(unassigned)",
        summary: b.title,
        detail: null,
        urgency: priorityUrgency(b.priority),
        age_seconds: ageSeconds(b.created_at, nowMs),
        stale_at: null,
        allowed_actions: actions.map((a) => a.action),
        actions,
      };
      if (options.classifyBuildApproval) row.gate = options.classifyBuildApproval(b);
      return row;
    });

  const rows = [...clarificationRows, ...buildRows];
  const queue: NeedsChrisQueue = {
    schema_version: "decisions.needs-chris.v1",
    generated_at: nowIso,
    counts: {
      total: rows.length,
      clarification: clarificationRows.length,
      build_approval: buildRows.length,
    },
    rows,
  };
  if (options.approvalPolicy) queue.approval_policy = options.approvalPolicy;
  return queue;
}
