// Kapelle B11 manager-side backend foundation — outputs/ops.ts
//
// Mutation handlers used by routes.ts: viewArtifact, approveArtifact,
// shipArtifact. Each mutation:
//   1. Lazily creates (or updates) the artifact_review_state row.
//   2. Appends an artifact_operations row.
//   3. Returns enough state for the route to send a response.
//
// Ship is a STUB until executors exist. It returns explicit blocker
// codes so callers know exactly what's missing. The same call signature
// will return status:"ok" once those executors land — no API break.

import type { DbAdapter } from "../db/db-adapter.js";
import {
  appendOperation,
  getLastOperationByActor,
  getReviewState,
  listOperations,
  upsertReviewState,
} from "./storage.js";
import type {
  ApproveRequest,
  ArtifactComment,
  ArtifactOpType,
  ArtifactReaction,
  ArtifactReviewStateRow,
  CommentRequest,
  RejectRequest,
  ShipRequest,
  ShipResponse,
  ViewRequest,
} from "./types.js";
import { isArtifactReaction } from "./types.js";

const DEFAULT_ACTOR = "operator";

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

export interface ViewResult {
  state: ArtifactReviewStateRow;
  op_id: number;
}

export async function viewArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ViewRequest,
  now?: () => Date,
): Promise<ViewResult> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const viewer = (req.viewer || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const patch: Partial<ArtifactReviewStateRow> = {
    last_viewed_at: ts,
    viewed_by_last: viewer,
    viewed_count: (existing?.viewed_count ?? 0) + 1,
    first_viewed_at: existing?.first_viewed_at ?? ts,
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    "view",
    viewer,
    ts,
    JSON.stringify({ viewed_count_after: state.viewed_count }),
    state.source_link,
  );
  return { state, op_id: opId };
}

export interface ApproveResult {
  state: ArtifactReviewStateRow;
  op_id: number;
  /** Monday §2: true when the artifact was ALREADY approved before this call —
   *  the approval is durable + idempotent (approved_at is first-write-wins). */
  idempotent: boolean;
}

export async function approveArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ApproveRequest,
  now?: () => Date,
): Promise<ApproveResult> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const alreadyApproved = existing?.approved_at != null;
  const approver = (req.approver || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const patch: Partial<ArtifactReviewStateRow> = {
    approved_at: existing?.approved_at ?? ts, // first-approve wins for the timestamp
    approved_by: approver,
    approval_note: req.note ?? existing?.approval_note ?? null,
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    "approve",
    approver,
    ts,
    JSON.stringify({ note: req.note ?? null, idempotent: alreadyApproved }),
    state.source_link,
  );
  return { state, op_id: opId, idempotent: alreadyApproved };
}

// ── Reject (T3B-1) ──────────────────────────────────────────────────
// Mirrors approve: a durable, idempotent reject_recorded state + op with Monday
// actor attribution. First-reject wins for the timestamp; repeat rejects are
// idempotent (state unchanged).

export interface RejectResult {
  state: ArtifactReviewStateRow;
  op_id: number;
  /** True when the artifact was ALREADY rejected before this call. */
  idempotent: boolean;
}

export async function rejectArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: RejectRequest,
  now?: () => Date,
): Promise<RejectResult> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const alreadyRejected = existing?.rejected_at != null;
  const rejecter = (req.rejecter || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const patch: Partial<ArtifactReviewStateRow> = {
    rejected_at: existing?.rejected_at ?? ts, // first-reject wins for the timestamp
    rejected_by: rejecter,
    reject_note: req.note ?? existing?.reject_note ?? null,
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    "reject",
    rejecter,
    ts,
    JSON.stringify({ note: req.note ?? null, idempotent: alreadyRejected }),
    state.source_link,
  );
  return { state, op_id: opId, idempotent: alreadyRejected };
}

// ── Cooldown (T3B-1) ────────────────────────────────────────────────
// A per-(artifact, action, actor) cooldown guards against accidental
// double-fire (e.g. a double-click). It is intentionally per-ACTOR so a
// multi-operator flow — Chris approves, then Liz approves — is never blocked.

/** Default minimum interval between repeats of the same action by the same
 *  actor on the same artifact. */
export const DEFAULT_ACTION_COOLDOWN_MS = 3000;

export interface CooldownResult {
  blocked: boolean;
  retry_after_ms?: number;
  last_ts?: string;
}

/** Returns blocked=true when `actor` performed one of `opTypes` on `artifactId`
 *  within `cooldownMs`. Different actors never collide. */
export async function checkActionCooldown(
  adapter: DbAdapter,
  artifactId: string,
  opTypes: ArtifactOpType[],
  actor: string,
  cooldownMs: number,
  now?: () => Date,
): Promise<CooldownResult> {
  if (cooldownMs <= 0) return { blocked: false };
  const last = await getLastOperationByActor(adapter, artifactId, opTypes, actor);
  if (!last) return { blocked: false };
  const lastMs = Date.parse(last.ts);
  if (!Number.isFinite(lastMs)) return { blocked: false };
  const elapsed = (now ? now() : new Date()).getTime() - lastMs;
  if (elapsed < cooldownMs) {
    return { blocked: true, retry_after_ms: cooldownMs - elapsed, last_ts: last.ts };
  }
  return { blocked: false };
}

