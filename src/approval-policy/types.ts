// Approval-policy — types.
//
// The data-driven "what needs Chris vs what agents auto-decide" policy
// (Kapelle Fleet Doctrine 2026-06-29 §"Approval / merge discipline").
// The gate is config (configs/approval-policy.json), not code: scope changes,
// spend over a threshold, external sends, and irreversible domain-data cutovers
// route to Chris; everything else auto-decides. Edit the config to change the
// gate — no redeploy. The Approvals surface (GET /decisions/needs-chris) reads
// this policy: it embeds the active policy summary and annotates each row with
// the gate decision (which rule matched, and why).

export type ApprovalDecisionGate = "chris" | "auto";

export type ApprovalRuleId =
  | "risk_class"
  | "spend"
  | "external_send"
  | "irreversible_cutover";

/** Raw config entry (configs/approval-policy.json). Every field optional —
 *  a missing/partial file degrades to the builtin doctrine default. */
export interface RawApprovalPolicyConfig {
  schema_version?: string;
  default_decision?: ApprovalDecisionGate;
  gated_risk_classes?: string[];
  spend?: { currency?: string; threshold?: number } | null;
  external_send?: { gate?: boolean; keywords?: string[] } | null;
  irreversible_cutover?: { gate?: boolean; keywords?: string[] } | null;
}

/** Fully normalized policy (lowercased risk classes + keywords, defaults filled). */
export interface ApprovalPolicyConfig {
  schema_version: string;
  source: "file" | "builtin_default";
  default_decision: ApprovalDecisionGate;
  gated_risk_classes: string[];
  spend: { currency: string; threshold: number } | null;
  external_send: { gate: boolean; keywords: string[] };
  irreversible_cutover: { gate: boolean; keywords: string[] };
}

/** What the classifier knows about one approvable item. All optional — the
 *  policy only gates on signals it actually has (no signal → that rule abstains). */
export interface ApprovalSignals {
  /** Item risk class, e.g. "scope" | "build" | "routine". */
  risk_class?: string | null;
  /** Estimated spend in the policy's currency (USD). */
  estimated_spend_usd?: number | null;
  /** Explicit external-send flag (true forces the external gate). */
  is_external_send?: boolean | null;
  /** Explicit irreversible-cutover flag (true forces that gate). */
  is_irreversible_cutover?: boolean | null;
  /** Free text (title/body) scanned against the external/irreversible keyword sets. */
  text?: string | null;
}

export interface ApprovalRuleMatch {
  rule: ApprovalRuleId;
  detail: string;
}

export interface ApprovalDecision {
  gate: ApprovalDecisionGate;
  matched_rules: ApprovalRuleMatch[];
  rationale: string;
  policy_version: string;
}

/** Compact, surface-facing view of the policy in effect (no keyword lists). */
export interface ApprovalPolicySummary {
  schema_version: string;
  source: "file" | "builtin_default";
  default_decision: ApprovalDecisionGate;
  gated_risk_classes: string[];
  spend_threshold: { currency: string; threshold: number } | null;
  external_send_gated: boolean;
  irreversible_cutover_gated: boolean;
}
