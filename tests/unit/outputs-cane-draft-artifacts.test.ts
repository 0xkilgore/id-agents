// CANE_DRAFT_ARTIFACTS — cane_draft as an approvable document-model artifact.
//
// Covers the spec's acceptance criteria for the backend (slice 1):
//   - register a cane_draft (idempotent on draft_id)
//   - revise appends revision_history + changes the latest body
//   - ship is blocked by NOT_APPROVED until approved
//   - approve → ship sends the latest body via the injected sender + sets shipped_at
//   - a second ship → ALREADY_SHIPPED (no double-send)
//   - a shipped cane_draft is filtered out of /outputs/inbox?kind=cane_draft
//   - a non-cane_draft kind still returns no_executor_configured
//   - flag OFF → revise route 404 + draft registration 404 + ship stays blocked

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import type { CaneDraftSender } from "../../src/outputs/ship-executor.js";

let app: Express;
let nowMs: number;
let sentBodies: string[];
let sendCalls: number;

// A capturing fake sender: records each body sent, returns a stable message_id
// keyed on the draft so a replay is idempotent on Cane's side.
function fakeSender(): CaneDraftSender {
  return async (payload, body) => {
    sendCalls += 1;
    sentBodies.push(body);
    return {
      ok: true,
      evidence: {
        sent_at: new Date(nowMs).toISOString(),
        message_id: `msg-${payload.draft_id}`,
        final_reply: body,
      },
    };
  };
}

function mount(env: NodeJS.ProcessEnv, sender?: CaneDraftSender): void {
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, {
    actionCooldownMs: 0, // disable cooldown for deterministic multi-call tests
    now: () => new Date(nowMs),
    env,
    caneDraftSender: sender,
    autoIngest: false,
  });
}

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  nowMs = Date.parse("2026-06-24T20:00:00.000Z");
  sentBodies = [];
  sendCalls = 0;
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

