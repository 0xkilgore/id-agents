// Kapelle B11 manager-side backend foundation — outputs/types.ts
//
// Smallest durable shape that lets the manager track operator review state
// (view/approve/ship) for artifacts that originate elsewhere (Reactor-side
// Powerhouse documents, dashboard REST shim, agent /agent-done callbacks).
//
// SQLite-mirror is intentional: every row carries a `source_link` field
// that points back at the upstream doc-model record, so the projection
// can be rebuilt from source if it drifts. Backfill semantics are:
// missing rows are created lazily on first /view or /approve mutation.

export type ArtifactOpType =
  | "view"
  | "approve"
  | "reject"
  | "ship_attempted"
  | "ship_blocked"
  | "comment_recorded";

// Append-only audit event for an artifact. Lives in artifact_operations.
export interface ArtifactOpRow {
  op_id: number;                  // SQLite autoincrement
  artifact_id: string;            // the artifact phid (cross-system stable id)
  op_type: ArtifactOpType;
  actor: string;                  // operator id, agent id, or "system"
  ts: string;                     // ISO-8601 UTC
  payload_json: string | null;    // structured op-specific JSON (note, blockers, etc.)
  source_link: string | null;     // doc-model pointer when mirrored from upstream
}

// Current review state for one artifact. Lives in artifact_review_state.
// One row per artifact. Lazily created on first view/approve.
export interface ArtifactReviewStateRow {
  artifact_id: string;
  source_link: string | null;     // e.g., "reactor:phid:art-..." or "delivery-log:line:583"
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  viewed_by_last: string | null;  // most-recent viewer (operator id or agent id)
  viewed_count: number;
  approved_at: string | null;
  approved_by: string | null;
  approval_note: string | null;
  rejected_at: string | null;       // T3B-1: first-reject-wins timestamp
  rejected_by: string | null;       // user:chris | user:liz
  reject_note: string | null;
  shipped_at: string | null;
  shipped_by: string | null;
  ship_blockers_json: string | null; // JSON array of blocker codes when ship is blocked
  created_at: string;
  updated_at: string;
}

// Availability of the underlying artifact file/source.
//   present : artifact exists per the catalog (or filesystem check)
//   missing : explicitly missing — catalog says it should exist but the file is gone
//   unknown : no catalog entry yet — review state exists but no metadata join
//
// "unknown" is the safe default while the catalog backfill warms up; once
// backfill runs, every artifact_review_state row should have a matching
// catalog row with availability=present|missing.
export type ArtifactAvailability = "present" | "missing" | "unknown";

// Returned by GET /outputs/inbox — minimal summary per row.
// The "inbox" framing: artifacts the operator needs to look at.
// Filter rules in storage.ts: never-viewed | viewed-not-approved | approved-not-shipped.
export interface OutputsInboxRow {
  artifact_id: string;
  source_link: string | null;
  title: string | null;           // from artifacts catalog (tl_dr from delivery-log) or null
  basename: string | null;        // from artifacts catalog or null
  agent: string | null;           // from artifacts catalog or null
  produced_at: string | null;     // ISO timestamp from artifacts catalog or null
  abs_path: string | null;        // from artifacts catalog or null
  tag: string | null;             // from artifacts catalog or null
  availability: ArtifactAvailability; // explicit instead of silent 404
  status: "never_viewed" | "viewed" | "approved" | "shipped" | "ship_blocked";
  first_viewed_at: string | null;
  approved_at: string | null;
  shipped_at: string | null;
  ship_blockers_json: string | null;
  // operator-facing meta:
  op_count: number;               // total operations recorded against this artifact
  last_op_at: string | null;
}

// Artifact catalog row. One per artifact ever produced + delivered. Created
// either by the /deliver path (live writes) or by the one-shot backfill
// reader that parses ~/Dropbox/Code/cane/taskview/delivery-log.md.
export interface ArtifactCatalogRow {
  artifact_id: string;
  basename: string;
  agent: string;
  tag: string | null;
  abs_path: string;
  title: string | null;         // the tl_dr summary from delivery-log
  produced_at: string;          // ISO from delivery-log timestamp
  source: "delivery-log" | "agent-done" | "manual" | "filesystem";
  availability: ArtifactAvailability;
  created_at: string;
  updated_at: string;
}

export interface ArtifactSourceEvidenceRow {
  evidence_id: string;
  artifact_id: string;
  source: "delivery-log" | "agent-done" | "manual" | "filesystem";
  source_ref: string;
  observed_at: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

// Payload accepted by POST /artifacts/register.
export interface RegisterArtifactRequest {
  artifact_id?: string;         // derived from abs_path if not supplied
  basename: string;
  agent: string;
  tag?: string;
  abs_path: string;
  title?: string;
  produced_at: string;          // ISO
  source?: "delivery-log" | "agent-done" | "manual" | "filesystem";
  availability?: ArtifactAvailability; // defaults to "present" — caller may say "missing"
}

export interface RegisterArtifactResponse {
  schema_version: "artifact.register.v1";
  artifact_id: string;
  inserted: boolean;            // true on first-create, false on update
  row: ArtifactCatalogRow;
}

export interface OutputsInboxResponse {
  schema_version: "outputs.inbox.v1";
  generated_at: string;
  items: OutputsInboxRow[];
  limit: number;
  offset: number;
  count: number;
}

export interface ArtifactReviewResponse {
  schema_version: "artifact.review.v1";
  artifact_id: string;
  state: ArtifactReviewStateRow | null;  // null when no review state row exists yet
  catalog: ArtifactCatalogRow | null;     // null when no catalog row exists yet
  availability: ArtifactAvailability;     // explicit; "unknown" when no catalog row
  operations_count: number;
  source_link: string | null;
  // Convenience flags for the dashboard:
  is_viewed: boolean;
  is_approved: boolean;
  is_shipped: boolean;
  is_ship_blocked: boolean;
}

export interface ArtifactOperationsResponse {
  schema_version: "artifact.operations.v1";
  artifact_id: string;
  operations: ArtifactOpRow[];
  limit: number;
  offset: number;
  count: number;
}

export interface ViewRequest {
  viewer?: string;                // optional override; defaults to "operator"
  source_link?: string;           // optional upstream pointer to backfill
}

export interface ApproveRequest {
  approver?: string;              // defaults to "operator"
  note?: string;
  source_link?: string;
}

export interface RejectRequest {
  rejecter?: string;              // resolved MondayActorRef; defaults to "operator"
  note?: string;
  source_link?: string;
}

export interface ShipRequest {
  shipper?: string;               // defaults to "operator"
  source_link?: string;
}

// Monday §2: a persisted, append-only artifact comment (op_type comment_recorded).
export interface CommentRequest {
  actor: string;                  // resolved MondayActorRef ("user:chris"|"user:liz")
  body: string;                   // the comment text
  anchor?: string | null;         // optional section/line anchor within the artifact
  source_link?: string;
}

export interface ArtifactComment {
  op_id: number;
  artifact_id: string;
  actor: string;
  body: string;
  anchor: string | null;
  ts: string;
}

// Stub-response from POST /artifacts/:id/ship. Blockers explain why
// ship is not yet possible. When executors exist, the same endpoint
// will return success.
export interface ShipResponse {
  schema_version: "artifact.ship.v1";
  artifact_id: string;
  status: "blocked" | "ok";
  blockers: string[];               // e.g. ["no_executor_configured", "approval_missing"]
  message: string;
  recorded_op_id: number | null;
}
