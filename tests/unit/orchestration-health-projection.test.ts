import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyOrchestrationAdmissionStatus,
  readOrchestrationHealthProjection,
} from "../../src/continuous-orchestration/health-projection.js";
import { insertBacklogItem, setItemState } from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
});

afterEach(async () => {
  await adapter.close();
});

describe("orchestration health projection", () => {
  it("classifies recent ready=0 ticks as no_ready_fuel, not a daemon-stuck incident", () => {
    const now = Date.parse("2026-07-07T12:00:00.000Z");

    const status = classifyOrchestrationAdmissionStatus({
      mode: "running",
      last_tick_at: "2026-07-07T11:59:30.000Z",
      last_dispatch_at: "2026-07-07T10:00:00.000Z",
      consecutive_zero_ticks: 0,
      ready: 0,
      min_ready_fuel: 8,
      stall_threshold_ticks: 3,
      tick_interval_ms: 60_000,
      active_clarification_count: 0,
      now_ms: now,
    });

    expect(status).toMatchObject({
      kind: "no_ready_fuel",
      ok: true,
      page_operator: false,
      severity: "watch",
      seconds_since_tick: 30,
    });
  });

  it("classifies recent ready=1 zero-admit ticks as no_ready_fuel, not a live incident page", () => {
    const now = Date.parse("2026-07-07T12:00:00.000Z");

    const status = classifyOrchestrationAdmissionStatus({
      mode: "running",
      last_tick_at: "2026-07-07T11:59:45.000Z",
      last_dispatch_at: "2026-07-07T09:00:00.000Z",
      consecutive_zero_ticks: 7,
      ready: 1,
      min_ready_fuel: 8,
      stall_threshold_ticks: 3,
      tick_interval_ms: 60_000,
      active_clarification_count: 0,
      now_ms: now,
    });

    expect(status).toMatchObject({
      kind: "no_ready_fuel",
      ok: true,
      page_operator: false,
      severity: "watch",
      seconds_since_tick: 15,
    });
  });

  it("distinguishes stale tick progress from stale dispatch progress", () => {
    const now = Date.parse("2026-07-07T12:00:00.000Z");

    const status = classifyOrchestrationAdmissionStatus({
      mode: "running",
      last_tick_at: "2026-07-07T11:45:00.000Z",
      last_dispatch_at: "2026-07-07T10:00:00.000Z",
      consecutive_zero_ticks: 0,
      ready: 0,
      min_ready_fuel: 8,
      stall_threshold_ticks: 3,
      tick_interval_ms: 60_000,
      active_clarification_count: 0,
      now_ms: now,
    });

    expect(status).toMatchObject({
      kind: "daemon_stuck",
      ok: false,
      page_operator: true,
      severity: "incident",
      seconds_since_tick: 900,
    });
  });

  it("reports clarification and admission-policy holds separately from daemon liveness", () => {
    const now = Date.parse("2026-07-07T12:00:00.000Z");
    const base = {
      mode: "running" as const,
      last_tick_at: "2026-07-07T11:59:45.000Z",
      last_dispatch_at: "2026-07-07T10:00:00.000Z",
      min_ready_fuel: 8,
      stall_threshold_ticks: 3,
      tick_interval_ms: 60_000,
      now_ms: now,
    };

    expect(classifyOrchestrationAdmissionStatus({
      ...base,
      consecutive_zero_ticks: 0,
      ready: 12,
      active_clarification_count: 2,
    })).toMatchObject({
      kind: "blocked_by_clarification",
      page_operator: false,
      severity: "action_needed",
    });

    expect(classifyOrchestrationAdmissionStatus({
      ...base,
      consecutive_zero_ticks: 3,
      ready: 12,
      active_clarification_count: 0,
    })).toMatchObject({
      kind: "admission_policy_held",
      page_operator: false,
      severity: "action_needed",
    });
  });

  it("counts active needs_clarification blockers, recent ids, and backlog dependency impact", async () => {
    const owner = await insertBacklogItem(adapter, {
      title: "land upstream change",
      readiness_state: "done",
    });
    await setItemState(adapter, owner.item_id, "done", { dispatch_phid: "phid:disp-clarifies-dependency" });
    await insertBacklogItem(adapter, {
      title: "dependent work",
      readiness_state: "ready",
      to_agent: "roger",
      dispatch_body: "continue",
      dependencies: [owner.item_id],
    });

    await insertDispatch({
      dispatch_phid: "phid:disp-clarifies-dependency",
      query_id: "query_blocking",
      status: "needs_clarification",
      updated_at: "2026-07-01T12:00:00.000Z",
      active_clarification_json: JSON.stringify({ question: "Which merge strategy?" }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-clarifies-standalone",
      query_id: "query_standalone",
      status: "needs_clarification",
      updated_at: "2026-07-01T13:00:00.000Z",
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-mooted",
      query_id: "query_mooted",
      status: "needs_clarification",
      recovery_status: "moot",
      updated_at: "2026-07-01T14:00:00.000Z",
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.blockers.blocked).toBe(true);
    expect(health.blockers.needs_clarification.count).toBe(2);
    expect(health.blockers.needs_clarification.recent_dispatch_ids).toEqual([
      "phid:disp-clarifies-standalone",
      "phid:disp-clarifies-dependency",
    ]);
    expect(health.blockers.needs_clarification.blocks_backlog_dependency_count).toBe(1);
    expect(health.blockers.needs_clarification.items[1]).toMatchObject({
      dispatch_phid: "phid:disp-clarifies-dependency",
      reason: "needs clarification: Which merge strategy?",
      blocks_backlog_dependency: true,
    });
  });

  it("classifies promotion blockers and ignores verified or explicitly skipped promotions", async () => {
    const owner = await insertBacklogItem(adapter, {
      title: "ship base package",
      readiness_state: "done",
    });
    await setItemState(adapter, owner.item_id, "done", { dispatch_phid: "phid:disp-promo-missing" });
    await insertBacklogItem(adapter, {
      title: "ship dependent package",
      readiness_state: "ready",
      to_agent: "roger",
      dispatch_body: "continue",
      dependencies: [owner.item_id],
    });

    await insertDispatch({
      dispatch_phid: "phid:disp-promo-missing",
      query_id: "query_missing",
      status: "done",
      completed_at: "2026-07-01T14:00:00.000Z",
      promotion_input_json: JSON.stringify({ repo: "/repo", branch: "feat", base: "main", remote: "origin" }),
      promotion_result_json: null,
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-promo-incomplete",
      query_id: "query_incomplete",
      status: "done",
      completed_at: "2026-07-01T13:00:00.000Z",
      promotion_input_json: JSON.stringify({ repo: "/repo", branch: "feat2", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({ required: true, completed: false, repos: [] }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-promo-ok",
      query_id: "query_ok",
      status: "done",
      completed_at: "2026-07-01T12:00:00.000Z",
      promotion_input_json: JSON.stringify({ repo: "/repo", branch: "feat3", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({
        required: true,
        completed: true,
        repos: [{ pushed: true, verified: true, promoted_sha: "abc", remote_main_sha: "abc" }],
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-promo-skipped",
      query_id: "query_skip",
      status: "done",
      completed_at: "2026-07-01T11:00:00.000Z",
      promotion_input_json: JSON.stringify({
        repo: "/repo",
        branch: "wip",
        base: "main",
        remote: "origin",
        promotion_skip_reason: "WIP branch",
      }),
      promotion_result_json: null,
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.blockers.promotion.count).toBe(2);
    expect(health.blockers.promotion.recent_dispatch_ids).toEqual([
      "phid:disp-promo-missing",
      "phid:disp-promo-incomplete",
    ]);
    expect(health.blockers.promotion.blocks_backlog_dependency_count).toBe(1);
    expect(health.blockers.promotion.items[0]).toMatchObject({
      dispatch_phid: "phid:disp-promo-missing",
      reason: "missing promotion result",
      blocks_backlog_dependency: true,
    });
    expect(health.blockers.promotion.items[1]?.reason).toBe("promotion incomplete: completed=false");
  });
});

async function insertDispatch(overrides: Partial<{
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  status: string;
  recovery_status: string;
  updated_at: string;
  completed_at: string | null;
  active_clarification_json: string | null;
  promotion_input_json: string | null;
  promotion_result_json: string | null;
}>): Promise<void> {
  const dispatchPhid = overrides.dispatch_phid ?? `phid:disp-${Math.random().toString(36).slice(2)}`;
  const updatedAt = overrides.updated_at ?? "2026-07-01T00:00:00.000Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
       dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown,
       provider, runtime, priority, status, not_before_at, updated_at, completed_at,
       recovery_status, active_clarification_json, promote, promotion_input_json, promotion_result_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dispatchPhid,
      "default",
      overrides.query_id ?? `${dispatchPhid}-query`,
      overrides.to_agent ?? "roger",
      "continuous-orchestration",
      "internal",
      "test dispatch",
      "body",
      "anthropic",
      "claude-code-cli",
      5,
      overrides.status ?? "queued",
      updatedAt,
      updatedAt,
      overrides.completed_at ?? null,
      overrides.recovery_status ?? "none",
      overrides.active_clarification_json ?? null,
      1,
      overrides.promotion_input_json ?? null,
      overrides.promotion_result_json ?? null,
    ],
  );
}
