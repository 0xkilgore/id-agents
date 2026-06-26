// Kapelle Desk — pure tray projection (no I/O).
//
// Builds the desk.tray.v1 envelope by merging persisted DeskItems with
// federated substrate rows (open decisions → needs_you; unread artifacts → shipped).

import type { DecisionRow } from "../decisions/types.js";
import type { OutputsInboxRow } from "../outputs/types.js";
import { useDocumentModel } from "../config/feature-flags.js";
import type { DeskItemRow, DeskTrayItem, DeskTrayResponse } from "./types.js";
import { parseProvenance } from "./storage.js";

export const DESK_TRAY_PARSER_VERSION = "desk.tray.v1";

export function deskRowToTrayItem(row: DeskItemRow): DeskTrayItem {
  const provenance = parseProvenance(row.provenance_json);
  return {
    desk_item_id: row.desk_item_id,
    label: row.label,
    kind: row.kind,
    desk_class: row.desk_class,
    tray_zone: row.tray_zone,
    body_md: row.body_md,
    source_ref: row.source_ref,
    added_at: row.added_at,
    added_by: row.added_by,
    tray_state: row.tray_state,
    dismissed_at: row.dismissed_at,
    provenance,
    href: hrefForDeskItem(row),
    priority: null,
  };
}

function hrefForDeskItem(row: DeskItemRow): string | null {
  if (row.kind === "artifact" && row.source_ref) {
    return `/ops/artifacts/${encodeURIComponent(row.source_ref)}`;
  }
  if (row.kind === "decision" && row.source_ref) {
    return `/ops/decisions/${encodeURIComponent(row.source_ref)}`;
  }
  return null;
}

export function artifactInboxToTrayItem(row: OutputsInboxRow): DeskTrayItem {
  const label = row.title ?? row.basename ?? row.artifact_id;
  return {
    desk_item_id: `desk_art_${row.artifact_id.replace(/^art_/, "").slice(0, 16)}`,
    label,
    kind: "artifact",
    desk_class: "tray",
    tray_zone: "shipped",
    body_md: row.abs_path ?? "",
    source_ref: row.artifact_id,
    added_at: row.produced_at ?? new Date().toISOString(),
    added_by: row.agent ?? "system",
    tray_state: "on_desk",
    dismissed_at: null,
    provenance: {
      source_path: null,
      anchor: null,
      parser_version: DESK_TRAY_PARSER_VERSION,
      source_ref: row.artifact_id,
    },
    href: `/ops/artifacts/${encodeURIComponent(row.artifact_id)}`,
    priority: null,
  };
}

export function decisionRowToTrayItem(row: DecisionRow): DeskTrayItem {
  return {
    desk_item_id: `desk_dec_${row.decision_id.replace(/^dec_/, "").slice(0, 16)}`,
    label: row.title,
    kind: "decision",
    desk_class: "tray",
    tray_zone: "needs_you",
    body_md: row.question,
    source_ref: row.decision_id,
    added_at: row.created_at,
    added_by: row.requested_by ?? row.owner,
    tray_state: "on_desk",
    dismissed_at: null,
    provenance: {
      source_path: null,
      anchor: null,
      parser_version: DESK_TRAY_PARSER_VERSION,
      source_ref: row.decision_id,
    },
    href: `/ops/decisions/${encodeURIComponent(row.decision_id)}`,
    priority: row.priority,
  };
}

export interface BuildDeskTrayInput {
  generatedAt: string;
  deskRows: DeskItemRow[];
  artifactInboxRows?: OutputsInboxRow[];
  openDecisions?: DecisionRow[];
  parityStatus?: "ok" | "fallback" | "drift";
  env?: NodeJS.ProcessEnv;
}

/** Merge persisted desk rows with federated substrate projections. */
export function buildDeskTrayEnvelope(input: BuildDeskTrayInput): DeskTrayResponse {
  const {
    generatedAt,
    deskRows,
    artifactInboxRows = [],
    openDecisions = [],
    parityStatus = "ok",
    env = process.env,
  } = input;

  const useSubstrate = useDocumentModel("desk", env);
  const persisted = deskRows
    .filter((r) => r.desk_class === "tray" && r.tray_state === "on_desk")
    .map(deskRowToTrayItem);

  const persistedSourceRefs = new Set(
    persisted.map((i) => i.source_ref).filter(Boolean) as string[],
  );

  const federatedShipped = artifactInboxRows
    .filter((a) => a.status === "never_viewed" || a.status === "viewed")
    .filter((a) => !persistedSourceRefs.has(a.artifact_id))
    .map(artifactInboxToTrayItem);

  const federatedNeedsYou = openDecisions
    .filter((d) => d.status === "open")
    .filter((d) => !persistedSourceRefs.has(d.decision_id))
    .map(decisionRowToTrayItem);

  const items = [...persisted, ...federatedNeedsYou, ...federatedShipped].sort(
    (a, b) => Date.parse(b.added_at) - Date.parse(a.added_at),
  );

  const needsYou = items.filter((i) => i.tray_zone === "needs_you").length;
  const shipped = items.filter((i) => i.tray_zone === "shipped").length;

  return {
    schema_version: "desk.tray.v1",
    generated_at: generatedAt,
    source: {
      system: "manager",
      projection: "desk_tray",
      source_type: federatedShipped.length + federatedNeedsYou.length > 0 ? "hybrid_projection" : "manager_desk_table",
      read_path: useSubstrate ? "substrate" : "markdown_walk",
    },
    freshness: {
      last_ingest_at: generatedAt,
      auto_ingest: false,
      stale_after_s: 900,
    },
    provenance: {
      parser_version: DESK_TRAY_PARSER_VERSION,
      markdown_source: null,
    },
    parity: {
      status: parityStatus,
      checked_at: generatedAt,
    },
    filters: {
      desk_class: "tray",
      tray_state: "on_desk",
    },
    counts: {
      on_desk: items.length,
      needs_you: needsYou,
      shipped,
      dismissed: deskRows.filter((r) => r.tray_state === "dismissed").length,
      acted: deskRows.filter((r) => r.tray_state === "acted").length,
    },
    items,
    warnings: [],
  };
}
