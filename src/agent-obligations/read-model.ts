import type { DbAdapter } from "../db/db-adapter.js";
import { buildReportsDue, type ReportRunFact } from "../loops/report-facts.js";
import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";

const ACTIVE_STATUSES = new Set(["queued", "in_flight", "bounced", "needs_clarification", "resume_delivery_failed"]);
const TERMINAL_DONE_STATUSES = new Set(["done"]);
const TERMINAL_FAILED_STATUSES = new Set(["failed", "cancelled"]);

export type AgentObligationStatus = "expected" | "done" | "late" | "failed";
export type AgentObligationSourceKind = "report" | "handoff" | "comment" | "closeout" | "task";
export type AgentObligationCloseSignal = "artifact" | "receipt" | "done" | null;

export interface AgentObligation {
  obligation_id: string;
  source_kind: AgentObligationSourceKind;
  obligation_type: AgentObligationSourceKind;
  source_record: string;
  source_ref: string;
  agent: string;
  owner: string;
  status: AgentObligationStatus;
  stale_after: string | null;
  due_at: string | null;
  last_event_at: string | null;
  is_stale: boolean;
  stale_seconds: number;
  escalation_level: "none" | "stale" | "critical";
  escalates_at: string | null;
  close_signal: AgentObligationCloseSignal;
  close_signal_ref: string | null;
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
  artifact_path?: string | null;
  result_json?: string | null;
}