// ── Comment (Monday §2) ─────────────────────────────────────────────
// Append-only, durable artifact comment. Persisted as a comment_recorded
// operation so it re-reads through /operations and /review and is visible to
// agents. Not preview-only: every call records a real op.

export interface CommentResult {
  comment: ArtifactComment;
  op_id: number;
}

export async function commentArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: CommentRequest,
  now?: () => Date,
): Promise<CommentResult> {
  const ts = nowIso(now);
  const actor = (req.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const anchor = req.anchor ?? null;
  const reaction = req.reaction ?? null;
  // Touch the review-state row so the artifact has a durable interaction record
  // (and updated_at moves) even if it was never viewed/approved.
  const existing = await getReviewState(adapter, artifactId);
  await upsertReviewState(
    adapter,
    artifactId,
    { source_link: req.source_link ?? existing?.source_link ?? null },
    ts,
  );
  const opId = await appendOperation(
    adapter,
    artifactId,
    "comment_recorded",
    actor,
    ts,
    // C0: reaction rides the same payload; omitted for plain comments so the
    // shape stays backward-compatible with pre-reaction rows.
    JSON.stringify(reaction ? { body: req.body, anchor, reaction } : { body: req.body, anchor }),
    req.source_link ?? existing?.source_link ?? null,
  );
  return {
    op_id: opId,
    comment: { op_id: opId, artifact_id: artifactId, actor, body: req.body, anchor, reaction, ts },
  };
}

/** Read the persisted comments for an artifact (newest first), projected from
 *  the append-only comment_recorded operations. */
export async function listComments(
  adapter: DbAdapter,
  artifactId: string,
  limit = 100,
  offset = 0,
): Promise<ArtifactComment[]> {
  const ops = await listOperations(adapter, artifactId, limit, offset);
  const comments: ArtifactComment[] = [];
  for (const op of ops) {
    if (op.op_type !== "comment_recorded") continue;
    let body = "";
    let anchor: string | null = null;
    let reaction: ArtifactReaction | null = null;
    try {
      const p = op.payload_json
        ? (JSON.parse(op.payload_json) as { body?: unknown; anchor?: unknown; reaction?: unknown })
        : {};
      body = typeof p.body === "string" ? p.body : "";
      anchor = typeof p.anchor === "string" ? p.anchor : null;
      reaction = isArtifactReaction(p.reaction) ? p.reaction : null;
    } catch {
      /* tolerate legacy/malformed payloads */
    }
    comments.push({ op_id: op.op_id, artifact_id: op.artifact_id, actor: op.actor, body, anchor, reaction, ts: op.ts });
  }
  return comments;
}

// Blocker codes returned by /ship. Stable enum-style strings; clients
// match against these to render UX. Adding new codes is backwards-
// compatible; removing one is not.
export const SHIP_BLOCKERS = {
  NO_EXECUTOR: "no_executor_configured",
  NOT_APPROVED: "artifact_not_approved",
  ALREADY_SHIPPED: "already_shipped",
} as const;

export type ShipBlockerCode = (typeof SHIP_BLOCKERS)[keyof typeof SHIP_BLOCKERS];

// Returns the current blocker set for an artifact. Pure (no I/O beyond
// the existing state). Today every ship returns NO_EXECUTOR because
// no executor is wired; that's intentional. The order matters:
// ALREADY_SHIPPED checks first, NOT_APPROVED next, NO_EXECUTOR last.
// When executors land, this function becomes the single place to
// remove NO_EXECUTOR from the static blocker list.
export function computeShipBlockers(state: ArtifactReviewStateRow | null): ShipBlockerCode[] {
  const blockers: ShipBlockerCode[] = [];
  if (state?.shipped_at) blockers.push(SHIP_BLOCKERS.ALREADY_SHIPPED);
  if (!state?.approved_at) blockers.push(SHIP_BLOCKERS.NOT_APPROVED);
  // Stub: no executor is configured yet. This is the canonical "until
  // executors exist" blocker the dispatch requested.
  blockers.push(SHIP_BLOCKERS.NO_EXECUTOR);
  return blockers;
}

export async function shipArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ShipRequest,
  now?: () => Date,
): Promise<ShipResponse> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const shipper = (req.shipper || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const blockers = computeShipBlockers(existing);

  // Always record the attempt as an operation, even when blocked.
  const blocked = blockers.length > 0;
  const opType: ArtifactOpType = blocked ? "ship_blocked" : "ship_attempted";
  const patch: Partial<ArtifactReviewStateRow> = {
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  if (blocked) {
    patch.ship_blockers_json = JSON.stringify(blockers);
  } else {
    // Future: this path lights up when executors exist.
    patch.shipped_at = ts;
    patch.shipped_by = shipper;
    patch.ship_blockers_json = null;
  }
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    opType,
    shipper,
    ts,
    JSON.stringify({ blockers, attempted_by: shipper }),
    state.source_link,
  );

  return {
    schema_version: "artifact.ship.v1",
    artifact_id: artifactId,
    status: blocked ? "blocked" : "ok",
    blockers,
    message: blocked
      ? `Ship blocked by: ${blockers.join(", ")}. Recorded as operation #${opId}.`
      : `Ship recorded. Op #${opId}.`,
    recorded_op_id: opId,
  };
}
