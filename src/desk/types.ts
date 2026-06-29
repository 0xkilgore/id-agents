// Kapelle Desk — DeskItem doc-model types.
//
// Contract: cto/output/2026-06-23-readmodel-contract-operator-surfaces-scope.md §4.2
// Console UX: rams/output/2026-06-23-desk-and-console-needs-you-redesign.md

import type { DocModelOrigin } from "../doc-model/provenance.js";
export type DeskItemKind =
  | "artifact"
  | "tickler"
  | "stale"
  | "dispatch_reply"
  | "note"
  | "decision";

export type DeskClass = "tray" | "fyi" | "status" | "reference";

export type TrayState = "on_desk" | "dismissed" | "acted";

/** Console column grouping for the Desk panel. */
export type DeskTrayZone = "needs_you" | "shipped";

export type DeskOpType = "DESK_ADD" | "DESK_DISMISS" | "DESK_ACT";

export interface DeskItemProvenance {
  source_path: string | null;
  anchor: string | null;
  parser_version: string;
  source_ref?: string | null;
  /** DV2 — canonical source pointer (path, ref, anchor). */
  source?: string | null;
  /** DV2 — how this desk row entered the substrate. */
  origin?: DocModelOrigin | null;
}

export interface DeskItemRow {
  desk_item_id: string;
  label: string;
  kind: DeskItemKind;
  desk_class: DeskClass;
  tray_zone: DeskTrayZone;
  body_md: string;
  source_ref: string | null;
  added_at: string;
  added_by: string;
  tray_state: TrayState;
  dismissed_at: string | null;
  provenance_json: string;
}

export interface DeskItemOperationRow {
  op_id: number;
  desk_item_id: string;
  op_type: DeskOpType;
  actor: string;
  ts: string;
  payload_json: string;
}

export interface DeskTrayItem {
  desk_item_id: string;
  label: string;
  kind: DeskItemKind;
  desk_class: DeskClass;
  tray_zone: DeskTrayZone;
  body_md: string;
  source_ref: string | null;
  added_at: string;
  added_by: string;
  tray_state: TrayState;
  dismissed_at: string | null;
  provenance: DeskItemProvenance;
  href: string | null;
  priority: string | null;
}

export interface DeskTrayResponse {
  schema_version: "desk.tray.v1";
  generated_at: string;
  source: {
    system: "manager";
    projection: "desk_tray";
    source_type: "manager_desk_table" | "hybrid_projection";
    read_path: "substrate" | "markdown_walk";
  };
  freshness: {
    last_ingest_at: string | null;
    auto_ingest: boolean;
    stale_after_s: number;
  };
  provenance: {
    parser_version: string;
    markdown_source: string | null;
  };
  parity: {
    status: "ok" | "fallback" | "drift";
    checked_at: string;
  };
  filters: {
    desk_class: DeskClass;
    tray_state: TrayState;
  };
  counts: {
    on_desk: number;
    needs_you: number;
    shipped: number;
    dismissed: number;
    acted: number;
  };
  items: DeskTrayItem[];
  warnings: Array<{ code: string; message: string }>;
}

export type DeskNeedsMeItemKind =
  | "approval"
  | "artifact_review"
  | "unread_comment"
  | "needs_chris";

export interface DeskNeedsMeItem {
  id: string;
  kind: DeskNeedsMeItemKind;
  label: string;
  body_md: string;
  source_ref: string;
  href: string | null;
  actor: string | null;
  agent: string | null;
  priority: string | number | null;
  status: string;
  added_at: string;
  provenance: {
    source: "decisions" | "artifact_review_state" | "artifact_operations" | "orchestration_backlog_item";
    source_table: string;
    source_ref: string;
    parser_version: "desk.needs_me.v1";
  };
}

export interface DeskNeedsMeResponse {
  schema_version: "desk.needs_me.v1";
  generated_at: string;
  source: {
    system: "manager";
    projection: "desk_needs_me";
    source_type: "hybrid_projection";
    read_path: "substrate";
  };
  filters: {
    actor: "user:chris";
    team_id: string;
    limit: number;
  };
  counts: {
    total: number;
    approvals: number;
    artifact_review: number;
    unread_comments: number;
    needs_chris: number;
  };
  items: DeskNeedsMeItem[];
  warnings: Array<{ code: string; message: string }>;
}

export interface UpsertDeskItemInput {
  desk_item_id?: string;
  label: string;
  kind: DeskItemKind;
  desk_class?: DeskClass;
  tray_zone?: DeskTrayZone;
  body_md?: string;
  source_ref?: string | null;
  added_at?: string;
  added_by?: string;
  tray_state?: TrayState;
  provenance?: Partial<DeskItemProvenance> & { origin?: DocModelOrigin | null };
}
