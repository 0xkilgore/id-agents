// Kapelle Fleet Activity read-model — builds the fleet.activity.v1 envelope.
//
// Federates artifacts + dispatches into a single team-scoped, since-watermark
// event stream. Scoping is by team_id: dispatch rows carry team_id directly;
// artifacts are attributed to a team via the producing agent's team_id. No
// operator identity or filesystem path is hard-coded — passing an unknown team
// yields an empty (never cross-team) feed plus a warning.

import type { DbAdapter } from "../db/db-adapter.js";
import { listArtifactCatalog } from "../outputs/storage.js";
import type { ArtifactCatalogRow } from "../outputs/types.js";
import { readDispatches, type DispatchReadRow } from "../dispatch-scheduler/read-model.js";
import {
  FLEET_ACTIVITY_KINDS,
  type FleetActivityEvent,
  type FleetActivityKind,
  type FleetActivityResponse,
} from "./types.js";

export const FLEET_ACTIVITY_SCHEMA_VERSION = "fleet.activity.v1" as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TEAM = "default";

const TERMINAL_DISPATCH_STATUSES = new Set(["done", "failed", "cancelled"]);

interface TeamRef {
  id: string | null;
  name: string | null;
}

interface TeamAgentRef {
  id: string;
  name: string;
  status: string | null;
  last_seen: number | null;
}

interface TaskActivityRow {
  id: string;
  name: string;
  title: string;
  status: string;
  owner: string | null;
  created_by: string | null;
  updated_at: number | null;
  completed_at: number | null;
  track: string | null;
}

interface ArtifactCommentRow {
  artifact_id: string;
  basename: string;
  title: string | null;
  agent: string;
  op_id: number;
  actor: string;
  ts: string;
  payload_json: string | null;
}

export interface BuildFleetActivityOptions {
  teamName?: string;
  /** Inclusive lower bound (ISO 8601). Invalid values are ignored + warned. */
  since?: string | null;
  limit?: number;
  kinds?: FleetActivityKind[];
  generatedAt: string;
}

export function normalizeLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Returns a valid ISO string or null. */
export function normalizeSince(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : trimmed;
}

export function normalizeKinds(raw: unknown): FleetActivityKind[] | null {
  if (raw == null) return null;
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw).split(",");
  const picked = tokens
    .map((t) => String(t).trim())
    .filter((t): t is FleetActivityKind =>
      (FLEET_ACTIVITY_KINDS as readonly string[]).includes(t),
    );
  return picked.length ? Array.from(new Set(picked)) : null;
}

