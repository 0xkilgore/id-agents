import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import { canonicalProjectName, projectAliases } from "./read-model.js";
import type {
  ProjectRootRegistration,
  ProjectSourceFreshnessStatus,
  ProjectSourceGroup,
  ProjectSourceReadState,
  ProjectSourceRow,
  ProjectSourcesEnvelope,
  ProjectSourceSavedView,
} from "./sources-types.js";

interface AgentRow {
  id: string;
  name: string;
  working_directory: string | null;
}

interface ArtifactRow {
  artifact_id: string;
  basename: string;
  agent: string;
  tag: string | null;
  abs_path: string;
  title: string | null;
  produced_at: string;
  availability: string;
  media_type: string | null;
  source_mtime: string | null;
  source_size: number | null;
  project_ref: string | null;
  dispatch_ref: string | null;
  updated_at: string;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  approved_at: string | null;
  shipped_at: string | null;
}

interface QueryRow {
  query_id: string;
  agent_id: string | null;
  agent_name: string | null;
  working_directory: string | null;
  status: string;
  prompt: string | null;
  created: number;
  completed: number | null;
  result: string | null;
  error: string | null;
  manager_dispatch_id: string | null;
}

interface DispatchRow {
  dispatch_phid: string;
  query_id: string;
  agent_query_id: string | null;
  to_agent: string;
  subject: string;
  body_markdown: string;
  artifact_path: string | null;
  result_json: string | null;
  status: string;
  completed_at: string | null;
  updated_at: string;
}

interface FileStat {
  path: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
}

export interface BuildProjectSourcesOptions {
  project: string;
  generatedAt?: string;
  limit?: number;
  type?: ProjectSourceGroup | null;
  agent?: string | null;
  since?: string | null;
  until?: string | null;
  readState?: ProjectSourceReadState | null;
  status?: ProjectSourceFreshnessStatus | null;
  q?: string | null;
  maxFiles?: number;
  maxDepth?: number;
  statFile?: (absPath: string) => Promise<FileStat | null>;
  readDir?: (absPath: string) => Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>>;
}

export const SOURCE_GROUPS: ProjectSourceGroup[] = [
  "transcripts",
  "images_screenshots_logos",
  "pdfs_forms",
  "emails_captures",
  "artifacts_reports",
  "other_files",
];

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);
const INLINE_TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".csv", ".tsv", ".log", ".html", ".htm"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const PDF_EXT = new Set([".pdf"]);

export const PROJECT_SOURCES_SAVED_VIEW: ProjectSourceSavedView = {
  id: "project-sources.v1.index",
  field_ids: [
    "project_sources.row.id",
    "project_sources.row.group",
    "project_sources.row.title",
    "project_sources.row.source",
    "project_sources.row.dates",
    "project_sources.row.ownership",
    "project_sources.row.links",
    "project_sources.row.preview",
    "project_sources.row.read",
    "project_sources.row.freshness",
    "project_sources.row.open",
  ],
  filters: ["type", "project", "agent", "date", "read_state", "status", "q"],
};

