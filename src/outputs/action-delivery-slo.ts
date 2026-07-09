import type { DbAdapter } from "../db/db-adapter.js";
import type { ArtifactCommentRouteStatus } from "./types.js";

export const ACTION_DELIVERY_TIMEOUT_TOPIC = "action_delivery.timeout" as const;

export interface ActionDeliveryTimeoutSweepResult {
  scanned: number;
  timed_out: number;
  notifications_created: number;
  notifications_suppressed: number;
}

interface CommentDeliveryRow {
  artifact_id: string;
  op_id: number;
  actor: string;
  ts: string;
  payload_json: string | null;
}

function parsePayload(payloadJson: string | null): Record<string, unknown> {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseRouteStatus(value: unknown): ArtifactCommentRouteStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<ArtifactCommentRouteStatus>;
  if (!v.suppress_duplicate_key || !v.deadline_at || !v.notification_status) return null;
  return v as ArtifactCommentRouteStatus;
}

function isDue(status: ArtifactCommentRouteStatus, nowMs: number): boolean {
  if (status.notification_status !== "pending") return false;
  if (!status.deadline_at) return false;
  const deadlineMs = Date.parse(status.deadline_at);
  return Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
}

async function eventExists(adapter: DbAdapter, teamId: string, suppressDuplicateKey: string): Promise<boolean> {
  const { rows } = await adapter.query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM event_log
      WHERE team_id = ? AND topic = ? AND subject_id = ?`,
    [teamId, ACTION_DELIVERY_TIMEOUT_TOPIC, suppressDuplicateKey],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function insertTimeoutEvent(
  adapter: DbAdapter,
  input: {
    teamId: string;
    suppressDuplicateKey: string;
    actor: string;
    occurredAtMs: number;
    data: Record<string, unknown>;
  },
): Promise<boolean> {
  if (await eventExists(adapter, input.teamId, input.suppressDuplicateKey)) return false;
  await adapter.query(
    `INSERT INTO event_log
       (team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.teamId,
      ACTION_DELIVERY_TIMEOUT_TOPIC,
      input.actor,
      "action_delivery",
      input.suppressDuplicateKey,
      input.occurredAtMs,
      JSON.stringify(input.data),
    ],
  );
  return true;
}

async function updateRouteStatus(
  adapter: DbAdapter,
  artifactId: string,
  opId: number,
  payload: Record<string, unknown>,
  routeStatus: ArtifactCommentRouteStatus,
): Promise<void> {
  await adapter.query(
    `UPDATE artifact_operations
        SET payload_json = ?
      WHERE artifact_id = ? AND op_id = ? AND op_type = 'comment_recorded'`,
    [JSON.stringify({ ...payload, route_status: routeStatus }), artifactId, opId],
  );
}

export async function acknowledgeActionDelivery(
  adapter: DbAdapter,
  input: { artifactId: string; opId: number; now?: () => Date },
): Promise<ArtifactCommentRouteStatus | null> {
  const { rows } = await adapter.query<CommentDeliveryRow>(
    `SELECT artifact_id, op_id, actor, ts, payload_json
       FROM artifact_operations
      WHERE artifact_id = ? AND op_id = ? AND op_type = 'comment_recorded'`,
    [input.artifactId, input.opId],
  );
  const row = rows[0];
  if (!row) return null;
  const payload = parsePayload(row.payload_json);
  const routeStatus = parseRouteStatus(payload.route_status);
  if (!routeStatus || routeStatus.notification_status !== "pending") return routeStatus;
  const nowIso = (input.now ? input.now() : new Date()).toISOString();
  const next: ArtifactCommentRouteStatus = {
    ...routeStatus,
    notification_status: "acked",
    next_retry_at: null,
    updated_at: nowIso,
  };
  await updateRouteStatus(adapter, row.artifact_id, row.op_id, payload, next);
  return next;
}

export async function sweepActionDeliveryTimeouts(
  adapter: DbAdapter,
  input: { teamId?: string; now?: () => Date } = {},
): Promise<ActionDeliveryTimeoutSweepResult> {
  const teamId = input.teamId ?? "default";
  const now = input.now ? input.now() : new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const result: ActionDeliveryTimeoutSweepResult = {
    scanned: 0,
    timed_out: 0,
    notifications_created: 0,
    notifications_suppressed: 0,
  };

  const { rows } = await adapter.query<CommentDeliveryRow>(
    `SELECT artifact_id, op_id, actor, ts, payload_json
       FROM artifact_operations
      WHERE op_type = 'comment_recorded'
      ORDER BY op_id ASC`,
  );

  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    const routeStatus = parseRouteStatus(payload.route_status);
    if (!routeStatus) continue;
    result.scanned += 1;
    if (!isDue(routeStatus, nowMs)) continue;

    const timedOutStatus: ArtifactCommentRouteStatus = {
      ...routeStatus,
      visible_state: "recorded-but-route-failed-with-retry",
      retryable: true,
      timed_out_at: nowIso,
      notification_status: "sent",
      next_retry_at: null,
      updated_at: nowIso,
    };
    const created = await insertTimeoutEvent(adapter, {
      teamId,
      suppressDuplicateKey: routeStatus.suppress_duplicate_key,
      actor: "system:action-delivery-slo",
      occurredAtMs: nowMs,
      data: {
        artifact_id: row.artifact_id,
        op_id: row.op_id,
        actor: row.actor,
        route_kind: routeStatus.route_kind,
        dispatch: routeStatus.dispatch,
        deadline_at: routeStatus.deadline_at,
        timed_out_at: nowIso,
        notification_status: "sent",
        suppress_duplicate_key: routeStatus.suppress_duplicate_key,
      },
    });
    await updateRouteStatus(adapter, row.artifact_id, row.op_id, payload, timedOutStatus);
    result.timed_out += 1;
    if (created) result.notifications_created += 1;
    else result.notifications_suppressed += 1;
  }

  return result;
}
