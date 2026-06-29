import type { BacklogItem } from "../continuous-orchestration/types.js";
import type { DbAdapter } from "../db/db-adapter.js";
import type { DecisionRow } from "../decisions/types.js";
import type { OutputsInboxRow } from "../outputs/types.js";
import type { DeskNeedsMeItem, DeskNeedsMeResponse } from "./types.js";

export const DESK_NEEDS_ME_PARSER_VERSION = "desk.needs_me.v1" as const;

export interface UnreadArtifactCommentRow {
  op_id: number;
  artifact_id: string;
  actor: string;
  ts: string;
  payload_json: string | null;
  title: string | null;
  basename: string | null;
  agent: string | null;
  abs_path: string | null;
}

export async function listUnreadArtifactComments(
  adapter: DbAdapter,
  opts: { actor?: string; limit?: number } = {},
): Promise<UnreadArtifactCommentRow[]> {
  const actor = opts.actor ?? "user:chris";
  const actorAliases = actor === "user:chris" ? ["user:chris", "human:chris", "chris"] : [actor];
  const aliasPlaceholders = actorAliases.map(() => "?").join(", ");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { rows } = await adapter.query<UnreadArtifactCommentRow>(
    `SELECT op.op_id, op.artifact_id, op.actor, op.ts, op.payload_json,
            a.title, a.basename, a.agent, a.abs_path
       FROM artifact_operations op
  LEFT JOIN artifact_review_state rs ON rs.artifact_id = op.artifact_id
  LEFT JOIN artifacts a ON a.artifact_id = op.artifact_id
      WHERE op.op_type = 'comment_recorded'
        AND op.actor NOT IN (${aliasPlaceholders})
        AND (rs.last_viewed_at IS NULL OR op.ts > rs.last_viewed_at)
   ORDER BY op.ts DESC, op.op_id DESC
      LIMIT ?`,
    [...actorAliases, limit],
  );
  return rows;
}

export interface BuildDeskNeedsMeInput {
  generatedAt: string;
  teamId: string;
  limit: number;
  approvals: DecisionRow[];
  artifactReview: OutputsInboxRow[];
  unreadComments: UnreadArtifactCommentRow[];
  needsChris: BacklogItem[];
}

export function buildDeskNeedsMeEnvelope(input: BuildDeskNeedsMeInput): DeskNeedsMeResponse {
  const approvalItems = input.approvals.map(approvalToNeedsMeItem);
  const reviewItems = input.artifactReview.map(artifactReviewToNeedsMeItem);
  const commentItems = input.unreadComments.map(unreadCommentToNeedsMeItem);
  const needsChrisItems = input.needsChris.map(needsChrisBacklogToNeedsMeItem);

  const items = [...approvalItems, ...reviewItems, ...commentItems, ...needsChrisItems]
    .sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at))
    .slice(0, input.limit);

  return {
    schema_version: "desk.needs_me.v1",
    generated_at: input.generatedAt,
    source: {
      system: "manager",
      projection: "desk_needs_me",
      source_type: "hybrid_projection",
      read_path: "substrate",
    },
    filters: {
      actor: "user:chris",
      team_id: input.teamId,
      limit: input.limit,
    },
    counts: {
      total: items.length,
      approvals: approvalItems.length,
      artifact_review: reviewItems.length,
      unread_comments: commentItems.length,
      needs_chris: needsChrisItems.length,
    },
    items,
    warnings: [],
  };
}

export function approvalToNeedsMeItem(row: DecisionRow): DeskNeedsMeItem {
  return {
    id: `needs_approval_${row.decision_id}`,
    kind: "approval",
    label: row.title,
    body_md: row.question,
    source_ref: row.decision_id,
    href: `/ops/decisions/${encodeURIComponent(row.decision_id)}`,
    actor: row.requested_by,
    agent: row.owner,
    priority: row.priority,
    status: row.status,
    added_at: row.created_at,
    provenance: provenance("decisions", row.decision_id),
  };
}

export function artifactReviewToNeedsMeItem(row: OutputsInboxRow): DeskNeedsMeItem {
  const label = row.title ?? row.basename ?? row.artifact_id;
  return {
    id: `needs_artifact_${row.artifact_id}`,
    kind: "artifact_review",
    label,
    body_md: row.abs_path ?? "",
    source_ref: row.artifact_id,
    href: `/ops/artifacts/${encodeURIComponent(row.artifact_id)}`,
    actor: null,
    agent: row.agent,
    priority: reviewPriority(row.status),
    status: row.status,
    added_at: row.last_op_at ?? row.produced_at ?? new Date(0).toISOString(),
    provenance: provenance("artifact_review_state", row.artifact_id),
  };
}

export function unreadCommentToNeedsMeItem(row: UnreadArtifactCommentRow): DeskNeedsMeItem {
  const parsed = parseCommentPayload(row.payload_json);
  const label = row.title ?? row.basename ?? row.artifact_id;
  return {
    id: `needs_comment_${row.artifact_id}_${row.op_id}`,
    kind: "unread_comment",
    label: `Unread comment on ${label}`,
    body_md: parsed.body,
    source_ref: `${row.artifact_id}#${row.op_id}`,
    href: `/ops/artifacts/${encodeURIComponent(row.artifact_id)}?comment=${row.op_id}`,
    actor: row.actor,
    agent: row.agent,
    priority: "normal",
    status: "unread",
    added_at: row.ts,
    provenance: provenance("artifact_operations", String(row.op_id)),
  };
}

export function needsChrisBacklogToNeedsMeItem(row: BacklogItem): DeskNeedsMeItem {
  return {
    id: `needs_chris_${row.item_id}`,
    kind: "needs_chris",
    label: row.title,
    body_md: row.flesh_patch?.reason ?? row.dispatch_body ?? "",
    source_ref: row.item_id,
    href: `/orchestration/backlog/${encodeURIComponent(row.item_id)}`,
    actor: row.updated_by ?? row.flesh_source,
    agent: row.to_agent,
    priority: row.priority,
    status: row.readiness_state,
    added_at: row.updated_at,
    provenance: provenance("orchestration_backlog_item", row.item_id),
  };
}

function provenance(
  source: DeskNeedsMeItem["provenance"]["source"],
  sourceRef: string,
): DeskNeedsMeItem["provenance"] {
  return {
    source,
    source_table: source,
    source_ref: sourceRef,
    parser_version: DESK_NEEDS_ME_PARSER_VERSION,
  };
}

function parseCommentPayload(payloadJson: string | null): { body: string } {
  try {
    const parsed = payloadJson ? (JSON.parse(payloadJson) as { body?: unknown }) : {};
    return { body: typeof parsed.body === "string" ? parsed.body : "" };
  } catch {
    return { body: "" };
  }
}

function reviewPriority(status: OutputsInboxRow["status"]): string {
  if (status === "ship_blocked") return "high";
  if (status === "approved") return "normal";
  return "review";
}
