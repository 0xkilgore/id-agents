// RF3 — observability-stack recommender (pure decision logic).
//
// Encodes the RF3 eval as testable code: score each catalogued component
// against the Observe/Audit tier's required capabilities, greedily assemble the
// minimal stack that covers them, and compute the adopt-vs-build call. No I/O,
// deterministic given inputs, so the tests pin the decision.

import type {
  AdoptVsBuild,
  AdoptVsBuildVerdict,
  ComponentScore,
  ObservabilityCapabilities,
  ObservabilityComponent,
  ObserveTierRequirements,
  RequirementWeights,
  StackRecommendation,
} from "./types.js";
import { DEFAULT_CATALOG } from "./catalog.js";

const DEFAULT_WEIGHTS: RequirementWeights = {
  capability_coverage: 0.45,
  self_host_fit: 0.20,
  otel_fit: 0.10,
  cost: 0.25,
};

export interface CostAssumptions {
  engineer_usd_per_day: number;
  amortization_months: number;
  decision_margin: number;
  /** One-time effort to BUILD the equivalent Observe/Audit tier from open
   *  primitives (OTel + our own cost/eval/audit/prompt-mgmt semantics). */
  build_own_setup_person_days: number;
  /** Standing ops to run a self-built tier, person-days/month. */
  build_own_ops_person_days_per_month: number;
  /** Fixed infra to run a self-built tier, USD/month. */
  build_own_infra_usd_per_month: number;
}

export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  engineer_usd_per_day: 800,
  amortization_months: 12,
  decision_margin: 0.15,
  build_own_setup_person_days: 40,
  build_own_ops_person_days_per_month: 3,
  build_own_infra_usd_per_month: 200,
};

const CAP_BY_REQUIREMENT: { flag: keyof ObserveTierRequirements; cap: keyof ObservabilityCapabilities; label: string }[] = [
  { flag: "need_runtime_tracing", cap: "runtime_tracing", label: "runtime_tracing" },
  { flag: "need_eval_harness", cap: "eval_harness", label: "eval_harness" },
  { flag: "need_prompt_management", cap: "prompt_management", label: "prompt_management" },
  { flag: "need_cost_tracking", cap: "cost_tracking", label: "cost_tracking" },
  { flag: "need_audit_log", cap: "audit_log", label: "audit_log" },
  { flag: "need_datasets", cap: "datasets", label: "datasets" },
];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** The capability labels the tier requires, derived from the need_* flags. */
export function requiredCapabilities(req: ObserveTierRequirements): string[] {
  return CAP_BY_REQUIREMENT.filter((m) => req[m.flag] === true).map((m) => m.label);
}

function componentCaps(c: ObservabilityComponent): Set<string> {
  return new Set(CAP_BY_REQUIREMENT.filter((m) => c.capabilities[m.cap]).map((m) => m.label));
}

/** Fully-loaded monthly cost to ADOPT a component: when self-host is required,
 *  the self-host cost; otherwise the cheaper of hosted vs fully-loaded
 *  self-host. */
export function adoptMonthlyUsd(
  c: ObservabilityComponent,
  req: ObserveTierRequirements,
  a: CostAssumptions,
): number {
  const selfHost = c.self_host.available
    ? c.self_host.infra_usd_per_month +
      c.self_host.ops_burden_person_days_per_month * a.engineer_usd_per_day +
      (c.self_host.setup_effort_person_days * a.engineer_usd_per_day) / Math.max(1, a.amortization_months)
    : Number.POSITIVE_INFINITY;
  if (req.require_self_host) return selfHost;
  return Math.min(c.hosted_cost.usd_per_month_hosted, selfHost);
}

/** Fully-loaded monthly cost to BUILD the equivalent tier ourselves. */
export function buildOwnMonthlyUsd(a: CostAssumptions): number {
  return (
    a.build_own_infra_usd_per_month +
    a.build_own_ops_person_days_per_month * a.engineer_usd_per_day +
    (a.build_own_setup_person_days * a.engineer_usd_per_day) / Math.max(1, a.amortization_months)
  );
}

function scoreComponent(
  c: ObservabilityComponent,
  req: ObserveTierRequirements,
  weights: RequirementWeights,
  required: string[],
  costCtx: { minAdopt: number; maxAdopt: number },
  a: CostAssumptions,
): ComponentScore {
  const caps = componentCaps(c);
  const covered = required.filter((r) => caps.has(r));
  const gaps = required.filter((r) => !caps.has(r));
  const capability_coverage = required.length === 0 ? 1 : covered.length / required.length;

  const self_host_fit = req.require_self_host ? (c.self_host.available ? 1 : 0) : 1;
  const otel_fit = req.prefer_otel ? (c.capabilities.otel_compatible ? 1 : 0.5) : 1;

  const adopt = adoptMonthlyUsd(c, req, a);
  const cost =
    costCtx.maxAdopt === costCtx.minAdopt
      ? 1
      : clamp01(1 - (Math.min(adopt, costCtx.maxAdopt) - costCtx.minAdopt) / (costCtx.maxAdopt - costCtx.minAdopt));

  const score =
    weights.capability_coverage * capability_coverage +
    weights.self_host_fit * self_host_fit +
    weights.otel_fit * otel_fit +
    weights.cost * cost;

  const rationale: string[] = [];
  rationale.push(`covers ${covered.length}/${required.length} required caps`);
  if (c.open_source) rationale.push(`OSS (${c.license ?? "open"})`);
  if (req.prefer_otel) rationale.push(c.capabilities.otel_compatible ? "OTel-compatible" : "not OTel-native");
  rationale.push(`~$${Number.isFinite(adopt) ? adopt.toFixed(0) : "∞"}/mo to adopt`);

  return {
    component_id: c.id,
    score,
    breakdown: { capability_coverage, self_host_fit, otel_fit, cost },
    gaps,
    estimated_hosted_usd_per_month: Number.isFinite(adopt) ? adopt : -1,
    rationale,
  };
}

