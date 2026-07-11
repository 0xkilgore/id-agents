import type { TaskCommentOperationState, TaskCommentRoutingResult } from "./storage.js";

export type TaskCommentOperationType =
  | "ADD_TASK_COMMENT"
  | "ROUTE_TASK_COMMENT"
  | "QUEUE_COMMENT_ROUTE_RETRY"
  | "MARK_COMMENT_ROUTE_TERMINAL_FAILURE";

export const TASK_COMMENT_INVALIDATED_VIEWS = [
  "task_detail",
  "task_table",
  "project",
  "timeline",
] as const;

export type TaskCommentInvalidatedView = typeof TASK_COMMENT_INVALIDATED_VIEWS[number];

export interface TaskCommentOperationAck {
  type: TaskCommentOperationType;
  clientOpId: string;
  taskId: string;
  commentId: string;
  visibleState: TaskCommentOperationState;
  routingResults?: TaskCommentRoutingResult[];
  createdAt: string;
}

export interface TaskCommentCanonicalProjection {
  commentId: string | null;
  visibleState: TaskCommentOperationState;
  routed: boolean;
  retryQueued: boolean;
  terminalFailure: boolean;
  appliedClientOpIds: string[];
  invalidatedViews: TaskCommentInvalidatedView[];
}

export function seedTaskCommentProjection(): TaskCommentCanonicalProjection {
  return {
    commentId: null,
    visibleState: "not-recorded",
    routed: false,
    retryQueued: false,
    terminalFailure: false,
    appliedClientOpIds: [],
    invalidatedViews: [],
  };
}

export function reduceTaskCommentOperationAck(
  state: TaskCommentCanonicalProjection,
  ack: TaskCommentOperationAck,
): TaskCommentCanonicalProjection {
  if (state.appliedClientOpIds.includes(ack.clientOpId)) return state;

  const next: TaskCommentCanonicalProjection = {
    ...state,
    commentId: ack.commentId,
    visibleState: ack.visibleState,
    appliedClientOpIds: [...state.appliedClientOpIds, ack.clientOpId],
    invalidatedViews: unionInvalidatedViews(state.invalidatedViews),
  };

  switch (ack.type) {
    case "ADD_TASK_COMMENT":
      next.routed = ack.visibleState === "recorded+routed";
      next.retryQueued = ack.visibleState === "recorded-but-route-failed-with-retry";
      next.terminalFailure = ack.visibleState === "terminal-failure";
      break;
    case "ROUTE_TASK_COMMENT":
      next.routed = ack.visibleState === "recorded+routed";
      next.retryQueued = ack.visibleState === "recorded-but-route-failed-with-retry";
      next.terminalFailure = ack.visibleState === "terminal-failure";
      break;
    case "QUEUE_COMMENT_ROUTE_RETRY":
      next.routed = false;
      next.retryQueued = true;
      next.terminalFailure = false;
      next.visibleState = "recorded-but-route-failed-with-retry";
      break;
    case "MARK_COMMENT_ROUTE_TERMINAL_FAILURE":
      next.routed = false;
      next.retryQueued = false;
      next.terminalFailure = true;
      next.visibleState = "terminal-failure";
      break;
  }

  return next;
}

export function projectTaskCommentOperationAcks(
  acks: TaskCommentOperationAck[],
): TaskCommentCanonicalProjection {
  return acks.reduce(reduceTaskCommentOperationAck, seedTaskCommentProjection());
}

export function buildTaskCommentOperationAck(input: {
  type: TaskCommentOperationType;
  clientOpId: string | null | undefined;
  taskId: string;
  commentId: string;
  visibleState: TaskCommentOperationState;
  routingResults?: TaskCommentRoutingResult[];
  createdAt?: string;
}): TaskCommentOperationAck {
  return {
    type: input.type,
    clientOpId: normalizeClientOpId(input.clientOpId) ?? `${input.type}:${input.commentId}`,
    taskId: input.taskId,
    commentId: input.commentId,
    visibleState: input.visibleState,
    routingResults: input.routingResults ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function unionInvalidatedViews(existing: TaskCommentInvalidatedView[]): TaskCommentInvalidatedView[] {
  return [...new Set([...existing, ...TASK_COMMENT_INVALIDATED_VIEWS])];
}

function normalizeClientOpId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}
