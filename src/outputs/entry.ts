// ARTIFACTS substrate proof-cut — canonical doc-type contract (read-model).
//
// SOURCE OF TRUTH: agent-platform/entry-taxonomy-package/entries/artifact.ts (DV1)
// + entry-taxonomy-package/provenance.ts (DV2). That package is not yet a build
// dependency of id-agents, so this file MIRRORS the DV1 ArtifactEntry shape (and
// the shared DV2/finance primitives PHID / ActorRef / AssociationEdge) to keep
// tonight's proof-cut inside one repo.
//
// TODO(import-not-mirror): once entry-taxonomy-package is linked into id-agents,
// delete these local definitions and `import` the canonical types. The *shape*
// here is canonical (DV1); only the *import path* is deferred.
//
// OSS lift: mirrors DV1/DV2 (Powerhouse document-model lineage, AGPL).

import type { LocalHealthVisual } from "../local-search/visual-state.js";

/** Stable cross-system id. For artifacts this is the existing artifact_id
 *  (`art_<sha256(abs_path)[:16]>`). */
export type PHID = string;

/** Who acted. DV2/finance shared primitive. */
export interface ActorRef {
  type: "agent" | "user" | "system" | "service";
  id: string;
}

/** A typed association from this entry to another. DV2/finance shared primitive.
 *  v0 of the artifacts read-model emits an empty `links[]`; the type is carried
 *  so consumers can rely on the DV1 envelope shape. */
export interface AssociationEdge {
  rel: "produced_by" | "references" | "derived_from";
  target_phid: PHID;
}

/** A single entry in the created/modified chain — who changed the entry, when,
 *  and a short note. DV2 shared primitive. */
export interface ProvenanceRevision {
  at: string;
  by: ActorRef;
  note: string | null;
}

/**
 * Shared DV2 provenance core carried by EVERY doc-model entry (artifact, task,
 * desk, …) so the substrate exposes one provenance contract everywhere (I-1/DV2):
 *   - actor_ref: primary actor (creator / last meaningful actor)
 *   - source: human or machine pointer (path, handle, anchor, dispatch ref)
 *   - origin: how the row entered the doc-model
 *   - source_dispatch_phid: dispatch that produced the row, when known
 *   - derived_from: upstream entry phids
 *   - revisions: created/modified chain (ascending)
 *   - contributors: deduped actors seen in the chain
 */
export interface EntryProvenance {
  actor_ref: ActorRef | null;
  source: string | null;
  origin:
    | "substrate"
    | "markdown_walk"
    | "federation"
    | "manual"
    | "migration"
    | "dispatch"
    | null;
  source_dispatch_phid: string | null;
  derived_from: string[];
  revisions: ProvenanceRevision[];
  contributors: ActorRef[];
}

/** Artifact provenance — the shared core plus artifact-specific lineage,
 *  built from the artifact_operations op log. */
export interface ArtifactProvenance extends EntryProvenance {
  produced_by: string[];
  references: string[];
}

/**
 * Maestra's stamping convention: who an entry is for (audience) and what
 * triage bucket it belongs to (kind). Drives the console's five surfaces
 * (Now / Inbox / Activity / Projects / Reports). Nullable/additive on
 * ArtifactEntry — legacy filesystem-projected rows (entry-projection.ts)
 * predate the convention and carry `stamp: null` until backfilled; doc-model
 * substrate rows (doc-model/artifact-document.ts) always carry one.
 */
export type EntryStampAudience = "operator" | "system";
export type EntryStampKind =
  | "action-needed"
  | "report"
  | "document"
  | "receipt"
  | "direction-brief"
  | "closeout"
  | "diagnostics"
  | "qa-evidence"
  | "final-document";
export interface EntryStamp {
  audience: EntryStampAudience;
  kind: EntryStampKind;
}

/**
 * DV1 ArtifactEntry — the row shape the operator surfaces query. A pure
 * projection over the existing `artifacts` / `artifact_review_state` /
 * `artifact_operations` tables (see entry-projection.ts) — no schema migration.
 */
export interface ArtifactEntry {
  phid: PHID;
  kind: "artifact";
  schema_version: 1;
  title: string;
  /** Empty for now — delivery rows carry no body. Reserved by the DV1 envelope. */
  body_markdown: string;
  display_id: string | null;
  artifact_kind: string;
  project: string | null;
  path: string | null;
  source_dispatch_phid: string | null;
  produced_by_agent: string | null;
  links: AssociationEdge[];
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  local_visual_state: LocalHealthVisual;
  provenance: ArtifactProvenance;
  stamp: EntryStamp | null;
}

/** Shared read-model envelope (parent contract §3) for the substrate surfaces. */
export interface ReadModelEnvelope<T> {
  schema_version: "read-model.v1";
  generated_at: string;
  items: T[];
  count: number;
  limit: number;
  offset: number;
  source: {
    read_path: "substrate" | "delivery-log-walk";
    projection: string;
  };
  admission?: {
    source: "stamp" | "comment_thread" | "receipt_log" | "project_group";
    audience: EntryStampAudience | "any";
    kinds: EntryStampKind[] | "any";
    reason: string;
  };
  parity: {
    status: "ok" | "drift" | "unchecked";
  };
}
