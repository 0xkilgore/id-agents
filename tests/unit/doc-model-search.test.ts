// DV3 — unified doc-model FTS search (/search).

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { registerArtifact } from "../../src/outputs/storage.js";
import { mountDocModelSearchRoutes } from "../../src/doc-model/routes.js";
import { searchDocModel } from "../../src/doc-model/search.js";
import { upsertDeskItem } from "../../src/desk/storage.js";

const NOW = "2026-06-26T18:00:00.000Z";

async function seedSearchFixture(adapter: SqliteAdapter) {
  await migrateSqlite(adapter);

  await registerArtifact(
    adapter,
    {
      basename: "ops-walk.png",
      agent: "rams",
      tag: "research",
      abs_path: "/output/research/ops-walk.png",
      title: "Ops walk screenshot",
      produced_at: NOW,
      source: "delivery-log",
    },
    NOW,
  );
  await registerArtifact(
    adapter,
    {
      basename: "note.md",
      agent: "roger",
      tag: "spec",
      abs_path: "/output/note.md",
      title: "Unrelated note",
      produced_at: NOW,
      source: "delivery-log",
    },
    NOW,
  );

  await upsertDeskItem(adapter, {
    label: "Review ops walk findings",
    kind: "note",
    body_md: "Shadow hash rows still appear in inbox triage.",
    source_ref: "art-shadow",
    added_at: NOW,
    added_by: "user:chris",
  });

  await adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, track)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "tsk_search",
      "audit-inbox-shadow",
      "uuid-search-1",
      null,
      "Audit inbox shadow rows",
      "Find and fix shadow hash display in inbox list.",
      "todo",
      null,
      null,
      1782510000,
      1782513600,
      "T-CKPT",
    ],
  );
}

async function bootSearchApp() {
  const adapter = new SqliteAdapter(":memory:");
  await seedSearchFixture(adapter);
  const app = express();
  app.use(express.json());
  mountDocModelSearchRoutes(app, adapter);
  return { app, adapter };
}

function getJson(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const body = await response.json();
        server.close(() => resolve({ status: response.status, body }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

describe("searchDocModel", () => {
  it("finds artifacts, desk items, and tasks across the doc-model", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedSearchFixture(adapter);

    const { items } = await searchDocModel(adapter, "shadow");
    const kinds = items.map((item) => item.kind);
    expect(kinds).toContain("desk_item");
    expect(kinds).toContain("task");
    expect(items.some((item) => item.kind === "artifact" && item.display_id === "ops-walk.png")).toBe(false);
  });

  it("finds PNG/asset artifacts by basename token", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedSearchFixture(adapter);

    const { items } = await searchDocModel(adapter, "png", { kinds: ["artifact"] });
    expect(items).toHaveLength(1);
    expect(items[0].display_id).toBe("ops-walk.png");
    expect(items[0].title).toBe("Ops walk screenshot");
  });

  it("respects kind filters and empty queries", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedSearchFixture(adapter);

    const deskOnly = await searchDocModel(adapter, "ops", { kinds: ["desk_item"] });
    expect(deskOnly.items.every((item) => item.kind === "desk_item")).toBe(true);

    const empty = await searchDocModel(adapter, "   ");
    expect(empty.items).toEqual([]);
  });
});

describe("GET /search (DV3 read-model route)", () => {
  it("returns ranked hits in the read-model envelope", async () => {
    const { app } = await bootSearchApp();
    const { status, body } = await getJson(app, "/search?q=shadow");
    expect(status).toBe(200);
    expect(body.schema_version).toBe("read-model.v1");
    expect(body.source).toEqual({ read_path: "substrate", projection: "doc_model_search" });
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(body.items.some((item: any) => item.kind === "desk_item")).toBe(true);
    expect(body.items.some((item: any) => item.kind === "task")).toBe(true);
  });

  it("supports kind filtering and bounded limits", async () => {
    const { app } = await bootSearchApp();
    const { status, body } = await getJson(app, "/search?q=ops&kind=artifact&limit=1");
    expect(status).toBe(200);
    expect(body.limit).toBe(1);
    expect(body.items.every((item: any) => item.kind === "artifact")).toBe(true);
  });

  it("rejects external web lane queries", async () => {
    const { app } = await bootSearchApp();
    const { status, body } = await getJson(app, "/search?q=web:shadow");
    expect(status).toBe(400);
    expect(body.reason).toBe("external_lane_disabled");
  });

  it("returns an empty envelope for blank q", async () => {
    const { app } = await bootSearchApp();
    const { status, body } = await getJson(app, "/search?q=");
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });
});
