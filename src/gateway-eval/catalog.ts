// RF2 — model-gateway option catalog (the evaluated data).
//
// HONESTY NOTE: capabilities are from public docs as of `as_of` with a
// confidence; PRICING/commercial terms drift — cost rows are representative
// estimates flagged verify_before_use. The recommender MATH is the durable
// artifact; the numbers are operator-replaceable inputs.
//
// RF2 names Portkey. We also catalogue LiteLLM (the other major OSS AI gateway,
// for a fair comparison), OpenRouter (the hosted aggregator already wired as an
// id-agents runtime), and "own model-policy" (the status-quo / extend baseline:
// src/model-policy already does provider-neutral routing today).

import type { ModelGatewayOption } from "./types.js";

const EVAL_DATE = "2026-06-24";

/** Portkey — AI gateway. OSS gateway core (MIT) + hosted control plane.
 *  The RF2 subject: full-featured gateway pattern. */
export const PORTKEY: ModelGatewayOption = {
  id: "portkey",
  name: "Portkey",
  url: "https://portkey.ai",
  kind: "gateway",
  open_source: true,
  license: "MIT", // gateway core (github.com/Portkey-AI/gateway); control plane hosted/enterprise
  capabilities: {
    provider_neutral_routing: true,
    fallbacks_retries: true,
    load_balancing: true,
    guardrails: true,
    semantic_caching: true,
    observability: true,
    virtual_keys_budgets: true,
    otel_compatible: true,
    sdk_languages: ["typescript", "python"],
  },
  hosted_cost: {
    billing_unit: "per_request",
    usd_per_month_hosted: 100, // representative paid control-plane tier — VERIFY
    free_tier: true,
    added_latency_ms: 40, // edge gateway, low overhead — VERIFY
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://portkey.ai/pricing",
      confidence: "low",
      verify_before_use: true,
      note: "OSS gateway is free to self-host; hosted control plane (observability/guardrails UI) is usage/seat-priced. Re-quote.",
    },
  },
  self_host: {
    available: true,
    license: "MIT",
    setup_effort_person_days: 3, // gateway is a fast edge service; full observability/control plane is the heavier piece
    ops_burden_person_days_per_month: 1,
    infra_usd_per_month: 80,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://github.com/Portkey-AI/gateway",
      confidence: "medium",
      verify_before_use: true,
      note: "MIT gateway self-hosts easily; the richer observability/guardrails dashboard leans on the hosted/enterprise control plane.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://portkey.ai",
    confidence: "medium",
    note: "Most complete gateway feature set (routing+guardrails+caching+observability+budgets). MIT core → liftable per directive #77.",
  },
};

/** LiteLLM — OSS proxy/SDK unifying 100+ providers behind the OpenAI format.
 *  The strongest self-host-first alternative to Portkey. */
export const LITELLM: ModelGatewayOption = {
  id: "litellm",
  name: "LiteLLM",
  url: "https://litellm.ai",
  kind: "gateway",
  open_source: true,
  license: "MIT",
  capabilities: {
    provider_neutral_routing: true,
    fallbacks_retries: true,
    load_balancing: true,
    guardrails: true, // via guardrail hooks/callbacks
    semantic_caching: true,
    observability: true, // logging callbacks (Langfuse/OTel/etc.)
    virtual_keys_budgets: true,
    otel_compatible: true,
    sdk_languages: ["python", "typescript"], // python-first; OpenAI-format usable from any lang
  },
  hosted_cost: {
    billing_unit: "free",
    usd_per_month_hosted: 0, // OSS proxy; enterprise tier optional
    free_tier: true,
    added_latency_ms: 30,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://litellm.ai",
      confidence: "medium",
      verify_before_use: true,
      note: "OSS proxy self-hosted = free; managed/enterprise optional. Python-first runtime.",
    },
  },
  self_host: {
    available: true,
    license: "MIT",
    setup_effort_person_days: 2,
    ops_burden_person_days_per_month: 1,
    infra_usd_per_month: 60,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://github.com/BerriAI/litellm",
      confidence: "medium",
      verify_before_use: true,
      note: "Run the proxy yourself; lightweight. MIT.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://litellm.ai",
    confidence: "medium",
    note: "Self-host-first OSS gateway; very broad provider coverage. Python-first (our runtimes are TS/CLI) is the main friction.",
  },
};

/** OpenRouter — hosted API aggregator, already wired as an id-agents runtime.
 *  Provider-neutral + fallbacks, but hosted-only (not self-hostable) and thin on
 *  guardrails/budgets. The adjacent status-quo. */
export const OPENROUTER: ModelGatewayOption = {
  id: "openrouter",
  name: "OpenRouter",
  url: "https://openrouter.ai",
  kind: "hosted_aggregator",
  open_source: false,
  capabilities: {
    provider_neutral_routing: true,
    fallbacks_retries: true,
    load_balancing: true,
    guardrails: false,
    semantic_caching: false,
    observability: true, // basic dashboards
    virtual_keys_budgets: true, // credits/limits
    otel_compatible: false,
    sdk_languages: ["typescript", "python"],
  },
  hosted_cost: {
    billing_unit: "usage",
    usd_per_month_hosted: 0, // no platform fee; pass-through model spend + small markup
    free_tier: true,
    added_latency_ms: 60,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://openrouter.ai",
      confidence: "medium",
      verify_before_use: true,
      note: "No platform subscription; small per-request markup on pass-through model spend. Hosted-only.",
    },
  },
  self_host: {
    available: false,
    setup_effort_person_days: 0,
    ops_burden_person_days_per_month: 0,
    infra_usd_per_month: 0,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "Hosted SaaS — cannot self-host." },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://openrouter.ai",
    confidence: "high",
    note: "Already integrated as a runtime (openrouter.env). Good provider-neutral routing + fallbacks; no guardrails/caching; not self-hostable.",
  },
};

/** Status-quo / extend baseline: our own src/model-policy routing. It already
 *  resolves model→runtime→provider lanes (provider-neutral routing); the gap is
 *  the gateway extras (guardrails, caching, fallbacks-as-a-feature, gateway
 *  observability). This is the "extend-own" reference. */
export const OWN_MODEL_POLICY: ModelGatewayOption = {
  id: "own_model_policy",
  name: "Own routing (model-policy, status quo)",
  url: "",
  kind: "own",
  open_source: true,
  capabilities: {
    provider_neutral_routing: true, // model-policy already does lane resolution
    fallbacks_retries: true, // primary→fallback chain exists in model-policy
    load_balancing: false,
    guardrails: false,
    semantic_caching: false,
    observability: false, // usage-meter is cost only, not request tracing
    virtual_keys_budgets: false,
    otel_compatible: false,
    sdk_languages: ["typescript"],
  },
  hosted_cost: {
    billing_unit: "free",
    usd_per_month_hosted: 0,
    free_tier: true,
    added_latency_ms: 0, // in-process
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "In-process routing; no marginal cost or added hop." },
  },
  self_host: {
    available: true,
    setup_effort_person_days: 0,
    ops_burden_person_days_per_month: 0,
    infra_usd_per_month: 0,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "Already in place (src/model-policy/)." },
  },
  provenance: {
    as_of: EVAL_DATE,
    confidence: "high",
    note: "Covers provider-neutral routing + fallback chains today. Missing the gateway extras — extending to parity is the RF2 build-own cost.",
  },
};

export const DEFAULT_CATALOG: ModelGatewayOption[] = [PORTKEY, LITELLM, OPENROUTER, OWN_MODEL_POLICY];
