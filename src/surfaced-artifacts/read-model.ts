import { promises as fsp } from "node:fs";
import { basename, extname } from "node:path";
import { isC0FeedbackReactionsEnabled } from "../config/feature-flags.js";
import type { DbAdapter } from "../db/db-adapter.js";
import { projectFromPath } from "../outputs/entry-projection.js";
import { artifactIdFromPath } from "../outputs/storage.js";
import type {
  ArtifactDeliveryFreshness,
  RecentFloodDiagnostic,
  RawSurfacedArtifactRowKey,
  SavedViewExecutionResult,
  SavedViewFieldId,
  SavedViewFieldRegistryEntry,
  SavedViewUnsupportedFieldError,
  SurfacedArtifactHealthEvent,
  SurfacedArtifactsHealth,
  SurfacedArtifactsSavedView,
  SurfacedArtifactNeed,
  SurfacedArtifactRelevanceReason,
  SurfacedArtifactBodySource,
  SurfacedArtifactRow,
  SurfacedArtifactSourceKind,
  SurfacedArtifactSourceType,
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
  media_type: string | null;
  content_hash: string | null;
  source_mtime: string | null;
  source_host: string | null;
  project_ref: string | null;
  dispatch_ref: string | null;
  body_text: string | null;
  body_error: string | null;
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
  promote: number | null;
  promotion_result_json: string | null;
  promotion_input_json: string | null;
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
  rawLimit?: number;
  readFile?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

const REASON_RANK: Record<SurfacedArtifactRelevanceReason, number> = {
  needs_decision: 1,
  blocked_or_stale: 2,
  final_user_facing_deliverable: 3,
  changed_product_behavior: 4,
  domain_action: 5,
};

const REASON_SCORE: Record<SurfacedArtifactRelevanceReason, number> = {
  needs_decision: 500,
  blocked_or_stale: 400,
  final_user_facing_deliverable: 300,
  changed_product_behavior: 200,
  domain_action: 100,
};

const RENDERABLE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".html", ".htm"]);
const CRITICAL_PROJECTS = new Set(["kapelle", "trinity"]);
const DOMAIN_PROJECTS = new Set(["cleveland-park", "finances", "politics", "personal", "rams"]);
const TRACK_RE = /\bT-[A-Z0-9][A-Z0-9_.-]*\b/g;

export const SURFACED_ARTIFACTS_SAVED_VIEW: SurfacedArtifactsSavedView = {
  id: "surfaced-artifacts.v1.primary",
  execution: "saved_view_backed",
  field_ids: [
    "artifact.id",
    "artifact.title",
    "artifact.subtitle",
    "artifact.workItemRef",
    "artifact.groupCount",
    "artifact.groupedSourceKinds",
    "artifact.rankScore",
    "artifact.status",
    "artifact.relevanceReason",
    "artifact.needs",
    "artifact.artifactRef",
    "artifact.dispatchRef",
    "artifact.taskRef",
    "artifact.projectRef",
    "artifact.programRef",
    "artifact.trackRef",
    "artifact.agentName",
    "artifact.createdAt",
    "artifact.updatedAt",
    "artifact.sourceKind",
    "artifact.sourceType",
    "artifact.sourceLabel",
    "artifact.sourcePath",
    "artifact.sourceProof",
    "artifact.visibility.discoveredBy",
    "artifact.visibility.pathPresent",
    "artifact.visibility.bodyRenderable",
    "artifact.delivery.stableUrl",
    "artifact.delivery.copyTextUrl",
    "artifact.delivery.downloadUrl",
    "artifact.delivery.mediaType",
    "artifact.delivery.freshness",
    "artifact.delivery.sourceHost",
    "artifact.delivery.sourceMtime",
    "artifact.delivery.contentHash",
    "artifact.delivery.bodyCached",
    "artifact.readState",
    "artifact.tags",
    "artifact.contentHash",
    "artifact.hasComments",
    "artifact.delivery.bodyAvailable",
    "artifact.delivery.bodySource",
    "artifact.delivery.openUrl",
    "dispatch.id",
    "dispatch.queryId",
    "dispatch.title",
    "dispatch.status",
    "dispatch.agentId",
    "dispatch.taskName",
    "dispatch.createdAt",
    "dispatch.queuedAt",
    "dispatch.startedAt",
    "dispatch.completedAt",
    "dispatch.updatedAt",
    "dispatch.needsOperator",
    "dispatch.failureKind",
    "dispatch.recoveryStatus",
    "loop.id",
    "loop.slug",
    "loop.title",
    "loop.status",
    "loop.nextRunAt",
    "loop.lastRunAt",
    "loop.dueAt",
    "loop.late",
    "loop.deliveryStatus",
    "user_task.id",
    "user_task.title",
    "user_task.status",
    "user_task.owner",
    "user_task.due",
    "user_task.priority",
    "user_task.source",
    "user_task.context",
    "user_task.projectRef",
    "user_task.updatedAt",
  ],
  field_registry: [],
  raw_row_key_mapping: {
    id: "artifact.id",
    title: "artifact.title",
    subtitle: "artifact.subtitle",
    work_item_ref: "artifact.workItemRef",
    group_count: "artifact.groupCount",
    grouped_source_kinds: "artifact.groupedSourceKinds",
    rank_score: "artifact.rankScore",
    status: "artifact.status",
    relevance_reason: "artifact.relevanceReason",
    needs: "artifact.needs",
    artifact_ref: "artifact.artifactRef",
    dispatch_ref: "artifact.dispatchRef",
    task_ref: "artifact.taskRef",
    project_ref: "artifact.projectRef",
    program_ref: "artifact.programRef",
    track_ref: "artifact.trackRef",
    agent_name: "artifact.agentName",
    created_at: "artifact.createdAt",
    updated_at: "artifact.updatedAt",
    source_kind: "artifact.sourceKind",
    source_type: "artifact.sourceType",
    source_label: "artifact.sourceLabel",
    source_path: "artifact.sourcePath",
    source_proof: "artifact.sourceProof",
    visibility_proof: "artifact.visibility.discoveredBy",
  },
  diagnostic_field_ids: [
    "surfaced_artifacts.recent_flood.window_start",
    "surfaced_artifacts.recent_flood.window_end",
    "surfaced_artifacts.recent_flood.source_data",
    "surfaced_artifacts.recent_flood.total_raw_count",
    "surfaced_artifacts.recent_flood.grouped_count",
    "surfaced_artifacts.recent_flood.suppressed_from_primary_count",
    "surfaced_artifacts.recent_flood.groups",
    "surfaced_artifacts.recent_flood.raw_rows",
  ],
};

