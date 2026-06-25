// C0 ambient feedback (T-CKPT.feedback-system/C0) — the lowest-click feedback
// surface. A one-tap reaction (👍/👎/❓/🔁) is a structured comment that rides
// the EXISTING comment-auto-dispatch (T-CKPT.7) to the owning agent, and the
// feedback→dispatch linkage is persisted so the acted-upon chip
// (GET /artifacts/:id/feedback) can trace it across reloads. Flag-gated behind
// C0_FEEDBACK_REACTIONS — 404 when off.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import type { CommentDispatchEnqueueFn } from "../../src/outputs/comment-dispatch.js";

const ART = "art-c0-1";
const ON = { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv;

interface EnqueueCall {
  to_agent: string;
  from_actor: string;
  message: string;
  subject?: string;
  priority?: number;
}

function makeFakeEnqueue(opts: { throws?: boolean } = {}): {
  fn: CommentDispatchEnqueueFn;
  calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  let n = 0;
  const fn: CommentDispatchEnqueueFn = async (input) => {
    calls.push(input);
    if (opts.throws) throw new Error("scheduler boom");
    n += 1;
    return { query_id: `q-c0-${n}`, dispatch_phid: `phid:disp-c0-${n}`, status: "queued" };
  };
  return { fn, calls };
}

async function buildApp(opts: {
  enqueue?: CommentDispatchEnqueueFn;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ app: Express; adapter: SqliteAdapter }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { enqueueDispatch: opts.enqueue, env: opts.env ?? ON });
  return { app, adapter };
}

async function catalogArtifact(adapter: SqliteAdapter, agent: string): Promise<void> {
  await registerArtifact(
    adapter,
    {
      artifact_id: ART,
      basename: "c0-plan.md",
      agent,
      abs_path: "/Users/kilgore/Dropbox/Code/regina/output/c0-plan.md",
      title: "C0 plan",
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

describe("POST /artifacts/:id/reactions — C0 ambient reactions", () => {
  it("records the reaction as a comment, routes a dispatch, and persists the linkage", async () => {
    const { fn, calls } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn });
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/reactions`, {
      actor_ref: "user:chris",
      reaction: "wrong",
      note: "the CTA is buried",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schema_version).toBe("artifact.reaction.v1");
    expect(res.body.reaction).toBe("wrong");
    expect(res.body.comment.reaction).toBe("wrong");
    expect(res.body.comment.body).toBe("👎 wrong — the CTA is buried");
    expect(res.body.dispatch_routed).toBe(true);
    expect(res.body.dispatch).toMatchObject({ to_agent: "regina", dispatch_phid: "phid:disp-c0-1" });

    // the dispatch message reads as a reaction, not a free-text comment
    expect(calls).toHaveLength(1);
    expect(calls[0].to_agent).toBe("regina");
    expect(calls[0].message).toContain("reacted (wrong)");
    expect(calls[0].message).toContain("## Reaction");
    expect(calls[0].message).toContain("👎 wrong — the CTA is buried");

    // the reaction shows up in the existing /comments listing with reaction set
    const comments = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(comments.body.comments).toHaveLength(1);
    expect(comments.body.comments[0].reaction).toBe("wrong");

    // and the acted-upon read model traces it to the dispatch durably
    const fb = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(fb.status).toBe(200);
    expect(fb.body.acted_upon.state).toBe("routed");
    expect(fb.body.acted_upon.reaction_count).toBe(1);
    expect(fb.body.acted_upon.routed_count).toBe(1);
    expect(fb.body.acted_upon.last_reaction).toBe("wrong");
    expect(fb.body.items).toHaveLength(1);
    expect(fb.body.items[0].kind).toBe("reaction");
    expect(fb.body.items[0].routing).toMatchObject({
      dispatch_phid: "phid:disp-c0-1",
      to_agent: "regina",
    });
    expect(fb.body.items[0].routing.routed_at).toBeTruthy();
  });

  it("accepts a bare reaction with no note (lowest click)", async () => {
    const { fn } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn });
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/reactions`, {
      actor_ref: "user:chris",
      reaction: "ship_it",
    });
    expect(res.status).toBe(200);
    expect(res.body.comment.body).toBe("👍 ship it");
    expect(res.body.dispatch_routed).toBe(true);
  });

  it("rejects an unknown reaction with 400 invalid_reaction", async () => {
    const { fn } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn });
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/reactions`, {
      actor_ref: "user:chris",
      reaction: "love_it",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_reaction");
  });

  it("captures durably even when there is no owning agent (skipped routing) — state=captured", async () => {
    const { fn } = makeFakeEnqueue();
    const { app } = await buildApp({ enqueue: fn }); // no catalog → no owner

    const res = await call(app, "POST", `/artifacts/${ART}/reactions`, {
      actor_ref: "user:liz",
      reaction: "iterate",
    });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch_skipped).toBe("artifact_owner_unknown");

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(fb.body.acted_upon.state).toBe("captured");
    expect(fb.body.acted_upon.routed_count).toBe(0);
    expect(fb.body.items[0].routing).toBeNull();
  });

  it("survives a routing crash without losing the durable reaction", async () => {
    const { fn } = makeFakeEnqueue({ throws: true });
    const { app, adapter } = await buildApp({ enqueue: fn });
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/reactions`, {
      actor_ref: "user:chris",
      reaction: "explain",
    });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(false);
    expect(res.body.dispatch_error).toBeTruthy();
    // still durable
    const comments = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(comments.body.comments).toHaveLength(1);
    expect(comments.body.comments[0].reaction).toBe("explain");
  });
});