export async function buildFleetActivity(
  adapter: DbAdapter,
  opts: BuildFleetActivityOptions,
): Promise<FleetActivityResponse> {
  const limit = normalizeLimit(opts.limit);
  const since = normalizeSince(opts.since);
  const kinds = opts.kinds && opts.kinds.length ? opts.kinds : [...FLEET_ACTIVITY_KINDS];
  const kindSet = new Set<FleetActivityKind>(kinds);
  const team = await resolveTeam(adapter, opts.teamName?.trim() || DEFAULT_TEAM);
  const warnings: FleetActivityResponse["warnings"] = [];

  if (typeof opts.since === "string" && opts.since.trim() && since === null) {
    warnings.push({
      code: "invalid_since",
      message: `Ignored unparseable "since" value; returning the full recent window instead.`,
    });
  }

  const events: FleetActivityEvent[] = [];

  if (!team.id) {
    warnings.push({
      code: "team_not_found",
      message: `No team row found for "${team.name ?? opts.teamName ?? DEFAULT_TEAM}"; the feed is empty to avoid cross-team leakage.`,
    });
    return emptyResponse(opts.generatedAt, team, since, limit, kinds, warnings);
  }

  // Over-fetch so the per-kind limit slice still has the newest events even
  // after team/agent/since filtering trims the candidate set.
  const fetchBudget = Math.min(limit * 4, 1000);

  const [agents, dispatchRows] = await Promise.all([
    listTeamAgents(adapter, team.id),
    needDispatches(kindSet)
      ? readDispatches(adapter, team.id, "all", fetchBudget)
      : Promise.resolve<DispatchReadRow[]>([]),
  ]);
  const agentNames = new Set<string>();
  for (const agent of agents) {
    if (agent.name) agentNames.add(agent.name);
    if (agent.id) agentNames.add(agent.id);
  }

  if (kindSet.has("artifact_produced")) {
    const artifactRows = await listArtifactCatalog(adapter, {
      since: since ?? undefined,
      limit: fetchBudget,
    });
    for (const row of artifactRows) {
      if (!agentNames.has(row.agent)) continue;
      events.push(artifactToEvent(row));
    }
  }

  for (const row of dispatchRows) {
    const event = dispatchToEvent(row, kindSet);
    if (event) events.push(event);
  }

  if (kindSet.has("task_claimed") || kindSet.has("task_completed")) {
    const taskRows = await listTaskActivity(adapter, team.id, since, fetchBudget);
    for (const row of taskRows) {
      events.push(...taskToEvents(row, kindSet));
    }
  }

  if (kindSet.has("artifact_commented")) {
    const commentRows = await listArtifactComments(adapter, team.id, since, fetchBudget);
    for (const row of commentRows) {
      if (!agentNames.has(row.agent)) continue;
      events.push(artifactCommentToEvent(row));
    }
  }

  const filtered = events.filter(
    (e) => kindSet.has(e.kind) && (since === null || Date.parse(e.ts) >= Date.parse(since)),
  );
  filtered.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.id.localeCompare(b.id));

  const counts = {
    total: filtered.length,
    returned: 0,
    artifact_produced: filtered.filter((e) => e.kind === "artifact_produced").length,
    dispatch_completed: filtered.filter((e) => e.kind === "dispatch_completed").length,
    dispatch_queued: filtered.filter((e) => e.kind === "dispatch_queued").length,
    task_claimed: filtered.filter((e) => e.kind === "task_claimed").length,
    task_completed: filtered.filter((e) => e.kind === "task_completed").length,
    artifact_commented: filtered.filter((e) => e.kind === "artifact_commented").length,
  };

  const items = filtered.slice(0, limit);
  counts.returned = items.length;

  if (counts.total > counts.returned) {
    warnings.push({
      code: "truncated",
      message: `Returned the ${counts.returned} newest of ${counts.total} matched events; lower the window or raise limit to page older activity.`,
    });
  }

  return {
    schema_version: FLEET_ACTIVITY_SCHEMA_VERSION,
    generated_at: opts.generatedAt,
    team,
    watermark: { since, next: items[0]?.ts ?? since },
    source: {
      system: "manager",
      projection: "fleet_activity",
      source_type: "hybrid_projection",
      read_path: "substrate",
    },
    filters: { since, limit, kinds },
    counts,
    instrumentation: buildInstrumentation(agents, opts.generatedAt),
    items,
    warnings,
  };
}

function needDispatches(kindSet: Set<FleetActivityKind>): boolean {
  return kindSet.has("dispatch_completed") || kindSet.has("dispatch_queued");
}

function emptyResponse(
  generatedAt: string,
  team: TeamRef,
  since: string | null,
  limit: number,
  kinds: FleetActivityKind[],
  warnings: FleetActivityResponse["warnings"],
): FleetActivityResponse {
  return {
    schema_version: FLEET_ACTIVITY_SCHEMA_VERSION,
    generated_at: generatedAt,
    team,
    watermark: { since, next: since },
    source: {
      system: "manager",
      projection: "fleet_activity",
      source_type: "hybrid_projection",
      read_path: "substrate",
    },
    filters: { since, limit, kinds },
    counts: {
      total: 0,
      returned: 0,
      artifact_produced: 0,
      dispatch_completed: 0,
      dispatch_queued: 0,
      task_claimed: 0,
      task_completed: 0,
      artifact_commented: 0,
    },
    instrumentation: {
      generated_for_day: generatedAt.slice(0, 10),
      active_window_hours: 24,
      daily_active_agents: 0,
      agents: [],
    },
    items: [],
    warnings,
  };
}

