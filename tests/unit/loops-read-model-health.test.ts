// Loops read-model health overlay — unit cover for the runs-derived read-model
// the `/loops`, `/loops/summary`, `/loops/:ref` routes serve (src/loops/rollup.ts
// build* + overlay functions). Asserts the page reflects real LoopRun data and
// honest emptiness, never registry placeholders or fixtures.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateLoopsTables, createLoopRun } from "../../src/loops/storage.js";
import { SEED_LOOPS } from "../../src/loops/registry.js";
import {
  buildLoopsList,
  buildLoopsSummary,
  buildLoopSummaryWithHealth,
} from "../../src/loops/rollup.js";
import type { ActorRef, LoopRunRecord, LoopRunStatus, LoopTrigger } from "../../src/loops/types.js";

const NOW = "2026-06-30T18:00:00.000Z";
const ACTOR: ActorRef = { kind: "agent", id: "roger" };

const enabledLoops = SEED_LOOPS.filter((l) => l.enabled);
const LOOP_A = enabledLoops[0]!; // we seed runs for this one
const LOOP_B = enabledLoops[1]!; // left run-less → must stay honest `unknown`

function ago(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

let seq = 0;
function runFor(
  loopPhid: string,
  over: { status?: LoopRunStatus; fired_at?: string; finished_at?: string | null; trigger?: LoopTrigger } = {},
): LoopRunRecord {
  seq += 1;
  const key = `idem-${loopPhid}-${seq}`;
  const fired = over.fired_at ?? NOW;
  return {
    loop_run_phid: `phid:looprun:${seq}`,
    loop_phid: loopPhid,
    trigger: over.trigger ?? { kind: "manual", actor: ACTOR, surface: "cli", idempotency_key: key, reason: null },
    status: over.status ?? "succeeded",
    failure_reason: null,
    failure_detail: null,
    step_log: [],
    output_refs: [],
    spawned_dispatch_phids: [],
    idempotency_key: key,
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

describe("loops read-model — runs-derived health overlay", () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateLoopsTables(adapter);
    expect(LOOP_A && LOOP_B).toBeTruthy(); // need ≥2 enabled seed loops
  });

  it("buildLoopsList overlays real health from LoopRun (not the placeholder)", async () => {
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "succeeded" }));

    const body = await buildLoopsList(adapter, NOW);
    expect(body.source).toBe("mixed"); // definitions seed + health substrate

    const a = body.loops.find((l) => l.loop_phid === LOOP_A.loop_phid)!;
    expect(a.health.state).toBe("healthy");
    expect(a.health.last_run_at).toBe(NOW);
    expect(a.health.last_run_status).toBe("succeeded");
    expect(a.health.last_run_phid).not.toBeNull();
    expect(a.health.runs_last_7d).toBe(1);

    // A different enabled loop with no runs must stay honestly `unknown`.
    const b = body.loops.find((l) => l.loop_phid === LOOP_B.loop_phid)!;
    expect(b.health.state).toBe("unknown");
    expect(b.health.last_run_at).toBeNull();
    expect(b.health.runs_last_7d).toBe(0);
  });

  it("honest emptiness: with zero runs every enabled loop is `unknown` (no fixtures)", async () => {
    const body = await buildLoopsList(adapter, NOW);
    for (const l of body.loops) {
      expect(l.health.state).toBe(l.enabled ? "unknown" : "disabled");
      expect(l.health.last_run_at).toBeNull();
      expect(l.health.last_run_phid).toBeNull();
      expect(l.health.runs_last_7d).toBe(0);
    }
  });

  it("a failure streak rolls the loop to a real `failed` health state", async () => {
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "failed", fired_at: ago(20), finished_at: ago(20) }));
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "failed", fired_at: ago(10), finished_at: ago(10) }));

    const a = (await buildLoopsList(adapter, NOW)).loops.find((l) => l.loop_phid === LOOP_A.loop_phid)!;
    expect(a.health.state).toBe("failed");
    expect(a.health.consecutive_failures).toBe(2);
  });

  it("the status filter runs against REAL health, not the placeholder", async () => {
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "succeeded" }));

    const healthy = await buildLoopsList(adapter, NOW, { status: "healthy" });
    expect(healthy.loops.some((l) => l.loop_phid === LOOP_A.loop_phid)).toBe(true);
    // LOOP_A is no longer `unknown`, so the placeholder-era filter would now miss it.
    const unknown = await buildLoopsList(adapter, NOW, { status: "unknown" });
    expect(unknown.loops.some((l) => l.loop_phid === LOOP_A.loop_phid)).toBe(false);
  });

  it("derives next_run_at from a pending scheduled run and syncs the summary field", async () => {
    const future = "2026-07-01T07:00:00.000Z";
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, {
      status: "queued",
      trigger: { kind: "scheduled", recurrence_phid: "r", recurrence_instance_phid: null, scheduled_for: future, dedup_key: "d1" },
    }));

    const a = (await buildLoopsList(adapter, NOW)).loops.find((l) => l.loop_phid === LOOP_A.loop_phid)!;
    expect(a.health.next_run_at).toBe(future);
    expect(a.next_run_at).toBe(future); // top-level summary field kept in sync
  });

  it("buildLoopsSummary reflects real health counts and `mixed` source", async () => {
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "succeeded" }));

    const summary = await buildLoopsSummary(adapter, NOW);
    expect(summary.source).toBe("mixed");
    expect(summary.healthy_count).toBeGreaterThanOrEqual(1);
  });

  it("buildLoopSummaryWithHealth overlays a single loop's real health", async () => {
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "succeeded" }));

    const overlaid = await buildLoopSummaryWithHealth(adapter, LOOP_A, NOW);
    expect(overlaid.health.state).toBe("healthy");
    expect(overlaid.health.last_run_phid).not.toBeNull();
  });

  it("threads team_id end-to-end without error (documented no-op until loop_runs.team_id exists)", async () => {
    await createLoopRun(adapter, runFor(LOOP_A.loop_phid, { status: "succeeded" }));

    const scoped = await buildLoopsList(adapter, NOW, {}, { team_id: "team_anything" });
    const a = scoped.loops.find((l) => l.loop_phid === LOOP_A.loop_phid)!;
    // No team_id column yet, so scope does not change the (global) result.
    expect(a.health.state).toBe("healthy");
  });
});
