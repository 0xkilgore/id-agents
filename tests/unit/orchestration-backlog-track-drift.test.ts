// POST /orchestration/backlog — track-conformance drift flagging (Spec L1b).
//
// The endpoint validates an item's `track` against the canonical-track-registry.
// A provided-but-non-conforming track is DRIFT: the item is still ingested
// (never blocked), but tagged with track_drift=true. Conforming tracks (and
// absent tracks) ingest with track_drift=false.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import { getBacklogItem } from "../../src/continuous-orchestration/storage.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  app = express();
  app.use(express.json());
  mountContinuousOrchestrationRoutes(app, {
    daemon: {} as unknown as ContinuousOrchestrationDaemon,
    adapter,
    config: defaultConfig(),
    teamId: "default",
  });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no addr")); return; }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

describe("POST /orchestration/backlog track drift", () => {
  it("flags a NON-conforming track as drift but STILL ingests the item", async () => {
    const r = await call("POST", "/orchestration/backlog", {
      title: "Mislabelled item",
      track: "T-NOPE",
    });
    expect(r.status).toBe(200); // ingested, not blocked
    expect(r.body.ok).toBe(true);
    expect(r.body.item.item_id).toBeTruthy();
    expect(r.body.item.track).toBe("T-NOPE"); // track preserved as given
    expect(r.body.item.track_drift).toBe(true);

    // Drift is persisted (countable via SQL).
    const stored = await getBacklogItem(adapter, r.body.item.item_id);
    expect(stored?.track_drift).toBe(true);
  });

  it("does NOT flag drift for a conforming canonical track", async () => {
    const r = await call("POST", "/orchestration/backlog", {
      title: "Good item",
      track: "T-ORCH",
    });
    expect(r.status).toBe(200);
    expect(r.body.item.track_drift).toBe(false);
  });

  it("does NOT flag drift for a conforming sub-track (prefix rollup)", async () => {
    const r = await call("POST", "/orchestration/backlog", {
      title: "Sub-track item",
      track: "T-CKPT.view-switcher",
    });
    expect(r.status).toBe(200);
    expect(r.body.item.track_drift).toBe(false);
  });

  it("does NOT flag drift for a conforming legacy alias", async () => {
    const r = await call("POST", "/orchestration/backlog", {
      title: "Legacy-alias item",
      track: "T15",
    });
    expect(r.status).toBe(200);
    expect(r.body.item.track_drift).toBe(false);
  });

  it("does NOT flag drift when no track is supplied", async () => {
    const r = await call("POST", "/orchestration/backlog", { title: "Untracked item" });
    expect(r.status).toBe(200);
    expect(r.body.item.track).toBeNull();
    expect(r.body.item.track_drift).toBe(false);
  });

  it("drift items are queryable via SQL for monitoring", async () => {
    await call("POST", "/orchestration/backlog", { title: "drift1", track: "garbage.thing" });
    await call("POST", "/orchestration/backlog", { title: "drift2", track: "ZZZ" });
    await call("POST", "/orchestration/backlog", { title: "ok", track: "T-ORCH" });
    const { rows } = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM orchestration_backlog_item WHERE track_drift = 1`,
    );
    expect(Number(rows[0].c)).toBe(2);
  });
});
