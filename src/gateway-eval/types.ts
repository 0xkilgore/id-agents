// RF2 — model-gateway decision-support model (Portkey gateway pattern for
// provider-neutral routing / guardrails / observability; adopt-vs-extend-own;
// cost). T-CKPT backlog RF2 is canonically a researcher read_only eval; this is
// the same eval encoded AS CODE — a typed capability/cost catalog plus a pure
// recommender — so the adopt-vs-extend decision rests on a versioned, testable
// artifact instead of prose. Sibling of src/exec-sandbox/ (RF1) and
// src/observability-eval/ (RF3).
//
// IMPORTANT — decision-support ONLY. Nothing in the codebase imports this at
// run time. The ModelGateway interface below documents the seam a real gateway
// adoption would implement over the existing src/model-policy routing; this
// module ships none. Deleting the directory changes zero behavior — that is
// what makes shipping it the safest reversible option.

export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  as_of: string;
  source_url?: string;
  confidence: Confidence;
  verify_before_use?: boolean;
  note?: string;
}

// ── Gateway capabilities ────────────────────────────────────────────

export interface GatewayCapabilities {
  /** Unified, provider-neutral API across LLM providers. */
  provider_neutral_routing: boolean;
  /** Automatic fallback to another provider/model on error. */
  fallbacks_retries: boolean;
  /** Load-balance / weighted routing across providers or keys. */
  load_balancing: boolean;
  /** Input/output guardrails (validation, PII, schema, moderation). */
  guardrails: boolean;
  /** Semantic / exact response caching. */
  semantic_caching: boolean;
  /** Request tracing / logging / metrics out of the box. */
  observability: boolean;
  /** Virtual keys + per-key budgets / rate limits. */
  virtual_keys_budgets: boolean;
  /** Speaks OpenTelemetry (interop, no lock-in). */
  otel_compatible: boolean;
  sdk_languages: string[];
}

// ── Cost / self-host ────────────────────────────────────────────────

export interface CostModel {
  billing_unit: "per_request" | "per_seat" | "per_month" | "usage" | "free";
  /** Representative hosted control-plane cost at the modeled volume, USD/month.
   *  0 for an OSS-self-host-only path. Excludes pass-through model spend. */
  usd_per_month_hosted: number;
  free_tier: boolean;
  /** Added per-request latency the gateway introduces, milliseconds. */
  added_latency_ms: number;
  provenance: Provenance;
}

export interface SelfHostProfile {
  available: boolean;
  license?: string;
  setup_effort_person_days: number;
  ops_burden_person_days_per_month: number;
  infra_usd_per_month: number;
  provenance: Provenance;
}

export interface ModelGatewayOption {
  id: string;
  name: string;
  url: string;
  /** "gateway" = a third-party AI gateway; "own" = extend our model-policy seam;
   *  "hosted_aggregator" = a hosted-only router (e.g. OpenRouter). */
  kind: "gateway" | "own" | "hosted_aggregator";
  open_source: boolean;
  license?: string;
  capabilities: GatewayCapabilities;
  hosted_cost: CostModel;
  self_host: SelfHostProfile;
  provenance: Provenance;
}

// ── Requirements the recommender scores against ─────────────────────

export interface GatewayRequirements {
  need_provider_neutral_routing: boolean;
  need_fallbacks_retries: boolean;
  need_load_balancing: boolean;
  need_guardrails: boolean;
  need_semantic_caching: boolean;
  need_observability: boolean;
  need_virtual_keys_budgets: boolean;
  /** Data residency / compliance forces self-host. */
  require_self_host: boolean;
  prefer_otel: boolean;
  /** Hard ceiling on added gateway latency, ms (0 = no constraint). */
  max_added_latency_ms: number;
  needed_languages: string[];
  /** Expected requests/month (drives hosted cost). */
  expected_requests_per_month: number;
  weights?: Partial<RequirementWeights>;
}

export interface RequirementWeights {
  capability_fit: number;
  self_host_fit: number;
  latency: number;
  cost: number;
}

// ── Recommender output ──────────────────────────────────────────────

export interface GatewayScore {
  gateway_id: string;
  score: number; // 0..1
  breakdown: {
    capability_fit: number;
    self_host_fit: number;
    latency: number;
    cost: number;
  };
  /** Hard gates this option FAILED (disqualified, still scored). */
  disqualifiers: string[];
  /** Required capabilities the option lacks. */
  capability_gaps: string[];
  estimated_monthly_usd: number;
  rationale: string[];
}

export interface GatewayRecommendation {
  ranking: GatewayScore[];
  /** Top eligible (non-disqualified) gateway id, or null. */
  recommended_gateway_id: string | null;
  /** The adopt-vs-extend-own call for the recommended gateway. */
  adopt_vs_extend: AdoptVsExtend | null;
  generated_at: string;
}

// ── Adopt a gateway vs extend our own model-policy routing ──────────

export type AdoptVsExtendVerdict =
  | "adopt_gateway" // adopt the third-party gateway
  | "extend_own" // build the missing capabilities on the model-policy seam
  | "too_close_to_call";

export interface AdoptVsExtend {
  gateway_id: string;
  verdict: AdoptVsExtendVerdict;
  /** Fully-loaded monthly cost of adopting the gateway. */
  adopt_usd_per_month: number;
  /** Fully-loaded monthly cost of extending our own routing to capability
   *  parity (amortized build + ops). */
  extend_own_usd_per_month: number;
  amortization_months: number;
  gateway_is_oss: boolean;
  rationale: string[];
}

// ── The seam a real adoption would implement (NOT implemented here) ──
// Documents the interface over the existing src/model-policy resolution.

export interface GatewayRequest {
  model: string;
  messages: { role: string; content: string }[];
  fallback_models?: string[];
}

export interface GatewayResponse {
  model_used: string;
  provider_used: string;
  content: string;
  cached: boolean;
}

export interface ModelGateway {
  readonly id: string;
  route(req: GatewayRequest): Promise<GatewayResponse>;
}
