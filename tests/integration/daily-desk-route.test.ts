import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import type { TasksRepository } from "../../src/db/db-service.js";
import { mountDailyDeskRoutes } from "../../src/daily-desk/routes.js";
import { migrateDailyDeskTables, upsertDailyDeskRegistration } from "../../src/daily-desk/storage.js";
import type { DailyDeskSourceSet } from "../../src/daily-desk/types.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");
let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("GET /daily-desk", () => {
  it("returns the versioned bounded manager contract once per request and fails closed on an invalid date", async () => {
    const adapter = new SqliteAdapter(":memory:");
    const app = express();
    let loadCount = 0;
    mountDailyDeskRoutes(app, adapter, {
      tasks: {} as TasksRepository,
      resolveTeamId: async () => "team-1",
      now: () => NOW,
      loadSources: async () => {
        loadCount += 1;
        return emptySource();
      },
    });
    server = await listen(app);
    const base = address(server);
    const response = await fetch(`${base}/daily-desk?today=2026-08-05`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(loadCount).toBe(1);
    expect(body).toMatchObject({
      schema_version: "daily-desk.v1",
      authority: { owner: "manager", projection: "daily_desk", state: "authoritative" },
      max_payload_bytes: 65536,
    });
    expect(response.headers.get("server-timing")).toMatch(/daily-desk-projection/);
    expect(response.headers.get("x-daily-desk-payload-bytes")).toBe(String(body.payload_bytes));
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(body.payload_bytes);

    const invalid = await fetch(`${base}/daily-desk?today=2026-02-31`);
    expect(invalid.status).toBe(400);
    expect(loadCount).toBe(1);
  });

  it("migrates and upserts only additive Daily Desk metadata", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateDailyDeskTables(adapter);
    const saved = await upsertDailyDeskRegistration(adapter, {
      team_id: "team-1", lane: "needs_response", entity_kind: "inbox", entity_id: "inbox-prod-1",
      audience: "operator", environment: "production", owner: "cane", canonical_url: "/ops/inboxes?item=inbox-prod-1",
      effective_lifecycle: "needs_response", source_as_of: "2026-08-05T11:00:00.000Z",
      admission_code: "operator_response_required", admission_detail: "unresolved production response",
      permitted_actions: ["open", "acknowledge", "open"],
    }, NOW.toISOString());
    expect(saved).toMatchObject({
      team_id: "team-1", lane: "needs_response", entity_kind: "inbox", entity_id: "inbox-prod-1",
      audience: "operator", environment: "production",
    });
    expect(JSON.parse(saved.permitted_actions_json)).toEqual(["open", "acknowledge"]);
    const tables = await adapter.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    expect(tables.rows.map((row) => row.name)).toContain("daily_desk_lane_metadata");
    expect(tables.rows.map((row) => row.name)).not.toContain("artifact_review_next_metadata");
  });
});

function emptySource(): DailyDeskSourceSet {
  return { today: [], review_next_source: [], needs_response: [], follow_through: [] };
}

async function listen(app: express.Application): Promise<Server> {
  return new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
}

function address(instance: Server): string {
  const bound = instance.address();
  if (!bound || typeof bound === "string") throw new Error("missing test port");
  return `http://127.0.0.1:${bound.port}`;
}
