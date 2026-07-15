// Doc-model substrate slice 2 — the console's five surfaces, projected from
// the artifact-document op log via Maestra's stamping convention
// (audience/kind). Every surface returns the SAME `ArtifactEntry` /
// `ReadModelEnvelope` shape the legacy filesystem-projected route already
// emits (see outputs/entry-projection.ts, outputs/entry.ts) — a console
// coded against that shape does not change when a surface's source flips
// from a static JSON snapshot to these live routes.
//
// Now       — audience:operator + action-oriented kind, still open (no receipt yet).
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

/** Now — action-oriented items for the operator that have not been receipted yet. */
export async function projectNowSurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<ArtifactEntry>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, {
    audience: "operator",
    order: "asc",
  });
  const open: ArtifactEntry[] = [];
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (projection && admitsNowSurface(projection.stamp) && projection.receipts.length === 0) {
      open.push(artifactDocumentToEntry(projection));
    }
  }
  return envelope(open, "doc_model_now", {
    source: "stamp",
    audience: "operator",
    kinds: NOW_KINDS,
    reason: "operator audience with action-needed or direction-brief kind and no receipt",
  });
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
  documents: Array<{ document_id: string; title: string; kind: string; updated_at: string }>;
}

/** Projects — every document grouped by project, file-system-like listing. Unassigned documents group under "(unassigned)". */
export async function projectProjectsSurface(
  adapter: DbAdapter,
  teamId: string,
): Promise<ReadModelEnvelope<ProjectGroup>> {
  const documentIds = await listArtifactDocumentIds(adapter, teamId, { order: "asc" });
  const groups = new Map<string, ProjectGroup>();
  for (const documentId of documentIds) {
    const projection = await projectArtifactDocument(adapter, documentId);
    if (!projection) continue;
    const key = projection.project ?? "(unassigned)";
    const group = groups.get(key) ?? { project: key, documents: [] };
    group.documents.push({
      document_id: projection.document_id,
      title: projection.frontmatter.title,
      kind: projection.stamp.kind,
      updated_at: projection.updated_at,
    });
    groups.set(key, group);
  }
  const items = [...groups.values()].sort((a, b) => a.project.localeCompare(b.project));
  return envelope(items, "doc_model_projects", {
    source: "project_group",
    audience: "any",
    kinds: "any",
    reason: "artifact documents grouped by project metadata",
  });
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