SURFACED_ARTIFACTS_SAVED_VIEW.field_registry = buildFieldRegistry(SURFACED_ARTIFACTS_SAVED_VIEW.field_ids);

const FIELD_IDS = new Set<SavedViewFieldId>(SURFACED_ARTIFACTS_SAVED_VIEW.field_ids);
const RAW_TO_CANONICAL = SURFACED_ARTIFACTS_SAVED_VIEW.raw_row_key_mapping;

export function validateSavedViewField(field: string): SavedViewUnsupportedFieldError | null {
  if (FIELD_IDS.has(field as SavedViewFieldId)) return null;
  const canonical = RAW_TO_CANONICAL[field as RawSurfacedArtifactRowKey];
  return {
    code: "unsupported_field",
    field,
    canonical_field: canonical,
    message: canonical
      ? `Raw SurfacedArtifactRow key "${field}" is not a saved-view field id; use "${canonical}".`
      : `Unsupported saved-view field "${field}".`,
  };
}

export function validateSavedViewPredicateFields(input: unknown): SavedViewUnsupportedFieldError[] {
  const fields = collectPredicateFields(input);
  const errors: SavedViewUnsupportedFieldError[] = [];
  for (const field of fields) {
    const error = validateSavedViewField(field);
    if (error) errors.push(error);
  }
  return errors;
}

export function executeSurfacedArtifactsSavedView(
  rows: SurfacedArtifactRow[],
  predicate: unknown,
  nowIso = new Date().toISOString(),
): SavedViewExecutionResult<SurfacedArtifactRow> {
  const errors = validateSavedViewPredicateFields(predicate);
  return {
    ok: errors.length === 0,
    schema_version: "view-execution.v1",
    view_id: SURFACED_ARTIFACTS_SAVED_VIEW.id,
    generated_at: nowIso,
    rows: errors.length === 0 ? rows : [],
    count: errors.length === 0 ? rows.length : 0,
    errors,
  };
}

function buildFieldRegistry(fieldIds: SavedViewFieldId[]): SavedViewFieldRegistryEntry[] {
  return fieldIds.map((id) => ({
    id,
    raw_row_key: rawKeyForCanonical(id),
    value_type: fieldValueType(id),
    operators: fieldOperators(id),
  }));
}

function rawKeyForCanonical(id: SavedViewFieldId): RawSurfacedArtifactRowKey | undefined {
  const found = Object.entries(SURFACED_ARTIFACTS_SAVED_VIEW.raw_row_key_mapping)
    .find(([, canonical]) => canonical === id);
  return found?.[0] as RawSurfacedArtifactRowKey | undefined;
}

function fieldValueType(id: SavedViewFieldId): SavedViewFieldRegistryEntry["value_type"] {
  if (id.endsWith("At") || id === "task.due" || id === "work_item.due" || id === "user_task.due" || id === "dispatch.completedAt") return "timestamp";
  if (id === "artifact.rankScore" || id === "artifact.groupCount" || id === "work_item.rank") return "number";
  if (id === "artifact.groupedSourceKinds" || id === "artifact.tags") return "string[]";
  if (id.includes(".has") || id === "loop.late" || id === "dispatch.needsOperator" || id === "artifact.visibility.pathPresent" || id === "artifact.visibility.bodyRenderable" || id === "artifact.delivery.bodyCached" || id === "artifact.delivery.bodyAvailable") return "boolean";
  if (id.endsWith("status") || id.endsWith("Status") || id.endsWith("freshness") || id.endsWith("Freshness") || id === "artifact.needs") return "enum";
  return "string";
}

function fieldOperators(id: SavedViewFieldId): SavedViewFieldRegistryEntry["operators"] {
  const type = fieldValueType(id);
  if (type === "number" || type === "timestamp") return ["eq", "neq", "exists", "gt", "gte", "lt", "lte"];
  if (type === "string[]") return ["contains", "exists"];
  if (type === "boolean") return ["eq", "neq", "exists"];
  if (type === "enum") return ["eq", "neq", "in", "not_in", "exists"];
  return ["eq", "neq", "in", "not_in", "contains", "exists"];
}

