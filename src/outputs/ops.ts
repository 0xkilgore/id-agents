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
  getArtifactDraft,
  getLastOperationByActor,
  getReviewState,
  listOperations,
  parseDraftPayload,
  upsertArtifactDraft,
  upsertReviewState,
} from "./storage.js";
import type {
  ActedUponSummary,
  ApproveRequest,
  ArtifactDispatchReceipt,
  ArtifactComment,
  ArtifactOpRow,
  ArtifactOpType,
  ArtifactReviewStateRow,
  ArtifactTimelineEvent,
  CaneDraftPayload,
  CommentRequest,
  DispatchFollowUpRequest,
  FeedbackItem,
  FeedbackRouting,
  ReactionKind,
  ReactionRequest,
  RejectRequest,
  ShipRequest,
  ShipResponse,
  SuggestedChangeRequest,
  ViewRequest,
} from "./types.js";
import { ARTIFACT_REACTIONS, isReactionKind } from "./types.js";
import type { CaneDraftSender } from "./ship-executor.js";
import { pendingIdFromDraftId } from "./ship-executor.js";

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
    req.idempotency_key,
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
    JSON.stringify({ body: req.body, anchor }),
    req.source_link ?? existing?.source_link ?? null,
    req.idempotency_key,
  );
  return {
    op_id: opId,
    comment: { op_id: opId, artifact_id: artifactId, actor, body: req.body, anchor, ts },
  };
}

export interface SuggestedChangeResult {
  event: ArtifactTimelineEvent;
  op_id: number;
  idempotent: boolean;
}

