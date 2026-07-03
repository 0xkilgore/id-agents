import path from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import { DEFAULT_REGISTRY, resolveTrack } from "../track-registry/registry.js";
import type {
  ProjectTrackArtifact,
  ProjectTrackBacklogItem,
  ProjectTrackBlocker,
  ProjectTrackDispatch,
  ProjectTrackResolution,
  ProjectTrackSummary,
  ProjectTracksEnvelope,
  ProjectTracksSources,
  ProjectTrackTask,
  TrackStatusBucket,
} from "./types.js";

interface AgentProjectRow {
  id: string;
  name: string;
  working_directory: string | null;
}

interface TaskProjectRow {
  id: string;
  name: string;
  title: string;
  status: string;
  owner: string | null;
  owner_name: string | null;
  updated_at: number;
  track: string | null;
}

interface ArtifactProjectRow {
  artifact_id: string;
  basename: string;
  agent: string;
  title: string | null;
  abs_path: string;
  produced_at: string;
  tag: string | null;
}

interface DispatchProjectRow {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  subject: string;
  body_markdown: string;
  status: string;
  updated_at: string;
  completed_at: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
}

interface BacklogProjectRow {
  item_id: string;
  title: string;
  track: string | null;
  to_agent: string | null;
  readiness_state: string;
  last_dispatch_phid: string | null;
  updated_at: string;
  track_drift: number | null;
}

const PROJECT_ALIASES: Record<string, string[]> = {
  "agent-platform": ["maestra", "agent-platform", "goals-tracks-tasks"],
};

const UNASSIGNED_TRACK = "(unassigned)";
const UNKNOWN_TRACK = "unknown";
const BLOCKED_BACKLOG_STATES = new Set(["blocked_dependency", "needs_chris_batch", "waiting_window", "failed"]);
const BLOCKED_DISPATCH_STATUSES = new Set(["blocked", "dispatch_blocked", "needs_clarification", "bounced", "failed"]);

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^project:/, "")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function canonicalProjectName(project: string): string {
  const key = normalizeKey(project);
  for (const [canonical, aliases] of Object.entries(PROJECT_ALIASES)) {
    if (aliases.map(normalizeKey).includes(key)) return canonical;
  }
  return key || "default";
}

export function projectAliases(project: string): string[] {
  const canonical = canonicalProjectName(project);
  const aliases = PROJECT_ALIASES[canonical] ?? [canonical];
  return Array.from(new Set([canonical, ...aliases].map(normalizeKey).filter(Boolean)));
}

function projectFromPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const parts = absPath.split(/[\\/]+/).filter(Boolean);
  const codeIdx = parts.lastIndexOf("Code");
  if (codeIdx >= 0 && parts[codeIdx + 1]) return normalizeKey(parts[codeIdx + 1]);
  const obsidianIdx = parts.lastIndexOf("Obsidian");
  if (obsidianIdx >= 0 && parts[obsidianIdx + 1]) return normalizeKey(parts[obsidianIdx + 1]);
  const parent = path.basename(path.dirname(absPath));
  return parent ? normalizeKey(parent) : null;
}

export function parseProjectTag(text: string | null | undefined): string | null {
  const m = (text ?? "").match(/\[\s*project\s*:\s*([^\]]+?)\s*\]/i);
  return m ? canonicalProjectName(m[1]) : null;
}

export function parseTrackTag(text: string | null | undefined): string | null {
  const s = text ?? "";
  const explicit = s.match(/\[\s*track\s*:\s*([^\]]+?)\s*\]/i);
  if (explicit) return explicit[1].trim();
  const bracket = s.match(/\[\s*((?:T-[A-Z0-9-]+|T\d+|I-\d+)(?:\.[A-Za-z0-9_.-]+)?)\s*\]/);
  return bracket ? bracket[1].trim() : null;
}

function epochToIso(value: number): string {
  return new Date((value > 1e12 ? value : value * 1000)).toISOString();
}

function resolveProjectTrack(track: string | null | undefined, forcedDrift = false): ProjectTrackResolution {
  const raw = track?.trim() || null;
  if (!raw || raw === UNASSIGNED_TRACK) {
    return { raw: raw ?? UNASSIGNED_TRACK, canonical: null, conforms: false, via: "none", drift: forcedDrift };
  }
  const resolved = resolveTrack(raw);
  return {
    raw,
    canonical: resolved.canonical,
    conforms: resolved.conforms,
    via: resolved.via,
    drift: forcedDrift || !resolved.conforms,
  };
}

