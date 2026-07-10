import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { basename as pathBasename, extname } from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import { readArtifactByLiveSourceId } from "../dispatch-scheduler/read-model.js";
import { artifactRowToEntry } from "./entry-projection.js";
import { artifactDetailVisualState } from "./local-health.js";
import { listComments, listTimelineEvents } from "./ops.js";
import {
  artifactIdFromPath,
  countOperations,
  deriveStatus,
  getArtifact,
  getArtifactBodyCache,
  getArtifactDraft,
  getReviewState,
  listArtifactSourceEvidence,
  listOperations,
  parseDraftPayload,
} from "./storage.js";
import type {
  ArtifactAvailability,
  ArtifactCatalogRow,
  ArtifactDetailBody,
  ArtifactDetailRender,
  ArtifactDetailResponse,
  ArtifactReviewStateRow,
  OutputsInboxRow,
} from "./types.js";

const MAX_DETAIL_BODY_BYTES = 1_048_576;
const SUMMARY_LIMIT = 50;

export interface ArtifactDetailRef {
  artifactId: string;
  requestedRef: string;
  resolvedFrom: ArtifactDetailResponse["resolved_from"];
  decodedPath: string | null;
}

export function resolveArtifactDetailRef(ref: string): ArtifactDetailRef {
  const decoded = decodePathRef(ref);
  if (decoded) {
    return {
      artifactId: artifactIdFromPath(decoded),
      requestedRef: ref,
      resolvedFrom: decoded === ref ? "path" : "encoded_path",
      decodedPath: decoded,
    };
  }
  return { artifactId: ref, requestedRef: ref, resolvedFrom: "artifact_id", decodedPath: null };
}

