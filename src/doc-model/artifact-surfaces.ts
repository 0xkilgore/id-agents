// Doc-model substrate slice 2 — the console's five surfaces, projected from
// the artifact-document op log via Maestra's stamping convention
// (audience/kind). Every surface returns the SAME `ArtifactEntry` /
// `ReadModelEnvelope` shape the legacy filesystem-projected route already
// emits (see outputs/entry-projection.ts, outputs/entry.ts) — a console
// coded against that shape does not change when a surface's source flips
// from a static JSON snapshot to these live routes.
//
// Now       — audience:operator action rows plus Chris feedback blockers, still open.
// Inbox     — documents whose latest op is an incoming comment awaiting disposition.
// Activity  — receipt ops across all documents, reverse-chron.
// Projects  — documents grouped by project, file-system-like listing.
// Reports   — audience:operator + report/final/evidence kind, reverse-chron.
// System    — audience:system, reverse-chron.

import type { DbAdapter } from "../db/db-adapter.js";
import type { ArtifactEntry, EntryStamp, EntryStampAudience, EntryStampKind, ReadModelEnvelope } from "../outputs/entry.js";
import {
  artifactDocumentToEntry,
  listArtifactDocumentIds,
  projectArtifactDocument,
  type ArtifactDocumentReceiptKind,
} from "./artifact-document.js";

interface SurfaceAdmission {
  source: "stamp" | "comment_thread" | "receipt_log" | "project_group";
  audience: EntryStampAudience | "any";
  kinds: EntryStampKind[] | "any";
  reason: string;
}

function envelope<T>(items: T[], projection: string, admission: SurfaceAdmission): ReadModelEnvelope<T> {
  return {
    schema_version: "read-model.v1",
    generated_at: new Date().toISOString(),
    items,
    count: items.length,
    limit: items.length,
    offset: 0,
    source: { read_path: "substrate", projection },
    admission,
    parity: { status: "unchecked" },
  };
}

const NOW_KINDS: EntryStampKind[] = ["action-needed", "direction-brief"];
const REPORT_KINDS: EntryStampKind[] = ["report", "final-document", "closeout", "qa-evidence"];

export type NowSurfaceReceiptState = "unreceipted" | "receipted";
export type NowSurfaceRouteState = "awaiting_response" | "action_open";
export type NowSurfaceSourceLinkState = "present" | "missing" | "unsafe";

export interface NowSurfaceState {
  blocker_kind: "artifact_action" | "feedback_blocker";
  source_link: string | null;
  source_link_state: NowSurfaceSourceLinkState;
  route_state: NowSurfaceRouteState;
  receipt_state: NowSurfaceReceiptState;
  latest_comment: { op_id: number; actor: string; ts: string; body: string } | null;
  latest_receipt: { op_id: number; actor: string; ts: string; kind: ArtifactDocumentReceiptKind; note: string | null } | null;
}

export type NowSurfaceEntry = ArtifactEntry & { now_state: NowSurfaceState };

export function admitsNowSurface(stamp: EntryStamp | null | undefined): boolean {
  return stamp?.audience === "operator" && NOW_KINDS.includes(stamp.kind);
}

export function admitsReportsSurface(stamp: EntryStamp | null | undefined): boolean {
  return stamp?.audience === "operator" && REPORT_KINDS.includes(stamp.kind);
}

export function admitsSystemSurface(stamp: EntryStamp | null | undefined): boolean {
  return stamp?.audience === "system" && typeof stamp.kind === "string" && stamp.kind.length > 0;
}

async function projectAll(adapter: DbAdapter, documentIds: string[]): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = [];
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (projection) entries.push(artifactDocumentToEntry(projection));
  }
  return entries;
}

/** Now — action rows and Chris feedback blockers for the operator, not system receipts/artifacts. */
export async function projectNowSurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<NowSurfaceEntry>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, {
    audience: "operator",
    order: "asc",
  });
  const open: NowSurfaceEntry[] = [];
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (!projection) continue;
    const latestComment = projection.comments[projection.comments.length - 1] ?? null;
    const latestReceipt = projection.receipts[projection.receipts.length - 1] ?? null;
    const receiptAfterLatestComment = !!latestComment && !!latestReceipt && latestReceipt.op_id > latestComment.op_id;
    const isFeedbackBlocker =
      !!latestComment &&
      !receiptAfterLatestComment &&
      isChrisFeedbackActor(latestComment.actor);
    if (admitsNowSurface(projection.stamp) && projection.receipts.length === 0) {
      open.push(withNowState(projection, {
        blocker_kind: "artifact_action",
        route_state: "action_open",
        latest_comment: latestComment,
        latest_receipt: latestReceipt,
      }));
    } else if (isFeedbackBlocker) {
      open.push(withNowState(projection, {
        blocker_kind: "feedback_blocker",
        route_state: "awaiting_response",
        latest_comment: latestComment,
        latest_receipt: latestReceipt,
      }));
    }
  }
  return envelope(open, "doc_model_now", {
    source: "comment_thread",
    audience: "operator",
    kinds: NOW_KINDS,
    reason: "operator action-needed/direction-brief rows with no receipt, plus Chris feedback comments awaiting a later receipt",
  });
}

