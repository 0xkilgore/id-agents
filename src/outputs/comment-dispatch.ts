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
import { isArtifactReaction } from "./types.js";
import type { ArtifactCatalogRow, ArtifactComment, ArtifactReaction } from "./types.js";

export const COMMENT_DISPATCH_SCHEMA_VERSION = "artifact.comment.dispatch.v1" as const;

// Re-export the reaction guard so consumers wiring the comment-dispatch rail
// (routes, tests) can validate + render reactions from one import surface.
export { isArtifactReaction };
export type { ArtifactReaction };

/**
 * C0 (2026-06-24): the agent-facing meaning of each ambient reaction. The
 * emoji + label are what Chris taps; `guidance` is the instruction the OWNING
 * agent receives so a one-tap reaction is unambiguous actionable work — not
 * just a vibe. Reactions ride the existing comment-auto-dispatch rail, so this
 * descriptor is the only reaction-specific logic the router adds.
 */
export interface ReactionDescriptor {
  emoji: string;
  label: string;
  guidance: string;
}

const REACTION_DESCRIPTORS: Record<ArtifactReaction, ReactionDescriptor> = {
  ship_it: {
    emoji: "👍",
    label: "Ship it",
    guidance:
      "Chris approves this direction. Proceed — promote/ship as-is unless you see a real blocker.",
  },
  wrong: {
    emoji: "👎",
    label: "Wrong",
    guidance:
      "Chris flags this as wrong. Stop and reconsider; do not proceed without addressing the objection.",
  },
  explain: {
    emoji: "❓",
    label: "Explain",
    guidance:
      "Chris wants an explanation. Reply with a concise rationale; do not change the artifact yet.",
  },
  iterate: {
    emoji: "🔁",
    label: "Iterate",
    guidance:
      "Chris wants another iteration. Revise the artifact per the comment and report back.",
  },
};

export function reactionDescriptor(reaction: ArtifactReaction): ReactionDescriptor {
  return REACTION_DESCRIPTORS[reaction];
}

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
  }): Promise<{ query_id: string; dispatch_phid: string; status: "queued" }>;
}

export interface CommentDispatchReceipt {
  query_id: string;
  dispatch_phid: string;
  to_agent: string;
}

export type CommentDispatchSkipReason =
  | "scheduler_unavailable" // no enqueue seam wired (bootstrap / legacy mount)
  | "artifact_owner_unknown"; // artifact not catalogued or has no owning agent

export type CommentDispatchResult =
  | { routed: true; dispatch: CommentDispatchReceipt }
  | { routed: false; skipped: CommentDispatchSkipReason }
  | { routed: false; error: { message: string } };

export interface RouteCommentInput {
  adapter: DbAdapter;
  /** The manager-injected scheduler enqueue. Undefined on legacy/bootstrap
   *  mounts that have no scheduler — routing then degrades to a skip. */
  enqueue: CommentDispatchEnqueueFn | undefined;
  artifactId: string;
  comment: ArtifactComment;
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
      subject: commentSubject(catalog, input.comment),
      message: commentMessage(catalog, input.comment),
      priority: 5,
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

function artifactLabel(catalog: ArtifactCatalogRow): string {
  return catalog.title || catalog.basename || catalog.artifact_id;
}

export function commentSubject(catalog: ArtifactCatalogRow, comment?: ArtifactComment): string {
  const reaction = comment?.reaction ?? null;
  if (reaction) {
    const d = reactionDescriptor(reaction);
    return `${d.emoji} ${d.label} on "${artifactLabel(catalog)}"`.slice(0, 80);
  }
  return `Operator comment on "${artifactLabel(catalog)}"`.slice(0, 80);
}

export function commentMessage(catalog: ArtifactCatalogRow, comment: ArtifactComment): string {
  const label = artifactLabel(catalog);
  const reaction = comment.reaction ?? null;
  const descriptor = reaction ? reactionDescriptor(reaction) : null;
  const hasBody = comment.body.trim().length > 0;

  const opening = descriptor
    ? `${comment.actor} reacted ${descriptor.emoji} **${descriptor.label}** on your artifact **${label}** (\`${catalog.artifact_id}\`).`
    : `${comment.actor} left a comment on your artifact **${label}** (\`${catalog.artifact_id}\`).`;

  const lines: (string | null)[] = [
    opening,
    "",
    catalog.abs_path ? `File: \`${catalog.abs_path}\`` : null,
    comment.anchor ? `Anchor: \`${comment.anchor}\`` : null,
    catalog.abs_path || comment.anchor ? "" : null,
    // C0: a reaction block when present. The body section is only emitted when
    // there is actual text — a bare reaction is valid feedback on its own.
    descriptor ? "## Reaction" : null,
    descriptor ? "" : null,
    descriptor ? `${descriptor.emoji} ${descriptor.label}` : null,
    descriptor ? "" : null,
    hasBody ? "## Comment" : null,
    hasBody ? "" : null,
    hasBody ? comment.body : null,
    hasBody ? "" : null,
    "## What to do",
    "",
    // Reaction-specific instruction when present; the generic comment guidance otherwise.
    descriptor
      ? descriptor.guidance
      : "Read the comment in context, make the requested change to the artifact (or " +
        "reply with why not), and report back via the canonical close-the-loop path.",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