export async function buildArtifactDetail(
  adapter: DbAdapter,
  ref: ArtifactDetailRef,
  nowIso = new Date().toISOString(),
  teamId = "default",
): Promise<ArtifactDetailResponse | null> {
  const [catalog, review, ops, operationsCount, comments, timeline, evidence, draftRow] = await Promise.all([
    getArtifact(adapter, ref.artifactId),
    getReviewState(adapter, ref.artifactId),
    listOperations(adapter, ref.artifactId, SUMMARY_LIMIT, 0),
    countOperations(adapter, ref.artifactId),
    listComments(adapter, ref.artifactId, SUMMARY_LIMIT, 0),
    listTimelineEvents(adapter, ref.artifactId, SUMMARY_LIMIT, 0),
    listArtifactSourceEvidence(adapter, ref.artifactId),
    getArtifactDraft(adapter, ref.artifactId),
  ]);
  const draft = parseDraftPayload(draftRow);
  let fallbackPath = ref.decodedPath;
  // query:<query_id>:<basename> / dispatch:<dispatch_phid> ids are synthesized
  // read-time by readArtifacts (GET /artifacts) from the queries/dispatch
  // tables and never written to the `artifacts` catalog table, so the direct
  // getArtifact lookup above always misses them. Without this fallback the
  // bulk list shows them as available while the single-artifact detail route
  // reports "unavailable" for the exact same id (2026-07-10 Spencer-demo bug).
  let liveSourceRow: Record<string, unknown> | null = null;
  if (!catalog && !fallbackPath) {
    liveSourceRow = await readArtifactByLiveSourceId(adapter, teamId, ref.artifactId).catch(() => null);
    if (liveSourceRow && typeof liveSourceRow.path === "string") {
      fallbackPath = liveSourceRow.path;
    }
  }
  if (!catalog && !review && !draft && !fallbackPath) return null;

  const syntheticCatalog =
    catalog ?? syntheticCatalogFromPath(ref.artifactId, fallbackPath, nowIso, liveSourceRow);
  const body = await readDetailBody(adapter, syntheticCatalog, draft);
  if (!catalog && !review && !draft && body.kind === "missing") return null;
  const render = renderMetadata(syntheticCatalog, body);
  const entry = syntheticCatalog ? artifactRowToEntry(syntheticCatalog, review, ops) : null;
  const displayTitle = humanDisplayTitle(catalog, draft, fallbackPath, ref.artifactId);
  const status = review ? deriveStatus(review) : "never_viewed";
  const latestTimeline = timeline[timeline.length - 1] ?? null;
  const latestComment = comments[comments.length - 1] ?? null;
  const availability = availabilityFromBody(body, syntheticCatalog);
  const stableUrl = `/artifacts/${encodeURIComponent(ref.artifactId)}/detail`;
  const copyTextUrl = `/artifacts/${encodeURIComponent(ref.artifactId)}/copy-text`;
  const downloadUrl = `/artifacts/${encodeURIComponent(ref.artifactId)}/download`;
  const bodyRenderable = body.text != null && ["markdown", "html", "text", "json"].includes(body.kind);
  const freshness = bodyRenderable ? "current" : body.kind === "missing" || body.kind === "unavailable" ? "body_unavailable" : "current";
  const localVisualState = artifactDetailVisualState({
    availability,
    body,
    catalogPresent: Boolean(catalog),
    status,
  });
  const versionKey = artifactDetailVersionKey({
    artifactId: ref.artifactId,
    catalog,
    review,
    body,
    operationsCount,
    comments,
    timeline,
    draftUpdatedAt: draftRow?.updated_at ?? null,
  });

  return {
    ok: true,
    schema_version: "artifact.detail.v1",
    generated_at: nowIso,
    version_key: versionKey,
    artifact_id: ref.artifactId,
    requested_ref: ref.requestedRef,
    resolved_from: ref.resolvedFrom,
    displayTitle,
    stableUrl,
    copyTextUrl,
    downloadUrl,
    metadata: {
      artifact_id: ref.artifactId,
      display_title: displayTitle,
      basename: syntheticCatalog?.basename ?? null,
      agent: syntheticCatalog?.agent ?? null,
      tag: syntheticCatalog?.tag ?? null,
      produced_at: syntheticCatalog?.produced_at ?? null,
      abs_path: syntheticCatalog?.abs_path ?? null,
      source: syntheticCatalog?.source ?? null,
      availability,
      media_type: syntheticCatalog?.media_type ?? null,
      content_hash: syntheticCatalog?.content_hash ?? null,
      source_mtime: syntheticCatalog?.source_mtime ?? null,
      source_size: syntheticCatalog?.source_size ?? null,
      project_ref: syntheticCatalog?.project_ref ?? null,
      dispatch_ref: syntheticCatalog?.dispatch_ref ?? null,
      source_host: syntheticCatalog?.source_host ?? null,
      source_badges: parseSourceBadges(syntheticCatalog?.source_badges),
      reconciled_at: syntheticCatalog?.reconciled_at ?? null,
      created_at: syntheticCatalog?.created_at ?? null,
      updated_at: syntheticCatalog?.updated_at ?? review?.updated_at ?? null,
      local_visual_state: localVisualState,
    },
    body,
    render,
    delivery: {
      artifactId: ref.artifactId,
      stableUrl,
      copyTextUrl,
      downloadUrl,
      sourcePath: syntheticCatalog?.abs_path ?? null,
      sourceStatus: availability,
      bodyRenderable,
      bodyPreview: body.text ? body.text.slice(0, 1200) : null,
      bodyUnavailable: !bodyRenderable,
      freshness,
      discoveredBy: discoveredBy(syntheticCatalog),
    },
    review: {
      state: review,
      status,
      operations_count: operationsCount,
      comments_count: comments.length,
      timeline_count: timeline.length,
      latest_comment: latestComment,
      latest_timeline_event: latestTimeline,
      is_viewed: !!review?.first_viewed_at,
      is_approved: !!review?.approved_at,
      is_rejected: !!review?.rejected_at,
      is_shipped: !!review?.shipped_at,
      is_ship_blocked: !!review?.ship_blockers_json && !review?.shipped_at,
    },
    comments,
    timeline,
    provenance: {
      entry,
      evidence,
    },
    draft,
  };
}