const ON = { CANE_DRAFT_ARTIFACTS: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

const DRAFT = {
  draft_id: "cane:draft:abc123",
  channel: "email",
  to: "liz@example.com",
  subject: "Re: roles",
  body_markdown: "hey liz — original draft body.",
  send_recommendation: "needs_approval",
  reasoning: "decision stakes",
};

describe("CANE_DRAFT_ARTIFACTS flag ON — register / revise / approve / ship", () => {
  beforeEach(() => mount(ON, fakeSender()));

  it("registers a cane_draft and is idempotent on draft_id", async () => {
    const r1 = await call("POST", "/drafts", DRAFT);
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.draft_id).toBe(DRAFT.draft_id);
    expect(r1.body.inserted).toBe(true);
    const artifactId = r1.body.artifact_id;

    // Re-register the same draft — no duplicate, same artifact_id.
    const r2 = await call("POST", "/drafts", { ...DRAFT, subject: "Re: roles (v2)" });
    expect(r2.status).toBe(200);
    expect(r2.body.inserted).toBe(false);
    expect(r2.body.artifact_id).toBe(artifactId);

    // Exactly one row surfaces in the cane_draft inbox.
    const inbox = await call("GET", "/outputs/inbox?kind=cane_draft");
    expect(inbox.body.items.filter((i: any) => i.artifact_id === artifactId).length).toBe(1);
  });

  it("revise appends revision_history and changes the latest body", async () => {
    const reg = await call("POST", "/drafts", DRAFT);
    const id = reg.body.artifact_id;

    const rev = await call("POST", `/artifacts/${id}/revise`, {
      body_markdown: "hey liz — EDITED body.",
      actor: "user:chris",
    });
    expect(rev.status).toBe(200);
    expect(rev.body.payload.body_markdown).toBe("hey liz — EDITED body.");
    expect(rev.body.payload.revision_history.length).toBe(1);
    expect(rev.body.payload.revision_history[0].by).toBe("user:chris");
    expect(rev.body.payload.revision_history[0].from_len).toBe(DRAFT.body_markdown.length);
  });

  it("ship is blocked by NOT_APPROVED until approved, then sends the latest body", async () => {
    const reg = await call("POST", "/drafts", DRAFT);
    const id = reg.body.artifact_id;

    // Ship before approve → blocked NOT_APPROVED, no executor blocker, no send.
    const blocked = await call("POST", `/artifacts/${id}/ship`, { actor_ref: "user:chris" });
    expect(blocked.status).toBe(200);
    expect(blocked.body.status).toBe("blocked");
    expect(blocked.body.blockers).toContain("artifact_not_approved");
    expect(blocked.body.blockers).not.toContain("no_executor_configured");
    expect(sendCalls).toBe(0);

    // Edit, then approve, then ship → sends the EDITED body, sets shipped_at.
    await call("POST", `/artifacts/${id}/revise`, { body_markdown: "final edited body", actor: "user:chris" });
    await call("POST", `/artifacts/${id}/approve`, { actor_ref: "user:chris" });
    const ok = await call("POST", `/artifacts/${id}/ship`, { actor_ref: "user:chris" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("ok");
    expect(sendCalls).toBe(1);
    expect(sentBodies[0]).toBe("final edited body");

    const review = await call("GET", `/artifacts/${id}/review`);
    expect(review.body.is_shipped).toBe(true);
    expect(review.body.state.shipped_at).toBeTruthy();
  });

  it("a second ship returns ALREADY_SHIPPED and does not double-send", async () => {
    const reg = await call("POST", "/drafts", DRAFT);
    const id = reg.body.artifact_id;
    await call("POST", `/artifacts/${id}/approve`, { actor_ref: "user:chris" });
    const first = await call("POST", `/artifacts/${id}/ship`, { actor_ref: "user:chris" });
    expect(first.body.status).toBe("ok");
    expect(sendCalls).toBe(1);

    const second = await call("POST", `/artifacts/${id}/ship`, { actor_ref: "user:chris" });
    expect(second.body.status).toBe("blocked");
    expect(second.body.blockers).toContain("already_shipped");
    expect(sendCalls).toBe(1); // no second email
  });

  it("a shipped cane_draft drops out of the inbox (cannot re-surface)", async () => {
    const reg = await call("POST", "/drafts", DRAFT);
    const id = reg.body.artifact_id;

    let inbox = await call("GET", "/outputs/inbox?kind=cane_draft");
    expect(inbox.body.items.some((i: any) => i.artifact_id === id)).toBe(true);

    await call("POST", `/artifacts/${id}/approve`, { actor_ref: "user:chris" });
    await call("POST", `/artifacts/${id}/ship`, { actor_ref: "user:chris" });

    inbox = await call("GET", "/outputs/inbox?kind=cane_draft");
    expect(inbox.body.items.some((i: any) => i.artifact_id === id)).toBe(false);
  });

  it("a non-cane_draft artifact still returns no_executor_configured", async () => {
    // A plain catalog artifact (no draft payload) — ship must stay blocked on
    // the executor, exactly as before this feature.
    await call("POST", "/artifacts/register", {
      artifact_id: "art-plain-doc",
      basename: "doc.md",
      agent: "cto",
      abs_path: "/tmp/doc.md",
      produced_at: new Date(nowMs).toISOString(),
    });
    await call("POST", "/artifacts/art-plain-doc/approve", { actor_ref: "user:chris" });
    const ship = await call("POST", "/artifacts/art-plain-doc/ship", { actor_ref: "user:chris" });
    expect(ship.body.status).toBe("blocked");
    expect(ship.body.blockers).toContain("no_executor_configured");
    expect(sendCalls).toBe(0);
  });
});

describe("CANE_DRAFT_ARTIFACTS flag OFF — inert (zero regression)", () => {
  beforeEach(() => mount(OFF, fakeSender()));

  it("draft registration is 404 and revise is 404", async () => {
    const reg = await call("POST", "/drafts", DRAFT);
    expect(reg.status).toBe(404);
    expect(reg.body.error).toBe("cane_draft_artifacts_disabled");

    const rev = await call("POST", "/artifacts/art-anything/revise", { body_markdown: "x" });
    expect(rev.status).toBe(404);
    expect(rev.body.error).toBe("cane_draft_artifacts_disabled");
  });

  it("ship on any artifact still returns no_executor_configured (legacy behavior)", async () => {
    await call("POST", "/artifacts/art-x/approve", { actor_ref: "user:chris" });
    const ship = await call("POST", "/artifacts/art-x/ship", { actor_ref: "user:chris" });
    expect(ship.body.status).toBe("blocked");
    expect(ship.body.blockers).toContain("no_executor_configured");
    expect(sendCalls).toBe(0);
  });
});
