import { createHash } from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type {
  DeskClass,
  DeskItemKind,
  DeskItemOperationRow,
  DeskItemProvenance,
  DeskItemRow,
  DeskOpType,
  DeskTrayZone,
  TrayState,
  UpsertDeskItemInput,
} from "./types.js";

export const DESK_PARSER_VERSION = "desk.producer.v2";

export async function migrateDeskTables(adapter: DbAdapter): Promise<void> {
  const autoIncrementPrimaryKey = adapter.dialect === "postgres"
    ? "BIGSERIAL PRIMARY KEY"
    : "INTEGER PRIMARY KEY AUTOINCREMENT";
  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS desk_items (
      desk_item_id   TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('artifact', 'tickler', 'stale', 'dispatch_reply', 'note', 'decision')),
      desk_class     TEXT NOT NULL DEFAULT 'tray' CHECK (desk_class IN ('tray', 'fyi', 'status', 'reference')),
      tray_zone      TEXT NOT NULL DEFAULT 'needs_you' CHECK (tray_zone IN ('needs_you', 'shipped')),
      body_md        TEXT NOT NULL DEFAULT '',
      source_ref     TEXT,
      added_at       TEXT NOT NULL,
      added_by       TEXT NOT NULL,
      tray_state     TEXT NOT NULL DEFAULT 'on_desk' CHECK (tray_state IN ('on_desk', 'dismissed', 'acted')),
      dismissed_at   TEXT,
      provenance_json TEXT NOT NULL
    )
  `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS desk_items_tray_idx ON desk_items(desk_class, tray_state, added_at DESC)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS desk_items_zone_idx ON desk_items(tray_zone, tray_state, added_at DESC)`,
    [],
  );
  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS desk_item_operations (
      op_id          ${autoIncrementPrimaryKey},
      desk_item_id   TEXT NOT NULL,
      op_type        TEXT NOT NULL CHECK (op_type IN ('DESK_ADD', 'DESK_DISMISS', 'DESK_ACT')),
      actor          TEXT NOT NULL,
      ts             TEXT NOT NULL,
      payload_json   TEXT NOT NULL DEFAULT '{}'
    )
  `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS desk_item_ops_item_idx ON desk_item_operations(desk_item_id, ts)`,
    [],
  );
}

export function deriveDeskItemId(
  label: string,
  sourceRef: string | null,
  addedAt: string,
): string {
  const hash = createHash("sha256")
    .update(`${label}|${sourceRef ?? ""}|${addedAt}`)
    .digest("hex")
    .slice(0, 16);
  return `desk_${hash}`;
}

function defaultProvenance(over?: Partial<DeskItemProvenance>): DeskItemProvenance {
  return {
    source_path: over?.source_path ?? null,
    anchor: over?.anchor ?? null,
    parser_version: over?.parser_version ?? DESK_PARSER_VERSION,
    source_ref: over?.source_ref ?? null,
    source: over?.source ?? over?.source_ref ?? over?.source_path ?? null,
    origin: over?.origin ?? "manual",
  };
}

export function parseProvenance(json: string): DeskItemProvenance {
  try {
    const parsed = JSON.parse(json) as Partial<DeskItemProvenance>;
    return defaultProvenance(parsed);
  } catch {
    return defaultProvenance();
  }
}

export async function getDeskItemById(
  adapter: DbAdapter,
  deskItemId: string,
): Promise<DeskItemRow | null> {
  const { rows } = await adapter.query<DeskItemRow>(
    `SELECT * FROM desk_items WHERE desk_item_id = ? LIMIT 1`,
    [deskItemId],
  );
  return rows[0] ?? null;
}

export interface ListDeskItemsFilters {
  desk_class?: DeskClass;
  tray_state?: TrayState;
  tray_zone?: DeskTrayZone;
  kind?: DeskItemKind;
  limit?: number;
}

export async function listDeskItems(
  adapter: DbAdapter,
  filters: ListDeskItemsFilters = {},
): Promise<DeskItemRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.desk_class) {
    where.push("desk_class = ?");
    params.push(filters.desk_class);
  }
  if (filters.tray_state) {
    where.push("tray_state = ?");
    params.push(filters.tray_state);
  }
  if (filters.tray_zone) {
    where.push("tray_zone = ?");
    params.push(filters.tray_zone);
  }
  if (filters.kind) {
    where.push("kind = ?");
    params.push(filters.kind);
  }
  const limit = Math.min(filters.limit ?? 200, 500);
  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await adapter.query<DeskItemRow>(
    `SELECT * FROM desk_items ${whereSql} ORDER BY added_at DESC LIMIT ?`,
    params,
  );
  return rows;
}

