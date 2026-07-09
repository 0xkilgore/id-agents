// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteNewsRepo } from "../../src/db/repos/sqlite/news-repo.js";
import { SqliteSchedulesRepo } from "../../src/db/repos/sqlite/schedules-repo.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { SqliteSubscriptionsRepo } from "../../src/db/repos/sqlite/subscriptions-repo.js";
import { SqliteCheckinsRepo } from "../../src/db/repos/sqlite/checkins-repo.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectRouteTimeout(input: string, init?: RequestInit) {
  const startedAt = Date.now();
  const res = await fetch(input, init);
  const elapsed = Date.now() - startedAt;
  expect(res.status).toBe(504);
  expect(elapsed).toBeLessThan(500);

  const body = await res.json() as any;
  expect(body).toMatchObject({
    ok: false,
    code: "route_timeout",
    action_status: "timed_out",
  });
  return body;
}

function delayMatchingSqlOnce(
  adapter: SqliteAdapter,
  matches: (sql: string) => boolean,
  delayMs = 50,
): () => void {
  const original = adapter.query.bind(adapter);
  let delayed = false;
  (adapter as any).query = (async (sql: string, ...args: any[]) => {
    const normalizedSql = String(sql).replace(/\s+/g, " ").trim();
    if (!delayed && matches(normalizedSql)) {
      delayed = true;
      await sleep(delayMs);
    }
    return original(sql, ...args);
  }) as typeof adapter.query;
  return () => {
    (adapter as any).query = original as typeof adapter.query;
  };
}

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

describe("manager durable state route timeouts", () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let previousFeedbackFlag: string | undefined;

  beforeAll(async () => {
    previousFeedbackFlag = process.env.C0_FEEDBACK_REACTIONS;
    process.env.C0_FEEDBACK_REACTIONS = "1";
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-route-timeout-"));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    await db.close();
    if (previousFeedbackFlag === undefined) {
      delete process.env.C0_FEEDBACK_REACTIONS;
    } else {
      process.env.C0_FEEDBACK_REACTIONS = previousFeedbackFlag;
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns a typed 504 instead of hanging when a task state route exceeds its caller bound", async () => {
    const originalList = db.tasks.list.bind(db.tasks);
    db.tasks.list = (async (...args: Parameters<typeof db.tasks.list>) => {
      await sleep(50);
      return originalList(...args);
    }) as typeof db.tasks.list;

    try {
      const startedAt = Date.now();
      const res = await fetch(`${baseUrl}/tasks?timeout_ms=5`);
      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(504);
      expect(elapsed).toBeLessThan(500);

      const body = await res.json() as any;
      expect(body).toMatchObject({
        ok: false,
        code: "route_timeout",
        action_status: "timed_out",
        route: "/tasks",
        method: "GET",
        timeout_ms: 5,
      });
    } finally {
      db.tasks.list = originalList as typeof db.tasks.list;
    }

    const healthy = await fetch(`${baseUrl}/tasks?timeout_ms=1000`);
    expect(healthy.status).toBe(200);
    const healthyBody = await healthy.json() as any;
    expect(healthyBody.ok).toBe(true);
  });

  it("bounds artifact list reads with the same typed route timeout state", async () => {
    const restore = delayMatchingSqlOnce(
      db.adapter,
      (sql) => /\bFROM artifacts\b/i.test(sql) && /\bORDER BY produced_at DESC\b/i.test(sql),
    );
    try {
      const body = await expectRouteTimeout(`${baseUrl}/artifacts/entries?timeout_ms=5`);
      expect(body).toMatchObject({
        route: "/artifacts/entries",
        method: "GET",
        timeout_ms: 5,
      });
    } finally {
      restore();
    }

    const healthy = await fetch(`${baseUrl}/artifacts/entries?timeout_ms=1000`);
    expect(healthy.status).toBe(200);
    const healthyBody = await healthy.json() as any;
    expect(healthyBody.schema_version).toBe("read-model.v1");
  });

  it("bounds artifact comment writes with a useful timeout state", async () => {
    const restore = delayMatchingSqlOnce(
      db.adapter,
      (sql) => /\bFROM artifact_review_state\b/i.test(sql),
    );
    try {
      const body = await expectRouteTimeout(`${baseUrl}/artifacts/art-timeout-comment/comments?timeout_ms=5`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor_ref: "user:chris",
          body: "Please tighten this section.",
          idempotency_key: "timeout-comment-1",
        }),
      });
      expect(body).toMatchObject({
        route: "/artifacts/art-timeout-comment/comments",
        method: "POST",
        timeout_ms: 5,
        idempotency_key: "timeout-comment-1",
      });
    } finally {
      restore();
    }

    const healthy = await fetch(`${baseUrl}/artifacts/art-timeout-comment/comments?timeout_ms=1000`);
    expect(healthy.status).toBe(200);
    const healthyBody = await healthy.json() as any;
    expect(healthyBody).toMatchObject({
      ok: true,
      schema_version: "artifact.comments.v1",
      artifact_id: "art-timeout-comment",
    });
  });

  it("bounds dispatch state reads with the same typed route timeout state", async () => {
    const restore = delayMatchingSqlOnce(
      db.adapter,
      (sql) => sql.includes("FROM dispatch_scheduler_queue"),
    );
    try {
      const body = await expectRouteTimeout(`${baseUrl}/dispatches?status=active&timeout_ms=5`);
      expect(body).toMatchObject({
        route: "/dispatches",
        method: "GET",
        timeout_ms: 5,
      });
    } finally {
      restore();
    }

    const healthy = await fetch(`${baseUrl}/dispatches?status=active&timeout_ms=1000`);
    expect(healthy.status).toBe(200);
    const healthyBody = await healthy.json() as any;
    expect(healthyBody).toMatchObject({
      ok: true,
      status: "active",
    });
  });
});
