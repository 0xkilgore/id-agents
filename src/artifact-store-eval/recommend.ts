// OSS-lift eval — artifact-store recommender (pure decision logic).
//
// Encodes the paperless-ngx-vs-own-doc-model eval as testable code: score each
// option against the lane's requirements, gate hard constraints (in-process,
// agent-artifact-fit, language, self-host, OCR), and compute the adopt-vs-extend
// call. No I/O, deterministic, so the tests pin the decision.

import type {
  AdoptVsExtend,
  AdoptVsExtendVerdict,
  ArtifactStoreCapabilities,
  ArtifactStoreOption,
  ArtifactStoreRecommendation,
  ArtifactStoreRequirements,
  RequirementWeights,
  StoreScore,
} from "./types.js";
import { DEFAULT_CATALOG, OWN_DOC_MODEL } from "./catalog.js";

const DEFAULT_WEIGHTS: RequirementWeights = {
  capability_fit: 0.35,
  purpose_fit: 0.30,
  integration_fit: 0.20,
  cost: 0.15,
};

export interface CostAssumptions {
  engineer_usd_per_day: number;
  amortization_months: number;
  decision_margin: number;
  /** Build effort to add ONE missing required capability to our own substrate. */
  per_capability_build_days: number;
  extend_own_ops_person_days_per_month: number;
  extend_own_infra_usd_per_month: number;
}

export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  engineer_usd_per_day: 800,
  amortization_months: 12,
  decision_margin: 0.15,
  per_capability_build_days: 10,
  extend_own_ops_person_days_per_month: 0,
  extend_own_infra_usd_per_month: 0,
};

const CAP_BY_REQUIREMENT: { flag: keyof ArtifactStoreRequirements; cap: keyof ArtifactStoreCapabilities; label: string }[] = [
  { flag: "need_full_text_search", cap: "full_text_search", label: "full_text_search" },
  { flag: "need_structured_metadata", cap: "structured_metadata", label: "structured_metadata" },
  { flag: "need_ingestion_pipeline", cap: "ingestion_pipeline", label: "ingestion_pipeline" },
  { flag: "need_versioning_audit", cap: "versioning_audit", label: "versioning_audit" },
  { flag: "need_rest_api", cap: "rest_api", label: "rest_api" },
  { flag: "need_ocr", cap: "ocr", label: "ocr" },
];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function requiredCapabilities(req: ArtifactStoreRequirements): string[] {
  return CAP_BY_REQUIREMENT.filter((m) => req[m.flag] === true).map((m) => m.label);
}

function gapsFor(o: ArtifactStoreOption, required: string[]): string[] {
  const have = new Set(CAP_BY_REQUIREMENT.filter((m) => o.capabilities[m.cap]).map((m) => m.label));
  return required.filter((r) => !have.has(r));
}

/** Fully-loaded monthly cost to ADOPT an option. For a self-host-only OSS tool
 *  (hosted_available=false) this is always the self-host cost — its $0 "hosted"
 *  price is non-existent, not free-to-run. */
export function adoptMonthlyUsd(
  o: ArtifactStoreOption,
  req: ArtifactStoreRequirements,
  a: CostAssumptions,
): number {
  const selfHost = o.self_host.available
    ? o.self_host.infra_usd_per_month +
      o.self_host.ops_burden_person_days_per_month * a.engineer_usd_per_day +
      (o.self_host.setup_effort_person_days * a.engineer_usd_per_day) / Math.max(1, a.amortization_months)
    : Number.POSITIVE_INFINITY;
  if (req.require_self_host || !o.hosted_cost.hosted_available) return selfHost;
  return Math.min(o.hosted_cost.usd_per_month_hosted, selfHost);
}

/** Fully-loaded monthly cost to EXTEND our own substrate to cover the required
 *  capabilities it still lacks. */
