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

async function callPost(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
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
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const responseBody = await r.json();
        server.close(() => resolve({ status: r.status, body: responseBody }));
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
  updated_at?: string;
}) {
  const now = overrides.updated_at ?? "2026-07-13T00:00:00.000Z";
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
  created_at?: string;
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
  if (overrides.created_at) {
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET created_at = $1,
              updated_at = $2
        WHERE item_id = $3`,
      [overrides.created_at, overrides.created_at, item.item_id],
    );
  }
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
  it("classifies terminal, linked-query-expired, failed verification, needs-input, queued, and retry-safe blockers without mutating", async () => {
    await seedDispatch({ phid: "phid:done", status: "done" });
    await seedDispatch({ phid: "phid:cancelled", status: "cancelled" });
    await seedDispatch({ phid: "phid:superseded", status: "superseded" });
    await seedDispatch({ phid: "phid:in-flight", status: "in_flight" });
    await seedDispatch({ phid: "phid:queued", status: "queued" });
    await seedDispatch({ phid: "phid:needs-input", status: "needs_clarification" });
    await seedDispatch({
      phid: "phid:retryable",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in_flight claim",
    });
    await seedDispatch({
      phid: "phid:linked-query-expired",
      status: "failed",
      failure_kind: "agent_error",
      failure_detail: "linked query terminated expired",
    });
    await seedDispatch({
      phid: "phid:failed-verification",
      status: "failed",
      failure_kind: "agent_error",
      failure_detail: "promotion verification failed",
      promotion_result_json: JSON.stringify({
        required: true,
        completed: false,
        repos: [{ verified: false, path: "/repo" }],
      }),
    });
    await seedDispatch({
      phid: "phid:promoted",
      status: "failed",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });

    const done = await seedReadyBlocker({
      title: "done duplicate",
      phid: "phid:done",
      created_at: "2026-07-10T00:00:00.000Z",
    });
    const cancelled = await seedReadyBlocker({ title: "cancelled duplicate", phid: "phid:cancelled", to_agent: "hopper" });
    const superseded = await seedReadyBlocker({ title: "superseded duplicate", phid: "phid:superseded" });
    const live = await seedReadyBlocker({ title: "live duplicate", phid: "phid:in-flight" });
    const queued = await seedReadyBlocker({ title: "queued duplicate", phid: "phid:queued" });
    const needsInput = await seedReadyBlocker({ title: "needs input duplicate", phid: "phid:needs-input" });
    const retryable = await seedReadyBlocker({ title: "retryable duplicate", phid: "phid:retryable" });
    const linkedQueryExpired = await seedReadyBlocker({
      title: "linked query expired duplicate",
      phid: "phid:linked-query-expired",
    });
    const failedVerification = await seedReadyBlocker({
      title: "failed verification duplicate",
      phid: "phid:failed-verification",
    });
    const promoted = await seedReadyBlocker({ title: "promoted duplicate", phid: "phid:promoted" });
    await seedReadyBlocker({ title: "operator approved retry", phid: "phid:retryable", retry_safe: true });
    await seedReadyBlocker({ title: "needs review duplicate", phid: "phid:done", state: "needs_review" });

    const before = await stateCounts();
    const r = await call("/orchestration/backlog/duplicate-dispatch-retry-blockers");
    const after = await stateCounts();

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.report).toMatchObject({
      schema_version: "orchestration.duplicate_dispatch_retry_classification.v2",
      dry_run: true,
      scanned: 11,
      count: 10,
      oldest_age_ms: expect.any(Number),
      oldest_age_hours: expect.any(Number),
    });
    expect(after).toEqual(before);

    const byId = Object.fromEntries(r.body.report.items.map((item: any) => [item.item_id, item]));
    expect(byId[done.item_id]).toMatchObject({
      item_id: done.item_id,
      prior_dispatch_id: "phid:done",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "close",
      owner: "roger",
      failure_kind: null,
      failure_class: "stale_duplicate",
      age_ms: expect.any(Number),
      age_hours: expect.any(Number),
    });
    expect(byId[promoted.item_id]).toMatchObject({
      prior_dispatch_id: "phid:promoted",
      prior_dispatch_status: "failed",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "close",
      failure_class: "stale_duplicate",
    });
    expect(byId[cancelled.item_id]).toMatchObject({
      prior_dispatch_id: "phid:cancelled",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
      failure_class: "stale_duplicate",
      owner: "hopper",
    });
    expect(byId[superseded.item_id]).toMatchObject({
      prior_dispatch_id: "phid:superseded",
      prior_dispatch_status: "superseded",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
      failure_class: "stale_duplicate",
    });
    expect(byId[live.item_id]).toMatchObject({
      prior_dispatch_id: "phid:in-flight",
      prior_dispatch_status: "in_flight",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
      failure_class: "live_or_queued",
    });
    expect(byId[queued.item_id]).toMatchObject({
      prior_dispatch_id: "phid:queued",
      prior_dispatch_status: "queued",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
      failure_class: "live_or_queued",
    });
    expect(byId[needsInput.item_id]).toMatchObject({
      prior_dispatch_id: "phid:needs-input",
      prior_dispatch_status: "needs_clarification",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
      failure_class: "needs_input",
    });
    expect(byId[retryable.item_id]).toMatchObject({
      prior_dispatch_id: "phid:retryable",
      prior_dispatch_status: "failed",
      operator_disposition: "retry",
      retry_safe_recommendation: "set_true",
      recommended_disposition: "mark-retry-safe",
      failure_class: "retryable_transient",
    });
    expect(byId[linkedQueryExpired.item_id]).toMatchObject({
      prior_dispatch_id: "phid:linked-query-expired",
      prior_dispatch_status: "failed",
      failure_kind: "agent_error",
      failure_detail: "linked query terminated expired",
      failure_class: "linked_query_expired",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
    });
    expect(byId[failedVerification.item_id]).toMatchObject({
      prior_dispatch_id: "phid:failed-verification",
      prior_dispatch_status: "failed",
      failure_kind: "agent_error",
      failure_detail: "promotion verification failed",
      failure_class: "failed_verification",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      recommended_disposition: "supersede",
    });
    expect(r.body.report.oldest_age_ms).toBeGreaterThanOrEqual(byId[done.item_id].age_ms);
    expect(r.body.report.oldest_age_hours).toBeGreaterThanOrEqual(byId[done.item_id].age_hours);
  });
});

describe("GET /orchestration/backlog/duplicate-dispatch-retry-blockers/stale-clarifications", () => {
  it("lists only needs-clarification prior dispatches older than the cutoff without marking retry-safe", async () => {
    await seedDispatch({ phid: "phid:stale-input", status: "needs_clarification", updated_at: "2026-07-16T00:00:00.000Z" });
    await seedDispatch({ phid: "phid:fresh-input", status: "needs_clarification", updated_at: new Date().toISOString() });
    await seedDispatch({ phid: "phid:old-queued", status: "queued", updated_at: "2026-07-16T00:00:00.000Z" });
    const stale = await seedReadyBlocker({ title: "stale clarification", phid: "phid:stale-input" });
    await seedReadyBlocker({ title: "fresh clarification", phid: "phid:fresh-input" });
    await seedReadyBlocker({ title: "old queued", phid: "phid:old-queued" });

    const before = await stateCounts();
    const r = await call("/orchestration/backlog/duplicate-dispatch-retry-blockers/stale-clarifications?older_than_hours=24&limit=1");

    expect(r.status).toBe(200);
    expect(r.body.report).toMatchObject({
      schema_version: "orchestration.stale_needs_clarification_retry_blockers.v1",
      dry_run: true,
      older_than_hours: 24,
      limit: 1,
      matched: 1,
      count: 1,
      truncated: false,
      guidance: expect.stringContaining("Do not mark retry_safe"),
    });
    expect(r.body.report.items).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        prior_dispatch_status: "needs_clarification",
        operator_action: "review_then_supersede",
        recommended_disposition: "supersede",
        retry_safe_recommendation: "leave_false",
        reason: expect.stringContaining("after operator review"),
      }),
    ]);
    expect(await stateCounts()).toEqual(before);
  });

  it("closes a terminal done duplicate row through the single-item manager action path", async () => {
    await seedDispatch({ phid: "phid:done-close", status: "done" });
    const duplicate = await seedReadyBlocker({ title: "done duplicate closeout", phid: "phid:done-close" });

    const res = await callPost(`/orchestration/backlog/${duplicate.item_id}/close-stale-duplicate`, {
      actor: "hopper",
      expected_last_dispatch_phid: "phid:done-close",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.receipt).toMatchObject({
      closed_by: "hopper",
      from_state: "ready",
      to_state: "done",
      next_action: "close_duplicate_row",
      prior_dispatch_phid: "phid:done-close",
      prior_dispatch_status: "done",
    });
    expect(res.body.item).toMatchObject({
      item_id: duplicate.item_id,
      readiness_state: "done",
      updated_by: "hopper",
    });
    expect(res.body.item.source_refs).toContain("manager:/orchestration/backlog/" + duplicate.item_id + "#stale-duplicate-closeout-receipt");
  });

  it("refuses the single-item closeout path for retryable failed duplicate rows", async () => {
    await seedDispatch({
      phid: "phid:retryable-closeout",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in_flight claim",
    });
    const duplicate = await seedReadyBlocker({ title: "retryable duplicate closeout", phid: "phid:retryable-closeout" });

    const res = await callPost(`/orchestration/backlog/${duplicate.item_id}/close-stale-duplicate`, {
      actor: "hopper",
      expected_last_dispatch_phid: "phid:retryable-closeout",
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      error: "prior_dispatch_not_terminal_or_safe",
    });
    expect((await stateCounts()).find(([state]) => state === "ready")).toEqual(["ready", 1]);
  });
});
