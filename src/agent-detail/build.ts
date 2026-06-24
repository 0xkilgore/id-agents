// Agent detail v2 (T-CKPT.agent-v2) — the pure aggregator behind
// GET /agents/:name/detail.
//
// The route fetches each data source from the DB/registry/filesystem (each
// best-effort, so a missing source degrades to empty/zero rather than 500ing)
// and hands the already-fetched rows to `buildAgentDetail`, which is pure and
// fully unit-tested. Keeping the shaping logic pure means the JSON contract the
// TUI (and any web console) consumes is verifiable without a live DB.

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

/** A loop the agent owns (LoopSummary, narrowed to what the page shows). */
export interface DetailLoopRow {
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  health_state: string;
  schedule_label: string;
}

/** Everything the route fetches, ready to be shaped. All fields required so the
 *  route is explicit about what it could/couldn't load (empty != absent). */
export interface RawAgentDetailData {
  name: string;
  consecutive_failures: number;
  last_error: string | null;
  tasks: DetailTaskRow[];
  tokens_today: number;
  token_series: TokenSeriesPoint[];
  failed_dispatches: number;
  recent_outputs: DetailArtifactRow[];
  skills: string[];
  loops: DetailLoopRow[];
  scripts: string[];
}

/** The stable JSON contract returned by GET /agents/:name/detail. */
export interface AgentDetailResponse {
  name: string;
  charts: {
    tasks: { total: number; by_status: Record<string, number> };
    tokens: { today: number; series: TokenSeriesPoint[] };
    failures: { consecutive: number; failed_dispatches: number; last_error: string | null };
  };
  /** Newest-first, capped at 20 — the recent-output feed. */
  recent_outputs: DetailArtifactRow[];
  skills: string[];
  loops: DetailLoopRow[];
  scripts: string[];
}

/** Hard cap on the recent-output feed (spec: "recent-output-last-20"). */
export const RECENT_OUTPUT_LIMIT = 20;

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
    recent_outputs: recent,
    skills: raw.skills,
    loops: raw.loops,
    scripts: raw.scripts,
  };
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
