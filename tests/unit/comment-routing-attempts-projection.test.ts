import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { appendOperation, migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import type { TaskCommentRoutingResult } from "../../src/task-comments/storage.js";

const NOW = new Date("2026-07-08T18:00:00.000Z");
const TEAM = "default";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, {
    now: () => NOW,
    resolveTeamId: async () => TEAM,
    actionCooldownMs: 0,
  });
});

describe("GET /comment-routing/attempts", () => {
  it("returns routed, retryable, retry-pending, and timed-out attempts with source refs and no duplicates", async () => {
    await seedTaskComment("cmt-routed", "task-routed", "routed", [
      routeResult({ target_agent: "roger", status: "routed", dispatch_phid: "phid:disp-routed", query_id: "query_routed", retryable: false }),
    ]);
    await seedTaskComment("cmt-failed", "task-failed", "failed", [
      routeResult({ target_agent: "regina", status: "failed", error: "scheduler boom", retryable: true }),
    ]);
    await seedTaskComment("cmt-pending", "task-pending", "pending", [
      routeResult({ target_agent: "cane", status: "pending", error: "scheduler_unavailable", retryable: true }),
    ]);
    await seedTaskComment("cmt-timeout", "task-timeout", "pending", [
      routeResult({ target_agent: "hopper", status: "pending", error: "scheduler_unavailable", retryable: true }),
    ], NOW.getTime() - 60 * 60 * 1000);

    const res = await call("GET", "/comment-routing/attempts?timeout_after_ms=900000");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      schema_version: "comment.route_attempts.v1",
      count: 4,
      counts: {
        retryable: 1,
        "retry-pending": 2,
        routed: 1,
        "terminal-deadletter": 0,
        disabled: 0,
        "not-recorded": 0,
      },
      legacy_counts: {
        routed: 1,
        failed: 1,
        pending: 1,
        timeout: 1,
      },
    });
    expect(new Set(res.body.items.map((item: any) => item.attempt_id)).size).toBe(4);
    expect(res.body.items.map((item: any) => item.status).sort()).toEqual(["retry-pending", "retry-pending", "retryable", "routed"]);
    expect(res.body.items.map((item: any) => item.legacy_status).sort()).toEqual(["failed", "pending", "routed", "timeout"]);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "routed",
          legacy_status: "routed",
          task_id: "task-routed",
          comment_id: "cmt-routed",
          source_ref: "task:task-routed:comment:cmt-routed",
          target_agent: "roger",
          dispatch_phid: "phid:disp-routed",
          retry: expect.objectContaining({ available: false }),
        }),
        expect.objectContaining({
          status: "retryable",
          legacy_status: "failed",
          task_id: "task-failed",
          comment_id: "cmt-failed",
          source_ref: "task:task-failed:comment:cmt-failed",
          target_agent: "regina",
          retry: expect.objectContaining({ available: true, source_ref: "task:task-failed:comment:cmt-failed" }),
        }),
        expect.objectContaining({
          status: "retry-pending",
          legacy_status: "pending",
          task_id: "task-pending",
          comment_id: "cmt-pending",
          source_ref: "task:task-pending:comment:cmt-pending",
          target_agent: "cane",
          retry: expect.objectContaining({ available: true }),
        }),
        expect.objectContaining({
          status: "retry-pending",
          legacy_status: "timeout",
          task_id: "task-timeout",
          comment_id: "cmt-timeout",
          source_ref: "task:task-timeout:comment:cmt-timeout",
          target_agent: "hopper",
          retry: expect.objectContaining({ available: true }),
        }),
      ]),
    );
  });

  it("separates terminal feedback outbox buckets for /ops counters", async () => {
    await seedTaskComment("cmt-terminal", "task-terminal", "failed", [
      routeResult({ target_agent: "retired", status: "failed", error: "target_agent_unresolved", retryable: false }),
    ]);
    await seedArtifactComment("art-routed", 1, {
      visible_state: "recorded+routed",
      feedback_status: "recorded+routed",
      routed: true,
      retryable: false,
      target_agent: "roger",
      dispatch: { query_id: "query_art", dispatch_phid: "phid:disp-art", to_agent: "roger" },
      updated_at: NOW.toISOString(),
    });
    await seedArtifactComment("art-disabled", 2, {
      visible_state: "disabled/not-recorded",
      feedback_status: "disabled/not-recorded",
      routed: false,
      retryable: false,
      skipped: "c0_feedback_reactions_disabled",
      updated_at: NOW.toISOString(),
    });
    await seedArtifactComment("art-not-recorded", 3, {
      visible_state: "not-recorded",
      feedback_status: "disabled/not-recorded",
      routed: false,
      retryable: false,
      skipped: "comment_write_failed",
      updated_at: NOW.toISOString(),
    });
    await seedArtifactComment("art-deadletter", 4, {
      visible_state: "terminal-failure",
      feedback_status: "terminal-failure",
      routed: false,
      retryable: false,
      target_agent: "retired",
      error: { message: "target agent retired no longer exists" },
      updated_at: NOW.toISOString(),
    });

    const res = await call("GET", "/comment-routing/attempts");

    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({
      retryable: 0,
      "retry-pending": 0,
      routed: 1,
      "terminal-deadletter": 2,
      disabled: 1,
      "not-recorded": 1,
    });
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "routed", artifact_id: "art-routed" }),
        expect.objectContaining({ status: "disabled", artifact_id: "art-disabled" }),
        expect.objectContaining({ status: "not-recorded", artifact_id: "art-not-recorded" }),
        expect.objectContaining({ status: "terminal-deadletter", artifact_id: "art-deadletter" }),
        expect.objectContaining({ status: "terminal-deadletter", task_id: "task-terminal" }),
      ]),
    );

    const filtered = await call("GET", "/comment-routing/attempts?status=terminal-deadletter");
    expect(filtered.body.count).toBe(2);
    expect(filtered.body.items.every((item: any) => item.status === "terminal-deadletter")).toBe(true);
  });

  it("contracts retry drain states for queued retry, routed retry, terminal failure, disabled route, and duplicate acknowledgement", async () => {
    await seedArtifactComment("artifact-queued", {
      routed: false,
      retryable: true,
      target_agent: "regina",
      target_agent_raw: "project:kapelle",
      error: { message: "route_failed_retryable" },
      updated_at: "2026-07-08T17:59:00.000Z",
    });
    await seedArtifactComment("artifact-routed-retry", {
      routed: true,
      retryable: false,
      target_agent: "regina",
      dispatch: { dispatch_phid: "phid:disp-routed-retry", query_id: "query_routed_retry", to_agent: "regina" },
      updated_at: "2026-07-08T17:58:00.000Z",
    });
    await seedArtifactComment("artifact-terminal", {
      routed: false,
      retryable: false,
      target_agent: "retired-agent",
      error: { message: "target agent retired-agent no longer exists" },
      updated_at: "2026-07-08T17:57:00.000Z",
    });
    await seedArtifactComment("artifact-disabled", {
      routed: false,
      retryable: false,
      target_agent: "regina",
      skipped: "CO_FEEDBACK_REACTIONS_DISABLED",
      error: { message: "CO_FEEDBACK_REACTIONS_DISABLED" },
      updated_at: "2026-07-08T17:56:00.000Z",
    });
    await seedArtifactComment("artifact-ack-duplicate", {
      route_kind: "acknowledgement",
      routed: false,
      retryable: false,
      target_agent: null,
      skipped: "acknowledged",
      updated_at: "2026-07-08T17:55:00.000Z",
    });

    const res = await call("GET", "/comment-routing/attempts?timeout_after_ms=900000");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      schema_version: "comment.route_attempts.v1",
      count: 4,
      counts: {
        retryable: 0,
        "retry-pending": 1,
        routed: 1,
        "terminal-deadletter": 2,
        disabled: 0,
        "not-recorded": 0,
      },
      legacy_counts: {
        pending: 1,
        routed: 1,
        failed: 2,
        timeout: 0,
      },
    });
    expect(res.body.items.map((item: any) => item.artifact_id).sort()).toEqual([
      "artifact-disabled",
      "artifact-queued",
      "artifact-routed-retry",
      "artifact-terminal",
    ]);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact_id: "artifact-queued",
          status: "retry-pending",
          target_agent: "regina",
          target_agent_raw: "project:kapelle",
          retry: expect.objectContaining({ available: true, reason: "retryable_route_attempt" }),
        }),
        expect.objectContaining({
          artifact_id: "artifact-routed-retry",
          status: "routed",
          dispatch_phid: "phid:disp-routed-retry",
          query_id: "query_routed_retry",
          retry: expect.objectContaining({ available: false }),
        }),
        expect.objectContaining({
          artifact_id: "artifact-terminal",
          status: "terminal-deadletter",
          error: "target agent retired-agent no longer exists",
          retryable: false,
          retry: expect.objectContaining({ available: false }),
        }),
        expect.objectContaining({
          artifact_id: "artifact-disabled",
          status: "terminal-deadletter",
          error: "CO_FEEDBACK_REACTIONS_DISABLED",
          retryable: false,
          retry: expect.objectContaining({ available: false }),
        }),
      ]),
    );
  });
});

