// Agent detail v2 pure builder (T-CKPT.agent-v2).

import { describe, it, expect } from "vitest";
import {
  buildAgentDetail,
  CONTRIBUTION_GRID_DAYS,
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
    now_iso: "2026-06-29T12:00:00.000Z",
    consecutive_failures: 0,
    last_error: null,
    tasks: [],
    tokens_today: 0,
    token_series: [],
    failed_dispatches: 0,
    recent_outputs: [],
    recent_dispatches: [],
    recent_comment_receipts: [],
    pending_obligations: [],
    skills: [],
    loops: [],
    scripts: [],
    catalog: null,
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

  it("builds a GitHub-style contribution grid from activity, artifacts, and failures", () => {
    const d = buildAgentDetail(
      raw({
        token_series: [
          { date: "2026-06-27", weighted: 100 },
          { date: "2026-06-28", weighted: 250 },
          { date: "2026-06-29", weighted: 500 },
        ],
        recent_outputs: [
          artifact(1, "2026-06-28T10:00:00.000Z"),
          artifact(2, "2026-06-28T11:00:00.000Z"),
          artifact(3, "2026-06-29T10:00:00.000Z"),
        ],
        recent_dispatches: [
          {
            dispatch_id: "d-ok",
            query_id: null,
            time: "2026-06-28T12:00:00.000Z",
            subject: "ok",
            dispatch_status: "done",
            verification_status: "verified",
            verified: true,
            artifact_path: "/out/ok.md",
            artifact_exists: true,
            artifact_mtime: null,
            tl_dr: "ok",
            kind: "build",
            attributed_agent: "roger",
          },
          {
            dispatch_id: "d-fail",
            query_id: null,
            time: "2026-06-28T13:00:00.000Z",
            subject: "fail",
            dispatch_status: "failed",
            verification_status: "failed",
            verified: false,
            artifact_path: null,
            artifact_exists: null,
            artifact_mtime: null,
            tl_dr: "fail",
            kind: "build",
            attributed_agent: "roger",
          },
        ],
      }),
    );

    expect(d.contribution_grid.days).toBe(CONTRIBUTION_GRID_DAYS);
    expect(d.contribution_grid.variants.map((v) => v.metric)).toEqual([
      "activity",
      "artifacts",
      "failure_rate",
    ]);

    const activity = d.contribution_grid.variants.find((v) => v.metric === "activity")!;
    expect(activity.cells.at(-1)).toEqual({ date: "2026-06-29", value: 500, intensity: 4 });
    expect(activity.cells.at(-2)).toMatchObject({ date: "2026-06-28", value: 250, intensity: 2 });
    expect(activity.total).toBe(850);

    const artifacts = d.contribution_grid.variants.find((v) => v.metric === "artifacts")!;
    expect(artifacts.cells.at(-2)).toMatchObject({ date: "2026-06-28", value: 2, intensity: 4 });
    expect(artifacts.cells.at(-1)).toMatchObject({ date: "2026-06-29", value: 1, intensity: 2 });

    const failureRate = d.contribution_grid.variants.find((v) => v.metric === "failure_rate")!;
    expect(failureRate.cells.at(-2)).toMatchObject({ date: "2026-06-28", value: 50, intensity: 4 });
    expect(failureRate.max).toBe(50);
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
    expect(d.recent_dispatches).toEqual([]);
    expect(d.recent_comment_receipts).toEqual([]);
    expect(d.pending_obligations).toEqual([]);
    expect(d.verified_landings).toEqual([]);
    expect(d.skills).toEqual([]);
    expect(d.name).toBe("roger");
  });

  it("caps pending obligations and keeps stale escalation fields", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      obligation_id: `agent-obligation:phid:disp-${i}:closeout`,
      source_kind: "closeout" as const,
      obligation_type: "closeout" as const,
      source_record: `phid:disp-${i}`,
      source_ref: `query_${i}`,
      agent: "roger",
      owner: "manager",
      status: i === 0 ? "done" as const : "late" as const,
      stale_after: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      due_at: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      last_event_at: null,
      is_stale: i !== 0,
      stale_seconds: i * 60,
      escalation_level: i > 10 ? "critical" as const : i === 0 ? "none" as const : "stale" as const,
      escalates_at: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      dashboard_reason: `Obligation ${i}`,
    }));
    const d = buildAgentDetail(raw({ pending_obligations: rows }));
    expect(d.pending_obligations).toHaveLength(RECENT_OUTPUT_LIMIT);
    expect(d.pending_obligations.some((o) => o.status === "done")).toBe(false);
    expect(d.pending_obligations[0]).toMatchObject({
      obligation_id: "agent-obligation:phid:disp-1:closeout",
      is_stale: true,
      escalation_level: "stale",
    });
  });

  it("caps recent comment receipts and orders newest-first", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      receipt_id: `receipt-${i}`,
      artifact_id: `art-${i}`,
      artifact_title: `Artifact ${i}`,
      artifact_basename: `artifact-${i}.md`,
      actor: "user:chris",
      time: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      route_status: "routed",
      visible_state: "recorded+routed" as const,
      retryable: false,
      route_kind: "substantive_follow_up" as const,
      target_agent: "roger",
      target_agent_raw: "roger",
      dispatch_id: `phid:disp-${i}`,
      query_id: `query_${i}`,
      failure_reason: null,
      retry_metadata: { retryable: false, skipped: null, error: null, updated_at: null },
    }));
    const d = buildAgentDetail(raw({ recent_comment_receipts: rows }));
    expect(d.recent_comment_receipts).toHaveLength(RECENT_OUTPUT_LIMIT);
    for (let i = 1; i < d.recent_comment_receipts.length; i++) {
      expect(d.recent_comment_receipts[i - 1].time >= d.recent_comment_receipts[i].time).toBe(true);
    }
  });

  it("caps recent dispatches and exposes verified landings", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      dispatch_id: `d-${i}`,
      query_id: null,
      time: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      subject: `dispatch ${i}`,
      dispatch_status: "done",
      verification_status: i % 2 === 0 ? "verified" : "unverified",
      verified: i % 2 === 0,
      artifact_path: i % 2 === 0 ? `/out/${i}.md` : null,
      artifact_exists: i % 2 === 0 ? true : null,
      artifact_mtime: i % 2 === 0 ? `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:01:00.000Z` : null,
      tl_dr: `dispatch ${i}`,
      kind: "report",
      attributed_agent: i % 2 === 0 ? "maestra" : "agent-platform",
    }));
    const d = buildAgentDetail(raw({ recent_dispatches: rows }));
    expect(d.recent_dispatches).toHaveLength(RECENT_OUTPUT_LIMIT);
    for (let i = 1; i < d.recent_dispatches.length; i++) {
      expect(d.recent_dispatches[i - 1].time >= d.recent_dispatches[i].time).toBe(true);
    }
    expect(d.verified_landings.every((x) => x.verified && x.artifact_path)).toBe(true);
  });

  it("counts a promotion landing (verified, no artifact) as a verified landing", () => {
    const mk = (over: Partial<(typeof rows)[number]>) => ({
      dispatch_id: "d", query_id: null, time: "2026-06-28T12:00:00.000Z", subject: "s",
      dispatch_status: "done", verification_status: "verified", verified: true,
      artifact_path: null as string | null, artifact_exists: null as boolean | null,
      artifact_mtime: null as string | null, tl_dr: "s", kind: "build", attributed_agent: "hopper",
      ...over,
    });
    const rows = [
      mk({ dispatch_id: "artifact-landing", artifact_path: "/out/x.md", artifact_exists: true }),
      mk({ dispatch_id: "promotion-landing", artifact_path: null }), // code build, promoted, no artifact
      mk({ dispatch_id: "unverified", verified: false, verification_status: "unverified" }),
    ];
    const d = buildAgentDetail(raw({ recent_dispatches: rows }));
    const landed = d.verified_landings.map((x) => x.dispatch_id).sort();
    expect(landed).toEqual(["artifact-landing", "promotion-landing"]);
  });

  it("AP6 — surfaces the catalog view (null catalog → empty view)", () => {
    expect(buildAgentDetail(raw()).catalog).toEqual({
      role: null,
      description: null,
      expertise: [],
      costTier: null,
      notSuitableFor: [],
      status: null,
    });
    const d = buildAgentDetail(
      raw({ catalog: { role: "developer", expertise: ["ts"], costTier: "low", notSuitableFor: ["design"] } }),
    );
    expect(d.catalog.role).toBe("developer");
    expect(d.catalog.expertise).toEqual(["ts"]);
    expect(d.catalog.costTier).toBe("low");
    expect(d.catalog.notSuitableFor).toEqual(["design"]);
  });

  it("AP6 Slice B — surfaces the inline-editor schema in every detail response", () => {
    const d = buildAgentDetail(raw());
    expect(d.catalog_edit_schema.map((f) => f.field)).toEqual([
      "role", "description", "expertise", "costTier", "notSuitableFor", "status",
    ]);
    const costTier = d.catalog_edit_schema.find((f) => f.field === "costTier");
    expect(costTier?.input).toBe("enum");
    expect(costTier?.options).toEqual(["low", "medium", "high"]);
  });
});
