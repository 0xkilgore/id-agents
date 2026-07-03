// T-RELIABILITY — model-effectiveness read-model (§2, the decision surface).
//
// GET /usage/effectiveness?group_by=model|task_class|agent → per-group quality-vs-
// cost so Chris can decide Sonnet-4.6-vs-Opus-4.8 PER TASK-CLASS on evidence, never
// a blind cost-downgrade. Pure over the §1 per-dispatch effectiveness rows.
//
// HONESTY (spec): a quality score built on `unknown` outcomes is labeled
// low-confidence, never presented as fact — outcome coverage + a source block are
// carried alongside the composite so a thin sample can't masquerade as a verdict.

export type CostSource = "metered" | "inferred" | "unknown";
export type OutcomeSource = "verified" | "partial" | "unknown";
export type EffectivenessGroupBy = "model" | "task_class" | "agent";

/** The §1 per-dispatch effectiveness record (the subset this read-model consumes). */
export interface DispatchEffectivenessRow {
  model: string;
  task_class: string;
  agent: string;
  usd_cost: number | null;
  latency_ms: number;
  reruns: number;
  cost_source: CostSource;
  verified_promotion: boolean | null;
  artifact_accepted: boolean | null;
  requested_changes: number;
  failed: boolean;
  outcome_source: OutcomeSource;
}

/** The transparent quality components (shown, not just the composite). */
export interface EffectivenessQuality {
  promotion_rate: number;
  acceptance_rate: number;
  no_rerun_rate: number;
  success_rate: number;
  no_requested_changes_rate: number;
  /** Equal-weight mean of the five components. Chris re-weights; the parts are shown. */
  composite: number;
}

export interface EffectivenessCost {
  mean_usd_cost: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
}

export interface EffectivenessGroup {
  key: string;
  count: number;
  quality: EffectivenessQuality;
  cost: EffectivenessCost;
  /** Trust in the quality number, from verified-outcome coverage. */
  confidence: "high" | "medium" | "low";
  outcome_coverage: Record<OutcomeSource, number>;
  cost_source_mix: Record<CostSource, number>;
}

export interface UsageEffectivenessReadModel {
  schema_version: "usage.effectiveness.v1";
  generated_at: string;
  group_by: EffectivenessGroupBy;
  groups: EffectivenessGroup[];
  total_dispatches: number;
  sources: {
    /** available = all rows verified; partial = some; unavailable = none. */
    outcome_quality: "available" | "partial" | "unavailable";
    notes: string[];
  };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function keyOf(row: DispatchEffectivenessRow, by: EffectivenessGroupBy): string {
  return by === "model" ? row.model : by === "task_class" ? row.task_class : row.agent;
}

function buildGroup(key: string, rows: DispatchEffectivenessRow[]): EffectivenessGroup {
  const n = rows.length;
  const rate = (pred: (r: DispatchEffectivenessRow) => boolean) => round(rows.filter(pred).length / n);

  const quality: EffectivenessQuality = {
    promotion_rate: rate((r) => r.verified_promotion === true),
    acceptance_rate: rate((r) => r.artifact_accepted === true),
    no_rerun_rate: rate((r) => r.reruns === 0),
    success_rate: rate((r) => !r.failed),
    no_requested_changes_rate: rate((r) => r.requested_changes === 0),
    composite: 0,
  };
  quality.composite = round(
    (quality.promotion_rate +
      quality.acceptance_rate +
      quality.no_rerun_rate +
      quality.success_rate +
      quality.no_requested_changes_rate) /
      5,
  );

  const costs = rows.map((r) => r.usd_cost).filter((c): c is number => c != null);
  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const cost: EffectivenessCost = {
    mean_usd_cost: costs.length ? round(costs.reduce((s, c) => s + c, 0) / costs.length, 6) : null,
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
  };

  const outcome_coverage: Record<OutcomeSource, number> = { verified: 0, partial: 0, unknown: 0 };
  const cost_source_mix: Record<CostSource, number> = { metered: 0, inferred: 0, unknown: 0 };
  for (const r of rows) {
    outcome_coverage[r.outcome_source] += 1;
    cost_source_mix[r.cost_source] += 1;
  }

  const verifiedShare = outcome_coverage.verified / n;
  const confidence = verifiedShare >= 0.6 ? "high" : verifiedShare >= 0.2 ? "medium" : "low";

  return { key, count: n, quality, cost, confidence, outcome_coverage, cost_source_mix };
}

/**
 * Build the effectiveness read-model grouped by model / task_class / agent. Pure;
 * `now` injected. Groups are sorted by count desc, then key.
 */
export function buildUsageEffectiveness(
  rows: DispatchEffectivenessRow[],
  group_by: EffectivenessGroupBy,
  nowIso: string,
): UsageEffectivenessReadModel {
  const byKey = new Map<string, DispatchEffectivenessRow[]>();
  for (const row of rows) {
    const k = keyOf(row, group_by);
    const list = byKey.get(k);
    if (list) list.push(row);
    else byKey.set(k, [row]);
  }

  const groups = [...byKey.entries()]
    .map(([key, rs]) => buildGroup(key, rs))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const verified = rows.filter((r) => r.outcome_source === "verified").length;
  const outcome_quality: "available" | "partial" | "unavailable" =
    rows.length === 0 || verified === 0 ? "unavailable" : verified === rows.length ? "available" : "partial";
  const notes: string[] = [];
  if (outcome_quality !== "available") {
    notes.push(
      `outcome_quality ${outcome_quality}: ${verified}/${rows.length} dispatches have a verified outcome. ` +
        "Quality scores over unverified outcomes are confidence-tagged, never presented as fact (§1 verified_promotion / R3 wiring pending).",
    );
  }

  return {
    schema_version: "usage.effectiveness.v1",
    generated_at: nowIso,
    group_by,
    groups,
    total_dispatches: rows.length,
    sources: { outcome_quality, notes },
  };
}
