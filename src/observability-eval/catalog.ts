// RF3 — observability component catalog (the evaluated data).
//
// HONESTY NOTE: capabilities are from public docs as of `as_of` with a
// confidence; PRICING/commercial terms drift — cost rows are representative
// estimates flagged verify_before_use. The recommender MATH is the durable
// artifact; the numbers are operator-replaceable inputs. No usd_* figure here
// is a committed quote.
//
// RF3 names Promptfoo + Langfuse. We also catalogue OpenTelemetry (the
// vendor-neutral open standard = the "build-own from primitives" reference) and
// the existing src/usage-meter/ (status-quo internal cost attribution) so the
// recommender always scores against the honest do-less baseline.

import type { ObservabilityComponent } from "./types.js";

const EVAL_DATE = "2026-06-24";

/** Langfuse — LLM observability/tracing platform. MIT core; self-hostable
 *  (Postgres + Clickhouse); hosted cloud with usage tiers. The "Observe" half. */
export const LANGFUSE: ObservabilityComponent = {
  id: "langfuse",
  name: "Langfuse",
  url: "https://langfuse.com",
  role: "tracing",
  open_source: true,
  license: "MIT", // core is MIT; some enterprise features are commercial
  capabilities: {
    runtime_tracing: true,
    eval_harness: true, // has evals, but Promptfoo is the stronger CI eval tool
    prompt_management: true,
    cost_tracking: true,
    audit_log: true, // durable trace store doubles as the audit record
    datasets: true,
    dashboards: true,
    otel_compatible: true, // ingests OpenTelemetry
    sdk_languages: ["typescript", "python"],
  },
  hosted_cost: {
    billing_unit: "per_event",
    usd_per_month_hosted: 100, // representative paid tier at modest volume — VERIFY
    free_tier: true,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://langfuse.com/pricing",
      confidence: "low",
      verify_before_use: true,
      note: "Hosted: free tier + usage-based paid tiers (events ingested). Some features enterprise-only.",
    },
  },
  self_host: {
    available: true,
    license: "MIT",
    setup_effort_person_days: 5,
    ops_burden_person_days_per_month: 2,
    infra_usd_per_month: 150, // Postgres + Clickhouse + app
    backing_services: ["postgres", "clickhouse"],
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://langfuse.com/self-hosting",
      confidence: "medium",
      verify_before_use: true,
      note: "Self-host is real infra (Postgres + Clickhouse). MIT core → license-clean to run + extend.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://langfuse.com",
    confidence: "medium",
    note: "Strong fit for the Observe + Audit halves: tracing, cost attribution, prompt mgmt, durable trace store. MIT core → liftable per directive #77.",
  },
};

/** Promptfoo — prompt/LLM evaluation + testing harness. MIT; primarily a
 *  local CLI/library (CI evals, assertions, red-teaming). The "eval" half. */
export const PROMPTFOO: ObservabilityComponent = {
  id: "promptfoo",
  name: "Promptfoo",
  url: "https://promptfoo.dev",
  role: "eval",
  open_source: true,
  license: "MIT",
  capabilities: {
    runtime_tracing: false, // it's an offline eval tool, not a runtime tracer
    eval_harness: true,
    prompt_management: false,
    cost_tracking: false,
    audit_log: false,
    datasets: true,
    dashboards: true, // eval result viewer
    otel_compatible: false,
    sdk_languages: ["typescript", "python"],
  },
  hosted_cost: {
    billing_unit: "free",
    usd_per_month_hosted: 0, // OSS CLI/lib; cloud/enterprise optional
    free_tier: true,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://promptfoo.dev",
      confidence: "medium",
      verify_before_use: true,
      note: "Core is a free MIT CLI/library. Optional paid cloud/enterprise for team features.",
    },
  },
  self_host: {
    available: true,
    license: "MIT",
    setup_effort_person_days: 1, // it's a lib/CLI — trivial to adopt in CI
    ops_burden_person_days_per_month: 0,
    infra_usd_per_month: 0,
    backing_services: [],
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://github.com/promptfoo/promptfoo",
      confidence: "high",
      note: "Runs locally / in CI; no standing infra. MIT.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://promptfoo.dev",
    confidence: "high",
    note: "Best-in-class eval/test harness; complements (not overlaps) Langfuse's runtime tracing. MIT.",
  },
};

/** OpenTelemetry — vendor-neutral open standard for traces. The "build-own from
 *  open primitives" reference point: maximal control, maximal effort. */
export const OPENTELEMETRY: ObservabilityComponent = {
  id: "opentelemetry",
  name: "OpenTelemetry",
  url: "https://opentelemetry.io",
  role: "standard",
  open_source: true,
  license: "Apache-2.0",
  capabilities: {
    runtime_tracing: true,
    eval_harness: false,
    prompt_management: false,
    cost_tracking: false,
    audit_log: false, // raw spans; you build the audit semantics yourself
    datasets: false,
    dashboards: false, // needs a backend (Jaeger/Tempo/…) + UI
    otel_compatible: true,
    sdk_languages: ["typescript", "python", "go", "java"],
  },
  hosted_cost: {
    billing_unit: "free",
    usd_per_month_hosted: 0,
    free_tier: true,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "The SDK/standard is free; a backend + storage is extra." },
  },
  self_host: {
    available: true,
    license: "Apache-2.0",
    setup_effort_person_days: 15, // instrument + run a collector + backend + UI + cost/eval semantics
    ops_burden_person_days_per_month: 3,
    infra_usd_per_month: 200,
    backing_services: ["otel-collector", "trace-backend", "storage"],
    provenance: {
      as_of: EVAL_DATE,
      confidence: "medium",
      note: "Maximal control but you build cost-tracking, prompt-mgmt, eval, audit semantics yourself. This is the build-own baseline.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://opentelemetry.io",
    confidence: "high",
    note: "Open tracing standard. Reference for the build-own path; both Promptfoo-adjacent and Langfuse speak OTel, so adopting them does not preclude OTel interop.",
  },
};

/** Status-quo baseline: the existing src/usage-meter/ (token/spend attribution).
 *  Not tracing or eval — included so the recommender scores against the honest
 *  "what we already have" reference. */
export const USAGE_METER: ObservabilityComponent = {
  id: "usage_meter",
  name: "usage-meter (status quo)",
  url: "",
  role: "internal",
  open_source: true,
  capabilities: {
    runtime_tracing: false,
    eval_harness: false,
    prompt_management: false,
    cost_tracking: true, // its whole job
    audit_log: false,
    datasets: false,
    dashboards: false,
    otel_compatible: false,
    sdk_languages: ["typescript"],
  },
  hosted_cost: {
    billing_unit: "free",
    usd_per_month_hosted: 0,
    free_tier: true,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "Already built; no marginal cost." },
  },
  self_host: {
    available: true,
    setup_effort_person_days: 0,
    ops_burden_person_days_per_month: 0,
    infra_usd_per_month: 0,
    backing_services: ["sqlite"],
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "In place today (src/usage-meter/)." },
  },
  provenance: {
    as_of: EVAL_DATE,
    confidence: "high",
    note: "Covers cost-tracking only. An Observe/Audit tier needs tracing + eval + audit on top — which is exactly the RF3 question.",
  },
};

export const DEFAULT_CATALOG: ObservabilityComponent[] = [
  LANGFUSE,
  PROMPTFOO,
  OPENTELEMETRY,
  USAGE_METER,
];
