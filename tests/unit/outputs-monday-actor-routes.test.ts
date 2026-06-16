// Monday §2 — manager-side artifact comment/approve/ship executor routes with
// fixed-actor (Chris/Liz) attribution + RD-001 stable-id guard.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";

let app: Express;

beforeEach(async () => {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter); // no emit seam — exercises the canonical write path
});

async function call(
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

const ART = "art-monday-1";

describe("POST /artifacts/:id/comments (the Chris/Liz unblock)", () => {
  it("Chris can comment and it persists + re-reads", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Tighten the hierarchy on the hero.",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.comment.actor).toBe("user:chris");
    expect(res.body.op_id).toBeGreaterThan(0);

    const get = await call("GET", `/artifacts/${ART}/comments`);
    expect(get.body.comments).toHaveLength(1);
    expect(get.body.comments[0].body).toBe("Tighten the hierarchy on the hero.");
    expect(get.body.comments[0].actor).toBe("user:chris");

    // and it shows in the operations audit log + review operations_count
    const ops = await call("GET", `/artifacts/${ART}/operations`);
    expect(ops.body.operations.some((o: any) => o.op_type === "comment_recorded")).toBe(true);
    const review = await call("GET", `/artifacts/${ART}/review`);
    expect(review.body.operations_count).toBeGreaterThanOrEqual(1);
  });

  it("Liz can comment too (second fixed actor)", async () => {
    await call("POST", `/artifacts/${ART}/comments`, { actor_ref: "user:liz", body: "Spacing feels cramped." });
    const get = await call("GET", `/artifacts/${ART}/comments`);
    expect(get.body.comments[0].actor).toBe("user:liz");
  });

  it("rejects a missing actor with a typed 400", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, { body: "no actor" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_actor");
  });

  it("rejects an unknown/arbitrary actor with a typed 403", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, { actor_ref: "user:erica", body: "nope" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("unknown_actor");
  });

  it("rejects an invalid artifact id (basename) — RD-001", async () => {
    const res = await call("POST", `/artifacts/loops-review.md/comments`, {
      actor_ref: "user:chris",
      body: "x",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_artifact_id");
  });

  it("rejects an empty comment body", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, { actor_ref: "user:chris", body: "   " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_body");
  });
});

describe("POST /artifacts/:id/approve (durable + idempotent + actor)", () => {
  it("approves with actor attribution and is idempotent on re-approve", async () => {
    const first = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:chris" });
    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBe(false);
    expect(first.body.actor).toBe("user:chris");
    expect(first.body.state.approved_by).toBe("user:chris");
    const firstApprovedAt = first.body.state.approved_at;

    const second = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:liz" });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true); // already approved
    expect(second.body.state.approved_at).toBe(firstApprovedAt); // first-write-wins
  });

  it("keeps existing Chris flows working (legacy approver: human:chris)", async () => {
    const res = await call("POST", `/artifacts/${ART}/approve`, { approver: "human:chris" });
    expect(res.status).toBe(200);
    expect(res.body.state.approved_by).toBe("user:chris");
  });

  it("rejects approve without an actor (400)", async () => {
    const res = await call("POST", `/artifacts/${ART}/approve`, {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_actor");
  });
});

describe("POST /artifacts/:id/ship (visible but blocked)", () => {
  it("returns a durable blocked operation with no_executor_configured (not fake success)", async () => {
    const res = await call("POST", `/artifacts/${ART}/ship`, { actor_ref: "user:chris" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("blocked");
    expect(res.body.blockers).toContain("no_executor_configured");
    expect(res.body.recorded_op_id).toBeGreaterThan(0);
    expect(res.body.actor).toBe("user:chris");
  });

  it("rejects ship with an invalid artifact id (index) — RD-001", async () => {
    const res = await call("POST", `/artifacts/3/ship`, { actor_ref: "user:chris" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_artifact_id");
  });
});
