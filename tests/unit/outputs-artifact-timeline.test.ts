import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";

let app: Express;

async function setup(): Promise<void> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { actionCooldownMs: 0 });
}

async function call(
  method: "POST" | "GET",
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

const ART = "art-timeline-1";
const OTHER = "art-timeline-2";

beforeEach(setup);

describe("Artifact Review v1 timeline", () => {
  it("supports the UI contract across durable write actions and reload readback", async () => {
    const comment = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Please add concrete numbers.",
    });
    expect(comment.status).toBe(200);
    expect(comment.body.dispatch_routed).toBe(false);
    expect(comment.body.dispatch_skipped).toBe("scheduler_unavailable");

    const comments = await call("GET", `/artifacts/${ART}/comments`);
    expect(comments.status).toBe(200);
    expect(comments.body.comments[0]).toMatchObject({
      actor: "user:chris",
      body: "Please add concrete numbers.",
    });

    const approve = await call("POST", `/artifacts/${ART}/approve`, {
      actor_ref: "user:chris",
      note: "Approved for UI build.",
      comment: "Good to ship once numbers land.",
      idempotency_key: "ui-approve",
    });
    expect(approve.status).toBe(200);
    expect(approve.body.state.approved_by).toBe("user:chris");
    expect(approve.body.state.approval_note).toBe("Approved for UI build.");
    expect(approve.body.comment.body).toBe("Good to ship once numbers land.");

    const reject = await call("POST", `/artifacts/${ART}/reject`, {
      actor_ref: "user:liz",
      note: "Request changes on the final copy.",
    });
    expect(reject.status).toBe(200);
    expect(reject.body.state.rejected_by).toBe("user:liz");
    expect(reject.body.state.reject_note).toBe("Request changes on the final copy.");

    const followUp = await call("POST", `/artifacts/${ART}/timeline`, {
      kind: "dispatch_follow_up",
      actor_ref: "user:liz",
      body: "Route copy fixes to backend owner.",
      target_agent: "substrate-api-codex",
      query_id: "query_ui_contract",
      dispatch_phid: "phid:disp-ui-contract",
      status: "queued",
    });
    expect(followUp.status).toBe(200);
    expect(followUp.body.event.dispatch_receipt).toMatchObject({
      target_agent: "substrate-api-codex",
      query_id: "query_ui_contract",
      dispatch_phid: "phid:disp-ui-contract",
      status: "queued",
    });

    const review = await call("GET", `/artifacts/${ART}/review`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      schema_version: "artifact.review.v1",
      artifact_id: ART,
      is_approved: true,
      is_rejected: true,
    });
    expect(review.body.state.approval_note).toBe("Approved for UI build.");
    expect(review.body.state.reject_note).toBe("Request changes on the final copy.");

    const timeline = await call("GET", `/artifacts/${ART}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.events.map((e: any) => e.kind)).toEqual([
      "comment",
      "comment",
      "approval",
      "rejection",
      "dispatch_follow_up",
    ]);
    expect(timeline.body.events.at(-1).dispatch_receipt.dispatch_phid).toBe("phid:disp-ui-contract");
  });

  it("lists durable events by artifact, including view and general comments", async () => {
    await call("POST", `/artifacts/${ART}/view`, { viewer: "user:chris" });
    await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Tighten the copy.",
    });
    await call("POST", `/artifacts/${OTHER}/comments`, {
      actor_ref: "user:liz",
      body: "Different artifact.",
    });

    const timeline = await call("GET", `/artifacts/${ART}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.schema_version).toBe("artifact.timeline.v1");
    expect(timeline.body.events.map((e: any) => e.kind)).toEqual(["view", "comment"]);
    expect(timeline.body.events[1]).toMatchObject({
      artifact_id: ART,
      actor: "user:chris",
      body: "Tighten the copy.",
      status: "recorded",
    });
    expect(timeline.body.events.some((e: any) => e.artifact_id === OTHER)).toBe(false);
  });

  it("creates suggested-change comments as typed review events and dedupes by idempotency key", async () => {
    const body = {
      kind: "suggested_change",
      actor_ref: "user:chris",
      body: "Replace the summary sentence.",
      suggested_markdown: "A sharper summary.",
      anchor: "summary",
      status: "open",
    };
    const first = await call("POST", `/artifacts/${ART}/timeline`, body, { "idempotency-key": "sug-1" });
    const second = await call("POST", `/artifacts/${ART}/timeline`, body, { "idempotency-key": "sug-1" });
    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.op_id).toBe(first.body.op_id);

    const timeline = await call("GET", `/artifacts/${ART}/timeline`);
    expect(timeline.body.events).toHaveLength(1);
    expect(timeline.body.events[0]).toMatchObject({
      kind: "suggested_change",
      status: "open",
      body: "Replace the summary sentence.",
      markdown: "A sharper summary.",
      anchor: "summary",
      idempotency_key: "sug-1",
    });
  });

  it("approve-with-comment creates both comment and approval timeline facts", async () => {
    const res = await call("POST", `/artifacts/${ART}/approve`, {
      actor_ref: "user:chris",
      note: "Approved",
      comment: "Looks good after the copy pass.",
      idempotency_key: "approve-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.comment.body).toBe("Looks good after the copy pass.");
    expect(res.body.comment_op_id).toBeGreaterThan(0);
    expect(res.body.op_id).toBeGreaterThan(res.body.comment_op_id);

    const timeline = await call("GET", `/artifacts/${ART}/timeline`);
    expect(timeline.body.events.map((e: any) => e.kind)).toEqual(["comment", "approval"]);
    expect(timeline.body.events[0].idempotency_key).toBe("approve-1:comment");
    expect(timeline.body.events[1]).toMatchObject({
      kind: "approval",
      status: "approved",
      body: "Approved",
      idempotency_key: "approve-1:approval",
    });
  });

  it("records dispatch-follow-up receipts in the timeline", async () => {
    const res = await call("POST", `/artifacts/${ART}/timeline`, {
      kind: "dispatch_follow_up",
      actor_ref: "user:liz",
      body: "Follow-up assigned to backend lane.",
      target_agent: "substrate-api-codex",
      query_id: "query_123",
      dispatch_phid: "phid:disp-123",
      status: "queued",
      idempotency_key: "follow-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({
      kind: "dispatch_follow_up",
      status: "queued",
      body: "Follow-up assigned to backend lane.",
      dispatch_receipt: {
        target_agent: "substrate-api-codex",
        query_id: "query_123",
        dispatch_phid: "phid:disp-123",
        status: "queued",
      },
    });
  });

  it("keeps legacy comments and approve endpoints compatible", async () => {
    const comment = await call("POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Legacy comment path.",
    });
    expect(comment.status).toBe(200);
    expect(comment.body.schema_version).toBe("artifact.comment.v1");
    expect(comment.body.comment.body).toBe("Legacy comment path.");

    const approve = await call("POST", `/artifacts/${ART}/approve`, {
      approver: "human:chris",
    });
    expect(approve.status).toBe(200);
    expect(approve.body.state.approved_by).toBe("user:chris");
    expect(approve.body.comment).toBeNull();
  });
});