export async function buildProjectSourcesEnvelope(
  adapter: DbAdapter,
  opts: BuildProjectSourcesOptions,
): Promise<ProjectSourcesEnvelope> {
  const canonical = canonicalProjectName(opts.project);
  const aliases = projectAliases(canonical);
  const aliasSet = new Set(aliases);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 500, 0), 2000);
  const maxDepth = Math.min(Math.max(opts.maxDepth ?? 5, 0), 10);

  const [agents, artifacts, queries, dispatches] = await Promise.all([
    readAgents(adapter),
    readArtifacts(adapter),
    readQueries(adapter),
    readDispatches(adapter),
  ]);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentProject = new Map<string, string | null>();
  for (const agent of agents) {
    const project = projectFromDeterministicPath(agent.working_directory) ?? canonicalProjectName(agent.name);
    agentProject.set(agent.id, project);
    agentProject.set(agent.name, project);
  }

  const roots = deterministicProjectRoots(canonical, aliasSet, agents, artifacts);
  const dispatchByQuery = new Map<string, DispatchRow>();
  const dispatchByAgentQuery = new Map<string, DispatchRow>();
  const dispatchByArtifactPath = new Map<string, DispatchRow>();
  for (const dispatch of dispatches) {
    dispatchByQuery.set(dispatch.query_id, dispatch);
    if (dispatch.agent_query_id) dispatchByAgentQuery.set(dispatch.agent_query_id, dispatch);
    for (const artifactPath of [dispatch.artifact_path, artifactPathFromResult(dispatch.result_json)]) {
      if (artifactPath) dispatchByArtifactPath.set(path.resolve(artifactPath), dispatch);
    }
  }

  const rows: ProjectSourceRow[] = [];
  const seenPaths = new Set<string>();

  for (const artifact of artifacts) {
    const project = canonicalProjectName(artifact.project_ref ?? projectFromDeterministicPath(artifact.abs_path) ?? "");
    if (!hasProject([project, agentProject.get(artifact.agent)], aliasSet)) continue;
    const dispatch = artifact.dispatch_ref
      ? dispatches.find((candidate) => candidate.dispatch_phid === artifact.dispatch_ref) ?? null
      : dispatchByArtifactPath.get(path.resolve(artifact.abs_path)) ?? null;
    rows.push(artifactRowToSource(artifact, canonical, dispatch?.dispatch_phid ?? artifact.dispatch_ref ?? null));
    seenPaths.add(path.resolve(artifact.abs_path));
  }

  for (const query of queries) {
    const agent = query.agent_id ? agentById.get(query.agent_id) : null;
    const project = projectFromDeterministicPath(query.working_directory ?? agent?.working_directory)
      ?? (query.agent_name ? canonicalProjectName(query.agent_name) : null);
    if (!hasProject([project, query.agent_name], aliasSet)) continue;
    const dispatch = dispatchByAgentQuery.get(query.query_id)
      ?? dispatchByQuery.get(query.query_id)
      ?? (query.manager_dispatch_id ? dispatches.find((candidate) => candidate.dispatch_phid === query.manager_dispatch_id) ?? null : null);
    rows.push(queryRowToSource(query, canonical, dispatch?.dispatch_phid ?? query.manager_dispatch_id ?? null));
  }

  const fileStats = await scanProjectRootFiles(roots, { maxFiles, maxDepth, readDir: opts.readDir, statFile: opts.statFile });
  for (const file of fileStats) {
    const resolved = path.resolve(file.path);
    if (seenPaths.has(resolved)) continue;
    const owner = ownerForPath(resolved, roots);
    rows.push(fileRowToSource(file, canonical, owner?.owner_agent ?? null, dispatchByArtifactPath.get(resolved)?.dispatch_phid ?? null));
  }

  const filtered = rows.filter((row) => matchesFilters(row, opts)).sort(compareRows).slice(0, limit);

  return {
    ok: true,
    schema_version: "project-sources.v1",
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    project: { requested: opts.project, canonical, aliases },
    saved_view: PROJECT_SOURCES_SAVED_VIEW,
    filters: {
      type: opts.type ?? null,
      project: canonical,
      agent: opts.agent ?? null,
      since: opts.since ?? null,
      until: opts.until ?? null,
      read_state: opts.readState ?? null,
      status: opts.status ?? null,
      q: opts.q ?? null,
      limit,
    },
    roots,
    groups: groupCounts(filtered),
    rows: filtered,
    count: filtered.length,
  };
}

async function readAgents(adapter: DbAdapter): Promise<AgentRow[]> {
  return (await adapter.query<AgentRow>(`SELECT id, name, working_directory FROM agents WHERE deleted_at IS NULL`)).rows;
}

async function readArtifacts(adapter: DbAdapter): Promise<ArtifactRow[]> {
  return (await adapter.query<ArtifactRow>(
    `SELECT a.artifact_id, a.basename, a.agent, a.tag, a.abs_path, a.title,
            a.produced_at, a.availability, a.media_type, a.source_mtime,
            a.source_size, a.project_ref, a.dispatch_ref, a.updated_at,
            rs.first_viewed_at, rs.last_viewed_at, rs.approved_at, rs.shipped_at
       FROM artifacts a
  LEFT JOIN artifact_review_state rs ON rs.artifact_id = a.artifact_id
   ORDER BY a.produced_at DESC
      LIMIT 2000`,
  )).rows;
}

