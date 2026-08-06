import type { CheckinRow, TaskRow } from "../db/types.js";
import type { InboxItemRow } from "../inbox/types.js";
import type { ReviewNextResponse, ReviewNextRow, ReviewNextSourceRow } from "../review-next/types.js";

export const DAILY_DESK_SCHEMA_VERSION = "daily-desk.v1" as const;
export const DAILY_DESK_LANE_ORDER = ["today", "review_next", "needs_response", "follow_through"] as const;
export type DailyDeskLaneId = typeof DAILY_DESK_LANE_ORDER[number];
export type DailyDeskAction = "open" | "complete" | "snooze" | "acknowledge" | "comment" | "approve" | "request_change" | "route" | "react";
export type DailyDeskFreshnessState = "current" | "stale" | "degraded" | "unknown";

export interface DailyDeskRegistration {
  team_id: string;
  lane: "needs_response" | "follow_through";
  entity_kind: "inbox" | "checkin";
  entity_id: string;
  audience: "operator" | "system";
  environment: "production" | "test";
  owner: string;
  canonical_url: string;
  effective_lifecycle: string;
  source_as_of: string;
  admission_code: string;
  admission_detail: string;
  permitted_actions: DailyDeskAction[];
}

export interface DailyDeskMetadataRow extends Omit<DailyDeskRegistration, "permitted_actions"> {
  permitted_actions_json: string;
  created_at: string;
  updated_at: string;
}

export interface DailyDeskNeedsResponseSource {
  metadata: DailyDeskMetadataRow;
  inbox: InboxItemRow;
}

export interface DailyDeskFollowThroughSource {
  metadata: DailyDeskMetadataRow;
  checkin: CheckinRow;
  task: TaskRow;
}

export interface DailyDeskSourceSet {
  today: TaskRow[];
  review_next_source: ReviewNextSourceRow[];
  needs_response: DailyDeskNeedsResponseSource[];
  follow_through: DailyDeskFollowThroughSource[];
}

export interface DailyDeskRow {
  id: string;
  lane: DailyDeskLaneId;
  title: string;
  authority: {
    owner: "manager";
    projection: "daily_desk";
    state: "authoritative";
    source_cursor: string;
  };
  audience: "operator";
  environment: "production";
  admission_reason: {
    code: string;
    detail: string;
    source: "task_entries" | "review_next" | "inbox_items" | "checkins";
  };
  effective_lifecycle: string;
  canonical_url: string;
  permitted_actions: DailyDeskAction[];
  source_cursor: string;
  source_as_of: string;
  projection_as_of: string;
  freshness_state: DailyDeskFreshnessState;
  freshness_reason: string;
  owner: string;
  review_next?: ReviewNextRow;
}

export interface DailyDeskLane {
  id: DailyDeskLaneId;
  label: "Today" | "Review next" | "Needs a response" | "Follow-through";
  max_rows: 5 | 8;
  count: number;
  rows: DailyDeskRow[];
}

export interface DailyDeskResponse {
  ok: true;
  schema_version: typeof DAILY_DESK_SCHEMA_VERSION;
  authority: {
    owner: "manager";
    projection: "daily_desk";
    state: "authoritative";
    source_cursor: string;
  };
  projection_as_of: string;
  source_as_of: string | null;
  freshness_state: DailyDeskFreshnessState;
  freshness_reason: string;
  lanes: DailyDeskLane[];
  count: number;
  max_payload_bytes: 65536;
  payload_bytes: number;
  review_next_receipt: Pick<ReviewNextResponse, "schema_version" | "authority" | "projection_as_of" | "source_as_of" | "freshness_state" | "freshness_reason" | "count" | "max_rows" | "payload_bytes">;
}
