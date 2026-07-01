// Artifact Review v1 — suggested-change routes (create + accept + reject/
// supersede lifecycle), per cto/output/2026-06-29-suggested-change-route-contract.md.
//
// Verifies: durable capture always lands; the accept route drift-guards then
// applies via the reversible `edit` op (source untouched); drift → 409 + stale;
// accept is gated by ARTIFACTS_EDIT_IN_PRODUCT; rationale routes through the
// shared comment classifier/router; RD-001 rejects non-artifact-id targets.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import type { CommentDispatchEnqueueFn } from "../../src/outputs/comment-dispatch.js";

const BODY = "The quick brown fox jumps over the lazy dog.";
const ART = "art-sug-1";

interface EnqueueCall { to_agent: string; message: string; subject?: string; channel?: string }

function makeEnqueue(): { fn: CommentDispatchEnqueueFn; calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = [];
  const fn: CommentDispatchEnqueueFn = async (input) => {
    calls.push(input);
    return { query_id: "q-sug-1", dispatch_phid: "phid:disp-sug-1", status: "queued" };
  };
  return { fn, calls };
}

async function buildApp(opts: { editEnabled?: boolean; enqueue?: CommentDispatchEnqueueFn } = {}): Promise<{
  app: Express;
  adapter: SqliteAdapter;
}> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, {
    actionCooldownMs: 0,
    enqueueDispatch: opts.enqueue,
    env: opts.editEnabled ? { ...process.env, ARTIFACTS_EDIT_IN_PRODUCT: "1" } : { ...process.env, ARTIFACTS_EDIT_IN_PRODUCT: "" },
  });
  return { app, adapter };
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

function spanOf(quote: string): { kind: "span"; quote: string; char_start: number; char_end: number } {
  const start = BODY.indexOf(quote);
  return { kind: "span", quote, char_start: start, char_end: start + quote.length };
}

/** Seed the substrate body via the edit-in-product op so accept has a body to
 *  drift-guard against (no filesystem needed). Requires editEnabled. */
async function seedBody(app: Express, artifactId = ART): Promise<void> {
  const r = await call(app, "POST", `/artifacts/${artifactId}/edit`, { actor: "user:chris", content: BODY });
  expect(r.status).toBe(200);
}

async function createSuggestion(app: Express, over: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  return call(app, "POST", `/artifacts/${ART}/suggestions`, {
    actor_ref: "user:chris",
    original_text: "brown fox",
    proposed_text: "red hen",
    anchor: spanOf("brown fox"),
    rationale: "read more clearly",
    ...over,
  });
}

