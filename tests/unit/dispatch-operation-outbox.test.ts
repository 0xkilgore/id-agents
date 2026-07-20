import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import {
  configureDispatchOperationOutbox,
  DispatchOperationOutboxWorker,
  type DispatchOperationEnvelope,
} from "../../src/dispatch-scheduler/dispatch-operation-outbox.js";

let dir: string;
let adapter: SqliteAdapter;
const now = "2026-07-20T20:00:00.000Z";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-outbox-"));
  adapter = new SqliteAdapter(join(dir, "manager.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-test', 'test')`);
});
afterEach(async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); });

function reactor() {
  return new SqliteDispatchReactor({ adapter, teamId: "team-test", now: () => now });
}
const input = {
  query_id: "query-1", to_agent: "roger", from_actor: "manager", channel: "dispatch",
  subject: "shadow", body_markdown: "body", provider: "anthropic" as const,
  runtime: "claude-code-cli" as const, priority: 5,
};

describe("dispatch operation transactional outbox", () => {
  it("is shadow-disabled by default and rolls back by flipping one control row", async () => {
    const r = reactor();
    const disabled = await r.enqueue(input);
    expect((await adapter.query(`SELECT * FROM dispatch_operation_outbox`)).rowCount).toBe(0);
    await r.cancel(disabled.dispatch_phid, "test setup");
    await configureDispatchOperationOutbox(adapter, true);
    const doc = await r.enqueue({ ...input, query_id: "query-2" });
    await r.claim({ limit: 1, now });
    await r.markDone(doc.dispatch_phid);
    const rows = await adapter.query<{ operation_type: string }>(
      `SELECT operation_type FROM dispatch_operation_outbox WHERE dispatch_phid = ? ORDER BY rowid`, [doc.dispatch_phid],
    );
    expect(rows.rows.map((row) => row.operation_type)).toEqual([
      "dispatch.requested", "dispatch.started", "dispatch.completed",
    ]);
    await configureDispatchOperationOutbox(adapter, false);
    await r.enqueue({ ...input, query_id: "query-3" });
    expect((await adapter.query(`SELECT * FROM dispatch_operation_outbox`)).rowCount).toBe(3);
  });

  it("replays with a stable idempotency key and retries sink failures without touching dispatch state", async () => {
    await configureDispatchOperationOutbox(adapter, true);
    const r = reactor();
    const doc = await r.enqueue(input);
    const seen: DispatchOperationEnvelope[] = [];
    let fail = true;
    const worker = new DispatchOperationOutboxWorker(adapter, {
      append: async (envelope) => { seen.push(envelope); if (fail) throw new Error("reactor unavailable"); },
    }, "worker-1", () => now, 3);
    expect(await worker.replayBatch()).toEqual({ delivered: 0, failed: 1, dead_lettered: 0 });
    expect((await r.getByPhid(doc.dispatch_phid))?.status).toBe("queued");
    await adapter.query(`UPDATE dispatch_operation_outbox SET available_at = ?`, [now]);
    fail = false;
    expect(await worker.replayBatch()).toEqual({ delivered: 1, failed: 0, dead_lettered: 0 });
    expect(seen[0].idempotency_key).toBe(seen[1].idempotency_key);
  });

  it("emits typed receipts for failure, cancellation, clarification, and retry", async () => {
    await configureDispatchOperationOutbox(adapter, true);
    const r = reactor();
    const failed = await r.enqueue({ ...input, query_id: "query-failed" });
    await r.claim({ limit: 1, now });
    await r.markFailed(failed.dispatch_phid, { failure_kind: "agent_error", detail: "boom" });

    const cancelled = await r.enqueue({ ...input, query_id: "query-cancelled" });
    await r.cancel(cancelled.dispatch_phid, "operator cancelled");

    const clarification = await r.enqueue({ ...input, query_id: "query-clarification" });
    await r.markNeedsClarification(clarification.dispatch_phid, { agent_id: "roger", question: "Which path?" });

    const retry = await r.enqueue({ ...input, query_id: "query-retry" });
    await r.claim({ limit: 1, now });
    await r.markBounced(retry.dispatch_phid, {
      kind: "rate_limit", message: "later", next_attempt_at: now,
    });

    const { rows } = await adapter.query<{ operation_type: string }>(
      `SELECT operation_type FROM dispatch_operation_outbox`,
    );
    const types = new Set(rows.map((row) => row.operation_type));
    for (const type of [
      "dispatch.failed", "dispatch.cancelled", "dispatch.clarification_requested", "dispatch.retry_scheduled",
    ]) expect(types.has(type)).toBe(true);
  });
});
