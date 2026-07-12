import type { DbAdapter } from "../db/db-adapter.js";

export type ManagerWorkClass = "manager_direct" | "delegated" | "authority_required";
export type SpecialistWorkClass = "research" | "implementation" | "content" | "audit" | "project_ops";

export interface ManagerWorkTelemetryWarning {
  source: "manager_query";
  query_id: string;
  created_at: string;
  completed_at: string | null;
  duration_seconds: number;
  specialist_work_class: SpecialistWorkClass;
  reason: string;
  excerpt: string;
}

export interface ManagerWorkTelemetryProjection {
  schema_version: "manager_work_telemetry.v1";
  window_hours: { last_24h: number; last_7d: number };
  counts_24h: Record<ManagerWorkClass, number>;
  counts_7d: Record<ManagerWorkClass, number>;
  specialist_counts_24h: Partial<Record<SpecialistWorkClass, number>>;
  specialist_counts_7d: Partial<Record<SpecialistWorkClass, number>>;
  warning_count_24h: number;
  warning_count_7d: number;
  recent_warnings: ManagerWorkTelemetryWarning[];
}

export interface ClassifyManagerWorkInput {
  source: "manager_query" | "dispatch" | "orchestration_decision";
  text: string;
  manager_dispatch_id?: string | null;
  dispatch_phid?: string | null;
  action?: string | null;
  routeLinked?: boolean;
}

export interface ManagerWorkClassification {
  work_class: ManagerWorkClass;
  specialist_work_class: SpecialistWorkClass | null;
  authority_only: boolean;
  route_linked: boolean;
}

interface ManagerQueryTurnRow {
  query_id: string;
  prompt: string | null;
  result: string | null;
  error: string | null;
  created: number;
  completed: number | null;
  manager_dispatch_id: string | null;
  manager_query_id: string | null;
}

interface DelegatedDispatchRow {
  dispatch_phid: string;
  body_markdown: string | null;
  subject: string | null;
  updated_at: string | null;
}

interface AuthorityDecisionRow {
  action: string;
  reason: string;
  ts: string;
  dispatch_phid: string | null;
}

const LONG_MANAGER_TURN_SECONDS = 10 * 60;
const WARNING_LIMIT = 5;

const SPECIALIST_PATTERNS: Array<[SpecialistWorkClass, RegExp]> = [
  ["audit", /\b(audit|review|inspect|verify|validation|regression|coverage|risk)\b/i],
  ["implementation", /\b(implement|build|code|fix|refactor|patch|test|tests|debug|backend|frontend|api|migration)\b/i],
  ["research", /\b(research|investigate|compare|evaluate|look up|source|survey)\b/i],
  ["content", /\b(write|draft|copy|content|post|article|docs?|documentation|report)\b/i],
  ["project_ops", /\b(plan|triage|coordinate|roadmap|backlog|status|handoff|schedule|prioriti[sz]e)\b/i],
];

const AUTHORITY_ONLY_RE =
  /\b(approval|approve|approved|clarification|answer(ed)?|promot(e|ion)|scheduler|pause|resume|route selection|reroute|status synthesis|desk delivery|deliver(y|ed)?|operator decision|needs chris|authority)\b/i;

const ROUTE_LINK_RE =
  /\b(dispatch_id|dispatch_phid|phid:disp-|backlog item|item_id|task route|\/tasks\/|task:\s*[a-z0-9][a-z0-9-]*)\b/i;

export function classifyManagerWork(input: ClassifyManagerWorkInput): ManagerWorkClassification {
  const text = input.text ?? "";
  const action = input.action ?? "";
  const authorityOnly = input.source === "orchestration_decision" ||
    AUTHORITY_ONLY_RE.test(`${action}\n${text}`);
  const routeLinked = Boolean(
    input.routeLinked ||
    input.manager_dispatch_id ||
    input.dispatch_phid ||
    ROUTE_LINK_RE.test(text),
  );
  const specialist = authorityOnly ? null : classifySpecialistWork(text);

  if (authorityOnly) {
    return {
      work_class: "authority_required",
      specialist_work_class: null,
      authority_only: true,
      route_linked: routeLinked,
    };
  }

  if (input.source === "dispatch" || input.manager_dispatch_id || input.dispatch_phid) {
    return {
      work_class: "delegated",
      specialist_work_class: specialist,
      authority_only: false,
      route_linked: true,
    };
  }

  return {
    work_class: "manager_direct",
    specialist_work_class: specialist,
    authority_only: false,
    route_linked: routeLinked,
  };
}

