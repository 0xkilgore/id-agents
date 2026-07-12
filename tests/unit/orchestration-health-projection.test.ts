import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readOrchestrationHealthProjection } from "../../src/continuous-orchestration/health-projection.js";
import { insertBacklogItem, setItemState } from "../../src/continuous-orchestration/storage.js";
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

  it("counts acknowledgement and approval receipts as consumed noise while preserving failed and pending route signals", async () => {
    await migrateOutputsTables(adapter);
    await insertArtifact("art:signals:ack.md", "regina");
    await insertDispatch({
      dispatch_phid: "phid:disp-real-failure",
      query_id: "query_real_failure",
      status: "failed",
    });
    await insertDispatch({
      dispatch_phid: "phid:disp-pending-route",
      query_id: "query_pending_route",
      status: "queued",
    });

    await insertCommentOp({
      artifact_id: "art:signals:ack.md",
      actor: "user:chris",
      body: "acknowledged",
      reaction: "acknowledged",
      route_status: {
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
        updated_at: "2026-07-01T15:00:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:signals:ack.md",
      actor: "user:chris",
      body: "ship it",
      reaction: "ship_it",
      route_status: {
        visible_state: "recorded+routed",
        route_kind: "approval_signal",
        routed: false,
        retryable: false,
        recorded_op_id: 2,
        target_agent: "regina",
        target_agent_raw: "regina",
        dispatch: null,
        skipped: "approval_signal",
        error: null,
        updated_at: "2026-07-01T15:01:00.000Z",
      },
    });
    await insertCommentOp({
      artifact_id: "art:signals:ack.md",
      actor: "user:chris",
      body: "please route this to the owner",
      reaction: "iterate",
      route_status: {
        visible_state: "recorded-but-route-failed-with-retry",
        route_kind: "substantive_follow_up",
        routed: false,
        retryable: true,
        recorded_op_id: 3,
        target_agent: "regina",
        target_agent_raw: "regina",
        dispatch: null,
        skipped: null,
        error: { message: "scheduler unavailable" },
        updated_at: "2026-07-01T15:02:00.000Z",
      },
    });

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality).toMatchObject({
      operating_state: "blocked_or_failed",
      raw_queued: 1,
      actionable_ready: 0,
      duplicate_or_noop_backfill: 2,
      blocked_or_failed: 2,
    });
    expect(health.queue_quality.explanation).toContain("2 blocked or failed");
    expect(health.queue_quality.explanation).toContain("2 duplicate/no-op artifact acknowledgement(s)");
    expect(health.queue_quality.explanation).toContain("1 raw queued dispatch(es) are not ready fuel");
    expect(health.queue_quality.top_noise_patterns).toEqual([
      {
        pattern: "acknowledgement:regina:acknowledged",
        count: 1,
        examples: ["art:signals:ack.md#1"],
      },
      {
        pattern: "approval_signal:regina:approval_signal",
        count: 1,
        examples: ["art:signals:ack.md#2"],
      },
    ]);
  });

  it("reports zero ready plus held low-confidence rows as underfed, not healthy idle", async () => {
    const held = await insertBacklogItem(adapter, {
      title: "T-ORCH refuel candidate held by confidence",
      readiness_state: "needs_review",
      to_agent: "maestra",
      dispatch_body: "seed refuel rows",
      risk_class: "build",
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET flesh_status = ?, flesh_confidence = ?
        WHERE item_id = ?`,
      ["needs_chris_batch", 0.64, held.item_id],
    );

    const health = await readOrchestrationHealthProjection(adapter, "default");

    expect(health.queue_quality).toMatchObject({
      operating_state: "underfed_needs_fuel",
      ready_total: 0,
      actionable_ready: 0,
      held_low_confidence: 1,
    });
    expect(health.queue_quality.explanation).toContain("Underfed: 0 ready row(s)");
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
