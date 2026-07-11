import { describe, expect, it } from "vitest";
import {
  TASK_COMMENT_INVALIDATED_VIEWS,
  buildTaskCommentOperationAck,
  projectTaskCommentOperationAcks,
  reduceTaskCommentOperationAck,
  seedTaskCommentProjection,
} from "../../src/task-comments/operations.js";

describe("task comment operation acks", () => {
  it("dedupes idempotent retries by clientOpId", () => {
    const first = buildTaskCommentOperationAck({
      type: "ADD_TASK_COMMENT",
      clientOpId: "client-op-1",
      taskId: "task-1",
      commentId: "comment-1",
      visibleState: "recorded-but-route-failed-with-retry",
    });
    const retry = buildTaskCommentOperationAck({
      type: "ROUTE_TASK_COMMENT",
      clientOpId: "client-op-1",
      taskId: "task-1",
      commentId: "comment-1",
      visibleState: "recorded+routed",
    });

    const state = projectTaskCommentOperationAcks([first, retry]);

    expect(state.visibleState).toBe("recorded-but-route-failed-with-retry");
    expect(state.appliedClientOpIds).toEqual(["client-op-1"]);
  });

  it("projects the four canonical visible states", () => {
    const add = buildTaskCommentOperationAck({
      type: "ADD_TASK_COMMENT",
      clientOpId: "add",
      taskId: "task-1",
      commentId: "comment-1",
      visibleState: "recorded+routed",
    });
    const retry = buildTaskCommentOperationAck({
      type: "QUEUE_COMMENT_ROUTE_RETRY",
      clientOpId: "retry",
      taskId: "task-1",
      commentId: "comment-1",
      visibleState: "recorded-but-route-failed-with-retry",
    });
    const terminal = buildTaskCommentOperationAck({
      type: "MARK_COMMENT_ROUTE_TERMINAL_FAILURE",
      clientOpId: "terminal",
      taskId: "task-1",
      commentId: "comment-1",
      visibleState: "terminal-failure",
    });

    expect(seedTaskCommentProjection().visibleState).toBe("not-recorded");
    expect(reduceTaskCommentOperationAck(seedTaskCommentProjection(), add).visibleState).toBe("recorded+routed");
    expect(projectTaskCommentOperationAcks([add, retry]).visibleState).toBe("recorded-but-route-failed-with-retry");
    expect(projectTaskCommentOperationAcks([add, retry, terminal]).visibleState).toBe("terminal-failure");
  });

  it("invalidates task detail, table, project, and timeline views", () => {
    const state = projectTaskCommentOperationAcks([
      buildTaskCommentOperationAck({
        type: "ADD_TASK_COMMENT",
        clientOpId: "invalidate-1",
        taskId: "task-1",
        commentId: "comment-1",
        visibleState: "recorded+routed",
      }),
    ]);

    expect(state.invalidatedViews).toEqual([...TASK_COMMENT_INVALIDATED_VIEWS]);
    expect(state.invalidatedViews).toEqual(["task_detail", "task_table", "project", "timeline"]);
  });
});
