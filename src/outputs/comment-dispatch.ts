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
      subject: commentSubject(catalog),
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
