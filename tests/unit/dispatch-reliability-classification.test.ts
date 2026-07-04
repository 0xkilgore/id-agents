// T-RELIABILITY (2026-07-04) — classify the ~1100+ failed-dispatch count
// (2026-06-30 overnight routing audit, +149 spike from one dead-lane wave)
// into real_failure / replay_duplicate / superseded so the count stops
// conflating scheduler-replay noise with genuine task failures.
//
// Covers: the pure classifier's supersede/moot/dedup-clustering rules, and
// the durable sweep that persists reliability_classification /
// reliability_classification_reason on dispatch_scheduler_queue.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SchedulerHandle } from "../../src/dispatch-scheduler/manager-integration.js";
import {
  classifyDispatchReliability,
  summarizeReliabilityBreakdown,
  sweepReliabilityClassification,
  type EffectiveStateRow,
  type ReliabilityDedupSibling,
} from "../../src/dispatch-scheduler/read-model.js";

const TEAM = "team";

function failedRow(over: Partial<EffectiveStateRow>): EffectiveStateRow {
  return {
    status: "failed",
    recovery_status: "none",
    recovery_reason: null,
    failure_kind: "agent_error",
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    not_before_at: null,
    started_at: null,
    completed_at: null,
    updated_at: "2026-06-30T03:00:00Z",
    provider: "anthropic",
    supersede_link: null,
    ...over,
  };
}

describe("classifyDispatchReliability (pure)", () => {
  it("returns null for a non-failed row", () => {
    expect(classifyDispatchReliability(failedRow({ status: "done" }))).toBeNull();
  });

  it("tags a supersede_link row as superseded", () => {
    const row = failedRow({ supersede_link: "phid:disp-replacement" });
    const result = classifyDispatchReliability(row);
    expect(result?.classification).toBe("superseded");
    expect(result?.reason).toContain("phid:disp-replacement");
  });

  it("tags recovery evidence of landed work as superseded", () => {
    const row = failedRow({ recovery_status: "verified_done" });
    expect(classifyDispatchReliability(row)?.classification).toBe("superseded");
  });

  it("tags a moot row with an explicit retry/reassign reason as superseded", () => {
    const row = failedRow({ recovery_status: "moot", recovery_reason: "retry → phid:disp-e0efcc20c3554d7f" });
    expect(classifyDispatchReliability(row)?.classification).toBe("superseded");
  });

  it("tags a moot row whose reason says 'superseded' as superseded", () => {
    const row = failedRow({
      recovery_status: "moot",
      recovery_reason: "Superseded — landed on main in fe3b380.",
    });
    expect(classifyDispatchReliability(row)?.classification).toBe("superseded");
  });

  it("tags a moot constrained-provider-dead row (scheduler/infra noise) as replay_duplicate", () => {
    const row = failedRow({
      recovery_status: "moot",
      recovery_reason: "constrained_provider_dead (T-RECON.2 sweep)",
    });
    expect(classifyDispatchReliability(row)?.classification).toBe("replay_duplicate");
  });

  it("tags a moot scheduler-wedge row as replay_duplicate", () => {
    const row = failedRow({
      recovery_status: "moot",
      recovery_reason: "moot reconcile: scheduler wedge (in-flight infra death), not a task failure",
    });
    expect(classifyDispatchReliability(row)?.classification).toBe("replay_duplicate");
  });

  it("tags a plain needs-operator failure with no dedup siblings as real_failure", () => {
    const row = failedRow({});
    expect(classifyDispatchReliability(row)?.classification).toBe("real_failure");
  });

  it("dedup clustering: a later sibling that completed marks this failure superseded", () => {
    const row = failedRow({ updated_at: "2026-06-30T03:00:00Z" });
    const siblings: ReliabilityDedupSibling[] = [
      { dispatch_phid: "phid:disp-later", status: "done", updated_at: "2026-06-30T03:10:00Z" },
    ];
    const result = classifyDispatchReliability(row, {}, siblings);
    expect(result?.classification).toBe("superseded");
  });

  it("dedup clustering: a later sibling that also failed marks this failure replay_duplicate", () => {
    const row = failedRow({ updated_at: "2026-06-30T03:00:00Z" });
    const siblings: ReliabilityDedupSibling[] = [
      { dispatch_phid: "phid:disp-later", status: "failed", updated_at: "2026-06-30T03:10:00Z" },
    ];
    const result = classifyDispatchReliability(row, {}, siblings);
    expect(result?.classification).toBe("replay_duplicate");
  });

  it("dedup clustering: an EARLIER sibling does not affect classification (only later ones count)", () => {
    const row = failedRow({ updated_at: "2026-06-30T03:00:00Z" });
    const siblings: ReliabilityDedupSibling[] = [
      { dispatch_phid: "phid:disp-earlier", status: "done", updated_at: "2026-06-30T02:00:00Z" },
    ];
    const result = classifyDispatchReliability(row, {}, siblings);
    expect(result?.classification).toBe("real_failure");
  });

  it("the final failure in a dedup cluster (no later siblings) stays real_failure", () => {
    const row = failedRow({ updated_at: "2026-06-30T03:10:00Z" });
    const siblings: ReliabilityDedupSibling[] = [
      { dispatch_phid: "phid:disp-earlier", status: "failed", updated_at: "2026-06-30T03:00:00Z" },
    ];
    const result = classifyDispatchReliability(row, {}, siblings);
    expect(result?.classification).toBe("real_failure");
  });

  it("constrained-provider dead-ghost failures classify as replay_duplicate even without a moot recovery_status yet", () => {
    const row = failedRow({ provider: "openai", recovery_status: "none" });
    const result = classifyDispatchReliability(row, { constrainedProviders: ["openai"] });
    expect(result?.classification).toBe("replay_duplicate");
  });
});