describe("C0 flag gating (C0_FEEDBACK_REACTIONS off)", () => {
  it("404s POST /reactions and GET /feedback when the flag is off", async () => {
    const { fn } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn, env: {} as NodeJS.ProcessEnv });
    await catalogArtifact(adapter, "regina");

    const post = await call(app, "POST", `/artifacts/${ART}/reactions`, {
      actor_ref: "user:chris",
      reaction: "ship_it",
    });
    expect(post.status).toBe(404);
    expect(post.body.error).toBe("c0_feedback_reactions_disabled");

    const get = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(get.status).toBe(404);
  });

  it("leaves the existing comment endpoint behaving exactly as before (no linkage op) when the flag is off", async () => {
    const { fn } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn, env: {} as NodeJS.ProcessEnv });
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "tighten the hero",
    });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_routed).toBe(true);
    // no comment_routed op should have been written (flag off)
    const { rows } = await adapter.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM artifact_operations WHERE artifact_id = ? AND op_type = 'comment_routed'`,
      [ART],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("GET /artifacts/:id/feedback — mixed comments + reactions", () => {
  it("rolls up reactions and free-text comments, tracing each routed dispatch", async () => {
    const { fn } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn });
    await catalogArtifact(adapter, "regina");

    await call(app, "POST", `/artifacts/${ART}/comments`, { actor_ref: "user:chris", body: "first, a note" });
    await call(app, "POST", `/artifacts/${ART}/reactions`, { actor_ref: "user:chris", reaction: "iterate" });

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(fb.body.acted_upon.feedback_count).toBe(2);
    expect(fb.body.acted_upon.reaction_count).toBe(1);
    expect(fb.body.acted_upon.routed_count).toBe(2); // both routed (flag on)
    expect(fb.body.acted_upon.state).toBe("routed");
    // newest-first: the reaction is item[0]
    expect(fb.body.items[0].kind).toBe("reaction");
    expect(fb.body.items[1].kind).toBe("comment");
    // each item carries its own dispatch trace
    expect(fb.body.items[0].routing.dispatch_phid).not.toBe(fb.body.items[1].routing.dispatch_phid);
  });

  it("returns state=none for an artifact with no feedback", async () => {
    const { app } = await buildApp();
    const fb = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(fb.body.acted_upon.state).toBe("none");
    expect(fb.body.items).toHaveLength(0);
  });
});
