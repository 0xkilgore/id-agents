import { createHash } from "node:crypto";
import { buildReviewNextResponse } from "../review-next/projection.js";
import type { ReviewNextAction } from "../review-next/types.js";
import { taskRowToEntry } from "../tasks-readmodel/entry-projection.js";
import type {
  DailyDeskAction,
  DailyDeskFreshnessState,
  DailyDeskLane,
  DailyDeskLaneId,
  DailyDeskMetadataRow,
  DailyDeskResponse,
  DailyDeskRow,
  DailyDeskSourceSet,
} from "./types.js";
import { DAILY_DESK_LANE_ORDER, DAILY_DESK_SCHEMA_VERSION } from "./types.js";

export const DAILY_DESK_MAX_BYTES = 64 * 1024;
export const DAILY_DESK_CAPS = { today: 8, review_next: 5, needs_response: 5, follow_through: 5 } as const;
export const DAILY_DESK_MAX_FIELD = { id: 256, title: 256, owner: 128, lifecycle: 128, code: 128, reason: 240, url: 1024 } as const;
const ACTIVE_REGISTRATION_LIFECYCLES = new Set(["active", "open", "pending", "needs_response", "waiting"]);
const RESPONSE_STATES = new Set(["new", "needs_route", "output_ready"]);
const RESPONSE_CLASSIFICATIONS = new Set(["action", "approval_needed"]);
const NON_PRODUCTION_MARKER = /(?:^|[:/_-])(?:test|tests|fixture|fixtures|system)(?:[:/_-]|$)/i;
const KNOWN_ACTIONS = new Set<DailyDeskAction>([
  "open", "complete", "snooze", "acknowledge", "comment", "approve", "request_change", "route", "react",
]);

export interface BuildDailyDeskOptions {
  now?: Date;
  today?: string;
  supportedReviewNextActions?: ReadonlySet<ReviewNextAction>;
}

