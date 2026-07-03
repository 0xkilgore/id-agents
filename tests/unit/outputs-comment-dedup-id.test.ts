// Inbox-digest dedup/idempotency by stable comment id — manager-side deliverable
// (fix-spec cto/output/2026-06-29-inbox-digest-artifact-comments-fix-spec.md §S5,
// Roger lane). The digest ledger keys dedup on a STABLE, GLOBALLY-UNIQUE comment
// id; op_id alone is only per-artifact-unique. Here we assert the manager's
// comment read models (/comments, /feedback) expose that id and that an
// idempotent re-write yields the SAME id (so a comment is counted once ever).

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { artifactCommentId } from "../../src/outputs/types.js";

const ART = "art-dedup-1";
const ART2 = "art-dedup-2";

async function buildApp(): Promise<{ app: Express }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  // /feedback + /reactions are gated by C0_FEEDBACK_REACTIONS.
  mountOutputsRoutes(app, adapter, {
    actionCooldownMs: 0,
    env: { ...process.env, C0_FEEDBACK_REACTIONS: "1" },
  });
  return { app };
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

describe("artifactCommentId (pure)", () => {
  it("is deterministic, globally unique, and embeds artifact_id + op_id", () => {
    expect(artifactCommentId(ART, 7)).toBe("acmt:art-dedup-1:7");
    // deterministic: same inputs → same id
    expect(artifactCommentId(ART, 7)).toBe(artifactCommentId(ART, 7));
    // op_id alone is not globally unique — a different artifact with the SAME
    // op_id must produce a DIFFERENT comment id.
    expect(artifactCommentId(ART, 7)).not.toBe(artifactCommentId(ART2, 7));
    // different op on the same artifact → different id
    expect(artifactCommentId(ART, 7)).not.toBe(artifactCommentId(ART, 8));
  });
});

describe("comment read models expose the stable dedup id", () => {
  it("/comments carries comment_id == artifactCommentId(artifact_id, op_id), stable across reads", async () => {
    const { app } = await buildApp();
    const posted = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Please tighten the intro.",
    });
    expect(posted.status).toBe(200);
    const opId = posted.body.op_id;
    const expectedId = artifactCommentId(ART, opId);
    expect(posted.body.comment.comment_id).toBe(expectedId);

    const g1 = await call(app, "GET", `/artifacts/${ART}/comments`);
    const g2 = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(g1.body.comments[0].comment_id).toBe(expectedId);
    // stable across reads
    expect(g2.body.comments[0].comment_id).toBe(g1.body.comments[0].comment_id);
  });

  it("/feedback exposes the SAME comment_id for the same op", async () => {
    const { app } = await buildApp();
    const posted = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "needs a concrete number here",
    });
    const expectedId = artifactCommentId(ART, posted.body.op_id);
    const fb = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(fb.status).toBe(200);
    expect(fb.body.items[0].comment_id).toBe(expectedId);
  });
});

describe("idempotency → dedup key stability", () => {
  it("re-posting with the same idempotency_key yields the SAME op_id and comment_id (counted once ever)", async () => {
    const { app } = await buildApp();
    const key = "digest-dedup-key-1";
    const first = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris", body: "one and only", idempotency_key: key,
    });
    const second = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris", body: "one and only", idempotency_key: key,
    });
    expect(first.body.op_id).toBe(second.body.op_id);
    expect(first.body.comment.comment_id).toBe(second.body.comment.comment_id);

    // The op-log has exactly one comment → the digest counts it once.
    const comments = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(comments.body.comments).toHaveLength(1);
  });

  it("distinct comments get distinct comment_ids", async () => {
    const { app } = await buildApp();
    const a = await call(app, "POST", `/artifacts/${ART}/comments`, { actor_ref: "user:chris", body: "first" });
    const b = await call(app, "POST", `/artifacts/${ART}/comments`, { actor_ref: "user:chris", body: "second" });
    expect(a.body.comment.comment_id).not.toBe(b.body.comment.comment_id);
  });
});