export interface RecommendOptions {
  catalog?: ObservabilityComponent[];
  weights?: Partial<RequirementWeights>;
  costAssumptions?: Partial<CostAssumptions>;
  now?: () => Date;
}

export function recommendStack(
  req: ObserveTierRequirements,
  opts: RecommendOptions = {},
): StackRecommendation {
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights, ...req.weights };
  const a = { ...DEFAULT_COST_ASSUMPTIONS, ...opts.costAssumptions };
  const now = opts.now ?? (() => new Date());
  const required = requiredCapabilities(req);

  const adopts = catalog.map((c) => adoptMonthlyUsd(c, req, a)).filter((n) => Number.isFinite(n));
  const costCtx = { minAdopt: adopts.length ? Math.min(...adopts) : 0, maxAdopt: adopts.length ? Math.max(...adopts) : 0 };

  const scored = catalog.map((c) => scoreComponent(c, req, weights, required, costCtx, a));
  const ranking = [...scored].sort((x, y) => (y.score !== x.score ? y.score - x.score : x.component_id.localeCompare(y.component_id)));

  // Greedy minimal cover: repeatedly take the eligible component that covers the
  // most still-uncovered required caps (tie-break: higher score). Respect
  // require_self_host (skip components that can't self-host when required).
  const eligible = catalog.filter((c) => (req.require_self_host ? c.self_host.available : true));
  const scoreById = new Map(scored.map((s) => [s.component_id, s.score]));
  const uncovered = new Set(required);
  const stack: string[] = [];
  while (uncovered.size > 0) {
    let best: ObservabilityComponent | null = null;
    let bestGain = 0;
    let bestScore = -1;
    for (const c of eligible) {
      if (stack.includes(c.id)) continue;
      const caps = componentCaps(c);
      const gain = [...uncovered].filter((r) => caps.has(r)).length;
      const s = scoreById.get(c.id) ?? 0;
      if (gain > bestGain || (gain === bestGain && gain > 0 && s > bestScore)) {
        best = c;
        bestGain = gain;
        bestScore = s;
      }
    }
    if (!best || bestGain === 0) break; // nothing further can cover the rest
    stack.push(best.id);
    for (const r of componentCaps(best)) uncovered.delete(r);
  }

  const recommended_stack = stack.length > 0 ? stack : required.length === 0 ? [] : null;
  const uncovered_requirements = [...uncovered];

  const adopt_vs_build =
    recommended_stack && recommended_stack.length > 0
      ? computeAdoptVsBuild(recommended_stack, catalog, req, a)
      : null;

  return {
    ranking,
    recommended_stack,
    uncovered_requirements,
    adopt_vs_build,
    generated_at: now().toISOString(),
  };
}

/** Adopt-and-extend (use Promptfoo/Langfuse) vs build-own (from primitives),
 *  fully-loaded monthly, with a margin band → too_close_to_call. */
export function computeAdoptVsBuild(
  stack: string[],
  catalog: ObservabilityComponent[],
  req: ObserveTierRequirements,
  a: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): AdoptVsBuild {
  const components = stack.map((id) => catalog.find((c) => c.id === id)).filter((c): c is ObservabilityComponent => !!c);
  const adopt = components.reduce((sum, c) => sum + adoptMonthlyUsd(c, req, a), 0);
  const buildOwn = buildOwnMonthlyUsd(a);
  const margin = a.decision_margin;
  const stack_is_oss = components.every((c) => c.open_source);

  let verdict: AdoptVsBuildVerdict;
  const rationale: string[] = [];
  if (adopt <= buildOwn * (1 - margin)) {
    verdict = "adopt_and_extend";
    rationale.push(`Adopt ($${adopt.toFixed(0)}/mo) beats build-own ($${buildOwn.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else if (buildOwn <= adopt * (1 - margin)) {
    verdict = "build_own";
    rationale.push(`Build-own ($${buildOwn.toFixed(0)}/mo) beats adopt ($${adopt.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else {
    verdict = "too_close_to_call";
    rationale.push(`Within ${(margin * 100).toFixed(0)}% (adopt $${adopt.toFixed(0)} vs build-own $${buildOwn.toFixed(0)}/mo) — pilot adoption before committing to build.`);
  }
  if (stack_is_oss) {
    rationale.push(`Stack is fully OSS (${components.map((c) => c.license ?? "open").join(", ")}) → adopt-and-extend is license-clean per directive #77; not a lock-in bet.`);
  }
  rationale.push("Cost rows are estimates — re-verify provider pricing/terms before committing.");

  return {
    stack,
    verdict,
    adopt_usd_per_month: adopt,
    build_own_usd_per_month: buildOwn,
    amortization_months: a.amortization_months,
    stack_is_oss,
    rationale,
  };
}
