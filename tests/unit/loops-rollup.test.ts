// LoopRun rollups (last / next / health) — unit cover for src/loops/rollup.ts.
// The runs-derived read-model that replaces registry.placeholderHealth.

import { describe, it, expect, beforeEach } from "vitest";
import { rollupLoopHealth, loadLoopHealth, type LoopRollupInput } from "../../src/loops/rollup.js";
import type { ActorRef, LoopRunRecord, LoopRunStatus, LoopTrigger } from "../../src/loops/types.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  migrateLoopsTables,
  seedLoopsFromRegistry,
  createLoopRun,
  loopRunPhid,
} from "../../src/loops/storage.js";

const NOW = "2026-06-26T18:00:00.000Z";
const ACTOR: ActorRef = { kind: "agent", id: "roger" };
const MANUAL_TRIGGER: LoopTrigger = {
  kind: "manual",
  actor: ACTOR,
  surface: "cli",
  idempotency_key: "k",
  reason: null,
};

let seq = 0;

interface RunOverrides {
  status?: LoopRunStatus;
  fired_at?: string;
  finished_at?: string | null;
  trigger?: LoopTrigger;
  loop_run_phid?: string;
}

function makeRun(over: RunOverrides = {}): LoopRunRecord {
  seq += 1;
  const fired = over.fired_at ?? NOW;
  return {
    loop_run_phid: over.loop_run_phid ?? `phid:looprun:${seq}`,
    loop_phid: "phid:loop:project-load",
    trigger: over.trigger ?? MANUAL_TRIGGER,
    status: over.status ?? "succeeded",
    failure_reason: null,
    failure_detail: null,
    step_log: [],
    output_refs: [],
    spawned_dispatch_phids: [],
    idempotency_key: `idem-${seq}`,
    retry_of_phid: null,
    fired_at: fired,
    queued_at: fired,
    admitted_at: fired,
    started_at: fired,
    finished_at: over.finished_at !== undefined ? over.finished_at : fired,
    created_by: ACTOR,
    updated_at: fired,
  };
}

const ENABLED: LoopRollupInput = { enabled: true, stale_after_minutes: null };

