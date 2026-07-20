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
    daemon: {} as unknown as ContinuousOrchestrationDaemon,
    adapter,
    config: defaultConfig(),
    teamId: "default",
  });
});

async function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}/orchestration/backlog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const responseBody = await response.json();
        server.close(() => resolve({ status: response.status, body: responseBody }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

describe("POST /orchestration/backlog readiness boundary", () => {
  it("rejects approved_ready because it is a flesh status, without writing a shadow backlog row", async () => {
    const response = await post({ title: "invalid shadow state", readiness_state: "approved_ready" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: "invalid_readiness_state",
      field: "readiness_state",
      received: "approved_ready",
      canonical_state: "ready",
    });
    const { rows } = await adapter.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM orchestration_backlog_item WHERE readiness_state = 'approved_ready'",
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  it("keeps direct ready writes behind the existing human approval gate", async () => {
    const response = await post({ title: "requires approval", readiness_state: "ready" });

    expect(response.status).toBe(200);
    expect(response.body.item.readiness_state).toBe("needs_review");
  });
});