function artifactDetailVersionKey(input: {
  artifactId: string;
  catalog: ArtifactCatalogRow | null;
  review: ArtifactReviewStateRow | null;
  body: ArtifactDetailBody;
  operationsCount: number;
  comments: ArtifactDetailResponse["comments"];
  timeline: ArtifactDetailResponse["timeline"];
  draftUpdatedAt: string | null;
}): string {
  const latestComment = input.comments[input.comments.length - 1] ?? null;
  const latestTimeline = input.timeline[input.timeline.length - 1] ?? null;
  const payload = {
    artifact_id: input.artifactId,
    catalog_updated_at: input.catalog?.updated_at ?? null,
    review_updated_at: input.review?.updated_at ?? null,
    body_cache_version_key: input.body.cache?.version_key ?? null,
    body_cache_content_hash: input.body.cache?.content_hash ?? null,
    body_source: input.body.source,
    body_bytes: input.body.bytes,
    body_error: input.body.error,
    operations_count: input.operationsCount,
    comments_count: input.comments.length,
    latest_comment_id: latestComment?.comment_id ?? null,
    latest_comment_ts: latestComment?.ts ?? null,
    timeline_count: input.timeline.length,
    latest_timeline_id: latestTimeline?.event_id ?? null,
    latest_timeline_ts: latestTimeline?.ts ?? null,
    draft_updated_at: input.draftUpdatedAt,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function decodePathRef(ref: string): string | null {
  if (ref.startsWith("/")) return ref;
  const decodedComponent = safeDecodeURIComponent(ref);
  if (decodedComponent.startsWith("/")) return decodedComponent;
  for (const candidate of [ref, decodedComponent]) {
    const decoded = safeBase64UrlDecode(candidate);
    if (decoded?.startsWith("/")) return decoded;
  }
  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeBase64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length < 8) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function syntheticCatalogFromPath(
  artifactId: string,
  absPath: string | null,
  nowIso: string,
  liveSourceRow: Record<string, unknown> | null = null,
): ArtifactCatalogRow | null {
  if (!absPath) return null;
  if (liveSourceRow) {
    const producedAt =
      typeof liveSourceRow.completed_at === "string"
        ? liveSourceRow.completed_at
        : typeof liveSourceRow.modified_at === "string"
          ? liveSourceRow.modified_at
          : nowIso;
    // ArtifactCatalogRow.source is a closed literal union (reconciler / registration
    // provenance kinds); the live-source row's finer-grained origin (e.g.
    // "queries.result") doesn't fit it, so it goes in source_badges below instead.
    const liveSourceBadge =
      (liveSourceRow.source_metadata as { source?: string } | undefined)?.source ?? "live-source";
    return {
      artifact_id: artifactId,
      basename: typeof liveSourceRow.basename === "string" ? liveSourceRow.basename : pathBasename(absPath),
      agent: typeof liveSourceRow.agent === "string" ? liveSourceRow.agent : "unknown",
      tag: null,
      abs_path: absPath,
      title: typeof liveSourceRow.title === "string" ? liveSourceRow.title : null,
      produced_at: producedAt,
      source: "filesystem",
      availability: "present",
      media_type: null,
      content_hash: null,
      source_mtime: null,
      source_size: typeof liveSourceRow.size_bytes === "number" ? liveSourceRow.size_bytes : null,
      project_ref: null,
      dispatch_ref: typeof liveSourceRow.dispatch_id === "string" ? liveSourceRow.dispatch_id : null,
      source_host: null,
      source_badges: JSON.stringify([liveSourceBadge]),
      reconciled_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
  }
  return {
    artifact_id: artifactId,
    basename: pathBasename(absPath),
    agent: "unknown",
    tag: null,
    abs_path: absPath,
    title: null,
    produced_at: nowIso,
    source: "filesystem",
    availability: "unknown",
    media_type: null,
    content_hash: null,
    source_mtime: null,
    source_size: null,
    project_ref: null,
    dispatch_ref: null,
    source_host: null,
    source_badges: JSON.stringify(["filesystem"]),
    reconciled_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

async function readDetailBody(
  adapter: DbAdapter,
  catalog: ArtifactCatalogRow | null,
  draft: ReturnType<typeof parseDraftPayload>,
): Promise<ArtifactDetailBody> {
  if (draft) {
    return {
      kind: "markdown",
      text: draft.body_markdown,
      bytes: Buffer.byteLength(draft.body_markdown, "utf8"),
      truncated: false,
      source: "cane_draft",
      error: null,
      body_unavailable: false,
      cache: null,
    };
  }
  if (!catalog?.abs_path) {
    return { kind: "unavailable", text: null, bytes: null, truncated: false, source: "none", error: null, body_unavailable: true, cache: null };
  }
  let fileReadError: string | null = null;
  try {
    const stat = await fsp.stat(catalog.abs_path);
    if (!stat.isFile()) {
      return { kind: "unavailable", text: null, bytes: stat.size, truncated: false, source: "file", error: "not_file", body_unavailable: true, cache: null };
    }
    const ext = extname(catalog.abs_path).toLowerCase();
    const kind = bodyKindFromExtension(ext);
    if (kind === "image" || kind === "binary") {
      return { kind, text: null, bytes: stat.size, truncated: false, source: "file", error: null, body_unavailable: true, cache: null };
    }
    const handle = await fsp.open(catalog.abs_path, "r");
    try {
      const size = Math.min(stat.size, MAX_DETAIL_BODY_BYTES);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return {
        kind,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        bytes: stat.size,
        truncated: stat.size > MAX_DETAIL_BODY_BYTES,
        source: "file",
        error: null,
        body_unavailable: false,
        cache: null,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "read_failed";
    fileReadError = code;
  }
  const cached = await getArtifactBodyCache(adapter, catalog.artifact_id).catch(() => null);
  if (cached?.body_text != null) {
    return {
      kind: bodyKindFromMediaType(cached.media_type),
      text: cached.body_text,
      bytes: cached.source_size,
      truncated: cached.body_truncated === 1,
      source: "artifact_body_cache",
      error: fileReadError ?? cached.body_error,
      body_unavailable: false,
      cache: {
        content_hash: cached.content_hash,
        version_key: cached.version_key,
        cached_at: cached.cached_at,
        freshness: cached.version_key ? "current" : "unversioned",
      },
    };
  }
  return { kind: "missing", text: null, bytes: null, truncated: false, source: "file", error: fileReadError ?? "read_failed", body_unavailable: true, cache: null };
}

function bodyKindFromExtension(ext: string): ArtifactDetailBody["kind"] {
  if ([".md", ".markdown", ".mdx"].includes(ext)) return "markdown";
  if ([".html", ".htm"].includes(ext)) return "html";
  if (ext === ".json") return "json";
  if ([".txt", ".log", ".csv", ".tsv", ".yaml", ".yml"].includes(ext)) return "text";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  return "binary";
}

function bodyKindFromMediaType(mediaType: string): ArtifactDetailBody["kind"] {
  if (mediaType === "text/markdown") return "markdown";
  if (mediaType === "text/html") return "html";
  if (mediaType === "application/json") return "json";
  if (mediaType === "text/plain") return "text";
  return "unavailable";
}

function renderMetadata(catalog: ArtifactCatalogRow | null, body: ArtifactDetailBody): ArtifactDetailRender {
  const filename = catalog?.basename ?? null;
  switch (body.kind) {
    case "markdown":
      return { renderer: "markdown", mime_type: "text/markdown; charset=utf-8", filename };
    case "html":
      return { renderer: "html", mime_type: "text/html; charset=utf-8", filename };
    case "json":
      return { renderer: "json", mime_type: "application/json; charset=utf-8", filename };
    case "text":
      return { renderer: "text", mime_type: "text/plain; charset=utf-8", filename };
    case "image":
      return { renderer: "image", mime_type: mimeFromExtension(filename), filename };
    case "binary":
      return { renderer: "download", mime_type: "application/octet-stream", filename };
    default:
      return { renderer: "empty", mime_type: "application/octet-stream", filename };
  }
}

function mimeFromExtension(filename: string | null): string {
  const ext = extname(filename ?? "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function humanDisplayTitle(
  catalog: ArtifactCatalogRow | null,
  draft: ReturnType<typeof parseDraftPayload>,
  fallbackPath: string | null,
  artifactId: string,
): string {
  return catalog?.title || draft?.subject || catalog?.basename || (fallbackPath ? pathBasename(fallbackPath) : artifactId);
}

function parseSourceBadges(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function availabilityFromBody(
  body: ArtifactDetailBody,
  catalog: ArtifactCatalogRow | null,
): ArtifactAvailability {
  if (body.kind === "missing") return "missing";
  if (body.source === "artifact_body_cache" && isMissingSourceError(body.error)) return "missing";
  if (catalog) return catalog.availability;
  if (body.source === "file") return "present";
  return "unknown";
}

function isMissingSourceError(error: string | null): boolean {
  return error === "ENOENT" || error === "ENOTDIR";
}

function discoveredBy(catalog: ArtifactCatalogRow | null): "agent_done" | "artifact_register" | "filesystem_reconcile" | "manual_fixture" {
  if (catalog?.source === "agent-done") return "agent_done";
  if (catalog?.source === "filesystem") return "filesystem_reconcile";
  if (catalog?.source === "manual") return "manual_fixture";
  return "artifact_register";
}
