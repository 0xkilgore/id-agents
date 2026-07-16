export type CommentRouteState =
  | "recorded_unrouted"
  | "recorded_route_pending"
  | "recorded_routed"
  | "recorded_route_failed_retryable"
  | "recorded_route_failed_terminal";

export type SurfacedArtifactStatus =
  | "unread"
  | "read"
  | "in_review"
  | "commented"
  | "routed"
  | "approved"
  | "requested_changes"
  | "stale"
  | "failed_route";

export type ArtifactDeliveryFreshness =
  | "current"
  | "syncing"
  | "stale"
  | "event_gap"
  | "body_unavailable"
  | "mutation_pending"
  | "index_building"
  | "index_partial"
  | "mutation_failed"
  | "error";

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

export type SurfacedArtifactSourceType =
  | "transcript"
  | "image"
  | "pdf"
  | "email"
  | "artifact"
  | "other";

export type SurfacedArtifactBodySource = "cache" | "filesystem" | "unavailable";

export type LegacyArtifactAudience = "operator" | "reader" | "system";

export type LegacyArtifactKind =
  | "operator_action"
  | "regular_report"
  | "final_document"
  | "qa_receipt"
  | "system_receipt";

export interface LegacyArtifactClassification {
  audience: LegacyArtifactAudience;
  kind: LegacyArtifactKind;
  project_ref?: string;
  track_ref?: string;
  confidence: number;
  reason: string;
  source_fields: Array<{
    field: string;
    value: string;
  }>;
}

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
  legacy_classification?: LegacyArtifactClassification;
  agent_name?: string;
  created_at: string;
  updated_at: string;
  source_kind: SurfacedArtifactSourceKind;
  source_type: SurfacedArtifactSourceType;
  source_label: string;
  source_path?: string;
  source_proof: string;
  visibility_proof: {
    discovered_by: "agent_done" | "delivery_log" | "filesystem" | "comment" | "manual_fixture";
    artifact_path_present: boolean;
    body_renderable?: boolean;
  };
  delivery: {
    stable_url: string;
    copy_text_url: string;
    download_url: string;
    media_type: "text/markdown" | "text/html" | "text/plain" | "application/json" | "application/pdf" | "unknown";
    freshness: ArtifactDeliveryFreshness;
    source_host?: string | null;
    source_mtime?: string | null;
    content_hash?: string | null;
    body_cached: boolean;
    body_available: boolean;
    body_source: SurfacedArtifactBodySource;
    body_preview?: string | null;
    open_url: string;
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

export type SurfacedArtifactHealthEventTopic =
  | "artifact.surfacing.body_unavailable"
  | "artifact.surfacing.missing_from_primary";

export interface SurfacedArtifactHealthEvent {
  topic: SurfacedArtifactHealthEventTopic;
  severity: "warning" | "error";
  subject_kind: "artifact" | "dispatch" | "surfaced_artifact";
  subject_id: string;
  message: string;
  data: {
    artifact_ref?: string;
    dispatch_ref?: string;
    row_id: string;
    title: string;
    source_kind: SurfacedArtifactSourceKind;
    discovered_by: SurfacedArtifactRow["visibility_proof"]["discovered_by"];
    artifact_path_present: boolean;
    body_renderable?: boolean;
  };
}

export interface SurfacedArtifactsHealth {
  ok: boolean;
  surface: "ops.surfaced-artifacts.health";
  event_count: number;
  events: SurfacedArtifactHealthEvent[];
}

export type SavedViewFieldId =
  | "artifact.id"
  | "artifact.title"
  | "artifact.subtitle"
  | "artifact.workItemRef"
  | "artifact.groupCount"
  | "artifact.groupedSourceKinds"
  | "artifact.rankScore"
  | "artifact.status"
  | "artifact.relevanceReason"
  | "artifact.needs"
  | "artifact.artifactRef"
  | "artifact.dispatchRef"
  | "artifact.taskRef"
  | "artifact.projectRef"
  | "artifact.programRef"
  | "artifact.trackRef"
  | "artifact.legacy.audience"
  | "artifact.legacy.kind"
  | "artifact.legacy.projectRef"
  | "artifact.legacy.trackRef"
  | "artifact.legacy.confidence"
  | "artifact.legacy.reason"
  | "artifact.agentName"
  | "artifact.createdAt"
  | "artifact.updatedAt"
  | "artifact.sourceKind"
  | "artifact.sourceType"
  | "artifact.sourceLabel"
  | "artifact.sourcePath"
  | "artifact.sourceProof"
  | "artifact.visibility.discoveredBy"
  | "artifact.visibility.pathPresent"
  | "artifact.visibility.bodyRenderable"
  | "artifact.delivery.stableUrl"
  | "artifact.delivery.copyTextUrl"
  | "artifact.delivery.downloadUrl"
  | "artifact.delivery.mediaType"
  | "artifact.delivery.freshness"
  | "artifact.delivery.sourceHost"
  | "artifact.delivery.sourceMtime"
  | "artifact.delivery.contentHash"
  | "artifact.delivery.bodyCached"
  | "artifact.delivery.bodyAvailable"
  | "artifact.delivery.bodySource"
  | "artifact.delivery.openUrl"
  | "artifact.readState"
  | "artifact.tags"
  | "artifact.contentHash"
  | "artifact.hasComments"
  | "dispatch.id"
  | "dispatch.queryId"
  | "dispatch.title"
  | "dispatch.status"
  | "dispatch.agentId"
  | "dispatch.taskName"
  | "dispatch.createdAt"
  | "dispatch.queuedAt"
  | "dispatch.startedAt"
  | "dispatch.completedAt"
  | "dispatch.updatedAt"
  | "dispatch.needsOperator"
  | "dispatch.failureKind"
  | "dispatch.recoveryStatus"
  | "loop.id"
  | "loop.slug"
  | "loop.title"
  | "loop.status"
  | "loop.nextRunAt"
  | "loop.lastRunAt"
  | "loop.dueAt"
  | "loop.late"
  | "loop.deliveryStatus"
  | "user_task.id"
  | "user_task.title"
  | "user_task.status"
  | "user_task.owner"
  | "user_task.due"
  | "user_task.priority"
  | "user_task.source"
  | "user_task.context"
  | "user_task.projectRef"
  | "user_task.updatedAt"
  | "project.id"
  | "project.status"
  | "project.owner"
  | "project.updatedAt"
  | "project.hasUnreadArtifacts"
  | "project.hasOpenTasks"
  | "task.id"
  | "task.projectId"
  | "task.owner"
  | "task.status"
  | "task.due"
  | "task.priority"
  | "task.tickler"
  | "task.source"
  | "task.updatedAt"
  | "work_item.entityType"
  | "work_item.projectId"
  | "work_item.actor"
  | "work_item.attentionState"
  | "work_item.updatedAt"
  | "work_item.due"
  | "work_item.rank";

export type RawSurfacedArtifactRowKey =
  | "id"
  | "title"
  | "subtitle"
  | "work_item_ref"
  | "group_count"
  | "grouped_source_kinds"
  | "rank_score"
  | "status"
  | "relevance_reason"
  | "needs"
  | "artifact_ref"
  | "dispatch_ref"
  | "task_ref"
  | "project_ref"
  | "program_ref"
  | "track_ref"
  | "legacy_classification"
  | "agent_name"
  | "created_at"
  | "updated_at"
  | "source_kind"
  | "source_type"
  | "source_label"
  | "source_path"
  | "source_proof"
  | "visibility_proof";

export interface SavedViewFieldRegistryEntry {
  id: SavedViewFieldId;
  raw_row_key?: RawSurfacedArtifactRowKey;
  value_type: "string" | "number" | "boolean" | "string[]" | "enum" | "timestamp";
  operators: Array<"eq" | "neq" | "in" | "not_in" | "contains" | "exists" | "gt" | "gte" | "lt" | "lte">;
}

export interface SavedViewUnsupportedFieldError {
  code: "unsupported_field";
  field: string;
  canonical_field?: SavedViewFieldId;
  message: string;
}

export interface SavedViewExecutionResult<T> {
  ok: boolean;
  schema_version: "view-execution.v1";
  view_id: string;
  generated_at: string;
  rows: T[];
  count: number;
  errors: SavedViewUnsupportedFieldError[];
}

export type SeededSurfacedArtifactsViewName = "artifactDesk" | "personalTasks" | "workQueue";

export interface SeededSurfacedArtifactsSavedView {
  name: SeededSurfacedArtifactsViewName;
  id: `surfaced-artifacts.v1.${SeededSurfacedArtifactsViewName}`;
  execution: "saved_view_backed";
  field_ids: SavedViewFieldId[];
  predicate: unknown;
}

export interface SurfacedArtifactsSavedView {
  id: "surfaced-artifacts.v1.primary";
  execution: "saved_view_backed";
  field_ids: SavedViewFieldId[];
  field_registry: SavedViewFieldRegistryEntry[];
  raw_row_key_mapping: Partial<Record<RawSurfacedArtifactRowKey, SavedViewFieldId>>;
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
  seeded_views: Record<SeededSurfacedArtifactsViewName, SeededSurfacedArtifactsSavedView>;
  rows: SurfacedArtifactRow[];
  count: number;
  recent_flood: RecentFloodDiagnostic;
  health: SurfacedArtifactsHealth;
}