export async function countDeskItemsByState(
  adapter: DbAdapter,
  trayState: TrayState,
): Promise<number> {
  const { rows } = await adapter.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM desk_items WHERE tray_state = ? AND desk_class = 'tray'`,
    [trayState],
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function countDeskItemsByZone(
  adapter: DbAdapter,
  zone: DeskTrayZone,
): Promise<number> {
  const { rows } = await adapter.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM desk_items WHERE tray_zone = ? AND tray_state = 'on_desk' AND desk_class = 'tray'`,
    [zone],
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function listDeskOperations(
  adapter: DbAdapter,
  deskItemId: string,
): Promise<DeskItemOperationRow[]> {
  const { rows } = await adapter.query<DeskItemOperationRow>(
    `SELECT * FROM desk_item_operations WHERE desk_item_id = ? ORDER BY op_id ASC`,
    [deskItemId],
  );
  return rows;
}

export async function appendDeskOperation(
  adapter: DbAdapter,
  op: Omit<DeskItemOperationRow, "op_id">,
): Promise<void> {
  await adapter.query(
    `INSERT INTO desk_item_operations (desk_item_id, op_type, actor, ts, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
    [op.desk_item_id, op.op_type, op.actor, op.ts, op.payload_json],
  );
}

export async function upsertDeskItem(
  adapter: DbAdapter,
  input: UpsertDeskItemInput,
  actor = "system",
): Promise<{ desk_item_id: string; outcome: "inserted" | "updated" }> {
  const addedAt = input.added_at ?? new Date().toISOString();
  const deskItemId =
    input.desk_item_id ??
    deriveDeskItemId(input.label, input.source_ref ?? null, addedAt);
  const existing = await getDeskItemById(adapter, deskItemId);
  const prior = existing ? parseProvenance(existing.provenance_json) : null;
  const provenance = defaultProvenance({
    ...prior,
    ...input.provenance,
    source_ref: input.source_ref ?? input.provenance?.source_ref ?? prior?.source_ref ?? null,
    source:
      input.provenance?.source ??
      input.source_ref ??
      input.provenance?.source_path ??
      prior?.source ??
      null,
    origin: input.provenance?.origin ?? prior?.origin ?? "manual",
  });
  const row: DeskItemRow = {
    desk_item_id: deskItemId,
    label: input.label,
    kind: input.kind,
    desk_class: input.desk_class ?? "tray",
    tray_zone: input.tray_zone ?? "needs_you",
    body_md: input.body_md ?? "",
    source_ref: input.source_ref ?? null,
    added_at: addedAt,
    added_by: input.added_by ?? actor,
    tray_state: input.tray_state ?? "on_desk",
    dismissed_at: null,
    provenance_json: JSON.stringify(provenance),
  };

  if (!existing) {
    await adapter.query(
      `INSERT INTO desk_items
         (desk_item_id, label, kind, desk_class, tray_zone, body_md, source_ref,
          added_at, added_by, tray_state, dismissed_at, provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.desk_item_id,
        row.label,
        row.kind,
        row.desk_class,
        row.tray_zone,
        row.body_md,
        row.source_ref,
        row.added_at,
        row.added_by,
        row.tray_state,
        row.dismissed_at,
        row.provenance_json,
      ],
    );
    await appendDeskOperation(adapter, {
      desk_item_id: deskItemId,
      op_type: "DESK_ADD",
      actor,
      ts: addedAt,
      payload_json: JSON.stringify({ label: row.label, kind: row.kind, origin: provenance.origin }),
    });
    return { desk_item_id: deskItemId, outcome: "inserted" };
  }

  await appendDeskOperation(adapter, {
    desk_item_id: deskItemId,
    op_type: "DESK_ADD",
    actor,
    ts: new Date().toISOString(),
    payload_json: JSON.stringify({ note: "updated", label: row.label, kind: row.kind }),
  });

  await adapter.query(
    `UPDATE desk_items
       SET label = ?,
           kind = ?,
           desk_class = ?,
           tray_zone = ?,
           body_md = ?,
           source_ref = ?,
           added_by = ?,
           tray_state = ?,
           provenance_json = ?
     WHERE desk_item_id = ?`,
    [
      row.label,
      row.kind,
      row.desk_class,
      row.tray_zone,
      row.body_md,
      row.source_ref,
      row.added_by,
      row.tray_state,
      row.provenance_json,
      deskItemId,
    ],
  );
  return { desk_item_id: deskItemId, outcome: "updated" };
}

export async function recordDeskDismiss(
  adapter: DbAdapter,
  deskItemId: string,
  actor: string,
  now: string,
): Promise<boolean> {
  const existing = await getDeskItemById(adapter, deskItemId);
  if (!existing) return false;
  await adapter.query(
    `UPDATE desk_items SET tray_state = 'dismissed', dismissed_at = ? WHERE desk_item_id = ?`,
    [now, deskItemId],
  );
  await appendDeskOperation(adapter, {
    desk_item_id: deskItemId,
    op_type: "DESK_DISMISS",
    actor,
    ts: now,
    payload_json: "{}",
  });
  return true;
}

export async function recordDeskAct(
  adapter: DbAdapter,
  deskItemId: string,
  actor: string,
  now: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const existing = await getDeskItemById(adapter, deskItemId);
  if (!existing) return false;
  await adapter.query(
    `UPDATE desk_items SET tray_state = 'acted', dismissed_at = COALESCE(dismissed_at, ?) WHERE desk_item_id = ?`,
    [now, deskItemId],
  );
  await appendDeskOperation(adapter, {
    desk_item_id: deskItemId,
    op_type: "DESK_ACT",
    actor,
    ts: now,
    payload_json: JSON.stringify(payload),
  });
  return true;
}
