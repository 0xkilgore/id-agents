import type { DbAdapter } from "../db/db-adapter.js";
import { resolveTrack } from "../track-registry/registry.js";
import { parseProjectTag, parseTrackTag } from "../project-tracks/read-model.js";
import { projectFromPath } from "../outputs/entry-projection.js";

export type ResetConformanceKind = "task" | "dispatch" | "artifact" | "report";
export type ResetConformanceState = "accepted" | "quarantined";

export interface ResetConformanceRecord {
  kind: ResetConformanceKind;
  id: string;
  state: ResetConformanceState;
  missing: string[];
  track: string | null;
  track_state: "ok" | "unassigned" | "unknown";
  project: string | null;
  owner: string | null;
  status: string | null;
  next_action: string | null;
}

export interface ResetConformanceSummary {
  schema_version: "reset-conformance.v1";
  generated_at: string;
  state: "ok" | "quarantined";
  counts: {
    total: number;
    accepted: number;
    quarantined: number;
    by_kind: Record<ResetConformanceKind, { total: number; quarantined: number }>;
    unassigned: number;
    track_unknown: number;
  };
  records: ResetConformanceRecord[];
  sources: Record<ResetConformanceKind, "available" | "unavailable">;
}

const UNASSIGNED = "(unassigned)";
const DONE_STATUSES = new Set(["done", "landed", "promoted", "shipped", "closed"]);

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nextActionFromText(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  const tagged = raw.match(/(?:next[_\s-]*action|next)\s*:\s*(.+)$/im);
  return text(tagged?.[1]) ?? null;
}

export function classifyTrack(raw: string | null | undefined): ResetConformanceRecord["track_state"] {
  const t = text(raw);
  if (!t || t === UNASSIGNED) return "unassigned";
  return resolveTrack(t).conforms ? "ok" : "unknown";
}

function requiredMissing(input: {
  track: string | null;
  project: string | null;
  owner: string | null;
  status: string | null;
  next_action: string | null;
}): string[] {
  const missing: string[] = [];
  if (classifyTrack(input.track) !== "ok") missing.push("track");
  if (!input.project) missing.push("project");
  if (!input.owner) missing.push("owner");
  if (!input.status) missing.push("status");
  if (!input.next_action && !DONE_STATUSES.has((input.status ?? "").toLowerCase())) missing.push("next_action");
  return missing;
}

function record(kind: ResetConformanceKind, id: string, input: {
  track: string | null;
  project: string | null;
  owner: string | null;
  status: string | null;
  next_action: string | null;
}): ResetConformanceRecord {
  const track_state = classifyTrack(input.track);
  const missing = requiredMissing(input);
  return {
    kind,
    id,
    state: missing.length === 0 ? "accepted" : "quarantined",
    missing,
    track: input.track,
    track_state,
    project: input.project,
    owner: input.owner,
    status: input.status,
    next_action: input.next_action,
  };
}

async function safeQuery<T>(adapter: DbAdapter, sql: string): Promise<{ rows: T[]; available: boolean }> {
  try {
    const { rows } = await adapter.query<T>(sql);
    return { rows, available: true };
  } catch {
    return { rows: [], available: false };
  }
}

