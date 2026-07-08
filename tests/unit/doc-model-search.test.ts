// DV3 — unified doc-model FTS search (/search).

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import type { DbAdapter, QueryResult } from "../../src/db/db-adapter.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { registerArtifact } from "../../src/outputs/storage.js";
import { mountDocModelSearchRoutes } from "../../src/doc-model/routes.js";
import { searchDocModel } from "../../src/doc-model/search.js";
import { upsertDeskItem } from "../../src/desk/storage.js";

const NOW = "2026-06-26T18:00:00.000Z";

type SeedArtifact = {
  artifact_id: string;
  basename: string;
  agent: string;
  tag: string | null;
  abs_path: string;
  title: string | null;
  produced_at: string;
  source: string;
  availability: string;
  source_badges: string;
  reconciled_at: string | null;
  created_at: string;
  updated_at: string;
};

type SeedDeskItem = {
  desk_item_id: string;
  label: string;
  kind: string;
  desk_class: string;
  tray_zone: string;
  body_md: string;
  source_ref: string | null;
  added_at: string;
  added_by: string;
  tray_state: string;
  dismissed_at: string | null;
  provenance_json: string;
};

type SeedTask = {
  id: string;
  name: string;
  uuid: string | null;
  team_id: string | null;
  title: string;
  description: string | null;
  status: string;
  created_by: string | null;
  owner: string | null;
  created_at: number;
  updated_at: number;
  track: string;
};

