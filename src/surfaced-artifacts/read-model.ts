import { basename, extname } from "node:path";
import { promises as fsp } from "node:fs";
import type { DbAdapter } from "../db/db-adapter.js";
import { artifactIdFromPath } from "../outputs/storage.js";
import { projectFromPath } from "../outputs/entry-projection.js";
import type {
  SurfacedArtifactNeed,
  SurfacedArtifactRelevanceReason,
  SurfacedArtifactRow,
  SurfacedArtifactStatus,
} from "./types.js";

type ArtifactSource = "delivery-log" | "agent-done" | "manual" | "filesystem";

interface ArtifactRow {
  artifact_id: string;
  basename: string;
  agent: string;
  tag: string | null;
  abs_path: string;
  title: string | null;
  produced_at: string;
  source: ArtifactSource;
  availability: string;
  updated_at: string;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  approved_at: string | null;
  rejected_at?: string | null;
  shipped_at: string | null;
  comment_count: number;
  routed_count: number;
  last_op_at: string | null;
}

interface DispatchDoneRow {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  subject: string;
  body_markdown: string;
  status: string;
  completed_at: string | null;
  updated_at: string;
  result_json: string | null;
  artifact_path: string | null;
}

interface CommentRow {
  op_id: number;
  artifact_id: string;
  actor: string;
  ts: string;
  payload_json: string | null;
  source_link: string | null;
  artifact_title: string | null;
  basename: string | null;
  agent: string | null;
  tag: string | null;
  abs_path: string | null;
  produced_at: string | null;
}

export interface BuildSurfacedArtifactsOptions {
  limit?: number;
  readFile?: (path: string) => Promise<string>;
}

const REASON_RANK: Record<SurfacedArtifactRelevanceReason, number> = {
  needs_chris: 1,
  latest_project_critical: 2,
  requested_task_deliverable: 3,
  done_without_visible_deliverable: 4,
  comment_needs_routing: 5,
};

const RENDERABLE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".html", ".htm"]);
const CRITICAL_PROJECTS = new Set(["kapelle", "trinity"]);

