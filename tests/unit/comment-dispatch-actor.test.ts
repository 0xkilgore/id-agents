// T-LOOP-CLOSE.1 (2026-06-22) — comment auto-dispatch acceptance test.
//
// The comment auto-dispatch feature shipped as B2 (POST /artifacts/:id/comments
// → routeCommentToOwningAgent → SchedulerHandle.enqueue). B2's own tests use a
// fake enqueue; this test proves the named acceptance END-TO-END through a REAL
// SchedulerHandle + the dispatch read-model:
//
//   "a Liz comment on a finances artifact creates a dispatch to finances with
//    source_metadata.from_actor=user:liz"
//
// i.e. the commenter's actor (via normalizeActorRef) is preserved as the
// dispatch from_actor, and the owning agent is resolved from the catalog.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { SchedulerHandle } from "../../src/dispatch-scheduler/manager-integration.js";
import { readDispatchById } from "../../src/dispatch-scheduler/read-model.js";

const TEAM = "default";
let adapter: SqliteAdapter;
let handle: SchedulerHandle;
let app: Express;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES (?, ?)`, [TEAM, TEAM]);

  // The REAL scheduler enqueue — the same path the manager binds in production.
  handle = new SchedulerHandle({ adapter, teamId: TEAM, resolveTargetUrl: () => null });
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { enqueueDispatch: handle.enqueue.bind(handle) });
});

async function call(method: "POST" | "GET", path: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
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
        let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

async function catalogArtifact(artifactId: string, agent: string) {
  await registerArtifact(
    adapter,
    {
      artifact_id: artifactId,
      basename: "q3-cash-flow.md",
      agent,
      abs_path: `/Users/kilgore/Dropbox/Code/${agent}/output/q3-cash-flow.md`,
      title: "Q3 cash flow",
      produced_at: new Date().toISOString(),
      source: "manual",
      availability: "present",
    },
    new Date().toISOString(),
  );
}

describe("comment auto-dispatch — acceptance (T-LOOP-CLOSE.1)", () => {
  it("a Liz comment on a finances artifact → dispatch to finances with source_metadata.from_actor=user:liz", async () => {
    const ART = "art-fin-1";
    await catalogArtifact(ART, "finances");

    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:liz",
      body: "Tighten the Q3 cash-flow table and flag the runway month.",
    });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(true);
    expect(res.body.dispatch.to_agent).toBe("finances");

    // Read the REAL dispatch back through the read-model and assert the
    // acceptance projection.
    const dispatch = await readDispatchById(adapter, TEAM, res.body.dispatch.dispatch_phid);
    expect(dispatch).not.toBeNull();
    expect(dispatch!.target_agent).toBe("finances");
    expect(dispatch!.source_metadata.from_actor).toBe("user:liz");
  });

  it("a Chris comment preserves from_actor=user:chris and resolves the owning agent", async () => {
    const ART = "art-pipe-1";
    await catalogArtifact(ART, "cane");

    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Route this to the pipeline owner.",
    });
    expect(res.body.dispatch.to_agent).toBe("cane");

    const dispatch = await readDispatchById(adapter, TEAM, res.body.dispatch.dispatch_phid);
    expect(dispatch!.source_metadata.from_actor).toBe("user:chris");
    expect(dispatch!.target_agent).toBe("cane");
  });

  it("rejects an unknown actor (only user:chris / user:liz route)", async () => {
    const ART = "art-x-1";
    await catalogArtifact(ART, "finances");
    const res = await call("POST", `/artifacts/${ART}/comments`, { actor_ref: "user:mallory", body: "nope" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("unknown_actor");
  });
});