function withNowState(
  projection: Awaited<ReturnType<typeof projectArtifactDocument>> & {},
  state: Pick<NowSurfaceState, "blocker_kind" | "route_state" | "latest_comment" | "latest_receipt">,
): NowSurfaceEntry {
  const sourceLink = projection.frontmatter.source_link;
  return {
    ...artifactDocumentToEntry(projection),
    now_state: {
      ...state,
      source_link: sourceLink,
      source_link_state: sourceLinkState(sourceLink),
      receipt_state: state.latest_receipt ? "receipted" : "unreceipted",
    },
  };
}

function isChrisFeedbackActor(actor: string): boolean {
  return /^(human:)?chris$/i.test(actor.trim());
}

function sourceLinkState(sourceLink: string | null): NowSurfaceSourceLinkState {
  if (!sourceLink || sourceLink.trim() === "") return "missing";
  const href = sourceLink.trim();
  if (href.startsWith("file://") || href.startsWith("/Users/") || href.startsWith("/home/") || href.startsWith("/tmp/")) {
    return "unsafe";
  }
  return "present";
}

export interface InboxSurfaceEntry {
  entry: ArtifactEntry;
  disposition: "awaiting_response";
  latest_comment: { op_id: number; actor: string; ts: string; body: string };
}

/**
 * Inbox — documents whose latest activity is an incoming comment with no
 * receipt after it. v0: every such row is "awaiting_response" — there is no
 * real routing/triage classifier here yet (that lives in task-comments'
 * routing_status for the task domain; artifacts don't have an equivalent
 * router). Kept honest rather than invented.
 */
export async function projectInboxSurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<InboxSurfaceEntry>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, { audience: "operator", order: "desc" });
  const rows: InboxSurfaceEntry[] = [];
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (!projection || projection.comments.length === 0) continue;
    const latestComment = projection.comments[projection.comments.length - 1];
    const latestReceipt = projection.receipts[projection.receipts.length - 1];
    const awaitingResponse = !latestReceipt || latestReceipt.op_id < latestComment.op_id;
    if (!awaitingResponse) continue;
    rows.push({
      entry: artifactDocumentToEntry(projection),
      disposition: "awaiting_response",
      latest_comment: latestComment,
    });
  }
  return envelope(rows, "doc_model_inbox", {
    source: "comment_thread",
    audience: "operator",
    kinds: "any",
    reason: "operator audience document whose latest comment has no later receipt",
  });
}

export interface ActivitySurfaceEntry {
  document_id: string;
  title: string;
  op_id: number;
  actor: string;
  ts: string;
  receipt_kind: ArtifactDocumentReceiptKind;
  note: string | null;
}

/** Activity — receipt ops (approve/reject/ship_attempted/ship_blocked) across all documents, newest first. */
export async function projectActivitySurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<ActivitySurfaceEntry>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, { order: "desc" });
  const rows: ActivitySurfaceEntry[] = [];
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (!projection) continue;
    for (const receipt of projection.receipts) {
      rows.push({
        document_id: projection.document_id,
        title: projection.frontmatter.title,
        op_id: receipt.op_id,
        actor: receipt.actor,
        ts: receipt.ts,
        receipt_kind: receipt.kind,
        note: receipt.note,
      });
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.op_id - a.op_id));
  return envelope(rows, "doc_model_activity", {
    source: "receipt_log",
    audience: "any",
    kinds: "any",
    reason: "receipt operations across artifact documents",
  });
}

export interface ProjectGroup {
  project: string;
  documents: ProjectDocumentSummary[];
}

export interface ProjectDocumentSummary {
  document_id: string;
  stable_id: string;
  title: string;
  kind: string;
  project: string;
  updated_at: string;
  open: {
    href: string;
    target: "doc_model_artifact";
    artifact_id: string;
    recoverable: boolean;
  };
  source_path: string | null;
  source_proof: "artifact_registry" | "document_source_link" | "missing";
  freshness: {
    status: "fresh" | "missing" | "unknown" | "error";
    checked_at: string;
  };
  body: {
    available: boolean;
    status: "available" | "missing";
    source: "doc_model_op_log";
  };
  cache: {
    available: boolean;
    status: "available" | "missing" | "error";
    source: "artifact_body_cache" | "none";
    error: string | null;
  };
}