export function isRawPrimaryTitle(value: string | null | undefined): boolean {
  const s = (value ?? "").trim();
  if (!s) return true;
  if (/^phid:/i.test(s)) return true;
  if (/^artifact:v\d+:/i.test(s)) return true;
  if (/^\/(?:Users|var|tmp|home)\//i.test(s)) return true;
  if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return true;
  if (/^[a-f0-9]{32,}$/i.test(s)) return true;
  return false;
}

export function titleSignalsFromBody(body: string | null | undefined): {
  frontmatterTitle: string | null;
  firstH1: string | null;
} {
  const text = body ?? "";
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  return {
    frontmatterTitle: fm?.[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ?? null,
    firstH1: text.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? null,
  };
}

export function humanTitleFromParts(input: {
  frontmatterTitle?: string | null;
  firstH1?: string | null;
  dispatchTitle?: string | null;
  taskTitle?: string | null;
  basename?: string | null;
  agent?: string | null;
  date?: string | null;
}): string {
  for (const candidate of [
    input.frontmatterTitle,
    input.firstH1,
    input.dispatchTitle,
    input.taskTitle,
    titleFromBasename(input.basename),
  ]) {
    const cleaned = cleanTitle(candidate);
    if (cleaned && !isRawPrimaryTitle(cleaned)) return cleaned;
  }
  return `Untitled artifact from ${cleanTitle(input.agent) || "unknown agent"} on ${input.date?.slice(0, 10) || "unknown date"}`;
}

export async function buildSurfacedArtifacts(
  adapter: DbAdapter,
  opts: BuildSurfacedArtifactsOptions = {},
): Promise<SurfacedArtifactRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const readFile = opts.readFile ?? ((p: string) => fsp.readFile(p, "utf8"));
  const rows = new Map<string, SurfacedArtifactRow>();
  const [artifacts, comments, dispatches] = await Promise.all([
    readArtifacts(adapter, limit),
    readCommentRows(adapter, limit),
    readDoneDispatches(adapter, limit),
  ]);

  for (const artifact of artifacts) {
    const body = await readRenderableBody(artifact.abs_path, readFile);
    const signals = titleSignalsFromBody(body.text);
    const reason = artifactReason(artifact);
    const status = artifactStatus(artifact);
    upsertRanked(rows, {
      id: `artifact:${artifact.artifact_id}`,
      title: humanTitleFromParts({
        frontmatterTitle: signals.frontmatterTitle,
        firstH1: signals.firstH1,
        dispatchTitle: artifact.title,
        basename: artifact.basename,
        agent: artifact.agent,
        date: artifact.produced_at,
      }),
      subtitle: subtitle([projectFromPath(artifact.abs_path), artifact.agent, artifact.tag]),
      status,
      relevance_reason: reason,
      needs: needForReason(reason, status),
      artifact_ref: artifact.abs_path || artifact.artifact_id,
      project_ref: projectFromPath(artifact.abs_path) ?? undefined,
      agent_name: artifact.agent,
      created_at: artifact.produced_at,
      updated_at: artifact.last_op_at ?? artifact.updated_at ?? artifact.produced_at,
      source_kind: artifact.source === "filesystem" ? "filesystem_reconcile" : "artifact",
      source_label: sourceLabel([projectFromPath(artifact.abs_path), artifact.agent, artifact.title ?? artifact.basename]),
      visibility_proof: {
        discovered_by: discoveredBy(artifact.source),
        artifact_path_present: Boolean(artifact.abs_path),
        body_renderable: body.renderable,
      },
    });
  }

  for (const dispatch of dispatches) {
    const artifactPath = dispatchArtifactPath(dispatch);
    const body = artifactPath ? await readRenderableBody(artifactPath, readFile) : { renderable: false, text: null };
    const missing = !artifactPath || !body.renderable;
    const base: Omit<SurfacedArtifactRow, "id" | "relevance_reason" | "needs" | "status" | "source_kind" | "visibility_proof"> = {
      title: humanTitleFromParts({
        dispatchTitle: dispatch.subject,
        basename: artifactPath ? basename(artifactPath) : null,
        agent: dispatch.to_agent,
        date: dispatch.completed_at ?? dispatch.updated_at,
      }),
      subtitle: subtitle([projectFromPath(artifactPath), dispatch.to_agent, dispatch.query_id]),
      artifact_ref: artifactPath ?? undefined,
      dispatch_ref: dispatch.dispatch_phid,
      project_ref: projectFromPath(artifactPath) ?? undefined,
      agent_name: dispatch.to_agent,
      created_at: dispatch.completed_at ?? dispatch.updated_at,
      updated_at: dispatch.completed_at ?? dispatch.updated_at,
      source_label: sourceLabel([projectFromPath(artifactPath), dispatch.to_agent, dispatch.subject]),
    };
    upsertRanked(rows, missing ? {
      ...base,
      id: `dispatch-missing:${dispatch.dispatch_phid}`,
      status: "unread",
      relevance_reason: "done_without_visible_deliverable",
      needs: "inspect_closeout",
      source_kind: "dispatch_done",
      visibility_proof: { discovered_by: "agent_done", artifact_path_present: Boolean(artifactPath), body_renderable: false },
    } : {
      ...base,
      id: `dispatch:${dispatch.dispatch_phid}`,
      status: "unread",
      relevance_reason: "requested_task_deliverable",
      needs: "read",
      source_kind: "dispatch_done",
      visibility_proof: { discovered_by: "agent_done", artifact_path_present: true, body_renderable: true },
    });
  }

  for (const comment of comments) {
    if (!commentNeedsRouting(comment.payload_json)) continue;
    const title = humanTitleFromParts({
      dispatchTitle: comment.artifact_title,
      basename: comment.basename,
      agent: comment.agent,
      date: comment.ts,
    });
    upsertRanked(rows, {
      id: `comment:${comment.artifact_id}:${comment.op_id}`,
      title: `Route comment on ${title}`,
      subtitle: subtitle([comment.agent, truncate(parseCommentBody(comment.payload_json), 72)]),
      status: "commented",
      relevance_reason: "comment_needs_routing",
      needs: "route",
      artifact_ref: comment.abs_path ?? comment.artifact_id,
      project_ref: projectFromPath(comment.abs_path) ?? undefined,
      agent_name: comment.agent ?? undefined,
      created_at: comment.ts,
      updated_at: comment.ts,
      source_kind: "comment",
      source_label: sourceLabel([comment.agent, title]),
      visibility_proof: { discovered_by: "comment", artifact_path_present: Boolean(comment.abs_path) },
    });
  }

  return [...rows.values()]
    .sort((a, b) => REASON_RANK[a.relevance_reason] - REASON_RANK[b.relevance_reason] || Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, limit);
}

async function readArtifacts(adapter: DbAdapter, limit: number): Promise<ArtifactRow[]> {
  const { rows } = await adapter.query<ArtifactRow>(
    `SELECT a.artifact_id, a.basename, a.agent, a.tag, a.abs_path, a.title,
            a.produced_at, a.source, a.availability, a.updated_at,
            rs.first_viewed_at, rs.last_viewed_at, rs.approved_at, rs.rejected_at,
            rs.shipped_at,
            SUM(CASE WHEN op.op_type = 'comment_recorded' THEN 1 ELSE 0 END) AS comment_count,
            SUM(CASE WHEN op.op_type = 'comment_routed' THEN 1 ELSE 0 END) AS routed_count,
            MAX(op.ts) AS last_op_at
       FROM artifacts a
  LEFT JOIN artifact_review_state rs ON rs.artifact_id = a.artifact_id
  LEFT JOIN artifact_operations op ON op.artifact_id = a.artifact_id
   GROUP BY a.artifact_id, a.basename, a.agent, a.tag, a.abs_path, a.title,
            a.produced_at, a.source, a.availability, a.updated_at,
            rs.first_viewed_at, rs.last_viewed_at, rs.approved_at, rs.rejected_at, rs.shipped_at
   ORDER BY COALESCE(MAX(op.ts), a.produced_at) DESC
      LIMIT ?`,
    [limit],
  );
  return rows;
}

async function readCommentRows(adapter: DbAdapter, limit: number): Promise<CommentRow[]> {
  const { rows } = await adapter.query<CommentRow>(
    `SELECT op.op_id, op.artifact_id, op.actor, op.ts, op.payload_json, op.source_link,
            a.title AS artifact_title, a.basename, a.agent, a.tag, a.abs_path, a.produced_at
       FROM artifact_operations op
  LEFT JOIN artifacts a ON a.artifact_id = op.artifact_id
      WHERE op.op_type = 'comment_recorded'
   ORDER BY op.ts DESC, op.op_id DESC
      LIMIT ?`,
    [limit],
  );
  return rows;
}

async function readDoneDispatches(adapter: DbAdapter, limit: number): Promise<DispatchDoneRow[]> {
  const { rows } = await adapter.query<DispatchDoneRow>(
    `SELECT dispatch_phid, query_id, to_agent, subject, body_markdown, status,
            completed_at, updated_at, result_json, artifact_path
       FROM dispatch_scheduler_queue
      WHERE status = 'done'
   ORDER BY COALESCE(completed_at, updated_at) DESC, dispatch_phid ASC
      LIMIT ?`,
    [limit],
  );
  return rows;
}

function artifactReason(row: ArtifactRow): SurfacedArtifactRelevanceReason {
  const haystack = [row.title, row.basename, row.tag].filter(Boolean).join(" ").toLowerCase();
  if (/\b(needs[_ -]?chris|needs[_ -]?read|needs[_ -]?approval|approve|approval|comment[_ -]?required)\b/.test(haystack)) return "needs_chris";
  const project = projectFromPath(row.abs_path);
  if ((project && CRITICAL_PROJECTS.has(project.toLowerCase())) || /\b(critical|watched|active|load[ -]?loop|kapelle|trinity)\b/.test(haystack)) {
    return "latest_project_critical";
  }
  if (row.source === "agent-done") return "requested_task_deliverable";
  return "latest_project_critical";
}

function artifactStatus(row: ArtifactRow): SurfacedArtifactStatus {
  if (row.approved_at) return "approved";
  if (Number(row.routed_count ?? 0) > 0) return "routed";
  if (Number(row.comment_count ?? 0) > 0) return "commented";
  if (row.last_viewed_at || row.first_viewed_at) return "read";
  return "unread";
}

function needForReason(reason: SurfacedArtifactRelevanceReason, status: SurfacedArtifactStatus): SurfacedArtifactNeed | undefined {
  if (reason === "done_without_visible_deliverable") return "inspect_closeout";
  if (reason === "comment_needs_routing") return "route";
  if (reason === "needs_chris" && status !== "approved") return status === "commented" ? "comment" : "read";
  if (reason === "requested_task_deliverable" || reason === "latest_project_critical") return "read";
  return undefined;
}

async function readRenderableBody(path: string | null | undefined, readFile: (path: string) => Promise<string>): Promise<{ renderable: boolean; text: string | null }> {
  if (!path || !RENDERABLE_EXTENSIONS.has(extname(path).toLowerCase())) return { renderable: false, text: null };
  try {
    const text = await readFile(path);
    return { renderable: text.trim().length > 0, text };
  } catch {
    return { renderable: false, text: null };
  }
}

function dispatchArtifactPath(row: DispatchDoneRow): string | null {
  if (row.artifact_path?.trim()) return row.artifact_path.trim();
  try {
    const parsed = row.result_json ? JSON.parse(row.result_json) as { artifact_path?: unknown; artifactPath?: unknown } : {};
    const raw = typeof parsed.artifact_path === "string" ? parsed.artifact_path : parsed.artifactPath;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function commentNeedsRouting(payloadJson: string | null): boolean {
  try {
    const route = payloadJson ? (JSON.parse(payloadJson) as { route_status?: { routed?: unknown; visible_state?: unknown } }).route_status : null;
    if (!route) return true;
    return !(route.routed === true || route.visible_state === "recorded+routed");
  } catch {
    return true;
  }
}

function parseCommentBody(payloadJson: string | null): string {
  try {
    const payload = payloadJson ? JSON.parse(payloadJson) as { body?: unknown; reaction?: unknown } : {};
    if (typeof payload.body === "string" && payload.body.trim()) return payload.body.trim();
    if (typeof payload.reaction === "string") return payload.reaction;
  } catch {
    /* ignore */
  }
  return "Unrouted comment";
}

function titleFromBasename(value: string | null | undefined): string | null {
  const b = cleanTitle(value);
  if (!b || isRawPrimaryTitle(b)) return null;
  const stem = b.replace(/\.[^.]+$/, "");
  const stripped = stem.replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, "").replace(/\b\d{4}-\d{2}-\d{2}\b/g, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : null;
}

function cleanTitle(value: string | null | undefined): string | null {
  const s = (value ?? "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
  return s || null;
}

function subtitle(parts: Array<string | null | undefined>): string | undefined {
  return parts.map((p) => cleanTitle(p)).filter(Boolean).join(" / ") || undefined;
}

function sourceLabel(parts: Array<string | null | undefined>): string {
  return subtitle(parts) ?? "Artifact source";
}

function discoveredBy(source: ArtifactSource): SurfacedArtifactRow["visibility_proof"]["discovered_by"] {
  if (source === "agent-done") return "agent_done";
  if (source === "delivery-log") return "delivery_log";
  if (source === "filesystem") return "filesystem";
  return "manual_fixture";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function upsertRanked(rows: Map<string, SurfacedArtifactRow>, row: SurfacedArtifactRow): void {
  const existing = rows.get(row.id);
  if (!existing || REASON_RANK[row.relevance_reason] < REASON_RANK[existing.relevance_reason]) rows.set(row.id, row);
}

export function artifactIdForSurfacingPath(path: string): string {
  return artifactIdFromPath(path);
}