export function extendOwnMonthlyUsd(
  req: ArtifactStoreRequirements,
  a: CostAssumptions,
  own: ArtifactStoreOption = OWN_DOC_MODEL,
): number {
  const gaps = gapsFor(own, requiredCapabilities(req));
  const setupDays = gaps.length * a.per_capability_build_days;
  return (
    a.extend_own_infra_usd_per_month +
    a.extend_own_ops_person_days_per_month * a.engineer_usd_per_day +
    (setupDays * a.engineer_usd_per_day) / Math.max(1, a.amortization_months)
  );
}

function gatesFor(o: ArtifactStoreOption, req: ArtifactStoreRequirements): string[] {
  const d: string[] = [];
  if (req.require_self_host && !o.self_host.available) d.push("not_self_hostable");
  if (req.require_in_process && !o.capabilities.in_process) d.push("not_in_process");
  if (req.require_agent_artifact_fit && !o.capabilities.agent_artifact_fit) d.push("wrong_purpose");
  if (req.need_ocr && !o.capabilities.ocr) d.push("no_ocr");
  for (const lang of req.needed_languages) {
    if (!o.capabilities.sdk_languages.includes(lang.toLowerCase())) d.push(`missing_language:${lang}`);
  }
  return d;
}

function scoreOption(
  o: ArtifactStoreOption,
  req: ArtifactStoreRequirements,
  weights: RequirementWeights,
  required: string[],
  ctx: { minMonthly: number; maxMonthly: number },
  a: CostAssumptions,
): StoreScore {
  const gaps = gapsFor(o, required);
  const capability_fit = required.length === 0 ? 1 : (required.length - gaps.length) / required.length;
  const purpose_fit = o.capabilities.agent_artifact_fit ? 1 : 0;
  const integration_fit = o.capabilities.in_process ? 1 : 0.3;

  const monthly = adoptMonthlyUsd(o, req, a);
  const cost =
    ctx.maxMonthly === ctx.minMonthly
      ? 1
      : clamp01(1 - (Math.min(monthly, ctx.maxMonthly) - ctx.minMonthly) / (ctx.maxMonthly - ctx.minMonthly));

  const disqualifiers = gatesFor(o, req);
  const score =
    weights.capability_fit * capability_fit +
    weights.purpose_fit * purpose_fit +
    weights.integration_fit * integration_fit +
    weights.cost * cost;

  const rationale: string[] = [];
  rationale.push(`covers ${required.length - gaps.length}/${required.length} required caps`);
  rationale.push(o.capabilities.agent_artifact_fit ? "purpose-fit for agent artifacts" : "built for a different artifact type");
  rationale.push(o.capabilities.in_process ? "in-process" : "separate service + second data model");
  if (o.open_source) rationale.push(`OSS (${o.license ?? "open"})`);
  rationale.push(`~$${Number.isFinite(monthly) ? monthly.toFixed(0) : "∞"}/mo to adopt`);
  if (gaps.length) rationale.push(`gaps: ${gaps.join(", ")}`);
  if (disqualifiers.length) rationale.push(`DISQUALIFIED: ${disqualifiers.join(", ")}`);

  return {
    store_id: o.id,
    score,
    breakdown: { capability_fit, purpose_fit, integration_fit, cost },
    disqualifiers,
    capability_gaps: gaps,
    estimated_monthly_usd: Number.isFinite(monthly) ? monthly : -1,
    rationale,
  };
}

export interface RecommendOptions {
  catalog?: ArtifactStoreOption[];
  weights?: Partial<RequirementWeights>;
  costAssumptions?: Partial<CostAssumptions>;
  now?: () => Date;
}

