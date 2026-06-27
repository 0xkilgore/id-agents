// P0 control-plane Slice 3 — pre-dispatch dedup guard.
//
// A dedup_key on enqueue collapses re-fires of the SAME logical work: while a
// dispatch for that key is NON-TERMINAL (queued / in_flight / needs_clarification
// / bounced / resume_delivery_failed) a repeat enqueue REUSES it (no duplicate
// row). Once it reaches a TERMINAL state (done / failed / cancelled) the key is
// free and a fresh enqueue is allowed (legitimate refire). Enqueues WITHOUT a
// dedup_key keep the old behavior (manual /talk dispatches never dedup).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "roger",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "scheduler-dedup-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-test', 'test')`);
});
afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function reactorOf(now = "2026-06-25T20:00:00.000Z") {
  return new SqliteDispatchReactor({ adapter, teamId: "team-test", now: () => now });
}

async function rowCount(dedup_key: string): Promise<number> {
  const { rows } = await adapter.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dispatch_scheduler_queue WHERE dedup_key = ? AND team_id = 'team-test'`,
    [dedup_key],
  );
  return Number(rows[0]?.n ?? 0);
}

async function setStatus(phid: string, status: string): Promise<void> {
  await adapter.query(`UPDATE dispatch_scheduler_queue SET status = ? WHERE dispatch_phid = ?`, [status, phid]);
}

async function setRecoveryStatus(phid: string, recoveryStatus: string): Promise<void> {
  await adapter.query(`UPDATE dispatch_scheduler_queue SET recovery_status = ? WHERE dispatch_phid = ?`, [
    recoveryStatus,
    phid,
  ]);
}

async function setLinkedQueryFailed(phid: string, recoveryStatus = "needs_operator"): Promise<void> {
  await adapter.query(
    `UPDATE dispatch_scheduler_queue
        SET status = 'failed',
            agent_query_id = 'agent-q-failed',
            failure_kind = 'agent_error',
            failure_detail = 'linked query terminated failed',
            recovery_status = ?
      WHERE dispatch_phid = ?`,
    [recoveryStatus, phid],
  );
}

describe("dispatch enqueue dedup guard", () => {
  it("reuses the existing dispatch when re-enqueued with the same dedup_key while QUEUED", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "item-T-MODEL" });
    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "item-T-MODEL" });
    expect(b.dispatch_phid).toBe(a.dispatch_phid); // reused, not a new row
    expect(await rowCount("item-T-MODEL")).toBe(1);
  });

  it("reuses while IN_FLIGHT and while NEEDS_CLARIFICATION (non-terminal states)", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "k" });

    await setStatus(a.dispatch_phid, "in_flight");
    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "k" });
    expect(b.dispatch_phid).toBe(a.dispatch_phid);

    await setStatus(a.dispatch_phid, "needs_clarification");
    const c = await r.enqueue({ ...base, query_id: "q3", dedup_key: "k" });
    expect(c.dispatch_phid).toBe(a.dispatch_phid);

    expect(await rowCount("k")).toBe(1);
  });

  it("allows a fresh dispatch once the prior one is TERMINAL (done → refire)", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "k" });
    await setStatus(a.dispatch_phid, "in_flight"); // markDone runs from in_flight
    await r.markDone(a.dispatch_phid);

    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "k" });
    expect(b.dispatch_phid).not.toBe(a.dispatch_phid); // refire allowed
    expect(await rowCount("k")).toBe(2); // one terminal + one fresh active
  });

  it("W-006: reuses a terminal linked-query failure by dedup_key once operator attention is recorded", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "storm-key" });
    await setLinkedQueryFailed(a.dispatch_phid);

    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "storm-key" });

    expect(b.dispatch_phid).toBe(a.dispatch_phid);
    expect(await rowCount("storm-key")).toBe(1);
  });

  it("W-006: reuses a terminal linked-query failure by agent and title when no dedup_key exists", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, subject: "storm title" });
    await setLinkedQueryFailed(a.dispatch_phid);

    const b = await r.enqueue({ ...base, query_id: "q2", subject: "storm title" });

    expect(b.dispatch_phid).toBe(a.dispatch_phid);
  });

  it("W-006: does not reuse unrelated terminal failures", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "k" });
    await adapter.query(
      `UPDATE dispatch_scheduler_queue
          SET status = 'failed',
              failure_kind = 'agent_error',
              failure_detail = 'ordinary validation failed',
              recovery_status = 'needs_operator'
        WHERE dispatch_phid = ?`,
      [a.dispatch_phid],
    );

    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "k" });

    expect(b.dispatch_phid).not.toBe(a.dispatch_phid);
    expect(await rowCount("k")).toBe(2);
  });

  it("allows a fresh dispatch once a prior non-terminal row is mooted", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "k" });
    await setStatus(a.dispatch_phid, "needs_clarification");
    await setRecoveryStatus(a.dispatch_phid, "moot");

    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "k" });

    expect(b.dispatch_phid).not.toBe(a.dispatch_phid);
    expect(await rowCount("k")).toBe(2);
  });

  it("allows a fresh dispatch after CANCEL (terminal)", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "k" });
    await r.cancel(a.dispatch_phid, "superseded");
    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "k" });
    expect(b.dispatch_phid).not.toBe(a.dispatch_phid);
  });

  it("does NOT dedup when no dedup_key is given (manual /talk compatibility)", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base });
    const b = await r.enqueue({ ...base, query_id: "q2" });
    expect(b.dispatch_phid).not.toBe(a.dispatch_phid); // two distinct rows
  });

  it("dedups independently per key", async () => {
    const r = reactorOf();
    const a = await r.enqueue({ ...base, dedup_key: "k1" });
    const b = await r.enqueue({ ...base, query_id: "q2", dedup_key: "k2" });
    expect(b.dispatch_phid).not.toBe(a.dispatch_phid);
    expect(await rowCount("k1")).toBe(1);
    expect(await rowCount("k2")).toBe(1);
  });
});
