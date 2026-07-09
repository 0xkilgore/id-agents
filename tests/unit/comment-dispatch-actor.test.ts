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
import { assembleAgentDetail } from "../../src/agent-detail/assemble.js";
import type { CommentDispatchEnqueueFn } from "../../src/outputs/comment-dispatch.js";

const TEAM = "default";
const C0_ON = { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv;
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
  mountOutputsRoutes(app, adapter, { enqueueDispatch: handle.enqueue.bind(handle), env: C0_ON });
  mountAgentDetailRoute(app);
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

function agentDetail(name: string) {
  return assembleAgentDetail(adapter, {
    teamId: TEAM,
    name,
    agentId: `agent-${name}`,
    runtime: "codex",
    workingDirectory: null,
    consecutiveFailures: 0,
    lastError: null,
    nowIso: "2026-07-07T12:00:00.000Z",
  });
}

function mountAgentDetailRoute(targetApp: Express) {
  targetApp.get("/agents/:name/detail", async (req, res) => {
    try {
      res.json(await agentDetail(req.params.name));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
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

    const detail = await agentDetail("finances");
    expect(detail.recent_comment_receipts[0]).toMatchObject({
      artifact_id: ART,
      artifact_title: "Q3 cash flow",
      actor: "user:liz",
      route_status: "routed",
      timestamp: expect.any(String),
      visible_state: "recorded+routed",
      retryable: false,
      target_agent: "finances",
      target_agent_raw: "finances",
      dispatch_id: res.body.dispatch.dispatch_phid,
      query_id: res.body.dispatch.query_id,
      failure_reason: null,
    });

    const detailApi = await call("GET", "/agents/finances/detail");
    expect(detailApi.status).toBe(200);
    expect(detailApi.body.recent_comment_receipts[0]).toMatchObject({
      artifact_id: ART,
      artifact_title: "Q3 cash flow",
      actor: "user:liz",
      timestamp: expect.any(String),
      route_status: "routed",
      visible_state: "recorded+routed",
      target_agent: "finances",
      dispatch_id: res.body.dispatch.dispatch_phid,
      query_id: res.body.dispatch.query_id,
    });
  });

  it("resolves project:<slug> catalog owners before enqueueing so route status is recorded+routed", async () => {
    const ART = "art-fin-project-owner";
    await catalogArtifact(ART, "project:finances");

    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:liz",
      body: "Please reconcile the recurring subscriptions section.",
    });

    expect(res.status).toBe(200);
    expect(res.body.visible_state).toBe("recorded+routed");
    expect(res.body.dispatch_routed).toBe(true);
    expect(res.body.dispatch.to_agent).toBe("finances");
    expect(res.body.route_status).toMatchObject({
      visible_state: "recorded+routed",
      target_agent: "finances",
      target_agent_raw: "project:finances",
    });

    const dispatch = await readDispatchById(adapter, TEAM, res.body.dispatch.dispatch_phid);
    expect(dispatch).not.toBeNull();
    expect(dispatch!.target_agent).toBe("finances");

    const comments = await call("GET", `/artifacts/${ART}/comments`);
    expect(comments.body.comments[0].route_status).toMatchObject({
      visible_state: "recorded+routed",
      target_agent: "finances",
      target_agent_raw: "project:finances",
    });
  });

  it("shows project:<slug> route failures in the owning agent timeline with retry metadata", async () => {
    const calls: unknown[] = [];
    const failingEnqueue: CommentDispatchEnqueueFn = async (input) => {
      calls.push(input);
      throw new Error("scheduler unavailable for project owner");
    };
    app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, { enqueueDispatch: failingEnqueue, env: C0_ON });
    mountAgentDetailRoute(app);

    const ART = "art-fin-project-failed";
    await catalogArtifact(ART, "project:finances");

    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Please rerun the totals section.",
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.body.visible_state).toBe("recorded-route-failed-retryable");
    expect(res.body.feedback_status).toBe("recorded-route-failed-retryable");
    expect(res.body.route_status).toMatchObject({
      routed: false,
      retryable: true,
      target_agent: "finances",
      target_agent_raw: "project:finances",
      error: { message: "scheduler unavailable for project owner" },
    });

    const detail = await agentDetail("finances");
    expect(detail.recent_comment_receipts[0]).toMatchObject({
      artifact_id: ART,
      artifact_title: "Q3 cash flow",
      actor: "user:chris",
      route_status: "recorded-but-route-failed",
      timestamp: expect.any(String),
      visible_state: "recorded-route-failed-retryable",
      retryable: true,
      target_agent: "finances",
      target_agent_raw: "project:finances",
      dispatch_id: null,
      query_id: null,
      failure_reason: "scheduler unavailable for project owner",
      retry_metadata: {
        retryable: true,
        skipped: null,
        error: { message: "scheduler unavailable for project owner" },
      },
    });

    const detailApi = await call("GET", "/agents/finances/detail");
    expect(detailApi.status).toBe(200);
    expect(detailApi.body.recent_comment_receipts[0]).toMatchObject({
      artifact_id: ART,
      artifact_title: "Q3 cash flow",
      actor: "user:chris",
      timestamp: expect.any(String),
      route_status: "recorded-but-route-failed",
      visible_state: "recorded-route-failed-retryable",
      retryable: true,
      target_agent: "finances",
      target_agent_raw: "project:finances",
      dispatch_id: null,
      query_id: null,
      failure_reason: "scheduler unavailable for project owner",
      retry_metadata: {
        retryable: true,
        skipped: null,
        error: { message: "scheduler unavailable for project owner" },
        updated_at: expect.any(String),
      },
    });
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
