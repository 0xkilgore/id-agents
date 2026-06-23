// Continuous Orchestration — auto-flesh readiness policy.
//
// The safety gate for daemon SELF-REFUEL. A fleshed skeleton becomes READY
// automatically ONLY when every check below passes; everything else is held as
// `needs_chris_batch` (with the proposed patch stored for one-click approval).
// Pure + fully unit-tested — the flesher and daemon wire I/O around it.
//
// NON-GOAL: never let generated work that touches external accounts, money,
// DNS, data deletion, force-push, budgets, or scheduler guardrails go READY
// unattended. See cto/output/2026-06-22-daemon-autonomous-engine-gap-scope.md.

import type { FleshPatch, RiskClass } from "./types.js";

export const FLESH_POLICY_VERSION = "flesh-policy.v1";

/** Confidence at/above which a valid, safe patch may auto-promote to READY. */
export const AUTO_READY_CONFIDENCE_THRESHOLD = 0.82;

/** Risk classes safe to auto-run unattended. Everything else escalates. */
const AUTO_READY_RISK = new Set<RiskClass>(["routine", "build"]);

/**
 * High-risk phrase denylist. If the generated dispatch body OR the source title
 * matches any of these, the item can NEVER auto-ready — it routes to Chris's
 * approval batch. Deliberately broad: a false "needs review" is cheap; a false
 * "auto-fire destructive work" is not.
 */
export const HIGH_RISK_DENYLIST: RegExp[] = [
  /\bforce[- ]?push(?:ing|es|ed)?\b/i,
  /\bdelete\s+(?:data|database|table|production|prod|records?|rows?)\b/i,
  /\bdrop\s+(?:table|database)\b/i,
  /\bpurchase|buy\b|payment|billing|charge\s+card|credit\s+card\b/i,
  /\b(?:dns|domain)\s+(?:record|registr|transfer|change)|\bnameservers?\b/i,
  /\bsend\s+(?:an?\s+)?email|email\s+(?:campaign|blast)|mailing\s+list\b/i,
  /\bchange\s+(?:the\s+)?budget|raise\s+(?:the\s+)?(?:cap|ceiling|budget)\b/i,
  /\b(?:scheduler|orchestration)\s+guardrail|kill[- ]?switch|disable\s+(?:the\s+)?(?:cap|gate|guardrail)\b/i,
  /\b(?:rotate|change|revoke)\s+(?:api\s+)?(?:keys?|secrets?|credentials?|tokens?)\b/i,
  /\bpublic\s+deploy|deploy\s+to\s+production|ship\s+to\s+prod\b/i,
  /\bexternal\s+account|third[- ]?party\s+account\b/i,
];

export interface ValidateFleshPatchOptions {
  /** Agents the patch may target — the live catalog or configured lane map. */
  knownAgents: Set<string>;
  /** Project write scopes a build item may declare (must be a subset). */
  knownWriteScopes: Set<string>;
  /** Per-item max token estimate for an auto-ready candidate. */
  maxTokenEstimate: number;
  /** The project tag the dispatch body must lead with, e.g. "kapelle". */
  projectTag: string;
}

/**
 * Hard structural validation of a generated patch. Returns the list of
 * violations (empty = valid). A patch that fails validation can never be READY.
 */
