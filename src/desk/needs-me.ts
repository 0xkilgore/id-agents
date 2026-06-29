import type { DbAdapter } from "../db/db-adapter.js";
import type { DecisionRow } from "../decisions/types.js";
import { listDecisions } from "../decisions/storage.js";
import { readDispatches, type DispatchReadRow } from "../dispatch-scheduler/read-model.js";
import { listInboxItems } from "../outputs/storage.js";
import type { OutputsInboxRow } from "../outputs/types.js";
import type { DeskNeedsMeItem, DeskNeedsMeResponse } from "./types.js";

export const DESK_NEEDS_ME_SCHEMA_VERSION = "desk.needs_me.v1" as const;

interface TeamRef {
  id: string | null;
  name: string | null;
}

export interface BuildDeskNeedsMeOptions {
  owner?: string;
  teamName?: string;
  limit?: number;
  generatedAt: string;
}

export async function buildDeskNeedsMe(
  adapter: DbAdapter,
  opts: BuildDeskNeedsMeOptions,
): Promise<DeskNeedsMeResponse> {
  const owner = normalizeOwner(opts.owner);
  const limit = normalizeLimit(opts.limit);
  const team = await resolveTeam(adapter, opts.teamName ?? "default");
  const warnings: DeskNeedsMeResponse["warnings"] = [];

  const [decisions, artifactRows, dispatchRows] = await Promise.all([
    listDecisions(adapter, { status: "open", owner, limit: Math.min(limit, 100) }),
    listInboxItems(adapter, { includeNeverViewed: true }, Math.min(limit * 2, 200), 0),
    team.id ? readDispatches(adapter, team.id, "all", Math.min(limit * 4, 200)) : Promise.resolve([]),
  ]);

  if (!team.id) {
    warnings.push({
      code: "team_not_found",
      message: `No team row found for "${team.name ?? opts.teamName ?? "default"}"; routed dispatch items were omitted.`,
    });
  }

  const approvalItems = decisions.map(decisionToNeedsMeItem);
  const artifactItems = artifactRows
    .filter((row) => row.status !== "shipped")
    .map(artifactInboxToNeedsMeItem);
  const routedItems = dispatchRows
    .filter((row) => row.needs_operator || row.needs_input.active != null)
    .map(dispatchToNeedsMeItem);

  const items = [...approvalItems, ...artifactItems, ...routedItems]
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, limit);

  return {
    schema_version: DESK_NEEDS_ME_SCHEMA_VERSION,
    generated_at: opts.generatedAt,
    owner,
    team,
    source: {
      system: "manager",
      projection: "desk_needs_me",
      source_type: "hybrid_projection",
      read_path: "substrate",
    },
    filters: { owner, limit },
    counts: {
      total: approvalItems.length + artifactItems.length + routedItems.length,
      returned: items.length,
      approvals: approvalItems.length,
      artifact_review: artifactItems.length,
      unread_comments: 0,
      routed_items: routedItems.length,
    },
    items,
    warnings,
  };
}

function normalizeOwner(owner: string | undefined): string {
  const trimmed = owner?.trim();
  return trimmed || "chris";
}

export function normalizeLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}

async function resolveTeam(adapter: DbAdapter, teamName: string): Promise<TeamRef> {
  try {
    const { rows } = await adapter.query<{ id: string; name: string }>(
      `SELECT id, name FROM teams WHERE name = ? LIMIT 1`,
      [teamName],
    );
    if (rows[0]) return { id: rows[0].id, name: rows[0].name };
  } catch {
    // Some unit harnesses mount Desk without the manager teams table.
  }
  return { id: null, name: teamName };
}

function decisionToNeedsMeItem(row: DecisionRow): DeskNeedsMeItem {
  return {
    id: `approval:${row.decision_id}`,
    source_type: "approval",
    label: row.title,
    body_md: row.question,
    href: `/ops/decisions/${encodeURIComponent(row.decision_id)}`,
    priority: row.priority,
    actor: row.requested_by,
    source_ref: row.decision_id,
    source_agent: row.requested_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: {
      decision_id: row.decision_id,
      display_id: row.display_id,
      estimated_seconds: row.estimated_seconds,
      owner: row.owner,
      status: row.status,
    },
  };
}

function artifactInboxToNeedsMeItem(row: OutputsInboxRow): DeskNeedsMeItem {
  const label = row.title ?? row.basename ?? row.artifact_id;
  return {
    id: `artifact_review:${row.artifact_id}`,
    source_type: "artifact_review",
    label,
    body_md: row.abs_path ?? "",
    href: `/ops/artifacts/${encodeURIComponent(row.artifact_id)}`,
    priority: row.status === "ship_blocked" ? "high" : null,
    actor: row.agent,
    source_ref: row.artifact_id,
    source_agent: row.agent,
    created_at: row.produced_at ?? row.last_op_at ?? new Date(0).toISOString(),
    updated_at: row.last_op_at ?? row.produced_at ?? new Date(0).toISOString(),
    metadata: {
      artifact_id: row.artifact_id,
      status: row.status,
      availability: row.availability,
      first_viewed_at: row.first_viewed_at,
      approved_at: row.approved_at,
      shipped_at: row.shipped_at,
      ship_blockers_json: row.ship_blockers_json,
      op_count: row.op_count,
    },
  };
}

function dispatchToNeedsMeItem(row: DispatchReadRow): DeskNeedsMeItem {
  return {
    id: `routed_item:${row.dispatch_phid}`,
    source_type: "routed_item",
    label: row.title || row.subject || row.dispatch_phid,
    body_md: row.failure_detail ?? "",
    href: `/ops/dispatches/${encodeURIComponent(row.dispatch_phid)}`,
    priority: row.source_metadata.priority == null ? null : String(row.source_metadata.priority),
    actor: row.source_metadata.from_actor,
    source_ref: row.dispatch_phid,
    source_agent: row.target_agent,
    created_at: row.queued_at ?? row.updated_at,
    updated_at: row.completed_at ?? row.in_flight_at ?? row.updated_at,
    metadata: {
      dispatch_id: row.dispatch_phid,
      query_id: row.query_id,
      agent_query_id: row.agent_query_id,
      target_agent: row.target_agent,
      status: row.status,
      effective_state: row.effective_state,
      needs_operator: row.needs_operator,
      needs_input: row.needs_input,
      sort_group: row.sort_group,
    },
  };
}
