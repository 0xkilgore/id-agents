import type { DailyDeskAction, DailyDeskFreshnessState, DailyDeskSourceSet } from "../daily-desk/types.js";

export const OPERATOR_ATTENTION_SCHEMA_VERSION = "operator-attention.v1" as const;
export const OPERATOR_ATTENTION_MAX_BYTES = 64 * 1024;
export const OPERATOR_ATTENTION_CAPS = { primary: 1, next: 4, waiting: 3 } as const;

export type OperatorAttentionBand = keyof typeof OPERATOR_ATTENTION_CAPS;
export type OperatorAttentionSuppressionCode =
  | "duplicate_identity"
  | "no_authority"
  | "not_operator"
  | "test_material"
  | "terminal"
  | "superseded"
  | "stale_unlabeled"
  | "unsupported_action"
  | "snoozed"
  | "dismissed"
  | "unbounded_request"
  | "unlinked_decision"
  | "owner_budget_exhausted"
  | "over_budget";

export interface OperatorAttentionCandidate {
  ref: string;
  title: string;
  owner: string;
  audience: "operator" | "system";
  environment: "production" | "test";
  authority_owner: string;
  canonical_url: string;
  lifecycle: string;
  source_as_of: string;
  meaningful_at: string;
  due_at?: string | null;
  expires_at?: string | null;
  priority?: number;
  source_kind: "task" | "report" | "inbox" | "feedback" | "delivery" | "checkin";
  attention_kind: "urgent" | "decide" | "answer" | "approve" | "read" | "due" | "waiting";
  requested_by_ref?: string | null;
  requested_by_waiting?: boolean;
  manager_derived?: boolean;
  operator_pinned?: boolean;
  last_known?: boolean;
  degraded?: boolean;
  snoozed?: boolean;
  dismissed?: boolean;
  family_ref?: string | null;
  supersedes_ref?: string | null;
  actions: DailyDeskAction[];
  admission_code: string;
  admission_detail: string;
}

export interface OperatorAttentionItem {
  ref: string;
  title: string;
  owner: string;
  authority: { owner: string; source_cursor: string };
  audience: "operator";
  environment: "production";
  band: OperatorAttentionBand;
  rank_band: number;
  canonical_url: string;
  lifecycle: string;
  source_kind: OperatorAttentionCandidate["source_kind"];
  source_as_of: string;
  meaningful_at: string;
  due_at: string | null;
  expires_at: string | null;
  freshness_state: DailyDeskFreshnessState;
  permitted_actions: DailyDeskAction[];
  admission_reason: { code: string; detail: string };
}

export interface OperatorAttentionSuppression {
  ref: string;
  reason: OperatorAttentionSuppressionCode;
  detail: string;
}

export interface OperatorAttentionResponse {
  ok: true;
  schema_version: typeof OPERATOR_ATTENTION_SCHEMA_VERSION;
  authority: {
    owner: "manager";
    projection: "operator_attention";
    state: "authoritative";
    source_cursor: string;
  };
  evaluated_at: string;
  source_as_of: string | null;
  freshness_state: DailyDeskFreshnessState;
  freshness_reason: string;
  bands: {
    primary: OperatorAttentionItem[];
    next: OperatorAttentionItem[];
    waiting: OperatorAttentionItem[];
  };
  counts: {
    primary: number;
    next: number;
    waiting: number;
    suppressed: number;
    overflow: number;
  };
  changes_count: number;
  capabilities: Record<DailyDeskAction, "available" | `disabled:${string}`>;
  max_payload_bytes: typeof OPERATOR_ATTENTION_MAX_BYTES;
  payload_bytes: number;
}

export interface OperatorAttentionSourceSet {
  daily_desk: DailyDeskSourceSet;
  candidates?: OperatorAttentionCandidate[];
  changes_count?: number;
  source_health?: "current" | "degraded" | "unavailable";
  source_health_reason?: string;
}

export interface OperatorAttentionBuildResult {
  response: OperatorAttentionResponse;
  suppressions: OperatorAttentionSuppression[];
}
