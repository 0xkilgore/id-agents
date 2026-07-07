export type SurfacedArtifactStatus = "unread" | "read" | "commented" | "routed" | "approved";

export type SurfacedArtifactRelevanceReason =
  | "needs_chris"
  | "latest_project_critical"
  | "requested_task_deliverable"
  | "done_without_visible_deliverable"
  | "comment_needs_routing";

export type SurfacedArtifactNeed = "read" | "comment" | "route" | "approve" | "inspect_closeout";

export interface SurfacedArtifactRow {
  id: string;
  title: string;
  subtitle?: string;
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
  source_kind: "artifact" | "dispatch_done" | "comment" | "task" | "filesystem_reconcile";
  source_label: string;
  visibility_proof: {
    discovered_by: "agent_done" | "delivery_log" | "filesystem" | "comment" | "manual_fixture";
    artifact_path_present: boolean;
    body_renderable?: boolean;
  };
}

export interface SurfacedArtifactsResponse {
  ok: true;
  schema_version: "surfaced-artifacts.v1";
  generated_at: string;
  rows: SurfacedArtifactRow[];
  count: number;
}