function hasProject(projects: Array<string | null | undefined>, aliases: Set<string>): boolean {
  return projects.some((p) => p != null && aliases.has(canonicalProjectName(p)));
}

function makeTrackSummary(track: ProjectTrackResolution): ProjectTrackSummary {
  const id = track.raw ?? UNKNOWN_TRACK;
  return {
    track: id,
    canonical_track: track.canonical,
    conforms: track.conforms,
    deferred: track.via === "deferred",
    drift: track.drift,
    counts: { task: 0, artifact: 0, dispatch: 0, backlog_item: 0 },
    status_counts: { queued: 0, building: 0, built_pending_review: 0, landed: 0, held: 0, other: 0 },
    latest_activity_at: null,
    owner_lanes: [],
    tasks: [],
    artifacts: [],
    dispatches: [],
    backlog_items: [],
    blockers: [],
  };
}

/** Record one item's live status into its track summary: bump the pipeline
 *  bucket, advance the latest-activity watermark (ISO sorts lexically), and add
 *  the owner lane. */
function recordStatus(
  summary: ProjectTrackSummary,
  bucket: TrackStatusBucket,
  activityIso: string | null,
  owner: string | null | undefined,
): void {
  summary.status_counts[bucket] += 1;
  if (activityIso && (!summary.latest_activity_at || activityIso > summary.latest_activity_at)) {
    summary.latest_activity_at = activityIso;
  }
  if (owner && !summary.owner_lanes.includes(owner)) summary.owner_lanes.push(owner);
}

function taskBucket(status: string | null | undefined): TrackStatusBucket {
  switch ((status ?? "").toLowerCase()) {
    case "todo": case "queued": case "ready": return "queued";
    case "doing": case "building": case "in_flight": return "building";
    case "done": case "landed": case "promoted": return "landed";
    case "blocked": case "held": case "paused": return "held";
    default: return "other";
  }
}

function dispatchBucket(status: string): TrackStatusBucket {
  switch (status) {
    case "queued": return "queued";
    case "in_flight": return "building";
    case "done": return "landed";
    default: return "other"; // failed / resume_delivery_failed / unknown
  }
}

function backlogBucket(readiness: string): TrackStatusBucket {
  if (BLOCKED_BACKLOG_STATES.has(readiness)) return "held";
  switch (readiness) {
    case "ready": case "queued": case "admitted": return "queued";
    case "building": case "in_flight": case "dispatched": return "building";
    case "needs_review": case "built_pending_review": return "built_pending_review";
    case "landed": case "done": case "promoted": return "landed";
    default: return "other";
  }
}

function addToSummary(
  summaries: Map<string, ProjectTrackSummary>,
  track: ProjectTrackResolution,
): ProjectTrackSummary {
  const key = track.raw ?? UNKNOWN_TRACK;
  let summary = summaries.get(key);
  if (!summary) {
    summary = makeTrackSummary(track);
    summaries.set(key, summary);
  } else if (track.drift) {
    summary.drift = true;
  }
  return summary;
}