async function readQueries(adapter: DbAdapter): Promise<QueryRow[]> {
  return (await adapter.query<QueryRow>(
    `SELECT q.query_id, q.agent_id, a.name AS agent_name, a.working_directory,
            q.status, q.prompt, q.created, q.completed, q.result, q.error,
            q.manager_dispatch_id
       FROM queries q
  LEFT JOIN agents a ON a.id = q.agent_id
   ORDER BY q.created DESC
      LIMIT 2000`,
  )).rows;
}

async function readDispatches(adapter: DbAdapter): Promise<DispatchRow[]> {
  return (await adapter.query<DispatchRow>(
    `SELECT dispatch_phid, query_id, agent_query_id, to_agent, subject, body_markdown,
            artifact_path, result_json, status, completed_at, updated_at
       FROM dispatch_scheduler_queue
   ORDER BY updated_at DESC
      LIMIT 2000`,
  )).rows;
}

export function deterministicProjectRoots(
  canonical: string,
  aliasSet: Set<string>,
  agents: AgentRow[],
  artifacts: ArtifactRow[],
): ProjectRootRegistration[] {
  const roots = new Map<string, ProjectRootRegistration>();
  const addRoot = (rootPath: string | null | undefined, ownerAgent: string | null, proof: ProjectRootRegistration["proof"]) => {
    if (!rootPath) return;
    const project = projectFromDeterministicPath(rootPath);
    if (!project || !aliasSet.has(canonicalProjectName(project))) return;
    const resolved = path.resolve(rootPath);
    const existing = roots.get(resolved);
    if (existing?.proof === "agent.working_directory" && proof === "artifact.abs_path") return;
    roots.set(resolved, {
      id: `root:${stableHash(resolved)}`,
      project: canonical,
      root_path: resolved,
      owner_agent: ownerAgent,
      proof,
    });
  };
  for (const agent of agents) addRoot(agent.working_directory, agent.name, "agent.working_directory");
  for (const artifact of artifacts) addRoot(projectRootFromPath(artifact.abs_path), artifact.agent, "artifact.abs_path");
  return [...roots.values()].sort((a, b) => a.root_path.localeCompare(b.root_path));
}

async function scanProjectRootFiles(
  roots: ProjectRootRegistration[],
  opts: Pick<BuildProjectSourcesOptions, "maxFiles" | "maxDepth" | "readDir" | "statFile">,
): Promise<FileStat[]> {
  const maxFiles = opts.maxFiles ?? 500;
  if (maxFiles <= 0) return [];
  const readDir = opts.readDir ?? ((p: string) => fsp.readdir(p, { withFileTypes: true }));
  const statFile = opts.statFile ?? (async (p: string) => {
    try {
      const stat = await fsp.stat(p);
      if (!stat.isFile()) return null;
      return { path: p, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, size: stat.size };
    } catch {
      return null;
    }
  });
  const files: FileStat[] = [];
  const visited = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= maxFiles || depth < 0) return;
    const resolved = path.resolve(dir);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readDir(resolved);
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const child = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(child, depth - 1);
      } else if (entry.isFile()) {
        const stat = await statFile(child);
        if (stat) files.push(stat);
      }
    }
  }
  for (const root of roots) await walk(root.root_path, opts.maxDepth ?? 5);
  return files;
}

function artifactRowToSource(row: ArtifactRow, project: string, dispatchId: string | null): ProjectSourceRow {
  const ext = path.extname(row.abs_path || row.basename).toLowerCase();
  return {
    id: `artifact:${row.artifact_id}`,
    group: groupForPath(row.abs_path, row.tag, row.title),
    title: cleanTitle(row.title) ?? titleFromBasename(row.basename),
    source: { kind: "artifact_catalog", path: row.abs_path, proof: "artifacts.abs_path" },
    dates: { created_at: row.produced_at, modified_at: row.updated_at ?? row.source_mtime },
    ownership: { project, agent: row.agent },
    links: { dispatch_id: dispatchId, artifact_id: row.artifact_id, query_id: null },
    preview: previewForExt(ext, row.media_type),
    read: readState(row),
    freshness: row.availability === "missing"
      ? { status: "missing", reason: "catalog availability is missing" }
      : { status: "fresh", reason: "cataloged artifact source" },
    open: { href: `/artifacts/${encodeURIComponent(row.artifact_id)}`, fallback: "artifact" },
  };
}

