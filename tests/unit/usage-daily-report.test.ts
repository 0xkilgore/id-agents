// Daily token-usage report aggregator + markdown renderer.

import { describe, it, expect } from "vitest";
import {
  buildDailyUsageReport,
  renderDailyUsageReportMarkdown,
  providerLabel,
  parseProjectFromSubject,
  localDate,
  type DispatchAttribution,
  type MeterSnapshot,
} from "../../src/usage-meter/daily-report.js";
import type { AgentUsageEvent } from "../../src/usage-meter/types.js";

const TZ = "America/Chicago";

let n = 0;
function ev(over: Partial<AgentUsageEvent> = {}): AgentUsageEvent {
  return {
    event_id: `e${++n}`,
    provider: "anthropic",
    agent_id: "roger",
    dispatch_id: null,
    query_id: null,
    session_id: null,
    model: "claude-opus-4-8",
    ts: Date.parse("2026-06-17T15:00:00.000Z"), // ~10:00 America/Chicago on 2026-06-17
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    raw_tokens: 0,
    weighted_tokens: 0,
    source: "transcript",
    confidence: "high",
    idempotency_key: `k${n}`,
    ...over,
  } as AgentUsageEvent;
}

describe("providerLabel", () => {
  it("maps lanes to operator labels", () => {
    expect(providerLabel("anthropic")).toBe("Claude");
    expect(providerLabel("openai")).toBe("Codex");
    expect(providerLabel("cursor")).toBe("Cursor");
    expect(providerLabel("other")).toBe("Other");
  });
});

describe("buildDailyUsageReport", () => {
  const NOW = Date.parse("2026-06-17T23:00:00.000Z");

  it("aggregates per-provider, per-agent, and total for the report day", () => {
    const events = [
      ev({ agent_id: "roger", provider: "anthropic", weighted_tokens: 100, input_tokens: 60, output_tokens: 40 }),
      ev({ agent_id: "roger", provider: "anthropic", weighted_tokens: 50 }),
      ev({ agent_id: "regina", provider: "openai", weighted_tokens: 300, input_tokens: 200, output_tokens: 100 }),
      ev({ agent_id: "rams", provider: "cursor", weighted_tokens: 25 }),
    ];
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW });

    expect(r.total.weighted_tokens).toBe(475);
    expect(r.total.events).toBe(4);
    expect(r.data_available).toBe(true);

    const codex = r.by_provider.find((p) => p.provider === "Codex")!;
    expect(codex.weighted_tokens).toBe(300);
    expect(codex.pct_weighted).toBeCloseTo(63.2, 0);

    const claude = r.by_provider.find((p) => p.provider === "Claude")!;
    expect(claude.weighted_tokens).toBe(150); // roger's two events

    // by_agent sorted desc by weighted; regina is the biggest
    expect(r.by_agent[0].agent_id).toBe("regina");
    expect(r.biggest_burners[0]).toMatchObject({ agent_id: "regina", weighted_tokens: 300 });
  });

  it("excludes events outside the report day (local-date bucketed)", () => {
    const events = [
      ev({ weighted_tokens: 100, ts: Date.parse("2026-06-17T15:00:00Z") }), // 06-17 local
      ev({ weighted_tokens: 999, ts: Date.parse("2026-06-16T15:00:00Z") }), // 06-16 local
    ];
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW });
    expect(r.total.weighted_tokens).toBe(100);
  });

  it("builds a rolling N-day trend with per-provider split", () => {
    const events = [
      ev({ weighted_tokens: 100, provider: "anthropic", ts: Date.parse("2026-06-17T15:00:00Z") }),
      ev({ weighted_tokens: 200, provider: "openai", ts: Date.parse("2026-06-16T15:00:00Z") }),
    ];
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW, trendDays: 3 });
    expect(r.trend).toHaveLength(3);
    expect(r.trend[r.trend.length - 1]).toMatchObject({ date: "2026-06-17", weighted_tokens: 100 });
    expect(r.trend[r.trend.length - 2]).toMatchObject({ date: "2026-06-16", weighted_tokens: 200 });
    expect(r.trend[r.trend.length - 2].by_provider.Codex).toBe(200);
  });

  it("flags data_available=false when the day has no events (instrumentation gap)", () => {
    const r = buildDailyUsageReport({ events: [], date: "2026-06-17", tz: TZ, nowMs: NOW });
    expect(r.data_available).toBe(false);
    expect(r.total.weighted_tokens).toBe(0);
    expect(renderDailyUsageReportMarkdown(r)).toMatch(/No token-usage events recorded/);
  });

  it("renders a markdown report with the key sections", () => {
    const events = [ev({ agent_id: "roger", weighted_tokens: 100 })];
    const md = renderDailyUsageReportMarkdown(
      buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW }),
    );
    expect(md).toContain("# Daily token-usage report — 2026-06-17");
    expect(md).toContain("## By provider");
    expect(md).toContain("## By agent");
    expect(md).toContain("## Biggest burners");
    expect(md).toMatch(/day trend/);
  });
});

