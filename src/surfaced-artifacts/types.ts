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
  program_ref?: string;
  track_ref?: string;
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
  source_data: {
    raw_limit: number;
    primary_limit: number;
    raw_row_count: number;
    primary_row_count: number;
    capped: boolean;
  };
  total_raw_count: number;
  grouped_count: number;
  suppressed_from_primary_count: number;
  groups: Array<{
    work_item_ref: string;
    title: string;
    program_ref?: string;
    track_ref?: string;
    project_ref?: string;
    agent_names: string[];
    raw_count: number;
    latest_update: string;
    reason_counts: Record<string, number>;
  }>;
  raw_rows: SurfacedArtifactRow[];
}

export type SurfacedArtifactSavedViewFieldId =
  | "surfaced_artifacts.row.id"
  | "surfaced_artifacts.row.title"
  | "surfaced_artifacts.row.subtitle"
  | "surfaced_artifacts.row.work_item_ref"
  | "surfaced_artifacts.row.group_count"
  | "surfaced_artifacts.row.grouped_source_kinds"
  | "surfaced_artifacts.row.rank_score"
  | "surfaced_artifacts.row.status"
  | "surfaced_artifacts.row.relevance_reason"
  | "surfaced_artifacts.row.needs"
  | "surfaced_artifacts.row.artifact_ref"
  | "surfaced_artifacts.row.dispatch_ref"
  | "surfaced_artifacts.row.task_ref"
  | "surfaced_artifacts.row.project_ref"
  | "surfaced_artifacts.row.program_ref"
  | "surfaced_artifacts.row.track_ref"
  | "surfaced_artifacts.row.agent_name"
  | "surfaced_artifacts.row.created_at"
  | "surfaced_artifacts.row.updated_at"
  | "surfaced_artifacts.row.source_kind"
  | "surfaced_artifacts.row.source_label"
  | "surfaced_artifacts.row.visibility_proof";

export interface SurfacedArtifactsSavedView {
  id: "surfaced-artifacts.v1.primary";
  field_ids: SurfacedArtifactSavedViewFieldId[];
  diagnostic_field_ids: Array<
    | "surfaced_artifacts.recent_flood.window_start"
    | "surfaced_artifacts.recent_flood.window_end"
    | "surfaced_artifacts.recent_flood.source_data"
    | "surfaced_artifacts.recent_flood.total_raw_count"
    | "surfaced_artifacts.recent_flood.grouped_count"
    | "surfaced_artifacts.recent_flood.suppressed_from_primary_count"
    | "surfaced_artifacts.recent_flood.groups"
    | "surfaced_artifacts.recent_flood.raw_rows"
  >;
}

export interface SurfacedArtifactsResponse {
  ok: true;
  schema_version: "surfaced-artifacts.v1";
  generated_at: string;
  saved_view: SurfacedArtifactsSavedView;
  rows: SurfacedArtifactRow[];
  count: number;
  recent_flood: RecentFloodDiagnostic;
}
