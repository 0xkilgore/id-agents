// Agent detail v2 (T-CKPT.agent-v2) — the pure aggregator behind
// GET /agents/:name/detail.
//
// The route fetches each data source from the DB/registry/filesystem (each
// best-effort, so a missing source degrades to empty/zero rather than 500ing)
// and hands the already-fetched rows to `buildAgentDetail`, which is pure and
// fully unit-tested. Keeping the shaping logic pure means the JSON contract the
// TUI (and any web console) consumes is verifiable without a live DB.

import type { AgentCatalog } from "../config-parser.js";
import {
  pickCatalogView,
  catalogEditSchema,
  type CatalogView,
  type CatalogFieldSchema,
} from "./catalog-edit.js";

/** A task row, narrowed to the fields the charts need. */
export interface DetailTaskRow {
  status: string;
}

/** One point in the per-agent token time-series (one calendar day). */
export interface TokenSeriesPoint {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Weighted tokens attributed to the agent that day. */
  weighted: number;
}

/** A recent artifact produced by the agent (catalog row, narrowed). */
export interface DetailArtifactRow {
  artifact_id: string;
  basename: string;
  title: string | null;
  tag: string | null;
  abs_path: string;
  produced_at: string;
}

/** A recent dispatch/verified landing attributed to the agent. */
export interface DetailDispatchRow {
  dispatch_id: string;
  query_id: string | null;
  time: string;
  subject: string;
  dispatch_status: string;
  verification_status: string;
  verified: boolean;
  artifact_path: string | null;
  artifact_exists: boolean | null;
  artifact_mtime: string | null;
  tl_dr: string | null;
  kind: string;
  attributed_agent: string;
}

/** A routed artifact-comment receipt visible in the owning agent history. */
export interface DetailCommentReceiptRow {
  receipt_id: string;
  artifact_id: string;
  artifact_title: string | null;
  artifact_basename: string | null;
  actor: string;
  time: string;
  route_status: string;
  visible_state: "recorded+routed" | "recorded-but-route-failed-with-retry" | "not-recorded";
  retryable: boolean;
  route_kind: "approval_signal" | "substantive_follow_up" | "question";
  target_agent: string | null;
  target_agent_raw: string | null;
  dispatch_id: string | null;
  query_id: string | null;
  failure_reason: string | null;
  retry_metadata: {
    retryable: boolean;
    skipped: string | null;
    error: { message: string } | null;
    updated_at: string | null;
  };
}

/** A loop the agent owns (LoopSummary, narrowed to what the page shows). */
export interface DetailLoopRow {
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  health_state: string;
  schedule_label: string;
}

export type ContributionMetric = "activity" | "artifacts" | "failure_rate";

