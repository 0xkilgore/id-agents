// RF1 — exec-sandbox recommender (pure decision logic).
//
// Encodes the RF1 eval as testable code: score each catalogued provider against
// typed requirements, apply hard gates, and — for the winner — compute the
// integrate-vs-operate-own call. No I/O, no clock except an injectable `now`;
// deterministic given its inputs so the tests pin the decision math.

import type {
  IntegrateVsOperate,
  IntegrateVsOperateVerdict,
  IsolationModel,
  ProviderScore,
  RequirementWeights,
  SandboxProvider,
  SandboxRecommendation,
  SandboxRequirements,
} from "./types.js";
import { DEFAULT_CATALOG } from "./catalog.js";

const ISOLATION_RANK: Record<IsolationModel, number> = { process: 1, container: 2, microvm: 3 };

const DEFAULT_WEIGHTS: RequirementWeights = {
  capability_fit: 0.35,
  isolation: 0.30,
  startup_latency: 0.10,
  cost: 0.25,
};

/** Cost assumptions for the integrate-vs-operate math. Overridable. */
export interface CostAssumptions {
  /** Fully-loaded cost of an engineer-day, USD. */
  engineer_usd_per_day: number;
  /** Months to amortize one-time self-host setup over. */
  amortization_months: number;
  /** Relative margin (0..1) within which hosted vs operate-own is "too close". */
  decision_margin: number;
}

export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  engineer_usd_per_day: 800,
  amortization_months: 12,
  decision_margin: 0.15,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Estimated monthly hosted spend at the requirement's expected volume, net of
 *  any free tier (floored at 0). */
export function estimateHostedMonthlyUsd(
  provider: SandboxProvider,
  req: SandboxRequirements,
): number {
  const gross = provider.hosted_cost.usd_per_sandbox_hour * req.expected_sandbox_hours_per_month;
  return Math.max(0, gross - provider.hosted_cost.free_tier_usd_per_month);
}

/** Fully-loaded monthly cost of self-hosting the OSS core at expected volume:
 *  fixed infra + standing ops time + amortized one-time setup. Returns
 *  Infinity when the provider cannot be self-hosted (so it never "wins"
 *  operate-own). */
export function estimateOperateOwnMonthlyUsd(
  provider: SandboxProvider,
  assumptions: CostAssumptions,
): number {
  const sh = provider.self_host;
  if (!sh.available) return Number.POSITIVE_INFINITY;
  const ops = sh.ops_burden_person_days_per_month * assumptions.engineer_usd_per_day;
  const setupAmortized =
    (sh.setup_effort_person_days * assumptions.engineer_usd_per_day) / Math.max(1, assumptions.amortization_months);
  return sh.infra_usd_per_month + ops + setupAmortized;
}

function gatesFor(provider: SandboxProvider, req: SandboxRequirements): string[] {
  const d: string[] = [];
  const cap = provider.capabilities;
  if (ISOLATION_RANK[cap.isolation] < ISOLATION_RANK[req.min_isolation]) d.push("insufficient_isolation");
  if (req.require_self_host && !provider.self_host.available) d.push("not_self_hostable");
  if (cap.max_session_seconds < req.needed_session_seconds) d.push("session_too_short");
  if (req.need_persistent_fs && !cap.persistent_fs) d.push("no_persistent_fs");
  if (req.need_snapshots && !cap.snapshots) d.push("no_snapshots");
  for (const lang of req.needed_languages) {
    if (!cap.sdk_languages.includes(lang.toLowerCase())) d.push(`missing_language:${lang}`);
  }
  return d;
}

function scoreProvider(
  provider: SandboxProvider,
  req: SandboxRequirements,
  weights: RequirementWeights,
  costCtx: { minMonthly: number; maxMonthly: number; minStartup: number; maxStartup: number },
): ProviderScore {
  const cap = provider.capabilities;
  const disqualifiers = gatesFor(provider, req);

  // capability_fit: fraction of the soft capability asks the provider satisfies.
  const wants: boolean[] = [
    !req.need_persistent_fs || cap.persistent_fs,
    !req.need_snapshots || cap.snapshots,
    cap.max_session_seconds >= req.needed_session_seconds,
    req.needed_languages.every((l) => cap.sdk_languages.includes(l.toLowerCase())),
  ];
  const capability_fit = wants.filter(Boolean).length / wants.length;

  // isolation: meeting the floor scores 1; exceeding it keeps 1; below scales down.
  const isolation = clamp01(ISOLATION_RANK[cap.isolation] / ISOLATION_RANK[req.min_isolation]);

  // startup_latency: lower is better, normalized across the catalog.
  const startup_latency =
    costCtx.maxStartup === costCtx.minStartup
      ? 1
      : clamp01(1 - (cap.startup_ms - costCtx.minStartup) / (costCtx.maxStartup - costCtx.minStartup));

  // cost: lower estimated monthly is better, normalized across the catalog.
  const monthly = estimateHostedMonthlyUsd(provider, req);
  const cost =
    costCtx.maxMonthly === costCtx.minMonthly
      ? 1
      : clamp01(1 - (monthly - costCtx.minMonthly) / (costCtx.maxMonthly - costCtx.minMonthly));

  const score =
    weights.capability_fit * capability_fit +
    weights.isolation * isolation +
    weights.startup_latency * startup_latency +
    weights.cost * cost;

  const rationale: string[] = [];
  rationale.push(`${cap.isolation} isolation (floor: ${req.min_isolation})`);
  rationale.push(`~$${monthly.toFixed(0)}/mo hosted at ${req.expected_sandbox_hours_per_month} sandbox-hrs`);
  if (provider.open_source) rationale.push(`OSS (${provider.license ?? "open"}) → self-host option`);
  if (disqualifiers.length) rationale.push(`DISQUALIFIED: ${disqualifiers.join(", ")}`);

  return {
    provider_id: provider.id,
    score,
    breakdown: { capability_fit, isolation, startup_latency, cost },
    disqualifiers,
    estimated_hosted_usd_per_month: monthly,
    rationale,
  };
}

