// Desk tray read-model — unit tests (projection + storage + parity + routes).

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateDecisionsTables } from "../../src/decisions/storage.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountDeskRoutes } from "../../src/desk/routes.js";
import {
  migrateDeskTables,
  upsertDeskItem,
  listDeskItems,
  deriveDeskItemId,
} from "../../src/desk/storage.js";
import {
  buildDeskTrayEnvelope,
  deskRowToTrayItem,
  artifactInboxToTrayItem,
  decisionRowToTrayItem,
} from "../../src/desk/projection.js";
import { computeDeskParity, countDeskMarkdownTrayLines } from "../../src/desk/parity.js";
import type { DecisionRow } from "../../src/decisions/types.js";
import type { OutputsInboxRow } from "../../src/outputs/types.js";

const NOW = "2026-06-25T12:00:00.000Z";

describe("deriveDeskItemId", () => {
  it("is stable for the same label+source+timestamp", () => {
    const a = deriveDeskItemId("Review artifact", "art_abc", NOW);
    const b = deriveDeskItemId("Review artifact", "art_abc", NOW);
    expect(a).toBe(b);
    expect(a.startsWith("desk_")).toBe(true);
  });
});

describe("buildDeskTrayEnvelope", () => {
  it("returns desk.tray.v1 with tray/on_desk rows only in items", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateDeskTables(adapter);
    await upsertDeskItem(adapter, {
      label: "Needs review",
      kind: "note",
      tray_zone: "needs_you",
      added_at: NOW,
    });
    await upsertDeskItem(adapter, {
      label: "Dismissed item",
      kind: "note",
      tray_state: "dismissed",
      added_at: NOW,
    });
    const rows = await listDeskItems(adapter);
    const envelope = buildDeskTrayEnvelope({
      generatedAt: NOW,
      deskRows: rows,
      env: { DESK_USE_DOCUMENT_MODEL: "true" },
    });
    expect(envelope.schema_version).toBe("desk.tray.v1");
    expect(envelope.source.read_path).toBe("substrate");
    expect(envelope.filters).toEqual({ desk_class: "tray", tray_state: "on_desk" });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0].label).toBe("Needs review");
    expect(envelope.items[0].tray_zone).toBe("needs_you");
  });

  it("federates open decisions into needs_you and unread artifacts into shipped", () => {
    const decision: DecisionRow = {
      decision_id: "dec_test_1",
      display_id: "D-1",
      title: "Approve tiers?",
      question: "Confirm vendor tiers",
      context_excerpt: null,
      recommendation_json: null,
      options_json: null,
      status: "open",
      estimated_seconds: 30,
      priority: "high",
      owner: "chris",
      requested_by: "maestra",
      created_at: NOW,
      updated_at: NOW,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      selected_option_id: null,
      source_refs_json: "[]",
      provenance_json: "{}",
    };
    const artifact: OutputsInboxRow = {
      artifact_id: "art_shipped_1",
      source_link: null,
      title: "New report",
      basename: "report.md",
      agent: "roger",
      produced_at: NOW,
      abs_path: "/abs/report.md",
      tag: "pipeline",
      availability: "present",
      status: "never_viewed",
      first_viewed_at: null,
      approved_at: null,
      shipped_at: null,
      ship_blockers_json: null,
      op_count: 0,
      last_op_at: null,
    };

    const envelope = buildDeskTrayEnvelope({
      generatedAt: NOW,
      deskRows: [],
      openDecisions: [decision],
      artifactInboxRows: [artifact],
      env: { DESK_USE_DOCUMENT_MODEL: "true" },
    });

    expect(envelope.counts.needs_you).toBe(1);
    expect(envelope.counts.shipped).toBe(1);
    expect(envelope.counts.on_desk).toBe(2);
    expect(envelope.items.some((i) => i.kind === "decision" && i.tray_zone === "needs_you")).toBe(true);
    expect(envelope.items.some((i) => i.kind === "artifact" && i.tray_zone === "shipped")).toBe(true);
    expect(envelope.source.source_type).toBe("hybrid_projection");
  });

  it("does not duplicate federated rows when already persisted by source_ref", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateDeskTables(adapter);
    await upsertDeskItem(adapter, {
      label: "Already on desk",
      kind: "decision",
      source_ref: "dec_dup",
      tray_zone: "needs_you",
      added_at: NOW,
    });
    const rows = await listDeskItems(adapter);
    const decision: DecisionRow = {
      decision_id: "dec_dup",
      display_id: null,
      title: "Dup",
      question: "Q",
      context_excerpt: null,
      recommendation_json: null,
      options_json: null,
      status: "open",
      estimated_seconds: null,
      priority: "normal",
      owner: "chris",
      requested_by: null,
      created_at: NOW,
      updated_at: NOW,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      selected_option_id: null,
      source_refs_json: "[]",
      provenance_json: "{}",
    };
    const envelope = buildDeskTrayEnvelope({
      generatedAt: NOW,
      deskRows: rows,
      openDecisions: [decision],
      env: { DESK_USE_DOCUMENT_MODEL: "true" },
    });
    expect(envelope.items.filter((i) => i.source_ref === "dec_dup")).toHaveLength(1);
  });
});

