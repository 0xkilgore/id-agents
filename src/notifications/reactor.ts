import type { DbAdapter } from "../db/db-adapter.js";
import { migrateDeskTables, upsertDeskItem } from "../desk/storage.js";

export type NotificationReason =
  | "dispatch_expired"
  | "target_unavailable"
  | "provider_rate_exhausted"
  | "route_failure"
  | "action_delivery_timeout";

export type NotificationClassification = "retryable" | "terminal";

export interface NotificationSourceRefs {
  dispatch_id?: string | null;
  query_id?: string | null;
  task_id?: string | null;
  artifact_id?: string | null;
  action_id?: string | null;
}

export interface NotificationReactorEventInput {
  team_id: string;
  reason: NotificationReason;
  classification: NotificationClassification;
  owner_route: string;
  source: NotificationSourceRefs;
  occurred_at: string;
  safe_message: string;
}

export interface NotificationReactorEvent {
  notification_id: string;
  topic: "notification:raised";
  team_id: string;
  reason: NotificationReason;
  classification: NotificationClassification;
  owner_route: string;
  source: NotificationSourceRefs;
  occurred_at: string;
  safe_message: string;
}

export function notificationId(input: NotificationReactorEventInput): string {
  const source =
    input.source.dispatch_id ??
    input.source.query_id ??
    input.source.task_id ??
    input.source.artifact_id ??
    input.source.action_id ??
    "unknown";
  return `notif_${input.reason}_${input.classification}_${source}`.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

export function buildNotificationEvent(input: NotificationReactorEventInput): NotificationReactorEvent {
  return {
    notification_id: notificationId(input),
    topic: "notification:raised",
    team_id: input.team_id,
    reason: input.reason,
    classification: input.classification,
    owner_route: input.owner_route,
    source: {
      dispatch_id: input.source.dispatch_id ?? null,
      query_id: input.source.query_id ?? null,
      task_id: input.source.task_id ?? null,
      artifact_id: input.source.artifact_id ?? null,
      action_id: input.source.action_id ?? null,
    },
    occurred_at: input.occurred_at,
    safe_message: operatorSafeMessage(input),
  };
}

export function operatorSafeMessage(input: NotificationReactorEventInput): string {
  const fallback = defaultMessage(input.reason, input.classification, input.owner_route);
  const text = sanitizeMessage(input.safe_message) || fallback;
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function sanitizeMessage(raw: string): string {
  return raw
    .replace(/\s+at\s+.+:\d+:\d+\)?/g, "")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b[A-Za-z]:?\/[^\s]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultMessage(reason: NotificationReason, classification: NotificationClassification, ownerRoute: string): string {
  switch (reason) {
    case "dispatch_expired":
      return classification === "retryable"
        ? `Dispatch timed out before a usable agent handoff on ${ownerRoute}; it is queued for retry.`
        : `Dispatch expired on ${ownerRoute}; operator review is required.`;
    case "target_unavailable":
      return classification === "retryable"
        ? `Target ${ownerRoute} was unavailable; delivery will retry.`
        : `Target ${ownerRoute} remained unavailable after retries.`;
    case "provider_rate_exhausted":
      return classification === "retryable"
        ? `Provider capacity is throttled for ${ownerRoute}; dispatch is backed off for retry.`
        : `Provider capacity retries are exhausted for ${ownerRoute}.`;
    case "route_failure":
      return classification === "retryable"
        ? `Routing failed for ${ownerRoute}; delivery is retryable.`
        : `Routing failed for ${ownerRoute}; operator review is required.`;
    case "action_delivery_timeout":
      return `Operator action delivery timed out for ${ownerRoute}; retry with the same idempotency key will not double-fire.`;
  }
}

export async function emitNotificationReactorEvent(
  adapter: DbAdapter,
  input: NotificationReactorEventInput,
): Promise<NotificationReactorEvent> {
  const event = buildNotificationEvent(input);
  await migrateDeskTables(adapter);
  await upsertDeskItem(
    adapter,
    {
      desk_item_id: event.notification_id,
      label: notificationLabel(event),
      kind: "note",
      desk_class: "tray",
      tray_zone: "needs_you",
      body_md: event.safe_message,
      source_ref: event.notification_id,
      added_at: event.occurred_at,
      added_by: "notification-reactor",
      provenance: {
        origin: "dispatch",
        source_ref: event.source.dispatch_id ?? event.source.query_id ?? event.source.action_id ?? event.notification_id,
      },
    },
    "notification-reactor",
  );
  await adapter.query(
    `INSERT INTO event_log
       (team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.team_id,
      event.topic,
      "notification-reactor",
      "notification",
      event.notification_id,
      Date.parse(event.occurred_at),
      JSON.stringify(event),
    ],
  );
  return event;
}

function notificationLabel(event: NotificationReactorEvent): string {
  const id = event.source.dispatch_id ?? event.source.query_id ?? event.source.action_id ?? event.notification_id;
  return `${event.reason.replace(/_/g, " ")} (${event.classification}) ${id}`;
}
