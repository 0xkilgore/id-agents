// PATCH /orchestration/backlog/:id — partial, idempotent, actor-attributed
// update of a backlog item's dispatchable fields (daemon-enable path).

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import { insertBacklogItem } from "../../src/continuous-orchestration/storage.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  app = express();
  app.use(express.json());
  // The PATCH route only touches `adapter`; a stub daemon is sufficient.
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

async function seed() {
  return insertBacklogItem(adapter, {
    title: "T-CKPT.0 skeleton",
    readiness_state: "needs_review",
    risk_class: "build",
  });
}

describe("PATCH /orchestration/backlog/:id", () => {
  it("partially updates dispatchable fields + attributes the actor", async () => {
    const item = await seed();
    const r = await call("PATCH", `/orchestration/backlog/${item.item_id}`, {
      actor_ref: "user:chris",
      to_agent: "regina",
      dispatch_body: "Build the deploy-drift banner",
      token_estimate: 100000,
      write_scope: ["kapelle-site"],
      dependencies: ["coitem_x"],
      provider: "anthropic",
      runtime: "claude-code-cli",
      value_score: 8,
      priority: 2,
      risk_class: "build",
    });
    expect(r.status).toBe(200);
    expect(r.body.item.to_agent).toBe("regina");
    expect(r.body.item.dispatch_body).toBe("Build the deploy-drift banner");
    expect(r.body.item.token_estimate).toBe(100000);
    expect(r.body.item.write_scope).toEqual(["kapelle-site"]);
    expect(r.body.item.dependencies).toEqual(["coitem_x"]);
    expect(r.body.item.priority).toBe(2);
    expect(r.body.item.value_score).toBe(8);
    expect(r.body.item.updated_by).toBe("user:chris");
    expect(r.body.updated_by).toBe("user:chris");
    // untouched
    expect(r.body.item.title).toBe("T-CKPT.0 skeleton");
    expect(r.body.item.readiness_state).toBe("needs_review");
  });

  it("is idempotent — same PATCH twice yields the same field state", async () => {
    const item = await seed();
    const patch = { actor_ref: "user:liz", to_agent: "roger", token_estimate: 50000 };
    const a = await call("PATCH", `/orchestration/backlog/${item.item_id}`, patch);
    const b = await call("PATCH", `/orchestration/backlog/${item.item_id}`, patch);
    expect(a.body.item.to_agent).toBe("roger");
    expect(b.body.item.to_agent).toBe("roger");
    expect(b.body.item.token_estimate).toBe(50000);
  });

  it("only updates supplied fields (true partial)", async () => {
    const item = await seed();
    await call("PATCH", `/orchestration/backlog/${item.item_id}`, { to_agent: "roger", token_estimate: 9000 });
    const r = await call("PATCH", `/orchestration/backlog/${item.item_id}`, { priority: 3 });
    expect(r.body.item.priority).toBe(3);
    expect(r.body.item.to_agent).toBe("roger");       // preserved
    expect(r.body.item.token_estimate).toBe(9000);    // preserved
  });

  it("404s for a non-existent item", async () => {
    const r = await call("PATCH", `/orchestration/backlog/coitem_nope`, { to_agent: "roger" });
    expect(r.status).toBe(404);
  });

  it("400s on an invalid field type", async () => {
    const item = await seed();
    const r = await call("PATCH", `/orchestration/backlog/${item.item_id}`, { token_estimate: "lots" });
    expect(r.status).toBe(400);
    expect(r.body.details.join(" ")).toMatch(/token_estimate/);
    const r2 = await call("PATCH", `/orchestration/backlog/${item.item_id}`, { write_scope: "kapelle-site" });
    expect(r2.status).toBe(400);
    const r3 = await call("PATCH", `/orchestration/backlog/${item.item_id}`, { risk_class: "bogus" });
    expect(r3.status).toBe(400);
  });
});
