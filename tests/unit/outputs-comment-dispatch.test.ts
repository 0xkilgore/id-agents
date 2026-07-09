// B2 (2026-06-22) — comment auto-dispatch: a submitted artifact comment is
// routed to the artifact's owning agent as a real dispatch, while the durable
// comment capture is preserved even when routing degrades or fails.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import type { CommentDispatchEnqueueFn } from "../../src/outputs/comment-dispatch.js";

const ART = "art-b2-1";

interface EnqueueCall {
  to_agent: string;
  from_actor: string;
  message: string;
  subject?: string;
  priority?: number;
}

// Records every enqueue and returns a deterministic receipt. `throws` flips it
// into the failure path to prove durable capture survives a routing crash.
function makeFakeEnqueue(opts: { throws?: boolean } = {}): {
  fn: CommentDispatchEnqueueFn;
  calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  const fn: CommentDispatchEnqueueFn = async (input) => {
    calls.push(input);
    if (opts.throws) throw new Error("scheduler boom");
    return { query_id: "q-b2-1", dispatch_phid: "phid:disp-b2-1", status: "queued" };
  };
  return { fn, calls };
}

async function buildApp(enqueue?: CommentDispatchEnqueueFn): Promise<{
  app: Express;
  adapter: SqliteAdapter;
}> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { enqueueDispatch: enqueue });
  return { app, adapter };
}

async function catalogArtifact(adapter: SqliteAdapter, agent: string): Promise<void> {
  await registerArtifact(
    adapter,
    {
      artifact_id: ART,
      basename: "b2-plan.md",
      agent,
      abs_path: "/Users/kilgore/Dropbox/Code/regina/output/b2-plan.md",
      title: "B2 ops plan",
      produced_at: new Date().toISOString(),
      source: "manual",
      availability: "present",
    },
    new Date().toISOString(),
  );
}

