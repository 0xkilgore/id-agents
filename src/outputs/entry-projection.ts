// ARTIFACTS substrate proof-cut — Step 1: pure entry projection.
//
// artifactRowToEntry() maps the existing substrate rows
//   artifacts (catalog) + artifact_review_state + artifact_operations (op log)
// into the canonical DV1 ArtifactEntry (with DV2 provenance from the op log).
// Pure + deterministic — no I/O, no clock — so it is unit-tested directly and
// the read route stays a thin SQL→projection adapter.

import type { ArtifactCatalogRow, ArtifactOpRow, ArtifactReviewStateRow } from "./types.js";
import type { ActorRef, ArtifactEntry, ArtifactProvenance } from "./entry.js";
import {
  buildProvenanceFromOpLog,
  finalizeEntryProvenance,
  parseActorRef,
} from "../doc-model/provenance.js";
import { artifactListVisualState } from "./local-health.js";

export { parseActorRef };

/** Derive a project slug from an absolute artifact path. Recognizes the two
 *  canonical roots (Dropbox/Code/<project>/… and Dropbox/Obsidian/…). */
export function projectFromPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const code = absPath.match(/\/Dropbox\/Code\/([^/]+)\//);
  if (code) return code[1];
  if (/\/Dropbox\/Obsidian\//.test(absPath)) return "obsidian";
  return null;
}

/** Build the DV2 provenance projection from the op log (ascending by op_id). */
export function provenanceFromOps(
  ops: ArtifactOpRow[],
  seed: { abs_path?: string | null; agent?: string | null } = {},
): ArtifactProvenance {
  const createdBy = seed.agent ? parseActorRef(seed.agent) : null;
  const base = finalizeEntryProvenance(
    buildProvenanceFromOpLog(ops, {
      source: seed.abs_path ?? null,
      origin: "substrate",
      actor_ref: createdBy,
    }),
    createdBy,
  );
  return {
    ...base,
    produced_by: [],
    references: [],
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
  const provenance = provenanceFromOps(ops, {
    abs_path: catalog.abs_path,
    agent: catalog.agent,
  });
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
    local_visual_state: artifactListVisualState({
      availability: catalog.availability,
      status: review?.ship_blockers_json && !review.shipped_at ? "ship_blocked" : undefined,
      catalogPresent: true,
    }),
    provenance,
  };
}
