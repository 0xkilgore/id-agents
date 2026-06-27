// DV2 doc-model provenance — shared helpers + desk entry projection tests.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  buildProvenanceFromOpLog,
  finalizeEntryProvenance,
  parseActorRef,
} from "../../src/doc-model/provenance.js";
import { deskRowToEntry } from "../../src/desk/entry-projection.js";
import { mountDeskRoutes } from "../../src/desk/routes.js";
import { migrateDeskTables, upsertDeskItem } from "../../src/desk/storage.js";
import type { DeskItemRow } from "../../src/desk/types.js";

const NOW = "2026-06-25T12:00:00.000Z";

describe("parseActorRef (shared)", () => {
  it("maps prefixed + bare actors", () => {
    expect(parseActorRef("user:chris")).toEqual({ type: "user", id: "chris" });
    expect(parseActorRef("agent:regina")).toEqual({ type: "agent", id: "regina" });
    expect(parseActorRef("system")).toEqual({ type: "system", id: "system" });
    expect(parseActorRef("operator")).toEqual({ type: "user", id: "operator" });
    expect(parseActorRef("roger")).toEqual({ type: "agent", id: "roger" });
    expect(parseActorRef("")).toEqual({ type: "system", id: "system" });
  });
});

describe("buildProvenanceFromOpLog", () => {
  it("builds revisions + contributors in op_id order with seed fields", () => {
    const prov = buildProvenanceFromOpLog(
      [
        { op_id: 2, ts: "t2", actor: "user:liz", op_type: "DESK_DISMISS" },
        { op_id: 1, ts: "t1", actor: "user:chris", op_type: "DESK_ADD" },
      ],
      { source: "/Desk.md#item", origin: "manual", actor_ref: { type: "user", id: "chris" } },
    );
    expect(prov.revisions.map((r) => r.at)).toEqual(["t1", "t2"]);
    expect(prov.source).toBe("/Desk.md#item");
    expect(prov.origin).toBe("manual");
    expect(prov.actor_ref).toEqual({ type: "user", id: "chris" });
    expect(prov.contributors).toEqual([
      { type: "user", id: "chris" },
      { type: "user", id: "liz" },
    ]);
  });

  it("prefers a JSON payload note over the op type", () => {
    const prov = buildProvenanceFromOpLog([
      {
        op_id: 1,
        ts: "t1",
        actor: "agent:qa",
        op_type: "DESK_ADD",
        payload_json: JSON.stringify({ note: "looks good" }),
      },
    ]);
    expect(prov.revisions[0].note).toBe("looks good");
  });
});

describe("finalizeEntryProvenance", () => {
  it("fills actor_ref from contributors when missing", () => {
    const base = buildProvenanceFromOpLog([
      { op_id: 1, ts: "t1", actor: "agent:roger", op_type: "DESK_ADD" },
    ]);
    const finalized = finalizeEntryProvenance({ ...base, actor_ref: null });
    expect(finalized.actor_ref).toEqual({ type: "agent", id: "roger" });
  });
});

describe("deskRowToEntry", () => {
  const row: DeskItemRow = {
    desk_item_id: "desk_test_1",
    label: "Review artifact",
    kind: "artifact",
    desk_class: "tray",
    tray_zone: "needs_you",
    body_md: "Please review",
    source_ref: "art_abc",
    added_at: NOW,
    added_by: "agent:qa",
    tray_state: "on_desk",
    dismissed_at: null,
    provenance_json: JSON.stringify({
      source_path: "/Desk.md",
      anchor: "review-artifact",
      parser_version: "desk.producer.v2",
      source_ref: "art_abc",
      source: "art_abc",
      origin: "manual",
    }),
  };

  it("projects a desk row with DV2 provenance from the op log", () => {
    const entry = deskRowToEntry(row, [
      {
        op_id: 1,
        desk_item_id: row.desk_item_id,
        op_type: "DESK_ADD",
        actor: "agent:qa",
        ts: NOW,
        payload_json: JSON.stringify({ label: row.label, origin: "manual" }),
      },
    ]);
    expect(entry.kind).toBe("desk_item");
    expect(entry.phid).toBe("desk_test_1");
    expect(entry.provenance.source).toBe("art_abc");
    expect(entry.provenance.origin).toBe("manual");
    expect(entry.provenance.actor_ref).toEqual({ type: "agent", id: "qa" });
    expect(entry.provenance.derived_from).toEqual(["art_abc"]);
    expect(entry.provenance.revisions).toHaveLength(1);
    expect(entry.created_by).toEqual({ type: "agent", id: "qa" });
  });

  it("synthesizes provenance when no op log exists (legacy rows)", () => {
    const entry = deskRowToEntry(row, []);
    expect(entry.provenance.origin).toBe("manual");
    expect(entry.provenance.revisions[0].note).toBe("created");
  });
});

async function bootDeskApp(): Promise<{ app: Express; adapter: SqliteAdapter }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateDeskTables(adapter);
  const app = express();
  app.use(express.json());
  mountDeskRoutes(app, adapter, { now: () => new Date(NOW) });
  return { app, adapter };
}

async function getJson(app: Express, path: string) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("GET /desk/entries/:ref (DV2 — provenance queryable per entry)", () => {
  it("returns the single DeskEntry with its provenance block", async () => {
    const { app, adapter } = await bootDeskApp();
    const { desk_item_id } = await upsertDeskItem(
      adapter,
      {
        label: "Needs review",
        kind: "note",
        source_ref: "art_xyz",
        added_by: "agent:qa",
        provenance: { origin: "manual", source: "art_xyz" },
      },
      "agent:qa",
    );

    const { status, body } = await getJson(app, `/desk/entries/${encodeURIComponent(desk_item_id)}`);
    expect(status).toBe(200);
    expect(body.entry.kind).toBe("desk_item");
    expect(body.entry.phid).toBe(desk_item_id);
    expect(body.entry.provenance.source).toBe("art_xyz");
    expect(body.entry.provenance.origin).toBe("manual");
    expect(body.entry.provenance.actor_ref).toEqual({ type: "agent", id: "qa" });
    expect(Array.isArray(body.entry.provenance.revisions)).toBe(true);
    expect(Array.isArray(body.entry.provenance.contributors)).toBe(true);
  });

  it("404s for an unknown desk ref", async () => {
    const { app } = await bootDeskApp();
    const { status, body } = await getJson(app, "/desk/entries/desk_does_not_exist");
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/);
  });
});
