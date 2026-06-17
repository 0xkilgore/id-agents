// T3B-1 — approve/reject/ship server adapters: Monday-actor attribution,
// idempotency, and the per-(artifact,action,actor) cooldown. The marquee
// integration is the Chris-then-Liz multi-operator flow.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";

let app: Express;
// Controllable clock shared by the cooldown guard AND the executors so cooldown
// math is deterministic.
let nowMs: number;
const COOLDOWN_MS = 3000;

beforeEach(async () => {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  nowMs = Date.parse("2026-06-17T20:00:00.000Z");
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { actionCooldownMs: COOLDOWN_MS, now: () => new Date(nowMs) });
});

async function call(method: "POST" | "GET", path: string, body?: unknown): Promise<{ status: number; body: any }> {
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

const ART = "art-t3b1-1";

describe("T3B-1 approve — Chris-then-Liz + idempotency + cooldown", () => {
  it("Chris approves, Liz approves (idempotent, first-write-wins), no cross-actor cooldown", async () => {
    const chris = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:chris" });
    expect(chris.status).toBe(200);
    expect(chris.body.idempotent).toBe(false);
    expect(chris.body.state.approved_by).toBe("user:chris");
    const approvedAt = chris.body.state.approved_at;

    // Liz immediately approves — DIFFERENT actor, must NOT be cooldown-blocked.
    const liz = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:liz" });
    expect(liz.status).toBe(200);
    expect(liz.body.idempotent).toBe(true);              // already approved
    expect(liz.body.state.approved_at).toBe(approvedAt); // first-write-wins
    expect(liz.body.state.approved_by).toBe("user:liz"); // latest actor recorded
  });

  it("an idempotent re-approve bypasses the cooldown (returns current state)", async () => {
    const first = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:chris" });
    expect(first.status).toBe(200);
    nowMs += 200; // well within cooldown
    const again = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:chris" });
    expect(again.status).toBe(200);          // not blocked — harmless idempotent repeat
    expect(again.body.idempotent).toBe(true);
  });

  it("a non-idempotent decision FLIP within the window is cooldown-blocked (429), allowed after", async () => {
    const approve = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:chris" });
    expect(approve.status).toBe(200);

    nowMs += 500; // within cooldown — Chris flips to reject too fast
    const flip = await call("POST", `/artifacts/${ART}/reject`, { actor_ref: "user:chris" });
    expect(flip.status).toBe(429);
    expect(flip.body.code).toBe("action_cooldown");
    expect(flip.body.retry_after_ms).toBeGreaterThan(0);

    nowMs += COOLDOWN_MS; // past cooldown
    const ok = await call("POST", `/artifacts/${ART}/reject`, { actor_ref: "user:chris" });
    expect(ok.status).toBe(200);
    expect(ok.body.state.rejected_by).toBe("user:chris");
  });
});

describe("T3B-1 reject", () => {
  it("rejects with actor attribution + idempotency", async () => {
    const r1 = await call("POST", `/artifacts/${ART}/reject`, { actor_ref: "user:chris", note: "off-brand" });
    expect(r1.status).toBe(200);
    expect(r1.body.idempotent).toBe(false);
    expect(r1.body.state.rejected_by).toBe("user:chris");
    const rejectedAt = r1.body.state.rejected_at;

    nowMs += COOLDOWN_MS;
    const r2 = await call("POST", `/artifacts/${ART}/reject`, { actor_ref: "user:liz" });
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);                 // already rejected
    expect(r2.body.state.rejected_at).toBe(rejectedAt);    // first-write-wins
  });

  it("a reject→approve flip is cooldown-guarded per actor", async () => {
    await call("POST", `/artifacts/${ART}/reject`, { actor_ref: "user:chris" });
    nowMs += 100; // Chris flips to approve too fast
    const blocked = await call("POST", `/artifacts/${ART}/approve`, { actor_ref: "user:chris" });
    expect(blocked.status).toBe(429);
  });

  it("enforces a valid Monday actor (missing → 400, unknown → 403)", async () => {
    expect((await call("POST", `/artifacts/${ART}/reject`, {})).status).toBe(400);
    expect((await call("POST", `/artifacts/${ART}/reject`, { actor_ref: "user:bob" })).status).toBe(403);
  });
});

describe("T3B-1 ship — cooldown-guarded, stays blocked-but-recorded", () => {
  it("records a blocked ship and cooldown-guards rapid repeats", async () => {
    const s1 = await call("POST", `/artifacts/${ART}/ship`, { actor_ref: "user:chris" });
    expect(s1.status).toBe(200);
    expect(s1.body.status).toBe("blocked");
    expect(s1.body.blockers).toContain("no_executor_configured");

    nowMs += 200;
    const s2 = await call("POST", `/artifacts/${ART}/ship`, { actor_ref: "user:chris" });
    expect(s2.status).toBe(429);

    // Different actor is independent.
    const liz = await call("POST", `/artifacts/${ART}/ship`, { actor_ref: "user:liz" });
    expect(liz.status).toBe(200);
  });
});
