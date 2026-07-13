import type { DbAdapter } from "../db/db-adapter.js";
import { artifactCommentId } from "../outputs/types.js";
import { parseRoutingResults, type TaskCommentRoutingStatus } from "../task-comments/storage.js";

export type CommentRouteAttemptStatus =
  | "retryable"
  | "retry-pending"
  | "routed"
  | "terminal-deadletter"
  | "disabled"
  | "not-recorded";
export type CommentRouteAttemptLegacyStatus = "pending" | "routed" | "failed" | "timeout";
export type CommentRouteAttemptSource = "artifact_comment" | "task_comment";

export interface CommentRouteAttempt {
  attempt_id: string;
  source: CommentRouteAttemptSource;
  status: CommentRouteAttemptStatus;
  legacy_status: CommentRouteAttemptLegacyStatus;
  artifact_id: string | null;
  task_id: string | null;
  task_name: string | null;
  comment_id: string;
  source_ref: string;
  target_agent: string | null;
  target_agent_raw: string | null;
  dispatch_phid: string | null;
  query_id: string | null;
  error: string | null;
  retryable: boolean;
  retry: {
    available: boolean;
    reason: string;
    source_ref: string;
    target_agent: string | null;
  };
  updated_at: string;
}

export interface CommentRouteAttemptsProjection {
  ok: true;
  schema_version: "comment.route_attempts.v1";
  counts: Record<CommentRouteAttemptStatus, number>;
  legacy_counts: Record<CommentRouteAttemptLegacyStatus, number>;
  items: CommentRouteAttempt[];
  count: number;
}

export interface CommentRouteAttemptsOptions {
  teamId?: string;
  now?: Date;
  timeoutAfterMs?: number;
  limit?: number;
  status?: CommentRouteAttemptStatus | "all";
}

const DEFAULT_TIMEOUT_AFTER_MS = 15 * 60 * 1000;

interface NormalizedTaskRouteResult {
  target_agent: string | null;
  target_agent_raw?: string | null;
  status: TaskCommentRoutingStatus;
  dispatch_phid: string | null;
  query_id: string | null;
  error: string | null;
  retryable?: boolean;
  routed_at: string | null;
}

