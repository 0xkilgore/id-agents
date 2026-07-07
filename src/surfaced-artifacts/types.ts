export type SurfacedArtifactStatus = "unread" | "read" | "commented" | "routed" | "approved";

export type SurfacedArtifactRelevanceReason =
  | "needs_decision"
  | "final_user_facing_deliverable"
  | "changed_product_behavior"
  | "domain_action"
  | "blocked_or_stale";

export type SurfacedArtifactNeed = "read" | "comment" | "route" | "approve" | "inspect_closeout";

export type SurfacedArtifactSourceKind =
  | "artifact"
  | "dispatch_done"
  | "verification"
  | "promotion"
  | "comment"
  | "task"
  | "filesystem_reconcile";

export interface SurfacedArtifactRow {
  id: string;
  title: string;
  subtitle?: string;
  work_item_ref?: string;
  group_count?: number;
  grouped_source_kinds?: SurfacedArtifactSourceKind[];
  rank_score: number;
  status: SurfacedArtifactStatus;
  relevance_reason: SurfacedArtifactRelevanceReason;
  needs?: SurfacedArtifactNeed;
  artifact_ref?: string;
  dispatch_ref?: string;
  task_ref?: string;
  project_ref?: string;
  agent_name?: string;
  created_at: string;
  updated_at: string;
  source_kind: SurfacedArtifactSourceKind;
  source_label: string;
  visibility_proof: {
    discovered_by: "agent_done" | "delivery_log" | "filesystem" | "comment" | "manual_fixture";
    artifact_path_present: boolean;
    body_renderable?: boolean;
  };
}

export interface RecentFloodDiagnostic {
  window_start: string;
  window_end: string;
  total_raw_count: number;
  grouped_count: number;
  suppressed_from_primary_count: number;
  groups: Array<{
    work_item_ref: string;
    title: string;
    track_ref?: string;
    project_ref?: string;
    agent_names: string[];
    raw_count: number;
    latest_update: string;
    reason_counts: Record<string, number>;
  }>;
  raw_rows: SurfacedArtifactRow[];
}

export interface SurfacedArtifactsResponse {
  ok: true;
  schema_version: "surfaced-artifacts.v1";
  generated_at: string;
  rows: SurfacedArtifactRow[];
  count: number;
  recent_flood: RecentFloodDiagnostic;
}