describe("POST /artifacts/:id/suggestions — create + route", () => {
  it("persists a proposed suggestion and skips routing when no scheduler is wired", async () => {
    const { app } = await buildApp();
    const res = await createSuggestion(app);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schema_version).toBe("artifact.suggestion.v1");
    expect(res.body.suggestion.state).toBe("proposed");
    expect(res.body.suggestion.suggestion_id).toMatch(/^phid:sug-/);
    expect(res.body.suggestion.original_text).toBe("brown fox");
    expect(res.body.routing.routed).toBe(false);
    expect(res.body.routing.skipped).toBe("scheduler_unavailable");
    expect(res.body.routing.kind).toBe("substantive_follow_up");
  });

  it("routes the rationale to the owning agent as a real dispatch", async () => {
    const { app, adapter } = await buildApp({ enqueue: makeEnqueue().fn });
    await registerArtifact(adapter, {
      artifact_id: ART, basename: "plan.md", agent: "regina",
      abs_path: "/tmp/plan.md", title: "Plan", produced_at: new Date().toISOString(),
      source: "manual", availability: "present",
    }, new Date().toISOString());
    const res = await createSuggestion(app);
    expect(res.status).toBe(200);
    expect(res.body.routing.routed).toBe(true);
    expect(res.body.routing.dispatch.to_agent).toBe("regina");
    expect(res.body.routing.dispatch.dispatch_phid).toBe("phid:disp-sug-1");
  });

  it("rejects a missing proposed_text with 400", async () => {
    const { app } = await buildApp();
    const res = await createSuggestion(app, { proposed_text: undefined });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_proposed_text");
  });

  it("rejects an invalid anchor with 400", async () => {
    const { app } = await buildApp();
    const res = await createSuggestion(app, { anchor: { kind: "span", quote: "x" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_anchor");
  });

  it("RD-001: rejects a non-artifact-id target", async () => {
    const { app } = await buildApp();
    const res = await call(app, "POST", `/artifacts/42/suggestions`, {
      actor_ref: "user:chris", original_text: "x", proposed_text: "y", anchor: { char_start: 0, char_end: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_artifact_id");
  });
});

describe("POST /artifacts/:id/suggestions/:sid/accept", () => {
  it("drift-guards then applies via a reversible edit op; idempotent on replay", async () => {
    const { app } = await buildApp({ editEnabled: true });
    await seedBody(app);
    const created = await createSuggestion(app);
    const sid = created.body.suggestion.suggestion_id;

    const accepted = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/accept`, { actor_ref: "user:chris" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.suggestion.state).toBe("accepted");
    expect(typeof accepted.body.edit_op_id).toBe("number");
    expect(accepted.body.idempotent).toBe(false);

    // The edit op carries the span-replaced body; the file is never touched.
    const edit = await call(app, "GET", `/artifacts/${ART}/edit`);
    expect(edit.body.edit.content).toBe("The quick red hen jumps over the lazy dog.");

    // Re-accepting is a no-op that returns the accepted record.
    const again = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/accept`, { actor_ref: "user:chris" });
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);
    expect(again.body.suggestion.state).toBe("accepted");
  });

  it("returns 409 + marks the suggestion stale when original_text has drifted", async () => {
    const { app } = await buildApp({ editEnabled: true });
    await seedBody(app);
    const created = await createSuggestion(app, { original_text: "purple elephant", anchor: { kind: "span", quote: "purple elephant", char_start: 0, char_end: 15 } });
    const sid = created.body.suggestion.suggestion_id;

    const res = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/accept`, { actor_ref: "user:chris" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("suggestion_stale");
    expect(res.body.suggestion.state).toBe("stale");

    // No edit was written.
    const edit = await call(app, "GET", `/artifacts/${ART}/edit`);
    expect(edit.body.edit.content).toBe(BODY);
  });

  it("is gated by ARTIFACTS_EDIT_IN_PRODUCT (404 when off)", async () => {
    const { app } = await buildApp({ editEnabled: false });
    const created = await createSuggestion(app);
    const sid = created.body.suggestion.suggestion_id;
    const res = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/accept`, { actor_ref: "user:chris" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("edit_in_product_disabled");
  });

  it("returns 404 for an unknown suggestion id", async () => {
    const { app } = await buildApp({ editEnabled: true });
    await seedBody(app);
    const res = await call(app, "POST", `/artifacts/${ART}/suggestions/phid:sug-nope/accept`, { actor_ref: "user:chris" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("suggestion_not_found");
  });
});

describe("reject / supersede lifecycle", () => {
  it("rejects a proposed suggestion, then accept is refused", async () => {
    const { app } = await buildApp({ editEnabled: true });
    await seedBody(app);
    const created = await createSuggestion(app);
    const sid = created.body.suggestion.suggestion_id;

    const rejected = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/reject`, { actor_ref: "user:chris", reason: "not needed" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.suggestion.state).toBe("rejected");

    const accept = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/accept`, { actor_ref: "user:chris" });
    expect(accept.status).toBe(409);
    expect(accept.body.code).toBe("suggestion_not_proposed");
  });

  it("supersedes a proposed suggestion", async () => {
    const { app } = await buildApp({ editEnabled: true });
    await seedBody(app);
    const created = await createSuggestion(app);
    const sid = created.body.suggestion.suggestion_id;
    const res = await call(app, "POST", `/artifacts/${ART}/suggestions/${sid}/supersede`, { actor_ref: "user:chris", superseded_by: "phid:sug-other" });
    expect(res.status).toBe(200);
    expect(res.body.suggestion.state).toBe("superseded");
    expect(res.body.suggestion.superseded_by).toBe("phid:sug-other");
  });
});
