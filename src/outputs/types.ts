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

import type { LocalHealthVisual } from "../local-search/visual-state.js";

export type ArtifactOpType =
  | "view"
  | "approve"
  | "reject"
  | "suggested_change"
  | "dispatch_follow_up"
  | "ship_attempted"
  | "ship_blocked"
  | "comment_recorded"
  | "edit"
  // CANE_DRAFT_ARTIFACTS: an operator's in-place rewrite of a cane_draft body.
  // Distinct from the generic `edit` op (edit.ts): revise_draft mutates the
  // typed draft payload's body_markdown and appends to its revision_history.
  | "revise_draft"
  // C0_FEEDBACK_REACTIONS (T-CKPT.feedback-system/C0): the durable linkage op
  // recorded after a comment/reaction is routed to its owning agent. Carries
  // {source_op_id, dispatch_phid, query_id, to_agent} so the acted-upon read
  // model can trace feedback → the dispatch it fired. B2 returned the receipt
  // only in the HTTP response; this op persists it so the chip survives reloads.
  | "comment_routed"
  // Artifact Review v1 (2026-06-29 suggested-change contract): a span-edit
  // proposal + its append-only lifecycle (proposed → accepted/rejected/
  // superseded/stale). Distinct from the v0 free-form `suggested_change` op:
  // a `suggestion` carries original_text/proposed_text and is applied via the
  // reversible `edit` op. See outputs/suggestion.ts.
  | "suggestion";

// Artifact kind for a Cane email/telegram draft that needs operator approval
// before it is sent. The send executor (ship-executor.ts) only fires for this
// kind; every other kind keeps returning no_executor_configured.
export const CANE_DRAFT_KIND = "cane_draft" as const;
export type CaneDraftKind = typeof CANE_DRAFT_KIND;

// One append-only revision-history entry for a cane_draft (operator edits).
export interface CaneDraftRevision {
  at: string;        // ISO-8601 UTC
  by: string;        // actor ref (e.g. user:chris)
  from_len: number;  // length of the body BEFORE this revision (audit aid)
}

// Typed payload carried by a cane_draft artifact, stored in artifact_drafts.
// draft_id is the idempotency anchor and == the artifact's source_link.
export interface CaneDraftPayload {
  draft_id: string;                 // "cane:draft:<pending_id>" — stable, unique
  channel: "email" | "telegram";
  to: string;                       // recipient address
  subject: string;
  body_markdown: string;            // the current draft body (editable in place)
  in_reply_to?: string | null;      // threading: Message-ID being replied to
  references?: string | null;       // threading: References header
  source_inbox_ref?: string | null; // inbox-item phid | state.json pending_id
  send_recommendation: "needs_approval"; // only needs_approval becomes an artifact
  reasoning?: string | null;        // why it needs approval
  revision_history: CaneDraftRevision[]; // append-only operator edits
}

// One row in artifact_drafts — the typed draft payload keyed by artifact_id,
// with draft_id UNIQUE for idempotent (re-)registration.
export interface ArtifactDraftRow {
  artifact_id: string;
  draft_id: string;
  payload_json: string; // serialized CaneDraftPayload
  created_at: string;
  updated_at: string;
}