class MemoryPostgresDocModelAdapter implements DbAdapter {
  readonly dialect = "postgres" as const;
  artifacts: SeedArtifact[] = [];
  deskItems: SeedDeskItem[] = [];
  tasks: SeedTask[] = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (/^\s*INSERT INTO artifacts\b/i.test(sql)) {
      this.artifacts.push({
        artifact_id: String(params[0]),
        basename: String(params[1]),
        agent: String(params[2]),
        tag: params[3] == null ? null : String(params[3]),
        abs_path: String(params[4]),
        title: params[5] == null ? null : String(params[5]),
        produced_at: String(params[6]),
        source: String(params[7]),
        availability: String(params[8]),
        source_badges: String(params[9]),
        reconciled_at: params[10] == null ? null : String(params[10]),
        created_at: String(params[11]),
        updated_at: String(params[12]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*INSERT INTO desk_items\b/i.test(sql)) {
      this.deskItems.push({
        desk_item_id: String(params[0]),
        label: String(params[1]),
        kind: String(params[2]),
        desk_class: String(params[3]),
        tray_zone: String(params[4]),
        body_md: String(params[5]),
        source_ref: params[6] == null ? null : String(params[6]),
        added_at: String(params[7]),
        added_by: String(params[8]),
        tray_state: String(params[9]),
        dismissed_at: params[10] == null ? null : String(params[10]),
        provenance_json: String(params[11]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*INSERT INTO tasks\b/i.test(sql)) {
      this.tasks.push({
        id: String(params[0]),
        name: String(params[1]),
        uuid: params[2] == null ? null : String(params[2]),
        team_id: params[3] == null ? null : String(params[3]),
        title: String(params[4]),
        description: params[5] == null ? null : String(params[5]),
        status: String(params[6]),
        created_by: params[7] == null ? null : String(params[7]),
        owner: params[8] == null ? null : String(params[8]),
        created_at: Number(params[9]),
        updated_at: Number(params[10]),
        track: String(params[11]),
      });
      return { rows: [], rowCount: 1 };
    }

    const limit = Number(params[1] ?? 50);
    if (/\bFROM artifacts a\b/i.test(sql)) {
      return { rows: this.searchArtifacts(String(params[0]), limit) as T[], rowCount: 0 };
    }
    if (/\bFROM desk_items d\b/i.test(sql)) {
      return { rows: this.searchDeskItems(String(params[0]), limit) as T[], rowCount: 0 };
    }
    if (/\bFROM tasks t\b/i.test(sql)) {
      return { rows: this.searchTasks(String(params[0]), limit) as T[], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  async close(): Promise<void> {}

  private tokens(query: string): string[] {
    return query.split(/\s*&\s*/).map((part) => part.replace(/:\*$/, "").toLowerCase()).filter(Boolean);
  }

  private matches(query: string, text: string): boolean {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return this.tokens(query).every((token) => words.some((word) => word.startsWith(token)));
  }

  private searchArtifacts(query: string, limit: number) {
    return this.artifacts
      .filter((row) => this.matches(query, `${row.title ?? ""} ${row.basename} ${row.tag ?? ""} ${row.agent}`))
      .map((row) => ({
        phid: row.artifact_id,
        title: row.title ?? row.basename,
        display_id: row.basename,
        score: -1,
        updated_at: row.produced_at,
      }))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.phid.localeCompare(b.phid))
      .slice(0, limit);
  }

  private searchDeskItems(query: string, limit: number) {
    return this.deskItems
      .filter((row) => this.matches(query, `${row.label} ${row.body_md} ${row.kind} ${row.source_ref ?? ""}`))
      .map((row) => ({
        phid: row.desk_item_id,
        title: row.label,
        score: -1,
        updated_at: row.dismissed_at ?? row.added_at,
      }))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.phid.localeCompare(b.phid))
      .slice(0, limit);
  }

  private searchTasks(query: string, limit: number) {
    return this.tasks
      .filter((row) => this.matches(query, `${row.name} ${row.title} ${row.description ?? ""} ${row.track} ${row.status}`))
      .map((row) => ({
        phid: row.uuid && row.uuid !== "" ? row.uuid : row.id,
        title: row.title,
        display_id: row.name,
        score: -1,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }))
      .sort((a, b) => a.updated_at - b.updated_at || a.phid.localeCompare(b.phid))
      .slice(0, limit);
  }
}

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

async function seedIdenticalSearchRows(adapter: DbAdapter) {
  if (adapter.dialect === "sqlite") {
    await migrateSqlite(adapter as SqliteAdapter);
  }

  await adapter.query(
    `INSERT INTO artifacts
       (artifact_id, basename, agent, tag, abs_path, title, produced_at, source,
        availability, source_badges, reconciled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "art_ops_walk",
      "ops-walk.png",
      "rams",
      "research",
      "/output/research/ops-walk.png",
      "Ops walk screenshot",
      NOW,
      "delivery-log",
      "present",
      "[]",
      null,
      NOW,
      NOW,
    ],
  );
  await adapter.query(
    `INSERT INTO artifacts
       (artifact_id, basename, agent, tag, abs_path, title, produced_at, source,
        availability, source_badges, reconciled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "art_note",
      "note.md",
      "roger",
      "spec",
      "/output/note.md",
      "Unrelated note",
      NOW,
      "delivery-log",
      "present",
      "[]",
      null,
      NOW,
      NOW,
    ],
  );
  await adapter.query(
    `INSERT INTO desk_items
       (desk_item_id, label, kind, desk_class, tray_zone, body_md, source_ref,
        added_at, added_by, tray_state, dismissed_at, provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "desk_shadow",
      "Review ops walk findings",
      "note",
      "tray",
      "needs_you",
      "Shadow hash rows still appear in inbox triage.",
      "art-shadow",
      NOW,
      "user:chris",
      "on_desk",
      null,
      "{}",
    ],
  );
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

function comparableHits(items: Awaited<ReturnType<typeof searchDocModel>>["items"]) {
  return items.map((item) => ({
    kind: item.kind,
    phid: item.phid,
    title: item.title,
    display_id: item.display_id,
    created_at: item.created_at,
    updated_at: item.updated_at,
  })).sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.phid.localeCompare(b.phid) ||
    String(a.display_id ?? "").localeCompare(String(b.display_id ?? "")),
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
    expect(items.find((item) => item.kind === "task")).toMatchObject({
      created_at: "2026-06-26T21:40:00.000Z",
      updated_at: "2026-06-26T22:40:00.000Z",
    });
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

  it("returns equivalent SQLite/Postgres results for identical doc-model rows", async () => {
    const sqlite = new SqliteAdapter(":memory:");
    const postgres = new MemoryPostgresDocModelAdapter();
    await seedIdenticalSearchRows(sqlite);
    await seedIdenticalSearchRows(postgres);

    const sqliteShadow = await searchDocModel(sqlite, "shadow");
    const postgresShadow = await searchDocModel(postgres, "shadow");
    expect(comparableHits(postgresShadow.items)).toEqual(comparableHits(sqliteShadow.items));

    const sqliteArtifact = await searchDocModel(sqlite, "png", { kinds: ["artifact"] });
    const postgresArtifact = await searchDocModel(postgres, "png", { kinds: ["artifact"] });
    expect(comparableHits(postgresArtifact.items)).toEqual(comparableHits(sqliteArtifact.items));
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
    expect(body.items.find((item: any) => item.kind === "task")).toMatchObject({
      created_at: "2026-06-26T21:40:00.000Z",
    });
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
