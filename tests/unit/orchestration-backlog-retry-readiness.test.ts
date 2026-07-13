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
  failure_kind?: string | null;
  failure_detail?: string | null;
  recovery_status?: string | null;
  recovery_attempts?: number;
  promotion_result_json?: string | null;
}) {
  const now = "2026-07-12T00:00:00.000Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at,
        failure_kind, failure_detail, recovery_status, recovery_attempts, promotion_result_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
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
      overrides.failure_kind ?? null,
      overrides.failure_detail ?? null,
      overrides.recovery_status ?? "none",
      overrides.recovery_attempts ?? 0,
      overrides.promotion_result_json ?? null,
    ],
  );
}

async function seedNeedsReview(title: string, phid: string) {
  const item = await insertBacklogItem(adapter, {
    title,
    readiness_state: "needs_review",
    risk_class: "build",
    to_agent: "roger",
    dispatch_body: `[project: kapelle] ${title}`,
    write_scope: ["kapelle/backend"],
  });
  await setItemState(adapter, item.item_id, "needs_review", { dispatch_phid: phid });
  return item;
}

describe("GET /orchestration/backlog retry_readiness", () => {
  it("classifies focused retry-readiness fixtures without conflating duplicates and retry fuel", async () => {
    await seedDispatch({
      phid: "phid:disp-terminal-success",
      status: "done",
      promotion_result_json: JSON.stringify({
        completed: true,
        repos: [{ pushed: true, verified: true, promoted_sha: "abc123", remote_main_sha: "abc123" }],
      }),
    });
    await seedDispatch({
      phid: "phid:disp-active-failed-retry",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "agent process lost during dispatch",
      recovery_attempts: 1,
    });
    await seedDispatch({
      phid: "phid:disp-linked-query-expired",
      status: "failed",
      failure_kind: "expired",
      failure_detail: "linked query terminated expired",
    });
    await seedDispatch({
      phid: "phid:disp-manual-promote",
      status: "failed",
      failure_kind: "provider_timeout",
      failure_detail: "provider_timeout while waiting for agent reply",
    });

    const terminalSuccess = await seedNeedsReview(
      "terminal-success stale duplicate fixture",
      "phid:disp-terminal-success",
    );
    const failedRetry = await seedNeedsReview("active failed retry candidate fixture", "phid:disp-active-failed-retry");
    const linkedQueryExpired = await seedNeedsReview(
      "linked-query-expired noise fixture",
      "phid:disp-linked-query-expired",
    );
    const manualPromote = await seedNeedsReview("manual promote required fixture", "phid:disp-manual-promote");

    const r = await call("/orchestration/backlog?state=needs_review");

    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((item: any) => [item.item_id, item]));

    expect(byId[terminalSuccess.item_id].retry_readiness).toMatchObject({
      status: "stale_duplicate",
      retryable: false,
      stale_duplicate: true,
      manual_promote_required: false,
      next_action: "close_or_ignore",
      prior_dispatch_status: "done",
    });
    expect(byId[failedRetry.item_id].retry_readiness).toMatchObject({
      status: "retryable_failed_row",
      retryable: true,
      stale_duplicate: false,
      manual_promote_required: true,
      next_action: "retry",
      prior_dispatch_status: "failed",
      dispatch_retry_count: 1,
      failure_kind: "scheduler_wedged",
    });
    expect(byId[linkedQueryExpired.item_id].retry_readiness).toMatchObject({
      status: "retryable_failed_row",
      retryable: true,
      stale_duplicate: false,
      manual_promote_required: true,
      next_action: "retry",
      prior_dispatch_status: "failed",
      failure_kind: "expired",
      failure_detail: "linked query terminated expired",
    });
    expect(byId[manualPromote.item_id].retry_readiness).toMatchObject({
      status: "retryable_failed_row",
      retryable: true,
      stale_duplicate: false,
      manual_promote_required: true,
      next_action: "retry",
      prior_dispatch_status: "failed",
      failure_kind: "provider_timeout",
    });
  });

  it("distinguishes retryable failed rows from stale duplicates", async () => {
    await seedDispatch({
      phid: "phid:disp-retryable",
      status: "failed",
      failure_kind: "provider_timeout",
      failure_detail: "linked query terminated expired; retry later",
    });
    await seedDispatch({
      phid: "phid:disp-done",
      status: "done",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });

    const retryable = await seedNeedsReview("retryable failed feedback row", "phid:disp-retryable");
    const stale = await seedNeedsReview("stale duplicate feedback row", "phid:disp-done");

    const r = await call("/orchestration/backlog?state=needs_review");

    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((item: any) => [item.item_id, item]));

    expect(byId[retryable.item_id].retry_readiness).toMatchObject({
      schema_version: "backlog.retry_readiness.v1",
      status: "retryable_failed_row",
      retryable: true,
      stale_duplicate: false,
      manual_promote_required: true,
      next_action: "retry",
      prior_dispatch_phid: "phid:disp-retryable",
      prior_dispatch_status: "failed",
      failure_kind: "provider_timeout",
    });
    expect(byId[stale.item_id].retry_readiness).toMatchObject({
      status: "stale_duplicate",
      retryable: false,
      stale_duplicate: true,
      manual_promote_required: false,
      next_action: "close_or_ignore",
      prior_dispatch_phid: "phid:disp-done",
      prior_dispatch_status: "done",
    });
  });

  it("marks active prior dispatches as wait rows, not retry fuel", async () => {
    await seedDispatch({ phid: "phid:disp-live", status: "in_flight" });
    const item = await seedNeedsReview("live duplicate feedback row", "phid:disp-live");

    const r = await call("/orchestration/backlog?state=needs_review");
    const got = r.body.items.find((row: any) => row.item_id === item.item_id);

    expect(got.retry_readiness).toMatchObject({
      status: "waiting_on_live_dispatch",
      retryable: false,
      stale_duplicate: false,
      manual_promote_required: false,
      next_action: "wait",
      prior_dispatch_status: "in_flight",
    });
  });

  it("keeps needs-clarification prior dispatches as wait rows, not stale false needs_review fuel", async () => {
    await seedDispatch({
      phid: "phid:disp-clarification",
      status: "needs_clarification",
      failure_kind: null,
      failure_detail: null,
    });
    const item = await seedNeedsReview("clarification-blocked feedback row", "phid:disp-clarification");

    const r = await call("/orchestration/backlog?state=needs_review");
    const got = r.body.items.find((row: any) => row.item_id === item.item_id);

    expect(got.retry_readiness).toMatchObject({
      status: "waiting_on_live_dispatch",
      retryable: false,
      stale_duplicate: false,
      manual_promote_required: false,
      next_action: "wait",
      prior_dispatch_status: "needs_clarification",
    });
    expect(got.retry_readiness.reason).toContain(
      "prior dispatch is needs_clarification; retrying now would duplicate live work",
    );
  });
});
