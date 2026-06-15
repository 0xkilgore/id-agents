// Dispatch-recovery reactor adapter + live reconciliation (P0 disp-b329f522…).
//
// Two layers:
//   1. The four SqliteDispatchReactor recovery primitives in isolation
//      (list / requeue / landed / outcome).
//   2. DispatchRecoveryService.runOnce wired to the real reactor via
//      makeRecoveryReactor — the load-bearing reconciliation the foundation
//      shipped dark. Covers the three required cases: expired+promotion →
//      landed_reconciled (no retry); expired internal no-evidence → requeue;
//      external side effect → unsafe (operator surface, no resend).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { makeRecoveryReactor } from "../../src/dispatch-recovery/reactor-adapter.js";
import {
  DispatchRecoveryService,
} from "../../src/dispatch-recovery/service.js";
import { DEFAULT_RECOVERY_CONFIG } from "../../src/dispatch-recovery/classifier.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const NOW = "2026-06-15T20:00:00.000Z";

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "coder-max",
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
  tmpDir = mkdtempSync(join(tmpdir(), "recovery-adapter-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-test', 'test')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness(now = NOW) {
  const reactor = new SqliteDispatchReactor({
    adapter,
    teamId: "team-test",
    now: () => now,
  });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

/**
 * Enqueue, then drive the row into a terminal `failed` state with the supplied
 * recovery-relevant columns. Direct UPDATE keeps the fixture explicit — the
 * lifecycle transitions are exercised by the dedicated lifecycle suite.
 */
async function seedFailed(
  client: DispatchDocClient,
  overrides: {
    query_id: string;
    channel?: string;
    failure_detail?: string;
    completed_at?: string;
    artifact_path?: string | null;
    promotion_completed?: boolean;
    recovery_attempts?: number;
    recovery_status?: string;
    side_effect?: string;
    allow_auto_retry?: boolean;
  },
): Promise<string> {
  const enq = await client.enqueueDispatch({ ...base, query_id: overrides.query_id });
  if (!enq.ok) throw new Error("enqueue failed");
  const phid = enq.value.dispatch_phid;
  await adapter.query(
    `UPDATE dispatch_scheduler_queue
       SET status = 'failed',
           failure_kind = 'expired',
           failure_detail = ?,
           completed_at = ?,
           channel = ?,
           artifact_path = ?,
           promotion_result_json = ?,
           recovery_attempts = ?,
           recovery_status = ?,
           side_effect = ?,
           allow_auto_retry = ?
     WHERE dispatch_phid = ? AND team_id = 'team-test'`,
    [
      overrides.failure_detail ?? "linked query terminated expired",
      overrides.completed_at ?? NOW,
      overrides.channel ?? "dispatch",
      overrides.artifact_path ?? null,
      overrides.promotion_completed ? JSON.stringify({ completed: true }) : null,
      overrides.recovery_attempts ?? 0,
      overrides.recovery_status ?? "none",
      overrides.side_effect ?? "none",
      overrides.allow_auto_retry ? 1 : 0,
      phid,
    ],
  );
  return phid;
}

async function statusOf(phid: string): Promise<string> {
  const { rows } = await adapter.query<{ status: string; recovery_status: string; recovery_attempts: number }>(
    `SELECT status, recovery_status, recovery_attempts FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
    [phid],
  );
  return rows[0]!.status;
}

async function recoveryOf(phid: string) {
  const { rows } = await adapter.query<{
    status: string;
    recovery_status: string;
    recovery_attempts: number;
    recovery_reason: string | null;
    not_before_at: string;
  }>(
    `SELECT status, recovery_status, recovery_attempts, recovery_reason, not_before_at
       FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
    [phid],
  );
  return rows[0]!;
}

describe("SqliteDispatchReactor recovery primitives", () => {
  it("listFailedForRecovery projects recovery fields and lookback", async () => {
    const { reactor, client } = harness();
    const recent = await seedFailed(client, {
      query_id: "recent",
      artifact_path: "/out/x.md",
      recovery_attempts: 1,
      side_effect: "email",
      allow_auto_retry: true,
    });
    // Outside the lookback window → excluded.
    await seedFailed(client, { query_id: "stale", completed_at: "2026-01-01T00:00:00.000Z" });

    const list = await reactor.listFailedForRecovery({ lookbackMs: 24 * 60 * 60 * 1000 });
    expect(list).toHaveLength(1);
    const row = list[0]!;
    expect(row.dispatch_phid).toBe(recent);
    expect(row.status).toBe("failed");
    expect(row.failure_detail).toBe("linked query terminated expired");
    expect(row.artifact_path).toBe("/out/x.md");
    expect(row.recovery_attempts).toBe(1);
    expect(row.side_effect).toBe("email");
    expect(row.allow_auto_retry).toBe(true);
    expect(row.promotion_completed).toBe(null);
  });

  it("listFailedForRecovery derives promotion_completed and excludes settled rows", async () => {
    const { reactor, client } = harness();
    await seedFailed(client, { query_id: "promoted", promotion_completed: true });
    await seedFailed(client, { query_id: "settled", recovery_status: "needs_operator" });

    const list = await reactor.listFailedForRecovery();
    expect(list).toHaveLength(1);
    expect(list[0]!.promotion_completed).toBe(true);
  });

  it("requeueForRecovery moves failed → bounced with bumped attempts", async () => {
    const { reactor, client } = harness();
    const phid = await seedFailed(client, { query_id: "retry", recovery_attempts: 1 });
    const ok = await reactor.requeueForRecovery(phid, {
      reason: "recovery: recoverable failure",
      next_attempt_at: "2026-06-15T20:05:00.000Z",
    });
    expect(ok).toBe(true);
    const r = await recoveryOf(phid);
    expect(r.status).toBe("bounced");
    expect(r.recovery_status).toBe("recovering");
    expect(r.recovery_attempts).toBe(2);
    expect(r.not_before_at).toBe("2026-06-15T20:05:00.000Z");
    expect(r.recovery_reason).toBe("recovery: recoverable failure");
  });

  it("requeueForRecovery returns false when row is not a terminal failure", async () => {
    const { reactor, client } = harness();
    const enq = await client.enqueueDispatch({ ...base, query_id: "queued" });
    expect(enq.ok).toBe(true);
    if (!enq.ok) return;
    const ok = await reactor.requeueForRecovery(enq.value.dispatch_phid, {
      reason: "x",
      next_attempt_at: NOW,
    });
    expect(ok).toBe(false);
    expect(await statusOf(enq.value.dispatch_phid)).toBe("queued");
  });

  it("markRecoveryLanded flips failed → done, landed_reconciled", async () => {
    const { reactor, client } = harness();
    const phid = await seedFailed(client, { query_id: "landed", promotion_completed: true });
    await reactor.markRecoveryLanded(phid);
    const r = await recoveryOf(phid);
    expect(r.status).toBe("done");
    expect(r.recovery_status).toBe("landed_reconciled");
  });

  it("recordRecoveryOutcome triages without re-dispatch", async () => {
    const { reactor, client } = harness();
    const phid = await seedFailed(client, { query_id: "triage", side_effect: "email" });
    await reactor.recordRecoveryOutcome(phid, {
      decision: "unsafe_side_effect",
      reason: "external side effect without allow_auto_retry",
    });
    const r = await recoveryOf(phid);
    expect(r.status).toBe("failed"); // NOT resent
    expect(r.recovery_status).toBe("unsafe_side_effect");
    expect(r.recovery_reason).toContain("external side effect");
  });
});

describe("DispatchRecoveryService live reconciliation", () => {
  function service(reactor: SqliteDispatchReactor) {
    return new DispatchRecoveryService({
      reactor: makeRecoveryReactor(reactor, { now: () => NOW }),
      config: DEFAULT_RECOVERY_CONFIG,
      now: () => NOW,
      enabled: true,
      budget: 10,
      backoffMs: 60_000,
    });
  }

  it("reconciles landed, requeues internal, and protects external in one pass", async () => {
    const { reactor, client } = harness();
    const landedPhid = await seedFailed(client, { query_id: "landed", promotion_completed: true });
    const retryPhid = await seedFailed(client, { query_id: "retry" });
    const externalPhid = await seedFailed(client, { query_id: "ext", side_effect: "email" });

    const report = await service(reactor).runOnce();

    expect(report.skipped).toBe(false);
    expect(report.scanned).toBe(3);
    expect(report.landed).toBe(1);
    expect(report.retried).toBe(1);
    expect(report.unsafe_side_effect).toBe(1);

    expect((await recoveryOf(landedPhid)).status).toBe("done");
    expect((await recoveryOf(landedPhid)).recovery_status).toBe("landed_reconciled");

    const retry = await recoveryOf(retryPhid);
    expect(retry.status).toBe("bounced");
    expect(retry.recovery_attempts).toBe(1);

    const ext = await recoveryOf(externalPhid);
    expect(ext.status).toBe("failed");
    expect(ext.recovery_status).toBe("unsafe_side_effect");
  });

  it("is a no-op when disabled", async () => {
    const { reactor, client } = harness();
    const phid = await seedFailed(client, { query_id: "retry" });
    const svc = new DispatchRecoveryService({
      reactor: makeRecoveryReactor(reactor, { now: () => NOW }),
      config: DEFAULT_RECOVERY_CONFIG,
      now: () => NOW,
      enabled: false,
      budget: 10,
      backoffMs: 60_000,
    });
    const report = await svc.runOnce();
    expect(report.skipped).toBe(true);
    expect(await statusOf(phid)).toBe("failed");
  });
});
