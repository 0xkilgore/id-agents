import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDispatchHealth } from "../../src/dispatch-scheduler/read-model.js";
import { readOrchestrationHealthProjection } from "../../src/continuous-orchestration/health-projection.js";
import {
  getBacklogItem,
  insertBacklogItem,
  reconcileStaleAlreadyDispatchedReadyRows,
  recordTickOutcome,
  setItemState,
  setMode,
} from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
});

afterEach(async () => {
  await adapter.close();
});

describe("orchestration health projection", () => {
  it("exposes bounded dispatch-health snapshot fields for Activity refresh", async () => {
    await insertDispatch({
      dispatch_phid: "phid:disp-in-flight-old",
      query_id: "query_in_flight_old",
      status: "in_flight",
      updated_at: "2026-07-01T10:00:00.000Z",
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-in-flight-new",
      query_id: "query_in_flight_new",
      status: "in_flight",
      updated_at: "2026-07-01T10:05:00.000Z",
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-promotion-verified",
      query_id: "query_promotion_verified",
      status: "done",
      completed_at: "2026-07-01T11:00:00.000Z",
      updated_at: "2026-07-01T11:00:00.000Z",
      promotion_result_json: JSON.stringify({
        completed: true,
        repos: [{ verified: true, promoted_sha: "abc", remote_main_sha: "abc" }],
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-promotion-unverified",
      query_id: "query_promotion_unverified",
      status: "done",
      completed_at: "2026-07-01T11:05:00.000Z",
      updated_at: "2026-07-01T11:05:00.000Z",
      promotion_result_json: JSON.stringify({
        completed: true,
        repos: [{ verified: false }],
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-stale-clarification",
      query_id: "query_stale_clarification",
      status: "needs_clarification",
      updated_at: "2026-07-01T09:00:00.000Z",
      active_clarification_json: JSON.stringify({
        clarification_id: "clar-stale",
        question: "Which landing should Activity show?",
        stale_at: "2026-07-01T09:30:00.000Z",
      }),
    });

    const health = await readDispatchHealth(adapter, "default");

    expect(health.bounded).toBe(true);
    expect(health.bounds).toMatchObject({
      count_per_status_limit: 1000,
      in_flight_limit: 50,
      recent_verified_landings_limit: 25,
      stale_snapshot_limit: 50,
      truncated_statuses: [],
    });
    expect(health.snapshot.schema_version).toBe("dispatch-health.snapshot.v1");
    expect(health.snapshot.in_flight).toMatchObject({
      count: 2,
      oldest_started_at: "2026-07-01T10:00:00.000Z",
      newest_updated_at: "2026-07-01T10:05:00.000Z",
    });
    expect(health.snapshot.in_flight.items.map((item) => item.dispatch_id)).toEqual([
      "phid:disp-in-flight-old",
      "phid:disp-in-flight-new",
    ]);
    expect(health.snapshot.recent_verified_landings.count).toBe(1);
    expect(health.snapshot.recent_verified_landings.items.map((item) => item.dispatch_id)).toEqual([
      "phid:disp-promotion-verified",
    ]);
    expect(health.snapshot.stale_snapshots.needs_clarification).toMatchObject({
      count: 1,
      oldest_stale_at: "2026-07-01T09:30:00.000Z",
      newest_stale_at: "2026-07-01T09:30:00.000Z",
    });
  });

  it("bounds dispatch-health status reads instead of grouping the full queue", async () => {
    for (let i = 0; i < 1005; i += 1) {
      await insertDispatch({
        dispatch_phid: `phid:disp-bounded-${String(i).padStart(4, "0")}`,
        query_id: `query_bounded_${i}`,
        status: "queued",
        updated_at: `2026-07-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
      });
    }

    const originalQuery = adapter.query.bind(adapter);
    const dispatchHealthSql: string[] = [];
    (adapter as any).query = (async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("dispatch_scheduler_queue")) {
        dispatchHealthSql.push(normalized);
      }
      return originalQuery(sql, params);
    }) as typeof adapter.query;

    try {
      const health = await readDispatchHealth(adapter, "default");
      expect(health.counts.queued).toBe(1000);
      expect(health.active).toBe(1000);
      expect(health.bounds.truncated_statuses).toContain("queued");
    } finally {
      (adapter as any).query = originalQuery as typeof adapter.query;
    }

    expect(dispatchHealthSql.some((sql) => /GROUP BY status/i.test(sql))).toBe(false);
    expect(dispatchHealthSql.some((sql) => /WITH bounded AS \( SELECT dispatch_phid FROM dispatch_scheduler_queue WHERE team_id = \? AND status = \? LIMIT \?/i.test(sql))).toBe(true);
  });

  it("reports capacity-explained zero-admit ticks as running_at_capacity instead of critical stall", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "current lane holder",
      readiness_state: "in_flight",
      to_agent: "roger",
      dispatch_body: "continue",
      write_scope: ["repo/shared"],
    });
    await insertBacklogItem(adapter, {
      title: "blocked by lane",
      readiness_state: "ready",
      to_agent: "roger",
      dispatch_body: "continue",
      write_scope: ["repo/shared"],
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: { single_writer_lane_busy: 1 },
    });

    const orchestration = await readOrchestrationHealthProjection(adapter, "default");
    const dispatches = await readDispatchHealth(adapter, "default");

    expect(orchestration.orchestration_loop).toMatchObject({
      state: "running_at_capacity",
      severity: "warn",
      consecutive_zero_ticks: 5,
      in_flight: 1,
      last_admission_block_reasons: { single_writer_lane_busy: 1 },
    });
    expect(dispatches.blockages.blockages.find((b) => b.kind === "co_stall")).toBeUndefined();
  });

  it("blocks build-ready lane diversity when ready fuel is at the floor but lanes are below minimum", async () => {
    await setMode(adapter, "default", "running");
    for (let i = 0; i < 12; i += 1) {
      await insertBacklogItem(adapter, {
        title: `single-lane build ready ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: ["/repo/kapelle"],
      });
    }
    await insertBacklogItem(adapter, {
      title: "single writer lane holder",
      readiness_state: "in_flight",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
      write_scope: ["/repo/kapelle"],
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {
        duplicate_dispatch_retry_required: 1,
        single_writer_lane_busy: 1,
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.blockers.blocked).toBe(true);
    expect(health.orchestration_loop.state).not.toBe("running");
    expect(health.orchestration_loop.state).not.toBe("paused");
    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      blocker_code: "build_ready_lane_diversity_below_min_lanes",
      useful_ready_count: 12,
      floor: 12,
      build_ready_lanes: 1,
      min_lanes: 2,
      candidate_lanes: ["/repo/kapelle"],
      blocker_reasons: {
        duplicate_dispatch_retry_required: 1,
        single_writer_lane_busy: 1,
        build_ready_lane_diversity_below_min_lanes: 1,
      },
    });
    expect(health.build_ready_floor.next_action).toContain("new lane");
    expect(health.queue_quality.actionable_ready).toBe(12);
  });

  it("keeps the 2026-07-13 build-ready current shape blocked on lane diversity, not ok or idle", async () => {
    await setMode(adapter, "default", "running");
    for (let i = 0; i < 12; i += 1) {
      await insertBacklogItem(adapter, {
        title: `2026-07-13 ready build row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "substrate-api-codex",
        dispatch_body: "continue",
        write_scope: ["/repo/id-agents"],
      });
    }
    await insertBacklogItem(adapter, {
      title: "2026-07-13 single writer lane holder",
      readiness_state: "in_flight",
      risk_class: "build",
      to_agent: "substrate-api-codex",
      dispatch_body: "continue",
      write_scope: ["/repo/id-agents"],
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {
        duplicate_dispatch_retry_required: 1,
        single_writer_lane_busy: 1,
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.blockers.blocked).toBe(true);
    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      blocker_code: "build_ready_lane_diversity_below_min_lanes",
      useful_ready_count: 12,
      floor: 12,
      build_ready_lanes: 1,
      min_lanes: 2,
      candidate_lanes: ["/repo/id-agents"],
      blocker_reasons: {
        duplicate_dispatch_retry_required: 1,
        single_writer_lane_busy: 1,
        build_ready_lane_diversity_below_min_lanes: 1,
      },
    });
    expect(health.build_ready_floor.next_action).toMatch(/new lane/i);
    expect(health.build_ready_floor.next_action).toMatch(/1\/2/);
    expect(health.build_ready_floor.next_action).toMatch(/12\/12/);
    expect(health.build_ready_floor.next_action).not.toMatch(/\b(ok|idle)\b/i);
  });

  it("does not count non-useful admission blockers as clean build-ready fuel", async () => {
    await setMode(adapter, "default", "running");
    const blockedIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const item = await insertBacklogItem(adapter, {
        title: `build ready projection row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [`/repo/kapelle-${i}`],
      });
      if (i < 2) blockedIds.push(item.item_id);
    }

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      readyAdmission: {
        admissibleNow: 10,
        blockerCounts: [
          { code: "target_unhealthy", category: "runtime_unavailable", count: 2 },
        ],
        nonAdmitted: blockedIds.map((item_id) => ({ item_id, code: "target_unhealthy" })),
      },
    });

    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      blocker_code: "build_ready_below_floor",
      useful_ready_count: 10,
      floor: 12,
      blocker_reasons: {
        target_unhealthy: 2,
        build_ready_below_floor: 1,
      },
    });
    expect(health.build_ready_floor.candidate_lanes).toHaveLength(10);
    expect(health.ready_item_blockers.stale_ready_fuel.counts_by_blocker_class).toEqual([
      { code: "target_unhealthy", category: "runtime_unavailable", count: 2, examples: blockedIds },
    ]);
  });

  it("keeps status health focused on higher-impact target_unhealthy repair without hiding retry blockers", async () => {
    await setMode(adapter, "default", "running");
    const targetUnhealthyIds: string[] = [];
    let retryBlockedId = "";
    for (let i = 0; i < 7; i += 1) {
      const row = await insertBacklogItem(adapter, {
        title: `status health blocked row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [`/repo/kapelle-${i}`],
      });
      if (i < 6) targetUnhealthyIds.push(row.item_id);
      else retryBlockedId = row.item_id;
    }
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 0,
      fired: true,
      admission_block_reasons: {},
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 8,
      fired: false,
      admission_block_reasons: {
        duplicate_dispatch_retry_required: 1,
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      readyAdmission: {
        rawReady: 7,
        usefulReady: 0,
        admissibleNow: 0,
        blockerCounts: [
          { code: "target_unhealthy", category: "runtime_unavailable", count: 6 },
          { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1 },
        ],
        nonAdmitted: [
          ...targetUnhealthyIds.map((item_id) => ({ item_id, code: "target_unhealthy", to_agent: "roger" })),
          { item_id: retryBlockedId, code: "duplicate_dispatch_retry_required", to_agent: "roger" },
        ],
        recommendedAction:
          "runtime repair for target_unhealthy=6 rows where safe; review duplicate_dispatch_retry_required=1 rows and mark retry_safe only for bounded refires or close stale duplicates",
      },
    });

    expect(health.orchestration_loop.last_admission_block_reasons).toEqual({
      duplicate_dispatch_retry_required: 1,
    });
    expect(health.orchestration_loop.zero_admit_audit).toEqual({
      recent_zero_admit_ticks: 8,
      top_blocker: { code: "target_unhealthy", category: "runtime_unavailable", count: 6 },
      affected_targets: ["roger"],
      last_dispatch_at: expect.any(String),
    });
    expect(health.ready_item_blockers.stale_ready_fuel.counts_by_blocker_class).toEqual([
      { code: "target_unhealthy", category: "runtime_unavailable", count: 6, examples: targetUnhealthyIds.slice(0, 5) },
      { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1, examples: [retryBlockedId] },
    ]);
    expect(health.ready_item_blockers.recommended_action).toContain(
      "runtime repair for target_unhealthy=6 rows where safe",
    );
    expect(health.ready_item_blockers.recommended_action).toContain(
      "review duplicate_dispatch_retry_required=1 rows",
    );
  });

  it("exposes bounded target-unhealthy blockers with item ids, alternatives, and operator action", async () => {
    await setMode(adapter, "default", "running");
    const rogerIds: string[] = [];
    const brunelIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const row = await insertBacklogItem(adapter, {
        title: `roger unhealthy target row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [`/repo/roger-${i}`],
      });
      rogerIds.push(row.item_id);
    }
    for (let i = 0; i < 2; i += 1) {
      const row = await insertBacklogItem(adapter, {
        title: `brunel unhealthy target row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "brunel",
        dispatch_body: "continue",
        write_scope: [`/repo/brunel-${i}`],
      });
      brunelIds.push(row.item_id);
    }

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      readyAdmission: {
        rawReady: 8,
        usefulReady: 0,
        admissibleNow: 0,
        blockerCounts: [
          { code: "target_unhealthy", category: "runtime_unavailable", count: 8 },
        ],
        nonAdmitted: [
          ...rogerIds.map((item_id) => ({ item_id, code: "target_unhealthy", to_agent: "roger" })),
          ...brunelIds.map((item_id) => ({
            item_id,
            code: "target_unhealthy",
            to_agent: "brunel",
            last_dispatch_phid: `phid:disp-${item_id}`,
          })),
        ],
        targetUnhealthyGroups: [
          {
            target: "roger",
            lane: "/repo/id-agents",
            count: 6,
            proposed_healthy_target: "regina",
            examples: rogerIds.map((item_id) => ({ item_id })),
            recommended_action: "reroute roger rows to regina or restart roger",
          },
          {
            target: "brunel",
            lane: "/repo/kapelle-site",
            count: 2,
            proposed_healthy_target: null,
            examples: brunelIds.map((item_id) => ({ item_id })),
            recommended_action: "restart brunel or downclassify stale target pins",
          },
        ],
        recommendedAction: "repair target_unhealthy lanes before adding more ready fuel",
      },
    });

    expect(health.ready_item_blockers.target_unhealthy).toEqual({
      count: 8,
      incident: null,
      top_blockers: [
        {
          target_agent: "roger",
          lane: "/repo/id-agents",
          count: 6,
          item_ids: rogerIds.slice(0, 5),
          online_alternatives: ["regina"],
          recommended_action: "reroute roger rows to regina or restart roger",
        },
        {
          target_agent: "brunel",
          lane: "/repo/kapelle-site",
          count: 2,
          item_ids: brunelIds,
          online_alternatives: [],
          recommended_action: "restart brunel or downclassify stale target pins",
        },
      ],
      repair_actions: [
        {
          target_agent: "roger",
          desired_action: "reroute",
          affected_item_ids: rogerIds.slice(0, 5),
          blocks_build_ready_floor: false,
          lane: "/repo/id-agents",
          proposed_target_agent: "regina",
          reason: "a healthy compatible target is available for these target_unhealthy ready rows",
          recommended_action: "reroute 6 target_unhealthy row(s) from roger to regina",
        },
        {
          target_agent: "brunel",
          desired_action: "supersede",
          affected_item_ids: brunelIds,
          blocks_build_ready_floor: false,
          lane: "/repo/kapelle-site",
          proposed_target_agent: null,
          reason: "target_unhealthy ready rows have prior dispatch evidence and need explicit replacement before any reroute or refire",
          recommended_action: "supersede or replace 2 target_unhealthy row(s) for brunel before readmission",
        },
      ],
    });
  });

  it("emits one bounded target-unhealthy incident when raw ready is blocked but not admissible", async () => {
    await setMode(adapter, "default", "running");
    const unhealthyIds: string[] = [];
    const dependencyIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const row = await insertBacklogItem(adapter, {
        title: `target unhealthy incident row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: i < 4 ? "brunel" : "coder-max",
        dispatch_body: "continue",
        write_scope: [`/repo/kapelle-unhealthy-${i}`],
      });
      unhealthyIds.push(row.item_id);
    }
    for (let i = 0; i < 3; i += 1) {
      const row = await insertBacklogItem(adapter, {
        title: `blocked dependency incident row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [`/repo/kapelle-dependency-${i}`],
      });
      dependencyIds.push(row.item_id);
    }
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 3,
      fired: false,
      admission_block_reasons: {
        target_unhealthy: 7,
        blocked_dependency: 3,
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      minReadyFuel: 8,
      readyAdmission: {
        rawReady: 10,
        usefulReady: 0,
        admissibleNow: 0,
        blockerCounts: [
          { code: "target_unhealthy", category: "runtime_unavailable", count: 7 },
          { code: "blocked_dependency", category: "lane_eligibility", count: 3 },
        ],
        nonAdmitted: [
          ...unhealthyIds.map((item_id, index) => ({
            item_id,
            code: "target_unhealthy",
            to_agent: index < 4 ? "brunel" : "coder-max",
          })),
          ...dependencyIds.map((item_id) => ({ item_id, code: "blocked_dependency", to_agent: "roger" })),
        ],
        targetUnhealthyGroups: [
          {
            target: "brunel",
            lane: "/repo/kapelle-unhealthy",
            count: 4,
            proposed_healthy_target: "regina",
            examples: unhealthyIds.slice(0, 4).map((item_id) => ({ item_id, risk_class: "build" })),
            recommended_action: "reroute brunel rows to regina or restart brunel",
          },
          {
            target: "coder-max",
            lane: "/repo/kapelle-unhealthy",
            count: 3,
            proposed_healthy_target: null,
            examples: unhealthyIds.slice(4).map((item_id) => ({ item_id, risk_class: "build" })),
            recommended_action: "restart coder-max or downclassify stale target pins",
          },
        ],
        recommendedAction:
          "repair target_unhealthy=7 rows before treating raw ready fuel as useful; resolve blocked_dependency=3 rows separately",
      },
    });

    expect(health.ok).toBe(false);
    expect(health.ready_item_blockers.ready).toBe(10);
    expect(health.ready_item_blockers.admissible_now).toBe(0);
    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      useful_ready_count: 0,
      blocker_reasons: {
        target_unhealthy: 7,
        blocked_dependency: 3,
        build_ready_below_floor: 1,
      },
    });
    expect(health.ready_item_blockers.target_unhealthy.incident).toEqual({
      schema_version: "orchestration.target_unhealthy_incident.v1",
      incident_code: "ready_fuel_blocked_by_target_unhealthy",
      dedupe_key: "ready_fuel_blocked_by_target_unhealthy|targets=brunel,coder-max|floor=8",
      severity: "critical",
      ready: 10,
      floor: 8,
      admissible_now: 0,
      consecutive_zero_ticks: 3,
      affected_targets: ["brunel", "coder-max"],
      example_item_ids: unhealthyIds.slice(0, 5),
      blocker_counts: [
        { code: "target_unhealthy", category: "runtime_unavailable", count: 7 },
        { code: "blocked_dependency", category: "lane_eligibility", count: 3 },
      ],
      recommended_action: "reroute 4 target_unhealthy row(s) from brunel to regina",
    });
    expect(health.ready_item_blockers.stale_ready_fuel.reason).toBe(
      "useful_ready_fuel=0 is below min_ready_fuel=8; raw_ready_fuel=10; admissible_now=0",
    );
    expect(health.queue_quality.explanation).toContain("7 target_unhealthy");
    expect(health.queue_quality.explanation).not.toContain("ready row(s) are admissible now");
  });

  it("persists enough zero-admit audit detail for stale target-unhealthy ready rows", async () => {
    await setMode(adapter, "default", "running");
    const staleA = await insertBacklogItem(adapter, {
      title: "stale target unhealthy roger row",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
      write_scope: ["/repo/kapelle-a"],
    });
    const staleB = await insertBacklogItem(adapter, {
      title: "stale target unhealthy brunel row",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "brunel",
      dispatch_body: "continue",
      write_scope: ["/repo/kapelle-b"],
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET last_dispatch_phid = CASE item_id
            WHEN $1 THEN 'phid:disp-stale-roger'
            WHEN $2 THEN 'phid:disp-stale-brunel'
          END
        WHERE item_id IN ($3, $4)`,
      [staleA.item_id, staleB.item_id, staleA.item_id, staleB.item_id],
    );
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 0,
      fired: true,
      admission_block_reasons: {},
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 6,
      fired: false,
      admission_block_reasons: { target_unhealthy: 2 },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      readyAdmission: {
        rawReady: 2,
        usefulReady: 0,
        admissibleNow: 0,
        blockerCounts: [
          { code: "target_unhealthy", category: "runtime_unavailable", count: 2 },
        ],
        nonAdmitted: [
          { item_id: staleA.item_id, code: "target_unhealthy", to_agent: "roger", last_dispatch_phid: "phid:disp-stale-roger" },
          { item_id: staleB.item_id, code: "target_unhealthy", to_agent: "brunel", last_dispatch_phid: "phid:disp-stale-brunel" },
        ],
      },
    });

    expect(health.orchestration_loop).toMatchObject({
      state: "stalled_ready_not_launching",
      consecutive_zero_ticks: 6,
      last_admission_block_reasons: { target_unhealthy: 2 },
      zero_admit_audit: {
        recent_zero_admit_ticks: 6,
        top_blocker: { code: "target_unhealthy", category: "runtime_unavailable", count: 2 },
        affected_targets: ["brunel", "roger"],
        last_dispatch_at: expect.any(String),
      },
    });
  });

  it("projects Wave49 all-single-writer-busy ready fuel with blocked lane keys and cross-lane action", async () => {
    await setMode(adapter, "default", "running");
    const itemIds: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const item = await insertBacklogItem(adapter, {
        title: `wave49 same-lane ready ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: ["/repo/id-agents"],
      });
      itemIds.push(item.item_id);
    }

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      minReadyFuel: 8,
      readyAdmission: {
        rawReady: 8,
        usefulReady: 8,
        admissibleNow: 0,
        blockerCounts: [
          { code: "single_writer_lane_busy", category: "lane_eligibility", count: 8 },
        ],
        nonAdmitted: itemIds.map((item_id) => ({ item_id, code: "single_writer_lane_busy" })),
        blockedLanes: [
          {
            lane: "/repo/id-agents",
            count: 8,
            blocker_counts: [
              { code: "single_writer_lane_busy", category: "lane_eligibility", count: 8 },
            ],
          },
        ],
        recommendedAction: "add cross-lane fuel outside blocked lane(s): /repo/id-agents",
      },
    });

    expect(health.ready_item_blockers).toMatchObject({
      ready: 8,
      admissible_now: 0,
      blocked_lanes: [
        {
          lane: "/repo/id-agents",
          count: 8,
          blocker_counts: [
            { code: "single_writer_lane_busy", category: "lane_eligibility", count: 8 },
          ],
        },
      ],
      recommended_action: "add cross-lane fuel outside blocked lane(s): /repo/id-agents",
      stale_ready_fuel: {
        active: true,
        recommended_action: "add cross-lane fuel outside blocked lane(s): /repo/id-agents",
        blocked_lanes: [
          {
            lane: "/repo/id-agents",
            count: 8,
            blocker_counts: [
              { code: "single_writer_lane_busy", category: "lane_eligibility", count: 8 },
            ],
          },
        ],
      },
    });
  });

  it("does not satisfy the useful-ready floor when all raw build-ready rows share a busy writer lane", async () => {
    await setMode(adapter, "default", "running");
    const itemIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const item = await insertBacklogItem(adapter, {
        title: `busy single-writer raw ready ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: ["/repo/kapelle"],
      });
      itemIds.push(item.item_id);
    }

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      minReadyFuel: 12,
      readyAdmission: {
        rawReady: 12,
        usefulReady: 0,
        admissibleNow: 0,
        blockerCounts: [
          { code: "single_writer_lane_busy", category: "lane_eligibility", count: 12 },
        ],
        nonAdmitted: itemIds.map((item_id) => ({ item_id, code: "single_writer_lane_busy" })),
        blockedLanes: [
          {
            lane: "/repo/kapelle",
            count: 12,
            blocker_counts: [
              { code: "single_writer_lane_busy", category: "lane_eligibility", count: 12 },
            ],
          },
        ],
        recommendedAction: "add cross-lane fuel outside blocked lane(s): /repo/kapelle",
      },
    });

    expect(health.ok).toBe(false);
    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      blocker_code: "build_ready_below_floor",
      useful_ready_count: 0,
      floor: 12,
      build_ready_lanes: 0,
      blocker_reasons: {
        single_writer_lane_busy: 12,
        build_ready_below_floor: 1,
      },
      next_action: "add cross-lane fuel outside blocked lane(s): /repo/kapelle",
    });
    expect(health.build_ready_floor.candidate_lanes).toEqual([]);
    expect(health.ready_item_blockers).toMatchObject({
      ready: 12,
      actionable: 12,
      admissible_now: 0,
      recommended_action: "add cross-lane fuel outside blocked lane(s): /repo/kapelle",
      stale_ready_fuel: {
        active: true,
        reason: "useful_ready_fuel=0 is below min_ready_fuel=12; raw_ready_fuel=12; admissible_now=0",
        recommended_action: "add cross-lane fuel outside blocked lane(s): /repo/kapelle",
      },
    });
    expect(health.ready_item_blockers.stale_ready_fuel.counts_by_blocker_class).toEqual([
      { code: "single_writer_lane_busy", category: "lane_eligibility", count: 12, examples: itemIds.slice(0, 5) },
    ]);
    expect(health.queue_quality.explanation).toContain(
      "12 actionable ready row(s) blocked by live admission guardrails",
    );
    expect(health.queue_quality.explanation).not.toContain("ready row(s) are admissible now");
  });

  it("escalates unexplained zero-admit ticks after the stall threshold", async () => {
    await setMode(adapter, "default", "running");
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {},
    });

    const orchestration = await readOrchestrationHealthProjection(adapter, "default");
    const dispatches = await readDispatchHealth(adapter, "default");

    expect(orchestration.orchestration_loop).toMatchObject({
      state: "stalled_ready_not_launching",
      severity: "critical",
      consecutive_zero_ticks: 5,
      last_admission_block_reasons: {},
    });
    expect(dispatches.blockages.blockages).toEqual([
      expect.objectContaining({
        kind: "co_stall",
        severity: "critical",
        count: 5,
      }),
    ]);
  });

  it("derives zero-admit blocker reasons from ready rows when persisted tick JSON is empty", async () => {
    await setMode(adapter, "default", "running");
    await insertAgent("cto", "claude-code-cli");
    const duplicate = await insertBacklogItem(adapter, {
      title: "failed dispatch retry guard",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await setItemState(adapter, duplicate.item_id, "ready", { dispatch_phid: "phid:disp-failed-prior" });
    await insertDispatch({
      dispatch_phid: "phid:disp-failed-prior",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in-flight claim",
    });
    await insertBacklogItem(adapter, {
      title: "cto runtime mismatch",
      readiness_state: "ready",
      risk_class: "routine",
      to_agent: "cto",
      dispatch_body: "review",
      provider: "openai",
      runtime: "codex",
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {
        no_in_flight_slots: 0,
        tick_admission_cap: 0,
      },
    });

    const orchestration = await readOrchestrationHealthProjection(adapter, "default");
    const dispatches = await readDispatchHealth(adapter, "default");

    expect(orchestration.orchestration_loop).toMatchObject({
      state: "stalled_ready_not_launching",
      severity: "critical",
      consecutive_zero_ticks: 5,
      last_admission_block_reasons: {
        duplicate_dispatch_retry_required: 1,
        provider_runtime_mismatch: 1,
      },
    });
    expect(orchestration.orchestration_loop.explanation).toContain("duplicate_dispatch_retry_required=1");
    expect(orchestration.orchestration_loop.explanation).toContain("provider_runtime_mismatch=1");
    expect(orchestration.queue_quality).toMatchObject({
      actionable_ready: 0,
    });
    expect(orchestration.ready_item_blockers).toMatchObject({
      ready: 2,
      actionable: 0,
    });
    expect(orchestration.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "duplicate_dispatch_retry_required",
        category: "retry_safety",
        count: 1,
        examples: [expect.any(String)],
      }),
      expect.objectContaining({
        code: "provider_runtime_mismatch",
        category: "runtime_unavailable",
        count: 1,
        examples: [expect.any(String)],
      }),
    ]);
    expect(orchestration.ready_item_blockers.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: duplicate.item_id,
          code: "duplicate_dispatch_retry_required",
          category: "retry_safety",
          prior_dispatch_id: "phid:disp-failed-prior",
          prior_dispatch_status: "failed",
          retry_safe_required: true,
          retry_safe_recommendation: "set_true",
          operator_disposition: "retry",
          recommended_disposition: "mark-retry-safe",
          recommended_action: "mark retry_safe only when the operator wants a bounded refire",
        }),
      ]),
    );
    expect(dispatches.blockages.blockages).toEqual([
      expect.objectContaining({
        kind: "co_stall",
        message: expect.stringContaining("duplicate_dispatch_retry_required=1"),
      }),
    ]);
    expect(dispatches.blockages.blockages[0]?.message).toContain("provider_runtime_mismatch=1");
  });

  it("does not classify manual refuel rows that omit provider/runtime as provider_runtime_mismatch", async () => {
    await setMode(adapter, "default", "running");
    await insertAgent("substrate-api-codex", "codex");
    await insertBacklogItem(adapter, {
      title: "Wave53 manual refuel row with omitted runtime metadata",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "substrate-api-codex",
      dispatch_body: "Add regression coverage for a contract-focused backlog item.",
      provider: null,
      runtime: null,
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {},
    });

    const orchestration = await readOrchestrationHealthProjection(adapter, "default");

    expect(orchestration.ready_item_blockers).toMatchObject({
      ready: 1,
      actionable: 1,
    });
    expect(orchestration.ready_item_blockers.categories).toEqual([]);
    expect(orchestration.orchestration_loop.last_admission_block_reasons).not.toHaveProperty(
      "provider_runtime_mismatch",
    );
  });

  it("reduces duplicate_dispatch_retry_required only after receipt-backed stale duplicate closeout", async () => {
    await setMode(adapter, "default", "running");
    const duplicate = await insertBacklogItem(adapter, {
      title: "already shipped duplicate",
      track: "T-ORCH",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await setItemState(adapter, duplicate.item_id, "ready", { dispatch_phid: "phid:disp-already-done" });
    await insertDispatch({
      dispatch_phid: "phid:disp-already-done",
      status: "done",
      completed_at: "2026-07-01T12:00:00.000Z",
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {},
    });

    const before = await readOrchestrationHealthProjection(adapter, "default");
    expect(before.ready_item_blockers.categories).toEqual([
      expect.objectContaining({ code: "duplicate_dispatch_retry_required", count: 1 }),
    ]);
    expect(before.ready_item_blockers.items).toEqual([
      expect.objectContaining({
        item_id: duplicate.item_id,
        code: "duplicate_dispatch_retry_required",
        prior_dispatch_id: "phid:disp-already-done",
        prior_dispatch_status: "done",
        retry_safe_required: true,
        retry_safe_recommendation: "leave_false",
        operator_disposition: "close",
        recommended_disposition: "close",
        recommended_action: "close or supersede the stale duplicate row; do not mark it retry-safe",
        stale_duplicate_closeout_receipt_exists: false,
      }),
    ]);

    const closeout = await reconcileStaleAlreadyDispatchedReadyRows(adapter, {
      team_id: "default",
      actor: "hopper",
    });
    expect(closeout).toMatchObject({
      closed: 1,
      superseded: 0,
      items: [
        {
          item_id: duplicate.item_id,
          dispatch_phid: "phid:disp-already-done",
          to_state: "done",
          receipt: {
            closed_by: "hopper",
            reason: "close_or_ignore",
            track: "T-ORCH",
            next_action: "close_duplicate_row",
            prior_dispatch_phid: "phid:disp-already-done",
            prior_dispatch_status: "done",
            successor_dispatch_phid: null,
            redispatch_safety: {
              safe_to_not_redispatch: true,
              reason: expect.stringContaining("duplicate completed work"),
            },
          },
        },
      ],
    });

    const closed = await getBacklogItem(adapter, duplicate.item_id);
    expect(closed?.readiness_state).toBe("done");
    expect(closed?.stale_duplicate_closeout_receipt).toMatchObject({
      closed_by: "hopper",
      to_state: "done",
      reason: "close_or_ignore",
      track: "T-ORCH",
      next_action: "close_duplicate_row",
      prior_dispatch_phid: "phid:disp-already-done",
      prior_dispatch_status: "done",
      redispatch_safety: { safe_to_not_redispatch: true },
    });
    expect(closed?.updated_by).toBe("hopper");

    const after = await readOrchestrationHealthProjection(adapter, "default");
    expect(after.ready_item_blockers.categories).toEqual([]);
    expect(after.ready_item_blockers.ready).toBe(0);
    expect(after.ready_item_blockers.actionable).toBe(0);
  });

  it("preserves retryable failed duplicate ready rows for explicit operator retry", async () => {
    await setMode(adapter, "default", "running");
    const duplicate = await insertBacklogItem(adapter, {
      title: "retryable failed duplicate",
      track: "T-ORCH",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await setItemState(adapter, duplicate.item_id, "ready", { dispatch_phid: "phid:disp-retryable-failed" });
    await insertDispatch({
      dispatch_phid: "phid:disp-retryable-failed",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "scheduler wedged during dispatch handoff",
    });

    const closeout = await reconcileStaleAlreadyDispatchedReadyRows(adapter, {
      team_id: "default",
      actor: "hopper",
    });

    expect(closeout).toMatchObject({
      scanned: 1,
      closed: 0,
      superseded: 0,
      items: [],
    });
    const preserved = await getBacklogItem(adapter, duplicate.item_id);
    expect(preserved?.readiness_state).toBe("ready");

    const health = await readOrchestrationHealthProjection(adapter, "default");
    expect(health.ready_item_blockers.items).toEqual([
      expect.objectContaining({
        item_id: duplicate.item_id,
        code: "duplicate_dispatch_retry_required",
        prior_dispatch_status: "failed",
        retry_safe_recommendation: "set_true",
        operator_disposition: "retry",
        recommended_disposition: "mark-retry-safe",
      }),
    ]);
  });

  it("classifies Gaudi verification HTTP 404 route failures with a concrete reroute recommendation", async () => {
    await setMode(adapter, "default", "running");
    const row = await insertBacklogItem(adapter, {
      title: "Gaudi verification dispatch route failure",
      track: "T-RELY",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "gaudi",
      dispatch_body: "[project: kapelle][T-RELY][VERIFY] gaudi: verify promoted build",
      write_scope: ["/repo/kapelle"],
    });
    await setItemState(adapter, row.item_id, "ready", { dispatch_phid: "phid:disp-gaudi-404" });
    await insertDispatch({
      dispatch_phid: "phid:disp-gaudi-404",
      to_agent: "gaudi",
      status: "failed",
      failure_kind: "agent_error",
      failure_detail: 'dispatch routing failed: HTTP 404 from /talk for agent "gaudi"',
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "duplicate_dispatch_retry_required",
        category: "retry_safety",
        count: 1,
        recommended_action: "mark the item retry-safe or create an explicit retry before readmitting it",
      }),
    ]);
    expect(health.ready_item_blockers.items).toEqual([
      expect.objectContaining({
        item_id: row.item_id,
        code: "duplicate_dispatch_retry_required",
        prior_dispatch_id: "phid:disp-gaudi-404",
        prior_dispatch_status: "failed",
        failure_class: "dispatch_route_not_found",
        retry_readiness_status: "non_retryable_failed_row",
        retry_safe_required: true,
        retry_safe_recommendation: "leave_false",
        operator_disposition: "reroute",
        recommended_disposition: "supersede",
        reason: expect.stringContaining("target route returned HTTP 404"),
        recommended_action:
          "reroute to a healthy compatible owner or supersede the stale target pin; do not mark it retry-safe",
      }),
    ]);
  });

  it("exposes the current duplicate-dispatch retry blockers and closes terminal stale duplicates with receipts", async () => {
    await setMode(adapter, "default", "running");
    const seedDuplicate = async (
      title: string,
      dispatch_phid: string,
      dispatch: Parameters<typeof insertDispatch>[0],
    ) => {
      const item = await insertBacklogItem(adapter, {
        title,
        track: "T-ORCH",
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: `[project: kapelle][T-ORCH] ${title}`,
        write_scope: [`/repo/${title.replace(/\s+/g, "-")}`],
      });
      await setItemState(adapter, item.item_id, "ready", { dispatch_phid });
      await insertDispatch({ dispatch_phid, ...dispatch });
      return item;
    };

    const retryable = await seedDuplicate("retryable failed prior", "phid:disp-retryable-prior", {
      status: "failed",
      recovery_status: "none",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in-flight claim",
    });
    const done = await seedDuplicate("terminal done prior", "phid:disp-done-prior", {
      status: "done",
      completed_at: "2026-07-14T12:00:00.000Z",
    });
    const superseded = await seedDuplicate("superseded prior", "phid:disp-superseded-prior", {
      status: "superseded",
      completed_at: "2026-07-14T12:05:00.000Z",
    });
    const promoted = await seedDuplicate("promotion verified prior", "phid:disp-promoted-prior", {
      status: "failed",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 5,
      fired: false,
      admission_block_reasons: {
        duplicate_dispatch_retry_required: 4,
        target_unhealthy: 1,
      },
    });

    const before = await readOrchestrationHealthProjection(adapter, "default");
    expect(before.orchestration_loop).toMatchObject({
      state: "stalled_ready_not_launching",
      severity: "critical",
      last_admission_block_reasons: {
        duplicate_dispatch_retry_required: 4,
        target_unhealthy: 1,
      },
    });
    expect(before.orchestration_loop.explanation).toContain("duplicate_dispatch_retry_required=4");
    expect(before.orchestration_loop.explanation).toContain("target_unhealthy=1");
    expect(before.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "duplicate_dispatch_retry_required",
        category: "retry_safety",
        count: 4,
        examples: [retryable.item_id, done.item_id, superseded.item_id, promoted.item_id],
      }),
    ]);
    expect(before.ready_item_blockers.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: retryable.item_id,
          prior_dispatch_id: "phid:disp-retryable-prior",
          prior_dispatch_status: "failed",
          retry_readiness_status: "retryable_failed_row",
          retry_safe_required: true,
          retry_safe_recommendation: "set_true",
          operator_disposition: "retry",
          recommended_disposition: "mark-retry-safe",
          reason: expect.stringContaining("failed with retryable transient"),
          safe_action_copy: expect.stringContaining("mark retry_safe=true only after operator approval"),
        }),
        expect.objectContaining({
          item_id: done.item_id,
          prior_dispatch_id: "phid:disp-done-prior",
          prior_dispatch_status: "done",
          retry_readiness_status: "stale_duplicate",
          retry_safe_recommendation: "leave_false",
          operator_disposition: "close",
          recommended_disposition: "close",
          reason: expect.stringContaining("close the duplicate ready blocker"),
          safe_action_copy: expect.stringContaining("close or supersede this stale duplicate row"),
        }),
        expect.objectContaining({
          item_id: superseded.item_id,
          prior_dispatch_id: "phid:disp-superseded-prior",
          prior_dispatch_status: "superseded",
          retry_readiness_status: "stale_duplicate",
          retry_safe_recommendation: "leave_false",
          operator_disposition: "close",
          recommended_disposition: "supersede",
          reason: expect.stringContaining("supersede the stale duplicate ready row"),
        }),
        expect.objectContaining({
          item_id: promoted.item_id,
          prior_dispatch_id: "phid:disp-promoted-prior",
          prior_dispatch_status: "failed",
          retry_readiness_status: "stale_duplicate",
          retry_safe_recommendation: "leave_false",
          operator_disposition: "close",
          recommended_disposition: "close",
          reason: expect.stringContaining("promotion-verified"),
        }),
      ]),
    );

    const closeout = await reconcileStaleAlreadyDispatchedReadyRows(adapter, {
      team_id: "default",
      actor: "roger",
    });
    expect(closeout).toMatchObject({
      scanned: 4,
      closed: 2,
      superseded: 1,
      preserved_retry_safe: 0,
    });
    expect(closeout.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        item_id: done.item_id,
        to_state: "done",
        receipt: expect.objectContaining({
          closed_by: "roger",
          next_action: "close_duplicate_row",
          prior_dispatch_phid: "phid:disp-done-prior",
          prior_dispatch_status: "done",
          redispatch_safety: expect.objectContaining({ safe_to_not_redispatch: true }),
        }),
      }),
      expect.objectContaining({
        item_id: superseded.item_id,
        to_state: "superseded",
        receipt: expect.objectContaining({
          closed_by: "roger",
          next_action: "supersede_duplicate_row",
          prior_dispatch_phid: "phid:disp-superseded-prior",
          prior_dispatch_status: "superseded",
          redispatch_safety: expect.objectContaining({ safe_to_not_redispatch: true }),
        }),
      }),
      expect.objectContaining({
        item_id: promoted.item_id,
        to_state: "done",
        receipt: expect.objectContaining({
          closed_by: "roger",
          next_action: "close_duplicate_row",
          prior_dispatch_phid: "phid:disp-promoted-prior",
          prior_dispatch_status: "failed",
          redispatch_safety: expect.objectContaining({ safe_to_not_redispatch: true }),
        }),
      }),
    ]));

    const after = await readOrchestrationHealthProjection(adapter, "default");
    expect(after.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "duplicate_dispatch_retry_required",
        category: "retry_safety",
        count: 1,
        examples: [retryable.item_id],
      }),
    ]);
    expect(after.ready_item_blockers.items).toEqual([
      expect.objectContaining({
        item_id: retryable.item_id,
        retry_readiness_status: "retryable_failed_row",
        retry_safe_recommendation: "set_true",
        operator_disposition: "retry",
      }),
    ]);
    await expect(getBacklogItem(adapter, done.item_id)).resolves.toMatchObject({
      readiness_state: "done",
      stale_duplicate_closeout_receipt: expect.objectContaining({
        prior_dispatch_phid: "phid:disp-done-prior",
        next_action: "close_duplicate_row",
      }),
    });
    await expect(getBacklogItem(adapter, superseded.item_id)).resolves.toMatchObject({
      readiness_state: "superseded",
      stale_duplicate_closeout_receipt: expect.objectContaining({
        prior_dispatch_phid: "phid:disp-superseded-prior",
        next_action: "supersede_duplicate_row",
      }),
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
      owner_lane: "chris",
      recommended_action: "ask Chris for the product or operator decision needed to resume",
      needs_chris: true,
      blocks_backlog_dependency: true,
    });
  });

  it("classifies needs_clarification rows as dependency blockers, retryable noise, or operator input", async () => {
    const owner = await insertBacklogItem(adapter, {
      title: "blocked upstream",
      readiness_state: "done",
    });
    await setItemState(adapter, owner.item_id, "done", { dispatch_phid: "phid:disp-expired-but-blocks" });
    await insertBacklogItem(adapter, {
      title: "dependent downstream",
      readiness_state: "ready",
      to_agent: "roger",
      dispatch_body: "continue",
      dependencies: [owner.item_id],
    });

    await insertDispatch({
      dispatch_phid: "phid:disp-expired-but-blocks",
      query_id: "query_expired_blocks",
      status: "needs_clarification",
      updated_at: "2026-07-01T16:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "linked query terminated expired; should this dependency be retried?",
        context: {
          blocking_reasons: ["linked query terminated expired"],
        },
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-expired-noise",
      query_id: "query_expired_noise",
      status: "needs_clarification",
      updated_at: "2026-07-01T15:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "linked query terminated expired",
        context: {
          summary: "Closeout expired as retryable noise; no operator decision required.",
          blocking_reasons: ["linked query terminated expired"],
        },
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-operator-input",
      query_id: "query_operator_input",
      status: "needs_clarification",
      updated_at: "2026-07-01T14:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "Which customer-facing copy should ship?",
        context: {
          blocking_reasons: ["operator decision required"],
        },
      }),
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    const itemIds = health.blockers.needs_clarification.items.map((item) => item.dispatch_phid);
    expect(health.blockers.needs_clarification.count).toBe(2);
    expect(health.blockers.needs_clarification.recent_dispatch_ids).toEqual([
      "phid:disp-expired-but-blocks",
      "phid:disp-operator-input",
    ]);
    expect(itemIds).not.toContain("phid:disp-expired-noise");
    expect(health.blockers.needs_clarification.blocks_backlog_dependency_count).toBe(1);
    expect(health.blockers.needs_clarification.items).toEqual([
      expect.objectContaining({
        dispatch_phid: "phid:disp-expired-but-blocks",
        owner_lane: "chris",
        recommended_action: "ask Chris for the product or operator decision needed to resume",
        needs_chris: true,
        blocks_backlog_dependency: true,
        blocked_dependency_item_ids: [expect.any(String)],
      }),
      expect.objectContaining({
        dispatch_phid: "phid:disp-operator-input",
        owner_lane: "chris",
        recommended_action: "ask Chris for the product or operator decision needed to resume",
        needs_chris: true,
        blocks_backlog_dependency: false,
      }),
    ]);
    expect(health.queue_quality.blocked_or_failed).toBe(3);
    expect(health.queue_quality.explanation).toContain("3 blocked or failed");
    expect(health.queue_quality.explanation).toContain("2 clarification blocker(s)");
  });

  it("routes known deterministic needs_clarification infra blockers away from Chris", async () => {
    await insertDispatch({
      dispatch_phid: "phid:disp-dirty-ui",
      query_id: "query_dirty_ui",
      to_agent: "frontend-builder",
      status: "needs_clarification",
      updated_at: "2026-07-01T15:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "Dirty UI worktree has user edits; should I overwrite them?",
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-task-cleanup",
      query_id: "query_task_cleanup",
      to_agent: "release-agent",
      status: "needs_clarification",
      updated_at: "2026-07-01T14:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "Divergent task-cleanup promotion: branch ahead and behind main.",
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-local-search",
      query_id: "query_local_search",
      to_agent: "search-agent",
      status: "needs_clarification",
      updated_at: "2026-07-01T13:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "Unrelated dirty local-search files are present before the change.",
      }),
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.blockers.needs_clarification.items).toEqual([
      expect.objectContaining({
        dispatch_phid: "phid:disp-dirty-ui",
        owner_lane: "ui-builder",
        recommended_action: "route to the UI worktree owner to preserve or commit local changes before resume",
        needs_chris: false,
      }),
      expect.objectContaining({
        dispatch_phid: "phid:disp-task-cleanup",
        owner_lane: "release-engineering",
        recommended_action: "run promotion preflight and resolve the task-cleanup branch divergence with the repo owner",
        needs_chris: false,
      }),
      expect.objectContaining({
        dispatch_phid: "phid:disp-local-search",
        owner_lane: "search-infra",
        recommended_action: "route to the local-search owner to stash, commit, or isolate unrelated dirty files",
        needs_chris: false,
      }),
    ]);
  });

  it("separates stale non-Chris clarifications from true operator decisions and promotion hygiene", async () => {
    await insertDispatch({
      dispatch_phid: "phid:disp-stale-needs-you-false",
      query_id: "query_stale_needs_you_false",
      to_agent: "regina",
      status: "needs_clarification",
      updated_at: "2026-07-01T16:00:00.000Z",
      active_clarification_json: JSON.stringify({
        needs_you: false,
        question: "linked query terminated expired while UI lane was at capacity",
        context: {
          summary: "Stale row from a saturated UI lane; no Chris decision required.",
          blocking_reasons: ["linked query terminated expired", "all_members_busy_with_backlog"],
          target_lane: "live-UI",
        },
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-product-decision",
      query_id: "query_product_decision",
      to_agent: "roger",
      status: "needs_clarification",
      updated_at: "2026-07-01T15:00:00.000Z",
      active_clarification_json: JSON.stringify({
        needs_you: true,
        question: "Should the checkout flow require approval before release?",
        context: {
          blocking_reasons: ["operator decision required"],
        },
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-promotion-hygiene",
      query_id: "query_promotion_hygiene",
      to_agent: "release-agent",
      status: "needs_clarification",
      updated_at: "2026-07-01T14:00:00.000Z",
      active_clarification_json: JSON.stringify({
        needs_you: false,
        question: "Promotion blocked: branch kapelle/fix-health is behind origin/main by 28 commits.",
        context: {
          repo: "/repo/kapelle",
          branch: "kapelle/fix-health",
          blocking_reasons: ["stale base", "branch-promotion hygiene should auto-route"],
          recommended_option: "route_to_worktree_hygiene",
        },
      }),
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.blockers.needs_clarification).toMatchObject({
      count: 3,
      needs_chris_count: 1,
      non_chris_count: 2,
      stale_non_chris_count: 2,
      recommended_action: "route non-Chris stale clarification rows to their owner lanes; ask Chris only for true product or operator decisions",
      recent_dispatch_ids: [
        "phid:disp-stale-needs-you-false",
        "phid:disp-product-decision",
        "phid:disp-promotion-hygiene",
      ],
    });
    expect(health.blockers.needs_clarification.items).toEqual([
      expect.objectContaining({
        dispatch_phid: "phid:disp-stale-needs-you-false",
        owner_lane: "ui-builder",
        needs_chris: false,
      }),
      expect.objectContaining({
        dispatch_phid: "phid:disp-product-decision",
        owner_lane: "chris",
        needs_chris: true,
      }),
      expect.objectContaining({
        dispatch_phid: "phid:disp-promotion-hygiene",
        owner_lane: "release-engineering",
        recommended_action: "route promotion hygiene to release-engineering: create_fresh_branch_from_base",
        needs_chris: false,
      }),
    ]);
  });

  it("classifies overloaded QA/UI linked-query expiries as stale-lane signals", async () => {
    await insertDispatch({
      dispatch_phid: "phid:disp-ui-expired-overloaded",
      query_id: "query_ui_expired_overloaded",
      to_agent: "regina",
      status: "needs_clarification",
      updated_at: "2026-07-01T15:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "linked query terminated expired",
        context: {
          summary: "QA dispatch expired while the target UI lane was overloaded.",
          blocking_reasons: ["linked query terminated expired", "all_members_busy_with_backlog"],
          target_lane: "live-UI",
        },
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-real-agent-error",
      query_id: "query_real_agent_error",
      to_agent: "roger",
      status: "needs_clarification",
      updated_at: "2026-07-01T14:00:00.000Z",
      active_clarification_json: JSON.stringify({
        question: "agent_error: test suite failed with assertion mismatch",
        context: {
          blocking_reasons: ["assertion mismatch"],
        },
      }),
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.blockers.needs_clarification.items).toEqual([
      expect.objectContaining({
        dispatch_phid: "phid:disp-ui-expired-overloaded",
        owner_lane: "ui-builder",
        recommended_action: "treat as stale UI/QA lane capacity; retry when the lane has free capacity or reassign within the UI pool",
        needs_chris: false,
      }),
      expect.objectContaining({
        dispatch_phid: "phid:disp-real-agent-error",
        owner_lane: "chris",
        recommended_action: "ask Chris for the product or operator decision needed to resume",
        needs_chris: true,
      }),
    ]);
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
      owner_lane: "release-engineering",
      recommended_action: "complete promotion, push the base branch, and verify the remote tip",
      needs_chris: false,
      blocks_backlog_dependency: true,
    });
    expect(health.blockers.promotion.items[1]?.reason).toBe("promotion incomplete: completed=false");
  });

  it("routes hygiene promotion failures out of generic promotion blockers", async () => {
    await insertDispatch({
      dispatch_phid: "phid:disp-hygiene",
      query_id: "query_hygiene",
      status: "done",
      completed_at: "2026-07-01T15:00:00.000Z",
      promotion_input_json: JSON.stringify({ repo: "/repo/app", branch: "feature/diverged", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({
        required: true,
        completed: false,
        failure_detail: "branch feature/diverged has diverged from main (ahead=1, behind=2)",
      }),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-generic",
      query_id: "query_generic",
      status: "done",
      completed_at: "2026-07-01T14:00:00.000Z",
      promotion_input_json: JSON.stringify({ repo: "/repo/app", branch: "feature/generic", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({ required: true, completed: false, repos: [] }),
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.blockers.promotion.count).toBe(1);
    expect(health.blockers.promotion.recent_dispatch_ids).toEqual(["phid:disp-generic"]);
  });

  it("counts duplicate/no-op artifact acknowledgement noise deterministically", async () => {
    await migrateOutputsTables(adapter);
    await insertArtifact("art:regina:ack.md", "regina");
    await insertCommentOp({
      artifact_id: "art:regina:ack.md",
      actor: "user:chris",
      body: "👍 acknowledged",
      reaction: "acknowledged",
      route_status: {
        visible_state: "recorded+routed",
        route_kind: "acknowledgement",
        routed: false,
        retryable: false,
        recorded_op_id: 1,
        target_agent: null,
        target_agent_raw: null,
        dispatch: null,
        skipped: "acknowledged",
        error: null,
        updated_at: "2026-07-01T15:00:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:regina:ack.md",
      actor: "user:chris",
      body: "👍 acknowledged",
      reaction: "acknowledged",
      route_status: {
        visible_state: "recorded+routed",
        route_kind: "acknowledgement",
        routed: false,
        retryable: false,
        recorded_op_id: 2,
        target_agent: null,
        target_agent_raw: null,
        dispatch: null,
        skipped: "acknowledged",
        error: null,
        updated_at: "2026-07-01T15:01:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:regina:ack.md",
      actor: "user:liz",
      body: "🚢 ship it",
      reaction: "ship_it",
      route_status: {
        visible_state: "recorded+routed",
        route_kind: "approval_signal",
        routed: false,
        retryable: false,
        recorded_op_id: 3,
        target_agent: null,
        target_agent_raw: null,
        dispatch: null,
        skipped: "approval_signal",
        error: null,
        updated_at: "2026-07-01T15:02:00.000Z",
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality).toMatchObject({
      raw_queued: 0,
      actionable_ready: 0,
      duplicate_or_noop_backfill: 3,
      suppressed_by_dedupe: 1,
      task_action_receipts: {
        routed: 0,
        failed: 0,
        needs_chris: 0,
        consumed: 3,
      },
    });
    expect(health.queue_quality.explanation).toContain("duplicate/no-op artifact acknowledgement");
    expect(health.queue_quality.top_noise_patterns[0]).toMatchObject({
      pattern: "acknowledgement:regina:acknowledged",
      count: 2,
      examples: ["art:regina:ack.md#1", "art:regina:ack.md#2"],
    });
  });

  it("separates duplicate acknowledgement noise by task-triage id before deduping", async () => {
    await migrateOutputsTables(adapter);
    await insertArtifact("art:triage:ack.md", "regina");
    const baseRouteStatus = {
      visible_state: "recorded+routed",
      route_kind: "acknowledgement",
      routed: false,
      retryable: false,
      recorded_op_id: 1,
      target_agent: "regina",
      target_agent_raw: "regina",
      dispatch: null,
      skipped: "acknowledged",
      error: null,
    };

    await insertCommentOp({
      artifact_id: "art:triage:ack.md",
      actor: "user:chris",
      body: "acknowledged",
      reaction: "acknowledged",
      task_triage_id: "triage-a",
      route_status: {
        ...baseRouteStatus,
        task_triage_id: "triage-a",
        updated_at: "2026-07-01T15:00:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:triage:ack.md",
      actor: "user:chris",
      body: "acknowledged",
      reaction: "acknowledged",
      task_triage_id: "triage-b",
      route_status: {
        ...baseRouteStatus,
        task_triage_id: "triage-b",
        updated_at: "2026-07-01T15:01:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:triage:ack.md",
      actor: "user:chris",
      body: "acknowledged",
      reaction: "acknowledged",
      task_triage_id: "triage-a",
      route_status: {
        ...baseRouteStatus,
        task_triage_id: "triage-a",
        updated_at: "2026-07-01T15:02:00.000Z",
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality.duplicate_or_noop_backfill).toBe(3);
    expect(health.queue_quality.suppressed_by_dedupe).toBe(1);
    expect(health.queue_quality.top_noise_patterns[0]).toMatchObject({
      pattern: "acknowledgement:regina:acknowledged",
      count: 2,
      examples: ["art:triage:ack.md#1", "art:triage:ack.md#3"],
    });
  });

  it("counts task note/comment action receipts by routed, failed, needs-Chris, and consumed state", async () => {
    await migrateOutputsTables(adapter);
    await insertArtifact("art:triage:receipts.md", "roger");

    await insertCommentOp({
      artifact_id: "art:triage:receipts.md",
      actor: "user:chris",
      body: "route",
      reaction: "comment",
      route_status: {
        route_kind: "task_note",
        routed: true,
        retryable: false,
        target_agent: "roger",
        dispatch: { dispatch_phid: "phid:disp-routed" },
        skipped: null,
        error: null,
        updated_at: "2026-07-01T15:00:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:triage:receipts.md",
      actor: "user:chris",
      body: "route fail",
      reaction: "comment",
      route_status: {
        route_kind: "task_note",
        routed: false,
        retryable: true,
        target_agent: "roger",
        dispatch: null,
        skipped: null,
        error: "agent unavailable",
        updated_at: "2026-07-01T15:01:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:triage:receipts.md",
      actor: "user:chris",
      body: "needs decision",
      reaction: "comment",
      route_status: {
        route_kind: "task_note",
        routed: false,
        retryable: false,
        target_agent: null,
        dispatch: null,
        skipped: "needs_chris",
        error: null,
        updated_at: "2026-07-01T15:02:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:triage:receipts.md",
      actor: "user:chris",
      body: "already handled",
      reaction: "acknowledged",
      route_status: {
        route_kind: "task_note",
        routed: false,
        retryable: false,
        target_agent: "roger",
        dispatch: null,
        skipped: "already_consumed",
        error: null,
        updated_at: "2026-07-01T15:03:00.000Z",
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality.task_action_receipts).toEqual({
      routed: 1,
      failed: 1,
      needs_chris: 1,
      consumed: 1,
    });
    expect(health.queue_quality.failed_task_action_receipts).toMatchObject({
      schema_version: "orchestration.failed_task_action_receipts.v1",
      count: 1,
      limit: 25,
      truncated: false,
      recommendations: { retry: 1, noop: 0, supersede: 0 },
      items: [
        {
          artifact_id: "art:triage:receipts.md",
          op_id: 2,
          route_kind: "task_note",
          target_agent: "roger",
          updated_at: "2026-07-01T15:01:00.000Z",
          retryable: true,
          error: "agent unavailable",
          recommendation: "retry",
          reason: "route status is retryable",
        },
      ],
    });
    expect(health.queue_quality.blocked_or_failed).toBe(1);
    expect(health.queue_quality.explanation).toContain("1 failed task-action receipt(s) require retry/noop/supersede disposition");
  });

  it("does not treat historical failed linked-query receipts as live Chris action", async () => {
    await migrateOutputsTables(adapter);
    await insertArtifact("art:triage:historical-linked-query.md", "roger");

    await insertCommentOp({
      artifact_id: "art:triage:historical-linked-query.md",
      actor: "system",
      body: "historical linked query failure",
      reaction: "comment",
      route_status: {
        visible_state: "recorded-but-route-failed",
        route_kind: "linked_query",
        routed: false,
        retryable: false,
        target_agent: "roger",
        dispatch: null,
        skipped: "needs_chris",
        error: null,
        needs_chris: true,
        failure_detail: "linked query terminated expired",
        updated_at: "2026-07-01T15:00:00.000Z",
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality.task_action_receipts).toEqual({
      routed: 0,
      failed: 1,
      needs_chris: 0,
      consumed: 0,
    });
    expect(health.queue_quality.failed_task_action_receipts).toMatchObject({
      count: 1,
      recommendations: { retry: 0, noop: 1, supersede: 0 },
      items: [
        {
          artifact_id: "art:triage:historical-linked-query.md",
          route_kind: "linked_query",
          target_agent: "roger",
          recommendation: "noop",
          reason: "historical linked-query failure is terminal noise",
        },
      ],
    });
  });

  it("bounds failed task-action receipt examples and classifies retry/noop/supersede recommendations", async () => {
    await migrateOutputsTables(adapter);
    await insertArtifact("art:triage:failed-receipts.md", "roger");

    await insertCommentOp({
      artifact_id: "art:triage:failed-receipts.md",
      actor: "user:chris",
      body: "retry me",
      reaction: "comment",
      route_status: {
        route_kind: "task_note",
        routed: false,
        retryable: true,
        target_agent: "roger",
        dispatch: null,
        skipped: null,
        error: "scheduler unavailable",
        updated_at: "2026-07-01T15:00:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:triage:failed-receipts.md",
      actor: "system",
      body: "old linked query failed",
      reaction: "comment",
      route_status: {
        visible_state: "recorded-but-route-failed",
        route_kind: "linked_query",
        routed: false,
        retryable: false,
        target_agent: "roger",
        dispatch: null,
        skipped: null,
        error: null,
        failure_detail: "linked query terminated expired",
        updated_at: "2026-07-01T15:01:00.000Z",
      },
    });

    for (let i = 0; i < 28; i += 1) {
      await insertCommentOp({
        artifact_id: "art:triage:failed-receipts.md",
        actor: "user:chris",
        body: `supersede ${i}`,
        reaction: "comment",
        route_status: {
          route_kind: "task_note",
          routed: false,
          retryable: false,
          target_agent: "roger",
          dispatch: null,
          skipped: null,
          error: "target_agent_unresolved",
          updated_at: `2026-07-01T15:${String(i + 2).padStart(2, "0")}:00.000Z`,
        },
      });
    }

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality.task_action_receipts.failed).toBe(30);
    expect(health.queue_quality.blocked_or_failed).toBe(30);
    expect(health.queue_quality.failed_task_action_receipts).toMatchObject({
      schema_version: "orchestration.failed_task_action_receipts.v1",
      count: 30,
      limit: 25,
      truncated: true,
      recommendations: { retry: 1, noop: 1, supersede: 28 },
    });
    expect(health.queue_quality.failed_task_action_receipts.items).toHaveLength(25);
    expect(health.queue_quality.failed_task_action_receipts.items[0]).toMatchObject({
      artifact_id: "art:triage:failed-receipts.md",
      route_kind: "task_note",
      recommendation: "supersede",
      reason: "route failed without retryable evidence",
      updated_at: "2026-07-01T15:29:00.000Z",
    });
  });

  it("surfaces reason-coded ready item blockers and stale ready floor", async () => {
    await insertBacklogItem(adapter, {
      title: "dependency-blocked ready item",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
      dependencies: ["missing-dependency"],
    });
    await insertBacklogItem(adapter, {
      title: "approval-blocked ready item",
      readiness_state: "ready",
      risk_class: "external",
      to_agent: "roger",
      dispatch_body: "continue",
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ready_item_blockers).toMatchObject({
      ready: 2,
      actionable: 0,
      stale_ready_floor: true,
    });
    expect(health.ready_item_blockers.categories).toEqual([
      {
        code: "blocked_dependency",
        category: "lane_eligibility",
        count: 1,
        examples: [expect.any(String)],
        owner_lane: "orchestration",
        reason: "ready row still has unresolved backlog dependencies",
        recommended_action: "land, clear, or supersede the dependency before admission",
      },
      {
        code: "risk_requires_approval",
        category: "lane_eligibility",
        count: 1,
        examples: [expect.any(String)],
        owner_lane: "chris",
        reason: "ready row has a risk class that cannot auto-run",
        recommended_action: "review and approve the item or lower the risk class before admission",
      },
    ]);
  });

  it("does not count risk-approval ready rows as useful or admissible build fuel", async () => {
    const approvalBlockedIds: string[] = [];
    for (let i = 0; i < 13; i += 1) {
      const item = await insertBacklogItem(adapter, {
        title: `risk approval blocked ready item ${i}`,
        readiness_state: "ready",
        risk_class: "external",
        to_agent: "roger",
        dispatch_body: "operator approval required",
        write_scope: [`/repo/risk-approval-${i}`],
      });
      approvalBlockedIds.push(item.item_id);
    }

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      minReadyFuel: 12,
      readyAdmission: {
        rawReady: 13,
        usefulReady: 0,
        admissibleNow: 0,
        blockerCounts: [
          { code: "risk_requires_approval", category: "lane_eligibility", count: 13 },
        ],
        nonAdmitted: approvalBlockedIds.map((item_id) => ({ item_id, code: "risk_requires_approval" })),
        recommendedAction: "review and approve risk_requires_approval=13 rows or lower risk class before admission",
      },
    });

    expect(health.ready_item_blockers).toMatchObject({
      ready: 13,
      actionable: 0,
      min_ready_fuel: 12,
      admissible_now: 0,
      stale_ready_floor: true,
      recommended_action: "review and approve risk_requires_approval=13 rows or lower risk class before admission",
      stale_ready_fuel: {
        active: true,
        reason: "useful_ready_fuel=0 is below min_ready_fuel=12; raw_ready_fuel=13; admissible_now=0",
        recommended_action: "review and approve risk_requires_approval=13 rows or lower risk class before admission",
        counts_by_blocker_class: [
          {
            code: "risk_requires_approval",
            category: "lane_eligibility",
            count: 13,
            examples: approvalBlockedIds.slice(0, 5),
          },
        ],
        examples: approvalBlockedIds.slice(0, 5),
      },
    });
    expect(health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "risk_requires_approval",
        category: "lane_eligibility",
        count: 13,
        examples: approvalBlockedIds.slice(0, 5),
        owner_lane: "chris",
        recommended_action: "review and approve the item or lower the risk class before admission",
      }),
    ]);
    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      useful_ready_count: 0,
      floor: 12,
      build_ready_lanes: 0,
      blocker_reasons: {
        risk_requires_approval: 13,
        build_ready_below_floor: 1,
      },
    });
  });

  it("includes owner, reason, and next action for admission metadata blockers", async () => {
    await insertAgent("cto", "claude-code-cli");
    const duplicate = await insertBacklogItem(adapter, {
      title: "duplicate retry guard",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await setItemState(adapter, duplicate.item_id, "ready", { dispatch_phid: "phid:disp-already-fired" });
    await insertBacklogItem(adapter, {
      title: "missing target",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "",
      dispatch_body: "",
    });
    await insertBacklogItem(adapter, {
      title: "runtime mismatch",
      readiness_state: "ready",
      risk_class: "routine",
      to_agent: "cto",
      dispatch_body: "review",
      provider: "openai",
      runtime: "codex",
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ready_item_blockers).toMatchObject({
      ready: 3,
      actionable: 0,
      stale_ready_floor: true,
    });
    expect(health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "missing_dispatch_target",
        category: "dispatch_admission",
        owner_lane: "orchestration",
        reason: "ready row is missing a target agent or dispatch body",
        recommended_action: "repair ready metadata before admission can launch the item",
      }),
      expect.objectContaining({
        code: "duplicate_dispatch_retry_required",
        category: "retry_safety",
        owner_lane: "orchestration",
        reason: "ready row is still linked to a prior dispatch and has not been marked retry-safe",
        recommended_action: "mark the item retry-safe or create an explicit retry before readmitting it",
      }),
      expect.objectContaining({
        code: "provider_runtime_mismatch",
        category: "runtime_unavailable",
        owner_lane: "fleet-ops",
        reason: "ready row requests a provider/runtime the target agent is not running",
        recommended_action: "route to a compatible agent or update the requested provider/runtime",
      }),
    ]);
  });

  it("computes a safe reroute/update repair suggestion for provider_runtime_mismatch rows without marking them admissible", async () => {
    await insertAgent("cto", "claude-code-cli");
    await insertAgent("brunel", "codex");
    await insertBacklogItem(adapter, {
      title: "Wave57 P1: Infra clear versus warning truth fixture",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "cto",
      dispatch_body: "review",
      provider: "openai",
      runtime: "codex",
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ready_item_blockers.ready).toBe(1);
    // The row must stay out of `actionable`/admissible fuel even though a
    // repair suggestion is available — a suggestion is not a fix.
    expect(health.ready_item_blockers.actionable).toBe(0);

    const item = health.ready_item_blockers.items.find((i) => i.code === "provider_runtime_mismatch");
    expect(item?.provider_runtime_repair).toEqual({
      requested_provider: "openai",
      requested_runtime: "codex",
      current_to_agent: "cto",
      current_to_agent_runtime: "claude-code-cli",
      reroute_to_agent: "brunel",
      update_metadata_to: { provider: "anthropic", runtime: "claude-code-cli" },
    });
    expect(health.build_ready_floor).toMatchObject({
      useful_ready_count: 0,
      blocker_reasons: {
        provider_runtime_mismatch: 1,
        build_ready_below_floor: 1,
      },
    });
  });

  it("leaves reroute_to_agent null when no live agent already runs the requested runtime", async () => {
    await insertAgent("cto", "claude-code-cli");
    await insertBacklogItem(adapter, {
      title: "runtime mismatch, no candidate",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "cto",
      dispatch_body: "review",
      provider: "openai",
      runtime: "codex",
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    const item = health.ready_item_blockers.items.find((i) => i.code === "provider_runtime_mismatch");
    expect(item?.provider_runtime_repair).toMatchObject({
      reroute_to_agent: null,
      update_metadata_to: { provider: "anthropic", runtime: "claude-code-cli" },
    });
  });
});

async function insertArtifact(artifactId: string, agent: string): Promise<void> {
  await adapter.query(
    `INSERT INTO artifacts (
       artifact_id, basename, agent, tag, abs_path, title, produced_at, source,
       availability, source_badges, reconciled_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifactId,
      "ack.md",
      agent,
      null,
      "/tmp/ack.md",
      "Ack",
      "2026-07-01T14:00:00.000Z",
      "manual",
      "present",
      "[]",
      null,
      "2026-07-01T14:00:00.000Z",
      "2026-07-01T14:00:00.000Z",
    ],
  );
}

async function insertCommentOp(input: {
  artifact_id: string;
  actor: string;
  body: string;
  reaction: string;
  task_triage_id?: string;
  route_status: Record<string, unknown>;
}): Promise<void> {
  await adapter.query(
    `INSERT INTO artifact_operations (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
     VALUES (?, 'comment_recorded', ?, ?, ?, NULL, NULL)`,
    [
      input.artifact_id,
      input.actor,
      String(input.route_status.updated_at),
      JSON.stringify({
        body: input.body,
        reaction: input.reaction,
        task_triage_id: input.task_triage_id,
        route_status: input.route_status,
      }),
    ],
  );
}

async function insertAgent(name: string, runtime: string): Promise<void> {
  await adapter.query(
    `INSERT OR IGNORE INTO teams (id, name, config) VALUES (?, ?, ?)`,
    ["default", "default", "{}"],
  );
  await adapter.query(
    `INSERT INTO agents (
       id, team_id, name, type, model, port, endpoint, working_directory,
       status, created_at, registry, metadata, deleted_at, runtime
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `agent-${name}`,
      "default",
      name,
      "claude",
      "test-model",
      0,
      `http://localhost/${name}`,
      "/tmp",
      "running",
      1780000000000,
      null,
      "{}",
      null,
      runtime,
    ],
  );
}

async function insertDispatch(overrides: Partial<{
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  status: string;
  recovery_status: string;
  updated_at: string;
  completed_at: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
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
       recovery_status, failure_kind, failure_detail, active_clarification_json,
       promote, promotion_input_json, promotion_result_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      overrides.failure_kind ?? null,
      overrides.failure_detail ?? null,
      overrides.active_clarification_json ?? null,
      1,
      overrides.promotion_input_json ?? null,
      overrides.promotion_result_json ?? null,
    ],
  );
}
