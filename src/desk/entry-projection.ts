import type { ActorRef, EntryProvenance, ReadModelEnvelope } from "../outputs/entry.js";
import type { DeskItemOperationRow, DeskItemRow } from "./types.js";
import {
  buildProvenanceFromOpLog,
  finalizeEntryProvenance,
  parseActorRef,
} from "../doc-model/provenance.js";
import { parseProvenance } from "./storage.js";

export interface DeskEntry {
  phid: string;
  kind: "desk_item";
  schema_version: 1;
  display_id: string;
  title: string;
  body_markdown: string;
  desk_item_kind: DeskItemRow["kind"];
  tray_zone: DeskItemRow["tray_zone"];
  tray_state: DeskItemRow["tray_state"];
  source_ref: string | null;
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  provenance: EntryProvenance;
}

export function deskRowToEntry(row: DeskItemRow, ops: DeskItemOperationRow[] = []): DeskEntry {
  const stored = parseProvenance(row.provenance_json);
  const createdBy = parseActorRef(row.added_by);
  const updatedAt = row.dismissed_at ?? row.added_at;
  const provenance = deskProvenance(row, ops, stored, createdBy);
  const lastRevision = provenance.revisions[provenance.revisions.length - 1];
  const updatedBy = lastRevision?.by ?? createdBy;

  return {
    phid: row.desk_item_id,
    kind: "desk_item",
    schema_version: 1,
    display_id: row.desk_item_id,
    title: row.label,
    body_markdown: row.body_md,
    desk_item_kind: row.kind,
    tray_zone: row.tray_zone,
    tray_state: row.tray_state,
    source_ref: row.source_ref,
    created_at: row.added_at,
    created_by: createdBy,
    updated_at: updatedAt,
    updated_by: updatedBy,
    provenance,
  };
}

function deskProvenance(
  row: DeskItemRow,
  ops: DeskItemOperationRow[],
  stored: ReturnType<typeof parseProvenance>,
  createdBy: ActorRef,
): EntryProvenance {
  if (ops.length > 0) {
    return finalizeEntryProvenance(
      buildProvenanceFromOpLog(ops, {
        source: stored.source ?? row.source_ref ?? stored.source_path,
        origin: stored.origin ?? "substrate",
        actor_ref: createdBy,
        derived_from: stored.source_ref ? [stored.source_ref] : [],
      }),
      createdBy,
    );
  }

  const revisions = [
    {
      at: row.added_at,
      by: createdBy,
      note: "created",
    },
  ];
  if (row.dismissed_at) {
    revisions.push({
      at: row.dismissed_at,
      by: createdBy,
      note: "dismissed",
    });
  }

  return finalizeEntryProvenance(
    {
      actor_ref: createdBy,
      source: stored.source ?? row.source_ref ?? stored.source_path,
      origin: stored.origin ?? "migration",
      source_dispatch_phid: null,
      derived_from: stored.source_ref ? [stored.source_ref] : [],
      revisions,
      contributors: [createdBy],
    },
    createdBy,
  );
}

/**
 * Wrap a page of desk rows in the shared read-model.v1 envelope — the substrate
 * query path for GET /desk/entries (I-1). Does not flip the operator cutover flag;
 * consumers keep reading GET /desk/tray until DESK_USE_DOCUMENT_MODEL is enabled.
 */
export function buildDeskEntriesEnvelope(
  rows: DeskItemRow[],
  opsByItemId: Map<string, DeskItemOperationRow[]>,
  page: { limit: number; offset: number },
  parityStatus: ReadModelEnvelope<DeskEntry>["parity"]["status"] = "unchecked",
): ReadModelEnvelope<DeskEntry> {
  const items = rows
    .slice(page.offset, page.offset + page.limit)
    .map((row) => deskRowToEntry(row, opsByItemId.get(row.desk_item_id) ?? []));
  return {
    schema_version: "read-model.v1",
    generated_at: new Date().toISOString(),
    items,
    count: items.length,
    limit: page.limit,
    offset: page.offset,
    source: { read_path: "substrate", projection: "desk_entries" },
    parity: { status: parityStatus },
  };
}
