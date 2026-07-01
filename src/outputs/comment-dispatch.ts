// Kapelle B2 (2026-06-22) — comment auto-dispatch producer.
//
// When an operator (Chris/Liz) submits a comment on a reviewed artifact via
// POST /artifacts/:id/comments, the comment is persisted durably (ops.ts).
// Until now the loop ended there: the comment was captured but never routed,
// so the owning agent never learned feedback had landed. This module closes
// that loop — it routes the comment to the artifact's OWNING agent as a real
// scheduler dispatch, turning operator feedback into actionable agent work.
//
// Failure posture: the durable comment is ALWAYS written before this runs
// (see routes.ts). Routing problems — no owning agent in the catalog, no
// scheduler wired, or an enqueue that throws — are returned as typed,
// non-fatal results. The route still returns 200 with the persisted comment
// plus a skip/error marker the console surfaces. We never fail a durable
// capture because the downstream routing hiccupped.
//
// Not idempotent (unlike approval-emit): every comment is a distinct piece of
// feedback, so each one routes its own fresh dispatch.

import type { DbAdapter } from "../db/db-adapter.js";
import { getArtifact } from "./storage.js";
import type { ArtifactCatalogRow, ArtifactComment } from "./types.js";

export const COMMENT_DISPATCH_SCHEMA_VERSION = "artifact.comment.dispatch.v1" as const;

/**
 * Deterministic origin channel stamped on EVERY dispatch that an artifact
 * comment routes. This is the canonical discriminator the needs_you digest uses
 * to guarantee that no artifact comment — however it was recovered or batched —
 * ever surfaces as a "Chris needs-you" item (see desk/needs-me.isArtifactCommentDispatch).
 */
export const ARTIFACT_COMMENT_DISPATCH_CHANNEL = "artifact_comment" as const;

/**
 * Minimal enqueue seam — structurally compatible with
 * `SchedulerHandle.enqueue` (the manager binds `dispatchScheduler.enqueue`
 * here). Only the fields the comment router needs are declared; the scheduler
 * accepts a superset (team_id, runtime, promotion metadata, …). Mirrors the
 * `EnqueueFn` seam the graph routes already use.
 */
export interface CommentDispatchEnqueueFn {
  (input: {
    to_agent: string;
    from_actor: string;
    message: string;
    subject?: string;
    priority?: number;
    /** Origin channel; comment routing always stamps ARTIFACT_COMMENT_DISPATCH_CHANNEL. */
    channel?: string;
  }): Promise<{ query_id: string; dispatch_phid: string; status: "queued" }>;
}

export interface CommentDispatchReceipt {
  query_id: string;
  dispatch_phid: string;
  to_agent: string;
}

export type CommentDispatchSkipReason =
  | "scheduler_unavailable" // no enqueue seam wired (bootstrap / legacy mount)
  | "artifact_owner_unknown" // artifact not catalogued or has no owning agent
  | "approval_signal" // comment was handled as an artifact approval, not agent work
  | "question_threaded"; // question remains attached to the artifact thread

export type CommentDispatchResult =
  | { routed: true; dispatch: CommentDispatchReceipt }
  | { routed: false; skipped: CommentDispatchSkipReason }
  | { routed: false; error: { message: string } };

export type ArtifactCommentRouteKind = "approval_signal" | "substantive_follow_up" | "question";

export interface RouteCommentInput {
  adapter: DbAdapter;
  /** The manager-injected scheduler enqueue. Undefined on legacy/bootstrap
   *  mounts that have no scheduler — routing then degrades to a skip. */
  enqueue: CommentDispatchEnqueueFn | undefined;
  artifactId: string;
  comment: ArtifactComment;
}

export function classifyArtifactComment(comment: ArtifactComment): ArtifactCommentRouteKind {
  if (comment.reaction === "ship_it") return "approval_signal";
  if (comment.reaction === "explain") return "question";
  if (comment.reaction === "wrong" || comment.reaction === "iterate") return "substantive_follow_up";

  const normalized = normalizeCommentText(comment.body);
  if (isApprovalSignal(normalized)) return "approval_signal";
  if (isQuestion(normalized)) return "question";
  return "substantive_follow_up";
}

