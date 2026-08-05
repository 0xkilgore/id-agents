export type ReviewNextLifecycle = "active" | "open" | "needs_review" | "pending";

export type ReviewNextAction =
  | "open"
  | "acknowledge"
  | "comment"
  | "approve"
  | "request_change"
  | "route"
  | "react";

export type ReviewNextFreshnessState = "fresh" | "aging" | "revised" | "revalidated" | "pinned";

export interface ReviewNextRegistration {
  audience: "operator" | "system";
  environment: "production" | "test";
  owner: string;
  canonical_url: string;
  effective_lifecycle: string;
  source_as_of: string;
  revised_at?: string | null;
  revalidated_at?: string | null;
  pinned_at?: string | null;
  attention_state: string;
  attention_reason: string;
  attention_priority: number;
  admission_reason: string;
  permitted_actions: ReviewNextAction[];
}

export interface ReviewNextMetadataRow extends ReviewNextRegistration {
  artifact_id: string;
  permitted_actions_json: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewNextSourceRow {
  artifact_id: string;
  title: string | null;
  artifact_created_at: string;
  produced_at: string;
  source: string;
  availability: string;
  abs_path: string;
  basename: string;
  audience: string;
  environment: string;
  owner: string;
  canonical_url: string;
  effective_lifecycle: string;
  source_as_of: string;
  revised_at: string | null;
  revalidated_at: string | null;
  pinned_at: string | null;
  attention_state: string;
  attention_reason: string;
  attention_priority: number;
  admission_reason: string;
  permitted_actions_json: string;
}

export interface ReviewNextRow {
  id: string;
  canonical_url: string;
  title: string;
  owner: string;
  audience: "operator";
  admission_reason: string;
  attention_state: string;
  attention_reason: string;
  attention_priority: number;
  effective_lifecycle: ReviewNextLifecycle;
  created_at: string;
  source_as_of: string;
  meaningful_at: string;
  freshness_state: ReviewNextFreshnessState;
  freshness_reason: string;
  pinned: boolean;
  permitted_actions: ReviewNextAction[];
}

export interface ReviewNextResponse {
  ok: true;
  schema_version: "review-next.v1";
  authority: {
    owner: "manager";
    projection: "review_next";
    state: "authoritative";
    source_cursor: string;
  };
  projection_as_of: string;
  source_as_of: string | null;
  freshness_state: "current" | "stale" | "degraded" | "unknown";
  freshness_reason: string;
  rows: ReviewNextRow[];
  count: number;
  max_rows: 5;
  payload_bytes: number;
}
