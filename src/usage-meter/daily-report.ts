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

/** A generic spend bucket keyed by project or task/dispatch. */
export interface DimensionUsage extends UsageTotals {
  /** Stable key — project name, or the dispatch_id for a task. */
  key: string;
  /** Human label when the key is opaque (e.g. a task's dispatch subject). */
  label?: string;
  pct_weighted: number;
}

/** One rate-limit window read live from usage-meter-v2 (`GET /usage`). */
export interface MeterWindowSnapshot {
  /** % of the window's weighted-token budget consumed. */
  percent: number;
  /** ISO timestamp the window resets, or null when unavailable. */
  reset_at: string | null;
  time_until_reset_seconds?: number | null;
}

/**
 * Live meter windows folded into the report so the daily numbers and the
 * rate-limit headroom are read off the *same* source of truth.
 *
 * NOTE: usage-meter-v2 models `daily` as a calendar-day window in the policy
 * timezone, not Anthropic's 5-hour rolling rate-limit window. The weekly
 * window + its reset timestamp are exact; the short-window % is the
 * calendar-day budget. A true 5h rolling window is a meter-policy change
 * (see the report's instrumentation scope).
 */
export interface MeterSnapshot {
  daily: MeterWindowSnapshot;
  weekly: MeterWindowSnapshot;
}

/** What a dispatch_id resolves to for project/task attribution. */
export interface DispatchAttribution {
  /** Project parsed from the dispatch subject `[project: X]`, or null. */
  project: string | null;
  /** Human task label (dispatch subject/title), or null. */
  task: string | null;
}

/** Resolve a usage event's dispatch_id → its project/task attribution. */
export type DispatchMetaResolver = (
  dispatchId: string | null | undefined,
) => DispatchAttribution | undefined;

/** Bucket used when an event can't be attributed to a project/task. */
export const UNATTRIBUTED = "(unattributed)";

/**
 * Parse the canonical project tag out of a dispatch subject. Subjects carry
 * `[project: kapelle]` (case-insensitive, whitespace-tolerant). Returns null
 * when no project tag is present.
 */
export function parseProjectFromSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const m = subject.match(/\[\s*project\s*:\s*([^\]]+?)\s*\]/i);
  return m ? m[1].trim() : null;
}

