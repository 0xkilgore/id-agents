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
  promotion_result_json?: string | null;
}) {
  const now = "2026-07-13T00:00:00.000Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at,
        recovery_status, promotion_result_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
      overrides.promotion_result_json ?? null,
    ],
  );
}

async function seedBacklog(overrides: {
  item_id?: string;
  title: string;
  state: "needs_review" | "ready" | "done";
  phid: string;
  retry_safe?: boolean;
}) {
  const item = await insertBacklogItem(adapter, {
    title: overrides.title,
    readiness_state: overrides.state,
    risk_class: "build",
    to_agent: "roger",
    dispatch_body: `[project: kapelle] ${overrides.title}`,
    write_scope: ["cane/id-agents"],
    retry_safe: overrides.retry_safe,
  });
  await setItemState(adapter, item.item_id, overrides.state, { dispatch_phid: overrides.phid });
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

describe("GET /orchestration/backlog/stale-duplicates", () => {
  it("lists only open already-dispatched rows with terminal prior dispatches and safe closeout payloads", async () => {
    await seedDispatch({ phid: "phid:done", status: "done" });
    await seedDispatch({ phid: "phid:moot", status: "failed", recovery_status: "moot" });
    await seedDispatch({ phid: "phid:superseded", status: "superseded" });
    await seedDispatch({ phid: "phid:cancelled", status: "cancelled" });
    await seedDispatch({
      phid: "phid:failed-promoted",
      status: "failed",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });
    await seedDispatch({ phid: "phid:failed-retry-safe", status: "failed", recovery_status: "none" });
    await seedDispatch({ phid: "phid:live", status: "in_flight" });

    const done = await seedBacklog({ title: "done duplicate", state: "needs_review", phid: "phid:done" });
    const moot = await seedBacklog({ title: "moot duplicate", state: "ready", phid: "phid:moot" });
    const superseded = await seedBacklog({ title: "superseded duplicate", state: "ready", phid: "phid:superseded" });
    const cancelled = await seedBacklog({ title: "cancelled duplicate", state: "ready", phid: "phid:cancelled" });
    const promoted = await seedBacklog({ title: "verified promotion duplicate", state: "needs_review", phid: "phid:failed-promoted" });
    await seedBacklog({ title: "live dispatch", state: "needs_review", phid: "phid:live" });
    await seedBacklog({ title: "human retry", state: "needs_review", phid: "phid:done", retry_safe: true });
    await seedBacklog({ title: "failed retry-safe row", state: "ready", phid: "phid:failed-retry-safe", retry_safe: true });
    await seedBacklog({ title: "already closed", state: "done", phid: "phid:done" });

    const before = await stateCounts();
    const r = await call("/orchestration/backlog/stale-duplicates");
    const after = await stateCounts();

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.report).toMatchObject({
      schema_version: "orchestration.stale_duplicate_backlog_report.v1",
      dry_run: true,
      scanned: 8,
      limit: 25,
      matched: 5,
      truncated: false,
      count: 5,
    });
    expect(after).toEqual(before);

    const byId = Object.fromEntries(r.body.report.items.map((item: any) => [item.item_id, item]));
    expect(byId[done.item_id]).toMatchObject({
      prior_terminal_status: "done",
      recommended_action: "mark_done",
      safe_closeout_payload: {
        dry_run: true,
        expected_last_dispatch_phid: "phid:done",
        from_state: "needs_review",
        to_state: "done",
      },
    });
    expect(byId[cancelled.item_id]).toMatchObject({
      prior_terminal_status: "cancelled",
      recommended_action: "mark_superseded",
      safe_closeout_payload: {
        expected_last_dispatch_phid: "phid:cancelled",
        from_state: "ready",
        to_state: "superseded",
      },
    });
    expect(byId[moot.item_id]).toMatchObject({
      prior_terminal_status: "moot",
      recommended_action: "mark_superseded",
      safe_closeout_payload: {
        expected_last_dispatch_phid: "phid:moot",
        from_state: "ready",
        to_state: "superseded",
      },
    });
    expect(byId[superseded.item_id]).toMatchObject({
      prior_terminal_status: "superseded",
      recommended_action: "mark_superseded",
      safe_closeout_payload: {
        expected_last_dispatch_phid: "phid:superseded",
        from_state: "ready",
        to_state: "superseded",
      },
    });
    expect(byId[promoted.item_id]).toMatchObject({
      prior_terminal_status: "failed",
      promotion_verified: true,
      recommended_action: "mark_done",
    });
  });

  it("bounds stale duplicate suggestions without including active or retry-safe failed rows", async () => {
    await seedDispatch({ phid: "phid:done-a", status: "done" });
    await seedDispatch({ phid: "phid:done-b", status: "done" });
    await seedDispatch({ phid: "phid:active", status: "queued" });
    await seedDispatch({
      phid: "phid:retryable-failed",
      status: "failed",
      recovery_status: "none",
    });

    const first = await seedBacklog({ title: "done duplicate A", state: "needs_review", phid: "phid:done-a" });
    const second = await seedBacklog({ title: "done duplicate B", state: "ready", phid: "phid:done-b" });
    await seedBacklog({ title: "active duplicate", state: "ready", phid: "phid:active" });
    await seedBacklog({
      title: "operator approved failed retry",
      state: "ready",
      phid: "phid:retryable-failed",
      retry_safe: true,
    });

    const before = await stateCounts();
    const r = await call("/orchestration/backlog/stale-duplicates?limit=1");
    const after = await stateCounts();

    expect(r.status).toBe(200);
    expect(after).toEqual(before);
    expect(r.body.report).toMatchObject({
      dry_run: true,
      scanned: 4,
      limit: 1,
      matched: 2,
      truncated: true,
      count: 1,
    });
    expect(r.body.report.items).toHaveLength(1);
    expect([first.item_id, second.item_id]).toContain(r.body.report.items[0].item_id);
    expect(r.body.report.items.map((item: any) => item.title)).not.toContain("active duplicate");
    expect(r.body.report.items.map((item: any) => item.title)).not.toContain("operator approved failed retry");
  });
});
