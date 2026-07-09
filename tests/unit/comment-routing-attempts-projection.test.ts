import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
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
  it("returns routed, failed, pending, and timed-out attempts with source refs and no duplicates", async () => {
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
        routed: 1,
        failed: 1,
        pending: 1,
        timeout: 1,
      },
    });
    expect(new Set(res.body.items.map((item: any) => item.attempt_id)).size).toBe(4);
    expect(res.body.items.map((item: any) => item.status).sort()).toEqual(["failed", "pending", "routed", "timeout"]);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "routed",
          task_id: "task-routed",
          comment_id: "cmt-routed",
          source_ref: "task:task-routed:comment:cmt-routed",
          target_agent: "roger",
          dispatch_phid: "phid:disp-routed",
          retry: expect.objectContaining({ available: false }),
        }),
        expect.objectContaining({
          status: "failed",
          task_id: "task-failed",
          comment_id: "cmt-failed",
          source_ref: "task:task-failed:comment:cmt-failed",
          target_agent: "regina",
          retry: expect.objectContaining({ available: true, source_ref: "task:task-failed:comment:cmt-failed" }),
        }),
        expect.objectContaining({
          status: "pending",
          task_id: "task-pending",
          comment_id: "cmt-pending",
          source_ref: "task:task-pending:comment:cmt-pending",
          target_agent: "cane",
          retry: expect.objectContaining({ available: true }),
        }),
        expect.objectContaining({
          status: "timeout",
          task_id: "task-timeout",
          comment_id: "cmt-timeout",
          source_ref: "task:task-timeout:comment:cmt-timeout",
          target_agent: "hopper",
          retry: expect.objectContaining({ available: true }),
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
