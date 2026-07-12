// GET /orchestration/backlog/needs-promote-report
//
// Gives operators a grouped view of needs_review rows that are blocked from
// auto-promote, especially already-dispatched duplicates that can be bulk-closed
// after their prior dispatch is confirmed terminal.

import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import { insertBacklogItem, setItemState } from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  app = express();
  app.use(express.json());
  mountContinuousOrchestrationRoutes(app, {
    daemon: {} as unknown as ContinuousOrchestrationDaemon,
    adapter,
    config: defaultConfig(),
    teamId: "default",
  });
});

async function call(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method });
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

async function seedDispatch(phid: string, status: "queued" | "failed" | "needs_clarification" | "done") {
  const now = "2026-07-10T00:00:00.000Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      phid,
      "team-uuid-test",
      `q_${phid}`,
      "roger",
      "co",
      "manager",
      "subject",
      "body",
      "openai",
      "codex",
      status,
      now,
      now,
    ],
  );
}

async function seedNeedsReview(overrides: {
  title: string;
  risk_class?: "build" | "destructive" | "external";
  flesh_confidence?: number | null;
  last_dispatch_phid?: string;
}) {
  const item = await insertBacklogItem(adapter, {
    title: overrides.title,
    readiness_state: "needs_review",
    risk_class: overrides.risk_class ?? "build",
    to_agent: "roger",
    dispatch_body: `[project: kapelle][T-ORCH] ${overrides.title}`,
    write_scope: ["cane/id-agents"],
  });
  await adapter.query(
    `UPDATE orchestration_backlog_item
        SET flesh_status = 'fleshed', flesh_confidence = $1
      WHERE item_id = $2`,
    [overrides.flesh_confidence ?? 0.9, item.item_id],
  );
  if (overrides.last_dispatch_phid) {
    await setItemState(adapter, item.item_id, "needs_review", { dispatch_phid: overrides.last_dispatch_phid });
  }
  return item;
}

describe("GET /orchestration/backlog/needs-promote-report", () => {
  it("groups needs_review rows by skip class and includes prior dispatch retry ledger status", async () => {
    await seedDispatch("phid:disp-queued", "queued");
    await seedDispatch("phid:disp-done", "done");
    await seedDispatch("phid:disp-failed", "failed");
    await seedDispatch("phid:disp-needs-clarification", "needs_clarification");

    const queuedDup = await seedNeedsReview({
      title: "already dispatched queued duplicate",
      last_dispatch_phid: "phid:disp-queued",
    });
    const doneDup = await seedNeedsReview({
      title: "already dispatched done duplicate",
      last_dispatch_phid: "phid:disp-done",
    });
    const failedDup = await seedNeedsReview({
      title: "already dispatched failed duplicate",
      last_dispatch_phid: "phid:disp-failed",
    });
    const needsClarificationDup = await seedNeedsReview({
      title: "already dispatched needs clarification duplicate",
      last_dispatch_phid: "phid:disp-needs-clarification",
    });
    await seedNeedsReview({
      title: "confidence held",
      flesh_confidence: 0.5,
    });
    await seedNeedsReview({
      title: "risk held",
      risk_class: "destructive",
      flesh_confidence: 0.95,
    });

    const r = await call("GET", "/orchestration/backlog/needs-promote-report");

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.total_needs_review).toBe(6);
    expect(r.body.auto_promotable).toBe(0);
    expect(r.body.counts).toEqual({
      already_dispatched: 4,
      confidence_threshold: 1,
      review_held_risk: 1,
    });

    expect(r.body.groups.already_dispatched.count).toBe(4);
    expect(r.body.groups.confidence_threshold.count).toBe(1);
    expect(r.body.groups.review_held_risk.count).toBe(1);

    const priorByItem = Object.fromEntries(
      r.body.groups.already_dispatched.items.map((item: any) => [item.item_id, item]),
    );
    expect(priorByItem[queuedDup.item_id].prior_dispatch_phid).toBe("phid:disp-queued");
    expect(priorByItem[queuedDup.item_id].prior_dispatch_status).toBe("queued");
    expect(priorByItem[doneDup.item_id].prior_dispatch_phid).toBe("phid:disp-done");
    expect(priorByItem[doneDup.item_id].prior_dispatch_status).toBe("done");
    expect(priorByItem[failedDup.item_id].prior_dispatch_phid).toBe("phid:disp-failed");
    expect(priorByItem[failedDup.item_id].prior_dispatch_status).toBe("failed");
    expect(priorByItem[needsClarificationDup.item_id].prior_dispatch_phid).toBe("phid:disp-needs-clarification");
    expect(priorByItem[needsClarificationDup.item_id].prior_dispatch_status).toBe("needs_clarification");
  });
});
