import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  app = express();
  app.use(express.json());
  mountContinuousOrchestrationRoutes(app, {
    daemon: {} as ContinuousOrchestrationDaemon,
    adapter,
    config: defaultConfig(),
    teamId: "default",
  });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const parsed = await response.json();
        server.close(() => resolve({ status: response.status, body: parsed }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

describe("POST /orchestration/backlog readiness write boundary", () => {
  it("normalizes legacy approved_ready to ready and exposes it in the ready backlog view", async () => {
    const created = await call("POST", "/orchestration/backlog", {
      title: "Wave131 approved scheduler item",
      readiness_state: "approved_ready",
    });

    expect(created.status).toBe(200);
    expect(created.body.item.readiness_state).toBe("ready");

    const visible = await call("GET", "/orchestration/backlog?state=ready");
    expect(visible.status).toBe(200);
    expect(visible.body.items).toHaveLength(1);
    expect(visible.body.items[0]).toMatchObject({
      item_id: created.body.item.item_id,
      readiness_state: "ready",
    });

    const { rows } = await adapter.query<{ readiness_state: string }>(
      "SELECT readiness_state FROM orchestration_backlog_item WHERE item_id = $1",
      [created.body.item.item_id],
    );
    expect(rows[0].readiness_state).toBe("ready");
  });

  it("rejects unknown readiness states with an actionable canonical-state error", async () => {
    const response = await call("POST", "/orchestration/backlog", {
      title: "Invalid scheduler item",
      readiness_state: "approved-but-not-canonical",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: "invalid_readiness_state",
      received: "approved-but-not-canonical",
    });
    expect(response.body.message).toContain("readiness_state=ready");
    expect(response.body.allowed).toContain("ready");

    const { rows } = await adapter.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM orchestration_backlog_item",
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