function queryRowToSource(row: QueryRow, project: string, dispatchId: string | null): ProjectSourceRow {
  const created = epochToIso(row.created);
  const completed = row.completed ? epochToIso(row.completed) : null;
  return {
    id: `query:${row.query_id}`,
    group: "transcripts",
    title: cleanTitle(firstLine(row.prompt)) ?? `Transcript ${row.query_id}`,
    source: { kind: "query_transcript", path: null, proof: "queries.query_id" },
    dates: { created_at: created, modified_at: completed ?? created },
    ownership: { project, agent: row.agent_name },
    links: { dispatch_id: dispatchId, artifact_id: null, query_id: row.query_id },
    preview: { renderable: true, state: "inline", media_type: "text/plain" },
    read: { state: "unknown", first_viewed_at: null, last_viewed_at: null },
    freshness: row.status === "error" || row.error
      ? { status: "stale", reason: "query finished with error" }
      : { status: "fresh", reason: "registered query transcript" },
    open: { href: `/queries/${encodeURIComponent(row.query_id)}`, fallback: "query" },
  };
}

function fileRowToSource(file: FileStat, project: string, agent: string | null, dispatchId: string | null): ProjectSourceRow {
  const ext = path.extname(file.path).toLowerCase();
  return {
    id: `file:${stableHash(path.resolve(file.path))}`,
    group: groupForPath(file.path),
    title: titleFromBasename(path.basename(file.path)),
    source: { kind: "filesystem", path: file.path, proof: "deterministic_project_root" },
    dates: { created_at: new Date(file.birthtimeMs).toISOString(), modified_at: new Date(file.mtimeMs).toISOString() },
    ownership: { project, agent },
    links: { dispatch_id: dispatchId, artifact_id: null, query_id: null },
    preview: previewForExt(ext),
    read: { state: "unknown", first_viewed_at: null, last_viewed_at: null },
    freshness: { status: "fresh", reason: "file present under registered project root" },
    open: { href: `file://${file.path}`, fallback: "file" },
  };
}

