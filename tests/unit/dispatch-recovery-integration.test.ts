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

function harness(opts?: { commitEvidence?: ConstructorParameters<typeof DispatchRecoveryService>[0]["commitEvidence"] }) {
  const reactor = new SqliteDispatchReactor({ adapter, teamId: "team-test", now: () => NOW });
  const client = new DispatchDocClient({ reactor, now: () => NOW });
  const service = new DispatchRecoveryService({
    reactor: reactor as unknown as DispatchRecoveryReactor,
    config: DEFAULT_RECOVERY_CONFIG,
    now: () => NOW,
    enabled: true,
    budget: 10,
    backoffMs: 60_000,
    commitEvidence: opts?.commitEvidence,
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

  it("D3 HEADLINE: the Roger Task substrate 8945b9e false-expire is recovered as verified-done, NOT retried", async () => {
    // Reproduces the known incident: the Task substrate dispatch was marked
    // failed/expired by the stale sweep while its commit (8945b9e) was actually
    // promoted + verified on agent-platform-task-package-v0 main, but the
    // promotion's `completed` flag was not recorded on the row (lost closeout).
    // The git commit-evidence probe confirms the SHA is on main → reconcile.
    const repoPath = "/Users/kilgore/Dropbox/Code/agent-platform-task-package-v0";
    const probed: Array<{ repoPath: string; base: string; sha: string }> = [];
    const { reactor, client, service } = harness({
      commitEvidence: {
        async verifyCommitOnBase(args) {
          probed.push(args);
          return args.repoPath === repoPath && args.sha === "8945b9e"; // on main
        },
      },
    });
    const phid = await seedFailed(client, reactor, "q-8945b9e", "stale in_flight: no progress for 2700000ms");
    // Promotion metadata WAS recorded (sha/repo/base) but completed=false — the
    // exact partial state a lost closeout leaves behind.
    await reactor.recordPromotionResult(phid, {
      result: {
        required: true,
        completed: false,
        repos: [
          {
            path: repoPath,
            base: "main",
            source_branch: "feat/task-substrate-read-api",
            strategy: "fast_forward",
            promoted_sha: "8945b9e",
            remote_main_sha: "8945b9e",
            pushed: true,
            verified: true,
          },
        ],
      },
    });

    const report = await service.runOnce();

    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("done"); // recovered, not failed/expired
    expect(doc?.recovery_status).toBe("verified_done");
    expect(report.landed).toBe(1);
    expect(report.retried).toBe(0);
    expect(doc?.recovery_attempts).toBe(0); // never re-dispatched
    // The probe was actually consulted with the row's promotion metadata.
    expect(probed).toEqual([{ repoPath, base: "main", sha: "8945b9e" }]);
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

describe("dispatch recovery — T1.11 boot-time backfill", () => {
  // Push a row's completion older than the 7-day recovery lookback window.
  async function ageRow(phid: string, iso: string): Promise<void> {
    await adapter.query(
      `UPDATE dispatch_scheduler_queue SET completed_at = ?, updated_at = ? WHERE dispatch_phid = ?`,
      [iso, iso, phid],
    );
  }

  it("HEADLINE: a 35-row pre-restart casualty wave — backfill reclassifies the 4 commit-verified false-expires, leaves 31, idempotent", async () => {
    const OLD = "2026-05-10T12:00:00.000Z"; // > 7 days before NOW (root-cause condition)
    const landedShas = ["8945b9e", "a40b923", "5d833b1", "3f140ec"]; // the 4 false-expire commits, on main
    const { reactor, client, service } = harness({
      commitEvidence: {
        async verifyCommitOnBase({ sha }) {
          return landedShas.includes(sha);
        },
      },
    });

    // 4 false-expires: failed/expired rows whose promoted commit IS on main but
    // whose closeout was lost (completed=false). These must reclassify.
    const falsePhids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const phid = await seedFailed(client, reactor, `q-false-${i}`, "linked query terminated expired");
      await reactor.recordPromotionResult(phid, {
        result: {
          required: true,
          completed: false,
          repos: [
            {
              path: "/repo",
              base: "main",
              source_branch: "feat-x",
              strategy: "fast_forward",
              promoted_sha: landedShas[i],
              remote_main_sha: landedShas[i],
              pushed: true,
              verified: true,
            },
          ],
        },
      });
      await ageRow(phid, OLD);
      falsePhids.push(phid);
    }
    // 31 genuine casualties: agent_error / linked-query-terminated, NO promotion
    // metadata — these stay failed (backfill never retries).
    for (let i = 0; i < 31; i++) {
      const phid = await seedFailed(
        client,
        reactor,
        `q-stuck-${i}`,
        i % 2 === 0 ? "linked query terminated expired" : "agent runtime error",
      );
      await ageRow(phid, OLD);
    }

    // Root cause: the periodic, lookback-bounded scan misses ALL 35 (too old).
    expect(await reactor.listFailedForRecovery({ now: NOW })).toHaveLength(0);
    // The wide boot-backfill scan catches every targeted row regardless of age.
    expect(await reactor.listStuckForBackfill()).toHaveLength(35);

    const report = await service.runBackfill();
    expect(report.scanned).toBe(35);
    expect(report.reclassified).toBe(4);
    expect(report.left).toBe(31);

    for (const phid of falsePhids) {
      const doc = await reactor.getByPhid(phid);
      expect(doc?.status).toBe("done"); // reclassified OUT of failed
      expect(doc?.recovery_status).toBe("verified_done");
    }
    expect(service.getBackfillMetrics()).toEqual({
      recovery_backfill_runs_total: 1,
      recovery_backfill_rows_reclassified_total: 4,
    });

    // Idempotent: the 4 are now `done` and fall out; the 31 remain failed; the
    // second pass reclassifies nothing and the reclassified counter is stable.
    const second = await service.runBackfill();
    expect(second.scanned).toBe(31);
    expect(second.reclassified).toBe(0);
    expect(service.getBackfillMetrics()).toEqual({
      recovery_backfill_runs_total: 2,
      recovery_backfill_rows_reclassified_total: 4,
    });
  });
});
