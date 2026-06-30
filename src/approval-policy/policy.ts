// Approval-policy — loader + classifier.
//
// loadApprovalPolicy() reads configs/approval-policy.json, normalizes it, and
// returns an ApprovalPolicyService. classify() applies the data-driven gate to
// one item's signals and returns chris|auto with the matched rules + rationale.
// Pure + `readFile`-injected (deterministic, unit-testable). Never throws — a
// missing/broken config degrades to the builtin doctrine default so the manager
// always has a policy.
//
// Doctrine (2026-06-29 §"Approval / merge discipline"): scope changes
// (risk=scope), spend over a threshold, external sends, and irreversible
// domain-data cutovers → Chris; everything else → agents decide.

import { readFileSync } from "node:fs";
import type {
  ApprovalDecision,
  ApprovalDecisionGate,
  ApprovalPolicyConfig,
  ApprovalPolicySummary,
  ApprovalRuleMatch,
  ApprovalSignals,
  RawApprovalPolicyConfig,
} from "./types.js";

export const APPROVAL_POLICY_VERSION = "approval-policy.v1";

/** Builtin default — the doctrine gate, used when no config file is present or
 *  the file is broken. Mirrors configs/approval-policy.json. */
export const BUILTIN_DEFAULT_APPROVAL_POLICY: RawApprovalPolicyConfig = {
  schema_version: APPROVAL_POLICY_VERSION,
  default_decision: "auto",
  gated_risk_classes: ["scope"],
  spend: { currency: "USD", threshold: 50 },
  external_send: {
    gate: true,
    keywords: [
      "send email",
      "email campaign",
      "email blast",
      "mailing list",
      "publish",
      "tweet",
      "post to",
      "external account",
      "outbound send",
    ],
  },
  irreversible_cutover: {
    gate: true,
    keywords: [
      "cutover",
      "migrate production",
      "delete data",
      "drop table",
      "drop database",
      "force push",
      "data deletion",
      "irreversible",
      "rotate keys",
      "revoke credentials",
      "wipe",
    ],
  },
};

function normalizeGate(raw: ApprovalDecisionGate | undefined): ApprovalDecisionGate {
  return raw === "chris" ? "chris" : "auto";
}

function normalizeStrings(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Find the first keyword that appears (case-insensitively) in `text`. */
function matchKeyword(text: string | null | undefined, keywords: string[]): string | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  for (const kw of keywords) {
    if (kw && hay.includes(kw)) return kw;
  }
  return null;
}

export class ApprovalPolicyService {
  readonly config: ApprovalPolicyConfig;

  constructor(config: ApprovalPolicyConfig) {
    this.config = config;
  }

  /** Decide whether one item needs Chris. Collects every matched gate rule so
   *  the surface can show exactly why (or that nothing matched → auto). */
  classify(signals: ApprovalSignals): ApprovalDecision {
    const matched: ApprovalRuleMatch[] = [];

    const rc = (signals.risk_class ?? "").trim().toLowerCase();
    if (rc && this.config.gated_risk_classes.includes(rc)) {
      matched.push({ rule: "risk_class", detail: `risk_class '${rc}' is gated` });
    }

    const spend = signals.estimated_spend_usd;
    if (
      this.config.spend &&
      typeof spend === "number" &&
      Number.isFinite(spend) &&
      spend >= this.config.spend.threshold
    ) {
      matched.push({
        rule: "spend",
        detail: `spend ${this.config.spend.currency} ${spend} ≥ threshold ${this.config.spend.threshold}`,
      });
    }

    if (this.config.external_send.gate) {
      if (signals.is_external_send === true) {
        matched.push({ rule: "external_send", detail: "flagged as an external send" });
      } else {
        const kw = matchKeyword(signals.text, this.config.external_send.keywords);
        if (kw) matched.push({ rule: "external_send", detail: `external-send keyword '${kw}'` });
      }
    }

    if (this.config.irreversible_cutover.gate) {
      if (signals.is_irreversible_cutover === true) {
        matched.push({ rule: "irreversible_cutover", detail: "flagged as an irreversible cutover" });
      } else {
        const kw = matchKeyword(signals.text, this.config.irreversible_cutover.keywords);
        if (kw) matched.push({ rule: "irreversible_cutover", detail: `irreversible-cutover keyword '${kw}'` });
      }
    }

    const gate: ApprovalDecisionGate =
      matched.length > 0 ? "chris" : this.config.default_decision;

    const rationale =
      matched.length > 0
        ? `Needs Chris — ${matched.map((m) => m.detail).join("; ")}`
        : this.config.default_decision === "auto"
          ? "Auto-decided — no gating rule matched"
          : "Default gate — requires Chris";

    return { gate, matched_rules: matched, rationale, policy_version: this.config.schema_version };
  }

  /** Compact view for the Approvals surface (the policy in effect, no keywords). */
  summary(): ApprovalPolicySummary {
    return {
      schema_version: this.config.schema_version,
      source: this.config.source,
      default_decision: this.config.default_decision,
      gated_risk_classes: [...this.config.gated_risk_classes],
      spend_threshold: this.config.spend ? { ...this.config.spend } : null,
      external_send_gated: this.config.external_send.gate,
      irreversible_cutover_gated: this.config.irreversible_cutover.gate,
    };
  }
}

/** Pure builder — normalize a raw config into a service. */
export function buildApprovalPolicyService(
  raw: RawApprovalPolicyConfig,
  source: ApprovalPolicyConfig["source"],
): ApprovalPolicyService {
  const spendRaw = raw.spend;
  const spend =
    spendRaw && typeof spendRaw.threshold === "number" && Number.isFinite(spendRaw.threshold)
      ? { currency: (spendRaw.currency ?? "USD").trim() || "USD", threshold: spendRaw.threshold }
      : null;

  const config: ApprovalPolicyConfig = {
    schema_version: raw.schema_version?.trim() || APPROVAL_POLICY_VERSION,
    source,
    default_decision: normalizeGate(raw.default_decision),
    gated_risk_classes: normalizeStrings(raw.gated_risk_classes),
    spend,
    external_send: {
      gate: raw.external_send?.gate ?? false,
      keywords: normalizeStrings(raw.external_send?.keywords),
    },
    irreversible_cutover: {
      gate: raw.irreversible_cutover?.gate ?? false,
      keywords: normalizeStrings(raw.irreversible_cutover?.keywords),
    },
  };
  return new ApprovalPolicyService(config);
}

export interface LoadApprovalPolicyOptions {
  /** Absolute path to approval-policy.json. Missing/invalid → builtin default. */
  configPath?: string;
  /** Injectable reader for tests; defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Diagnostics sink (defaults to console.warn). */
  onWarn?: (msg: string) => void;
}

/** Load from disk; never throws. */
export function loadApprovalPolicy(opts: LoadApprovalPolicyOptions = {}): ApprovalPolicyService {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const warn = opts.onWarn ?? ((m: string) => console.warn(`[approval-policy] ${m}`));

  if (!opts.configPath) {
    return buildApprovalPolicyService(BUILTIN_DEFAULT_APPROVAL_POLICY, "builtin_default");
  }
  try {
    const raw = JSON.parse(read(opts.configPath)) as RawApprovalPolicyConfig;
    return buildApprovalPolicyService(raw, "file");
  } catch (err) {
    warn(
      `failed to load ${opts.configPath} (${err instanceof Error ? err.message : String(err)}); using builtin default`,
    );
    return buildApprovalPolicyService(BUILTIN_DEFAULT_APPROVAL_POLICY, "builtin_default");
  }
}