export async function suggestArtifactChange(
  adapter: DbAdapter,
  artifactId: string,
  req: SuggestedChangeRequest,
  now?: () => Date,
): Promise<SuggestedChangeResult> {
  const ts = nowIso(now);
  const actor = (req.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const anchor = req.anchor ?? null;
  const status = req.status ?? "open";
  const existing = await getReviewState(adapter, artifactId);
  await upsertReviewState(
    adapter,
    artifactId,
    { source_link: req.source_link ?? existing?.source_link ?? null },
    ts,
  );
  const before = req.idempotency_key ? await countMatchingIdempotency(adapter, artifactId, req.idempotency_key) : 0;
  const opId = await appendOperation(
    adapter,
    artifactId,
    "suggested_change",
    actor,
    ts,
    JSON.stringify({
      body: req.body,
      anchor,
      suggested_markdown: req.suggested_markdown ?? null,
      status,
    }),
    req.source_link ?? existing?.source_link ?? null,
    req.idempotency_key,
  );
  const op = (await listOperations(adapter, artifactId, 1000, 0)).find((row) => row.op_id === opId);
  if (!op) throw new Error(`suggested_change op ${opId} was not readable`);
  return { op_id: opId, event: timelineEventFromOperation(op), idempotent: before > 0 };
}

export interface DispatchFollowUpResult {
  event: ArtifactTimelineEvent;
  op_id: number;
  idempotent: boolean;
}

export async function recordDispatchFollowUp(
  adapter: DbAdapter,
  artifactId: string,
  req: DispatchFollowUpRequest,
  now?: () => Date,
): Promise<DispatchFollowUpResult> {
  const ts = nowIso(now);
  const actor = (req.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const existing = await getReviewState(adapter, artifactId);
  await upsertReviewState(
    adapter,
    artifactId,
    { source_link: req.source_link ?? existing?.source_link ?? null },
    ts,
  );
  const before = req.idempotency_key ? await countMatchingIdempotency(adapter, artifactId, req.idempotency_key) : 0;
  const opId = await appendOperation(
    adapter,
    artifactId,
    "dispatch_follow_up",
    actor,
    ts,
    JSON.stringify({
      body: req.body ?? null,
      target_agent: req.target_agent ?? null,
      query_id: req.query_id ?? null,
      dispatch_phid: req.dispatch_phid ?? null,
      status: req.status ?? "queued",
    }),
    req.source_link ?? existing?.source_link ?? null,
    req.idempotency_key,
  );
  const op = (await listOperations(adapter, artifactId, 1000, 0)).find((row) => row.op_id === opId);
  if (!op) throw new Error(`dispatch_follow_up op ${opId} was not readable`);
  return { op_id: opId, event: timelineEventFromOperation(op), idempotent: before > 0 };
}

async function countMatchingIdempotency(
  adapter: DbAdapter,
  artifactId: string,
  idempotencyKey: string,
): Promise<number> {
  const { rows } = await adapter.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM artifact_operations WHERE artifact_id = ? AND idempotency_key = ?`,
    [artifactId, idempotencyKey],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Read the persisted comments for an artifact (newest first), projected from
 *  the append-only comment_recorded operations. Reactions (C0) are
 *  comment_recorded ops too, so they appear here with `reaction` populated. */
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
    const { body, anchor, reaction } = parseCommentPayload(op.payload_json);
    comments.push({ op_id: op.op_id, artifact_id: op.artifact_id, actor: op.actor, body, anchor, ts: op.ts, reaction });
  }
  return comments;
}

function parseCommentPayload(payloadJson: string | null): {
  body: string;
  anchor: string | null;
  reaction: ReactionKind | null;
} {
  let body = "";
  let anchor: string | null = null;
  let reaction: ReactionKind | null = null;
  try {
    const p = payloadJson
      ? (JSON.parse(payloadJson) as { body?: unknown; anchor?: unknown; reaction?: unknown })
      : {};
    body = typeof p.body === "string" ? p.body : "";
    anchor = typeof p.anchor === "string" ? p.anchor : null;
    reaction = isReactionKind(p.reaction) ? p.reaction : null;
  } catch {
    /* tolerate legacy/malformed payloads */
  }
  return { body, anchor, reaction };
}

// ── C0 ambient reactions (T-CKPT.feedback-system/C0) ────────────────
// A reaction is the lowest-click comment: one tap → a typed reaction (and an
// optional one-sentence note). It is persisted as a `comment_recorded` op with
// a `reaction` field in the payload, so it rides the EXISTING /comments listing
// and the EXISTING comment-auto-dispatch (routes.ts) unchanged — the C0 spec's
// "increment over T-CKPT.7, do not duplicate comment-routing".

/** The human-readable body synthesized for a reaction, e.g. "👎 wrong" or
 *  "🔁 iterate — tighten the hero". Used as the comment body the owning agent
 *  reads and the /comments listing shows. */
export function reactionBody(reaction: ReactionKind, note?: string | null): string {
  const { emoji, label } = ARTIFACT_REACTIONS[reaction];
  const head = `${emoji} ${label}`;
  const trimmed = note?.trim();
  return trimmed ? `${head} — ${trimmed}` : head;
}

export async function reactArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ReactionRequest,
  now?: () => Date,
): Promise<CommentResult> {
  if (!isReactionKind(req.reaction)) {
    throw new Error(`invalid reaction: ${String(req.reaction)}`);
  }
  const ts = nowIso(now);
  const actor = (req.actor || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const anchor = req.anchor ?? null;
  const note = req.note?.trim() || null;
  const body = reactionBody(req.reaction, note);
  // Touch review-state so the artifact carries a durable interaction record.
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
    JSON.stringify({ body, anchor, reaction: req.reaction, note }),
    req.source_link ?? existing?.source_link ?? null,
  );
  return {
    op_id: opId,
    comment: { op_id: opId, artifact_id: artifactId, actor, body, anchor, ts, reaction: req.reaction },
  };
}

// ── C0 close-the-loop: durable feedback → dispatch linkage ──────────
// B2 (comment-auto-dispatch) returned the dispatch receipt only in the HTTP
// response, so a page reload lost the link. This persists it as an append-only
// `comment_routed` op keyed to the source comment's op_id, so the acted-upon
// read model survives restarts. Append-only and additive — it NEVER blocks the
// durable comment capture (called after routing, failures swallowed by caller).

export interface CommentRoutedInput {
  source_op_id: number;
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string;
}

export async function recordCommentRouted(
  adapter: DbAdapter,
  artifactId: string,
  input: CommentRoutedInput,
  actor: string,
  now?: () => Date,
): Promise<number> {
  const ts = nowIso(now);
  return appendOperation(
    adapter,
    artifactId,
    "comment_routed",
    actor,
    ts,
    JSON.stringify({
      source_op_id: input.source_op_id,
      dispatch_phid: input.dispatch_phid,
      query_id: input.query_id,
      to_agent: input.to_agent,
    }),
    null,
  );
}

// ── C0 acted-upon read model (GET /artifacts/:id/feedback) ──────────
// Projects the append-only op log into the chip's read model: every reaction /
// comment, each annotated with the dispatch it fired (joined from comment_routed
// by source_op_id), plus a rolled-up acted-upon summary. Pure derivation — no
// prose parsing, no live dispatch-store coupling (the chip resolves terminal
// dispatch status from routed_dispatches[].dispatch_phid itself).

function parseRoutedPayload(
  payloadJson: string | null,
): { source_op_id: number; routing: Omit<FeedbackRouting, "routed_at"> } | null {
  try {
    const p = payloadJson
      ? (JSON.parse(payloadJson) as {
          source_op_id?: unknown;
          dispatch_phid?: unknown;
          query_id?: unknown;
          to_agent?: unknown;
        })
      : {};
    if (typeof p.source_op_id !== "number" || typeof p.dispatch_phid !== "string" || typeof p.to_agent !== "string") {
      return null;
    }
    return {
      source_op_id: p.source_op_id,
      routing: {
        dispatch_phid: p.dispatch_phid,
        query_id: typeof p.query_id === "string" ? p.query_id : null,
        to_agent: p.to_agent,
      },
    };
  } catch {
    return null;
  }
}

export async function listFeedback(
  adapter: DbAdapter,
  artifactId: string,
  limit = 200,
  offset = 0,
): Promise<{ items: FeedbackItem[]; acted_upon: ActedUponSummary }> {
  const ops = await listOperations(adapter, artifactId, limit, offset);
  // Index routing ops by the comment op_id they reference. Latest routed wins
  // for a given source (re-routes are rare but additive).
  const routingBySource = new Map<number, FeedbackRouting>();
  for (const op of ops) {
    if (op.op_type !== "comment_routed") continue;
    const parsed = parseRoutedPayload(op.payload_json);
    if (!parsed) continue;
    // ops are newest-first, so the first routed op seen for a source is the
    // latest — keep it, skip older re-routes.
    if (routingBySource.has(parsed.source_op_id)) continue;
    routingBySource.set(parsed.source_op_id, { ...parsed.routing, routed_at: op.ts });
  }

  const items: FeedbackItem[] = [];
  for (const op of ops) {
    if (op.op_type !== "comment_recorded") continue;
    const { body, anchor, reaction } = parseCommentPayload(op.payload_json);
    items.push({
      op_id: op.op_id,
      actor: op.actor,
      kind: reaction ? "reaction" : "comment",
      reaction,
      body,
      anchor,
      ts: op.ts,
      routing: routingBySource.get(op.op_id) ?? null,
    });
  }
  // listOperations is op_id ASC (oldest-first). For the chip/feed we surface
  // newest-first so items[0] is the most recent piece of feedback.
  items.reverse();

  // Build the summary off the newest-first items.
  const reactionItems = items.filter((i) => i.reaction);
  const routedDispatches = items.map((i) => i.routing).filter((r): r is FeedbackRouting => r != null);
  const state: ActedUponSummary["state"] =
    items.length === 0 ? "none" : routedDispatches.length > 0 ? "routed" : "captured";
  const acted_upon: ActedUponSummary = {
    state,
    feedback_count: items.length,
    reaction_count: reactionItems.length,
    routed_count: routedDispatches.length,
    last_reaction: reactionItems[0]?.reaction ?? null,
    last_feedback_at: items[0]?.ts ?? null,
    routed_dispatches: routedDispatches,
  };
  return { items, acted_upon };
}

// ── Artifact review timeline (T-CKPT Artifact Review v1) ───────────
// Durable read model over artifact_operations. This keeps legacy operation
// writes as the source of truth while exposing typed review events for the
// Artifact Review UI.

export async function listTimelineEvents(
  adapter: DbAdapter,
  artifactId: string,
  limit = 100,
  offset = 0,
): Promise<ArtifactTimelineEvent[]> {
  const ops = await listOperations(adapter, artifactId, limit, offset);
  return ops.map(timelineEventFromOperation);
}

export function timelineEventFromOperation(op: ArtifactOpRow): ArtifactTimelineEvent {
  const payload = parsePayloadObject(op.payload_json);
  const body = stringOrNull(payload.body) ?? stringOrNull(payload.note);
  const anchor = stringOrNull(payload.anchor);
  const receipt = dispatchReceiptFromPayload(payload);
  return {
    event_id: `artifact-event-${op.op_id}`,
    op_id: op.op_id,
    artifact_id: op.artifact_id,
    kind: timelineKind(op.op_type, payload),
    status: timelineStatus(op.op_type, payload),
    actor: op.actor,
    ts: op.ts,
    markdown: stringOrNull(payload.suggested_markdown) ?? body,
    body,
    anchor,
    source_link: op.source_link,
    idempotency_key: op.idempotency_key ?? null,
    dispatch_receipt: receipt,
    payload,
  };
}

function parsePayloadObject(payloadJson: string | null): Record<string, unknown> {
  if (!payloadJson) return {};
  try {
    const value = JSON.parse(payloadJson);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dispatchReceiptFromPayload(payload: Record<string, unknown>): ArtifactDispatchReceipt | null {
  const targetAgent = stringOrNull(payload.target_agent) ?? stringOrNull(payload.to_agent);
  const queryId = stringOrNull(payload.query_id);
  const dispatchPhid = stringOrNull(payload.dispatch_phid);
  const status = stringOrNull(payload.status);
  if (!targetAgent && !queryId && !dispatchPhid && !status) return null;
  return {
    target_agent: targetAgent,
    query_id: queryId,
    dispatch_phid: dispatchPhid,
    status,
  };
}

function timelineKind(opType: ArtifactOpType, payload: Record<string, unknown>): ArtifactTimelineEvent["kind"] {
  switch (opType) {
    case "view":
      return "view";
    case "approve":
      return "approval";
    case "reject":
      return "rejection";
    case "suggested_change":
      return "suggested_change";
    case "dispatch_follow_up":
      return "dispatch_follow_up";
    case "comment_routed":
      return "comment_routed";
    case "ship_attempted":
      return "ship";
    case "ship_blocked":
      return "ship_blocked";
    case "edit":
      return "edit";
    case "revise_draft":
      return "draft_revision";
    case "comment_recorded":
      return stringOrNull(payload.suggested_markdown) ? "suggested_change" : "comment";
  }
}

function timelineStatus(opType: ArtifactOpType, payload: Record<string, unknown>): string {
  const payloadStatus = stringOrNull(payload.status);
  if (payloadStatus) return payloadStatus;
  switch (opType) {
    case "view":
      return "viewed";
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "dispatch_follow_up":
    case "comment_routed":
      return "routed";
    case "ship_attempted":
      return "shipped";
    case "ship_blocked":
      return "blocked";
    case "suggested_change":
      return "open";
    default:
      return "recorded";
  }
}

// ── Revise draft (CANE_DRAFT_ARTIFACTS) ─────────────────────────────
// An operator's in-place rewrite of a cane_draft body. Append-only and
// latest-wins, mirroring edit.ts's derivation pattern, but a DISTINCT op type
// (`revise_draft`) gated by CANE_DRAFT_ARTIFACTS — it does not touch edit.ts's
// generic `edit` op or its ARTIFACTS_EDIT_IN_PRODUCT flag. Each revise:
//   1. updates the typed draft payload's body_markdown,
//   2. appends a {at,by,from_len} entry to revision_history,
//   3. records a `revise_draft` op row (the audit trail).

export const REVISE_DRAFT_OP_TYPE = "revise_draft" as const;

export interface ReviseDraftResult {
  payload: CaneDraftPayload;
  op_id: number;
}

/** The latest in-place body for a cane_draft, used by the send executor.
 *  = the most recent `revise_draft` op's body, falling back to the registered
 *  payload body when there has been no revision. Pure (op-log derivation). */
export function latestDraftBody(payload: CaneDraftPayload, ops: ArtifactOpRow[]): string {
  let latest: ArtifactOpRow | null = null;
  for (const op of ops) {
    if (op.op_type !== REVISE_DRAFT_OP_TYPE) continue;
    if (!latest || op.op_id > latest.op_id) latest = op;
  }
  if (!latest) return payload.body_markdown;
  try {
    const parsed = JSON.parse(latest.payload_json ?? "{}") as { body_markdown?: unknown };
    if (typeof parsed.body_markdown === "string") return parsed.body_markdown;
  } catch {
    /* malformed → fall back to registered body */
  }
  return payload.body_markdown;
}

export async function reviseDraft(
  adapter: DbAdapter,
  artifactId: string,
  bodyMarkdown: string,
  actor: string,
  now?: () => Date,
): Promise<ReviseDraftResult> {
  const ts = nowIso(now);
  const draftRow = await getArtifactDraft(adapter, artifactId);
  const payload = parseDraftPayload(draftRow);
  if (!payload) {
    throw new Error(`no cane_draft payload for artifact ${artifactId}`);
  }
  const fromLen = payload.body_markdown.length;
  const next: CaneDraftPayload = {
    ...payload,
    body_markdown: bodyMarkdown,
    revision_history: [
      ...(payload.revision_history ?? []),
      { at: ts, by: actor, from_len: fromLen },
    ],
  };
  await upsertArtifactDraft(adapter, artifactId, next, ts);
  // Touch the review-state row so the artifact has a durable interaction record.
  const existing = await getReviewState(adapter, artifactId);
  await upsertReviewState(
    adapter,
    artifactId,
    { source_link: existing?.source_link ?? next.draft_id },
    ts,
  );
  const opId = await appendOperation(
    adapter,
    artifactId,
    REVISE_DRAFT_OP_TYPE,
    actor,
    ts,
    JSON.stringify({ body_markdown: bodyMarkdown, from_len: fromLen }),
    existing?.source_link ?? next.draft_id,
  );
  return { payload: next, op_id: opId };
}

// Blocker codes returned by /ship. Stable enum-style strings; clients
// match against these to render UX. Adding new codes is backwards-
// compatible; removing one is not.
export const SHIP_BLOCKERS = {
  NO_EXECUTOR: "no_executor_configured",
  NOT_APPROVED: "artifact_not_approved",
  ALREADY_SHIPPED: "already_shipped",
  SEND_FAILED: "cane_send_failed",
} as const;

export type ShipBlockerCode = (typeof SHIP_BLOCKERS)[keyof typeof SHIP_BLOCKERS];

// Returns the current blocker set for an artifact. Pure (no I/O beyond
// the existing state). The order matters: ALREADY_SHIPPED checks first,
// NOT_APPROVED next, NO_EXECUTOR last.
//
// For a cane_draft artifact (opts.isCaneDraft), the send executor IS the
// executor, so NO_EXECUTOR is NOT pushed — ALREADY_SHIPPED + NOT_APPROVED still
// gate it (approve-before-send + idempotent shipped_at). For EVERY OTHER kind,
// NO_EXECUTOR is pushed exactly as before (no executor wired).
export function computeShipBlockers(
  state: ArtifactReviewStateRow | null,
  opts: { isCaneDraft?: boolean } = {},
): ShipBlockerCode[] {
  const blockers: ShipBlockerCode[] = [];
  if (state?.shipped_at) blockers.push(SHIP_BLOCKERS.ALREADY_SHIPPED);
  if (!state?.approved_at) blockers.push(SHIP_BLOCKERS.NOT_APPROVED);
  if (!opts.isCaneDraft) {
    // No executor is configured for non-cane_draft kinds. This is the canonical
    // "until executors exist" blocker the original dispatch requested.
    blockers.push(SHIP_BLOCKERS.NO_EXECUTOR);
  }
  return blockers;
}

// CANE_DRAFT_ARTIFACTS — the ship context the route injects when the artifact is
// a cane_draft and the flag is ON. Carries the typed payload, the op-log (to
// derive the latest revised body), and the injectable Cane sender.
export interface CaneDraftShipContext {
  payload: CaneDraftPayload;
  ops: ArtifactOpRow[];
  sender: CaneDraftSender;
}

export async function shipArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ShipRequest,
  now?: () => Date,
  caneDraft?: CaneDraftShipContext,
): Promise<ShipResponse> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const shipper = (req.shipper || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const isCaneDraft = !!caneDraft;
  const blockers = computeShipBlockers(existing, { isCaneDraft });

  // Always record the attempt as an operation, even when blocked.
  const blocked = blockers.length > 0;
  const patch: Partial<ArtifactReviewStateRow> = {
    source_link: req.source_link ?? existing?.source_link ?? null,
  };

  if (blocked) {
    patch.ship_blockers_json = JSON.stringify(blockers);
    const state = await upsertReviewState(adapter, artifactId, patch, ts);
    const opId = await appendOperation(
      adapter,
      artifactId,
      "ship_blocked",
      shipper,
      ts,
      JSON.stringify({ blockers, attempted_by: shipper }),
      state.source_link,
    );
    return {
      schema_version: "artifact.ship.v1",
      artifact_id: artifactId,
      status: "blocked",
      blockers,
      message: `Ship blocked by: ${blockers.join(", ")}. Recorded as operation #${opId}.`,
      recorded_op_id: opId,
    };
  }

  // Not blocked. For cane_draft, actually perform the send via the single Cane
  // send path before recording shipped_at. The ALREADY_SHIPPED blocker above
  // makes a second ship a no-op (no double-send) — first-write-wins shipped_at.
  if (isCaneDraft && caneDraft) {
    const body = latestDraftBody(caneDraft.payload, caneDraft.ops);
    const result = await caneDraft.sender(caneDraft.payload, body);
    if (!result.ok || !result.evidence) {
      // Send failed: record a blocked attempt (not shipped) so a retry is
      // possible and shipped_at stays null.
      const sendBlockers = [SHIP_BLOCKERS.SEND_FAILED];
      patch.ship_blockers_json = JSON.stringify(sendBlockers);
      const state = await upsertReviewState(adapter, artifactId, patch, ts);
      const opId = await appendOperation(
        adapter,
        artifactId,
        "ship_blocked",
        shipper,
        ts,
        JSON.stringify({ blockers: sendBlockers, error: result.error ?? "send failed" }),
        state.source_link,
      );
      return {
        schema_version: "artifact.ship.v1",
        artifact_id: artifactId,
        status: "blocked",
        blockers: sendBlockers,
        message: `Cane send failed: ${result.error ?? "unknown"}. Recorded as operation #${opId}.`,
        recorded_op_id: opId,
      };
    }
    // Sent. Record shipped_at (first-write-wins) + the sent evidence op.
    patch.shipped_at = result.evidence.sent_at;
    patch.shipped_by = shipper;
    patch.ship_blockers_json = null;
    const state = await upsertReviewState(adapter, artifactId, patch, ts);
    const opId = await appendOperation(
      adapter,
      artifactId,
      "ship_attempted",
      shipper,
      ts,
      JSON.stringify({
        cane_draft: true,
        pending_id: pendingIdFromDraftId(caneDraft.payload.draft_id),
        message_id: result.evidence.message_id,
        sent_at: result.evidence.sent_at,
        already_sent: result.evidence.already_sent ?? false,
        attempted_by: shipper,
      }),
      state.source_link,
    );
    return {
      schema_version: "artifact.ship.v1",
      artifact_id: artifactId,
      status: "ok",
      blockers: [],
      message: `Draft sent (message_id ${result.evidence.message_id}). Op #${opId}.`,
      recorded_op_id: opId,
    };
  }

  // Non-cane_draft, not blocked — this path is unreachable today because
  // computeShipBlockers always pushes NO_EXECUTOR for non-cane_draft kinds.
  // Kept for forward-compatibility when other executors land.
  patch.shipped_at = ts;
  patch.shipped_by = shipper;
  patch.ship_blockers_json = null;
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    "ship_attempted",
    shipper,
    ts,
    JSON.stringify({ blockers: [], attempted_by: shipper }),
    state.source_link,
  );
  return {
    schema_version: "artifact.ship.v1",
    artifact_id: artifactId,
    status: "ok",
    blockers: [],
    message: `Ship recorded. Op #${opId}.`,
    recorded_op_id: opId,
  };
}
