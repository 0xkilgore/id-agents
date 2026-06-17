// Daily token-usage report — aggregates agent_usage_event into a per-provider /
// per-agent / total daily report with a rolling trend and biggest-burner flags,
// so Chris can set the orchestrator's budget caps from real numbers.
//
// Pure aggregation (events in, report out) + a markdown renderer for the Desk /
// artifact delivery. Days are bucketed by the viewer's local calendar date so a
// "day" matches what Chris sees, not UTC.

import type { AgentUsageEvent, Provider } from "./types.js";

export const DEFAULT_REPORT_TZ = "America/Chicago";

export type ProviderLabel = "Claude" | "Codex" | "Cursor" | "Other";

/** Map the usage-meter provider lane to the operator-facing label. */
export function providerLabel(p: Provider | string): ProviderLabel {
  switch (p) {
    case "anthropic":
      return "Claude";
    case "openai":
      return "Codex";
    case "cursor":
      return "Cursor";
    default:
      return "Other";
  }
}

export interface UsageTotals {
  weighted_tokens: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

export interface ProviderUsage extends UsageTotals {
  provider: ProviderLabel;
  pct_weighted: number;
}

export interface AgentUsage extends UsageTotals {
  agent_id: string;
  providers: ProviderLabel[];
  pct_weighted: number;
}

export interface TrendDay {
  date: string; // YYYY-MM-DD (local)
  weighted_tokens: number;
  by_provider: Partial<Record<ProviderLabel, number>>;
}

export interface DailyUsageReport {
  schema_version: "usage.daily-report.v1";
  generated_at: string;
  date: string; // the local day being reported
  tz: string;
  total: UsageTotals;
  by_provider: ProviderUsage[];
  by_agent: AgentUsage[];
  biggest_burners: Array<{ agent_id: string; weighted_tokens: number; pct_weighted: number }>;
  trend: TrendDay[];
  /** False when no events landed in the report day — the instrumentation note. */
  data_available: boolean;
}

export interface BuildDailyReportOptions {
  events: AgentUsageEvent[];
  /** Local day to report, YYYY-MM-DD. Defaults to the local day of nowMs. */
  date?: string;
  tz?: string;
  nowMs: number;
  trendDays?: number;
  topBurners?: number;
}

function emptyTotals(): UsageTotals {
  return { weighted_tokens: 0, input_tokens: 0, output_tokens: 0, events: 0 };
}

function add(t: UsageTotals, e: AgentUsageEvent): void {
  t.weighted_tokens += e.weighted_tokens ?? 0;
  t.input_tokens += e.input_tokens ?? 0;
  t.output_tokens += e.output_tokens ?? 0;
  t.events += 1;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10; // one decimal
}

/** Local calendar date (YYYY-MM-DD) for an epoch-ms timestamp in `tz`. */
export function localDate(ms: number, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The local date `n` days before `date` (YYYY-MM-DD), tz-aware enough for a
 *  trend axis (uses noon UTC to avoid DST edge flips). */
function dateMinusDays(date: string, n: number): string {
  const base = Date.parse(`${date}T12:00:00.000Z`);
  return new Date(base - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function buildDailyUsageReport(opts: BuildDailyReportOptions): DailyUsageReport {
  const tz = opts.tz ?? DEFAULT_REPORT_TZ;
  const trendDays = opts.trendDays ?? 7;
  const topBurners = opts.topBurners ?? 5;
  const reportDate = opts.date ?? localDate(opts.nowMs, tz);

  // Bucket every event by its local date once.
  const byDate = new Map<string, AgentUsageEvent[]>();
  for (const e of opts.events) {
    const d = localDate(e.ts, tz);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(e);
  }

  const dayEvents = byDate.get(reportDate) ?? [];

  // Totals + per-provider + per-agent for the report day.
  const total = emptyTotals();
  const provMap = new Map<ProviderLabel, UsageTotals>();
  const agentMap = new Map<string, { totals: UsageTotals; providers: Set<ProviderLabel> }>();
  for (const e of dayEvents) {
    add(total, e);
    const pl = providerLabel(e.provider);
    if (!provMap.has(pl)) provMap.set(pl, emptyTotals());
    add(provMap.get(pl)!, e);
    if (!agentMap.has(e.agent_id)) agentMap.set(e.agent_id, { totals: emptyTotals(), providers: new Set() });
    const am = agentMap.get(e.agent_id)!;
    add(am.totals, e);
    am.providers.add(pl);
  }

  const by_provider: ProviderUsage[] = [...provMap.entries()]
    .map(([provider, t]) => ({ provider, ...t, pct_weighted: pct(t.weighted_tokens, total.weighted_tokens) }))
    .sort((a, b) => b.weighted_tokens - a.weighted_tokens);

  const by_agent: AgentUsage[] = [...agentMap.entries()]
    .map(([agent_id, v]) => ({
      agent_id,
      ...v.totals,
      providers: [...v.providers].sort(),
      pct_weighted: pct(v.totals.weighted_tokens, total.weighted_tokens),
    }))
    .sort((a, b) => b.weighted_tokens - a.weighted_tokens);

  const biggest_burners = by_agent
    .slice(0, topBurners)
    .map((a) => ({ agent_id: a.agent_id, weighted_tokens: a.weighted_tokens, pct_weighted: a.pct_weighted }));

  // Rolling trend ending on the report day.
  const trend: TrendDay[] = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = dateMinusDays(reportDate, i);
    const evs = byDate.get(d) ?? [];
    const byProv: Partial<Record<ProviderLabel, number>> = {};
    let w = 0;
    for (const e of evs) {
      const pl = providerLabel(e.provider);
      byProv[pl] = (byProv[pl] ?? 0) + (e.weighted_tokens ?? 0);
      w += e.weighted_tokens ?? 0;
    }
    trend.push({ date: d, weighted_tokens: w, by_provider: byProv });
  }

  return {
    schema_version: "usage.daily-report.v1",
    generated_at: new Date(opts.nowMs).toISOString(),
    date: reportDate,
    tz,
    total,
    by_provider,
    by_agent,
    biggest_burners,
    trend,
    data_available: dayEvents.length > 0,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Render the report as the Desk / artifact markdown. */
export function renderDailyUsageReportMarkdown(r: DailyUsageReport): string {
  const lines: string[] = [];
  lines.push(`# Daily token-usage report — ${r.date} (${r.tz})`);
  lines.push("");
  if (!r.data_available) {
    lines.push(
      `> ⚠️ No token-usage events recorded for ${r.date}. The agent_usage_event table is not yet being populated — per-agent token ingestion is not wired (see instrumentation scope). This report renders real numbers as soon as ingestion lands.`,
    );
    lines.push("");
  }
  lines.push(
    `**Total weighted tokens: ${fmt(r.total.weighted_tokens)}**  ·  input ${fmt(r.total.input_tokens)} · output ${fmt(r.total.output_tokens)} · ${fmt(r.total.events)} events`,
  );
  lines.push("");
  lines.push("## By provider");
  lines.push("");
  lines.push("| Provider | Weighted tokens | % | Input | Output | Events |");
  lines.push("|---|--:|--:|--:|--:|--:|");
  for (const p of r.by_provider) {
    lines.push(`| ${p.provider} | ${fmt(p.weighted_tokens)} | ${p.pct_weighted}% | ${fmt(p.input_tokens)} | ${fmt(p.output_tokens)} | ${fmt(p.events)} |`);
  }
  lines.push("");
  lines.push("## By agent");
  lines.push("");
  lines.push("| Agent | Provider | Weighted tokens | % | Input | Output |");
  lines.push("|---|---|--:|--:|--:|--:|");
  for (const a of r.by_agent) {
    lines.push(`| ${a.agent_id} | ${a.providers.join("+")} | ${fmt(a.weighted_tokens)} | ${a.pct_weighted}% | ${fmt(a.input_tokens)} | ${fmt(a.output_tokens)} |`);
  }
  lines.push("");
  lines.push("## Biggest burners");
  lines.push("");
  if (r.biggest_burners.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const b of r.biggest_burners) {
      lines.push(`- **${b.agent_id}** — ${fmt(b.weighted_tokens)} weighted tokens (${b.pct_weighted}%)`);
    }
  }
  lines.push("");
  lines.push(`## ${r.trend.length}-day trend (weighted tokens/day)`);
  lines.push("");
  lines.push("| Date | Total | Claude | Codex | Cursor | Other |");
  lines.push("|---|--:|--:|--:|--:|--:|");
  for (const t of r.trend) {
    const bp = t.by_provider;
    lines.push(
      `| ${t.date} | ${fmt(t.weighted_tokens)} | ${fmt(bp.Claude ?? 0)} | ${fmt(bp.Codex ?? 0)} | ${fmt(bp.Cursor ?? 0)} | ${fmt(bp.Other ?? 0)} |`,
    );
  }
  lines.push("");
  lines.push(`_generated ${r.generated_at} · weighted = input + output + cache_creation + cache_read×0.1_`);
  return lines.join("\n");
}
