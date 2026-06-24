// Agent detail v2 pure builder (T-CKPT.agent-v2).

import { describe, it, expect } from "vitest";
import {
  buildAgentDetail,
  RECENT_OUTPUT_LIMIT,
  type RawAgentDetailData,
  type DetailArtifactRow,
} from "../../src/agent-detail/build.js";

function artifact(n: number, producedAt: string): DetailArtifactRow {
  return {
    artifact_id: `a${n}`,
    basename: `out-${n}.md`,
    title: `Output ${n}`,
    tag: "trinity",
    abs_path: `/x/out-${n}.md`,
    produced_at: producedAt,
  };
}

function raw(over: Partial<RawAgentDetailData> = {}): RawAgentDetailData {
  return {
    name: "roger",
    consecutive_failures: 0,
    last_error: null,
    tasks: [],
    tokens_today: 0,
    token_series: [],
    failed_dispatches: 0,
    recent_outputs: [],
    skills: [],
    loops: [],
    scripts: [],
    ...over,
  };
}

describe("buildAgentDetail", () => {
  it("counts tasks by status and totals them", () => {
    const d = buildAgentDetail(
      raw({ tasks: [{ status: "done" }, { status: "done" }, { status: "doing" }] }),
    );
    expect(d.charts.tasks.total).toBe(3);
    expect(d.charts.tasks.by_status).toEqual({ done: 2, doing: 1 });
  });

  it("buckets empty/missing status under 'unknown'", () => {
    const d = buildAgentDetail(raw({ tasks: [{ status: "" }, { status: "done" }] }));
    expect(d.charts.tasks.by_status).toEqual({ unknown: 1, done: 1 });
  });

  it("passes token today + series through and floors negatives to 0", () => {
    const series = [{ date: "2026-06-23", weighted: 100 }, { date: "2026-06-24", weighted: 250 }];
    const d = buildAgentDetail(raw({ tokens_today: 250, token_series: series }));
    expect(d.charts.tokens.today).toBe(250);
    expect(d.charts.tokens.series).toEqual(series);
    expect(buildAgentDetail(raw({ tokens_today: -5 })).charts.tokens.today).toBe(0);
    expect(buildAgentDetail(raw({ tokens_today: NaN })).charts.tokens.today).toBe(0);
  });

  it("surfaces failure stats (consecutive + failed dispatches + last_error)", () => {
    const d = buildAgentDetail(
      raw({ consecutive_failures: 3, failed_dispatches: 7, last_error: "boom" }),
    );
    expect(d.charts.failures).toEqual({ consecutive: 3, failed_dispatches: 7, last_error: "boom" });
  });

  it("caps the recent-output feed at 20 and orders newest-first", () => {
    // 25 artifacts, intentionally shuffled produced_at, ascending index ≠ time.
    const outs = Array.from({ length: 25 }, (_, i) =>
      artifact(i, `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const d = buildAgentDetail(raw({ recent_outputs: outs }));
    expect(d.recent_outputs).toHaveLength(RECENT_OUTPUT_LIMIT);
    // strictly descending by produced_at
    for (let i = 1; i < d.recent_outputs.length; i++) {
      expect(d.recent_outputs[i - 1].produced_at >= d.recent_outputs[i].produced_at).toBe(true);
    }
  });

  it("passes skills / loops / scripts through unchanged", () => {
    const loops = [
      { slug: "morning-digest", name: "Morning Digest", kind: "digest", enabled: true, health_state: "healthy", schedule_label: "daily 7am" },
    ];
    const d = buildAgentDetail(
      raw({ skills: ["code-review", "verify"], loops, scripts: ["deploy.sh", "ingest.py"] }),
    );
    expect(d.skills).toEqual(["code-review", "verify"]);
    expect(d.loops).toEqual(loops);
    expect(d.scripts).toEqual(["deploy.sh", "ingest.py"]);
  });

  it("empty agent → zeroed charts, empty feeds (degrades, never throws)", () => {
    const d = buildAgentDetail(raw());
    expect(d.charts.tasks).toEqual({ total: 0, by_status: {} });
    expect(d.charts.tokens).toEqual({ today: 0, series: [] });
    expect(d.recent_outputs).toEqual([]);
    expect(d.skills).toEqual([]);
    expect(d.name).toBe("roger");
  });
});
