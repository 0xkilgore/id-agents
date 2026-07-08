import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import crypto from "node:crypto";

import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteCheckinsRepo } from "../../src/db/repos/sqlite/checkins-repo.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { SqliteNewsRepo } from "../../src/db/repos/sqlite/news-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteSchedulesRepo } from "../../src/db/repos/sqlite/schedules-repo.js";
import { SqliteSubscriptionsRepo } from "../../src/db/repos/sqlite/subscriptions-repo.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";

const TEAM = "task-comment-route-test";

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

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

describe("POST /tasks/:ref/append-note", () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-comment-route-test-"));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM task_comment_events`);
    await db.adapter.query(`DELETE FROM event_log`);
    await db.adapter.query(`DELETE FROM tasks`);
  });

  it("records a task note once and exposes held state in task detail", async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, description, status, owner, created_at, updated_at, track)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`task_${crypto.randomUUID()}`, "comment-me", "uuid-comment-me", teamId, "Comment Me", null, "todo", null, now, now, "T-RELY"],
    );

    const body = {
      actor: "user:chris",
      comment: "Please route this task note.",
      source_path: "/tmp/to-do.md",
      source_line: 7,
    };
    const first = await fetch(`${baseUrl}/tasks/comment-me/append-note`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const duplicate = await fetch(`${baseUrl}/tasks/comment-me/append-note`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    expect(first).toMatchObject({
      ok: true,
      deduped: false,
      visible_state: "comment-held",
      route_state: "held",
      held_reason: "task_owner_unknown",
    });
    expect(duplicate).toMatchObject({ ok: true, deduped: true });

    const { rows: events } = await db.adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM task_comment_events`,
    );
    expect(Number(events[0].c)).toBe(1);
    const { rows: wakeups } = await db.adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM event_log WHERE topic = 'task:comment'`,
    );
    expect(Number(wakeups[0].c)).toBe(1);

    const detail = await fetch(`${baseUrl}/tasks/comment-me`, {
      headers: { "X-Id-Team": TEAM },
    }).then((r) => r.json());
    expect(detail.task.commentRouting).toMatchObject({
      visible_state: "comment-held",
      route_state: "held",
      held_reason: "task_owner_unknown",
    });
    expect(detail.task.commentHistory).toHaveLength(1);
    expect(detail.task.commentHistory[0]).toMatchObject({
      source_path: "/tmp/to-do.md",
      source_line: 7,
      actor: "user:chris",
    });
  });
});
