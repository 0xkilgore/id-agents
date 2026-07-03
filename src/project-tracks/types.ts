import type { ResolveVia } from "../track-registry/registry.js";

export type ProjectTrackAssociationKind = "task" | "artifact" | "dispatch" | "backlog_item";

/** Live-status pipeline buckets for the tracks/projects status tracker. */
export type TrackStatusBucket =
  | "queued"
  | "building"
  | "built_pending_review"
  | "landed"
  | "held"
  | "other";
export type TrackStatusCounts = Record<TrackStatusBucket, number>;

/** Honesty doctrine: each feeding source declares its availability so the panel
 *  can say "unavailable/stale" explicitly instead of rendering a fixture as real. */
export type SourceAvailability = "available" | "derived" | "unavailable" | "stale";
export interface ProjectTracksSources {
  /** orchestration_backlog_item.readiness_state. */
  orchestration_backlog: SourceAvailability;
  /** tasks.status stream (doing/done/…). */
  task_stream: SourceAvailability;
  /** dispatch_scheduler_queue.status. */
  dispatch_queue: SourceAvailability;
  /** Refactor-debt ledger (RD rows + built-pending-review/built-and-reviewed).
   *  Not present in this datastore yet → `unavailable` (never faked). */
  refactor_debt_ledger: SourceAvailability;
  /** Spec-054 landed/merge signal — currently inferred from terminal dispatch/
   *  backlog status rather than a dedicated promotion feed → `derived`. */
  spec054_landed: SourceAvailability;
  /** Human-readable notes for any non-`available` source (surfaced by the UI). */
  notes: string[];
}

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
  /** Live pipeline status counts across the track's items (tracker per-row data). */
  status_counts: TrackStatusCounts;
  /** Most recent state-change timestamp across the track's items (ISO), or null. */
  latest_activity_at: string | null;
  /** Distinct owner agents/lanes carrying the track, sorted. */
  owner_lanes: string[];
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
  /** Per-source availability (honesty doctrine — never fake an unavailable feed). */
  sources: ProjectTracksSources;
  empty: boolean;
}