interface TaskObligationRow {
  id: string;
  name: string;
  title: string;
  status: string;
  owner: string | null;
  owner_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface CommentObligationRow {
  op_id: number;
  artifact_id: string;
  actor: string;
  ts: string;
  payload_json: string | null;
  source_link: string | null;
}

export interface ReadAgentObligationsOptions {
  limit?: number;
  now?: string;
  staleAfterMs?: number;
  agent?: string | null;
  status?: AgentObligationStatus | "all" | null;
  includeReports?: boolean;
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
            updated_at, failure_kind, failure_detail, artifact_path, result_json
       FROM dispatch_scheduler_queue
      WHERE team_id = ?
        ${agentClause}
      ORDER BY COALESCE(completed_at, started_at, updated_at, not_before_at) DESC,
               dispatch_phid DESC
      LIMIT ?`,
    params,
  );

  const dispatchObligations = rows.map((row) => rowToAgentObligation(row, { now, staleAfterMs }));
  const taskObligations = await taskObligationsFor(adapter, teamId, { now, staleAfterMs, agent, limit });
  const commentObligations = await commentObligationsFor(adapter, { now, staleAfterMs, agent, limit });
  const reportObligations = opts.includeReports === false
    ? []
    : await reportObligationsFor(adapter as DbAdapter, teamId, { now, agent });

  const obligations = dedupeObligations([...dispatchObligations, ...taskObligations, ...commentObligations, ...reportObligations])
    .filter((o) => (agent ? sameAgent(o.agent, agent) : true))
    .filter((o) => status === "all" || o.status === status)
    .sort(compareObligations)
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
  const sourceRecord = row.dispatch_phid;
  const lastEventAt = row.completed_at ?? row.started_at ?? row.updated_at ?? row.not_before_at;
  const staleAfter = staleAfterFor(row, opts.staleAfterMs);
  const status = deriveObligationStatus(row.status, staleAfter, opts.now);
  const escalation = escalationFields(status, staleAfter, opts.now);
  const closeSignal = dispatchCloseSignal(row, status);

  return {
    obligation_id: obligationId(sourceRecord, sourceKind),
    source_kind: sourceKind,
    obligation_type: sourceKind,
    source_record: sourceRecord,
    source_ref: row.query_id ?? row.dispatch_phid,
    agent: row.to_agent,
    owner: row.from_actor ?? "manager",
    status,
    stale_after: staleAfter,
    due_at: staleAfter,
    last_event_at: lastEventAt,
    ...escalation,
    close_signal: closeSignal.signal,
    close_signal_ref: closeSignal.ref,
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

function dispatchCloseSignal(
  row: AgentObligationRow,
  status: AgentObligationStatus,
): { signal: AgentObligationCloseSignal; ref: string | null } {
  if (status !== "done") return { signal: null, ref: null };
  if (row.artifact_path) return { signal: "artifact", ref: row.artifact_path };
  const resultArtifact = artifactPathFromResult(row.result_json);
  if (resultArtifact) return { signal: "artifact", ref: resultArtifact };
  return { signal: "done", ref: row.dispatch_phid };
}

function artifactPathFromResult(resultJson: string | null | undefined): string | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    for (const key of ["artifact_path", "artifactPath", "output_path", "path"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    return null;
  }
  return null;
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

async function reportObligationsFor(
  adapter: DbAdapter,
  teamId: string,
  opts: { now: string; agent: string | null },
): Promise<AgentObligation[]> {
  let reports: Awaited<ReturnType<typeof buildReportsDue>>;
  try {
    reports = await buildReportsDue(adapter, opts.now, { team_id: teamId });
  } catch {
    return [];
  }
  return reports.runs
    .filter((run) => run.status !== "skipped")
    .filter((run) => (opts.agent ? sameAgent(run.owner_agent, opts.agent) : true))
    .map((run) => reportRunToObligation(run, opts.now));
}

function reportRunToObligation(run: ReportRunFact, now: string): AgentObligation {
  const sourceRecord = `${run.report_key}:${run.expected_for}`;
  const status = run.status === "failed" ? "failed" : run.status === "done" ? "done" : run.status === "late" ? "late" : "expected";
  const staleAfter = status === "done" ? null : run.stale_at;
  const escalation = escalationFields(status, staleAfter, now);
  return {
    obligation_id: obligationId(sourceRecord, "report"),
    source_kind: "report",
    obligation_type: "report",
    source_record: sourceRecord,
    source_ref: run.loop_run_phid ?? run.report_key,
    agent: run.owner_agent,
    owner: run.owner_agent,
    status,
    stale_after: staleAfter,
    due_at: run.due_at,
    last_event_at: run.finished_at ?? run.fired_at,
    ...escalation,
    close_signal: status === "done" ? (run.loop_run_phid ? "receipt" : "done") : null,
    close_signal_ref: status === "done" ? (run.loop_run_phid ?? run.report_key) : null,
    dashboard_reason:
      status === "done"
        ? "Report complete"
        : status === "failed"
          ? `Report failed: ${run.reason}`
          : status === "late"
            ? `Stale missing report: ${run.reason}`
            : `Report expected from ${run.owner_agent}`,
  };
}

async function taskObligationsFor(
  adapter: DbAdapterLike,
  teamId: string,
  opts: { now: string; staleAfterMs: number; agent: string | null; limit: number },
): Promise<AgentObligation[]> {
  const params: unknown[] = [teamId];
  const agentClause = opts.agent ? "AND (owner_agent.name = ? OR t.owner = ?)" : "";
  if (opts.agent) params.push(opts.agent, opts.agent);
  params.push(Math.max(opts.limit * 2, opts.limit));

  try {
    const { rows } = await adapter.query<TaskObligationRow>(
      `SELECT t.id, t.name, t.title, t.status, t.owner, owner_agent.name AS owner_name,
              t.created_by, creator_agent.name AS created_by_name,
              t.created_at, t.updated_at, t.completed_at
         FROM tasks t
         LEFT JOIN agents owner_agent ON owner_agent.id = t.owner
         LEFT JOIN agents creator_agent ON creator_agent.id = t.created_by
        WHERE t.team_id = ?
          AND t.owner IS NOT NULL
          ${agentClause}
        ORDER BY COALESCE(t.completed_at, t.updated_at, t.created_at) DESC, t.name DESC
        LIMIT ?`,
      params,
    );
    return rows.map((row) => taskRowToObligation(row, opts));
  } catch {
    return [];
  }
}

function taskRowToObligation(
  row: TaskObligationRow,
  opts: { now: string; staleAfterMs: number },
): AgentObligation {
  const agent = row.owner_name ?? row.owner ?? "unknown";
  const updatedAt = epochToIso(row.completed_at ?? row.updated_at ?? row.created_at);
  const staleAfter = row.status === "done" ? null : addMs(updatedAt, opts.staleAfterMs);
  const status = row.status === "done" ? "done" : deriveObligationStatus(row.status, staleAfter, opts.now);
  const escalation = escalationFields(status, staleAfter, opts.now);
  return {
    obligation_id: obligationId(row.name, "task"),
    source_kind: "task",
    obligation_type: "task",
    source_record: row.name,
    source_ref: row.id,
    agent,
    owner: row.created_by_name ?? row.created_by ?? "manager",
    status,
    stale_after: staleAfter,
    due_at: staleAfter,
    last_event_at: updatedAt,
    ...escalation,
    close_signal: status === "done" ? "done" : null,
    close_signal_ref: status === "done" ? row.name : null,
    dashboard_reason:
      status === "done"
        ? "Task complete"
        : status === "late"
          ? `Stale task ownership: ${row.title}`
          : `Task ownership expected from ${agent}`,
  };
}

async function commentObligationsFor(
  adapter: DbAdapterLike,
  opts: { now: string; staleAfterMs: number; agent: string | null; limit: number },
): Promise<AgentObligation[]> {
  try {
    const { rows } = await adapter.query<CommentObligationRow>(
      `SELECT op_id, artifact_id, actor, ts, payload_json, source_link
         FROM artifact_operations
        WHERE op_type = 'comment_recorded'
        ORDER BY ts DESC, op_id DESC
        LIMIT ?`,
      [Math.max(opts.limit * 4, opts.limit)],
    );
    return rows
      .map((row) => commentRowToObligation(row, opts))
      .filter((o): o is AgentObligation => o != null)
      .filter((o) => (opts.agent ? sameAgent(o.agent, opts.agent) : true));
  } catch {
    return [];
  }
}

function commentRowToObligation(
  row: CommentObligationRow,
  opts: { now: string; staleAfterMs: number },
): AgentObligation | null {
  const routeStatus = routeStatusFromCommentPayload(row.payload_json);
  const targetAgent = routeStatus?.target_agent ?? routeStatus?.dispatch?.to_agent ?? null;
  if (!targetAgent) return null;
  const sourceRecord = `artifact-comment:${row.artifact_id}:${row.op_id}`;
  const staleAfter = routeStatus?.deadline_at ?? addMs(row.ts, opts.staleAfterMs);
  const routed = routeStatus?.visible_state === "recorded+routed" && routeStatus.dispatch;
  const failed = routeStatus?.visible_state === "terminal-failure";
  const retryable = routeStatus?.retryable === true;
  const status: AgentObligationStatus = routed
    ? "done"
    : failed
      ? "failed"
      : retryable && Date.parse(staleAfter) <= Date.parse(opts.now)
        ? "late"
        : "expected";
  const escalation = escalationFields(status, status === "done" ? null : staleAfter, opts.now);
  return {
    obligation_id: obligationId(sourceRecord, "comment"),
    source_kind: "comment",
    obligation_type: "comment",
    source_record: sourceRecord,
    source_ref: routeStatus?.dispatch?.dispatch_phid ?? row.source_link ?? row.artifact_id,
    agent: targetAgent,
    owner: row.actor,
    status,
    stale_after: status === "done" ? null : staleAfter,
    due_at: status === "done" ? null : staleAfter,
    last_event_at: routeStatus?.updated_at ?? row.ts,
    ...escalation,
    close_signal: routed ? "receipt" : null,
    close_signal_ref: routed ? routeStatus.dispatch!.dispatch_phid : null,
    dashboard_reason:
      status === "done"
        ? "Comment follow-up routed"
        : status === "failed"
          ? `Comment follow-up failed: ${routeStatus?.error?.message ?? "terminal failure"}`
          : status === "late"
            ? `Stale missing comment receipt: no route receipt after ${staleAfter}`
            : `Comment follow-up expected from ${targetAgent}`,
  };
}

function routeStatusFromCommentPayload(payloadJson: string | null): {
  visible_state?: string;
  retryable?: boolean;
  target_agent?: string | null;
  deadline_at?: string | null;
  updated_at?: string | null;
  error?: { message?: string | null } | null;
  dispatch?: { dispatch_phid: string; to_agent: string } | null;
} | null {
  if (!payloadJson) return null;
  try {
    const payload = JSON.parse(payloadJson) as { route_status?: unknown };
    const routeStatus = payload.route_status as Record<string, unknown> | undefined;
    if (!routeStatus || typeof routeStatus !== "object") return null;
    const dispatch = routeStatus.dispatch && typeof routeStatus.dispatch === "object"
      ? routeStatus.dispatch as Record<string, unknown>
      : null;
    const error = routeStatus.error && typeof routeStatus.error === "object"
      ? routeStatus.error as Record<string, unknown>
      : null;
    return {
      visible_state: typeof routeStatus.visible_state === "string" ? routeStatus.visible_state : undefined,
      retryable: typeof routeStatus.retryable === "boolean" ? routeStatus.retryable : undefined,
      target_agent: typeof routeStatus.target_agent === "string" ? routeStatus.target_agent : null,
      deadline_at: typeof routeStatus.deadline_at === "string" ? routeStatus.deadline_at : null,
      updated_at: typeof routeStatus.updated_at === "string" ? routeStatus.updated_at : null,
      error: error ? { message: typeof error.message === "string" ? error.message : null } : null,
      dispatch: dispatch && typeof dispatch.dispatch_phid === "string" && typeof dispatch.to_agent === "string"
        ? { dispatch_phid: dispatch.dispatch_phid, to_agent: dispatch.to_agent }
        : null,
    };
  } catch {
    return null;
  }
}

function obligationId(sourceRecord: string, obligationType: AgentObligationSourceKind): string {
  return `agent-obligation:${sourceRecord}:${obligationType}`;
}

function epochToIso(value: number): string {
  return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
}

function addMs(iso: string, ms: number): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed + ms).toISOString() : iso;
}

function dedupeObligations(obligations: AgentObligation[]): AgentObligation[] {
  const byKey = new Map<string, AgentObligation>();
  for (const obligation of obligations) {
    const key = `${obligation.source_record}:${obligation.obligation_type}`;
    const existing = byKey.get(key);
    if (!existing || compareObligations(obligation, existing) < 0) {
      byKey.set(key, obligation);
    }
  }
  return [...byKey.values()];
}

function compareObligations(a: AgentObligation, b: AgentObligation): number {
  const severity = (o: AgentObligation): number => {
    if (o.status === "late") return 0;
    if (o.status === "failed") return 1;
    if (o.status === "expected") return 2;
    return 3;
  };
  const sev = severity(a) - severity(b);
  if (sev !== 0) return sev;
  const at = a.due_at ?? a.last_event_at ?? "";
  const bt = b.due_at ?? b.last_event_at ?? "";
  return at < bt ? -1 : at > bt ? 1 : a.obligation_id.localeCompare(b.obligation_id);
}

function escalationFields(
  status: AgentObligationStatus,
  staleAfter: string | null,
  now: string,
): Pick<AgentObligation, "is_stale" | "stale_seconds" | "escalation_level" | "escalates_at"> {
  const staleMs = staleAfter ? Date.parse(staleAfter) : NaN;
  const nowMs = Date.parse(now);
  const staleSeconds = Number.isFinite(staleMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - staleMs) / 1000))
    : 0;
  const isStale = (status === "late" || status === "failed") && staleSeconds > 0;
  return {
    is_stale: isStale,
    stale_seconds: isStale ? staleSeconds : 0,
    escalation_level: isStale ? (staleSeconds >= 24 * 60 * 60 ? "critical" : "stale") : "none",
    escalates_at: staleAfter,
  };
}

function sameAgent(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
