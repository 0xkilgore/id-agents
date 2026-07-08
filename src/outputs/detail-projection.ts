import { promises as fsp } from "node:fs";
import { basename as pathBasename, extname } from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import { artifactRowToEntry } from "./entry-projection.js";
import { artifactDetailVisualState } from "./local-health.js";
import { listComments, listTimelineEvents } from "./ops.js";
import {
  artifactIdFromPath,
  countOperations,
  deriveStatus,
  getArtifact,
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
  const fallbackPath = ref.decodedPath;
  if (!catalog && !review && !draft && !fallbackPath) return null;

  const syntheticCatalog = catalog ?? syntheticCatalogFromPath(ref.artifactId, fallbackPath, nowIso);
  const body = await readDetailBody(syntheticCatalog, draft);
  if (!catalog && !review && !draft && body.kind === "missing") return null;
  const render = renderMetadata(syntheticCatalog, body);
  const entry = syntheticCatalog ? artifactRowToEntry(syntheticCatalog, review, ops) : null;
  const displayTitle = humanDisplayTitle(catalog, draft, fallbackPath, ref.artifactId);
  const status = review ? deriveStatus(review) : "never_viewed";
  const latestTimeline = timeline[timeline.length - 1] ?? null;
  const latestComment = comments[comments.length - 1] ?? null;
  const availability = syntheticCatalog?.availability ?? availabilityFromBody(body, catalog);
  const localVisualState = artifactDetailVisualState({
    availability,
    body,
    catalogPresent: Boolean(catalog),
    status,
  });

  return {
    ok: true,
    schema_version: "artifact.detail.v1",
    generated_at: nowIso,
    artifact_id: ref.artifactId,
    requested_ref: ref.requestedRef,
    resolved_from: ref.resolvedFrom,
    displayTitle,
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
      mtime_ms: syntheticCatalog?.mtime_ms ?? null,
      project: syntheticCatalog?.project ?? null,
      dispatch_id: syntheticCatalog?.dispatch_id ?? null,
      registered_at: syntheticCatalog?.registered_at ?? null,
      body_unavailable: syntheticCatalog?.body_unavailable ?? null,
      source_badges: parseSourceBadges(syntheticCatalog?.source_badges),
      reconciled_at: syntheticCatalog?.reconciled_at ?? null,
      created_at: syntheticCatalog?.created_at ?? null,
      updated_at: syntheticCatalog?.updated_at ?? review?.updated_at ?? null,
      local_visual_state: localVisualState,
    },
    body,
    render,
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

function syntheticCatalogFromPath(
  artifactId: string,
  absPath: string | null,
  nowIso: string,
): ArtifactCatalogRow | null {
  if (!absPath) return null;
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
    source_badges: JSON.stringify(["filesystem"]),
    reconciled_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

async function readDetailBody(
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
    };
  }
  if (!catalog?.abs_path) {
    return { kind: "unavailable", text: null, bytes: null, truncated: false, source: "none", error: null };
  }
  const cachedBody = catalog.cached_body;
  try {
    const stat = await fsp.stat(catalog.abs_path);
    if (!stat.isFile()) {
      if (cachedBody != null) return cachedDetailBody(catalog, "not_file");
      return { kind: "unavailable", text: null, bytes: stat.size, truncated: false, source: "file", error: "not_file" };
    }
    const ext = extname(catalog.abs_path).toLowerCase();
    const kind = bodyKindFromExtension(ext);
    if (kind === "image" || kind === "binary") {
      return { kind, text: null, bytes: stat.size, truncated: false, source: "file", error: null };
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
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (cachedBody != null) {
      const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "read_failed";
      return cachedDetailBody(catalog, code);
    }
    const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "read_failed";
    return { kind: catalog.body_unavailable ? "unavailable" : "missing", text: null, bytes: null, truncated: false, source: "file", error: catalog.body_unavailable ?? code };
  }
}

function bodyKindFromExtension(ext: string): ArtifactDetailBody["kind"] {
  if ([".md", ".markdown", ".mdx"].includes(ext)) return "markdown";
  if ([".html", ".htm"].includes(ext)) return "html";
  if (ext === ".json") return "json";
  if ([".txt", ".log", ".csv", ".tsv", ".yaml", ".yml"].includes(ext)) return "text";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  return "binary";
}

function cachedDetailBody(catalog: ArtifactCatalogRow, error: string): ArtifactDetailBody {
  const text = catalog.cached_body ?? "";
  return {
    kind: bodyKindFromExtension(extname(catalog.abs_path).toLowerCase()),
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: false,
    source: "file",
    error: `cached_after_${error}`,
  };
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
  if (catalog) return catalog.availability;
  if (body.kind === "missing") return "missing";
  if (body.source === "file") return "present";
  return "unknown";
}
