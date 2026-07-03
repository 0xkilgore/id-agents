// RD-027 (IDA-2026-07-01-F9): the artifact mutation surface must resolve refs
// CONSISTENTLY. Before, only POST /comments resolved an encoded-path ref;
// approve/reject/ship/reactions/timeline still 400'd on the SAME ref — an
// operator dead-end mid review loop. After: every /artifacts/:id mutation route
// resolves through resolveMutationArtifactId to the same stable artifact_id.
// RD-001 preserved: display ids / basenames / indices are still rejected.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, artifactIdFromPath } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";

const ABS_PATH = "/Users/kilgore/Dropbox/Code/regina/output/rd027-plan.md";
const STABLE_ID = artifactIdFromPath(ABS_PATH);
// Encoded-path ref the console holds (slashes → %2F); Express decodes it back to
// the abs path as one :id segment, which the resolver maps to STABLE_ID.
const ENCODED_REF = encodeURIComponent(ABS_PATH);

async function buildApp(): Promise<Express> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, {
    actionCooldownMs: 0,
    env: { ...process.env, C0_FEEDBACK_REACTIONS: "1" },
  });
  return app;
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

describe("RD-027 mutation-route ref-resolution parity", () => {
  it("drives comment → approve → ship via the encoded-path ref; none 400, all resolve to the same stable id", async () => {
    const app = await buildApp();

    const comment = await call(app, "POST", `/artifacts/${ENCODED_REF}/comments`, {
      actor_ref: "user:chris", body: "Please tighten the intro.",
    });
    expect(comment.status).toBe(200);
    // resolved to the stable id: the comment's own comment_id embeds STABLE_ID.
    expect(comment.body.comment.comment_id).toBe(`acmt:${STABLE_ID}:${comment.body.op_id}`);
    expect(comment.body.comment.artifact_id).toBe(STABLE_ID);

    const approve = await call(app, "POST", `/artifacts/${ENCODED_REF}/approve`, {
      actor_ref: "user:chris", note: "good",
    });
    expect(approve.status).toBe(200);

    const ship = await call(app, "POST", `/artifacts/${ENCODED_REF}/ship`, { actor_ref: "user:chris" });
    // ship is a stub (returns blockers) but must NOT 400 on the ref
    expect(ship.status).toBe(200);

    // Everything landed under the SAME stable artifact_id: reading via the stable
    // id shows the comment + approved review state.
    const comments = await call(app, "GET", `/artifacts/${STABLE_ID}/comments`);
    expect(comments.body.comments).toHaveLength(1);
    const review = await call(app, "GET", `/artifacts/${STABLE_ID}/review`);
    expect(review.body.is_approved).toBe(true);
  });

  it("reactions, timeline, and suggestion routes also resolve the encoded-path ref (no dead-end)", async () => {
    const app = await buildApp();

    const reaction = await call(app, "POST", `/artifacts/${ENCODED_REF}/reactions`, {
      actor_ref: "user:chris", reaction: "iterate", note: "tighten hero",
    });
    expect(reaction.status).toBe(200);

    const timeline = await call(app, "POST", `/artifacts/${ENCODED_REF}/timeline`, {
      actor_ref: "user:chris", kind: "suggested_change", body: "swap the header",
    });
    expect(timeline.status).toBe(200);

    const suggestion = await call(app, "POST", `/artifacts/${ENCODED_REF}/suggestions`, {
      actor_ref: "user:chris",
      original_text: "x", proposed_text: "y",
      anchor: { kind: "span", quote: "x", char_start: 0, char_end: 1 },
      rationale: "clearer",
    });
    expect(suggestion.status).toBe(200);
    expect(suggestion.body.suggestion.artifact_id).toBe(STABLE_ID);
  });

  it("RD-001 preserved: a display id / index is still rejected at mutation routes", async () => {
    const app = await buildApp();
    for (const badId of ["9", "42", "some-basename"]) {
      const res = await call(app, "POST", `/artifacts/${badId}/comments`, {
        actor_ref: "user:chris", body: "x",
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_artifact_id");
    }
  });
});