async function call(
  app: Express,
  method: "POST" | "GET",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
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

describe("POST /artifacts/:id/comments — B2 auto-dispatch", () => {
  it("routes the comment to the artifact's owning agent and returns a receipt", async () => {
    const { fn, calls } = makeFakeEnqueue();
    const { app, adapter } = await buildApp(fn);
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Tighten the hero hierarchy.",
      anchor: "L42",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.route_kind).toBe("substantive_follow_up");
    expect(res.body.dispatch_routed).toBe(true);
    expect(res.body.dispatch).toMatchObject({
      query_id: "q-b2-1",
      dispatch_phid: "phid:disp-b2-1",
      to_agent: "regina",
    });
    expect(res.body.visible_state).toBe("recorded+routed");
    expect(res.body.feedback_status).toBe("recorded+routed");
    expect(res.body.route_status).toMatchObject({
      visible_state: "recorded+routed",
      compat_status: "recorded+routed",
      feedback_status: "recorded+routed",
      route_kind: "substantive_follow_up",
      routed: true,
      retryable: false,
      recorded_op_id: res.body.op_id,
      target_agent: "regina",
      target_agent_raw: "regina",
      dispatch: {
        query_id: "q-b2-1",
        dispatch_phid: "phid:disp-b2-1",
        to_agent: "regina",
      },
    });

    // the dispatch carried the right routing + payload
    expect(calls).toHaveLength(1);
    expect(calls[0].to_agent).toBe("regina");
    expect(calls[0].from_actor).toBe("user:chris");
    expect(calls[0].message).toContain("Tighten the hero hierarchy.");
    expect(calls[0].message).toContain(ART);
    expect(calls[0].message).toContain("L42");

    // and the comment is still durable
    const get = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(get.body.comments).toHaveLength(1);
    expect(get.body.comments[0].body).toBe("Tighten the hero hierarchy.");
    expect(get.body.comments[0].route_status).toMatchObject({
      visible_state: "recorded+routed",
      target_agent: "regina",
      dispatch: { dispatch_phid: "phid:disp-b2-1" },
    });
  });

  it("classifies approval-signal comments as artifact approvals without dispatching", async () => {
    const { fn, calls } = makeFakeEnqueue();
    const { app, adapter } = await buildApp(fn);
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Ship it",
    });

    expect(res.status).toBe(200);
    expect(res.body.route_kind).toBe("approval_signal");
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch_skipped).toBe("approval_signal");
    expect(res.body.approval.state.approved_by).toBe("user:chris");
    expect(res.body.approval.state.approval_note).toBe("Ship it");
    expect(calls).toHaveLength(0);

    const { rows } = await adapter.query<{ approved_at: string | null; approved_by: string | null }>(
      `SELECT approved_at, approved_by FROM artifact_review_state WHERE artifact_id = ?`,
      [ART],
    );
    expect(rows[0].approved_at).toBeTruthy();
    expect(rows[0].approved_by).toBe("user:chris");
  });

  it("classifies questions as artifact-thread comments without dispatching or approving", async () => {
    const { fn, calls } = makeFakeEnqueue();
    const { app, adapter } = await buildApp(fn);
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:liz",
      body: "Can we keep this version for the demo?",
    });

    expect(res.status).toBe(200);
    expect(res.body.route_kind).toBe("question");
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch_skipped).toBe("question_threaded");
    expect(res.body.approval).toBeNull();
    expect(calls).toHaveLength(0);

    const { rows } = await adapter.query<{ approved_at: string | null }>(
      `SELECT approved_at FROM artifact_review_state WHERE artifact_id = ?`,
      [ART],
    );
    expect(rows[0].approved_at).toBeNull();
  });

  it("persists but skips routing with artifact_owner_unknown when the artifact is not catalogued", async () => {
    const { fn, calls } = makeFakeEnqueue();
    const { app } = await buildApp(fn); // no catalogArtifact → no owner

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:liz",
      body: "no owner on record",
    });

    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch).toBeNull();
    expect(res.body.dispatch_skipped).toBe("artifact_owner_unknown");
    expect(res.body.visible_state).toBe("recorded-route-failed-retryable");
    expect(res.body.feedback_status).toBe("recorded-route-failed-retryable");
    expect(res.body.route_status).toMatchObject({
      visible_state: "recorded-route-failed-retryable",
      compat_status: "recorded-route-failed-retryable",
      feedback_status: "recorded-route-failed-retryable",
      routed: false,
      retryable: true,
      skipped: "artifact_owner_unknown",
    });
    expect(calls).toHaveLength(0);

    const get = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(get.body.comments).toHaveLength(1);
    expect(get.body.comments[0].route_status.visible_state).toBe("recorded-route-failed-retryable");
    expect(get.body.comments[0].route_status.feedback_status).toBe("recorded-route-failed-retryable");
  });

  it("persists but skips routing with scheduler_unavailable when no enqueue seam is wired", async () => {
    const { app, adapter } = await buildApp(undefined); // legacy/bootstrap mount
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "scheduler not wired",
    });

    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch).toBeNull();
    expect(res.body.dispatch_skipped).toBe("scheduler_unavailable");
    expect(res.body.visible_state).toBe("disabled/not-recorded");
    expect(res.body.feedback_status).toBe("disabled/not-recorded");
    expect(res.body.route_status).toMatchObject({
      visible_state: "disabled/not-recorded",
      routed: false,
      retryable: false,
      skipped: "scheduler_unavailable",
    });

    const get = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(get.body.comments).toHaveLength(1);
    expect(get.body.comments[0].route_status.feedback_status).toBe("disabled/not-recorded");
  });

  it("preserves the durable comment and returns dispatch_error when enqueue throws", async () => {
    const { fn, calls } = makeFakeEnqueue({ throws: true });
    const { app, adapter } = await buildApp(fn);
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "route crash but I must persist",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch).toBeNull();
    expect(res.body.dispatch_error.message).toContain("scheduler boom");
    expect(res.body.visible_state).toBe("recorded-route-failed-retryable");
    expect(res.body.feedback_status).toBe("recorded-route-failed-retryable");
    expect(res.body.route_status).toMatchObject({
      visible_state: "recorded-route-failed-retryable",
      compat_status: "recorded-route-failed-retryable",
      feedback_status: "recorded-route-failed-retryable",
      routed: false,
      retryable: true,
      target_agent: "regina",
      target_agent_raw: "regina",
      error: { message: "scheduler boom" },
    });
    expect(calls).toHaveLength(1);

    // durable capture survived the routing crash
    const get = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(get.body.comments).toHaveLength(1);
    expect(get.body.comments[0].body).toBe("route crash but I must persist");
    expect(get.body.comments[0].route_status.error.message).toContain("scheduler boom");
  });

  it("reports live feedback capabilities and canonicalizes DEFAULT owner routing", async () => {
    const { fn, calls } = makeFakeEnqueue();
    const { app, adapter } = await buildApp(fn);
    await catalogArtifact(adapter, "project:DEFAULT");

    const status = await call(app, "GET", "/artifacts/feedback/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      schema_version: "artifact.feedback.capability.v1",
      comments: { recordable: true, route_enabled: true, route_status: "enabled" },
    });
    expect(status.body.statuses).toContain("disabled/not-recorded");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Please route to the default team owner.",
    });

    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(true);
    expect(res.body.dispatch.to_agent).toBe("default");
    expect(res.body.route_status).toMatchObject({
      target_agent: "default",
      target_agent_raw: "project:DEFAULT",
      feedback_status: "recorded+routed",
    });
    expect(calls[0].to_agent).toBe("default");
  });
});