async function resolveTeam(adapter: DbAdapter, teamName: string): Promise<TeamRef> {
  try {
    const { rows } = await adapter.query<{ id: string; name: string }>(
      `SELECT id, name FROM teams WHERE name = ? LIMIT 1`,
      [teamName],
    );
    if (rows[0]) return { id: rows[0].id, name: rows[0].name };
  } catch {
    // Some unit harnesses mount the feed without the manager teams table.
  }
  return { id: null, name: teamName };
}

/**
 * The set of identifiers (agent name + id) for live agents on the team.
 * artifacts.agent stores the agent name; including the id keeps matching
 * robust if a producer recorded its id instead.
 */
async function listTeamAgents(adapter: DbAdapter, teamId: string): Promise<TeamAgentRef[]> {
  try {
    const { rows } = await adapter.query<TeamAgentRef>(
      `SELECT id, name, status, last_seen FROM agents WHERE team_id = ? AND deleted_at IS NULL`,
      [teamId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: row.status == null ? null : String(row.status),
      last_seen: row.last_seen == null ? null : Number(row.last_seen),
    }));
  } catch {
    // No agents table in this harness — artifacts simply won't be attributed.
    return [];
  }
}

function artifactToEvent(row: ArtifactCatalogRow): FleetActivityEvent {
  return {
    id: `artifact_produced:${row.artifact_id}`,
    kind: "artifact_produced",
    ts: row.produced_at,
    actor: row.agent,
    label: row.title ?? row.basename ?? row.artifact_id,
    summary: row.abs_path,
    href: `/ops/artifacts/${encodeURIComponent(row.artifact_id)}`,
    source_ref: row.artifact_id,
    metadata: {
      artifact_id: row.artifact_id,
      basename: row.basename,
      tag: row.tag,
      availability: row.availability,
      source: row.source,
    },
  };
}

function dispatchToEvent(
  row: DispatchReadRow,
  kindSet: Set<FleetActivityKind>,
): FleetActivityEvent | null {
  const terminal = TERMINAL_DISPATCH_STATUSES.has(row.status);
  if (terminal) {
    if (!kindSet.has("dispatch_completed")) return null;
    const ts = row.completed_at ?? row.done_at ?? row.updated_at;
    return {
      id: `dispatch_completed:${row.dispatch_phid}`,
      kind: "dispatch_completed",
      ts,
      actor: row.target_agent,
      label: row.title || row.subject || row.dispatch_phid,
      summary: row.failure_detail ?? null,
      href: `/ops/dispatches/${encodeURIComponent(row.dispatch_phid)}`,
      source_ref: row.dispatch_phid,
      metadata: {
        dispatch_id: row.dispatch_phid,
        query_id: row.query_id,
        status: row.status,
        effective_state: row.effective_state,
        failure_kind: row.failure_kind,
      },
    };
  }

  if (!kindSet.has("dispatch_queued")) return null;
  const ts = row.queued_at ?? row.updated_at;
  return {
    id: `dispatch_queued:${row.dispatch_phid}`,
    kind: "dispatch_queued",
    ts,
    actor: row.target_agent,
    label: row.title || row.subject || row.dispatch_phid,
    summary: null,
    href: `/ops/dispatches/${encodeURIComponent(row.dispatch_phid)}`,
    source_ref: row.dispatch_phid,
    metadata: {
      dispatch_id: row.dispatch_phid,
      query_id: row.query_id,
      status: row.status,
      effective_state: row.effective_state,
    },
  };
}

async function listTaskActivity(
  adapter: DbAdapter,
  teamId: string,
  since: string | null,
  limit: number,
): Promise<TaskActivityRow[]> {
  try {
    const params: unknown[] = [teamId];
    let sql = `SELECT id, name, title, status, owner, created_by, updated_at, completed_at, track
               FROM tasks
               WHERE team_id = ?`;
    if (since) {
      const sinceMs = Date.parse(since);
      sql += ` AND (updated_at >= ? OR completed_at >= ?)`;
      params.push(sinceMs, sinceMs);
    }
    sql += ` ORDER BY COALESCE(completed_at, updated_at, created_at) DESC LIMIT ?`;
    params.push(limit);
    const { rows } = await adapter.query<TaskActivityRow>(sql, params);
    return rows;
  } catch {
    return [];
  }
}

