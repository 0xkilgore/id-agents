// DV2 doc-model provenance — shared helpers for artifacts, tasks, and desk.
//
// Records source / actor / origin plus revision lineage on every substrate entry
// so operator surfaces can audit where a row came from and how it changed.

import type { ActorRef, EntryProvenance, ProvenanceRevision } from "../outputs/entry.js";

export type DocModelOrigin =
  | "substrate"
  | "markdown_walk"
  | "federation"
  | "manual"
  | "migration"
  | "dispatch";

export interface OpLogRow {
  op_id: number;
  ts: string;
  actor: string;
  op_type: string;
  payload_json?: string | null;
}

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

function revisionNote(op: OpLogRow): string | null {
  if (op.payload_json) {
    try {
      const parsed = JSON.parse(op.payload_json) as { note?: unknown };
      if (typeof parsed.note === "string" && parsed.note.trim()) return parsed.note.trim();
    } catch {
      /* fall through */
    }
  }
  return op.op_type;
}

function dedupeContributors(revisions: ProvenanceRevision[]): ActorRef[] {
  const contributors: ActorRef[] = [];
  const seen = new Set<string>();
  for (const rev of revisions) {
    const key = `${rev.by.type}:${rev.by.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      contributors.push(rev.by);
    }
  }
  return contributors;
}

export function buildProvenanceFromOpLog(
  ops: OpLogRow[],
  seed: {
    source?: string | null;
    origin?: DocModelOrigin | null;
    actor_ref?: ActorRef | null;
    source_dispatch_phid?: string | null;
    derived_from?: string[];
  } = {},
): EntryProvenance {
  const ordered = [...ops].sort((a, b) => a.op_id - b.op_id);
  const revisions = ordered.map((op) => ({
    at: op.ts,
    by: parseActorRef(op.actor),
    note: revisionNote(op),
  }));
  const contributors = dedupeContributors(revisions);
  const actor_ref = seed.actor_ref ?? contributors[0] ?? null;
  return {
    actor_ref,
    source: seed.source ?? null,
    origin: seed.origin ?? null,
    source_dispatch_phid: seed.source_dispatch_phid ?? null,
    derived_from: seed.derived_from ?? [],
    revisions,
    contributors,
  };
}

export function finalizeEntryProvenance(
  base: EntryProvenance,
  actor_ref?: ActorRef | null,
): EntryProvenance {
  return {
    ...base,
    actor_ref: actor_ref ?? base.actor_ref ?? base.contributors[0] ?? null,
  };
}
