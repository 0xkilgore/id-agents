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
 * …) so the substrate exposes one provenance contract everywhere (I-1):
 *   - actor_ref:              `contributors` + each revision's `by`
 *   - source dispatch:        `source_dispatch_phid`
 *   - derived-from links:     `derived_from`
 *   - created/modified chain: `revisions` (ascending)
 */
export interface EntryProvenance {
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
  provenance: ArtifactProvenance;
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
  parity: {
    status: "ok" | "drift" | "unchecked";
  };
}