describe("deskRowToTrayItem", () => {
  it("maps storage row to tray item with href for artifacts", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateDeskTables(adapter);
    await upsertDeskItem(adapter, {
      label: "Artifact review",
      kind: "artifact",
      source_ref: "art_xyz",
      tray_zone: "shipped",
      added_at: NOW,
    });
    const row = (await listDeskItems(adapter))[0];
    const item = deskRowToTrayItem(row);
    expect(item.href).toBe("/ops/artifacts/art_xyz");
    expect(item.tray_zone).toBe("shipped");
  });
});

describe("artifactInboxToTrayItem + decisionRowToTrayItem", () => {
  it("assigns shipped zone to artifacts and needs_you to decisions", () => {
    const art = artifactInboxToTrayItem({
      artifact_id: "art_a",
      source_link: null,
      title: "T",
      basename: "a.md",
      agent: "roger",
      produced_at: NOW,
      abs_path: "/a.md",
      tag: null,
      availability: "present",
      status: "never_viewed",
      first_viewed_at: null,
      approved_at: null,
      shipped_at: null,
      ship_blockers_json: null,
      op_count: 0,
      last_op_at: null,
    });
    expect(art.tray_zone).toBe("shipped");
    expect(art.kind).toBe("artifact");

    const dec = decisionRowToTrayItem({
      decision_id: "dec_b",
      display_id: null,
      title: "Choose",
      question: "Which?",
      context_excerpt: null,
      recommendation_json: null,
      options_json: null,
      status: "open",
      estimated_seconds: 60,
      priority: "normal",
      owner: "chris",
      requested_by: "system",
      created_at: NOW,
      updated_at: NOW,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      selected_option_id: null,
      source_refs_json: "[]",
      provenance_json: "{}",
    });
    expect(dec.tray_zone).toBe("needs_you");
    expect(dec.kind).toBe("decision");
  });
});

async function bootDeskApp(): Promise<Express> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateDeskTables(adapter);
  await migrateOutputsTables(adapter);
  await migrateDecisionsTables(adapter);
  const app = express();
  app.use(express.json());
  mountDeskRoutes(app, adapter, {
    now: () => new Date("2026-06-25T12:00:00.000Z"),
    deskMarkdownPath: "/nonexistent/Desk.md",
    env: { DESK_USE_DOCUMENT_MODEL: "true" },
  });
  return app;
}

function getJson(app: Express, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, init);
        const body = await r.json();
        server.close(() => resolve({ status: r.status, body }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

describe("GET /desk/tray + POST /desk/items", () => {
  it("serves desk.tray.v1 from substrate (read_path:substrate)", async () => {
    const app = await bootDeskApp();
    const { status, body } = await getJson(app, "/desk/tray");
    expect(status).toBe(200);
    expect(body.schema_version).toBe("desk.tray.v1");
    expect(body.source.read_path).toBe("substrate");
    expect(body.source.projection).toBe("desk_tray");
    expect(body.filters).toEqual({ desk_class: "tray", tray_state: "on_desk" });
  });

  it("upserts a desk item via POST /desk/items", async () => {
    const app = await bootDeskApp();
    const { status, body } = await getJson(app, "/desk/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Review spec", kind: "note", tray_zone: "needs_you" }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("inserted");
    expect(body.desk_item_id).toMatch(/^desk_/);

    const tray = await getJson(app, "/desk/tray");
    expect(tray.body.items).toHaveLength(1);
    expect(tray.body.items[0].label).toBe("Review spec");
  });

  it("rejects POST /desk/items without label", async () => {
    const app = await bootDeskApp();
    const { status, body } = await getJson(app, "/desk/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "note" }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe("label_required");
  });
});

describe("desk parity", () => {
  it("counts bullet lines under tray headings", () => {
    const md = [
      "# Desk",
      "## 📥 AWAITING YOU",
      "- Item one",
      "- Item two",
      "## 🔥 Right now",
    ].join("\n");
    expect(countDeskMarkdownTrayLines(md)).toBe(2);
  });

  it("reports ok when markdown source is absent", () => {
    const report = computeDeskParity([], null, NOW);
    expect(report.status).toBe("ok");
  });
});