export async function buildCommentRouteAttemptsProjection(
  adapter: DbAdapter,
  opts: CommentRouteAttemptsOptions = {},
): Promise<CommentRouteAttemptsProjection> {
  const now = opts.now ?? new Date();
  const timeoutAfterMs = opts.timeoutAfterMs ?? DEFAULT_TIMEOUT_AFTER_MS;
  const limit = clampLimit(opts.limit);
  const statusFilter = opts.status && opts.status !== "all" ? opts.status : null;
  const attempts = [
    ...(await artifactCommentRouteAttempts(adapter, now, timeoutAfterMs)),
    ...(await taskCommentRouteAttempts(adapter, opts.teamId ?? "default", now, timeoutAfterMs)),
  ];

  const deduped = new Map<string, CommentRouteAttempt>();
  for (const attempt of attempts) {
    if (!deduped.has(attempt.attempt_id)) deduped.set(attempt.attempt_id, attempt);
  }

  const items = [...deduped.values()]
    .filter((attempt) => (statusFilter ? attempt.status === statusFilter : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit);
  const counts: Record<CommentRouteAttemptStatus, number> = {
    retryable: 0,
    "retry-pending": 0,
    routed: 0,
    "terminal-deadletter": 0,
    disabled: 0,
    "not-recorded": 0,
  };
  const legacyCounts: Record<CommentRouteAttemptLegacyStatus, number> = {
    pending: 0,
    routed: 0,
    failed: 0,
    timeout: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
    legacyCounts[item.legacy_status] += 1;
  }

  return {
    ok: true,
    schema_version: "comment.route_attempts.v1",
    counts,
    legacy_counts: legacyCounts,
    items,
    count: items.length,
  };
}

async function artifactCommentRouteAttempts(
  adapter: DbAdapter,
  now: Date,
  timeoutAfterMs: number,
): Promise<CommentRouteAttempt[]> {
  const { rows } = await adapter.query<{
    op_id: number;
    artifact_id: string;
    ts: string;
    payload_json: string | null;
  }>(
    `SELECT op_id, artifact_id, ts, payload_json
     FROM artifact_operations
     WHERE op_type = 'comment_recorded'
     ORDER BY ts DESC, op_id DESC`,
  );
  const attempts: CommentRouteAttempt[] = [];
  for (const row of rows) {
    const routeStatus = parseArtifactRouteStatus(row.payload_json);
    if (!routeStatus) continue;
    if (isNoopAcknowledgementRoute(routeStatus)) continue;
    const commentId = artifactCommentId(row.artifact_id, Number(row.op_id));
    const sourceRef = `artifact:${row.artifact_id}:comment:${row.op_id}`;
    const legacyStatus = artifactLegacyStatus(routeStatus, now, timeoutAfterMs);
    const projectedStatus = artifactAttemptStatus(routeStatus, legacyStatus);
    const targetAgent = routeStatus.target_agent ?? routeStatus.dispatch?.to_agent ?? null;
    attempts.push(
      withRetry({
        attempt_id: `artifact:${row.artifact_id}:${row.op_id}:${targetAgent ?? "unassigned"}`,
        source: "artifact_comment",
        status: projectedStatus,
        legacy_status: legacyStatus,
        artifact_id: row.artifact_id,
        task_id: null,
        task_name: null,
        comment_id: commentId,
        source_ref: sourceRef,
        target_agent: targetAgent,
        target_agent_raw: routeStatus.target_agent_raw ?? targetAgent,
        dispatch_phid: routeStatus.dispatch?.dispatch_phid ?? null,
        query_id: routeStatus.dispatch?.query_id ?? null,
        error: routeStatus.error?.message ?? routeStatus.skipped ?? null,
        retryable: routeStatus.retryable,
        retry: placeholderRetry(),
        updated_at: routeStatus.updated_at || row.ts,
      }),
    );
  }
  return attempts;
}

async function taskCommentRouteAttempts(
  adapter: DbAdapter,
  teamId: string,
  now: Date,
  timeoutAfterMs: number,
): Promise<CommentRouteAttempt[]> {
  const { rows } = await adapter.query<{
    id: string;
    task_id: string;
    task_name: string;
    routing_status: string;
    routing_results_json: string;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, task_id, task_name, routing_status, routing_results_json, created_at, updated_at
     FROM task_comment_events
     WHERE team_id = ?
     ORDER BY updated_at DESC, created_at DESC`,
    [teamId],
  );
  const attempts: CommentRouteAttempt[] = [];
  for (const row of rows) {
    const results = parseRoutingResults(row.routing_results_json);
    const sourceRef = `task:${row.task_name}:comment:${row.id}`;
    const updatedAt = new Date(Number(row.updated_at || row.created_at)).toISOString();
    const fallbackStatus: TaskCommentRoutingStatus =
      row.routing_status === "routed" || row.routing_status === "failed" ? row.routing_status : "pending";
    const effectiveResults: NormalizedTaskRouteResult[] = results.length > 0
      ? results
      : [{
          target_agent: null,
          target_agent_raw: null,
          status: fallbackStatus,
          dispatch_phid: null,
          query_id: null,
          error: null,
          retryable: true,
          routed_at: null,
        }];
    for (const result of effectiveResults) {
      const retryable = result.retryable ?? result.status !== "routed";
      const projectedStatus = taskAttemptStatus(result.status, retryable);
      const legacyStatus = taskLegacyStatus(result.status, updatedAt, now, timeoutAfterMs);
      attempts.push(
        withRetry({
          attempt_id: `task:${row.id}:${result.target_agent ?? "unassigned"}`,
          source: "task_comment",
          status: projectedStatus,
          legacy_status: legacyStatus,
          artifact_id: null,
          task_id: row.task_id,
          task_name: row.task_name,
          comment_id: row.id,
          source_ref: sourceRef,
          target_agent: result.target_agent ?? null,
          target_agent_raw: result.target_agent_raw ?? result.target_agent ?? null,
          dispatch_phid: result.dispatch_phid ?? null,
          query_id: result.query_id ?? null,
          error: result.error ?? null,
          retryable,
          retry: placeholderRetry(),
          updated_at: result.routed_at ?? updatedAt,
        }),
      );
    }
  }
  return attempts;
}

function taskAttemptStatus(
  status: string,
  retryable: boolean,
): CommentRouteAttemptStatus {
  if (status === "routed") return "routed";
  if (status === "failed") return retryable ? "retryable" : "terminal-deadletter";
  return "retry-pending";
}

function taskLegacyStatus(
  status: string,
  updatedAt: string,
  now: Date,
  timeoutAfterMs: number,
): CommentRouteAttemptLegacyStatus {
  if (status === "routed") return "routed";
  if (status === "failed") return "failed";
  return isTimedOut(updatedAt, now, timeoutAfterMs) ? "timeout" : "pending";
}

function withRetry(attempt: CommentRouteAttempt): CommentRouteAttempt {
  const available = attempt.retryable && attempt.status !== "routed";
  return {
    ...attempt,
    retry: {
      available,
      reason: available ? "retryable_route_attempt" : "route_attempt_not_retryable",
      source_ref: attempt.source_ref,
      target_agent: attempt.target_agent,
    },
  };
}

function placeholderRetry(): CommentRouteAttempt["retry"] {
  return { available: false, reason: "unset", source_ref: "", target_agent: null };
}

function isTimedOut(updatedAt: string, now: Date, timeoutAfterMs: number): boolean {
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) && now.getTime() - ms >= timeoutAfterMs;
}

function clampLimit(input: number | undefined): number {
  if (input == null || !Number.isFinite(input)) return 200;
  return Math.max(1, Math.min(Math.floor(input), 500));
}

function parseArtifactRouteStatus(payloadJson: string | null): {
  routed: boolean;
  retryable: boolean;
  route_kind: string | null;
  target_agent: string | null;
  target_agent_raw: string | null;
  dispatch: { query_id: string; dispatch_phid: string; to_agent: string } | null;
  skipped: string | null;
  error: { message: string } | null;
  visible_state: string | null;
  feedback_status: string | null;
  updated_at: string;
} | null {
  try {
    const payload = payloadJson ? JSON.parse(payloadJson) as { route_status?: unknown } : {};
    const route = payload.route_status;
    if (!route || typeof route !== "object" || Array.isArray(route)) return null;
    const r = route as Record<string, unknown>;
    const dispatch = r.dispatch && typeof r.dispatch === "object" && !Array.isArray(r.dispatch)
      ? r.dispatch as Record<string, unknown>
      : null;
    const error = r.error && typeof r.error === "object" && !Array.isArray(r.error)
      ? r.error as Record<string, unknown>
      : null;
    return {
      routed: r.routed === true,
      retryable: r.retryable === true,
      route_kind: typeof r.route_kind === "string" ? r.route_kind : null,
      target_agent: typeof r.target_agent === "string" ? r.target_agent : null,
      target_agent_raw: typeof r.target_agent_raw === "string" ? r.target_agent_raw : null,
      dispatch: dispatch && typeof dispatch.dispatch_phid === "string" && typeof dispatch.to_agent === "string"
        ? {
            query_id: typeof dispatch.query_id === "string" ? dispatch.query_id : "",
            dispatch_phid: dispatch.dispatch_phid,
            to_agent: dispatch.to_agent,
          }
        : null,
      skipped: typeof r.skipped === "string" ? r.skipped : null,
      error: error && typeof error.message === "string" ? { message: error.message } : null,
      visible_state: typeof r.visible_state === "string" ? r.visible_state : null,
      feedback_status: typeof r.feedback_status === "string" ? r.feedback_status : null,
      updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
    };
  } catch {
    return null;
  }
}

function artifactAttemptStatus(
  routeStatus: NonNullable<ReturnType<typeof parseArtifactRouteStatus>>,
  legacyStatus: CommentRouteAttemptLegacyStatus,
): CommentRouteAttemptStatus {
  if (routeStatus.visible_state === "not-recorded") return "not-recorded";
  if (routeStatus.visible_state === "disabled/not-recorded" || routeStatus.feedback_status === "disabled/not-recorded") return "disabled";
  if (routeStatus.visible_state === "terminal-failure" || routeStatus.feedback_status === "terminal-failure") return "terminal-deadletter";
  if (routeStatus.routed) return "routed";
  if (!routeStatus.retryable) return "terminal-deadletter";
  return legacyStatus === "timeout" ? "retryable" : "retry-pending";
}

function artifactLegacyStatus(
  routeStatus: NonNullable<ReturnType<typeof parseArtifactRouteStatus>>,
  now: Date,
  timeoutAfterMs: number,
): CommentRouteAttemptLegacyStatus {
  if (routeStatus.routed) return "routed";
  if (routeStatus.retryable && isTimedOut(routeStatus.updated_at, now, timeoutAfterMs)) return "timeout";
  if (routeStatus.retryable) return "pending";
  return "failed";
}

function isNoopAcknowledgementRoute(routeStatus: NonNullable<ReturnType<typeof parseArtifactRouteStatus>>): boolean {
  return routeStatus.routed === false &&
    routeStatus.retryable === false &&
    (routeStatus.route_kind === "acknowledgement" ||
      routeStatus.route_kind === "approval_signal" ||
      routeStatus.skipped === "acknowledged" ||
      routeStatus.skipped === "approval_signal");
}
