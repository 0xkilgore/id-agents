import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";

const ACTIVE_STATUSES = new Set(["queued", "in_flight", "bounced", "needs_clarification", "resume_delivery_failed"]);
const TERMINAL_DONE_STATUSES = new Set(["done"]);
const TERMINAL_FAILED_STATUSES = new Set(["failed", "cancelled"]);

export type AgentObligationStatus = "expected" | "done" | "late" | "failed";
export type AgentObligationSourceKind = "report" | "handoff" | "comment" | "closeout";

export interface AgentObligation {
  obligation_id: string;
  source_kind: AgentObligationSourceKind;
  source_ref: string;
  agent: string;
  owner: string;
  status: AgentObligationStatus;
  stale_after: string | null;
  due_at: string | null;
  last_event_at: string | null;
  dashboard_reason: string;
}

interface AgentObligationRow {
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string;
  from_actor: string | null;
  channel: string | null;
  subject: string | null;
  body_markdown: string | null;
  status: string;
  not_before_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
}

export interface ReadAgentObligationsOptions {
  limit?: number;
  now?: string;
  staleAfterMs?: number;
  agent?: string | null;
  status?: AgentObligationStatus | "all" | null;
}

export interface AgentObligationsEnvelope {
  ok: true;
  schema_version: "agent-obligations.v1";
  team_id: string;
  generated_at: string;
  count: number;
  obligations: AgentObligation[];
  items: AgentObligation[];
}

export function parseAgentObligationLimit(raw: unknown, defaultLimit = 100, maxLimit = 500): number {
  if (raw == null || raw === "") return defaultLimit;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(maxLimit, Math.floor(n));
}

export function parseAgentObligationStatus(raw: unknown): AgentObligationStatus | "all" | null {
  if (raw == null || raw === "") return "all";
  if (raw === "expected" || raw === "done" || raw === "late" || raw === "failed" || raw === "all") {
    return raw;
  }
  return null;
}

export async function readAgentObligations(
  adapter: DbAdapterLike,
  teamId: string,
  opts: ReadAgentObligationsOptions = {},
): Promise<AgentObligationsEnvelope> {
  const limit = opts.limit ?? 100;
  const now = opts.now ?? new Date().toISOString();
  const status = opts.status ?? "all";
  const staleAfterMs = opts.staleAfterMs ?? 30 * 60 * 1000;
  const agent = typeof opts.agent === "string" && opts.agent.length > 0 ? opts.agent : null;

  const params: unknown[] = [teamId];
  const agentClause = agent ? "AND to_agent = ?" : "";
  if (agent) params.push(agent);
  params.push(Math.max(limit * 4, limit));

  const { rows } = await adapter.query<AgentObligationRow>(
    `SELECT dispatch_phid, query_id, to_agent, from_actor, channel, subject,
            body_markdown, status, not_before_at, started_at, completed_at,
            updated_at, failure_kind, failure_detail
       FROM dispatch_scheduler_queue
      WHERE team_id = ?
        ${agentClause}
      ORDER BY COALESCE(completed_at, started_at, updated_at, not_before_at) DESC,
               dispatch_phid DESC
      LIMIT ?`,
    params,
  );

  const obligations = rows
    .map((row) => rowToAgentObligation(row, { now, staleAfterMs }))
    .filter((o) => status === "all" || o.status === status)
    .slice(0, limit);

  return {
    ok: true,
    schema_version: "agent-obligations.v1",
    team_id: teamId,
    generated_at: now,
    count: obligations.length,
    obligations,
    items: obligations,
  };
}

export function rowToAgentObligation(
  row: AgentObligationRow,
  opts: { now: string; staleAfterMs: number },
): AgentObligation {
  const sourceKind = inferSourceKind(row);
  const lastEventAt = row.completed_at ?? row.started_at ?? row.updated_at ?? row.not_before_at;
  const staleAfter = staleAfterFor(row, opts.staleAfterMs);
  const status = deriveObligationStatus(row.status, staleAfter, opts.now);

  return {
    obligation_id: `agent-obligation:${row.dispatch_phid}`,
    source_kind: sourceKind,
    source_ref: row.query_id ?? row.dispatch_phid,
    agent: row.to_agent,
    owner: row.from_actor ?? "manager",
    status,
    stale_after: staleAfter,
    due_at: staleAfter,
    last_event_at: lastEventAt,
    dashboard_reason: dashboardReason(row, sourceKind, status, staleAfter),
  };
}

function staleAfterFor(row: AgentObligationRow, staleAfterMs: number): string | null {
  if (!ACTIVE_STATUSES.has(row.status)) return null;
  const base = row.started_at ?? row.not_before_at ?? row.updated_at;
  if (!base) return null;
  const ms = Date.parse(base);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + staleAfterMs).toISOString();
}

function deriveObligationStatus(rawStatus: string, staleAfter: string | null, now: string): AgentObligationStatus {
  if (TERMINAL_DONE_STATUSES.has(rawStatus)) return "done";
  if (TERMINAL_FAILED_STATUSES.has(rawStatus)) return "failed";
  if (staleAfter && Date.parse(staleAfter) <= Date.parse(now)) return "late";
  return "expected";
}

function inferSourceKind(row: AgentObligationRow): AgentObligationSourceKind {
  const haystack = `${row.channel ?? ""} ${row.subject ?? ""} ${row.body_markdown ?? ""}`.toLowerCase();
  if (haystack.includes("artifact_comment") || haystack.includes("comment")) return "comment";
  if (haystack.includes("handoff")) return "handoff";
  if (haystack.includes("report")) return "report";
  return "closeout";
}

function dashboardReason(
  row: AgentObligationRow,
  sourceKind: AgentObligationSourceKind,
  status: AgentObligationStatus,
  staleAfter: string | null,
): string {
  if (status === "done") return `${label(sourceKind)} complete`;
  if (status === "failed") {
    const detail = row.failure_detail ?? row.failure_kind;
    return detail ? `${label(sourceKind)} failed: ${detail}` : `${label(sourceKind)} failed`;
  }
  if (status === "late") {
    return `Stale missing ${sourceKind}: no terminal closeout after ${staleAfter ?? "stale window"}`;
  }
  return `${label(sourceKind)} expected from ${row.to_agent}`;
}

function label(kind: AgentObligationSourceKind): string {
  if (kind === "closeout") return "Closeout";
  if (kind === "comment") return "Comment follow-up";
  return kind[0].toUpperCase() + kind.slice(1);
}
