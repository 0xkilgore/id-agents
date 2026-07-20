import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { runBoundedLifecycleReconciliationCycle } from "../../src/continuous-orchestration/lifecycle-reconciliation-loop.js";
import {
  getBacklogItem,
  insertBacklogItem,
  listRecentDecisions,
} from "../../src/continuous-orchestration/storage.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
});

async function seedPair(input: {
  item_id: string;
  status: "done" | "failed" | "in_flight";
  failure_kind?: string;
  failure_detail?: string;
}) {
  const item = await insertBacklogItem(adapter, {
    item_id: input.item_id,
    title: input.item_id,
    readiness_state: "ready",
    to_agent: "roger",
    dispatch_body: "bounded lifecycle fixture",
  });
  const phid = `phid:disp-${input.item_id}`;
  await adapter.query(
    `UPDATE orchestration_backlog_item SET last_dispatch_phid = $1 WHERE item_id = $2`,
    [phid, item.item_id],
  );
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, failure_kind, failure_detail,
        not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      phid, "team-uuid-test", `query_${input.item_id}`, "roger", "schedule", "manager",
      input.item_id, "body", "openai", "codex", input.status,
      input.failure_kind ?? null, input.failure_detail ?? null,
      "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z",
    ],
  );
  return { item, phid };
}

describe("bounded lifecycle reconciliation loop", () => {
  it("applies only landed-close, terminal-supersede, and verified transient retry-safe classes", async () => {
    const done = await seedPair({ item_id: "a-done", status: "done" });
    const retry = await seedPair({ item_id: "b-retry", status: "failed", failure_kind: "scheduler_wedged" });
    const hold = await seedPair({ item_id: "c-hold", status: "in_flight" });

    const result = await runBoundedLifecycleReconciliationCycle(adapter, {
      cycle_id: "cycle-live",
      dry_run: false,
      max_actions: 10,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result.actions).toEqual({ auto_close: 1, supersede: 0, mark_retry_safe: 1, hold: 1 });
    expect((await getBacklogItem(adapter, done.item.item_id))?.readiness_state).toBe("done");
    expect((await getBacklogItem(adapter, retry.item.item_id))?.retry_safe).toBe(true);
    expect((await getBacklogItem(adapter, hold.item.item_id))?.readiness_state).toBe("ready");
    const ledger = await listRecentDecisions(adapter, { limit: 10 });
    expect(ledger).toHaveLength(3);
    expect(ledger.every((row) => row.action === "lifecycle_reconciliation")).toBe(true);
    expect(ledger.map((row) => row.metadata?.receipt).every(Boolean)).toBe(true);
  });

  it("enforces the per-cycle cap and produces mutation-free dry-run receipts", async () => {
    const first = await seedPair({ item_id: "a-first", status: "done" });
    const second = await seedPair({ item_id: "b-second", status: "done" });
    const result = await runBoundedLifecycleReconciliationCycle(adapter, {
      cycle_id: "cycle-dry",
      dry_run: true,
      max_actions: 1,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ classified: 2, processed: 1, truncated: true, dry_run: true });
    expect(result.receipts[0]).toMatchObject({ action: "auto_close", outcome: "would_apply", dry_run: true });
    expect((await getBacklogItem(adapter, first.item.item_id))?.readiness_state).toBe("ready");
    expect((await getBacklogItem(adapter, second.item.item_id))?.readiness_state).toBe("ready");
    expect(await listRecentDecisions(adapter, { limit: 10 })).toEqual([]);
  });
});