/** Projects — operator-facing documents grouped by project, newest first within each group. */
export async function projectProjectsSurface(
  adapter: DbAdapter,
  teamId: string,
  opts: { includeSystem?: boolean } = {},
): Promise<ReadModelEnvelope<ProjectGroup>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, { order: "desc" });
  const registry = await loadProjectDocumentRegistry(adapter, documentIds);
  const generatedAt = new Date().toISOString();
  const groups = new Map<string, ProjectGroup>();
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (!projection) continue;
    if (!opts.includeSystem && projection.stamp.audience === "system") continue;
    const key = projection.project ?? "(unassigned)";
    const group = groups.get(key) ?? { project: key, documents: [] };
    group.documents.push(projectDocumentSummary(projection, key, registry.get(projection.document_id) ?? null, generatedAt));
    groups.set(key, group);
  }
  const items = [...groups.values()].sort((a, b) => a.project.localeCompare(b.project));
  return envelope(items, "doc_model_projects", {
    source: "project_group",
    audience: opts.includeSystem ? "any" : "operator",
    kinds: "any",
    reason: opts.includeSystem
      ? "artifact documents grouped by project metadata"
      : "operator-facing artifact documents grouped by project metadata; system rows remain on System unless include_system=true",
  });
}

interface ProjectDocumentRegistryRow {
  artifact_id: string;
  abs_path: string;
  availability: string;
  body_text: string | null;
  body_error: string | null;
}

async function loadProjectDocumentRegistry(
  adapter: DbAdapter,
  documentIds: string[],
): Promise<Map<string, ProjectDocumentRegistryRow>> {
  if (documentIds.length === 0) return new Map();
  const params = documentIds;
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  try {
    const { rows } = await adapter.query<ProjectDocumentRegistryRow>(
      `SELECT a.artifact_id, a.abs_path, a.availability, b.body_text, b.body_error
         FROM artifacts a
    LEFT JOIN artifact_bodies b ON b.artifact_id = a.artifact_id
        WHERE a.artifact_id IN (${placeholders})`,
      params,
    );
    return new Map(rows.map((row) => [row.artifact_id, row]));
  } catch {
    return new Map();
  }
}

function projectDocumentSummary(
  projection: Awaited<ReturnType<typeof projectArtifactDocument>> & {},
  project: string,
  registry: ProjectDocumentRegistryRow | null,
  generatedAt: string,
): ProjectDocumentSummary {
  const fallbackSourcePath = sourcePathFromSourceLink(projection.frontmatter.source_link);
  const bodyAvailable = projection.content.trim().length > 0;
  const cacheAvailable = !!registry?.body_text && !registry.body_error;
  const recoverable = bodyAvailable || cacheAvailable;
  return {
    document_id: projection.document_id,
    stable_id: projection.document_id,
    title: projection.frontmatter.title,
    kind: projection.stamp.kind,
    project,
    updated_at: projection.updated_at,
    open: {
      href: `/doc-model/artifacts/${encodeURIComponent(projection.document_id)}`,
      target: "doc_model_artifact",
      artifact_id: projection.document_id,
      recoverable,
    },
    source_path: registry?.abs_path ?? fallbackSourcePath,
    source_proof: registry?.abs_path ? "artifact_registry" : fallbackSourcePath ? "document_source_link" : "missing",
    freshness: {
      status: freshnessStatus(registry?.availability ?? projection.frontmatter.availability, registry?.body_error ?? null),
      checked_at: generatedAt,
    },
    body: {
      available: bodyAvailable,
      status: bodyAvailable ? "available" : "missing",
      source: "doc_model_op_log",
    },
    cache: {
      available: cacheAvailable,
      status: cacheStatus(registry),
      source: registry ? "artifact_body_cache" : "none",
      error: registry?.body_error ?? null,
    },
  };
}

function sourcePathFromSourceLink(sourceLink: string | null): string | null {
  if (!sourceLink) return null;
  const trimmed = sourceLink.trim();
  return trimmed.startsWith("/") ? trimmed : null;
}

function freshnessStatus(
  availability: string | null | undefined,
  bodyError: string | null,
): ProjectDocumentSummary["freshness"]["status"] {
  if (bodyError) return "error";
  if (availability === "present") return "fresh";
  if (availability === "missing") return "missing";
  return "unknown";
}

function cacheStatus(registry: ProjectDocumentRegistryRow | null): ProjectDocumentSummary["cache"]["status"] {
  if (!registry) return "missing";
  if (registry.body_error) return "error";
  return registry.body_text ? "available" : "missing";
}

/** Reports — operator report/evidence artifacts, reverse-chron by updated_at. */
export async function projectReportsSurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<ArtifactEntry>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, {
    audience: "operator",
    order: "desc",
  });
  const items = (await projectAll(adapter, documentIds)).filter((entry) => admitsReportsSurface(entry.stamp));
  return envelope(items, "doc_model_reports", {
    source: "stamp",
    audience: "operator",
    kinds: REPORT_KINDS,
    reason: "operator audience with report, final-document, closeout, or qa-evidence kind",
  });
}

/** System — system-facing artifacts, reverse-chron by updated_at. */
export async function projectSystemSurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<ArtifactEntry>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, {
    audience: "system",
    order: "desc",
  });
  const items = (await projectAll(adapter, documentIds)).filter((entry) => admitsSystemSurface(entry.stamp));
  return envelope(items, "doc_model_system", {
    source: "stamp",
    audience: "system",
    kinds: "any",
    reason: "system audience with a non-empty kind",
  });
}