export function recommendArtifactStore(
  req: ArtifactStoreRequirements,
  opts: RecommendOptions = {},
): ArtifactStoreRecommendation {
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights, ...req.weights };
  const a = { ...DEFAULT_COST_ASSUMPTIONS, ...opts.costAssumptions };
  const now = opts.now ?? (() => new Date());
  const required = requiredCapabilities(req);

  const monthlies = catalog.map((o) => adoptMonthlyUsd(o, req, a)).filter((n) => Number.isFinite(n));
  const ctx = { minMonthly: monthlies.length ? Math.min(...monthlies) : 0, maxMonthly: monthlies.length ? Math.max(...monthlies) : 0 };

  const scored = catalog.map((o) => scoreOption(o, req, weights, required, ctx, a));
  const ranking = [...scored].sort((x, y) => {
    const xg = x.disqualifiers.length > 0;
    const yg = y.disqualifiers.length > 0;
    if (xg !== yg) return xg ? 1 : -1;
    if (y.score !== x.score) return y.score - x.score;
    return x.store_id.localeCompare(y.store_id);
  });

  // Unlike the gateway eval, "extend own" IS a legitimate winner here — the own
  // substrate is an eligible recommendation, not just a baseline.
  const topEligible = ranking.find((r) => r.disqualifiers.length === 0) ?? null;
  const recommended_store_id = topEligible?.store_id ?? null;

  // The adopt-vs-extend call compares the adopt CANDIDATE against extend-own,
  // regardless of which won the ranking — that is the question the eval asks.
  const adoptCandidate = catalog.find((o) => o.kind === "adopt") ?? null;
  const adopt_vs_extend = adoptCandidate ? computeAdoptVsExtend(adoptCandidate, req, a) : null;

  return {
    ranking,
    recommended_store_id,
    adopt_vs_extend,
    generated_at: now().toISOString(),
  };
}

/** Adopt the candidate (paperless-ngx) vs extend our own substrate, fully-loaded
 *  monthly, with a margin band → too_close_to_call. */
export function computeAdoptVsExtend(
  candidate: ArtifactStoreOption,
  req: ArtifactStoreRequirements,
  a: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): AdoptVsExtend {
  const adopt = adoptMonthlyUsd(candidate, req, a);
  const extendOwn = extendOwnMonthlyUsd(req, a);
  const margin = a.decision_margin;
  const adopt_is_oss = candidate.open_source;

  // A hard fit failure (wrong purpose / not in-process / missing language)
  // means adopt is not viable regardless of cost — extend-own wins outright.
  const fitGates = gatesFor(candidate, req);
  let verdict: AdoptVsExtendVerdict;
  const rationale: string[] = [];
  if (fitGates.length > 0) {
    verdict = "extend_own";
    rationale.push(`${candidate.name} fails hard fit gates (${fitGates.join(", ")}) — not viable to adopt regardless of cost.`);
  } else if (adopt <= extendOwn * (1 - margin)) {
    verdict = "adopt";
    rationale.push(`Adopt ($${adopt.toFixed(0)}/mo) beats extend-own ($${extendOwn.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else if (extendOwn <= adopt * (1 - margin)) {
    verdict = "extend_own";
    rationale.push(`Extend-own ($${extendOwn.toFixed(0)}/mo) beats adopt ($${adopt.toFixed(0)}/mo) by >${(margin * 100).toFixed(0)}%.`);
  } else {
    verdict = "too_close_to_call";
    rationale.push(`Within ${(margin * 100).toFixed(0)}% (adopt $${adopt.toFixed(0)} vs extend-own $${extendOwn.toFixed(0)}/mo) — pilot before committing.`);
  }
  rationale.push("Own substrate already covers the lane in-process + purpose-built for agent artifacts (DV2/DV3/DV7); extend-own cost is only any missing capability.");
  if (adopt_is_oss) {
    rationale.push(`${candidate.name} is OSS (${candidate.license ?? "open"}) → liftable per directive #77; license is not the blocker, fit + integration cost is.`);
  }
  rationale.push("Cost rows are estimates — re-verify before committing.");

  return {
    adopt_candidate_id: candidate.id,
    verdict,
    adopt_usd_per_month: Number.isFinite(adopt) ? adopt : -1,
    extend_own_usd_per_month: extendOwn,
    amortization_months: a.amortization_months,
    adopt_is_oss,
    rationale,
  };
}