function matchesFilters(row: ProjectSourceRow, opts: BuildProjectSourcesOptions): boolean {
  if (opts.type && row.group !== opts.type) return false;
  if (opts.agent && row.ownership.agent !== opts.agent) return false;
  if (opts.readState && row.read.state !== opts.readState) return false;
  if (opts.status && row.freshness.status !== opts.status) return false;
  const ts = row.dates.modified_at ?? row.dates.created_at;
  if (opts.since && ts && ts < opts.since) return false;
  if (opts.until && ts && ts > opts.until) return false;
  if (opts.q) {
    const q = opts.q.toLowerCase();
    const haystack = [
      row.title,
      row.group,
      row.source.path,
      row.source.proof,
      row.ownership.project,
      row.ownership.agent,
      row.links.dispatch_id,
      row.links.artifact_id,
      row.links.query_id,
      row.freshness.status,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function groupCounts(rows: ProjectSourceRow[]): Record<ProjectSourceGroup, number> {
  const counts = Object.fromEntries(SOURCE_GROUPS.map((group) => [group, 0])) as Record<ProjectSourceGroup, number>;
  for (const row of rows) counts[row.group] += 1;
  return counts;
}

function compareRows(a: ProjectSourceRow, b: ProjectSourceRow): number {
  const ad = a.dates.modified_at ?? a.dates.created_at ?? "";
  const bd = b.dates.modified_at ?? b.dates.created_at ?? "";
  return bd.localeCompare(ad) || a.title.localeCompare(b.title);
}

function readState(row: ArtifactRow): ProjectSourceRow["read"] {
  const state: ProjectSourceReadState = row.shipped_at
    ? "shipped"
    : row.approved_at
      ? "approved"
      : row.last_viewed_at || row.first_viewed_at
        ? "read"
        : "unread";
  return { state, first_viewed_at: row.first_viewed_at, last_viewed_at: row.last_viewed_at };
}

function previewForExt(ext: string, mediaType: string | null = null): ProjectSourceRow["preview"] {
  if (INLINE_TEXT_EXT.has(ext)) return { renderable: true, state: "inline", media_type: mediaType ?? mediaTypeForExt(ext) };
  if (IMAGE_EXT.has(ext)) return { renderable: true, state: "inline", media_type: mediaType ?? mediaTypeForExt(ext) };
  if (PDF_EXT.has(ext)) return { renderable: true, state: "download", media_type: mediaType ?? "application/pdf" };
  return { renderable: false, state: "external_open", media_type: mediaType ?? mediaTypeForExt(ext) };
}

export function groupForPath(absPath: string, tag?: string | null, title?: string | null): ProjectSourceGroup {
  const ext = path.extname(absPath).toLowerCase();
  const name = path.basename(absPath).toLowerCase();
  const text = [absPath, tag, title].filter(Boolean).join(" ").toLowerCase();
  if (/\b(transcript|conversation|session|chat|query|meeting notes)\b/.test(text) || ext === ".log") return "transcripts";
  if (IMAGE_EXT.has(ext) || /\b(screenshot|screen|logo|image|photo)\b/.test(text)) return "images_screenshots_logos";
  if (PDF_EXT.has(ext) || /\b(form|forms|pdf)\b/.test(text)) return "pdfs_forms";
  if (/\b(email|mail|capture|inbox|gmail|newsletter)\b/.test(text) || name.endsWith(".eml") || name.endsWith(".mbox")) return "emails_captures";
  if (/\b(artifact|report|brief|closeout|handoff|output)\b/.test(text) || absPath.includes("/output/")) return "artifacts_reports";
  return "other_files";
}

export function projectFromDeterministicPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const normalized = absPath.replaceAll("\\", "/");
  const code = normalized.match(/\/Dropbox\/Code\/([^/]+)(?:\/|$)/);
  if (code) return canonicalProjectName(code[1]);
  const workspace = normalized.match(/\/\.id-agents\/workspace\/([^/]+)(?:\/|$)/);
  if (workspace && !["agents"].includes(workspace[1])) return canonicalProjectName(workspace[1]);
  const obsidian = normalized.match(/\/Dropbox\/Obsidian\/([^/]+)(?:\/|$)/);
  if (obsidian) return canonicalProjectName(obsidian[1]);
  return null;
}

function projectRootFromPath(absPath: string): string | null {
  const normalized = absPath.replaceAll("\\", "/");
  for (const marker of ["/output/", "/src/", "/tests/", "/docs/", "/meetings/", "/forms/", "/images/", "/screenshots/"]) {
    const idx = normalized.indexOf(marker);
    if (idx > 0) return normalized.slice(0, idx);
  }
  return path.dirname(absPath);
}

function ownerForPath(absPath: string, roots: ProjectRootRegistration[]): ProjectRootRegistration | null {
  const sorted = [...roots].sort((a, b) => b.root_path.length - a.root_path.length);
  return sorted.find((root) => absPath === root.root_path || absPath.startsWith(root.root_path + path.sep)) ?? null;
}

function hasProject(projects: Array<string | null | undefined>, aliases: Set<string>): boolean {
  return projects.some((p) => p != null && aliases.has(canonicalProjectName(p)));
}

function artifactPathFromResult(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { artifact_path?: unknown };
    return typeof parsed.artifact_path === "string" && parsed.artifact_path ? parsed.artifact_path : null;
  } catch {
    return null;
  }
}

function epochToIso(value: number): string {
  return new Date((value > 1e12 ? value : value * 1000)).toISOString();
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function mediaTypeForExt(ext: string): string | null {
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if ([".txt", ".log"].includes(ext)) return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  return null;
}

function titleFromBasename(value: string): string {
  return value.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || value;
}

function cleanTitle(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  return s ? s.slice(0, 160) : null;
}

function firstLine(value: string | null | undefined): string | null {
  return (value ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
}