export async function buildResetConformanceSummary(
  adapter: DbAdapter,
  opts: { teamId?: string | null; generatedAt?: string; limit?: number } = {},
): Promise<ResetConformanceSummary> {
  const limit = opts.limit ?? 1000;
  const teamClause = opts.teamId ? `WHERE t.team_id = '${String(opts.teamId).replace(/'/g, "''")}'` : "";
  const dispatchTeamClause = opts.teamId ? `WHERE team_id = '${String(opts.teamId).replace(/'/g, "''")}'` : "";

  const [tasks, dispatches, artifacts] = await Promise.all([
    safeQuery<{
      id: string; name: string; title: string; description: string | null; status: string | null;
      owner: string | null; owner_name: string | null; created_by: string | null; created_by_name: string | null; track: string | null;
    }>(adapter, `
      SELECT t.id, t.name, t.title, t.description, t.status, t.owner, owner_agent.name AS owner_name,
             t.created_by, creator.name AS created_by_name, t.track
        FROM tasks t
   LEFT JOIN agents owner_agent ON owner_agent.id = t.owner
   LEFT JOIN agents creator ON creator.id = t.created_by
      ${teamClause}
    ORDER BY t.updated_at DESC
       LIMIT ${limit}
    `),
    safeQuery<{
      dispatch_phid: string; to_agent: string | null; subject: string | null; body_markdown: string | null; status: string | null;
    }>(adapter, `
      SELECT dispatch_phid, to_agent, subject, body_markdown, status
        FROM dispatch_scheduler_queue
      ${dispatchTeamClause}
    ORDER BY updated_at DESC
       LIMIT ${limit}
    `),
    safeQuery<{
      artifact_id: string; basename: string; agent: string | null; tag: string | null; abs_path: string | null;
      title: string | null; availability: string | null;
    }>(adapter, `
      SELECT artifact_id, basename, agent, tag, abs_path, title, availability
        FROM artifacts
    ORDER BY produced_at DESC
       LIMIT ${limit}
    `),
  ]);

  const records: ResetConformanceRecord[] = [];

  for (const row of tasks.rows) {
    records.push(record("task", row.id, {
      track: text(row.track),
      project: text(row.created_by_name) ?? text(row.owner_name),
      owner: text(row.owner_name) ?? text(row.owner),
      status: text(row.status),
      next_action: nextActionFromText(row.description),
    }));
  }

  for (const row of dispatches.rows) {
    records.push(record("dispatch", row.dispatch_phid, {
      track: parseTrackTag(row.subject) ?? parseTrackTag(row.body_markdown),
      project: parseProjectTag(row.subject) ?? parseProjectTag(row.body_markdown),
      owner: text(row.to_agent),
      status: text(row.status),
      next_action: nextActionFromText(row.body_markdown) ?? text(row.subject),
    }));
  }

  for (const row of artifacts.rows) {
    const isReport = /(^|[\\/])reports?[\\/]/i.test(row.abs_path ?? "") || /report/i.test(row.tag ?? row.basename ?? "");
    records.push(record(isReport ? "report" : "artifact", row.artifact_id, {
      track: parseTrackTag(row.tag) ?? parseTrackTag(row.title) ?? parseTrackTag(row.basename),
      project: projectFromPath(row.abs_path),
      owner: text(row.agent),
      status: text(row.availability),
      next_action: nextActionFromText(row.title) ?? text(row.title),
    }));
  }

  const by_kind: ResetConformanceSummary["counts"]["by_kind"] = {
    task: { total: 0, quarantined: 0 },
    dispatch: { total: 0, quarantined: 0 },
    artifact: { total: 0, quarantined: 0 },
    report: { total: 0, quarantined: 0 },
  };
  let accepted = 0;
  let quarantined = 0;
  let unassigned = 0;
  let trackUnknown = 0;
  for (const r of records) {
    by_kind[r.kind].total += 1;
    if (r.state === "accepted") accepted += 1;
    else {
      quarantined += 1;
      by_kind[r.kind].quarantined += 1;
    }
    if (r.track_state === "unassigned") unassigned += 1;
    if (r.track_state === "unknown") trackUnknown += 1;
  }

  return {
    schema_version: "reset-conformance.v1",
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    state: quarantined === 0 ? "ok" : "quarantined",
    counts: {
      total: records.length,
      accepted,
      quarantined,
      by_kind,
      unassigned,
      track_unknown: trackUnknown,
    },
    records: records.filter((r) => r.state === "quarantined").slice(0, 100),
    sources: {
      task: tasks.available ? "available" : "unavailable",
      dispatch: dispatches.available ? "available" : "unavailable",
      artifact: artifacts.available ? "available" : "unavailable",
      report: artifacts.available ? "available" : "unavailable",
    },
  };
}