export function buildDailyDeskResponse(source: DailyDeskSourceSet, options: BuildDailyDeskOptions = {}): DailyDeskResponse {
  const now = options.now ?? new Date();
  const projectionAsOf = now.toISOString();
  const today = options.today ?? projectionAsOf.slice(0, 10);
  // A1 reuse seam: admission, sorting, max_rows=5, cursor, freshness and row
  // semantics are delegated to the landed A1 builder without reinterpretation.
  const reviewNext = buildReviewNextResponse(source.review_next_source, {
    now,
    supportedActions: options.supportedReviewNextActions,
  });

  const todayRows = source.today
    .map((row) => ({ source: row, entry: taskRowToEntry(row, new Map(), today) }))
    .filter(({ source: row, entry }) => row.status !== "done" && !entry.done && !entry.archived && entry.band === "today")
    .filter(({ source: row }) => !nonProduction(row.id, row.name, row.title))
    .sort((a, b) => b.source.updated_at - a.source.updated_at || a.entry.phid.localeCompare(b.entry.phid))
    .slice(0, DAILY_DESK_CAPS.today)
    .map(({ source: row, entry }) => dailyRow({
      id: entry.phid,
      lane: "today",
      title: entry.display_title,
      owner: entry.owner?.id ?? "unassigned",
      admissionCode: "canonical_task_today",
      admissionDetail: `open task is in canonical today band for ${today}`,
      admissionSource: "task_entries",
      lifecycle: entry.task_status,
      canonicalUrl: `/ops/tasks?task=${encodeURIComponent(entry.display_id)}#task-${encodeURIComponent(entry.display_id)}`,
      permittedActions: ["open", "complete", "snooze"],
      sourceAsOf: epochToIso(row.updated_at),
      projectionAsOf,
      freshness: freshness(epochToIso(row.updated_at), now, "task substrate updated"),
    }));

  const reviewRows = reviewNext.rows.map((row) => dailyRow({
    id: row.id,
    lane: "review_next",
    title: row.title,
    owner: row.owner,
    admissionCode: "a1_review_next",
    admissionDetail: row.admission_reason,
    admissionSource: "review_next",
    lifecycle: row.effective_lifecycle,
    canonicalUrl: row.canonical_url,
    permittedActions: row.permitted_actions,
    sourceAsOf: row.source_as_of,
    projectionAsOf: reviewNext.projection_as_of,
    freshness: {
      state: reviewNext.freshness_state,
      reason: `${row.freshness_state}: ${row.freshness_reason}`,
    },
    reviewNext: row,
  }));

  const needsResponseRows = source.needs_response
    .filter(({ metadata, inbox }) => eligibleMetadata(metadata, "needs_response", "inbox"))
    .filter(({ inbox }) => RESPONSE_STATES.has(inbox.operator_state)
      && RESPONSE_CLASSIFICATIONS.has(inbox.classification_label ?? "")
      && inbox.resolved_at === null
      && inbox.checked_off_at === null)
    .filter(({ metadata, inbox }) => !nonProduction(metadata.entity_id, metadata.canonical_url, inbox.source_external_id ?? ""))
    .sort((a, b) => b.metadata.source_as_of.localeCompare(a.metadata.source_as_of) || a.metadata.entity_id.localeCompare(b.metadata.entity_id))
    .slice(0, DAILY_DESK_CAPS.needs_response)
    .map(({ metadata, inbox }) => dailyRow({
      id: inbox.inbox_phid,
      lane: "needs_response",
      title: inbox.source_subject ?? inbox.source_excerpt ?? inbox.source_text ?? "Untitled inbox item",
      owner: metadata.owner,
      admissionCode: metadata.admission_code,
      admissionDetail: metadata.admission_detail,
      admissionSource: "inbox_items",
      lifecycle: metadata.effective_lifecycle,
      canonicalUrl: metadata.canonical_url,
      permittedActions: parseActions(metadata.permitted_actions_json),
      sourceAsOf: metadata.source_as_of,
      projectionAsOf,
      freshness: inbox.parity_status === "drift"
        ? { state: "degraded", reason: "inbox projection parity reports drift" }
        : freshness(metadata.source_as_of, now, "inbox projection updated"),
    }));

  const followThroughRows = source.follow_through
    .filter(({ metadata, checkin, task }) => eligibleMetadata(metadata, "follow_through", "checkin")
      && checkin.status === "active"
      && task.status !== "done"
      && task.completed_at === null
      && (checkin.ttl_expires_at === null || checkin.ttl_expires_at > now.getTime()))
    .filter(({ metadata, checkin, task }) => !nonProduction(metadata.entity_id, checkin.id, task.id, task.name, task.title))
    .sort((a, b) => {
      const left = a.checkin.next_fire_at ?? Number.MAX_SAFE_INTEGER;
      const right = b.checkin.next_fire_at ?? Number.MAX_SAFE_INTEGER;
      return left - right || b.metadata.source_as_of.localeCompare(a.metadata.source_as_of) || a.checkin.id.localeCompare(b.checkin.id);
    })
    .slice(0, DAILY_DESK_CAPS.follow_through)
    .map(({ metadata, checkin, task }) => dailyRow({
      id: checkin.id,
      lane: "follow_through",
      title: checkin.note ?? task.title,
      owner: metadata.owner,
      admissionCode: metadata.admission_code,
      admissionDetail: metadata.admission_detail,
      admissionSource: "checkins",
      lifecycle: metadata.effective_lifecycle,
      canonicalUrl: metadata.canonical_url,
      permittedActions: parseActions(metadata.permitted_actions_json),
      sourceAsOf: metadata.source_as_of,
      projectionAsOf,
      freshness: freshness(metadata.source_as_of, now, "active checkin updated"),
    }));

  const lanes: DailyDeskLane[] = [
    lane("today", "Today", DAILY_DESK_CAPS.today, todayRows),
    lane("review_next", "Review next", DAILY_DESK_CAPS.review_next, reviewRows),
    lane("needs_response", "Needs a response", DAILY_DESK_CAPS.needs_response, needsResponseRows),
    lane("follow_through", "Follow-through", DAILY_DESK_CAPS.follow_through, followThroughRows),
  ];
  if (lanes.map((item) => item.id).join("|") !== DAILY_DESK_LANE_ORDER.join("|")) throw new Error("daily_desk_lane_order_invalid");
  const allRows = lanes.flatMap((item) => item.rows);
  const sourceCursor = hash([
    reviewNext.authority.source_cursor,
    ...lanes.flatMap((item) => item.rows.map((row) => `${item.id}:${row.source_cursor}`)),
  ].join("\n"));
  const aggregateFreshness = aggregateFreshnessState(allRows.map((row) => row.freshness_state));
  const response: DailyDeskResponse = {
    ok: true,
    schema_version: DAILY_DESK_SCHEMA_VERSION,
    authority: { owner: "manager", projection: "daily_desk", state: "authoritative", source_cursor: sourceCursor },
    projection_as_of: projectionAsOf,
    source_as_of: allRows.reduce<string | null>((latest, row) => !latest || row.source_as_of > latest ? row.source_as_of : latest, null),
    freshness_state: aggregateFreshness,
    freshness_reason: bounded(aggregateFreshness === "current"
      ? "all admitted lane rows are current manager projections"
      : `one or more admitted lane rows report ${aggregateFreshness} freshness`, DAILY_DESK_MAX_FIELD.reason),
    lanes,
    count: allRows.length,
    max_payload_bytes: 65536,
    payload_bytes: 0,
    review_next_receipt: {
      schema_version: reviewNext.schema_version,
      authority: reviewNext.authority,
      projection_as_of: reviewNext.projection_as_of,
      source_as_of: reviewNext.source_as_of,
      freshness_state: reviewNext.freshness_state,
      freshness_reason: reviewNext.freshness_reason,
      count: reviewNext.count,
      max_rows: reviewNext.max_rows,
      payload_bytes: reviewNext.payload_bytes,
    },
  };
  response.payload_bytes = stablePayloadBytes(response);
  if (response.payload_bytes > DAILY_DESK_MAX_BYTES) throw new Error(`daily_desk_payload_exceeds_${DAILY_DESK_MAX_BYTES}_bytes`);
  return response;
}