// Append-only audit event for an artifact. Lives in artifact_operations.
export interface ArtifactOpRow {
  op_id: number;                  // SQLite autoincrement
  artifact_id: string;            // the artifact phid (cross-system stable id)
  op_type: ArtifactOpType;
  actor: string;                  // operator id, agent id, or "system"
  ts: string;                     // ISO-8601 UTC
  payload_json: string | null;    // structured op-specific JSON (note, blockers, etc.)
  source_link: string | null;     // doc-model pointer when mirrored from upstream
  idempotency_key?: string | null; // optional caller-supplied dedupe key
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

export type ArtifactMediaType =
  | "text/markdown"
  | "text/html"
  | "text/plain"
  | "application/json"
  | "application/pdf"
  | "unknown";

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
  local_visual_state: LocalHealthVisual;
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
  media_type: ArtifactMediaType | null;
  content_hash: string | null;
  source_mtime: string | null;
  source_size: number | null;
  project_ref: string | null;
  dispatch_ref: string | null;
  source_host: string | null;
  // T11.7: JSON array of the distinct sources that have observed this artifact
  // (e.g. ["filesystem","agent-done"]) — the console's source badges.
  source_badges: string;
  // T11.7: when the filesystem reconciler last confirmed this artifact's state.
  reconciled_at: string | null;
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
  source_badges?: string[];     // T11.7: distinct observing sources
  reconciled_at?: string;       // T11.7: last filesystem reconcile time
  title?: string;
  produced_at: string;          // ISO
  source?: "delivery-log" | "agent-done" | "manual" | "filesystem";
  availability?: ArtifactAvailability; // defaults to "present" — caller may say "missing"
  media_type?: ArtifactMediaType;
  content_hash?: string | null;
  source_mtime?: string | null;
  source_size?: number | null;
  project_ref?: string | null;
  dispatch_ref?: string | null;
  source_host?: string | null;
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
  is_rejected: boolean;
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

export type ArtifactTimelineEventKind =
  | "view"
  | "comment"
  | "suggested_change"
  | "approval"
  | "rejection"
  | "dispatch_follow_up"
  | "comment_routed"
  | "ship"
  | "ship_blocked"
  | "edit"
  | "draft_revision";

export interface ArtifactDispatchReceipt {
  target_agent: string | null;
  query_id: string | null;
  dispatch_phid: string | null;
  status: string | null;
}

export type ArtifactCommentVisibleState =
  | "recorded+routed"
  | "recorded-but-route-failed-with-retry"
  | "not-recorded";

export interface ArtifactCommentRouteStatus {
  visible_state: ArtifactCommentVisibleState;
  route_kind: "acknowledgement" | "approval_signal" | "substantive_follow_up" | "question";
  routed: boolean;
  retryable: boolean;
  recorded_op_id: number;
  target_agent: string | null;
  target_agent_raw: string | null;
  dispatch: {
    query_id: string;
    dispatch_phid: string;
    to_agent: string;
  } | null;
  skipped: string | null;
  error: { message: string } | null;
  updated_at: string;
}

export interface ArtifactTimelineEvent {
  event_id: string;
  op_id: number;
  artifact_id: string;
  kind: ArtifactTimelineEventKind;
  status: string;
  actor: string;
  ts: string;
  markdown: string | null;
  body: string | null;
  anchor: string | null;
  source_link: string | null;
  idempotency_key: string | null;
  dispatch_receipt: ArtifactDispatchReceipt | null;
  payload: Record<string, unknown>;
}

export interface ArtifactTimelineResponse {
  ok: true;
  schema_version: "artifact.timeline.v1";
  artifact_id: string;
  events: ArtifactTimelineEvent[];
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
  idempotency_key?: string | null;
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
  idempotency_key?: string | null;
}

export interface SuggestedChangeRequest {
  actor: string;
  body: string;
  anchor?: string | null;
  suggested_markdown?: string | null;
  status?: "open" | "applied" | "dismissed";
  source_link?: string;
  idempotency_key?: string | null;
}

export interface DispatchFollowUpRequest {
  actor: string;
  body?: string | null;
  target_agent?: string | null;
  query_id?: string | null;
  dispatch_phid?: string | null;
  status?: string | null;
  source_link?: string;
  idempotency_key?: string | null;
}

/**
 * Stable, globally-unique id for one artifact comment — the dedup/idempotency
 * key the inbox digest ledger keys on (fix-spec 2026-06-29 §S5). `op_id` alone
 * is only per-artifact-unique (and FeedbackItem doesn't even carry artifact_id),
 * so the digest needs one string that is globally unique + deterministic +
 * stable across reads. Derived from (artifact_id, op_id): a comment written
 * idempotently (same idempotency_key → same op_id) yields the SAME comment_id,
 * so it is counted once ever across digest windows.
 */
export function artifactCommentId(artifactId: string, opId: number): string {
  return `acmt:${artifactId}:${opId}`;
}

export interface ArtifactComment {
  /** Stable, globally-unique dedup key = artifactCommentId(artifact_id, op_id). */
  comment_id: string;
  op_id: number;
  artifact_id: string;
  actor: string;
  body: string;
  anchor: string | null;
  ts: string;
  // C0_FEEDBACK_REACTIONS: present when this comment was a one-tap reaction
  // (👍/👎/❓/🔁). Plain free-text comments leave it null. A reaction is still a
  // comment_recorded op — it rides the existing /comments listing and the
  // existing comment-auto-dispatch (T-CKPT.7) unchanged — so reactions never
  // duplicate the comment-routing path; they are the lowest-click form of it.
  reaction?: ReactionKind | null;
  route_status?: ArtifactCommentRouteStatus | null;
}

// ── C0 ambient reactions (T-CKPT.feedback-system/C0) ────────────────
// The four canonical lowest-click reactions, per chris-feedback-system-design
// §3 C0. A reaction is a one-tap structured comment; the value is the stored
// key, `emoji`/`label` are render hints surfaced to the owning agent and chip.
export const ARTIFACT_REACTIONS = {
  acknowledged: { emoji: "👍", label: "acknowledged" },
  ship_it: { emoji: "🚢", label: "ship it" },
  wrong: { emoji: "👎", label: "wrong" },
  explain: { emoji: "❓", label: "explain" },
  iterate: { emoji: "🔁", label: "iterate" },
} as const;

export type ReactionKind = keyof typeof ARTIFACT_REACTIONS;

export function isReactionKind(v: unknown): v is ReactionKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ARTIFACT_REACTIONS, v);
}

