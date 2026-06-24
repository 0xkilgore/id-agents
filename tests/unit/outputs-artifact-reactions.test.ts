// T-CKPT.feedback C0 (2026-06-24, phid:disp-22142afd6cae1a32) — artifact
// REACTIONS (👍 ship-it / 👎 wrong / ❓ explain / 🔁 iterate) wired to the
// EXISTING comment-auto-dispatch rail (T-LOOP-CLOSE.1 / T-CKPT.7). A reaction
// is a structured comment: it persists through the same comment_recorded op,
// routes through the same routeCommentToOwningAgent, and never duplicates the
// comment-routing path. These tests pin:
//   - the reaction descriptor (emoji + agent-facing intent) per reaction
//   - commentMessage() carries the reaction intent so the owning agent knows
//     what Chris asked for
//   - the POST /comments route accepts a reaction with NO body text (a bare
//     👍 is valid feedback) and still routes to the owning agent
//   - a request with neither body nor reaction is rejected
//   - an unknown reaction value is rejected
//   - listComments projects the reaction back

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { SchedulerHandle } from "../../src/dispatch-scheduler/manager-integration.js";
import { readDispatchById } from "../../src/dispatch-scheduler/read-model.js";
import {
  commentMessage,
  reactionDescriptor,
  isArtifactReaction,
} from "../../src/outputs/comment-dispatch.js";
import type { ArtifactCatalogRow } from "../../src/outputs/types.js";

const TEAM = "default";
const ART = "art-c0-react-1";
let adapter: SqliteAdapter;
let handle: SchedulerHandle;
let app: Express;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES (?, ?)`, [TEAM, TEAM]);
  await registerArtifact(
    adapter,
    {
      artifact_id: ART,
      agent: "finances",
      basename: "q2-plan.md",
      title: "Q2 Plan",
      abs_path: "/abs/finances/output/q2-plan.md",
      produced_at: new Date().toISOString(),
      source: "manual",
      availability: "present",
    },
    new Date().toISOString(),
  );

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

const catalog: ArtifactCatalogRow = {
  artifact_id: ART,
  agent: "finances",
  basename: "q2-plan.md",
  tag: null,
  title: "Q2 Plan",
  abs_path: "/abs/finances/output/q2-plan.md",
  produced_at: "2026-06-24T00:00:00Z",
  source: "manual",
  availability: "present",
  source_badges: "[]",
  reconciled_at: null,
  created_at: "2026-06-24T00:00:00Z",
  updated_at: "2026-06-24T00:00:00Z",
};

describe("reaction descriptors", () => {
  it("maps every reaction to an emoji + agent-facing intent", () => {
    for (const r of ["ship_it", "wrong", "explain", "iterate"] as const) {
      const d = reactionDescriptor(r);
      expect(d.emoji.length).toBeGreaterThan(0);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.guidance.length).toBeGreaterThan(0);
    }
    expect(reactionDescriptor("ship_it").emoji).toBe("👍");
    expect(reactionDescriptor("wrong").emoji).toBe("👎");
    expect(reactionDescriptor("explain").emoji).toBe("❓");
    expect(reactionDescriptor("iterate").emoji).toBe("🔁");
  });

  it("isArtifactReaction guards the enum", () => {
    expect(isArtifactReaction("ship_it")).toBe(true);
    expect(isArtifactReaction("iterate")).toBe(true);
    expect(isArtifactReaction("nope")).toBe(false);
    expect(isArtifactReaction(undefined)).toBe(false);
    expect(isArtifactReaction(null)).toBe(false);
  });
});

describe("commentMessage carries reaction intent", () => {
  it("renders the reaction descriptor + guidance when a reaction is present", () => {
    const msg = commentMessage(catalog, {
      op_id: 1, artifact_id: ART, actor: "user:chris", body: "", anchor: null,
      reaction: "iterate", ts: "2026-06-24T00:00:00Z",
    });
    expect(msg).toContain("🔁");
    expect(msg).toContain(reactionDescriptor("iterate").label);
    expect(msg).toContain(reactionDescriptor("iterate").guidance);
  });

  it("includes both the reaction AND the typed body when both are present", () => {
    const msg = commentMessage(catalog, {
      op_id: 2, artifact_id: ART, actor: "user:chris", body: "tighten section 3", anchor: null,
      reaction: "iterate", ts: "2026-06-24T00:00:00Z",
    });
    expect(msg).toContain("🔁");
    expect(msg).toContain("tighten section 3");
  });

  it("a plain comment (no reaction) is unchanged — still has the comment body", () => {
    const msg = commentMessage(catalog, {
      op_id: 3, artifact_id: ART, actor: "user:chris", body: "looks good", anchor: null,
      reaction: null, ts: "2026-06-24T00:00:00Z",
    });
    expect(msg).toContain("looks good");
    expect(msg).not.toContain("Reaction");
  });
});

describe("POST /artifacts/:id/comments with a reaction", () => {
  it("accepts a bare reaction (no body) and routes it to the owning agent", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor: "user:chris",
      reaction: "ship_it",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.comment.reaction).toBe("ship_it");
    expect(res.body.dispatch_routed).toBe(true);
    expect(res.body.dispatch.to_agent).toBe("finances");

    // The routed dispatch carries the reaction intent + the commenter's actor.
    const dispatch = await readDispatchById(adapter, TEAM, res.body.dispatch.dispatch_phid);
    expect(dispatch).not.toBeNull();
    expect(dispatch!.source_metadata.from_actor).toBe("user:chris");
    expect(dispatch!.target_agent).toBe("finances");
  });

  it("routes a reaction WITH a body too", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor: "user:chris",
      reaction: "iterate",
      body: "redo the projections",
    });
    expect(res.status).toBe(200);
    expect(res.body.comment.reaction).toBe("iterate");
    expect(res.body.comment.body).toBe("redo the projections");
    expect(res.body.dispatch_routed).toBe(true);
  });

  it("rejects a request with neither body nor reaction", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, { actor: "user:chris" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown reaction value", async () => {
    const res = await call("POST", `/artifacts/${ART}/comments`, {
      actor: "user:chris",
      reaction: "shrug",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_reaction");
  });

  it("projects the reaction back through GET /comments", async () => {
    await call("POST", `/artifacts/${ART}/comments`, { actor: "user:chris", reaction: "wrong" });
    const res = await call("GET", `/artifacts/${ART}/comments`);
    expect(res.status).toBe(200);
    const reactions = res.body.comments.map((c: any) => c.reaction);
    expect(reactions).toContain("wrong");
  });
});
