import type { ArtifactCommentRouteStatus } from "./types.js";
import type { ArtifactCommentRouteKind, CommentDispatchResult } from "./comment-dispatch.js";

export type ArtifactReviewDocumentOperationType =
  | "assign_reviewer"
  | "comment"
  | "react"
  | "approve"
  | "reject"
  | "request_changes"
  | "mark_read"
  | "link_task"
  | "create_followup";

export interface ArtifactReviewDocumentOperation {
  id: string;
  artifact_id: string;
  type: ArtifactReviewDocumentOperationType;
  actor_ref: string;
  created_at: string;
  idempotency_key?: string | null;
  payload?: Record<string, unknown>;
}

export interface ArtifactReviewProjectionCursor {
  last_operation_id: string | null;
  last_created_at: string | null;
  applied_count: number;
}

export interface ArtifactReviewDocumentState {
  artifact_id: string;
  reviewer_ref: string | null;
  read_by: Record<string, string>;
  status: "unread" | "read" | "approved" | "rejected" | "changes_requested";
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  request_changes_at: string | null;
  request_changes_by: string | null;
  comments: ArtifactReviewDocumentComment[];
  reactions: ArtifactReviewDocumentReaction[];
  linked_tasks: ArtifactReviewLinkedTask[];
  followups: ArtifactReviewFollowup[];
  operation_ids: string[];
  idempotency_keys: string[];
  projection_cursor: ArtifactReviewProjectionCursor;
}

export interface ArtifactReviewDocumentComment {
  operation_id: string;
  actor_ref: string;
  created_at: string;
  body: string;
  anchor: string | null;
  route_status: ArtifactCommentRouteStatus | null;
}

export interface ArtifactReviewDocumentReaction {
  operation_id: string;
  actor_ref: string;
  created_at: string;
  reaction: string;
  note: string | null;
}

export interface ArtifactReviewLinkedTask {
  operation_id: string;
  task_ref: string;
  actor_ref: string;
  created_at: string;
  note: string | null;
}

export interface ArtifactReviewFollowup {
  operation_id: string;
  task_ref: string | null;
  dispatch_ref: string | null;
  actor_ref: string;
  created_at: string;
  title: string | null;
}

export function initialArtifactReviewDocumentState(artifactId: string): ArtifactReviewDocumentState {
  return {
    artifact_id: artifactId,
    reviewer_ref: null,
    read_by: {},
    status: "unread",
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    rejected_by: null,
    request_changes_at: null,
    request_changes_by: null,
    comments: [],
    reactions: [],
    linked_tasks: [],
    followups: [],
    operation_ids: [],
    idempotency_keys: [],
    projection_cursor: { last_operation_id: null, last_created_at: null, applied_count: 0 },
  };
}

export function projectArtifactReviewOperations(
  artifactId: string,
  operations: ArtifactReviewDocumentOperation[],
  seed: ArtifactReviewDocumentState = initialArtifactReviewDocumentState(artifactId),
): ArtifactReviewDocumentState {
  return operations.reduce((state, op) => reduceArtifactReviewOperation(state, op), seed);
}