describe("summarizeReliabilityBreakdown (pure)", () => {
  it("tallies rows by reliability_classification, defaulting missing to unclassified", () => {
    const rows = [
      { reliability_classification: "real_failure" },
      { reliability_classification: "real_failure" },
      { reliability_classification: "replay_duplicate" },
      { reliability_classification: "superseded" },
      { reliability_classification: null },
      {},
    ] as any;
    expect(summarizeReliabilityBreakdown(rows)).toEqual({
      real_failure: 2,
      replay_duplicate: 1,
      superseded: 1,
      unclassified: 2,
    });
  });
});

describe("sweepReliabilityClassification (DB)", () => {
  let tmpDir: string;
  let adapter: SqliteAdapter;
  let handle: SchedulerHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reliability-sweep-"));
    adapter = new SqliteAdapter(join(tmpDir, "t.db"));
    await migrateSqlite(adapter);
    await adapter.query(`INSERT INTO teams (id, name) VALUES (?, ?)`, [TEAM, TEAM]);
    handle = new SchedulerHandle({ adapter, teamId: TEAM, resolveTargetUrl: () => null });
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function makeFailed(opts: {
    detail?: string;
    dedup_key?: string;
    updated_at?: string;
  } = {}): Promise<string> {
    const { query_id } = await handle.enqueue({
      to_agent: "cane",
      from_actor: "test",
      message: "m",
      dedup_key: opts.dedup_key,
    } as any);
    const doc = await handle.reactor.getByQueryId(query_id);
    await handle.reactor.markFailed(doc!.dispatch_phid, {
      failure_kind: "agent_error",
      detail: opts.detail ?? "genuine agent crash",
    } as any);
    if (opts.updated_at) {
      await adapter.query(`UPDATE dispatch_scheduler_queue SET updated_at = ? WHERE dispatch_phid = ?`, [
        opts.updated_at,
        doc!.dispatch_phid,
      ]);
    }
    return doc!.dispatch_phid;
  }

  it("classifies an isolated genuine failure as real_failure", async () => {
    const phid = await makeFailed({ detail: "genuine agent crash, no provider limit" });
    const result = await sweepReliabilityClassification(adapter, TEAM);
    expect(result.classified).toBe(1);
    expect(result.breakdown.real_failure).toBe(1);

    const { rows } = await adapter.query<{ reliability_classification: string }>(
      `SELECT reliability_classification FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [phid],
    );
    expect(rows[0].reliability_classification).toBe("real_failure");
  });

  it("classifies a dedup-key cluster: earlier failed attempts are replay_duplicate, the final one is real_failure", async () => {
    const key = "dedup:same-logical-work";
    await makeFailed({ dedup_key: key, updated_at: "2026-06-30T03:00:00.000Z" });
    await makeFailed({ dedup_key: key, updated_at: "2026-06-30T03:05:00.000Z" });
    const last = await makeFailed({ dedup_key: key, updated_at: "2026-06-30T03:10:00.000Z" });

    const result = await sweepReliabilityClassification(adapter, TEAM);
    expect(result.scanned).toBe(3);
    expect(result.breakdown.replay_duplicate).toBe(2);
    expect(result.breakdown.real_failure).toBe(1);

    const { rows } = await adapter.query<{ reliability_classification: string }>(
      `SELECT reliability_classification FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [last],
    );
    expect(rows[0].reliability_classification).toBe("real_failure");
  });

  it("classifies a dedup-key cluster where the logical work eventually completed as superseded", async () => {
    const key = "dedup:eventually-done";
    await makeFailed({ dedup_key: key, updated_at: "2026-06-30T03:00:00.000Z" });
    const { query_id } = await handle.enqueue({
      to_agent: "cane",
      from_actor: "test",
      message: "m",
      dedup_key: key,
    } as any);
    const doneDoc = await handle.reactor.getByQueryId(query_id);
    await adapter.query(
      `UPDATE dispatch_scheduler_queue SET status = 'done', updated_at = ? WHERE dispatch_phid = ?`,
      ["2026-06-30T03:10:00.000Z", doneDoc!.dispatch_phid],
    );

    const result = await sweepReliabilityClassification(adapter, TEAM);
    expect(result.breakdown.superseded).toBe(1);
  });

  it("is idempotent: re-running after a full sweep classifies nothing new", async () => {
    await makeFailed({});
    const first = await sweepReliabilityClassification(adapter, TEAM);
    expect(first.classified).toBe(1);
    const second = await sweepReliabilityClassification(adapter, TEAM);
    expect(second.scanned).toBe(0);
    expect(second.classified).toBe(0);
  });

  it("only classifies unclassified rows, leaving a manually-set classification untouched", async () => {
    const phid = await makeFailed({});
    await adapter.query(
      `UPDATE dispatch_scheduler_queue SET reliability_classification = 'superseded', reliability_classification_reason = 'manual override' WHERE dispatch_phid = ?`,
      [phid],
    );
    const result = await sweepReliabilityClassification(adapter, TEAM);
    expect(result.scanned).toBe(0);
    const { rows } = await adapter.query<{ reliability_classification: string }>(
      `SELECT reliability_classification FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [phid],
    );
    expect(rows[0].reliability_classification).toBe("superseded");
  });
});