describe("parseProjectFromSubject", () => {
  it("extracts the [project: X] tag, case/space-insensitive", () => {
    expect(parseProjectFromSubject("[project: kapelle][BUILD] do thing")).toBe("kapelle");
    expect(parseProjectFromSubject("[BUILD][ Project :  Cane Site ] x")).toBe("Cane Site");
    expect(parseProjectFromSubject("no tag here")).toBeNull();
    expect(parseProjectFromSubject(null)).toBeNull();
    expect(parseProjectFromSubject(undefined)).toBeNull();
  });
});

describe("buildDailyUsageReport — by-project / by-task", () => {
  const NOW = Date.parse("2026-06-17T23:00:00.000Z");

  // dispatch_id → attribution stub (what the route's DB join produces).
  const meta: Record<string, DispatchAttribution> = {
    "disp-a": { project: "kapelle", task: "[project: kapelle] build login" },
    "disp-b": { project: "kapelle", task: "[project: kapelle] fix nav" },
    "disp-c": { project: "cane", task: "[project: cane] scheduler" },
  };
  const dispatchMeta = (id: string | null | undefined) => (id ? meta[id] : undefined);

  const events = [
    ev({ dispatch_id: "disp-a", weighted_tokens: 100 }),
    ev({ dispatch_id: "disp-b", weighted_tokens: 50 }),
    ev({ dispatch_id: "disp-c", weighted_tokens: 300 }),
    ev({ dispatch_id: null, weighted_tokens: 25 }), // unattributed
  ];

  it("aggregates tokens by project (kapelle = a+b)", () => {
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW, dispatchMeta });
    const kap = r.by_project.find((p) => p.key === "kapelle")!;
    expect(kap.weighted_tokens).toBe(150);
    const cane = r.by_project.find((p) => p.key === "cane")!;
    expect(cane.weighted_tokens).toBe(300);
    const un = r.by_project.find((p) => p.key === "(unattributed)")!;
    expect(un.weighted_tokens).toBe(25);
    // sorted desc by weighted
    expect(r.by_project[0].key).toBe("cane");
  });

  it("aggregates tokens by task/dispatch with the subject as label", () => {
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW, dispatchMeta });
    const taskC = r.by_task.find((t) => t.key === "disp-c")!;
    expect(taskC.weighted_tokens).toBe(300);
    expect(taskC.label).toBe("[project: cane] scheduler");
    expect(r.by_task[0].key).toBe("disp-c"); // biggest task
  });

  it("honors topDimensions for the top_projects / top_tasks lists", () => {
    const r = buildDailyUsageReport({
      events,
      date: "2026-06-17",
      tz: TZ,
      nowMs: NOW,
      dispatchMeta,
      topDimensions: 2,
    });
    expect(r.top_projects).toHaveLength(2);
    expect(r.top_tasks).toHaveLength(2);
    expect(r.top_projects[0].key).toBe("cane");
  });

  it("buckets everything as unattributed when no resolver is given", () => {
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW });
    expect(r.by_project).toHaveLength(1);
    expect(r.by_project[0].key).toBe("(unattributed)");
    expect(r.by_project[0].weighted_tokens).toBe(475);
  });

  it("renders the project + task sections in markdown", () => {
    const r = buildDailyUsageReport({ events, date: "2026-06-17", tz: TZ, nowMs: NOW, dispatchMeta });
    const md = renderDailyUsageReportMarkdown(r);
    expect(md).toContain("## By project");
    expect(md).toContain("## Biggest burners — by project");
    expect(md).toContain("## Biggest burners — by task");
    expect(md).toContain("kapelle");
  });
});

describe("buildDailyUsageReport — live meter windows", () => {
  const NOW = Date.parse("2026-06-17T23:00:00.000Z");
  const meter: MeterSnapshot = {
    daily: { percent: 42, reset_at: "2026-06-18T00:00:00.000-05:00", time_until_reset_seconds: 3600 },
    weekly: { percent: 71, reset_at: "2026-06-22T00:00:00.000-05:00", time_until_reset_seconds: 99999 },
  };

  it("folds the meter snapshot into the report", () => {
    const r = buildDailyUsageReport({ events: [ev({ weighted_tokens: 10 })], date: "2026-06-17", tz: TZ, nowMs: NOW, meter });
    expect(r.meter).toEqual(meter);
  });

  it("defaults meter to null when not supplied", () => {
    const r = buildDailyUsageReport({ events: [], date: "2026-06-17", tz: TZ, nowMs: NOW });
    expect(r.meter).toBeNull();
  });

  it("renders the rate-limit windows section with % and reset", () => {
    const r = buildDailyUsageReport({ events: [ev({ weighted_tokens: 10 })], date: "2026-06-17", tz: TZ, nowMs: NOW, meter });
    const md = renderDailyUsageReportMarkdown(r);
    expect(md).toContain("## Rate-limit windows (live meter)");
    expect(md).toContain("71%");
    expect(md).toContain("2026-06-22T00:00:00.000-05:00");
  });
});
