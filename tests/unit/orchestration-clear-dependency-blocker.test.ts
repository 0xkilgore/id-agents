import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import {
  clearBacklogDependencyBlocker,
  getBacklogItem,
  insertBacklogItem,
  listRecentDecisions,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";

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

async function call(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

async function seedBlockedPair(depState: "done" | "superseded" = "done") {
  const upstream = await insertBacklogItem(adapter, {
    title: "Upstream landed work",
    logical_key: "T-ORCH-upstream",
    readiness_state: "ready",
    to_agent: "roger",
    dispatch_body: "land upstream",
  });
  await setItemState(adapter, upstream.item_id, depState);
  const blocked = await insertBacklogItem(adapter, {
    title: "Ready row blocked by stale dependency",
    readiness_state: "ready",
    to_agent: "roger",
    dispatch_body: "ship downstream",
    dependencies: [upstream.item_id, "T-ORCH-upstream", "still-open"],
  });
  return { upstream: (await getBacklogItem(adapter, upstream.item_id))!, blocked };
}

describe("POST /orchestration/backlog/:id/clear-dependency-blocker", () => {
  it("requires actor and reason", async () => {
    const { upstream, blocked } = await seedBlockedPair();
    const missingActor = await call(`/orchestration/backlog/${blocked.item_id}/clear-dependency-blocker`, {
      dependency: upstream.item_id,
      reason: "upstream already landed",
    });
    expect(missingActor.status).toBe(400);
    expect(missingActor.body.reason).toBe("actor_required");

    const missingReason = await call(`/orchestration/backlog/${blocked.item_id}/clear-dependency-blocker`, {
      dependency: upstream.item_id,
      actor: "human:chris",
    });
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.reason).toBe("reason_required");
  });

  it("clears a terminal dependency and returns the audited receipt", async () => {
    const { upstream, blocked } = await seedBlockedPair("superseded");
    const res = await call(`/orchestration/backlog/${blocked.item_id}/clear-dependency-blocker`, {
      dependency: upstream.item_id,
      actor: "human:chris",
      reason: "upstream was superseded by the landed replacement",
    });

    expect(res.status).toBe(200);
    expect(res.body.item.readiness_state).toBe("ready");
    expect(res.body.item.dependencies).toEqual(["T-ORCH-upstream", "still-open"]);
    expect(res.body.dependency_state).toBe("superseded");
    expect(res.body.receipt).toMatchObject({
      actor: "human:chris",
      reason: "dependency_blocker_cleared",
      next_action: "clear_dependency_blocker",
    });
  });
});

describe("clearBacklogDependencyBlocker", () => {
  it("removes the dependency by logical key and appends a decision-log audit row", async () => {
    const { upstream, blocked } = await seedBlockedPair("done");
    const result = await clearBacklogDependencyBlocker(adapter, blocked.item_id, {
      dependency: "T-ORCH-upstream",
      actor: "operator:desk",
      reason: "landed upstream should no longer block admission",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.dependencies).toEqual([upstream.item_id, "still-open"]);
    expect(result.item.updated_by).toBe("operator:desk");

    const decisions = await listRecentDecisions(adapter, { limit: 5 });
    expect(decisions[0]).toMatchObject({
      item_id: blocked.item_id,
      action: "reconciled",
      reason: "landed upstream should no longer block admission",
    });
    expect(decisions[0].metadata).toMatchObject({
      operation: "clear_dependency_blocker",
      actor: "operator:desk",
      dependency: "T-ORCH-upstream",
      dependency_state: "done",
      dependencies_before: expect.arrayContaining(["T-ORCH-upstream", "still-open"]),
      dependencies_after: [upstream.item_id, "still-open"],
    });
  });
});