export interface ReactionRequest {
  actor: string; // resolved MondayActorRef ("user:chris"|"user:liz")
  reaction: ReactionKind;
  note?: string | null; // optional one-sentence elaboration
  anchor?: string | null;
  source_link?: string;
}

// ── C0 acted-upon read model (GET /artifacts/:id/feedback) ──────────
// The close-the-loop surface: every reaction/comment on an artifact, each
// annotated with the dispatch it fired (if any), plus a rolled-up acted-upon
// summary the chip renders. Derived purely from the append-only op log
// (comment_recorded + comment_routed) — never from prose.

/** The dispatch a single piece of feedback fired, as persisted by the
 *  comment_routed op. */
export interface FeedbackRouting {
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string;
  routed_at: string;
  // S4 (inbox-digest-manager-source): the routed dispatch's LIVE status,
  // resolved only on the reconcile view (GET /artifacts/:id/feedback?reconcile=1)
  // when the manager binds a dispatch-status resolver. On the default decoupled
  // read model these stay null so the existing chip contract is unchanged.
  // `is_terminal` lets the Cane digest drop already-closed loops (done/failed/
  // cancelled) from live "needs you" / "routed" views without re-encoding the
  // terminal set. `status: null` (unresolved) is treated as still-live.
  status?: string | null;
  effective_state?: string | null;
  is_terminal?: boolean;
}

/** S4: the minimal live-status view of a routed dispatch, returned by the
 *  injected resolver and stamped onto FeedbackRouting on the reconcile view. */
export interface DispatchStatusLite {
  status: string;
  effective_state: string | null;
  is_terminal: boolean;
}

/** S4: resolves a routed dispatch's live status by its stable `dispatch_phid`.
 *  Team is already bound (the route resolves it per-request), so the pure
 *  reconcile helper stays team-agnostic. Returns null when the dispatch is not
 *  found (e.g. purged) — the reconcile view then leaves status null (live). */
export type DispatchStatusResolver = (
  dispatchPhid: string,
) => Promise<DispatchStatusLite | null>;

/** S4: the team-aware seam the manager binds into mountOutputsRoutes (the
 *  dispatch store is keyed by team). The route resolves the request's team via
 *  `resolveTeamId` and curries it down to a plain DispatchStatusResolver. */
export type TeamAwareDispatchStatusResolver = (
  dispatchPhid: string,
  teamId: string,
) => Promise<DispatchStatusLite | null>;

export interface FeedbackItem {
  /** Stable, globally-unique dedup key = artifactCommentId(artifact_id, op_id).
   *  FeedbackItem carries no artifact_id, so op_id alone is not globally unique —
   *  this is the id the digest ledger dedups/reconciles on (fix-spec §S5). */
  comment_id: string;
  op_id: number;
  actor: string;
  /** "reaction" when reaction != null, else "comment". */
  kind: "reaction" | "comment";
  reaction: ReactionKind | null;
  body: string;
  anchor: string | null;
  ts: string;
  /** The dispatch this feedback routed to its owning agent, or null when it
   *  never routed (no owner / no scheduler / flag was off at capture time). */
  routing: FeedbackRouting | null;
  route_status?: ArtifactCommentRouteStatus | null;
}