export async function readManagerWorkTelemetryProjection(
  adapter: DbAdapter,
  teamId: string,
  opts: { now?: Date; warningLimit?: number } = {},
): Promise<ManagerWorkTelemetryProjection> {
  const now = opts.now ?? new Date();
  const cutoff24h = now.getTime() - 24 * 60 * 60 * 1000;
  const cutoff7d = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const warningLimit = Math.max(1, opts.warningLimit ?? WARNING_LIMIT);

  const [managerTurns, dispatches, authorityDecisions] = await Promise.all([
    readManagerQueryTurns(adapter, teamId, cutoff7d),
    readDelegatedDispatches(adapter, teamId, cutoff7d),
    readAuthorityDecisions(adapter, teamId, cutoff7d),
  ]);

  const counts24h = emptyWorkCounts();
  const counts7d = emptyWorkCounts();
  const specialist24h: Partial<Record<SpecialistWorkClass, number>> = {};
  const specialist7d: Partial<Record<SpecialistWorkClass, number>> = {};
  const warnings: ManagerWorkTelemetryWarning[] = [];

  const add = (atMs: number, c: ManagerWorkClassification) => {
    if (atMs >= cutoff7d) {
      counts7d[c.work_class] += 1;
      if (c.specialist_work_class) specialist7d[c.specialist_work_class] = (specialist7d[c.specialist_work_class] ?? 0) + 1;
    }
    if (atMs >= cutoff24h) {
      counts24h[c.work_class] += 1;
      if (c.specialist_work_class) specialist24h[c.specialist_work_class] = (specialist24h[c.specialist_work_class] ?? 0) + 1;
    }
  };

  for (const row of managerTurns) {
    const text = managerTurnText(row);
    const classification = classifyManagerWork({
      source: "manager_query",
      text,
      manager_dispatch_id: row.manager_dispatch_id,
      routeLinked: Boolean(row.manager_query_id),
    });
    add(Number(row.created), classification);

    const durationSeconds = Math.max(0, Math.round(((row.completed ?? now.getTime()) - row.created) / 1000));
    if (
      row.created >= cutoff7d &&
      classification.work_class === "manager_direct" &&
      classification.specialist_work_class &&
      !classification.route_linked &&
      durationSeconds >= LONG_MANAGER_TURN_SECONDS
    ) {
      warnings.push({
        source: "manager_query",
        query_id: row.query_id,
        created_at: new Date(row.created).toISOString(),
        completed_at: row.completed ? new Date(row.completed).toISOString() : null,
        duration_seconds: durationSeconds,
        specialist_work_class: classification.specialist_work_class,
        reason: "long manager-direct specialist turn lacks a linked dispatch_id, backlog item, or task route",
        excerpt: excerpt(text),
      });
    }
  }

  for (const row of dispatches) {
    const atMs = parseTimeMs(row.updated_at);
    if (atMs == null) continue;
    add(atMs, classifyManagerWork({
      source: "dispatch",
      text: `${row.subject ?? ""}\n${row.body_markdown ?? ""}`,
      dispatch_phid: row.dispatch_phid,
    }));
  }

  for (const row of authorityDecisions) {
    const atMs = parseTimeMs(row.ts);
    if (atMs == null) continue;
    add(atMs, classifyManagerWork({
      source: "orchestration_decision",
      text: row.reason,
      action: row.action,
      dispatch_phid: row.dispatch_phid,
    }));
  }

  warnings.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return {
    schema_version: "manager_work_telemetry.v1",
    window_hours: { last_24h: 24, last_7d: 24 * 7 },
    counts_24h: counts24h,
    counts_7d: counts7d,
    specialist_counts_24h: specialist24h,
    specialist_counts_7d: specialist7d,
    warning_count_24h: warnings.filter((w) => Date.parse(w.created_at) >= cutoff24h).length,
    warning_count_7d: warnings.length,
    recent_warnings: warnings.slice(0, warningLimit),
  };
}

function classifySpecialistWork(text: string): SpecialistWorkClass | null {
  for (const [klass, pattern] of SPECIALIST_PATTERNS) {
    if (pattern.test(text)) return klass;
  }
  return null;
}

function emptyWorkCounts(): Record<ManagerWorkClass, number> {
  return { manager_direct: 0, delegated: 0, authority_required: 0 };
}

async function readManagerQueryTurns(adapter: DbAdapter, teamId: string, cutoffMs: number): Promise<ManagerQueryTurnRow[]> {
  const { rows } = await adapter.query<ManagerQueryTurnRow>(
    `SELECT query_id, prompt, result, error, created, completed, manager_dispatch_id, manager_query_id
       FROM queries
      WHERE team_id = ?
        AND owner_kind = 'manager'
        AND created >= ?
      ORDER BY created DESC`,
    [teamId, cutoffMs],
  );
  return rows;
}

async function readDelegatedDispatches(adapter: DbAdapter, teamId: string, cutoffMs: number): Promise<DelegatedDispatchRow[]> {
  const cutoffIso = new Date(cutoffMs).toISOString();
  const { rows } = await adapter.query<DelegatedDispatchRow>(
    `SELECT dispatch_phid, subject, body_markdown, updated_at
       FROM dispatch_scheduler_queue
      WHERE team_id = ?
        AND updated_at >= ?
      ORDER BY updated_at DESC`,
    [teamId, cutoffIso],
  );
  return rows;
}

async function readAuthorityDecisions(adapter: DbAdapter, teamId: string, cutoffMs: number): Promise<AuthorityDecisionRow[]> {
  const cutoffIso = new Date(cutoffMs).toISOString();
  const { rows } = await adapter.query<AuthorityDecisionRow>(
    `SELECT action, reason, ts, dispatch_phid
       FROM orchestration_decision_log
      WHERE team_id = ?
        AND ts >= ?
        AND (
          action IN ('held', 'guardrail_halt', 'auto_pause', 'auto_promote')
          OR reason LIKE '%approval%'
          OR reason LIKE '%clarification%'
          OR reason LIKE '%promotion%'
          OR reason LIKE '%scheduler%'
          OR reason LIKE '%route%'
          OR reason LIKE '%status%'
        )
      ORDER BY ts DESC`,
    [teamId, cutoffIso],
  );
  return rows;
}

function managerTurnText(row: ManagerQueryTurnRow): string {
  return [row.prompt, row.result, row.error].filter((v): v is string => typeof v === "string" && v.trim() !== "").join("\n");
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function excerpt(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 220);
}
