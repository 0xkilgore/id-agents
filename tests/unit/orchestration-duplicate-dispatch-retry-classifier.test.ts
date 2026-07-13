import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import {
  insertBacklogItem,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
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

async function call(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const body = await r.json();
        server.close(() => resolve({ status: r.status, body }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

async function seedDispatch(overrides: {
  phid: string;
  status: string;
  recovery_status?: string | null;
  failure_kind?: string | null;
  failure_detail?: string | null;
  promotion_result_json?: string | null;
}) {
  const now = "2026-07-13T00:00:00.000Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at,
        recovery_status, failure_kind, failure_detail, promotion_result_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      overrides.phid,
      "team-uuid-test",
      `q_${overrides.phid}`,
      "roger",
      "co",
      "manager",
      "subject",
      "body",
      "openai",
      "codex",
      overrides.status,
      now,
      now,
      overrides.recovery_status ?? "none",
      overrides.failure_kind ?? null,
      overrides.failure_detail ?? null,
      overrides.promotion_result_json ?? null,
    ],
  );
}

async function seedReadyBlocker(overrides: {
  title: string;
  phid: string;
  to_agent?: string | null;
  retry_safe?: boolean;
  state?: "ready" | "needs_review" | "done";
}) {
  const item = await insertBacklogItem(adapter, {
    title: overrides.title,
    readiness_state: overrides.state ?? "ready",
    risk_class: "build",
    to_agent: overrides.to_agent ?? "roger",
    dispatch_body: `[project: kapelle][T-ORCH] ${overrides.title}`,
    write_scope: ["cane/id-agents"],
    retry_safe: overrides.retry_safe,
  });
  await setItemState(adapter, item.item_id, overrides.state ?? "ready", { dispatch_phid: overrides.phid });
  return item;
}

async function stateCounts() {
  const { rows } = await adapter.query<{ readiness_state: string; count: number }>(
    `SELECT readiness_state, COUNT(*) AS count
       FROM orchestration_backlog_item
      GROUP BY readiness_state
      ORDER BY readiness_state`,
  );
  return rows.map((r) => [r.readiness_state, Number(r.count)]);
}

describe("GET /orchestration/backlog/duplicate-dispatch-retry-blockers", () => {
  it("classifies terminal, non-terminal, and retry-safe duplicate ready blockers without mutating", async () => {
    await seedDispatch({ phid: "phid:done", status: "done" });
    await seedDispatch({ phid: "phid:cancelled", status: "cancelled" });
    await seedDispatch({ phid: "phid:in-flight", status: "in_flight" });
    await seedDispatch({
      phid: "phid:retryable",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in_flight claim",
    });
    await seedDispatch({
      phid: "phid:promoted",
      status: "failed",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });

    const done = await seedReadyBlocker({ title: "done duplicate", phid: "phid:done" });
    const cancelled = await seedReadyBlocker({ title: "cancelled duplicate", phid: "phid:cancelled", to_agent: "hopper" });
    const live = await seedReadyBlocker({ title: "live duplicate", phid: "phid:in-flight" });
    const retryable = await seedReadyBlocker({ title: "retryable duplicate", phid: "phid:retryable" });
    const promoted = await seedReadyBlocker({ title: "promoted duplicate", phid: "phid:promoted" });
    await seedReadyBlocker({ title: "operator approved retry", phid: "phid:retryable", retry_safe: true });
    await seedReadyBlocker({ title: "needs review duplicate", phid: "phid:done", state: "needs_review" });

    const before = await stateCounts();
    const r = await call("/orchestration/backlog/duplicate-dispatch-retry-blockers");
    const after = await stateCounts();

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.report).toMatchObject({
      schema_version: "orchestration.duplicate_dispatch_retry_classification.v1",
      dry_run: true,
      scanned: 6,
      count: 5,
    });
    expect(after).toEqual(before);

    const byId = Object.fromEntries(r.body.report.items.map((item: any) => [item.item_id, item]));
    expect(byId[done.item_id]).toMatchObject({
      item_id: done.item_id,
      prior_dispatch_id: "phid:done",
      recommended_disposition: "close",
      owner: "roger",
    });
    expect(byId[promoted.item_id]).toMatchObject({
      prior_dispatch_id: "phid:promoted",
      prior_dispatch_status: "failed",
      recommended_disposition: "close",
    });
    expect(byId[cancelled.item_id]).toMatchObject({
      prior_dispatch_id: "phid:cancelled",
      recommended_disposition: "supersede",
      owner: "hopper",
    });
    expect(byId[live.item_id]).toMatchObject({
      prior_dispatch_id: "phid:in-flight",
      prior_dispatch_status: "in_flight",
      recommended_disposition: "supersede",
    });
    expect(byId[retryable.item_id]).toMatchObject({
      prior_dispatch_id: "phid:retryable",
      prior_dispatch_status: "failed",
      recommended_disposition: "mark-retry-safe",
    });
  });
});
