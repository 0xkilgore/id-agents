// RF2 — model-gateway recommender (pure decision logic).
//
// Encodes the RF2 eval as testable code: score each catalogued gateway option
// against the routing requirements, gate the hard constraints, and — for the
// winner — compute the adopt-vs-extend-own call (adopt a gateway vs build the
// missing capabilities on our existing src/model-policy routing). No I/O,
// deterministic, so the tests pin the decision.

import type {
  AdoptVsExtend,
  AdoptVsExtendVerdict,
  GatewayCapabilities,
  GatewayRequirements,
  GatewayScore,
  ModelGatewayOption,
  GatewayRecommendation,
  RequirementWeights,
} from "./types.js";
import { DEFAULT_CATALOG, OWN_MODEL_POLICY } from "./catalog.js";

const DEFAULT_WEIGHTS: RequirementWeights = {
  capability_fit: 0.45,
  self_host_fit: 0.20,
  latency: 0.10,
  cost: 0.25,
};

export interface CostAssumptions {
  engineer_usd_per_day: number;
  amortization_months: number;
  decision_margin: number;
  /** Build effort to add ONE missing gateway capability to our own routing. */
  per_capability_build_days: number;
  /** Standing ops to run the extended own routing, person-days/month. */
  extend_own_ops_person_days_per_month: number;
  /** Fixed infra for the extended own routing, USD/month. */
  extend_own_infra_usd_per_month: number;
}

export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  engineer_usd_per_day: 800,
  amortization_months: 12,
  decision_margin: 0.15,
  per_capability_build_days: 8,
  extend_own_ops_person_days_per_month: 1,
  extend_own_infra_usd_per_month: 0,
};

const CAP_BY_REQUIREMENT: { flag: keyof GatewayRequirements; cap: keyof GatewayCapabilities; label: string }[] = [
  { flag: "need_provider_neutral_routing", cap: "provider_neutral_routing", label: "provider_neutral_routing" },
  { flag: "need_fallbacks_retries", cap: "fallbacks_retries", label: "fallbacks_retries" },
  { flag: "need_load_balancing", cap: "load_balancing", label: "load_balancing" },
  { flag: "need_guardrails", cap: "guardrails", label: "guardrails" },
  { flag: "need_semantic_caching", cap: "semantic_caching", label: "semantic_caching" },
  { flag: "need_observability", cap: "observability", label: "observability" },
  { flag: "need_virtual_keys_budgets", cap: "virtual_keys_budgets", label: "virtual_keys_budgets" },
];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function requiredCapabilities(req: GatewayRequirements): string[] {
  return CAP_BY_REQUIREMENT.filter((m) => req[m.flag] === true).map((m) => m.label);
}

function gapsFor(option: ModelGatewayOption, required: string[]): string[] {
  const have = new Set(CAP_BY_REQUIREMENT.filter((m) => option.capabilities[m.cap]).map((m) => m.label));
  return required.filter((r) => !have.has(r));
}

/** Fully-loaded monthly cost to ADOPT an option. */
export function adoptMonthlyUsd(
  o: ModelGatewayOption,
  req: GatewayRequirements,
  a: CostAssumptions,
): number {
  const selfHost = o.self_host.available
    ? o.self_host.infra_usd_per_month +
      o.self_host.ops_burden_person_days_per_month * a.engineer_usd_per_day +
      (o.self_host.setup_effort_person_days * a.engineer_usd_per_day) / Math.max(1, a.amortization_months)
    : Number.POSITIVE_INFINITY;
  if (req.require_self_host) return selfHost;
  return Math.min(o.hosted_cost.usd_per_month_hosted, selfHost);
}

/** Fully-loaded monthly cost to EXTEND our own routing to capability parity:
 *  build effort scales with how many required capabilities our own routing
 *  still lacks (amortized) + ops + infra. */
export function extendOwnMonthlyUsd(
  req: GatewayRequirements,
  a: CostAssumptions,
  own: ModelGatewayOption = OWN_MODEL_POLICY,
): number {
  const required = requiredCapabilities(req);
  const gaps = gapsFor(own, required);
  const setupDays = gaps.length * a.per_capability_build_days;
  return (
    a.extend_own_infra_usd_per_month +
    a.extend_own_ops_person_days_per_month * a.engineer_usd_per_day +
    (setupDays * a.engineer_usd_per_day) / Math.max(1, a.amortization_months)
  );
}

function gatesFor(o: ModelGatewayOption, req: GatewayRequirements): string[] {
  const d: string[] = [];
  if (req.require_self_host && !o.self_host.available) d.push("not_self_hostable");
  if (req.max_added_latency_ms > 0 && o.hosted_cost.added_latency_ms > req.max_added_latency_ms) d.push("latency_exceeded");
  for (const lang of req.needed_languages) {
    if (!o.capabilities.sdk_languages.includes(lang.toLowerCase())) d.push(`missing_language:${lang}`);
  }
  return d;
}

