import { describe, expect, it, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import type { TaskRow } from "../../src/db/types.js";
import {
  TASK_COMMENT_DISPATCH_CHANNEL,
  appendAndRouteTaskComment,
  listPendingTaskCommentEvents,
  listTaskCommentEvents,
  migrateTaskCommentTables,
  type TaskCommentEnqueueFn,
} from "../../src/tasks-readmodel/comment-router.js";

const TEAM = "team-task-comments";

const TASK: TaskRow = {
  id: "task_1",
  name: "reactor-build",
  uuid: "uuid-reactor",
  team_id: TEAM,
  title: "Build reactor",
  description: null,
  status: "doing",
  created_by: null,
  owner: "owner-agent",
  created_at: 1783538000,
  updated_at: 1783538000,
  completed_at: null,
  track: "T-RELY",
};

describe("task comment router", () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateTaskCommentTables(adapter);
  });

  it("creates one durable routed event and does not refire duplicates", async () => {
    const calls: Parameters<TaskCommentEnqueueFn>[0][] = [];
    const enqueue: TaskCommentEnqueueFn = async (input) => {
      calls.push(input);
      return { query_id: "query_task_comment", dispatch_phid: "phid:disp-task-comment", status: "queued" };
    };

    const first = await appendAndRouteTaskComment({
      adapter,
      enqueue,
      teamId: TEAM,
      task: TASK,
      actor: "user:chris",
      commentText: "Please route this note.",
      sourcePath: "/tmp/to-do.md",
      sourceLine: 42,
      nowMs: 1783539000000,
    });
    const second = await appendAndRouteTaskComment({
      adapter,
      enqueue,
      teamId: TEAM,
      task: TASK,
      actor: "user:chris",
      commentText: "Please route this note.",
      sourcePath: "/tmp/to-do.md",
      sourceLine: 42,
      nowMs: 1783539010000,
    });

    expect(first.routed).toBe(true);
    expect(first.event.route_state).toBe("routed");
    expect(first.event.dispatch_phid).toBe("phid:disp-task-comment");
    expect(second.deduped).toBe(true);
    expect(second.event.event_id).toBe(first.event.event_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      to_agent: "owner-agent",
      from_actor: "user:chris",
      channel: TASK_COMMENT_DISPATCH_CHANNEL,
      team_id: TEAM,
    });

    const events = await listTaskCommentEvents(adapter, TEAM, TASK.id);
    expect(events).toHaveLength(1);
    expect(events[0].source_path).toBe("/tmp/to-do.md");
    expect(events[0].source_line).toBe(42);
  });

  it("holds ownerless comments with a visible reason", async () => {
    const result = await appendAndRouteTaskComment({
      adapter,
      teamId: TEAM,
      task: { ...TASK, owner: null },
      actor: "user:liz",
      commentText: "Who owns this?",
      nowMs: 1783539000000,
    });

    expect(result.routed).toBe(false);
    expect("held_reason" in result && result.held_reason).toBe("task_owner_unknown");
    expect(result.event.route_state).toBe("held");
    const pending = await listPendingTaskCommentEvents(adapter, TEAM);
    expect(pending.map((e) => e.event_id)).toEqual([result.event.event_id]);
  });
});