function dailyRow(input: {
  id: string;
  lane: DailyDeskLaneId;
  title: string;
  owner: string;
  admissionCode: string;
  admissionDetail: string;
  admissionSource: DailyDeskRow["admission_reason"]["source"];
  lifecycle: string;
  canonicalUrl: string;
  permittedActions: readonly string[];
  sourceAsOf: string;
  projectionAsOf: string;
  freshness: { state: DailyDeskFreshnessState; reason: string };
  reviewNext?: DailyDeskRow["review_next"];
}): DailyDeskRow {
  const semanticCursor = hash([
    input.lane, input.id, input.sourceAsOf, input.lifecycle, input.canonicalUrl,
    input.admissionCode, input.permittedActions.join(","),
  ].join("\u0000"));
  return {
    id: bounded(input.id, DAILY_DESK_MAX_FIELD.id),
    lane: input.lane,
    title: bounded(input.title.trim(), DAILY_DESK_MAX_FIELD.title),
    authority: { owner: "manager", projection: "daily_desk", state: "authoritative", source_cursor: semanticCursor },
    audience: "operator",
    environment: "production",
    admission_reason: {
      code: bounded(input.admissionCode, DAILY_DESK_MAX_FIELD.code),
      detail: bounded(input.admissionDetail, DAILY_DESK_MAX_FIELD.reason),
      source: input.admissionSource,
    },
    effective_lifecycle: bounded(input.lifecycle, DAILY_DESK_MAX_FIELD.lifecycle),
    canonical_url: bounded(input.canonicalUrl, DAILY_DESK_MAX_FIELD.url),
    permitted_actions: input.permittedActions.filter((action): action is DailyDeskAction => KNOWN_ACTIONS.has(action as DailyDeskAction)),
    source_cursor: semanticCursor,
    source_as_of: input.sourceAsOf,
    projection_as_of: input.projectionAsOf,
    freshness_state: input.freshness.state,
    freshness_reason: bounded(input.freshness.reason, DAILY_DESK_MAX_FIELD.reason),
    owner: bounded(input.owner, DAILY_DESK_MAX_FIELD.owner),
    ...(input.reviewNext ? { review_next: input.reviewNext } : {}),
  };
}

function lane(id: DailyDeskLaneId, label: DailyDeskLane["label"], maxRows: 5 | 8, rows: DailyDeskRow[]): DailyDeskLane {
  if (rows.length > maxRows) throw new Error(`daily_desk_${id}_cap_exceeded`);
  return { id, label, max_rows: maxRows, count: rows.length, rows };
}

function eligibleMetadata(metadata: DailyDeskMetadataRow, laneId: DailyDeskLaneId, kind: "inbox" | "checkin"): boolean {
  return metadata.lane === laneId
    && metadata.entity_kind === kind
    && metadata.audience === "operator"
    && metadata.environment === "production"
    && Boolean(metadata.entity_id && metadata.owner && metadata.canonical_url && metadata.source_as_of)
    && ACTIVE_REGISTRATION_LIFECYCLES.has(metadata.effective_lifecycle)
    && Number.isFinite(Date.parse(metadata.source_as_of));
}

function parseActions(raw: string): DailyDeskAction[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((action): action is DailyDeskAction => typeof action === "string" && KNOWN_ACTIONS.has(action as DailyDeskAction)))];
  } catch {
    return [];
  }
}

function nonProduction(...values: string[]): boolean {
  return values.some((value) => NON_PRODUCTION_MARKER.test(value));
}

function epochToIso(value: number): string {
  return new Date(value > 1e12 ? value : value * 1000).toISOString();
}

function freshness(sourceAsOf: string, now: Date, reason: string): { state: DailyDeskFreshnessState; reason: string } {
  const parsed = Date.parse(sourceAsOf);
  if (!Number.isFinite(parsed)) return { state: "unknown", reason: `${reason}; source timestamp is invalid` };
  const ageMs = now.getTime() - parsed;
  if (ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return { state: "stale", reason: `${reason}; source is older than 24 hours or in the future` };
  return { state: "current", reason: `${reason}; source is at most 24 hours old` };
}

function aggregateFreshnessState(states: DailyDeskFreshnessState[]): DailyDeskFreshnessState {
  if (states.includes("degraded")) return "degraded";
  if (states.includes("stale")) return "stale";
  if (states.includes("unknown")) return "unknown";
  return "current";
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bounded(value: string, max: number): string {
  return value.slice(0, max);
}

function stablePayloadBytes(response: DailyDeskResponse): number {
  let previous = -1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = Buffer.byteLength(JSON.stringify(response), "utf8");
    response.payload_bytes = next;
    if (next === previous) return next;
    previous = next;
  }
  return Buffer.byteLength(JSON.stringify(response), "utf8");
}