/** minutes before NOW, as an ISO string. */
function ago(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

describe("rollupLoopHealth — state", () => {
  it("disabled loop is always `disabled`, regardless of runs", () => {
    const h = rollupLoopHealth({ enabled: false, stale_after_minutes: null }, [makeRun()], NOW);
    expect(h.state).toBe("disabled");
  });

  it("no runs (enabled) is `unknown` with honest zeros/nulls", () => {
    const h = rollupLoopHealth(ENABLED, [], NOW);
    expect(h).toEqual({
      state: "unknown",
      last_run_at: null,
      last_run_status: null,
      last_run_phid: null,
      last_success_at: null,
      consecutive_failures: 0,
      next_run_at: null,
      runs_last_7d: 0,
      stale_after_minutes: null,
    });
  });

  it("last terminal run succeeded and not stale → `healthy`", () => {
    const h = rollupLoopHealth(ENABLED, [makeRun({ status: "succeeded" })], NOW);
    expect(h.state).toBe("healthy");
    expect(h.last_run_status).toBe("succeeded");
    expect(h.last_success_at).toBe(NOW);
  });

  it("succeeded but older than stale_after_minutes → `degraded`", () => {
    const input: LoopRollupInput = { enabled: true, stale_after_minutes: 60 };
    const h = rollupLoopHealth(input, [makeRun({ status: "succeeded", fired_at: ago(120), finished_at: ago(120) })], NOW);
    expect(h.state).toBe("degraded");
  });

  it("stale_after_minutes=null never goes stale → `healthy`", () => {
    const h = rollupLoopHealth(ENABLED, [makeRun({ status: "succeeded", fired_at: ago(10_000), finished_at: ago(10_000) })], NOW);
    expect(h.state).toBe("healthy");
  });

  it("a single failure (below threshold) → `degraded`", () => {
    const h = rollupLoopHealth(ENABLED, [makeRun({ status: "failed" })], NOW);
    expect(h.state).toBe("degraded");
    expect(h.consecutive_failures).toBe(1);
  });

  it("consecutive failures ≥ threshold → `failed`", () => {
    const runs = [
      makeRun({ status: "failed", fired_at: ago(1) }),
      makeRun({ status: "failed", fired_at: ago(2) }),
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.state).toBe("failed");
    expect(h.consecutive_failures).toBe(2);
  });

  it("custom fail_threshold of 1 flips a single failure to `failed`", () => {
    const h = rollupLoopHealth({ enabled: true, stale_after_minutes: null, fail_threshold: 1 }, [makeRun({ status: "failed" })], NOW);
    expect(h.state).toBe("failed");
  });

  it("partial last run → `degraded` with coarse status `succeeded`", () => {
    const h = rollupLoopHealth(ENABLED, [makeRun({ status: "partial" })], NOW);
    expect(h.state).toBe("degraded");
    expect(h.last_run_status).toBe("succeeded");
  });

  it("cancelled-only history → `unknown`", () => {
    const h = rollupLoopHealth(ENABLED, [makeRun({ status: "cancelled" })], NOW);
    expect(h.state).toBe("unknown");
    expect(h.last_run_status).toBe("cancelled");
  });
});

describe("rollupLoopHealth — selection & counts", () => {
  it("consecutive_failures counts only the leading failed streak (stops at a success)", () => {
    const runs = [
      makeRun({ status: "failed", fired_at: ago(1) }),
      makeRun({ status: "failed", fired_at: ago(2) }),
      makeRun({ status: "succeeded", fired_at: ago(3), finished_at: ago(3) }),
      makeRun({ status: "failed", fired_at: ago(4) }),
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.consecutive_failures).toBe(2);
  });

  it("picks the newest run by fired_at even when input is unordered", () => {
    const runs = [
      makeRun({ status: "failed", fired_at: ago(100), loop_run_phid: "phid:looprun:old" }),
      makeRun({ status: "succeeded", fired_at: ago(1), finished_at: ago(1), loop_run_phid: "phid:looprun:new" }),
      makeRun({ status: "queued", fired_at: ago(50), loop_run_phid: "phid:looprun:mid" }),
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.last_run_phid).toBe("phid:looprun:new");
    expect(h.last_run_at).toBe(ago(1));
    expect(h.state).toBe("healthy");
  });

  it("last_success_at is the finished_at of the newest succeeded run, not partial", () => {
    const runs = [
      makeRun({ status: "partial", fired_at: ago(1), finished_at: ago(1) }),
      makeRun({ status: "succeeded", fired_at: ago(2), finished_at: ago(2) }),
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.last_success_at).toBe(ago(2));
  });

  it("in-flight last run reports coarse `running`; state derives from last terminal", () => {
    const runs = [
      makeRun({ status: "reasoning", fired_at: ago(1), finished_at: null }),
      makeRun({ status: "succeeded", fired_at: ago(2), finished_at: ago(2) }),
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.last_run_status).toBe("running");
    expect(h.state).toBe("healthy");
  });

  it("runs_last_7d excludes runs older than 7 days and future-fired runs", () => {
    const runs = [
      makeRun({ status: "succeeded", fired_at: ago(60) }),
      makeRun({ status: "succeeded", fired_at: ago(6 * 24 * 60) }),
      makeRun({ status: "succeeded", fired_at: ago(8 * 24 * 60) }), // too old
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.runs_last_7d).toBe(2);
  });
});

describe("rollupLoopHealth — next_run_at", () => {
  it("passes through an explicit next_run_at", () => {
    const when = "2026-06-27T07:00:00.000Z";
    const h = rollupLoopHealth({ ...ENABLED, next_run_at: when }, [makeRun()], NOW);
    expect(h.next_run_at).toBe(when);
  });

  it("explicit null forces no next run (overrides derivation)", () => {
    const future = "2026-06-27T07:00:00.000Z";
    const scheduled = makeRun({
      status: "queued",
      trigger: { kind: "scheduled", recurrence_phid: "r", recurrence_instance_phid: null, scheduled_for: future, dedup_key: "d" },
    });
    const h = rollupLoopHealth({ ...ENABLED, next_run_at: null }, [scheduled], NOW);
    expect(h.next_run_at).toBeNull();
  });

  it("derives next_run_at from the earliest pending scheduled run", () => {
    const soon = "2026-06-27T07:00:00.000Z";
    const later = "2026-06-28T07:00:00.000Z";
    const past = ago(60);
    const runs = [
      makeRun({ status: "queued", trigger: { kind: "scheduled", recurrence_phid: "r", recurrence_instance_phid: null, scheduled_for: later, dedup_key: "d1" } }),
      makeRun({ status: "queued", trigger: { kind: "scheduled", recurrence_phid: "r", recurrence_instance_phid: null, scheduled_for: soon, dedup_key: "d2" } }),
      // past scheduled — ignored
      makeRun({ status: "queued", trigger: { kind: "scheduled", recurrence_phid: "r", recurrence_instance_phid: null, scheduled_for: past, dedup_key: "d3" } }),
      // terminal scheduled in the future — ignored (already ran)
      makeRun({ status: "succeeded", finished_at: NOW, trigger: { kind: "scheduled", recurrence_phid: "r", recurrence_instance_phid: null, scheduled_for: "2026-06-26T23:00:00.000Z", dedup_key: "d4" } }),
    ];
    const h = rollupLoopHealth(ENABLED, runs, NOW);
    expect(h.next_run_at).toBe(soon);
  });

  it("no pending scheduled run → next_run_at null", () => {
    const h = rollupLoopHealth(ENABLED, [makeRun({ status: "succeeded" })], NOW);
    expect(h.next_run_at).toBeNull();
  });
});

describe("loadLoopHealth — substrate bridge", () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateLoopsTables(adapter);
    await seedLoopsFromRegistry(adapter, NOW);
  });

  it("rolls up runs read from the loop_runs substrate", async () => {
    const loopPhid = "phid:loop:project-load";
    const okKey = "ok-1";
    const failKey = "fail-1";
    await createLoopRun(adapter, {
      ...baseRun(loopPhid, okKey),
      status: "succeeded",
      fired_at: ago(120),
      finished_at: ago(120),
    });
    await createLoopRun(adapter, {
      ...baseRun(loopPhid, failKey),
      status: "failed",
      fired_at: ago(10),
      finished_at: ago(10),
    });

    const h = await loadLoopHealth(adapter, loopPhid, { enabled: true, stale_after_minutes: null }, NOW);
    expect(h.last_run_status).toBe("failed");
    expect(h.state).toBe("degraded"); // one failure, below default threshold of 2
    expect(h.consecutive_failures).toBe(1);
    expect(h.last_success_at).toBe(ago(120));
    expect(h.runs_last_7d).toBe(2);
  });

  it("empty substrate → unknown", async () => {
    const h = await loadLoopHealth(adapter, "phid:loop:project-load", { enabled: true, stale_after_minutes: null }, NOW);
    expect(h.state).toBe("unknown");
    expect(h.runs_last_7d).toBe(0);
  });
});

function baseRun(loopPhid: string, key: string): LoopRunRecord {
  return {
    loop_run_phid: loopRunPhid(loopPhid, key),
    loop_phid: loopPhid,
    trigger: { ...MANUAL_TRIGGER, idempotency_key: key },
    status: "succeeded",
    failure_reason: null,
    failure_detail: null,
    step_log: [],
    output_refs: [],
    spawned_dispatch_phids: [],
    idempotency_key: key,
    retry_of_phid: null,
    fired_at: NOW,
    queued_at: NOW,
    admitted_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    created_by: ACTOR,
    updated_at: NOW,
  };
}
