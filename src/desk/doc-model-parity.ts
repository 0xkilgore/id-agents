// I-1 desk doc-model parity — substrate query vs the current tray read path.
//
// The "current source" for persisted desk rows is the tray projection
// (buildDeskTrayEnvelope → deskRowToTrayItem). The substrate query is
// buildDeskEntriesEnvelope → deskRowToEntry. Both read the same desk_items
// rows; this gate must be green before DESK_USE_DOCUMENT_MODEL flips.

import { computeParity } from "../substrate-migration/parity.js";
import type { ParityComparable, ParityReport } from "../substrate-migration/types.js";
import type { DeskEntry } from "./entry-projection.js";
import type { DeskTrayItem } from "./types.js";

export function deskEntryToComparable(entry: DeskEntry): ParityComparable {
  return {
    key: entry.phid,
    ordering_ts: entry.updated_at,
    fidelity: {
      title: entry.title,
      tray_zone: entry.tray_zone,
      tray_state: entry.tray_state,
      desk_item_kind: entry.desk_item_kind,
      source_ref: entry.source_ref ?? "",
    },
  };
}

export function deskTrayItemToComparable(item: DeskTrayItem): ParityComparable {
  return {
    key: item.desk_item_id,
    ordering_ts: item.dismissed_at ?? item.added_at,
    fidelity: {
      title: item.label,
      tray_zone: item.tray_zone,
      tray_state: item.tray_state,
      desk_item_kind: item.kind,
      source_ref: item.source_ref ?? "",
    },
  };
}

/** Compare substrate DeskEntry[] to tray items from the current read path. */
export function computeDeskDocModelParity(
  substrateEntries: DeskEntry[],
  currentTrayItems: DeskTrayItem[],
  checkedAt: string,
): ParityReport {
  return computeParity(
    substrateEntries.map(deskEntryToComparable),
    currentTrayItems.map(deskTrayItemToComparable),
    checkedAt,
  );
}
