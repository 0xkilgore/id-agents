// RF3 — observability-stack decision-support model (Promptfoo + Langfuse as the
// foundation for a Kapelle Observe/Audit paid tier; adopt-vs-build; cost).
// T-CKPT backlog RF3 is canonically a researcher read_only eval; this is the
// same eval encoded AS CODE — a typed capability/cost catalog plus a pure
// recommender — so the adopt-vs-build decision rests on a versioned, testable
// artifact instead of prose. Sibling of src/exec-sandbox/ (RF1).
//
// IMPORTANT — decision-support ONLY. Nothing in the codebase imports this at
// run time. The component interfaces below document what a real Observe/Audit
// tier would consume; this module ships none. Deleting the directory changes
// zero behavior — that is what makes shipping it the safest reversible option.

export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  as_of: string;
  source_url?: string;
  confidence: Confidence;
  /** Pricing/commercial facts drift — true means re-verify before a spend or
   *  packaging decision. */
  verify_before_use?: boolean;
  note?: string;
}

// ── Capabilities an Observe/Audit tier cares about ──────────────────

export interface ObservabilityCapabilities {
  /** Runtime LLM call tracing: traces/spans/generations with latency+IO. */
  runtime_tracing: boolean;
  /** Offline prompt/model evaluation harness (assertions, datasets, CI). */
  eval_harness: boolean;
  /** Versioned prompt management / registry. */
  prompt_management: boolean;
  /** Token + USD cost attribution per trace/user/session. */
  cost_tracking: boolean;
  /** Durable, queryable audit record of agent actions (the "Audit" half). */
  audit_log: boolean;
  /** Eval/test dataset management. */
  datasets: boolean;
  /** Hosted dashboards / UI for the operator. */
  dashboards: boolean;
  /** Speaks OpenTelemetry (vendor-neutral interop — avoids lock-in). */
  otel_compatible: boolean;
  sdk_languages: string[];
}

// ── Cost (modeled dimensionally; numbers are operator-replaceable) ───

export interface CostModel {
  billing_unit: "per_event" | "per_seat" | "per_month" | "usage" | "free";
  /** Representative hosted cost at the modeled volume, USD/month. 0 for a
   *  free/OSS-only tool. */
  usd_per_month_hosted: number;
  free_tier: boolean;
  provenance: Provenance;
}

export interface SelfHostProfile {
  available: boolean;
  license?: string; // MIT, Apache-2.0, AGPL-3.0 …
  /** One-time engineering effort to stand it up, person-days (estimate). */
  setup_effort_person_days: number;
  /** Standing ops burden, person-days/month (estimate). */
  ops_burden_person_days_per_month: number;
  /** Fixed infra to run it self-hosted, USD/month (estimate). */
  infra_usd_per_month: number;
  /** Heavy backing stores it requires (e.g. Postgres + Clickhouse). */
  backing_services: string[];
  provenance: Provenance;
}

export interface ObservabilityComponent {
  id: string;
  name: string;
  url: string;
  /** Primary role so the recommender can reason about coverage. */
  role: "tracing" | "eval" | "standard" | "internal";
  open_source: boolean;
  license?: string;
  capabilities: ObservabilityCapabilities;
  hosted_cost: CostModel;
  self_host: SelfHostProfile;
  provenance: Provenance;
}

// ── Tier requirements the recommender scores against ────────────────

/** The capability flags an Observe/Audit tier must cover. The recommender
 *  treats these as the union the chosen STACK must satisfy. */
export interface ObserveTierRequirements {
  need_runtime_tracing: boolean;
  need_eval_harness: boolean;
  need_prompt_management: boolean;
  need_cost_tracking: boolean;
  need_audit_log: boolean;
  need_datasets: boolean;
  /** Data residency / compliance forces self-host (Audit tiers often do). */
  require_self_host: boolean;
  /** Avoid vendor lock-in → prefer OTel-compatible components. */
  prefer_otel: boolean;
  needed_languages: string[];
  /** Expected monthly trace/event volume (drives hosted cost). */
  expected_events_per_month: number;
  weights?: Partial<RequirementWeights>;
}

export interface RequirementWeights {
  capability_coverage: number;
  self_host_fit: number;
  otel_fit: number;
  cost: number;
}

// ── Recommender output ──────────────────────────────────────────────

export interface ComponentScore {
  component_id: string;
  score: number; // 0..1
  breakdown: {
    capability_coverage: number;
    self_host_fit: number;
    otel_fit: number;
    cost: number;
  };
  /** Tier requirements this component does NOT cover on its own (informational
   *  — components compose into a stack). */
  gaps: string[];
  estimated_hosted_usd_per_month: number;
  rationale: string[];
}

export interface StackRecommendation {
  /** Per-component ranking (best fit first). */
  ranking: ComponentScore[];
  /** The recommended minimal stack (component ids) that covers the tier's
   *  required capabilities, or null when no combination covers them. */
  recommended_stack: string[] | null;
  /** Required capabilities the recommended stack still cannot cover. */
  uncovered_requirements: string[];
  /** The adopt-vs-build call for the recommended stack. */
  adopt_vs_build: AdoptVsBuild | null;
  generated_at: string;
}

// ── Adopt-and-extend vs build-from-scratch ──────────────────────────

export type AdoptVsBuildVerdict =
  | "adopt_and_extend" // build the tier ON Promptfoo/Langfuse
  | "build_own" // build the Observe/Audit tier from primitives
  | "too_close_to_call";

export interface AdoptVsBuild {
  stack: string[];
  verdict: AdoptVsBuildVerdict;
  /** Fully-loaded cost of adopting (hosted or self-hosted OSS) per month. */
  adopt_usd_per_month: number;
  /** Fully-loaded cost of building the equivalent ourselves per month
   *  (amortized build effort + ops). */
  build_own_usd_per_month: number;
  amortization_months: number;
  /** True when every component in the stack is OSS (license-clean to extend). */
  stack_is_oss: boolean;
  rationale: string[];
}

// ── The seam a real Observe/Audit tier would consume (NOT implemented) ──

export interface TraceEvent {
  trace_id: string;
  agent_id: string;
  kind: "llm_call" | "tool_call" | "decision" | "dispatch";
  started_at: string;
  ended_at: string;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
}

export interface ObservabilitySink {
  readonly id: string;
  emit(event: TraceEvent): Promise<void>;
  flush(): Promise<void>;
}