/** Rolled-up acted-upon state for the chip. `routed` = at least one piece of
 *  feedback fired a dispatch to the owning agent (the loop is in motion).
 *  Live dispatch terminal status (done/in_flight) is intentionally NOT resolved
 *  here — the frontend/chip resolves it from `routed_dispatches[].dispatch_phid`
 *  so this read model stays decoupled from the manager dispatch store. */
export interface ActedUponSummary {
  state: "none" | "captured" | "routed";
  feedback_count: number;
  reaction_count: number;
  routed_count: number;
  last_reaction: ReactionKind | null;
  last_feedback_at: string | null;
  routed_dispatches: FeedbackRouting[];
}

export interface ArtifactFeedbackResponse {
  ok: true;
  schema_version: "artifact.feedback.v1";
  artifact_id: string;
  acted_upon: ActedUponSummary;
  items: FeedbackItem[];
  count: number;
}

export interface ArtifactDetailBody {
  kind: "markdown" | "html" | "text" | "json" | "image" | "binary" | "missing" | "unavailable";
  text: string | null;
  bytes: number | null;
  truncated: boolean;
  source: "file" | "artifact_body_cache" | "cane_draft" | "none";
  error: string | null;
}

export interface ArtifactDetailRender {
  renderer: "markdown" | "html" | "text" | "json" | "image" | "download" | "empty";
  mime_type: string;
  filename: string | null;
}

export interface ArtifactDetailMetadata {
  artifact_id: string;
  display_title: string;
  basename: string | null;
  agent: string | null;
  tag: string | null;
  produced_at: string | null;
  abs_path: string | null;
  source: ArtifactCatalogRow["source"] | null;
  availability: ArtifactAvailability;
  media_type: ArtifactMediaType | null;
  content_hash: string | null;
  source_mtime: string | null;
  source_size: number | null;
  project_ref: string | null;
  dispatch_ref: string | null;
  source_host: string | null;
  source_badges: string[];
  reconciled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  local_visual_state: LocalHealthVisual;
}

export interface ArtifactDetailReviewSummary {
  state: ArtifactReviewStateRow | null;
  status: OutputsInboxRow["status"];
  operations_count: number;
  comments_count: number;
  timeline_count: number;
  latest_comment: ArtifactComment | null;
  latest_timeline_event: ArtifactTimelineEvent | null;
  is_viewed: boolean;
  is_approved: boolean;
  is_rejected: boolean;
  is_shipped: boolean;
  is_ship_blocked: boolean;
}

export interface ArtifactDetailProvenanceSummary {
  entry: import("./entry.js").ArtifactEntry | null;
  evidence: ArtifactSourceEvidenceRow[];
}

export interface ArtifactDeliveryLinks {
  artifactId: string;
  stableUrl: string;
  copyTextUrl: string;
  downloadUrl: string;
  sourcePath: string | null;
  bodyRenderable: boolean;
  bodyPreview: string | null;
  bodyUnavailable: boolean;
  freshness: "current" | "syncing" | "stale" | "event_gap" | "body_unavailable" | "error";
  discoveredBy: "agent_done" | "artifact_register" | "filesystem_reconcile" | "manual_fixture";
}

export interface ArtifactDetailResponse {
  ok: true;
  schema_version: "artifact.detail.v1";
  generated_at: string;
  artifact_id: string;
  requested_ref: string;
  resolved_from: "artifact_id" | "encoded_path" | "path";
  displayTitle: string;
  stableUrl: string;
  copyTextUrl: string;
  downloadUrl: string;
  metadata: ArtifactDetailMetadata;
  body: ArtifactDetailBody;
  render: ArtifactDetailRender;
  delivery: ArtifactDeliveryLinks;
  review: ArtifactDetailReviewSummary;
  comments: ArtifactComment[];
  timeline: ArtifactTimelineEvent[];
  provenance: ArtifactDetailProvenanceSummary;
  draft: CaneDraftPayload | null;
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