function normalizeCommentText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isApprovalSignal(text: string): boolean {
  if (!text) return false;
  if (/\b(not|don't|do not|cannot|can't|isn't|is not|needs?|fix|change|revise|iterate|wrong|blocked)\b/.test(text)) {
    return false;
  }
  return (
    /^(ship it|approved|approve|lgtm|looks good|looks good to me|ready to ship|good to ship|ship)$/i.test(text) ||
    /\b(ship it|approved|lgtm|looks good|ready to ship|good to ship)\b/i.test(text)
  );
}

function isQuestion(text: string): boolean {
  if (!text) return false;
  return text.includes("?") || /^(can|could|would|should|why|what|when|where|who|how|is|are|does|do)\b/.test(text);
}

/**
 * Route a persisted artifact comment to the artifact's owning agent as a
 * scheduler dispatch. The comment is assumed already durable; this only adds
 * the routing side-effect and returns a typed receipt/skip/error.
 */
export async function routeCommentToOwningAgent(
  input: RouteCommentInput,
): Promise<CommentDispatchResult> {
  if (!input.enqueue) {
    return { routed: false, skipped: "scheduler_unavailable" };
  }
  const catalog = await getArtifact(input.adapter, input.artifactId);
  const owner = catalog?.agent?.trim();
  if (!catalog || !owner) {
    return { routed: false, skipped: "artifact_owner_unknown" };
  }
  try {
    const receipt = await input.enqueue({
      to_agent: owner,
      from_actor: input.comment.actor,
      subject: commentSubject(catalog),
      message: commentMessage(catalog, input.comment),
      priority: 5,
      channel: ARTIFACT_COMMENT_DISPATCH_CHANNEL,
    });
    return {
      routed: true,
      dispatch: {
        query_id: receipt.query_id,
        dispatch_phid: receipt.dispatch_phid,
        to_agent: owner,
      },
    };
  } catch (err) {
    return {
      routed: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ── Recovered-comment batch sweep (deterministic) ─────────────────────

export interface RecoveredCommentSweepInput {
  adapter: DbAdapter;
  enqueue: CommentDispatchEnqueueFn | undefined;
  comments: Array<{ artifactId: string; comment: ArtifactComment }>;
}

export interface RecoveredCommentSweepEntry {
  artifactId: string;
  op_id: number;
  route_kind: ArtifactCommentRouteKind;
  result: CommentDispatchResult;
}

export interface RecoveredCommentSweepReport {
  schema_version: typeof COMMENT_DISPATCH_SCHEMA_VERSION;
  total: number;
  counts: Record<ArtifactCommentRouteKind, number>;
  entries: RecoveredCommentSweepEntry[];
}

/**
 * Deterministic sweep of a recovered artifact-comment batch. Classification is
 * pure (classifyArtifactComment); routing is applied in stable input order.
 * approval_signal / question never dispatch agent work; substantive_follow_up
 * routes to the owning agent. EVERY routed dispatch carries the
 * artifact_comment channel, so a recovered batch can never reach needs_you.
 * Same input → identical report (no clocks, no randomness here).
 */
export async function sweepRecoveredArtifactComments(
  input: RecoveredCommentSweepInput,
): Promise<RecoveredCommentSweepReport> {
  const counts: Record<ArtifactCommentRouteKind, number> = {
    approval_signal: 0,
    substantive_follow_up: 0,
    question: 0,
  };
  const entries: RecoveredCommentSweepEntry[] = [];

  for (const { artifactId, comment } of input.comments) {
    const route_kind = classifyArtifactComment(comment);
    counts[route_kind] += 1;

    let result: CommentDispatchResult;
    if (route_kind === "approval_signal") {
      result = { routed: false, skipped: "approval_signal" };
    } else if (route_kind === "question") {
      result = { routed: false, skipped: "question_threaded" };
    } else {
      result = await routeCommentToOwningAgent({
        adapter: input.adapter,
        enqueue: input.enqueue,
        artifactId,
        comment,
      });
    }
    entries.push({ artifactId, op_id: comment.op_id, route_kind, result });
  }

  return {
    schema_version: COMMENT_DISPATCH_SCHEMA_VERSION,
    total: input.comments.length,
    counts,
    entries,
  };
}

function artifactLabel(catalog: ArtifactCatalogRow): string {
  return catalog.title || catalog.basename || catalog.artifact_id;
}

export function commentSubject(catalog: ArtifactCatalogRow): string {
  // C0: a reaction is still a comment, but the subject reads "reaction" so the
  // owning agent can triage one-tap feedback at a glance.
  const noun = "Operator comment";
  return `${noun} on "${artifactLabel(catalog)}"`.slice(0, 80);
}

export function commentMessage(catalog: ArtifactCatalogRow, comment: ArtifactComment): string {
  const label = artifactLabel(catalog);
  // C0_FEEDBACK_REACTIONS: when the comment is a one-tap reaction, the verb and
  // the section heading say "reacted" so the agent reads it as a reaction, not a
  // free-text note. The body already carries the synthesized "👎 wrong — …".
  const isReaction = comment.reaction != null;
  const verb = isReaction ? `reacted (${comment.reaction})` : "left a comment";
  const heading = isReaction ? "## Reaction" : "## Comment";
  const lines: (string | null)[] = [
    `${comment.actor} ${verb} on your artifact **${label}** (\`${catalog.artifact_id}\`).`,
    "",
    catalog.abs_path ? `File: \`${catalog.abs_path}\`` : null,
    comment.anchor ? `Anchor: \`${comment.anchor}\`` : null,
    catalog.abs_path || comment.anchor ? "" : null,
    heading,
    "",
    comment.body,
    "",
    "## What to do",
    "",
    "Read the comment in context, make the requested change to the artifact (or " +
      "reply with why not), and report back via the canonical close-the-loop path.",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