function scoreOption(
  o: ModelGatewayOption,
  req: GatewayRequirements,
  weights: RequirementWeights,
  required: string[],
  ctx: { minMonthly: number; maxMonthly: number; minLatency: number; maxLatency: number },
  a: CostAssumptions,
): GatewayScore {
  const gaps = gapsFor(o, required);
  const capability_fit = required.length === 0 ? 1 : (required.length - gaps.length) / required.length;
  const self_host_fit = req.require_self_host ? (o.self_host.available ? 1 : 0) : 1;

  const lat = o.hosted_cost.added_latency_ms;
  const latency =
    ctx.maxLatency === ctx.minLatency ? 1 : clamp01(1 - (lat - ctx.minLatency) / (ctx.maxLatency - ctx.minLatency));

  const monthly = adoptMonthlyUsd(o, req, a);
  const cost =
    ctx.maxMonthly === ctx.minMonthly
      ? 1
      : clamp01(1 - (Math.min(monthly, ctx.maxMonthly) - ctx.minMonthly) / (ctx.maxMonthly - ctx.minMonthly));

  const disqualifiers = gatesFor(o, req);
  const score =
    weights.capability_fit * capability_fit +
    weights.self_host_fit * self_host_fit +
    weights.latency * latency +
    weights.cost * cost;

  const rationale: string[] = [];
  rationale.push(`covers ${required.length - gaps.length}/${required.length} required caps`);
  if (o.open_source) rationale.push(`OSS (${o.license ?? "open"})`);
  else rationale.push("proprietary / hosted-only");
  rationale.push(`+${lat}ms, ~$${Number.isFinite(monthly) ? monthly.toFixed(0) : "∞"}/mo to adopt`);
  if (gaps.length) rationale.push(`gaps: ${gaps.join(", ")}`);
  if (disqualifiers.length) rationale.push(`DISQUALIFIED: ${disqualifiers.join(", ")}`);

  return {
    gateway_id: o.id,
    score,
    breakdown: { capability_fit, self_host_fit, latency, cost },
    disqualifiers,
    capability_gaps: gaps,
    estimated_monthly_usd: Number.isFinite(monthly) ? monthly : -1,
    rationale,
  };
}

export interface RecommendOptions {
  catalog?: ModelGatewayOption[];
  weights?: Partial<RequirementWeights>;
  costAssumptions?: Partial<CostAssumptions>;
  now?: () => Date;
}

export function recommendGateway(
  req: GatewayRequirements,
  opts: RecommendOptions = {},
): GatewayRecommendation {
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights, ...req.weights };
  const a = { ...DEFAULT_COST_ASSUMPTIONS, ...opts.costAssumptions };
  const now = opts.now ?? (() => new Date());
  const required = requiredCapabilities(req);

  const monthlies = catalog.map((o) => adoptMonthlyUsd(o, req, a)).filter((n) => Number.isFinite(n));
  const latencies = catalog.map((o) => o.hosted_cost.added_latency_ms);
  const ctx = {
    minMonthly: monthlies.length ? Math.min(...monthlies) : 0,
    maxMonthly: monthlies.length ? Math.max(...monthlies) : 0,
    minLatency: Math.min(...latencies),
    maxLatency: Math.max(...latencies),
  };

  const scored = catalog.map((o) => scoreOption(o, req, weights, required, ctx, a));
  const ranking = [...scored].sort((x, y) => {
    const xg = x.disqualifiers.length > 0;
    const yg = y.disqualifiers.length > 0;
    if (xg !== yg) return xg ? 1 : -1;
    if (y.score !== x.score) return y.score - x.score;
    return x.gateway_id.localeCompare(y.gateway_id);
  });

  // The "own" option is the extend-own baseline, not a gateway to "adopt".
  const topEligible = ranking.find((r) => r.disqualifiers.length === 0 && r.gateway_id !== OWN_MODEL_POLICY.id) ?? null;
  const recommended_gateway_id = topEligible?.gateway_id ?? null;

  const adopt_vs_extend = topEligible
    ? computeAdoptVsExtend(catalog.find((o) => o.id === topEligible.gateway_id)!, req, a)
    : null;

  return {
    ranking,
    recommended_gateway_id,
    adopt_vs_extend,
    generated_at: now().toISOString(),
  };
}

/** Adopt the gateway vs extend our own model-policy routing to parity,
 *  fully-loaded monthly, with a margin band → too_close_to_call. */
export function computeAdoptVsExtend(
  gateway: ModelGatewayOption,
  req: GatewayRequirements,
  a: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): AdoptVsExtend {
  const adopt = adoptMonthlyUsd(gateway, req, a);
  const extendOwn = extendOwnMonthlyUsd(req, a);
  const margin = a.decision_margin;
  const gateway_is_oss = gateway.open_source;

  let verdict: AdoptVsExtendVerdict;
  const rationale: string[] = [];
  if (adopt <= extendOwn * (1 - margin)) {
    verdict = "adopt_gateway";
    rationale.push(`Adopt ($${adopt.toFixed(0)}/mo) beats extend-own ($${extendOwn.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else if (extendOwn <= adopt * (1 - margin)) {
    verdict = "extend_own";
    rationale.push(`Extend-own ($${extendOwn.toFixed(0)}/mo) beats adopt ($${adopt.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else {
    verdict = "too_close_to_call";
    rationale.push(`Within ${(margin * 100).toFixed(0)}% (adopt $${adopt.toFixed(0)} vs extend-own $${extendOwn.toFixed(0)}/mo) — pilot the gateway behind the model-policy seam before committing.`);
  }
  rationale.push("Own routing already covers provider-neutral routing + fallback chains (src/model-policy); extend-own cost is only the missing gateway extras.");
  if (gateway_is_oss) {
    rationale.push(`${gateway.name} core is OSS (${gateway.license ?? "open"}) → adopt-and-self-host is license-clean per directive #77; not a lock-in bet.`);
  }
  rationale.push("Cost rows are estimates — re-verify provider pricing/terms before committing.");

  return {
    gateway_id: gateway.id,
    verdict,
    adopt_usd_per_month: adopt,
    extend_own_usd_per_month: extendOwn,
    amortization_months: a.amortization_months,
    gateway_is_oss,
    rationale,
  };
}
