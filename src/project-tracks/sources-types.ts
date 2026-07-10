export type ProjectSourceGroup =
  | "transcripts"
  | "images_screenshots_logos"
  | "pdfs_forms"
  | "emails_captures"
  | "artifacts_reports"
  | "other_files";

export type ProjectSourceReadState = "unread" | "read" | "approved" | "shipped" | "unknown";
export type ProjectSourceFreshnessStatus = "fresh" | "stale" | "missing" | "unknown";
export type ProjectSourcePreviewState = "inline" | "download" | "external_open" | "unavailable";

export interface ProjectRootRegistration {
  id: string;
  project: string;
  root_path: string;
  owner_agent: string | null;
  proof: "agent.working_directory" | "artifact.abs_path";
}

export interface ProjectSourceRow {
  id: string;
  group: ProjectSourceGroup;
  title: string;
  source: {
    kind: "query_transcript" | "artifact_catalog" | "filesystem";
    path: string | null;
    proof: string;
  };
  dates: {
    created_at: string | null;
    modified_at: string | null;
  };
  ownership: {
    project: string;
    agent: string | null;
  };
  links: {
    dispatch_id: string | null;
    artifact_id: string | null;
    query_id: string | null;
  };
  preview: {
    renderable: boolean;
    state: ProjectSourcePreviewState;
    media_type: string | null;
  };
  read: {
    state: ProjectSourceReadState;
    first_viewed_at: string | null;
    last_viewed_at: string | null;
  };
  freshness: {
    status: ProjectSourceFreshnessStatus;
    reason: string;
  };
  open: {
    href: string;
    fallback: "artifact" | "query" | "file";
  };
}

export type ProjectSourceSavedViewFieldId =
  | "project_sources.row.id"
  | "project_sources.row.group"
  | "project_sources.row.title"
  | "project_sources.row.source"
  | "project_sources.row.dates"
  | "project_sources.row.ownership"
  | "project_sources.row.links"
  | "project_sources.row.preview"
  | "project_sources.row.read"
  | "project_sources.row.freshness"
  | "project_sources.row.open";

export interface ProjectSourceSavedView {
  id: "project-sources.v1.index";
  field_ids: ProjectSourceSavedViewFieldId[];
  filters: Array<"type" | "project" | "agent" | "date" | "read_state" | "status" | "q">;
}

export interface ProjectSourcesEnvelope {
  ok: true;
  schema_version: "project-sources.v1";
  generated_at: string;
  project: {
    requested: string;
    canonical: string;
    aliases: string[];
  };
  saved_view: ProjectSourceSavedView;
  filters: {
    type: ProjectSourceGroup | null;
    project: string;
    agent: string | null;
    since: string | null;
    until: string | null;
    read_state: ProjectSourceReadState | null;
    status: ProjectSourceFreshnessStatus | null;
    q: string | null;
    limit: number;
  };
  roots: ProjectRootRegistration[];
  groups: Record<ProjectSourceGroup, number>;
  rows: ProjectSourceRow[];
  count: number;
}