export function validateFleshPatch(patch: FleshPatch, opts: ValidateFleshPatchOptions): string[] {
  const errors: string[] = [];
  const body = patch.dispatch_body ?? "";

  if (!body.startsWith(`[project: ${opts.projectTag}]`)) {
    errors.push(`dispatch_body must start with [project: ${opts.projectTag}]`);
  }
  // A track tag like [T-ORCH] / [T15] anywhere in the leading metadata block.
  if (!/\[T-?(?:[A-Z]{1,6}|\d{1,3})(?:\.\d+)?[^\]]*\]/.test(body)) {
    errors.push("dispatch_body must include the track tag");
  }
  if (!patch.to_agent || !/\b\w+:\s/.test(body)) {
    errors.push("dispatch_body must include a clear owner command (e.g. 'agent: do X')");
  }
  if (!patch.to_agent || !opts.knownAgents.has(patch.to_agent)) {
    errors.push(`to_agent '${patch.to_agent}' not in the known agent catalog/lane map`);
  }
  if (!AUTO_READY_RISK.has(patch.risk_class)) {
    errors.push(`risk_class '${patch.risk_class}' is not auto-runnable (routine|build only)`);
  }
  // Build work must declare a write scope, and it must be a subset of known scopes.
  if (patch.risk_class === "build") {
    if (!patch.write_scope || patch.write_scope.length === 0) {
      errors.push("write_scope must be non-empty for build work");
    } else {
      const broad = patch.write_scope.filter((s) => !opts.knownWriteScopes.has(s));
      if (broad.length > 0) {
        errors.push(`write_scope broader than known project scopes: ${broad.join(", ")}`);
      }
    }
  }
  if (!Number.isFinite(patch.token_estimate) || patch.token_estimate <= 0) {
    errors.push("token_estimate must be a finite positive number");
  } else if (patch.token_estimate > opts.maxTokenEstimate) {
    errors.push(`token_estimate ${patch.token_estimate} exceeds per-item max ${opts.maxTokenEstimate}`);
  }
  // Code-changing work must carry verification + Spec 054 promotion language.
  if (patch.risk_class === "build") {
    if (!/verif|test|build/i.test(body)) {
      errors.push("build dispatch_body must include a verification requirement");
    }
    if (!/spec\s*054|promot/i.test(body)) {
      errors.push("build dispatch_body must include Spec 054 promotion requirement");
    }
  }
  return errors;
}

/** True when the body or source title trips the high-risk denylist. */
export function matchesHighRiskDenylist(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const re of HIGH_RISK_DENYLIST) {
      if (re.test(text)) return re.source;
    }
  }
  return null;
}

export interface AutoReadyInput {
  patch: FleshPatch;
  /** The source skeleton title (also scanned against the denylist). */
  sourceTitle: string;
  /** Resolved item_ids known to the backlog (for dependency resolution). */
  knownItemIds: Set<string>;
  /** Daemon-attributed remaining budget; the estimate must fit. */
  remainingDaemonBudget: number;
  validate: ValidateFleshPatchOptions;
}

export interface AutoReadyDecision {
  ready_decision: "auto_ready" | "needs_chris_batch";
  reasons: string[];
}

/**
 * Decide whether a fleshed item may auto-promote to READY. Every condition must
 * hold; otherwise it is held for Chris's approval batch with the reasons logged.
 */
export function evaluateAutoReady(input: AutoReadyInput): AutoReadyDecision {
  const reasons: string[] = [];
  const { patch } = input;

  const denyHit = matchesHighRiskDenylist(patch.dispatch_body, input.sourceTitle);
  if (denyHit) reasons.push(`high-risk denylist match: /${denyHit}/`);

  if (patch.confidence < AUTO_READY_CONFIDENCE_THRESHOLD) {
    reasons.push(`confidence ${patch.confidence.toFixed(2)} < ${AUTO_READY_CONFIDENCE_THRESHOLD}`);
  }
  if (!AUTO_READY_RISK.has(patch.risk_class)) {
    reasons.push(`risk_class '${patch.risk_class}' requires approval batch`);
  }
  const validationErrors = validateFleshPatch(patch, input.validate);
  for (const e of validationErrors) reasons.push(`invalid: ${e}`);

  const unresolved = (patch.dependencies ?? []).filter((d) => !input.knownItemIds.has(d));
  if (unresolved.length > 0) {
    reasons.push(`unresolved dependencies: ${unresolved.join(", ")}`);
  }
  if (patch.token_estimate > input.remainingDaemonBudget) {
    reasons.push(
      `token_estimate ${patch.token_estimate} exceeds remaining daemon budget ${input.remainingDaemonBudget}`,
    );
  }

  return {
    ready_decision: reasons.length === 0 ? "auto_ready" : "needs_chris_batch",
    reasons,
  };
}
