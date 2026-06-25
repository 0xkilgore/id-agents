// RF1 — exec-sandbox decision-support model (E2B vs Daytona; integrate-vs-
// operate-own; cost). T-CKPT backlog RF1 is canonically a researcher read_only
// eval; this is the same eval encoded AS CODE — a typed capability/cost catalog
// plus a pure recommender — so the integrate-vs-operate-own decision rests on a
// versioned, testable artifact instead of prose.
//
// IMPORTANT — this module is decision-support only. It is intentionally NOT
// wired into any runtime path: nothing in the codebase imports it at run time.
// The `ExecSandboxProvider` interface below documents the seam a future
// integration would implement; this module ships none. Deleting the whole
// directory changes zero behavior — that is what makes shipping it the safest
// reversible option.

// ── Provenance / confidence ─────────────────────────────────────────
// Every fact in the catalog carries where it came from and how sure we are, so
// a stale price never masquerades as ground truth. Mirrors the model-policy
// `source: "seed" | "models_dev"` provenance convention.

export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  /** ISO date the fact was last checked. */
  as_of: string;
  source_url?: string;
  confidence: Confidence;
  /** When true, the operator MUST re-verify before relying on this for a spend
   *  decision (used for pricing, which drifts). */
  verify_before_use?: boolean;
  note?: string;
}

// ── Capabilities ────────────────────────────────────────────────────

/** How strongly a sandbox isolates untrusted agent code. */
export type IsolationModel =
  | "microvm" // Firecracker / hardware-virtualized — strongest
  | "container" // namespaced OS container
  | "process"; // same-host process — weakest

export interface SandboxCapabilities {
  /** Persistent filesystem that survives within a session. */
  persistent_fs: boolean;
  /** Snapshot / fork a running sandbox for fast resume. */
  snapshots: boolean;
  /** Outbound internet from inside the sandbox (toggleable). */
  network_egress: boolean;
  isolation: IsolationModel;
  /** Cold-start latency to a ready sandbox, in milliseconds (representative). */
  startup_ms: number;
  /** Max wall-clock a single sandbox can run, in seconds. */
  max_session_seconds: number;
  /** Language/runtime SDKs the provider ships first-class. */
  sdk_languages: string[];
}

// ── Cost ────────────────────────────────────────────────────────────
// Modeled dimensionally so the recommender math works without asserting false
// precision. The representative `usd_per_sandbox_hour` is a single normalized
// rate for an apples-to-apples small sandbox (1 vCPU / 1–2 GB), carrying its own
// provenance + confidence. Operators replace it with a verified quote.

export interface CostModel {
  billing_unit: "per_second" | "per_minute" | "per_hour" | "subscription";
  /** Normalized representative hosted rate for a 1 vCPU / ~2GB sandbox. */
  usd_per_sandbox_hour: number;
  /** Free tier / monthly credit in USD, if any (0 when none). */
  free_tier_usd_per_month: number;
  provenance: Provenance;
}

// ── Operate-own (self-host the OSS) profile ─────────────────────────
// RF1's core question is integrate-vs-operate-own. A provider whose core is
// open-source can be self-hosted; this captures the cost/effort of doing so.

export interface SelfHostProfile {
  /** Can the core be self-hosted at all (is it open-source / on-prem)? */
  available: boolean;
  license?: string; // e.g. "Apache-2.0", "AGPL-3.0"
  /** One-time engineering effort to stand it up, in person-days (estimate). */
  setup_effort_person_days: number;
  /** Standing ops burden once running, in person-days per month (estimate). */
  ops_burden_person_days_per_month: number;
  /** Rough fixed infra cost to run the self-hosted control plane + a small
   *  pool, USD/month (estimate). */
  infra_usd_per_month: number;
  provenance: Provenance;
}

// ── A catalogued provider ───────────────────────────────────────────

export interface SandboxProvider {
  id: string; // stable key, e.g. "e2b"
  name: string; // display, e.g. "E2B"
  url: string;
  /** Is the provider's core open-source (and thus liftable per directive #77)? */
  open_source: boolean;
  license?: string;
  capabilities: SandboxCapabilities;
  hosted_cost: CostModel;
  self_host: SelfHostProfile;
  provenance: Provenance;
}

// ── Requirements the recommender scores against ─────────────────────

export interface SandboxRequirements {
  /** Minimum isolation the use-case demands (untrusted agent code → microvm). */
  min_isolation: IsolationModel;
  /** Hard requirement that the provider be self-hostable. */
  require_self_host: boolean;
  /** Longest session the workload needs, seconds. */
  needed_session_seconds: number;
  /** Languages the agents run; provider must cover all of them. */
  needed_languages: string[];
  /** Persistence and snapshots needed? */
  need_persistent_fs: boolean;
  need_snapshots: boolean;
  /** Expected steady-state concurrent sandboxes (drives integrate-vs-operate). */
  expected_concurrent_sandboxes: number;
  /** Expected total sandbox-hours per month (drives hosted cost). */
  expected_sandbox_hours_per_month: number;
  /** Relative weights (0..1). Defaulted by the recommender when omitted. */
  weights?: Partial<RequirementWeights>;
}

export interface RequirementWeights {
  capability_fit: number;
  isolation: number;
  startup_latency: number;
  cost: number;
}

// ── Recommender output ──────────────────────────────────────────────

export interface ProviderScore {
  provider_id: string;
  /** 0..1 overall; higher is better. */
  score: number;
  /** Per-axis 0..1 sub-scores, for transparency. */
  breakdown: {
    capability_fit: number;
    isolation: number;
    startup_latency: number;
    cost: number;
  };
  /** Hard gates this provider FAILED (e.g. "not_self_hostable"). A gated
   *  provider is still scored but flagged disqualified. */
  disqualifiers: string[];
  estimated_hosted_usd_per_month: number;
  rationale: string[];
}

export interface SandboxRecommendation {
  /** Ranked best→worst, disqualified providers sorted last. */
  ranking: ProviderScore[];
  /** The top eligible (non-disqualified) provider id, or null if all gated. */
  recommended_provider_id: string | null;
  /** The integrate-vs-operate-own call for the recommended provider. */
  integrate_vs_operate: IntegrateVsOperate | null;
  generated_at: string;
}

// ── Integrate-vs-operate-own ────────────────────────────────────────

export type IntegrateVsOperateVerdict =
  | "integrate_hosted" // use the vendor's hosted API
  | "operate_own" // self-host the OSS core
  | "too_close_to_call"; // within the margin — defer / pilot both

export interface IntegrateVsOperate {
  provider_id: string;
  verdict: IntegrateVsOperateVerdict;
  /** Fully-loaded monthly cost of the hosted path at expected volume. */
  hosted_usd_per_month: number;
  /** Fully-loaded monthly cost of self-hosting, amortizing setup over the
   *  horizon and pricing engineering time at `engineer_usd_per_day`. */
  operate_own_usd_per_month: number;
  /** Months over which one-time setup effort is amortized. */
  amortization_months: number;
  rationale: string[];
}

// ── The seam a real integration would implement (NOT implemented here) ──
// Documented so a future build has a typed target. This module ships no
// concrete provider — it is decision-support only.

export interface ExecSandboxHandle {
  id: string;
  provider_id: string;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface ExecSandboxProvider {
  readonly id: string;
  create(opts?: { template?: string; timeout_seconds?: number }): Promise<ExecSandboxHandle>;
  exec(handle: ExecSandboxHandle, command: string): Promise<ExecResult>;
  writeFile(handle: ExecSandboxHandle, path: string, contents: string): Promise<void>;
  kill(handle: ExecSandboxHandle): Promise<void>;
}
