// ARTIFACTS substrate proof-cut — Step 1: pure entry projection.
//
// artifactRowToEntry() maps the existing substrate rows
//   artifacts (catalog) + artifact_review_state + artifact_operations (op log)
// into the canonical DV1 ArtifactEntry (with DV2 provenance from the op log).
// Pure + deterministic — no I/O, no clock — so it is unit-tested directly and
// the read route stays a thin SQL→projection adapter.

import type { ArtifactCatalogRow, ArtifactOpRow, ArtifactReviewStateRow } from "./types.js";
import type { ActorRef, ArtifactEntry, ArtifactProvenance } from "./entry.js";

/** Parse a stored actor string ("user:chris", "agent:roger", "system", "regina",
 *  "operator") into a DV2 ActorRef. Unprefixed operator → user; bare names are
 *  treated as agents (the common op-log actor). */
export function parseActorRef(raw: string | null | undefined): ActorRef {
  const value = (raw ?? "").trim();
  if (!value) return { type: "system", id: "system" };
  const colon = value.indexOf(":");
  if (colon > 0) {
    const prefix = value.slice(0, colon).toLowerCase();
    const id = value.slice(colon + 1) || value;
    if (prefix === "user") return { type: "user", id };
    if (prefix === "agent") return { type: "agent", id };
    if (prefix === "system") return { type: "system", id };
    if (prefix === "service") return { type: "service", id };
  }
  if (value === "system") return { type: "system", id: "system" };
  if (value === "operator") return { type: "user", id: "operator" };
  return { type: "agent", id: value };
}

/** Derive a project slug from an absolute artifact path. Recognizes the two
 *  canonical roots (Dropbox/Code/<project>/… and Dropbox/Obsidian/…). */
export function projectFromPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const code = absPath.match(/\/Dropbox\/Code\/([^/]+)\//);
  if (code) return code[1];
  if (/\/Dropbox\/Obsidian\//.test(absPath)) return "obsidian";
  return null;
}

/** Best-effort revision note for an op-log row: prefer a `note` in the JSON
 *  payload, else fall back to the op type. */
function revisionNote(op: ArtifactOpRow): string | null {
  if (op.payload_json) {
    try {
      const parsed = JSON.parse(op.payload_json) as { note?: unknown };
      if (typeof parsed.note === "string" && parsed.note.trim()) return parsed.note.trim();
    } catch {
      /* non-JSON payload — fall through to op_type */
    }
  }
  return op.op_type;
}

/** Build the DV2 provenance projection from the op log (ascending by op_id). */
export function provenanceFromOps(ops: ArtifactOpRow[]): ArtifactProvenance {
  const ordered = [...ops].sort((a, b) => a.op_id - b.op_id);
  const revisions = ordered.map((op) => ({
    at: op.ts,
    by: parseActorRef(op.actor),
    note: revisionNote(op),
  }));
  const contributors: ActorRef[] = [];
  const seen = new Set<string>();
  for (const rev of revisions) {
    const key = `${rev.by.type}:${rev.by.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      contributors.push(rev.by);
    }
  }
  return {
    source_dispatch_phid: null,
    produced_by: [],
    derived_from: [],
    references: [],
    revisions,
    contributors,
  };
}

/**
 * Project a catalog row (+ optional review state + op log) into an ArtifactEntry.
 * Catalog-driven: `catalog` is the canonical row; `review` and `ops` enrich it.
 */
export function artifactRowToEntry(
  catalog: ArtifactCatalogRow,
  review: ArtifactReviewStateRow | null,
  ops: ArtifactOpRow[],
): ArtifactEntry {
  const createdBy = parseActorRef(catalog.agent);
  const provenance = provenanceFromOps(ops);
  const updatedAt = review?.updated_at ?? catalog.produced_at;
  // Most-recent op actor, else the producing agent, drives updated_by.
  const lastRevision = provenance.revisions[provenance.revisions.length - 1];
  const updatedBy = lastRevision?.by ?? createdBy;

  return {
    phid: catalog.artifact_id,
    kind: "artifact",
    schema_version: 1,
    title: catalog.title ?? catalog.basename ?? catalog.artifact_id,
    body_markdown: "",
    display_id: catalog.basename ?? null,
    artifact_kind: catalog.tag ?? "artifact",
    project: projectFromPath(catalog.abs_path),
    path: catalog.abs_path ?? null,
    source_dispatch_phid: provenance.source_dispatch_phid,
    produced_by_agent: catalog.agent ?? null,
    links: [],
    created_at: catalog.produced_at,
    created_by: createdBy,
    updated_at: updatedAt,
    updated_by: updatedBy,
    provenance,
  };
}
