import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDispatchHealth } from "../../src/dispatch-scheduler/read-model.js";
import { readOrchestrationHealthProjection } from "../../src/continuous-orchestration/health-projection.js";
import { insertBacklogItem, recordTickOutcome, setItemState, setMode } from "../../src/continuous-orchestration/storage.js";
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

    expect(health.blockers.needs_clarification.count).toBe(2);
    expect(health.blockers.needs_clarification.recent_dispatch_ids).toEqual([
      "phid:disp-expired-but-blocks",
      "phid:disp-operator-input",
    ]);
    expect(health.blockers.needs_clarification.blocks_backlog_dependency_count).toBe(1);
    expect(health.blockers.needs_clarification.items).toEqual([
      expect.objectContaining({
        dispatch_phid: "phid:disp-expired-but-blocks",
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
      },
      {
        code: "risk_requires_approval",
        category: "lane_eligibility",
        count: 1,
        examples: [expect.any(String)],
      },
    ]);
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