export interface ContributionGridCell {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Raw metric value for the day. */
  value: number;
  /** GitHub-style shade bucket: 0=no activity, 4=highest activity. */
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface ContributionGridVariant {
  metric: ContributionMetric;
  label: string;
  unit: string;
  total: number;
  max: number;
  cells: ContributionGridCell[];
}

export interface ContributionGrid {
  days: number;
  variants: ContributionGridVariant[];
}

/** Everything the route fetches, ready to be shaped. All fields required so the
 *  route is explicit about what it could/couldn't load (empty != absent). */
export interface RawAgentDetailData {
  name: string;
  now_iso: string;
  consecutive_failures: number;
  last_error: string | null;
  tasks: DetailTaskRow[];
  tokens_today: number;
  token_series: TokenSeriesPoint[];
  failed_dispatches: number;
  recent_outputs: DetailArtifactRow[];
  recent_dispatches: DetailDispatchRow[];
  recent_comment_receipts: DetailCommentReceiptRow[];
  skills: string[];
  loops: DetailLoopRow[];
  scripts: string[];
  /** AP6 — the agent's stored catalog (metadata.catalog), or null if absent. */
  catalog: AgentCatalog | null;
}

/** The stable JSON contract returned by GET /agents/:name/detail. */
export interface AgentDetailResponse {
  name: string;
  charts: {
    tasks: { total: number; by_status: Record<string, number> };
    tokens: { today: number; series: TokenSeriesPoint[] };
    failures: { consecutive: number; failed_dispatches: number; last_error: string | null };
  };
  /** GitHub-style daily contribution grids for the agent profile. */
  contribution_grid: ContributionGrid;
  /** Newest-first, capped at 20 — the recent-output feed. */
  recent_outputs: DetailArtifactRow[];
  /** Newest-first, capped at 20 — recent dispatches from the verification projection. */
  recent_dispatches: DetailDispatchRow[];
  /** Newest-first, capped at 20 — routed artifact-comment receipts for this agent. */
  recent_comment_receipts: DetailCommentReceiptRow[];
  /** Convenience subset of recent_dispatches where verification produced a landing. */
  verified_landings: DetailDispatchRow[];
  skills: string[];
  loops: DetailLoopRow[];
  scripts: string[];
  /** AP6 — the agent's catalog, narrowed to the editable view fields. */
  catalog: CatalogView;
  /** AP6 (Slice B) — self-describing schema for the inline catalog editor
   *  (editable fields + input types + enum options), so the detail page renders
   *  and pre-validates the editor without hard-coding the field rules. */
  catalog_edit_schema: CatalogFieldSchema[];
}

/** Hard cap on the recent-output feed (spec: "recent-output-last-20"). */
export const RECENT_OUTPUT_LIMIT = 20;
export const CONTRIBUTION_GRID_DAYS = 35;

/**
 * Shape raw per-agent data into the AgentDetailResponse contract. Pure: no I/O,
 * deterministic. Counts tasks by status, caps the output feed at 20 (assumes
 * caller passes newest-first; re-sorts defensively), and passes the rest
 * through. Negative/NaN numbers are floored to 0 so the charts never render
 * garbage.
 */
export function buildAgentDetail(raw: RawAgentDetailData): AgentDetailResponse {
  const by_status: Record<string, number> = {};
  for (const t of raw.tasks) {
    const k = t.status || "unknown";
    by_status[k] = (by_status[k] ?? 0) + 1;
  }

  const recent = [...raw.recent_outputs]
    .sort((a, b) => (a.produced_at < b.produced_at ? 1 : a.produced_at > b.produced_at ? -1 : 0))
    .slice(0, RECENT_OUTPUT_LIMIT);

  const recentDispatches = [...raw.recent_dispatches]
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    .slice(0, RECENT_OUTPUT_LIMIT);
  const recentCommentReceipts = [...raw.recent_comment_receipts]
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    .slice(0, RECENT_OUTPUT_LIMIT);

  const contribution_grid = buildContributionGrid(raw, recent, recentDispatches);

  return {
    name: raw.name,
    charts: {
      tasks: { total: raw.tasks.length, by_status },
      tokens: { today: nonNeg(raw.tokens_today), series: raw.token_series },
      failures: {
        consecutive: nonNeg(raw.consecutive_failures),
        failed_dispatches: nonNeg(raw.failed_dispatches),
        last_error: raw.last_error,
      },
    },
    contribution_grid,
    recent_outputs: recent,
    recent_dispatches: recentDispatches,
    recent_comment_receipts: recentCommentReceipts,
    // A verified landing is any verified dispatch — an artifact landing (has a
    // path) OR a promotion landing (code promoted to main, no artifact file).
    // Requiring artifact_path here silently dropped every code build, so agents
    // showed zero landings despite shipping (Maestra bug, 2026-06-30).
    verified_landings: recentDispatches.filter((d) => d.verified),
    skills: raw.skills,
    loops: raw.loops,
    scripts: raw.scripts,
    catalog: pickCatalogView(raw.catalog),
    catalog_edit_schema: catalogEditSchema(),
  };
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function buildContributionGrid(
  raw: RawAgentDetailData,
  recentOutputs: DetailArtifactRow[],
  recentDispatches: DetailDispatchRow[],
): ContributionGrid {
  const dates = contributionDates(raw.now_iso, CONTRIBUTION_GRID_DAYS);
  const activity = new Map<string, number>();
  for (const p of raw.token_series) {
    if (!dates.includes(p.date)) continue;
    activity.set(p.date, (activity.get(p.date) ?? 0) + nonNeg(p.weighted));
  }

  const artifacts = new Map<string, number>();
  for (const o of recentOutputs) {
    const d = isoDate(o.produced_at);
    if (!d || !dates.includes(d)) continue;
    artifacts.set(d, (artifacts.get(d) ?? 0) + 1);
  }

  const dispatchTotals = new Map<string, number>();
  const dispatchFailures = new Map<string, number>();
  for (const d of recentDispatches) {
    const day = isoDate(d.time);
    if (!day || !dates.includes(day)) continue;
    dispatchTotals.set(day, (dispatchTotals.get(day) ?? 0) + 1);
    if (isFailedDispatch(d)) {
      dispatchFailures.set(day, (dispatchFailures.get(day) ?? 0) + 1);
    }
  }
  const failureRate = new Map<string, number>();
  for (const [day, total] of dispatchTotals) {
    if (total <= 0) continue;
    failureRate.set(day, Math.round(((dispatchFailures.get(day) ?? 0) / total) * 100));
  }

  return {
    days: dates.length,
    variants: [
      variant("activity", "Activity", "tokens", dates, activity),
      variant("artifacts", "Artifacts", "outputs", dates, artifacts),
      variant("failure_rate", "Failure %", "%", dates, failureRate),
    ],
  };
}

function contributionDates(nowIso: string, days: number): string[] {
  const now = new Date(nowIso);
  const end = Number.isFinite(now.getTime()) ? now : new Date();
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Array.from({ length: days }, (_, i) => {
    const t = endUtc - (days - 1 - i) * 24 * 60 * 60 * 1000;
    return new Date(t).toISOString().slice(0, 10);
  });
}

function variant(
  metric: ContributionMetric,
  label: string,
  unit: string,
  dates: string[],
  values: Map<string, number>,
): ContributionGridVariant {
  const rawValues = dates.map((d) => nonNeg(values.get(d) ?? 0));
  const max = Math.max(0, ...rawValues);
  return {
    metric,
    label,
    unit,
    total: rawValues.reduce((sum, n) => sum + n, 0),
    max,
    cells: dates.map((date, i) => {
      const value = rawValues[i] ?? 0;
      return { date, value, intensity: intensity(value, max) };
    }),
  };
}

function intensity(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

function isoDate(value: string): string | null {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isFailedDispatch(d: DetailDispatchRow): boolean {
  const status = `${d.dispatch_status} ${d.verification_status}`.toLowerCase();
  return !d.verified || status.includes("fail") || status.includes("bounce") || status.includes("error");
}
