// P0 dispatch-recovery — end-to-end integration: the real DispatchRecoveryService
// driving the real SqliteDispatchReactor (the live DispatchRecoveryReactor adapter)
// over an in-memory sqlite. Proves landed-reconciliation, retry-requeue, and the
// external-side-effect guard against the actual persistence + bounce machinery.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import {
  DispatchRecoveryService,
  type DispatchRecoveryReactor,
} from "../../src/dispatch-recovery/service.js";
import { DEFAULT_RECOVERY_CONFIG } from "../../src/dispatch-recovery/classifier.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

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
const NOW = "2026-06-15T21:00:00.000Z";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "recovery-int-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-test', 'test')`);
});
afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness() {
  const reactor = new SqliteDispatchReactor({ adapter, teamId: "team-test", now: () => NOW });
  const client = new DispatchDocClient({ reactor, now: () => NOW });
  const service = new DispatchRecoveryService({
    reactor: reactor as unknown as DispatchRecoveryReactor,
    config: DEFAULT_RECOVERY_CONFIG,
    now: () => NOW,
    enabled: true,
    budget: 10,
    backoffMs: 60_000,
  });
  return { reactor, client, service };
}

async function seedFailed(
  client: DispatchDocClient,
  reactor: SqliteDispatchReactor,
  queryId: string,
  detail: string,
): Promise<string> {
  const enq = await client.enqueueDispatch({ ...base, query_id: queryId });
  if (!enq.ok) throw new Error("enqueue failed");
  const phid = enq.value.dispatch_phid;
  await client.claimForStart({ limit: 1 });
  await reactor.recordAgentStart(phid, `agent-${queryId}`);
  await reactor.markFailed(phid, { failure_kind: "agent_error", detail });
  return phid;
}

const PROMO_OK = {
  required: true,
  completed: true,
  repos: [
    {
      path: "/repo",
      base: "main",
      source_branch: "feat-x",
      strategy: "fast_forward",
      promoted_sha: "abc",
      remote_main_sha: "abc",
      pushed: true,
      verified: true,
    },
  ],
};

describe("dispatch recovery — live reconciliation", () => {
  it("HEADLINE: an expired-failed row WITH promotion evidence is reconciled to landed (done), NOT retried", async () => {
    const { reactor, client, service } = harness();
    const phid = await seedFailed(client, reactor, "q-landed", "linked query terminated expired");
    await reactor.recordPromotionResult(phid, { result: PROMO_OK });

    const report = await service.runOnce();

    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("done");
    expect(doc?.recovery_status).toBe("landed_reconciled");
    expect(report.landed).toBe(1);
    expect(report.retried).toBe(0);
    expect(doc?.recovery_attempts).toBe(0); // no retry happened
  });

  it("an expired-failed INTERNAL row with NO evidence is requeued with recovery metadata", async () => {
    const { reactor, client, service } = harness();
    const phid = await seedFailed(client, reactor, "q-retry", "linked query terminated expired");

    const report = await service.runOnce();

    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).not.toBe("failed"); // moved back toward execution (bounced)
    expect(doc?.recovery_status).toBe("recovering");
    expect(doc?.recovery_attempts).toBe(1);
    expect(report.retried).toBe(1);
  });

  it("an external side-effect failed row is NOT auto-resent — routed to operator", async () => {
    const { reactor, client, service } = harness();
    const phid = await seedFailed(client, reactor, "q-email", "linked query terminated expired");
    // No enqueue input for side_effect yet; set it directly (default is 'none').
    await adapter.query(
      `UPDATE dispatch_scheduler_queue SET side_effect = 'email' WHERE dispatch_phid = ?`,
      [phid],
    );

    const report = await service.runOnce();

    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("failed"); // not resent
    expect(doc?.recovery_status).toBe("unsafe_side_effect");
    expect(report.unsafe_side_effect).toBe(1);
  });

  it("a reconciled (done) row is not re-processed on a second pass (idempotent)", async () => {
    const { reactor, client, service } = harness();
    const phid = await seedFailed(client, reactor, "q-idem", "linked query terminated expired");
    await reactor.recordPromotionResult(phid, { result: PROMO_OK });

    await service.runOnce();
    const second = await service.runOnce();

    expect(second.scanned).toBe(0); // done rows fall out of listFailedForRecovery
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("done");
  });
});