function routeResult(overrides: Partial<TaskCommentRoutingResult> & { target_agent: string; status: TaskCommentRoutingResult["status"] }): TaskCommentRoutingResult {
  return {
    target_agent: overrides.target_agent,
    target_agent_raw: overrides.target_agent_raw ?? overrides.target_agent,
    status: overrides.status,
    dispatch_phid: overrides.dispatch_phid ?? null,
    query_id: overrides.query_id ?? null,
    error: overrides.error ?? null,
    retryable: overrides.retryable ?? overrides.status !== "routed",
    routed_at: overrides.routed_at ?? null,
  };
}

async function seedTaskComment(
  id: string,
  taskName: string,
  routingStatus: string,
  results: TaskCommentRoutingResult[],
  updatedAt = NOW.getTime(),
): Promise<void> {
  await adapter.query(
    `INSERT INTO task_comment_events (
      id, team_id, task_id, task_uuid, task_name, task_title,
      source_path, source_line, comment_text, actor, occurred_at,
      hash, event_seq, routing_status, routing_results_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      id,
      TEAM,
      taskName,
      taskName,
      `Title ${taskName}`,
      `Comment ${id}`,
      "user:chris",
      updatedAt,
      `hash-${id}`,
      routingStatus,
      JSON.stringify(results),
      updatedAt,
      updatedAt,
    ],
  );
}

async function seedArtifactComment(
  artifactId: string,
  opIdHintOrRouteStatus: number | Record<string, unknown>,
  maybeRouteStatus?: Record<string, unknown>,
): Promise<void> {
  const opIdHint = typeof opIdHintOrRouteStatus === "number" ? opIdHintOrRouteStatus : 0;
  const routeStatus = typeof opIdHintOrRouteStatus === "number" ? maybeRouteStatus ?? {} : opIdHintOrRouteStatus;
  await appendOperation(
    adapter,
    artifactId,
    "comment_recorded",
    "user:chris",
    new Date(NOW.getTime() + opIdHint).toISOString(),
    JSON.stringify({ body: `Artifact comment ${opIdHint}`, route_status: routeStatus }),
    null,
    null,
  );
}

async function call(method: "GET", path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method });
        const text = await response.text();
        const parsed = text ? JSON.parse(text) : null;
        server.close(() => resolve({ status: response.status, body: parsed }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}
