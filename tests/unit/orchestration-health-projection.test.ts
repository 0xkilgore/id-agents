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

  it("keeps approval-gated raw ready rows out of actionable and useful build fuel", async () => {
    await setMode(adapter, "default", "running");
    const approvalRequiredIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await insertBacklogItem(adapter, {
        title: `admissible build ready ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [`/repo/build-fuel-${i}`],
      });
    }
    for (let i = 0; i < 11; i += 1) {
      const item = await insertBacklogItem(adapter, {
        title: `approval-gated ready ${i}`,
        readiness_state: "ready",
        risk_class: "external",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [`/repo/approval-${i}`],
      });
      approvalRequiredIds.push(item.item_id);
    }

    const health = await readOrchestrationHealthProjection(adapter, "default", {
      minReadyFuel: 12,
      readyAdmission: {
        rawReady: 13,
        usefulReady: 2,
        admissibleNow: 2,
        blockerCounts: [
          { code: "risk_requires_approval", category: "lane_eligibility", count: 11 },
        ],
        nonAdmitted: approvalRequiredIds.map((item_id) => ({ item_id, code: "risk_requires_approval" })),
      },
    });

    expect(health.queue_quality.actionable_ready).toBe(2);
    expect(health.ready_item_blockers).toMatchObject({
      ready: 13,
      actionable: 2,
      admissible_now: 2,
      stale_ready_floor: true,
    });
    expect(health.ready_item_blockers.stale_ready_fuel).toMatchObject({
      active: true,
      reason: "useful_ready_fuel=2 is below min_ready_fuel=12; raw_ready_fuel=13",
      recommended_action:
        "clear the top ready-admission blockers or promote/refuel safe backlog candidates until ready fuel is admissible",
      counts_by_blocker_class: [
        {
          code: "risk_requires_approval",
          category: "lane_eligibility",
          count: 11,
          examples: approvalRequiredIds.slice(0, 5),
        },
      ],
      examples: approvalRequiredIds.slice(0, 5),
    });
    expect(health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "risk_requires_approval",
        category: "lane_eligibility",
        owner_lane: "chris",
        count: 11,
        examples: approvalRequiredIds.slice(0, 5),
        recommended_action: "review and approve the item or lower the risk class before admission",
      }),
    ]);
    expect(health.ready_item_blockers.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: approvalRequiredIds[0],
          code: "risk_requires_approval",
          category: "lane_eligibility",
          owner_lane: "chris",
          recommended_action: "review and approve the item or lower the risk class before admission",
        }),
      ]),
    );
    expect(health.build_ready_floor).toMatchObject({
      blocked: true,
      blocker_code: "build_ready_below_floor",
      useful_ready_count: 2,
      floor: 12,
      build_ready_lanes: 2,
      blocker_reasons: {
        build_ready_below_floor: 1,
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
    expect(health.queue_quality.blocked_or_failed).toBe(1);
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