export interface RecommendOptions {
  catalog?: SandboxProvider[];
  weights?: Partial<RequirementWeights>;
  costAssumptions?: Partial<CostAssumptions>;
  now?: () => Date;
}

export function recommendProvider(
  req: SandboxRequirements,
  opts: RecommendOptions = {},
): SandboxRecommendation {
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights, ...req.weights };
  const assumptions = { ...DEFAULT_COST_ASSUMPTIONS, ...opts.costAssumptions };
  const now = opts.now ?? (() => new Date());

  // Normalization context across the catalog.
  const monthlies = catalog.map((p) => estimateHostedMonthlyUsd(p, req));
  const startups = catalog.map((p) => p.capabilities.startup_ms);
  const costCtx = {
    minMonthly: Math.min(...monthlies),
    maxMonthly: Math.max(...monthlies),
    minStartup: Math.min(...startups),
    maxStartup: Math.max(...startups),
  };

  const scored = catalog.map((p) => scoreProvider(p, req, weights, costCtx));

  // Rank: eligible (no disqualifiers) before gated; within each, higher score
  // first; deterministic tie-break by provider_id.
  const ranking = [...scored].sort((a, b) => {
    const aGated = a.disqualifiers.length > 0;
    const bGated = b.disqualifiers.length > 0;
    if (aGated !== bGated) return aGated ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.provider_id.localeCompare(b.provider_id);
  });

  const topEligible = ranking.find((r) => r.disqualifiers.length === 0) ?? null;
  const recommended_provider_id = topEligible?.provider_id ?? null;

  const integrate_vs_operate = topEligible
    ? compareIntegrateVsOperate(
        catalog.find((p) => p.id === topEligible.provider_id)!,
        req,
        assumptions,
      )
    : null;

  return {
    ranking,
    recommended_provider_id,
    integrate_vs_operate,
    generated_at: now().toISOString(),
  };
}

/** The integrate-vs-operate-own call for one provider: compare fully-loaded
 *  hosted spend against fully-loaded self-host cost at the expected volume,
 *  with a margin band that yields "too_close_to_call" → pilot both. */
export function compareIntegrateVsOperate(
  provider: SandboxProvider,
  req: SandboxRequirements,
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): IntegrateVsOperate {
  const hosted = estimateHostedMonthlyUsd(provider, req);
  const operateOwn = estimateOperateOwnMonthlyUsd(provider, assumptions);
  const margin = assumptions.decision_margin;

  let verdict: IntegrateVsOperateVerdict;
  const rationale: string[] = [];
  if (!provider.self_host.available) {
    verdict = "integrate_hosted";
    rationale.push("No self-host option — hosted is the only path.");
  } else if (hosted <= operateOwn * (1 - margin)) {
    verdict = "integrate_hosted";
    rationale.push(`Hosted ($${hosted.toFixed(0)}/mo) beats operate-own ($${operateOwn.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else if (operateOwn <= hosted * (1 - margin)) {
    verdict = "operate_own";
    rationale.push(`Operate-own ($${operateOwn.toFixed(0)}/mo) beats hosted ($${hosted.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else {
    verdict = "too_close_to_call";
    rationale.push(`Within ${(margin * 100).toFixed(0)}% (hosted $${hosted.toFixed(0)} vs operate-own $${operateOwn.toFixed(0)}/mo) — pilot both before committing.`);
  }
  if (provider.open_source) {
    rationale.push(`Provider core is OSS (${provider.license ?? "open"}); operate-own is a real, license-clean option (directive #77).`);
  }
  rationale.push("Cost rows are estimates — re-verify provider pricing before any spend commitment.");

  return {
    provider_id: provider.id,
    verdict,
    hosted_usd_per_month: hosted,
    operate_own_usd_per_month: Number.isFinite(operateOwn) ? operateOwn : -1,
    amortization_months: assumptions.amortization_months,
    rationale,
  };
}
