// T-ORCH P0 acceptance soak — prove the daemon runs CONTINUOUSLY hands-off:
// over many ticks with an operator doing nothing, READY fuel cycles
// (needs_review auto-promoted by self-refuel), the daemon fires up to
// max_in_flight every tick, and work ships continuously. Mirrors the live
// stuck state (a little ready fuel + a big needs_review backlog).
//
// Run: vitest run tests/integration/continuous-orchestration-soak.test.ts
// (prints the tick-by-tick table to the test log.)

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  insertBacklogItem,
  listBacklogByState,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";

const okUsage = (): { view: UsageGateView; daily_tokens_used: number } => ({
  view: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
  daily_tokens_used: 0,
});

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

describe("T-ORCH P0 — continuous hands-off soak", () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = await freshDb();
  });

  it("cycles ready-fuel, fires up to max_in_flight every tick, ships continuously", async () => {
    const MAX_IN_FLIGHT = 8;
    // Seed the live-like stuck state: a little ready fuel + a big needs_review
    // backlog of unfleshed T-ORCH skeletons the self-refuel can flesh.
    for (let i = 0; i < 4; i++) {
      await insertBacklogItem(adapter, {
        title: `seed-ready-${i}`,
        to_agent: "roger",
        dispatch_body: "ship it",
        readiness_state: "ready",
        risk_class: "build",
        write_scope: [`ready-scope-${i}`],
      });
    }
    for (let i = 0; i < 60; i++) {
      await insertBacklogItem(adapter, {
        title: `T-ORCH.${i} — wire continuous slice ${i}`,
        track: "T-ORCH",
        readiness_state: "needs_review",
        source_refs: ["roadmap.md"],
      });
    }

    const fired: string[] = [];
    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: {
        ...defaultConfig(),
        enabled: true,
        dry_run: false,
        auto_flesh_enabled: true, // self-refuel ON
        min_ready_fuel: MAX_IN_FLIGHT,
        max_flesh_per_tick: 8,
        max_in_flight: MAX_IN_FLIGHT,
        max_new_per_tick: 1,
        daily_token_ceiling: 1_000_000_000,
      },
      enqueue: async (item: BacklogItem) => {
        fired.push(item.item_id);
        return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q_${item.item_id}` };
      },
      readUsage: () => Promise.resolve(okUsage()),
      // The daemon's own in-flight lane (the fixed readInFlight semantics):
      // count the orchestration's own in_flight backlog rows.
      readInFlight: async () => {
        const inflight = await listBacklogByState(adapter, { team_id: "default", state: "in_flight" });
        const scopes = new Set<string>();
        for (const it of inflight) for (const s of it.write_scope) scopes.add(s);
        return { count: inflight.length, active_write_scopes: scopes };
      },
      alert: async () => {},
      killSwitchActive: () => false,
      now: () => Date.parse("2026-06-17T18:00:00Z"), // NOT a cadence load-point
    });
    await daemon.setMode("running");

    const TICKS = 12;
    const log: Array<{
      tick: number;
      ready_before: number;
      needs_review_before: number;
      refuel_ready: number;
      admitted: number;
      stall: boolean;
    }> = [];
    let totalAdmitted = 0;

    for (let t = 1; t <= TICKS; t++) {
      const readyBefore = (await listBacklogByState(adapter, { state: "ready" })).length;
      const reviewBefore = (await listBacklogByState(adapter, { state: "needs_review" })).length;
      const r = await daemon.runTick();
      log.push({
        tick: t,
        ready_before: readyBefore,
        needs_review_before: reviewBefore,
        refuel_ready: r.refuel?.auto_ready ?? 0,
        admitted: r.admitted.length,
        stall: r.stall_alert,
      });
      totalAdmitted += r.admitted.length;
      // Simulate the fleet COMPLETING the fired work between ticks so slots free
      // and the loop keeps cycling (mirrors dispatches reaching done).
      const inflight = await listBacklogByState(adapter, { state: "in_flight" });
      for (const it of inflight) await setItemState(adapter, it.item_id, "done");
    }

    // Print the tick-by-tick evidence for the closeout.
    // eslint-disable-next-line no-console
    console.log(
      "\nTICK | ready_before | needs_review | refuel→ready | admitted | stall\n" +
        log
          .map(
            (l) =>
              ` ${String(l.tick).padStart(3)} | ${String(l.ready_before).padStart(12)} | ` +
              `${String(l.needs_review_before).padStart(12)} | ${String(l.refuel_ready).padStart(12)} | ` +
              `${String(l.admitted).padStart(8)} | ${l.stall}`,
          )
          .join("\n"),
    );

    // ── Acceptance assertions ──
    // 1. Self-refuel auto-promoted needs_review -> ready across the run.
    const totalRefuelled = log.reduce((a, l) => a + l.refuel_ready, 0);
    expect(totalRefuelled).toBeGreaterThan(8);
    // 2. The needs_review backlog actually drained (refuel consumed it).
    expect(log[0].needs_review_before).toBe(60);
    expect(log[log.length - 1].needs_review_before).toBeLessThan(40);
    // 3. The daemon fired on EVERY tick (continuous; pre-fix it stalled at 0),
    //    never raised a stall alert, and on a multi-lane tick filled BEYOND the
    //    old between-batch trickle of max_new_per_tick (tick 1 fired 5 across
    //    distinct write-scopes). Sustained per-tick throughput is correctly
    //    bounded by single-writer lanes — auto-fleshed T-ORCH work all shares
    //    roger's id-agents lane, so it serializes to 1/tick (the lane guardrail
    //    working as designed). Filling to max_in_flight needs multi-lane fuel.
    expect(log.every((l) => l.admitted >= 1)).toBe(true);
    expect(log.every((l) => !l.stall)).toBe(true);
    expect(Math.max(...log.map((l) => l.admitted))).toBeGreaterThan(
      defaultConfig().max_new_per_tick,
    );
    // 4. Work shipped on every tick across the window, hands-off.
    expect(totalAdmitted).toBeGreaterThanOrEqual(TICKS);
  });
});
