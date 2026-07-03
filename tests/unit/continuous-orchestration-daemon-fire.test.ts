// RD-003 (Fable critique 2026-07-01): the CO daemon fire transition is non-atomic
// — bindItemForFire persists before enqueue, so a failure/crash strands or
// double-fires items. These tests reproduce both failure modes.

import { describe, expect, it } from "vitest";
import { ContinuousOrchestrationDaemon, type DaemonDeps } from "../../src/continuous-orchestration/daemon.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { insertBacklogItem, getBacklogItem, setMode } from "../../src/continuous-orchestration/storage.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem } from "../../src/continuous-orchestration/types.js";

function config() {
  return {
    ...defaultConfig(),
    dry_run: false,
    auto_flesh_enabled: false,
    auto_promote_enabled: false,
    max_enqueues_per_tick: 5,
    max_new_per_tick: 5,
    max_in_flight: 5,
  };
}

/** A pool routing seam that always routes to a one-builder backend pool and hands
 *  out a distinct worktree — enough to exercise the bind→enqueue→persist path. */
function fakePools(): NonNullable<DaemonDeps["pools"]> {
  return {
    poolForItem: () => ({ pool_id: "backend", repo_root: "/repo", max_parallel: 3, members: ["roger"] }),
    availableBuilders: () => ["roger"],
    allocateWorktree: async () => ({ path: "/repo/.worktrees/wt1", branch: "b1", lease_id: null }),
  };
}

const usage = async () => ({
  view: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" as const },
  daily_tokens_used: 0,
});
const noInFlight = async () => ({ count: 0, active_write_scopes: new Set<string>() });

async function seedReadyItem(adapter: SqliteAdapter): Promise<BacklogItem> {
  await setMode(adapter, "default", "running");
  return insertBacklogItem(adapter, {
    team_id: "default",
    logical_key: "rd003-fire-key",
    title: "T-ORCH backend build",
    track: "T-ORCH",
    to_agent: null, // ORIGINAL: unbound
    dispatch_body: "do the backend work",
    readiness_state: "ready",
    risk_class: "build",
    write_scope: ["/repo/orig"], // ORIGINAL write_scope
  });
}

describe("RD-003 — atomic CO fire", () => {
  it("mode (a): enqueue rejects after the worktree bind → item is REVERTED, not stranded", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    const seeded = await seedReadyItem(adapter);

    const deps: DaemonDeps = {
      adapter,
      config: config(),
      enqueue: async () => {
        throw new Error("scheduler enqueue exploded");
      },
      readUsage: usage,
      readInFlight: noInFlight,
      pools: fakePools(),
    };
    const daemon = new ContinuousOrchestrationDaemon(deps);
    await daemon.runTick();

    const after = await getBacklogItem(adapter, seeded.item_id);
    // The bind was reverted: original to_agent (null) + original write_scope, and
    // the item is still 'ready' (never transitioned, never left bound to wt1).
    expect(after?.readiness_state).toBe("ready");
    expect(after?.to_agent).toBeNull();
    expect(after?.write_scope).toEqual(["/repo/orig"]);
  });

  it("mode (b): enqueue resolves but setItemState crashes → next tick does NOT double-fire (single dispatch per dedup_key)", async () => {
    const real = new SqliteAdapter(":memory:");
    await migrateSqlite(real);
    const seeded = await seedReadyItem(real);

    // Fault-inject: throw ONCE on the in_flight setItemState UPDATE (the crash
    // between enqueue-success and persist). Every other query passes through.
    let armed = true;
    const adapter = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return async (sql: string, params?: unknown[]) => {
            if (armed && /readiness_state = \$1/.test(sql) && Array.isArray(params) && params[0] === "in_flight") {
              armed = false;
              throw new Error("simulated crash: in_flight persist failed");
            }
            return target.query(sql, params as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as SqliteAdapter;

    // Idempotent mock scheduler: one dispatch per dedup_key (mirrors the real
    // dedup_key convention). A re-fire of the same item returns the SAME dispatch.
    const byDedup = new Map<string, { dispatch_phid: string; query_id: string }>();
    let enqueueCalls = 0;
    const enqueue = async (item: BacklogItem) => {
      enqueueCalls += 1;
      const dedup = item.logical_key ?? `orchestration-item:${item.item_id}`;
      const existing = byDedup.get(dedup);
      if (existing) return existing;
      const res = { dispatch_phid: `phid:disp-${dedup}`, query_id: `q-${dedup}` };
      byDedup.set(dedup, res);
      return res;
    };

    const deps: DaemonDeps = {
      adapter,
      config: config(),
      enqueue,
      readUsage: usage,
      readInFlight: noInFlight,
      pools: fakePools(),
    };
    const daemon = new ContinuousOrchestrationDaemon(deps);

    // Tick 1: enqueue succeeds, setItemState crashes → item stays 'ready'.
    await daemon.runTick();
    expect(byDedup.size).toBe(1); // one dispatch created
    expect((await getBacklogItem(real, seeded.item_id))?.readiness_state).toBe("ready");

    // Tick 2: item re-admitted, re-fired with the SAME dedup_key → the idempotent
    // scheduler returns the SAME dispatch (no second), and the persist now succeeds.
    await daemon.runTick();
    expect(byDedup.size).toBe(1); // STILL one dispatch — no double-fire
    expect(enqueueCalls).toBeGreaterThanOrEqual(2); // fired twice, but deduped to one
    const finalItem = await getBacklogItem(real, seeded.item_id);
    expect(finalItem?.readiness_state).toBe("in_flight");
    expect(finalItem?.last_dispatch_phid).toBe(`phid:disp-rd003-fire-key`);
  });
});