function taskToEvents(row: TaskActivityRow, kindSet: Set<FleetActivityKind>): FleetActivityEvent[] {
  const events: FleetActivityEvent[] = [];
  const title = row.title || row.name;
  if (kindSet.has("task_completed") && row.completed_at != null) {
    events.push({
      id: `task_completed:${row.id}`,
      kind: "task_completed",
      ts: new Date(Number(row.completed_at)).toISOString(),
      actor: row.owner ?? row.created_by ?? null,
      label: title,
      summary: row.track ?? null,
      href: `/ops/tasks/${encodeURIComponent(row.name)}`,
      source_ref: row.id,
      metadata: {
        task_id: row.id,
        task_name: row.name,
        status: row.status,
        owner: row.owner,
        track: row.track,
      },
    });
  }
  if (kindSet.has("task_claimed") && row.owner && row.updated_at != null && row.status !== "done") {
    events.push({
      id: `task_claimed:${row.id}`,
      kind: "task_claimed",
      ts: new Date(Number(row.updated_at)).toISOString(),
      actor: row.owner,
      label: title,
      summary: row.track ?? null,
      href: `/ops/tasks/${encodeURIComponent(row.name)}`,
      source_ref: row.id,
      metadata: {
        task_id: row.id,
        task_name: row.name,
        status: row.status,
        owner: row.owner,
        track: row.track,
      },
    });
  }
  return events;
}

async function listArtifactComments(
  adapter: DbAdapter,
  teamId: string,
  since: string | null,
  limit: number,
): Promise<ArtifactCommentRow[]> {
  try {
    const params: unknown[] = [teamId];
    let sql = `SELECT a.artifact_id, a.basename, a.title, a.agent,
                      o.op_id, o.actor, o.ts, o.payload_json
               FROM artifact_operations o
               JOIN artifacts a ON a.artifact_id = o.artifact_id
               JOIN agents ag ON ag.team_id = ? AND ag.deleted_at IS NULL
                            AND (ag.name = a.agent OR ag.id = a.agent)
               WHERE o.op_type = 'comment_recorded'`;
    if (since) {
      sql += ` AND o.ts >= ?`;
      params.push(since);
    }
    sql += ` ORDER BY o.ts DESC, o.op_id DESC LIMIT ?`;
    params.push(limit);
    const { rows } = await adapter.query<ArtifactCommentRow>(sql, params);
    return rows;
  } catch {
    return [];
  }
}

function artifactCommentToEvent(row: ArtifactCommentRow): FleetActivityEvent {
  const body = parseCommentBody(row.payload_json);
  const label = row.title ?? row.basename ?? row.artifact_id;
  return {
    id: `artifact_commented:${row.artifact_id}:${row.op_id}`,
    kind: "artifact_commented",
    ts: row.ts,
    actor: row.actor,
    label,
    summary: body,
    href: `/ops/artifacts/${encodeURIComponent(row.artifact_id)}#comment-${row.op_id}`,
    source_ref: row.artifact_id,
    metadata: {
      artifact_id: row.artifact_id,
      op_id: row.op_id,
      producer_agent: row.agent,
    },
  };
}

function parseCommentBody(payloadJson: string | null): string | null {
  try {
    const parsed = payloadJson ? JSON.parse(payloadJson) as { body?: unknown; reaction?: unknown } : {};
    if (typeof parsed.body === "string" && parsed.body.trim()) return parsed.body;
    if (typeof parsed.reaction === "string" && parsed.reaction.trim()) return parsed.reaction;
  } catch {
    /* tolerate legacy/malformed payloads */
  }
  return null;
}

function buildInstrumentation(agents: TeamAgentRef[], generatedAt: string): FleetActivityResponse["instrumentation"] {
  const day = generatedAt.slice(0, 10);
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const rows = agents
    .map((agent) => {
      const activeToday = agent.last_seen != null && agent.last_seen >= dayStart;
      return {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        last_seen_at: agent.last_seen == null ? null : new Date(agent.last_seen).toISOString(),
        active_today: activeToday,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    generated_for_day: day,
    active_window_hours: 24,
    daily_active_agents: rows.filter((agent) => agent.active_today).length,
    agents: rows,
  };
}