export async function buildProjectTracksEnvelope(
  adapter: DbAdapter,
  opts: { project: string; generatedAt?: string; limitPerKind?: number },
): Promise<ProjectTracksEnvelope> {
  const requested = opts.project;
  const canonical = canonicalProjectName(requested);
  const aliases = projectAliases(canonical);
  const aliasSet = new Set(aliases);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const limit = opts.limitPerKind ?? 50;

  const [
    { rows: agents },
    { rows: tasks },
    { rows: artifacts },
    { rows: dispatches },
    { rows: backlog },
  ] = await Promise.all([
    adapter.query<AgentProjectRow>(`SELECT id, name, working_directory FROM agents WHERE deleted_at IS NULL`),
    adapter.query<TaskProjectRow>(
      `SELECT t.id, t.name, t.title, t.status, t.owner, a.name AS owner_name,
              t.updated_at, t.track
         FROM tasks t
    LEFT JOIN agents a ON a.id = t.owner
        ORDER BY t.updated_at DESC
        LIMIT 1000`,
    ),
    adapter.query<ArtifactProjectRow>(
      `SELECT artifact_id, basename, agent, title, abs_path, produced_at, tag
         FROM artifacts
        ORDER BY produced_at DESC
        LIMIT 1000`,
    ),
    adapter.query<DispatchProjectRow>(
      `SELECT dispatch_phid, query_id, to_agent, subject, body_markdown, status,
              updated_at, completed_at, failure_kind, failure_detail
         FROM dispatch_scheduler_queue
        ORDER BY updated_at DESC
        LIMIT 1000`,
    ),
    adapter.query<BacklogProjectRow>(
      `SELECT item_id, title, track, to_agent, readiness_state, last_dispatch_phid,
              updated_at, track_drift
         FROM orchestration_backlog_item
        ORDER BY updated_at DESC
        LIMIT 1000`,
    ),
  ]);

  const agentProjects = new Map<string, string | null>();
  const agentNames = new Map<string, string>();
  for (const agent of agents) {
    const fromDir = projectFromPath(agent.working_directory);
    const fromName = canonicalProjectName(agent.name);
    const project = fromDir ?? (aliasSet.has(fromName) ? canonical : fromName);
    agentProjects.set(agent.id, project);
    agentNames.set(agent.id, agent.name);
    agentProjects.set(agent.name, project);
  }

  const dispatchProjects = new Map<string, string | null>();
  const dispatchTracks = new Map<string, string | null>();
  for (const row of dispatches) {
    const project =
      parseProjectTag(row.subject) ??
      parseProjectTag(row.body_markdown) ??
      agentProjects.get(row.to_agent) ??
      null;
    dispatchProjects.set(row.dispatch_phid, project);
    dispatchTracks.set(row.dispatch_phid, parseTrackTag(row.subject) ?? parseTrackTag(row.body_markdown));
  }

  const summaries = new Map<string, ProjectTrackSummary>();
  let totalAssociations = 0;
  let conformingAssociations = 0;
  let driftCount = 0;
  let unassignedCount = 0;
  let unknownCount = 0;
  const countTrack = (track: ProjectTrackResolution) => {
    totalAssociations += 1;
    if (track.conforms) conformingAssociations += 1;
    if (track.drift) driftCount += 1;
    // Conformance breakdown for the non-conforming set (acceptance: report
    // unassigned/unknown track counts). "(unassigned)" = no track; any other
    // non-conforming raw value = an assigned-but-unrecognized (unknown) track.
    if (track.raw === UNASSIGNED_TRACK) unassignedCount += 1;
    else if (!track.conforms) unknownCount += 1;
  };

  for (const row of tasks) {
    if (!hasProject([agentProjects.get(row.owner ?? "") ?? null, row.owner_name], aliasSet)) continue;
    const track = resolveProjectTrack(row.track);
    const item: ProjectTrackTask = {
      id: row.id,
      name: row.name,
      title: row.title,
      status: row.status,
      owner: row.owner_name ?? row.owner,
      updated_at: epochToIso(row.updated_at),
      track,
    };
    const summary = addToSummary(summaries, track);
    if (summary.tasks.length < limit) summary.tasks.push(item);
    summary.counts.task += 1;
    recordStatus(summary, taskBucket(row.status), item.updated_at, item.owner);
    countTrack(track);
  }

  for (const row of artifacts) {
    const trackRaw = parseTrackTag(row.tag) ?? parseTrackTag(row.title) ?? parseTrackTag(row.basename);
    if (!hasProject([projectFromPath(row.abs_path), agentProjects.get(row.agent) ?? null], aliasSet)) continue;
    const track = resolveProjectTrack(trackRaw);
    const item: ProjectTrackArtifact = {
      artifact_id: row.artifact_id,
      title: row.title,
      basename: row.basename,
      agent: row.agent,
      abs_path: row.abs_path,
      produced_at: row.produced_at,
      track,
    };
    const summary = addToSummary(summaries, track);
    if (summary.artifacts.length < limit) summary.artifacts.push(item);
    summary.counts.artifact += 1;
    // A produced artifact is landed deliverable evidence.
    recordStatus(summary, "landed", item.produced_at, row.agent);
    countTrack(track);
  }

  for (const row of dispatches) {
    if (!hasProject([dispatchProjects.get(row.dispatch_phid) ?? null], aliasSet)) continue;
    const track = resolveProjectTrack(dispatchTracks.get(row.dispatch_phid));
    const item: ProjectTrackDispatch = {
      dispatch_phid: row.dispatch_phid,
      query_id: row.query_id,
      subject: row.subject,
      to_agent: agentNames.get(row.to_agent) ?? row.to_agent,
      status: row.status,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      track,
    };
    const summary = addToSummary(summaries, track);
    if (summary.dispatches.length < limit) summary.dispatches.push(item);
    if (isDispatchBlocker(row) && summary.blockers.length < limit) {
      summary.blockers.push(dispatchBlocker(row, track));
    }
    summary.counts.dispatch += 1;
    recordStatus(summary, dispatchBucket(row.status), item.updated_at, item.to_agent);
    countTrack(track);
  }

  for (const row of backlog) {
    if (!hasProject([dispatchProjects.get(row.last_dispatch_phid ?? "") ?? null, agentProjects.get(row.to_agent ?? "") ?? null], aliasSet)) {
      continue;
    }
    const track = resolveProjectTrack(row.track, row.track_drift === 1);
    const item: ProjectTrackBacklogItem = {
      item_id: row.item_id,
      title: row.title,
      readiness_state: row.readiness_state,
      to_agent: row.to_agent ? (agentNames.get(row.to_agent) ?? row.to_agent) : null,
      last_dispatch_phid: row.last_dispatch_phid,
      updated_at: row.updated_at,
      track,
    };
    const summary = addToSummary(summaries, track);
    if (summary.backlog_items.length < limit) summary.backlog_items.push(item);
    if (BLOCKED_BACKLOG_STATES.has(row.readiness_state) && summary.blockers.length < limit) {
      summary.blockers.push(backlogBlocker(row, track));
    }
    summary.counts.backlog_item += 1;
    recordStatus(summary, backlogBucket(row.readiness_state), item.updated_at, item.to_agent);
    countTrack(track);
  }

  const tracks = [...summaries.values()].sort((a, b) => {
    const ac = Object.values(a.counts).reduce((sum, n) => sum + n, 0);
    const bc = Object.values(b.counts).reduce((sum, n) => sum + n, 0);
    return bc - ac || a.track.localeCompare(b.track);
  });
  for (const s of tracks) s.owner_lanes.sort();
  const conformingShare = totalAssociations > 0 ? conformingAssociations / totalAssociations : 1;

  // Honesty doctrine (spec §"Honesty bar"): declare each feeding source's
  // availability explicitly so the UI can render "unavailable/stale" instead of
  // faking a fixture. The refactor-debt ledger has no table in this datastore, so
  // T-REFACTOR built-pending-review / built-and-reviewed / per-finding X-of-Y are
  // NOT sourced — reported unavailable, never faked.
  const sources: ProjectTracksSources = {
    orchestration_backlog: "available",
    task_stream: "available",
    dispatch_queue: "available",
    refactor_debt_ledger: "unavailable",
    spec054_landed: "derived",
    notes: [
      "refactor_debt_ledger unavailable: no RD-ledger table in this datastore; T-REFACTOR built-pending-review / built-and-reviewed and per-finding X-of-Y counts are not sourced yet (shown unavailable, never faked).",
      "spec054_landed derived: landed counts are inferred from terminal dispatch/backlog status, not a dedicated promotion/merge feed.",
    ],
  };

  return {
    schema_version: "project-tracks.v1",
    generated_at: generatedAt,
    project: { requested, canonical, aliases },
    source: {
      read_path: "substrate",
      projection: "project_tracks",
      source_type: "hybrid_projection",
    },
    tracks,
    canonical_tracks: DEFAULT_REGISTRY.canonical,
    deferred_tracks: DEFAULT_REGISTRY.deferred,
    drift: {
      total_associations: totalAssociations,
      conforming_associations: conformingAssociations,
      conforming_share: Number(conformingShare.toFixed(4)),
      threshold: DEFAULT_REGISTRY.conformanceThreshold,
      below_threshold: conformingShare < DEFAULT_REGISTRY.conformanceThreshold,
      drift_count: driftCount,
      unassigned_count: unassignedCount,
      unknown_count: unknownCount,
    },
    sources,
    empty: totalAssociations === 0,
  };
}

function isDispatchBlocker(row: DispatchProjectRow): boolean {
  return BLOCKED_DISPATCH_STATUSES.has(row.status) || row.failure_kind != null || row.failure_detail != null;
}

function dispatchBlocker(row: DispatchProjectRow, track: ProjectTrackResolution): ProjectTrackBlocker {
  return {
    kind: "dispatch",
    id: row.dispatch_phid,
    title: row.subject,
    status: row.status,
    reason: row.failure_detail ?? row.failure_kind,
    updated_at: row.updated_at,
    track,
  };
}

function backlogBlocker(row: BacklogProjectRow, track: ProjectTrackResolution): ProjectTrackBlocker {
  return {
    kind: "backlog_item",
    id: row.item_id,
    title: row.title,
    status: row.readiness_state,
    reason: row.readiness_state,
    updated_at: row.updated_at,
    track,
  };
}