export interface DailyUsageReport {
  schema_version: "usage.daily-report.v1";
  generated_at: string;
  date: string; // the local day being reported
  tz: string;
  total: UsageTotals;
  by_provider: ProviderUsage[];
  by_agent: AgentUsage[];
  /** Tokens per project (project parsed from the dispatch subject). */
  by_project: DimensionUsage[];
  /** Tokens per task — one bucket per dispatch the events were attributed to. */
  by_task: DimensionUsage[];
  biggest_burners: Array<{ agent_id: string; weighted_tokens: number; pct_weighted: number }>;
  /** Top-N biggest burners by project. */
  top_projects: DimensionUsage[];
  /** Top-N biggest burners by task/dispatch. */
  top_tasks: DimensionUsage[];
  trend: TrendDay[];
  /** Live rate-limit windows read off usage-meter-v2, or null when no meter. */
  meter: MeterSnapshot | null;
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
  /** Top-N for the project/task burner lists (defaults to 10). */
  topDimensions?: number;
  /** Resolve dispatch_id → {project, task} for the by-project/by-task lanes. */
  dispatchMeta?: DispatchMetaResolver;
  /** Live meter windows (daily/weekly % + reset) read from usage-meter-v2. */
  meter?: MeterSnapshot | null;
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
  const topDimensions = opts.topDimensions ?? 10;
  const resolveMeta = opts.dispatchMeta ?? (() => undefined);
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
  const projMap = new Map<string, UsageTotals>();
  // Task buckets keyed by dispatch_id; label is the human task subject/title.
  const taskMap = new Map<string, { totals: UsageTotals; label?: string }>();
  for (const e of dayEvents) {
    add(total, e);
    const pl = providerLabel(e.provider);
    if (!provMap.has(pl)) provMap.set(pl, emptyTotals());
    add(provMap.get(pl)!, e);
    if (!agentMap.has(e.agent_id)) agentMap.set(e.agent_id, { totals: emptyTotals(), providers: new Set() });
    const am = agentMap.get(e.agent_id)!;
    add(am.totals, e);
    am.providers.add(pl);

    // Project / task attribution via the event's dispatch_id.
    const meta = resolveMeta(e.dispatch_id);
    const projectKey = meta?.project ?? UNATTRIBUTED;
    if (!projMap.has(projectKey)) projMap.set(projectKey, emptyTotals());
    add(projMap.get(projectKey)!, e);

    const taskKey = e.dispatch_id ?? UNATTRIBUTED;
    if (!taskMap.has(taskKey)) {
      taskMap.set(taskKey, { totals: emptyTotals(), label: meta?.task ?? undefined });
    }
    const tm = taskMap.get(taskKey)!;
    add(tm.totals, e);
    if (!tm.label && meta?.task) tm.label = meta.task;
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

  const by_project: DimensionUsage[] = [...projMap.entries()]
    .map(([key, t]) => ({ key, ...t, pct_weighted: pct(t.weighted_tokens, total.weighted_tokens) }))
    .sort((a, b) => b.weighted_tokens - a.weighted_tokens);

  const by_task: DimensionUsage[] = [...taskMap.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      ...v.totals,
      pct_weighted: pct(v.totals.weighted_tokens, total.weighted_tokens),
    }))
    .sort((a, b) => b.weighted_tokens - a.weighted_tokens);

  const top_projects = by_project.slice(0, topDimensions);
  const top_tasks = by_task.slice(0, topDimensions);

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
    by_project,
    by_task,
    biggest_burners,
    top_projects,
    top_tasks,
    trend,
    meter: opts.meter ?? null,
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
  if (r.meter) {
    lines.push("## Rate-limit windows (live meter)");
    lines.push("");
    lines.push("| Window | Used % | Resets |");
    lines.push("|---|--:|---|");
    lines.push(`| Daily (calendar-day) | ${r.meter.daily.percent}% | ${r.meter.daily.reset_at ?? "—"} |`);
    lines.push(`| Weekly | ${r.meter.weekly.percent}% | ${r.meter.weekly.reset_at ?? "—"} |`);
    lines.push("");
    lines.push(
      "_Read live from usage-meter-v2 `/usage`. The short window is the meter's calendar-day budget; a true 5-hour rolling window is not yet modeled (see scope)._",
    );
    lines.push("");
  }
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
  lines.push("## By project");
  lines.push("");
  lines.push("| Project | Weighted tokens | % | Input | Output | Events |");
  lines.push("|---|--:|--:|--:|--:|--:|");
  if (r.by_project.length === 0) {
    lines.push("| _(none)_ | 0 | 0% | 0 | 0 | 0 |");
  } else {
    for (const p of r.by_project) {
      lines.push(`| ${p.key} | ${fmt(p.weighted_tokens)} | ${p.pct_weighted}% | ${fmt(p.input_tokens)} | ${fmt(p.output_tokens)} | ${fmt(p.events)} |`);
    }
  }
  lines.push("");
  lines.push("## Biggest burners — by project");
  lines.push("");
  if (r.top_projects.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const p of r.top_projects) {
      lines.push(`- **${p.key}** — ${fmt(p.weighted_tokens)} weighted tokens (${p.pct_weighted}%)`);
    }
  }
  lines.push("");
  lines.push("## Biggest burners — by task");
  lines.push("");
  if (r.top_tasks.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const t of r.top_tasks) {
      const label = t.label ? `${t.label} (${t.key})` : t.key;
      lines.push(`- **${label}** — ${fmt(t.weighted_tokens)} weighted tokens (${t.pct_weighted}%)`);
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