export function reduceArtifactReviewOperation(
  state: ArtifactReviewDocumentState,
  op: ArtifactReviewDocumentOperation,
): ArtifactReviewDocumentState {
  if (op.artifact_id !== state.artifact_id) return state;
  if (state.operation_ids.includes(op.id)) return state;
  const key = normalizedString(op.idempotency_key);
  if (key && state.idempotency_keys.includes(key)) return state;

  const next = cloneState(state);
  next.operation_ids.push(op.id);
  if (key) next.idempotency_keys.push(key);
  next.projection_cursor = {
    last_operation_id: op.id,
    last_created_at: op.created_at,
    applied_count: next.projection_cursor.applied_count + 1,
  };

  switch (op.type) {
    case "assign_reviewer":
      next.reviewer_ref = normalizedString(op.payload?.reviewer_ref) ?? op.actor_ref;
      break;
    case "mark_read":
      next.read_by[op.actor_ref] = op.created_at;
      if (next.status === "unread") next.status = "read";
      break;
    case "comment":
      next.comments.push({
        operation_id: op.id,
        actor_ref: op.actor_ref,
        created_at: op.created_at,
        body: normalizedString(op.payload?.body) ?? "",
        anchor: normalizedString(op.payload?.anchor),
        route_status: parseRouteStatus(op.payload?.route_status),
      });
      break;
    case "react":
      next.reactions.push({
        operation_id: op.id,
        actor_ref: op.actor_ref,
        created_at: op.created_at,
        reaction: normalizedString(op.payload?.reaction) ?? "acknowledged",
        note: normalizedString(op.payload?.note),
      });
      break;
    case "approve":
      next.status = "approved";
      next.approved_at = op.created_at;
      next.approved_by = op.actor_ref;
      break;
    case "reject":
      next.status = "rejected";
      next.rejected_at = op.created_at;
      next.rejected_by = op.actor_ref;
      break;
    case "request_changes":
      next.status = "changes_requested";
      next.request_changes_at = op.created_at;
      next.request_changes_by = op.actor_ref;
      break;
    case "link_task": {
      const taskRef = normalizedString(op.payload?.task_ref);
      if (taskRef) {
        next.linked_tasks.push({
          operation_id: op.id,
          task_ref: taskRef,
          actor_ref: op.actor_ref,
          created_at: op.created_at,
          note: normalizedString(op.payload?.note),
        });
      }
      break;
    }
    case "create_followup":
      next.followups.push({
        operation_id: op.id,
        task_ref: normalizedString(op.payload?.task_ref),
        dispatch_ref: normalizedString(op.payload?.dispatch_ref),
        actor_ref: op.actor_ref,
        created_at: op.created_at,
        title: normalizedString(op.payload?.title),
      });
      break;
  }

  return next;
}

export function commentRouteStatusFromDispatchResult(
  routeKind: ArtifactCommentRouteKind,
  result: CommentDispatchResult,
  recordedOpId: number,
  updatedAt: string,
): ArtifactCommentRouteStatus {
  if (result.routed) {
    return {
      visible_state: "recorded+routed",
      route_kind: routeKind,
      routed: true,
      retryable: false,
      recorded_op_id: recordedOpId,
      target_agent: result.dispatch.to_agent,
      target_agent_raw: result.dispatch.to_agent_raw ?? result.dispatch.to_agent,
      dispatch: {
        query_id: result.dispatch.query_id,
        dispatch_phid: result.dispatch.dispatch_phid,
        to_agent: result.dispatch.to_agent,
      },
      skipped: null,
      error: null,
      updated_at: updatedAt,
    };
  }
  const skipped = "skipped" in result ? result.skipped : null;
  const isPolicySkip = skipped === "acknowledged" || skipped === "approval_signal" || skipped === "question_threaded";
  return {
    visible_state: isPolicySkip ? "recorded+routed" : "recorded-but-route-failed-with-retry",
    route_kind: routeKind,
    routed: false,
    retryable: !isPolicySkip,
    recorded_op_id: recordedOpId,
    target_agent: "target_agent" in result && typeof result.target_agent === "string" ? result.target_agent : null,
    target_agent_raw: "target_agent_raw" in result && typeof result.target_agent_raw === "string" ? result.target_agent_raw : null,
    dispatch: null,
    skipped,
    error: "error" in result ? result.error : null,
    updated_at: updatedAt,
  };
}

function cloneState(state: ArtifactReviewDocumentState): ArtifactReviewDocumentState {
  return {
    ...state,
    read_by: { ...state.read_by },
    comments: state.comments.map((c) => ({ ...c })),
    reactions: state.reactions.map((r) => ({ ...r })),
    linked_tasks: state.linked_tasks.map((l) => ({ ...l })),
    followups: state.followups.map((f) => ({ ...f })),
    operation_ids: [...state.operation_ids],
    idempotency_keys: [...state.idempotency_keys],
    projection_cursor: { ...state.projection_cursor },
  };
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseRouteStatus(value: unknown): ArtifactCommentRouteStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ArtifactCommentRouteStatus>;
  if (
    v.visible_state !== "recorded+routed" &&
    v.visible_state !== "recorded-but-route-failed-with-retry" &&
    v.visible_state !== "not-recorded"
  ) return null;
  return v as ArtifactCommentRouteStatus;
}
