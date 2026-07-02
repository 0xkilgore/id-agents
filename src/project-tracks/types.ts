import type { ResolveVia } from "../track-registry/registry.js";

export type ProjectTrackAssociationKind = "task" | "artifact" | "dispatch" | "backlog_item";

export interface ProjectTrackResolution {
  raw: string | null;
  canonical: string | null;
  conforms: boolean;
  via: ResolveVia;
  drift: boolean;
}

export interface ProjectTrackTask {
  id: string;
  name: string;
  title: string;
  status: string;
  owner: string | null;
  updated_at: string;
  track: ProjectTrackResolution;
}

export interface ProjectTrackArtifact {
  artifact_id: string;
  title: string | null;
  basename: string;
  agent: string;
  abs_path: string;
  produced_at: string;
  track: ProjectTrackResolution;
}

export interface ProjectTrackDispatch {
  dispatch_phid: string;
  query_id: string;
  subject: string;
  to_agent: string;
  status: string;
  updated_at: string;
  completed_at: string | null;
  track: ProjectTrackResolution;
}

export interface ProjectTrackBacklogItem {
  item_id: string;
  title: string;
  readiness_state: string;
  to_agent: string | null;
  last_dispatch_phid: string | null;
  updated_at: string;
  track: ProjectTrackResolution;
}

export interface ProjectTrackBlocker {
  kind: "dispatch" | "backlog_item";
  id: string;
  title: string;
  status: string;
  reason: string | null;
  updated_at: string;
  track: ProjectTrackResolution;
}

export interface ProjectTrackSummary {
  track: string;
  canonical_track: string | null;
  conforms: boolean;
  deferred: boolean;
  drift: boolean;
  counts: Record<ProjectTrackAssociationKind, number>;
  tasks: ProjectTrackTask[];
  artifacts: ProjectTrackArtifact[];
  dispatches: ProjectTrackDispatch[];
  backlog_items: ProjectTrackBacklogItem[];
  blockers: ProjectTrackBlocker[];
}

export interface ProjectTrackDriftSummary {
  total_associations: number;
  conforming_associations: number;
  conforming_share: number;
  threshold: number;
  below_threshold: boolean;
  drift_count: number;
  /** Associations with NO track assigned (raw === "(unassigned)"). */
  unassigned_count: number;
  /** Associations with a track value that does not conform to the registry
   *  (assigned-but-unrecognized — distinct from unassigned). */
  unknown_count: number;
}

export interface ProjectTracksEnvelope {
  schema_version: "project-tracks.v1";
  generated_at: string;
  project: {
    requested: string;
    canonical: string;
    aliases: string[];
  };
  source: {
    read_path: "substrate";
    projection: "project_tracks";
    source_type: "hybrid_projection";
  };
  tracks: ProjectTrackSummary[];
  canonical_tracks: string[];
  deferred_tracks: string[];
  drift: ProjectTrackDriftSummary;
  empty: boolean;
}
