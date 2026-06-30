// Approval-policy — the data-driven "what needs Chris vs auto" gate.
// Doctrine (2026-06-29 §"Approval / merge discipline"): scope changes, spend
// over a threshold, external sends, and irreversible domain-data cutovers gate
// to Chris; everything else auto-decides.

import { describe, it, expect } from "vitest";
import {
  APPROVAL_POLICY_VERSION,
  BUILTIN_DEFAULT_APPROVAL_POLICY,
  buildApprovalPolicyService,
  loadApprovalPolicy,
} from "../../src/approval-policy/policy.js";
import type { RawApprovalPolicyConfig } from "../../src/approval-policy/types.js";

const DEFAULT = loadApprovalPolicy(); // builtin doctrine default

describe("approval-policy — doctrine gate (builtin default)", () => {
  it("gates scope risk_class to Chris", () => {
    const d = DEFAULT.classify({ risk_class: "scope" });
    expect(d.gate).toBe("chris");
    expect(d.matched_rules.map((m) => m.rule)).toEqual(["risk_class"]);
  });

  it("auto-decides ordinary build/routine work (no rule matches)", () => {
    expect(DEFAULT.classify({ risk_class: "build", text: "T-CKPT — approvals cockpit panel" }).gate).toBe("auto");
    expect(DEFAULT.classify({ risk_class: "routine" }).gate).toBe("auto");
  });

  it("risk_class match is case-insensitive", () => {
    expect(DEFAULT.classify({ risk_class: "SCOPE" }).gate).toBe("chris");
    expect(DEFAULT.classify({ risk_class: " Scope " }).gate).toBe("chris");
  });

  it("gates spend at or above the threshold, auto below", () => {
    expect(DEFAULT.classify({ estimated_spend_usd: 50 }).gate).toBe("chris"); // == threshold
    expect(DEFAULT.classify({ estimated_spend_usd: 49.99 }).gate).toBe("auto");
    expect(DEFAULT.classify({ estimated_spend_usd: 1000 }).matched_rules[0]!.rule).toBe("spend");
  });

  it("ignores absent/non-finite spend (rule abstains)", () => {
    expect(DEFAULT.classify({}).gate).toBe("auto");
    expect(DEFAULT.classify({ estimated_spend_usd: null }).gate).toBe("auto");
    expect(DEFAULT.classify({ estimated_spend_usd: Number.NaN }).gate).toBe("auto");
  });

  it("gates external sends — explicit flag or keyword in text", () => {
    expect(DEFAULT.classify({ is_external_send: true }).gate).toBe("chris");
    const kw = DEFAULT.classify({ text: "Send email blast to the mailing list" });
    expect(kw.gate).toBe("chris");
    expect(kw.matched_rules.some((m) => m.rule === "external_send")).toBe(true);
  });

  it("gates irreversible cutovers — explicit flag or keyword in text", () => {
    expect(DEFAULT.classify({ is_irreversible_cutover: true }).gate).toBe("chris");
    expect(DEFAULT.classify({ text: "Drop table users and migrate production data" }).gate).toBe("chris");
    expect(DEFAULT.classify({ text: "rotate keys for the prod database" }).matched_rules.some((m) => m.rule === "irreversible_cutover")).toBe(true);
  });

  it("collects multiple matched rules when several gates trip", () => {
    const d = DEFAULT.classify({ risk_class: "scope", estimated_spend_usd: 500, text: "publish the cutover" });
    expect(d.gate).toBe("chris");
    expect(d.matched_rules.map((m) => m.rule).sort()).toEqual([
      "external_send",
      "irreversible_cutover",
      "risk_class",
      "spend",
    ]);
    expect(d.rationale).toMatch(/Needs Chris/);
  });

  it("stamps the policy version on every decision", () => {
    expect(DEFAULT.classify({}).policy_version).toBe(APPROVAL_POLICY_VERSION);
  });

  it("exposes a compact summary of the policy in effect", () => {
    const s = DEFAULT.summary();
    expect(s).toMatchObject({
      schema_version: APPROVAL_POLICY_VERSION,
      source: "builtin_default",
      default_decision: "auto",
      gated_risk_classes: ["scope"],
      spend_threshold: { currency: "USD", threshold: 50 },
      external_send_gated: true,
      irreversible_cutover_gated: true,
    });
  });
});

describe("approval-policy — config-driven (no code change to retune the gate)", () => {
  it("honors a custom risk-class gate list + spend threshold from config", () => {
    const raw: RawApprovalPolicyConfig = {
      schema_version: "approval-policy.test",
      default_decision: "auto",
      gated_risk_classes: ["scope", "destructive"],
      spend: { currency: "USD", threshold: 1000 },
      external_send: { gate: false, keywords: [] },
      irreversible_cutover: { gate: false, keywords: [] },
    };
    const svc = buildApprovalPolicyService(raw, "file");
    expect(svc.classify({ risk_class: "destructive" }).gate).toBe("chris");
    expect(svc.classify({ estimated_spend_usd: 999 }).gate).toBe("auto");
    expect(svc.classify({ estimated_spend_usd: 1000 }).gate).toBe("chris");
    // external/irreversible disabled by config → keyword no longer gates
    expect(svc.classify({ text: "send email blast and drop table" }).gate).toBe("auto");
  });

  it("default_decision=chris flips the fall-through to require Chris", () => {
    const svc = buildApprovalPolicyService(
      { default_decision: "chris", gated_risk_classes: [], spend: null, external_send: { gate: false }, irreversible_cutover: { gate: false } },
      "file",
    );
    expect(svc.classify({ risk_class: "build" }).gate).toBe("chris");
  });
});

describe("approval-policy — resilient load (never throws)", () => {
  it("falls back to the builtin default when the file is missing", () => {
    const svc = loadApprovalPolicy({
      configPath: "/no/such/approval-policy.json",
      readFile: () => {
        throw new Error("ENOENT");
      },
      onWarn: () => {},
    });
    expect(svc.config.source).toBe("builtin_default");
    expect(svc.classify({ risk_class: "scope" }).gate).toBe("chris");
  });

  it("falls back to the builtin default on malformed JSON", () => {
    const svc = loadApprovalPolicy({
      configPath: "/x.json",
      readFile: () => "{ not json",
      onWarn: () => {},
    });
    expect(svc.config.source).toBe("builtin_default");
  });

  it("loads a well-formed config file as source=file", () => {
    const svc = loadApprovalPolicy({
      configPath: "/x.json",
      readFile: () => JSON.stringify(BUILTIN_DEFAULT_APPROVAL_POLICY),
    });
    expect(svc.config.source).toBe("file");
    expect(svc.classify({ risk_class: "scope" }).gate).toBe("chris");
  });

  it("ships configs/approval-policy.json that parses and matches the builtin gate", () => {
    const svc = loadApprovalPolicy({ configPath: `${process.cwd()}/configs/approval-policy.json` });
    expect(svc.config.source).toBe("file");
    expect(svc.summary().gated_risk_classes).toContain("scope");
    expect(svc.classify({ risk_class: "scope" }).gate).toBe("chris");
    expect(svc.classify({ risk_class: "build" }).gate).toBe("auto");
  });
});
