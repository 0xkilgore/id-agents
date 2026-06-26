// Desk tray read-model — unit tests (projection + storage + parity + routes).

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { insertDecision, migrateDecisionsTables } from "../../src/decisions/storage.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
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

async function bootDeskHarness(): Promise<{ app: Express; adapter: SqliteAdapter }> {
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
  return { app, adapter };
}

async function bootDeskApp(): Promise<Express> {
  const { app } = await bootDeskHarness();
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

  it("matches the Desk UI contract for needs_you and shipped tray columns", async () => {
    const { app, adapter } = await bootDeskHarness();
    await upsertDeskItem(adapter, {
      label: "Tickler due soon",
      kind: "tickler",
      body_md: "Follow up on the partner memo",
      source_ref: "tickler:due-soon",
      tray_zone: "needs_you",
      added_at: "2026-06-25T12:30:00.000Z",
      added_by: "substrate-api-codex",
      provenance: {
        source_path: "/tmp/Desk.md",
        anchor: "tickler-due-soon",
      },
    });
    await upsertDeskItem(adapter, {
      label: "Dismissed note",
      kind: "note",
      tray_state: "dismissed",
      added_at: "2026-06-25T12:20:00.000Z",
    });
    await upsertDeskItem(adapter, {
      label: "FYI note",
      kind: "note",
      desk_class: "fyi",
      added_at: "2026-06-25T12:10:00.000Z",
    });
    await insertDecision(adapter, {
      decision_id: "dec_contract_shape",
      display_id: "D-TRAY",
      title: "Approve Desk tray contract?",
      question: "Confirm the Desk UI can render the tray response without adapters.",
      context_excerpt: null,
      recommendation_json: null,
      options_json: null,
      status: "open",
      estimated_seconds: 45,
      priority: "high",
      owner: "chris",
      requested_by: "maestra",
      created_at: "2026-06-25T13:00:00.000Z",
      updated_at: "2026-06-25T13:00:00.000Z",
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      selected_option_id: null,
      source_refs_json: "[]",
      provenance_json: "{}",
    });
    await registerArtifact(adapter, {
      artifact_id: "art_contract_shape",
      basename: "desk-contract.md",
      agent: "roger",
      tag: "qa",
      abs_path: "/tmp/desk-contract.md",
      title: "Desk contract artifact",
      produced_at: "2026-06-25T11:00:00.000Z",
      source: "agent-done",
    }, NOW);

    const { status, body } = await getJson(app, "/desk/tray");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      schema_version: "desk.tray.v1",
      generated_at: NOW,
      source: {
        system: "manager",
        projection: "desk_tray",
        source_type: "hybrid_projection",
        read_path: "substrate",
      },
      freshness: {
        last_ingest_at: NOW,
        auto_ingest: false,
        stale_after_s: 900,
      },
      provenance: {
        parser_version: "desk.tray.v1",
        markdown_source: null,
      },
      parity: {
        status: "ok",
        checked_at: NOW,
      },
      filters: {
        desk_class: "tray",
        tray_state: "on_desk",
      },
      counts: {
        on_desk: 3,
        needs_you: 2,
        shipped: 1,
        dismissed: 1,
        acted: 0,
      },
      warnings: [],
    });
    expect(body.items).toHaveLength(3);
    expect(body.items.map((item: { label: string }) => item.label)).toEqual([
      "Approve Desk tray contract?",
      "Tickler due soon",
      "Desk contract artifact",
    ]);
    expect(body.items.some((item: { label: string }) => item.label === "Dismissed note")).toBe(false);
    expect(body.items.some((item: { label: string }) => item.label === "FYI note")).toBe(false);

    const bySourceRef = new Map(
      body.items.map((item: { source_ref: string | null }) => [item.source_ref, item]),
    );
    expect(bySourceRef.get("dec_contract_shape")).toMatchObject({
      desk_item_id: "desk_dec_contract_shape",
      label: "Approve Desk tray contract?",
      kind: "decision",
      desk_class: "tray",
      tray_zone: "needs_you",
      body_md: "Confirm the Desk UI can render the tray response without adapters.",
      source_ref: "dec_contract_shape",
      added_at: "2026-06-25T13:00:00.000Z",
      added_by: "maestra",
      tray_state: "on_desk",
      dismissed_at: null,
      href: "/ops/decisions/dec_contract_shape",
      priority: "high",
      provenance: {
        source_path: null,
        anchor: null,
        parser_version: "desk.tray.v1",
        source_ref: "dec_contract_shape",
      },
    });
    expect(bySourceRef.get("tickler:due-soon")).toMatchObject({
      label: "Tickler due soon",
      kind: "tickler",
      desk_class: "tray",
      tray_zone: "needs_you",
      body_md: "Follow up on the partner memo",
      source_ref: "tickler:due-soon",
      added_by: "substrate-api-codex",
      tray_state: "on_desk",
      href: null,
      priority: null,
      provenance: {
        source_path: "/tmp/Desk.md",
        anchor: "tickler-due-soon",
        parser_version: "desk.producer.v1",
        source_ref: "tickler:due-soon",
      },
    });
    expect(bySourceRef.get("art_contract_shape")).toMatchObject({
      desk_item_id: "desk_art_contract_shape",
      label: "Desk contract artifact",
      kind: "artifact",
      desk_class: "tray",
      tray_zone: "shipped",
      body_md: "/tmp/desk-contract.md",
      source_ref: "art_contract_shape",
      added_at: "2026-06-25T11:00:00.000Z",
      added_by: "roger",
      tray_state: "on_desk",
      dismissed_at: null,
      href: "/ops/artifacts/art_contract_shape",
      priority: null,
      provenance: {
        source_path: null,
        anchor: null,
        parser_version: "desk.tray.v1",
        source_ref: "art_contract_shape",
      },
    });
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
