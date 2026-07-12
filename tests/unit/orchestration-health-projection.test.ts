import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readOrchestrationHealthProjection } from "../../src/continuous-orchestration/health-projection.js";
import {
  classifyManagerWork,
  readManagerWorkTelemetryProjection,
} from "../../src/continuous-orchestration/manager-work-telemetry.js";
import {
  appendDecisions,
  insertBacklogItem,
  recordTickOutcome,
  setItemState,
  setMode,
} from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  classifyPromotionHygieneFailure,
  upsertWorktreeHygieneCleanupRoute,
} from "../../src/loops/worktree-hygiene.js";
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
  it("classifies manager work with authority exclusions", () => {
    expect(classifyManagerWork({
      source: "manager_query",
      text: "Implement backend telemetry and tests",
    })).toMatchObject({
      work_class: "manager_direct",
      specialist_work_class: "implementation",
      authority_only: false,
      route_linked: false,
    });

    expect(classifyManagerWork({
      source: "dispatch",
      text: "Audit the API route",
      dispatch_phid: "phid:disp-delegated",
    })).toMatchObject({
      work_class: "delegated",
      specialist_work_class: "audit",
      route_linked: true,
    });

    expect(classifyManagerWork({
      source: "manager_query",
      text: "Approval granted for promotion and scheduler route selection",
    })).toMatchObject({
      work_class: "authority_required",
      specialist_work_class: null,
      authority_only: true,
    });
  });

  it("exposes 24h and 7d manager work telemetry without warning on delegated specialist work", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    await insertManagerQuery({
      query_id: "query_direct_status",
      prompt: "Summarize status for Desk delivery",
      created: Date.parse("2026-07-13T10:00:00.000Z"),
      completed: Date.parse("2026-07-13T10:02:00.000Z"),
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-delegated-impl",
      query_id: "query_delegated_impl",
      status: "done",
      updated_at: "2026-07-13T09:00:00.000Z",
      body_markdown: "Implement the backend pool telemetry and tests",
    });
    await appendDecisions(adapter, {
      team_id: "default",
      tick_id: "tick-authority",
      dry_run: false,
      records: [{ item_id: null, action: "held", reason: "risk requires approval before dispatch" }],
    });

    const telemetry = await readManagerWorkTelemetryProjection(adapter, "default", { now });

    expect(telemetry.counts_24h).toMatchObject({
      manager_direct: 0,
      delegated: 1,
      authority_required: 2,
    });
    expect(telemetry.specialist_counts_24h.implementation).toBe(1);
    expect(telemetry.warning_count_24h).toBe(0);
    expect(telemetry.recent_warnings).toEqual([]);
  });

  it("warns on long specialist manager-direct work with no dispatch, backlog item, or task route", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    await insertManagerQuery({
      query_id: "query_long_direct",
      prompt: "Implement lightweight manager-direct telemetry in the backend pool and add tests",
      created: Date.parse("2026-07-13T08:00:00.000Z"),
      completed: Date.parse("2026-07-13T08:37:00.000Z"),
    });
    await insertManagerQuery({
      query_id: "query_linked_direct",
      prompt: "Implement route fix. Task: manager-direct-telemetry",
      created: Date.parse("2026-07-13T09:00:00.000Z"),
      completed: Date.parse("2026-07-13T09:40:00.000Z"),
    });

    const telemetry = await readManagerWorkTelemetryProjection(adapter, "default", { now });

    expect(telemetry.counts_24h.manager_direct).toBe(2);
    expect(telemetry.specialist_counts_24h.implementation).toBe(2);
    expect(telemetry.warning_count_24h).toBe(1);
    expect(telemetry.recent_warnings[0]).toMatchObject({
      query_id: "query_long_direct",
      duration_seconds: 2220,
      specialist_work_class: "implementation",
    });
    expect(telemetry.recent_warnings[0]?.reason).toContain("linked dispatch_id");
  });

  it("includes manager work telemetry in the orchestration health payload", async () => {
    await insertManagerQuery({
      query_id: "query_health_payload",
      prompt: "Research backend telemetry requirements",
      created: Date.now() - 60_000,
      completed: Date.now(),
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.manager_work_telemetry.schema_version).toBe("manager_work_telemetry.v1");
    expect(health.manager_work_telemetry.counts_24h.manager_direct).toBeGreaterThanOrEqual(1);
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

  it("routes hygiene promotion failures out of generic promotion blockers and exposes cleanup owner lane", async () => {
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
    const incident = classifyPromotionHygieneFailure({
      repo: "/repo/app",
      branch: "feature/diverged",
      dispatch_id: "phid:disp-hygiene",
      text: "branch feature/diverged has diverged from main (ahead=1, behind=2)",
    });
    expect(incident).not.toBeNull();
    const route = await upsertWorktreeHygieneCleanupRoute(adapter, incident!, {
      nowIso: "2026-07-01T15:01:00.000Z",
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
    expect(health.blockers.stale_hygiene.count).toBe(1);
    expect(health.blockers.stale_hygiene.owner_lanes).toEqual(["roger"]);
    expect(health.blockers.stale_hygiene.items[0]).toMatchObject({
      dispatch_phid: "phid:disp-hygiene",
      repo: "/repo/app",
      branch: "feature/diverged",
      class_code: "ahead_behind_divergence",
      dedupe_key: "/repo/app:feature/diverged:ahead_behind_divergence",
      owner_lane: "roger",
      cleanup_item_id: route.item.item_id,
      cleanup_dispatch_id: null,
    });
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
    await insertBacklogItem(adapter, {
      title: "dispatch-target-blocked ready item",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: null,
      dispatch_body: null,
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ready_item_blockers).toMatchObject({
      ready: 3,
      admissible: 0,
      actionable: 0,
      in_flight: 0,
      stale_ready_floor: true,
    });
    for (const category of health.ready_item_blockers.categories) {
      expect(category).toEqual(expect.objectContaining({
        owner: expect.any(String),
        reason_code: category.code,
        reason_text: expect.any(String),
        next_action: expect.any(String),
      }));
      expect(category.owner).not.toBe("");
      expect(category.reason_text).not.toBe("");
      expect(category.next_action).not.toBe("");
    }
    expect(health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "missing_dispatch_target",
        category: "dispatch_admission",
        owner: "orchestration_flesher",
        reason_code: "missing_dispatch_target",
        count: 1,
        examples: [expect.any(String)],
      }),
      expect.objectContaining({
        code: "blocked_dependency",
        category: "lane_eligibility",
        owner: "dependency_owner",
        reason_code: "blocked_dependency",
        count: 1,
        examples: [expect.any(String)],
      }),
      expect.objectContaining({
        code: "risk_requires_approval",
        category: "lane_eligibility",
        owner: "operator",
        reason_code: "risk_requires_approval",
        count: 1,
        examples: [expect.any(String)],
      }),
    ]);
  });

  it("does not render ready but inadmissible work with no in-flight rows as ok or idle", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "approval-blocked ready item",
      readiness_state: "ready",
      risk_class: "external",
      to_agent: "roger",
      dispatch_body: "continue",
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.orchestration_loop).toMatchObject({
      state: "blocked_backpressure",
      ready_count: 1,
      admissible_ready_count: 0,
      actionable_ready_count: 0,
      in_flight_count: 0,
      noop_tick_count: 0,
    });
    expect(health.orchestration_loop.state).not.toBe("idle_no_ready_work");
    expect(health.orchestration_loop.reason).toContain("risk_requires_approval=1");
    expect(health.ready_item_blockers.categories).not.toHaveLength(0);
    for (const category of health.ready_item_blockers.categories) {
      expect(category.reason_text.trim()).not.toBe("");
      expect(category.next_action.trim()).not.toBe("");
    }
  });

  it("treats raw ready fuel blocked only by write-scope locks as not useful fuel", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "active writer",
      readiness_state: "in_flight",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
      write_scope: ["repo/locked"],
    });
    for (let i = 0; i < 11; i += 1) {
      await insertBacklogItem(adapter, {
        title: `locked ready item ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: ["repo/locked"],
      });
    }

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.orchestration_loop).toMatchObject({
      state: "blocked_backpressure",
      raw_ready: 11,
      useful_ready: 0,
      admissible_now: 0,
      ready_count: 11,
      admissible_ready_count: 0,
      actionable_ready_count: 0,
      in_flight_count: 1,
    });
    expect(health.ready_item_blockers).toMatchObject({
      raw_ready: 11,
      useful_ready: 0,
      admissible_now: 0,
      ready: 11,
      admissible: 0,
      actionable: 0,
      stale_ready_floor: true,
      next_action: expect.stringMatching(/widen\/split|locks to clear/),
    });
    expect(health.ready_item_blockers.next_action).not.toMatch(/author filler/i);
    expect(health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "single_writer_lane_busy",
        count: 11,
      }),
    ]);
    expect(health.ready_item_blockers.top_blocking_lanes[0]).toMatchObject({
      lane: "repo/locked",
      code: "single_writer_lane_busy",
      count: 11,
    });
  });

  it("requests new-lane build fuel when ready rows are concentrated in an occupied lane", async () => {
    await setMode(adapter, "default", "running");
    const idAgentsLane = "/Users/kilgore/Dropbox/Code/cane/id-agents";
    for (const lane of [
      idAgentsLane,
      "/Users/kilgore/Dropbox/Code/cane/kapelle-site",
      "/Users/kilgore/Dropbox/Code/cane/finance",
    ]) {
      await insertBacklogItem(adapter, {
        title: `active writer for ${lane}`,
        readiness_state: "in_flight",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [lane],
      });
    }
    for (let i = 0; i < 12; i += 1) {
      await insertBacklogItem(adapter, {
        title: `id-agents ready item ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
        write_scope: [idAgentsLane],
      });
    }

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ready_item_blockers).toMatchObject({
      raw_ready: 12,
      useful_ready: 0,
      admissible_now: 0,
      in_flight: 3,
      stale_ready_floor: true,
    });
    expect(health.orchestration_loop.in_flight_count).toBe(3);
    expect(health.ready_item_blockers.next_action).toMatch(/new-lane build-ready fuel/i);
    expect(health.ready_item_blockers.next_action).not.toMatch(/filler/i);
    expect(health.ready_item_blockers.top_blocking_lanes[0]).toMatchObject({
      lane: idAgentsLane,
      code: "single_writer_lane_busy",
      count: 12,
    });
  });

  it("classifies ready backlog plus repeated no-op ticks as stalled_ready_not_launching", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "ready build work",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await recordTickOutcome(adapter, "default", { zero_ticks: 4, fired: false });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.orchestration_loop).toMatchObject({
      state: "stalled_ready_not_launching",
      ready_count: 1,
      actionable_ready_count: 1,
      noop_tick_count: 4,
      scheduler_loop_id: "continuous-orchestration:default",
    });
  });

  it("classifies zero ready work and no launches as idle_no_ready_work", async () => {
    await setMode(adapter, "default", "running");
    await recordTickOutcome(adapter, "default", { zero_ticks: 9, fired: false });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(true);
    expect(health.orchestration_loop).toMatchObject({
      state: "idle_no_ready_work",
      ready_count: 0,
      noop_tick_count: 9,
    });
  });

  it("classifies explicit capacity pressure as blocked_no_capacity instead of a silent stall", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "ready build work",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await appendDecisions(adapter, {
      team_id: "default",
      tick_id: "tick-capacity",
      dry_run: false,
      records: [{ item_id: null, action: "guardrail_halt", reason: "max in-flight capacity reached" }],
    });
    await recordTickOutcome(adapter, "default", { zero_ticks: 7, fired: false });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.orchestration_loop).toMatchObject({
      state: "blocked_no_capacity",
      ready_count: 1,
      actionable_ready_count: 1,
      in_flight_count: 0,
      noop_tick_count: 7,
      last_noop_reason: "max in-flight capacity reached",
    });
  });

  it("classifies explicitly blocked ready rows as blocked_backpressure instead of a silent stall", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "approval-blocked ready item",
      readiness_state: "ready",
      risk_class: "external",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await recordTickOutcome(adapter, "default", { zero_ticks: 170, fired: false });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(false);
    expect(health.orchestration_loop).toMatchObject({
      state: "blocked_backpressure",
      ready_count: 1,
      actionable_ready_count: 0,
      in_flight_count: 0,
      noop_tick_count: 170,
    });
  });

  it("keeps a scheduler that launched within the window in running state", async () => {
    await setMode(adapter, "default", "running");
    await insertBacklogItem(adapter, {
      title: "ready build work",
      readiness_state: "ready",
      risk_class: "build",
      to_agent: "roger",
      dispatch_body: "continue",
    });
    await recordTickOutcome(adapter, "default", { zero_ticks: 0, fired: true });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.ok).toBe(true);
    expect(health.orchestration_loop).toMatchObject({
      state: "running",
      ready_count: 1,
      actionable_ready_count: 1,
      noop_tick_count: 0,
    });
    expect(health.orchestration_loop.last_launch_at).toEqual(expect.any(String));
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

async function insertDispatch(overrides: Partial<{
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  status: string;
  body_markdown: string;
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
      overrides.body_markdown ?? "body",
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

async function insertManagerQuery(input: {
  query_id: string;
  prompt: string;
  created: number;
  completed?: number | null;
  result?: string | null;
  error?: string | null;
  manager_dispatch_id?: string | null;
  manager_query_id?: string | null;
}): Promise<void> {
  await adapter.query(
    `INSERT INTO teams (id, name) VALUES ('default', 'default')
     ON CONFLICT(id) DO NOTHING`,
    [],
  );
  await adapter.query(
    `INSERT INTO queries (
       team_id, agent_id, query_id, status, prompt, created, completed, result, error,
       session_id, owner_kind, owner_id, manager_dispatch_id, manager_query_id
     ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'manager', ?, ?, ?)`,
    [
      "default",
      input.query_id,
      input.completed == null ? "processing" : "completed",
      input.prompt,
      input.created,
      input.completed ?? null,
      input.result ?? null,
      input.error ?? null,
      "default",
      input.manager_dispatch_id ?? null,
      input.manager_query_id ?? null,
    ],
  );
}