function collectPredicateFields(input: unknown): string[] {
  const fields: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.field === "string") fields.push(record.field);
    for (const key of ["and", "or", "not", "predicates", "filters", "where", "query"]) {
      if (key in record) walk(record[key]);
    }
  };
  walk(input);
  return [...new Set(fields)];
}

export function isRawPrimaryTitle(value: string | null | undefined): boolean {
  const s = (value ?? "").trim();
  if (!s) return true;
  if (/^phid:/i.test(s)) return true;
  if (/^(query|dispatch|task|artifact)[-_:][a-z0-9][a-z0-9_.:-]{5,}$/i.test(s)) return true;
  if (/^art[-_:][a-z0-9_-]{6,}$/i.test(s)) return true;
  if (/^artifact:v\d+:/i.test(s)) return true;
  if (/^\/(?:Users|var|tmp|home)\//i.test(s)) return true;
  if (/^[A-Za-z0-9+/_-]{24,}={0,2}$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return true;
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

function metadataSignalsFromText(text: string | null | undefined): {
  project: string | null;
  program: string | null;
  track: string | null;
} {
  const body = text ?? "";
  const frontmatter = body.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1] ?? "";
  const project = firstClean([
    frontmatter.match(/^project:\s*["']?([^\n]+?)["']?\s*$/m)?.[1],
    body.match(/\bproject:\s*`?([A-Za-z0-9_.-]+)`?/i)?.[1],
  ]);
  const program = firstClean([
    frontmatter.match(/^program:\s*["']?([^\n]+?)["']?\s*$/m)?.[1],
    body.match(/\b(Local-First Project\/Artifact Surfacing program)\b/i)?.[1],
    body.match(/\bprogram:\s*`?([^`\n]+?)`?\s*(?:\n|$)/i)?.[1],
  ]);
  const track = normalizeTrack(firstClean([
    frontmatter.match(/^track:\s*["']?([^\n]+?)["']?\s*$/m)?.[1],
    body.match(TRACK_RE)?.[0],
  ]));
  return {
    project: project ? slugify(project) : null,
    program: programFromText(program) ?? slugify(program),
    track,
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
  return (await buildSurfacedArtifactsReadModel(adapter, opts)).rows;
}

export async function buildSurfacedArtifactsReadModel(
  adapter: DbAdapter,
  opts: BuildSurfacedArtifactsOptions = {},
): Promise<{ rows: SurfacedArtifactRow[]; recent_flood: RecentFloodDiagnostic; health: SurfacedArtifactsHealth }> {
  const primaryLimit = Math.min(Math.max(opts.limit ?? 5, 1), 7);
  const rawLimit = Math.min(Math.max(opts.rawLimit ?? 250, primaryLimit), 500);
  const readFile = opts.readFile ?? ((p: string) => fsp.readFile(p, "utf8"));
  const feedbackEnabled = isC0FeedbackReactionsEnabled(opts.env);
  const [artifacts, comments, dispatches] = await Promise.all([
    readArtifacts(adapter, rawLimit),
    readCommentRows(adapter, rawLimit),
    readDoneDispatches(adapter, rawLimit),
  ]);

  const rawRows: SurfacedArtifactRow[] = [];
  for (const artifact of artifacts) {
    const body = await readRenderableBody(artifact.abs_path, readFile);
    const signals = titleSignalsFromBody(body.text);
    const metadata = metadataSignalsFromText(body.text);
    const project = cleanTitle(artifact.project_ref) ?? projectFromPath(artifact.abs_path) ?? metadata.project ?? projectFromText([artifact.title, artifact.basename, artifact.tag].join(" "));
    const track = metadata.track ?? trackFromText([artifact.tag, artifact.title, artifact.basename, body.text].join(" "));
    const program = metadata.program ?? programFromText([artifact.title, artifact.basename, body.text].join(" "));
    const sourceKind = artifactSourceKind(artifact);
    const sourceType = sourceTypeFromPath({
      path: artifact.abs_path,
      mediaType: artifact.media_type,
      title: artifact.title ?? artifact.basename,
      body: artifact.body_text ?? body.text,
    });
    const reason = artifactReason(artifact);
    const status = artifactStatus(artifact, feedbackEnabled);
    rawRows.push(withRank({
      id: `artifact:${artifact.artifact_id}`,
      title: humanTitleFromParts({
        frontmatterTitle: signals.frontmatterTitle,
        firstH1: signals.firstH1,
        dispatchTitle: artifact.title,
        basename: artifact.basename,
        agent: artifact.agent,
        date: artifact.produced_at,
      }),
      subtitle: subtitle([project, artifact.agent, artifact.tag]),
      work_item_ref: artifactWorkItemRef(artifact, project),
      group_count: 1,
      grouped_source_kinds: [sourceKind],
      status,
      relevance_reason: reason,
      needs: needForReason(reason, status),
      artifact_ref: artifact.abs_path || artifact.artifact_id,
      dispatch_ref: artifact.dispatch_ref ?? undefined,
      project_ref: project ?? undefined,
      program_ref: program ?? undefined,
      track_ref: track ?? undefined,
      agent_name: artifact.agent,
      created_at: artifact.produced_at,
      updated_at: artifact.last_op_at ?? artifact.updated_at ?? artifact.produced_at,
      source_kind: sourceKind,
      source_type: sourceType,
      source_label: sourceLabel([project, artifact.agent, artifact.title ?? artifact.basename]),
      source_path: artifact.abs_path || undefined,
      source_proof: sourceProof(artifact.abs_path, artifact.source, artifact.source_host),
      visibility_proof: {
        discovered_by: discoveredBy(artifact.source),
        artifact_path_present: Boolean(artifact.abs_path),
        body_renderable: body.renderable,
      },
      delivery: artifactDelivery(artifact.artifact_id, {
        mediaType: artifact.media_type,
        freshness: body.renderable ? "current" : artifact.body_error ? "error" : "body_unavailable",
        sourceHost: artifact.source_host,
        sourceMtime: artifact.source_mtime,
        contentHash: artifact.content_hash,
        bodyCached: Boolean(artifact.body_text),
        bodyAvailable: body.renderable || Boolean(artifact.body_text),
        bodySource: artifact.body_text ? "cache" : body.renderable ? "filesystem" : "unavailable",
        bodyPreview: artifact.body_text?.slice(0, 1200) ?? body.text?.slice(0, 1200) ?? null,
      }),
    }));
  }

  for (const dispatch of dispatches) {
    const artifactPath = dispatchArtifactPath(dispatch);
    const body = artifactPath ? await readRenderableBody(artifactPath, readFile) : { renderable: false, text: null };
    const signals = titleSignalsFromBody(body.text);
    const metadata = metadataSignalsFromText([body.text, dispatch.body_markdown].filter(Boolean).join("\n"));
    const missing = !artifactPath || !body.renderable;
    const project = projectFromPath(artifactPath) ?? metadata.project ?? projectFromText([dispatch.subject, dispatch.body_markdown, dispatch.result_json].join(" "));
    const track = metadata.track ?? trackFromText([dispatch.subject, dispatch.body_markdown, dispatch.result_json].join(" "));
    const program = metadata.program ?? programFromText([dispatch.subject, dispatch.body_markdown].join(" "));
    const reason = missing ? "blocked_or_stale" : dispatchReasonFor(dispatch);
    const status: SurfacedArtifactStatus = "unread";
    const sourceKind = dispatchSourceKind(dispatch, missing);
    const sourceType = sourceTypeFromPath({
      path: artifactPath,
      mediaType: mediaTypeFromPathForDelivery(artifactPath),
      title: dispatch.subject,
      body: body.text ?? dispatch.body_markdown,
    });
    rawRows.push(withRank({
      id: missing ? `dispatch-missing:${dispatch.dispatch_phid}` : `dispatch:${dispatch.dispatch_phid}`,
      title: humanTitleFromParts({
        frontmatterTitle: signals.frontmatterTitle,
        firstH1: signals.firstH1,
        dispatchTitle: dispatch.subject,
        basename: artifactPath ? basename(artifactPath) : null,
        agent: dispatch.to_agent,
        date: dispatch.completed_at ?? dispatch.updated_at,
      }),
      subtitle: subtitle([project, dispatch.to_agent, dispatch.query_id]),
      work_item_ref: dispatchWorkItemRef(dispatch, artifactPath, project),
      group_count: 1,
      grouped_source_kinds: [sourceKind],
      status,
      relevance_reason: reason,
      needs: missing ? "inspect_closeout" : needForReason(reason, status),
      artifact_ref: artifactPath ?? undefined,
      dispatch_ref: dispatch.dispatch_phid,
      project_ref: project ?? undefined,
      program_ref: program ?? undefined,
      track_ref: track ?? undefined,
      agent_name: dispatch.to_agent,
      created_at: dispatch.completed_at ?? dispatch.updated_at,
      updated_at: dispatch.completed_at ?? dispatch.updated_at,
      source_kind: sourceKind,
      source_type: sourceType,
      source_label: sourceLabel([project, dispatch.to_agent, dispatch.subject]),
      source_path: artifactPath ?? undefined,
      source_proof: artifactPath ? sourceProof(artifactPath, "agent-done", null) : `dispatch:${dispatch.dispatch_phid}`,
      visibility_proof: {
        discovered_by: "agent_done",
        artifact_path_present: Boolean(artifactPath),
        body_renderable: !missing,
      },
      delivery: artifactDelivery(artifactPath ? artifactIdFromPath(artifactPath) : dispatch.dispatch_phid, {
        mediaType: mediaTypeFromPathForDelivery(artifactPath),
        freshness: missing ? "body_unavailable" : "current",
        sourceHost: null,
        sourceMtime: null,
        contentHash: null,
        bodyCached: false,
        bodyAvailable: body.renderable,
        bodySource: body.renderable ? "filesystem" : "unavailable",
        bodyPreview: body.text?.slice(0, 1200) ?? null,
      }),
    }));
  }

  if (feedbackEnabled) {
    for (const comment of comments) {
      if (!commentNeedsRouting(comment.payload_json)) continue;
      const project = projectFromPath(comment.abs_path) ?? projectFromText([comment.artifact_title, comment.basename, comment.tag].join(" "));
      const track = trackFromText([comment.tag, comment.artifact_title, comment.basename, parseCommentBody(comment.payload_json)].join(" "));
      const title = humanTitleFromParts({
        dispatchTitle: comment.artifact_title,
        basename: comment.basename,
        agent: comment.agent,
        date: comment.ts,
      });
      rawRows.push(withRank({
        id: `comment:${comment.artifact_id}:${comment.op_id}`,
        title: `Route comment on ${title}`,
        subtitle: subtitle([comment.agent, truncate(parseCommentBody(comment.payload_json), 72)]),
        work_item_ref: `artifact:${comment.artifact_id}`,
        group_count: 1,
        grouped_source_kinds: ["comment"],
        status: "commented",
        relevance_reason: "blocked_or_stale",
        needs: "route",
        artifact_ref: comment.abs_path ?? comment.artifact_id,
        project_ref: project ?? undefined,
        track_ref: track ?? undefined,
        agent_name: comment.agent ?? undefined,
        created_at: comment.ts,
        updated_at: comment.ts,
        source_kind: "comment",
        source_type: sourceTypeFromPath({ path: comment.abs_path, title }),
        source_label: sourceLabel([comment.agent, title]),
        source_path: comment.abs_path ?? undefined,
        source_proof: comment.abs_path ? sourceProof(comment.abs_path, "comment", null) : `comment:${comment.artifact_id}:${comment.op_id}`,
        visibility_proof: { discovered_by: "comment", artifact_path_present: Boolean(comment.abs_path) },
        delivery: artifactDelivery(comment.artifact_id, {
          mediaType: mediaTypeFromPathForDelivery(comment.abs_path),
          freshness: comment.abs_path ? "current" : "body_unavailable",
          sourceHost: null,
          sourceMtime: null,
          contentHash: null,
          bodyCached: false,
          bodyAvailable: false,
          bodySource: "unavailable",
          bodyPreview: null,
        }),
      }));
    }
  }

  const grouped = groupPrimaryRows(rawRows);
  const rows = grouped.sort(compareSurfacedRows).slice(0, primaryLimit);
  return {
    rows,
    recent_flood: buildRecentFloodDiagnostic(rawRows, grouped, rows, { rawLimit, primaryLimit }),
    health: buildSurfacedArtifactsHealth(rawRows, rows),
  };
}

export function buildSurfacedArtifactsHealth(
  rawRows: SurfacedArtifactRow[],
  primaryRows: SurfacedArtifactRow[],
): SurfacedArtifactsHealth {
  const primaryKeys = new Set<string>();
  for (const row of primaryRows) {
    primaryKeys.add(row.id);
    if (row.artifact_ref) primaryKeys.add(`artifact_ref:${row.artifact_ref}`);
    if (row.dispatch_ref) primaryKeys.add(`dispatch_ref:${row.dispatch_ref}`);
    if (row.work_item_ref) primaryKeys.add(`work_item_ref:${row.work_item_ref}`);
  }

  const events = new Map<string, SurfacedArtifactHealthEvent>();
  for (const row of rawRows) {
    if (row.visibility_proof.artifact_path_present && row.visibility_proof.body_renderable === false) {
      addHealthEvent(events, {
        topic: "artifact.surfacing.body_unavailable",
        severity: "error",
        subject_kind: row.dispatch_ref ? "dispatch" : row.artifact_ref ? "artifact" : "surfaced_artifact",
        subject_id: row.dispatch_ref ?? row.artifact_ref ?? row.id,
        message: `Artifact body is unavailable for ${row.title}`,
        data: healthEventData(row),
      });
    }

    const inPrimary = primaryKeys.has(row.id)
      || (row.artifact_ref ? primaryKeys.has(`artifact_ref:${row.artifact_ref}`) : false)
      || (row.dispatch_ref ? primaryKeys.has(`dispatch_ref:${row.dispatch_ref}`) : false)
      || (row.work_item_ref ? primaryKeys.has(`work_item_ref:${row.work_item_ref}`) : false);
    if (!inPrimary && (row.source_kind === "artifact" || row.source_kind === "dispatch_done")) {
      addHealthEvent(events, {
        topic: "artifact.surfacing.missing_from_primary",
        severity: "warning",
        subject_kind: row.dispatch_ref ? "dispatch" : row.artifact_ref ? "artifact" : "surfaced_artifact",
        subject_id: row.dispatch_ref ?? row.artifact_ref ?? row.id,
        message: `Fresh artifact is not present in the primary Desk/Recent Output rows: ${row.title}`,
        data: healthEventData(row),
      });
    }
  }

  const ordered = [...events.values()].sort((a, b) => {
    const severity = (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1);
    return severity || a.topic.localeCompare(b.topic) || a.subject_id.localeCompare(b.subject_id);
  });
  return {
    ok: ordered.length === 0,
    surface: "ops.surfaced-artifacts.health",
    event_count: ordered.length,
    events: ordered,
  };
}

function addHealthEvent(events: Map<string, SurfacedArtifactHealthEvent>, event: SurfacedArtifactHealthEvent): void {
  events.set(`${event.topic}:${event.subject_kind}:${event.subject_id}`, event);
}

function healthEventData(row: SurfacedArtifactRow): SurfacedArtifactHealthEvent["data"] {
  return {
    artifact_ref: row.artifact_ref,
    dispatch_ref: row.dispatch_ref,
    row_id: row.id,
    title: row.title,
    source_kind: row.source_kind,
    discovered_by: row.visibility_proof.discovered_by,
    artifact_path_present: row.visibility_proof.artifact_path_present,
    body_renderable: row.visibility_proof.body_renderable,
  };
}

async function readArtifacts(adapter: DbAdapter, limit: number): Promise<ArtifactRow[]> {
  const { rows } = await adapter.query<ArtifactRow>(
    `SELECT a.artifact_id, a.basename, a.agent, a.tag, a.abs_path, a.title,
            a.produced_at, a.source, a.availability, a.media_type, a.content_hash,
            a.source_mtime, a.source_host, a.project_ref, a.dispatch_ref,
            b.body_text, b.body_error, a.updated_at,
            rs.first_viewed_at, rs.last_viewed_at, rs.approved_at, rs.rejected_at,
            rs.shipped_at,
            SUM(CASE WHEN op.op_type = 'comment_recorded' THEN 1 ELSE 0 END) AS comment_count,
            SUM(CASE WHEN op.op_type = 'comment_routed' THEN 1 ELSE 0 END) AS routed_count,
            MAX(op.ts) AS last_op_at
       FROM artifacts a
  LEFT JOIN artifact_bodies b ON b.artifact_id = a.artifact_id
  LEFT JOIN artifact_review_state rs ON rs.artifact_id = a.artifact_id
  LEFT JOIN artifact_operations op ON op.artifact_id = a.artifact_id
   GROUP BY a.artifact_id, a.basename, a.agent, a.tag, a.abs_path, a.title,
            a.produced_at, a.source, a.availability, a.media_type, a.content_hash,
            a.source_mtime, a.source_host, a.project_ref, a.dispatch_ref,
            b.body_text, b.body_error, a.updated_at,
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
            completed_at, updated_at, result_json, artifact_path,
            promote, promotion_result_json, promotion_input_json
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
  if (/\b(needs[_ -]?chris|needs[_ -]?read|needs[_ -]?decision|needs[_ -]?approval|approve|approval|comment[_ -]?required|choose|unblock)\b/.test(haystack)) return "needs_decision";
  if (/\b(blocked|stale|missing|failed|failure|retry|route[-_ ]?failed|verification[-_ ]?failed)\b/.test(haystack)) return "blocked_or_stale";
  if (/\b(promotion|promoted|deploy|deployed|verification|verified|behavior|changed|config|code|release)\b/.test(haystack)) return "changed_product_behavior";
  const project = projectFromPath(row.abs_path);
  if (project && DOMAIN_PROJECTS.has(project.toLowerCase())) return "domain_action";
  if (/\b(final|deliverable|closeout|handoff|report|brief|rundown|addendum)\b/.test(haystack)) return "final_user_facing_deliverable";
  if ((project && CRITICAL_PROJECTS.has(project.toLowerCase())) || /\b(critical|watched|active|load[ -]?loop|kapelle|trinity)\b/.test(haystack)) return "changed_product_behavior";
  if (row.source === "agent-done") return "final_user_facing_deliverable";
  return "final_user_facing_deliverable";
}

function artifactStatus(row: ArtifactRow, feedbackEnabled = true): SurfacedArtifactStatus {
  if (row.approved_at) return "approved";
  if (Number(row.routed_count ?? 0) > 0) return "routed";
  if (feedbackEnabled && Number(row.comment_count ?? 0) > 0) return "commented";
  if (row.last_viewed_at || row.first_viewed_at) return "read";
  return "unread";
}

function artifactSourceKind(row: ArtifactRow): SurfacedArtifactSourceKind {
  if (row.source === "filesystem") return "filesystem_reconcile";
  const haystack = [row.title, row.basename, row.tag].filter(Boolean).join(" ").toLowerCase();
  if (/\b(promot(?:e|ed|ion)|merge[-_ ]?main)\b/.test(haystack)) return "promotion";
  if (/\b(verif(?:y|ied|ication)|qa|smoke|test[-_ ]?report)\b/.test(haystack)) return "verification";
  return "artifact";
}

function dispatchReasonFor(row: DispatchDoneRow): SurfacedArtifactRelevanceReason {
  const text = [row.subject, row.body_markdown, row.result_json, row.promotion_result_json, row.promotion_input_json].filter(Boolean).join(" ").toLowerCase();
  if (/\b(needs[_ -]?decision|needs[_ -]?chris|approve|approval|choose|unblock)\b/.test(text)) return "needs_decision";
  if (/\b(blocked|stale|failed|failure|retry|missing|incomplete)\b/.test(text)) return "blocked_or_stale";
  const promotion = parsePromotionInput(row.promotion_input_json);
  if (promotion?.repo && /\/(?:cleveland-park|finances|politics|personal|rams)(?:\/|$)/.test(promotion.repo)) return "domain_action";
  if (Number(row.promote ?? 0) === 1 || /\b(promot(?:e|ed|ion)|deploy|merge|sha|code|config|behavior|release)\b/.test(text)) return "changed_product_behavior";
  return "final_user_facing_deliverable";
}

function dispatchSourceKind(row: DispatchDoneRow, missing: boolean): SurfacedArtifactSourceKind {
  if (missing) return "dispatch_done";
  const text = [row.subject, row.result_json, row.promotion_result_json, row.promotion_input_json].filter(Boolean).join(" ").toLowerCase();
  if (Number(row.promote ?? 0) === 1 || /\b(promot(?:e|ed|ion)|merge[-_ ]?main)\b/.test(text)) return "promotion";
  if (/\b(verif(?:y|ied|ication)|smoke|test)\b/.test(text)) return "verification";
  return "dispatch_done";
}

function artifactWorkItemRef(row: ArtifactRow, project: string | null): string {
  const scope = project ?? row.tag ?? row.agent;
  return `work:${scope}:${artifactFamily(row.basename || row.title || row.artifact_id)}`;
}

function dispatchWorkItemRef(row: DispatchDoneRow, artifactPath: string | null, project: string | null): string {
  const promotion = parsePromotionInput(row.promotion_input_json);
  if (promotion?.branch) return `branch:${promotion.branch}`;
  if (project) return `project:${project}:${artifactFamily(artifactPath ? basename(artifactPath) : row.subject)}`;
  return `dispatch:${row.dispatch_phid}`;
}

function needForReason(reason: SurfacedArtifactRelevanceReason, status: SurfacedArtifactStatus): SurfacedArtifactNeed | undefined {
  if (reason === "blocked_or_stale") return status === "commented" ? "route" : "inspect_closeout";
  if (reason === "needs_decision" && status !== "approved") return "approve";
  if (reason === "final_user_facing_deliverable" || reason === "changed_product_behavior" || reason === "domain_action") return "read";
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

function withRank(row: Omit<SurfacedArtifactRow, "rank_score">): SurfacedArtifactRow {
  return { ...row, rank_score: rankScore(row) };
}

function rankScore(row: Pick<SurfacedArtifactRow, "relevance_reason" | "status" | "group_count">): number {
  const statusBoost = row.status === "unread" ? 20 : row.status === "commented" ? 15 : row.status === "routed" ? 5 : 0;
  return REASON_SCORE[row.relevance_reason] + statusBoost + Math.min(row.group_count ?? 1, 12);
}

function groupPrimaryRows(rawRows: SurfacedArtifactRow[]): SurfacedArtifactRow[] {
  const groups = new Map<string, SurfacedArtifactRow[]>();
  for (const row of rawRows) {
    const key = row.work_item_ref ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort(compareSurfacedRows);
    const primary = { ...sorted[0] };
    primary.id = rows.length > 1 ? `group:${key}` : primary.id;
    primary.work_item_ref = key;
    primary.group_count = rows.length;
    primary.grouped_source_kinds = [...new Set(rows.map((r) => r.source_kind))].sort();
    primary.created_at = minIso(rows.map((r) => r.created_at)) ?? primary.created_at;
    primary.updated_at = maxIso(rows.map((r) => r.updated_at)) ?? primary.updated_at;
    primary.rank_score = rankScore(primary) + Math.min(rows.length, 12);
    return primary;
  });
}

function compareSurfacedRows(a: SurfacedArtifactRow, b: SurfacedArtifactRow): number {
  return REASON_RANK[a.relevance_reason] - REASON_RANK[b.relevance_reason]
    || b.rank_score - a.rank_score
    || Date.parse(b.updated_at) - Date.parse(a.updated_at)
    || a.id.localeCompare(b.id);
}

function buildRecentFloodDiagnostic(
  rawRows: SurfacedArtifactRow[],
  groupedRows: SurfacedArtifactRow[],
  primaryRows: SurfacedArtifactRow[],
  limits: { rawLimit: number; primaryLimit: number },
): RecentFloodDiagnostic {
  const groups = new Map<string, SurfacedArtifactRow[]>();
  for (const row of rawRows) {
    const key = row.work_item_ref ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return {
    window_start: minIso(rawRows.map((r) => r.updated_at)) ?? "",
    window_end: maxIso(rawRows.map((r) => r.updated_at)) ?? "",
    source_data: {
      raw_limit: limits.rawLimit,
      primary_limit: limits.primaryLimit,
      raw_row_count: rawRows.length,
      primary_row_count: primaryRows.length,
      capped: rawRows.length >= limits.rawLimit || rawRows.length > primaryRows.length,
    },
    total_raw_count: rawRows.length,
    grouped_count: groupedRows.length,
    suppressed_from_primary_count: Math.max(0, rawRows.length - primaryRows.length),
    groups: [...groups.entries()].map(([work_item_ref, rows]) => {
      const sorted = [...rows].sort(compareSurfacedRows);
      const reason_counts: Record<string, number> = {};
      for (const row of rows) reason_counts[row.relevance_reason] = (reason_counts[row.relevance_reason] ?? 0) + 1;
      return {
        work_item_ref,
        title: sorted[0]?.title ?? work_item_ref,
        program_ref: sorted.find((r) => r.program_ref)?.program_ref,
        track_ref: sorted.find((r) => r.track_ref)?.track_ref,
        project_ref: sorted.find((r) => r.project_ref)?.project_ref,
        agent_names: [...new Set(rows.map((r) => r.agent_name).filter((v): v is string => Boolean(v)))].sort(),
        raw_count: rows.length,
        latest_update: maxIso(rows.map((r) => r.updated_at)) ?? sorted[0]?.updated_at ?? "",
        reason_counts,
      };
    }).sort((a, b) => Date.parse(b.latest_update) - Date.parse(a.latest_update)),
    raw_rows: [...rawRows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
  };
}

function artifactFamily(value: string | null | undefined): string {
  const stem = (basename(value ?? "untitled").replace(/\.[^.]+$/, "") || "untitled")
    .replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, "")
    .toLowerCase()
    .replace(/\b(closeout|verification|verified|promotion|promoted|retry|status|report|note|notes|handoff|final)\b/g, "")
    .replace(/-\d+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (stem || "untitled").replace(/\s+/g, "-");
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

function firstClean(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = cleanTitle(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function projectFromText(value: string | null | undefined): string | null {
  const s = value ?? "";
  const explicit = s.match(/\bproject:\s*`?([A-Za-z0-9_.-]+)`?/i)?.[1];
  if (explicit) return explicit.toLowerCase();
  if (/\bkapelle\b/i.test(s)) return "kapelle";
  if (/\btrinity\b/i.test(s)) return "trinity";
  for (const project of DOMAIN_PROJECTS) {
    if (new RegExp(`\\b${escapeRegExp(project)}\\b`, "i").test(s)) return project;
  }
  return null;
}

function programFromText(value: string | null | undefined): string | null {
  const s = value ?? "";
  if (/\bLocal-First Project\/Artifact Surfacing\b/i.test(s)) return "local-first-project-artifact-surfacing";
  const explicit = s.match(/\bprogram:\s*`?([^`\n]+?)`?\s*(?:\n|$)/i)?.[1];
  return slugify(explicit);
}

function trackFromText(value: string | null | undefined): string | null {
  return normalizeTrack((value ?? "").match(TRACK_RE)?.[0]);
}

function normalizeTrack(value: string | null | undefined): string | null {
  return (value ?? "").match(TRACK_RE)?.[0] ?? null;
}

function slugify(value: string | null | undefined): string | null {
  const s = cleanTitle(value);
  if (!s) return null;
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function subtitle(parts: Array<string | null | undefined>): string | undefined {
  return parts.map((p) => cleanTitle(p)).filter(Boolean).join(" / ") || undefined;
}

function sourceLabel(parts: Array<string | null | undefined>): string {
  return subtitle(parts) ?? "Artifact source";
}

function sourceProof(path: string | null | undefined, source: string, host: string | null | undefined): string {
  const prefix = host ? `${host}:` : "";
  return path ? `${source}:${prefix}${path}` : source;
}

function sourceTypeFromPath(input: {
  path?: string | null;
  mediaType?: string | null;
  title?: string | null;
  body?: string | null;
}): SurfacedArtifactSourceType {
  const media = (input.mediaType ?? "").toLowerCase();
  const ext = extname(input.path ?? "").toLowerCase();
  const haystack = [input.path, input.title, input.body?.slice(0, 2000)].filter(Boolean).join(" ").toLowerCase();
  if (media.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg"].includes(ext)) return "image";
  if (media === "application/pdf" || ext === ".pdf") return "pdf";
  if ([".eml", ".msg"].includes(ext) || /\b(email|mailbox|inbox|subject:|from:)\b/.test(haystack)) return "email";
  if (/\b(transcript|transcription|recording|call notes|meeting notes)\b/.test(haystack)) return "transcript";
  if ([".md", ".markdown", ".txt", ".json", ".html", ".htm"].includes(ext) || media.startsWith("text/") || media === "application/json") return "artifact";
  return "other";
}

function discoveredBy(source: ArtifactSource): SurfacedArtifactRow["visibility_proof"]["discovered_by"] {
  if (source === "agent-done") return "agent_done";
  if (source === "delivery-log") return "delivery_log";
  if (source === "filesystem") return "filesystem";
  return "manual_fixture";
}

function artifactDelivery(
  artifactId: string,
  input: {
    mediaType: string | null | undefined;
    freshness: ArtifactDeliveryFreshness;
    sourceHost: string | null | undefined;
    sourceMtime: string | null | undefined;
    contentHash: string | null | undefined;
    bodyCached: boolean;
    bodyAvailable: boolean;
    bodySource: SurfacedArtifactBodySource;
    bodyPreview: string | null | undefined;
  },
): SurfacedArtifactRow["delivery"] {
  const stableUrl = `/artifacts/${encodeURIComponent(artifactId)}/detail`;
  return {
    stable_url: stableUrl,
    copy_text_url: `/artifacts/${encodeURIComponent(artifactId)}/copy-text`,
    download_url: `/artifacts/${encodeURIComponent(artifactId)}/download`,
    media_type: normalizeDeliveryMediaType(input.mediaType),
    freshness: input.freshness,
    source_host: input.sourceHost ?? null,
    source_mtime: input.sourceMtime ?? null,
    content_hash: input.contentHash ?? null,
    body_cached: input.bodyCached,
    body_available: input.bodyAvailable,
    body_source: input.bodySource,
    body_preview: input.bodyPreview ?? null,
    open_url: stableUrl,
  };
}

function mediaTypeFromPathForDelivery(path: string | null | undefined): SurfacedArtifactRow["delivery"]["media_type"] {
  const ext = extname(path ?? "").toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".pdf") return "application/pdf";
  return "unknown";
}

function normalizeDeliveryMediaType(value: string | null | undefined): SurfacedArtifactRow["delivery"]["media_type"] {
  if (value === "text/markdown" || value === "text/html" || value === "text/plain" || value === "application/json" || value === "application/pdf") {
    return value;
  }
  return "unknown";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function minIso(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)));
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((v) => Date.parse(v)))).toISOString();
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)));
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((v) => Date.parse(v)))).toISOString();
}

function parsePromotionInput(json: string | null): { repo?: string; branch?: string; base?: string; remote?: string } | null {
  try {
    return json ? JSON.parse(json) as { repo?: string; branch?: string; base?: string; remote?: string } : null;
  } catch {
    return null;
  }
}

export function artifactIdForSurfacingPath(path: string): string {
  return artifactIdFromPath(path);
}
