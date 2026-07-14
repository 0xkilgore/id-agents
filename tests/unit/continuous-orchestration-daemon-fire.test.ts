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
function fakePools(builders: string[] = ["roger"]): NonNullable<DaemonDeps["pools"]> {
  return {
    poolForItem: () => ({ pool_id: "backend", repo_root: "/repo", max_parallel: 3, members: ["roger", "regina"] }),
    availableBuilders: () => [...builders],
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

async function insertActiveDispatch(adapter: SqliteAdapter, dedupKey: string): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
       dispatch_phid, team_id, query_id, to_agent, from_actor, channel,
       subject, body_markdown, provider, runtime, priority, status,
       not_before_at, attempt_count, bounce_count, last_bounce_json,
       bounce_history_json, started_at, completed_at, updated_at,
       agent_query_id, usage_policy_snapshot_json, failure_kind,
       failure_detail, target_url, result_json, artifact_path,
       recovery_status, recovery_attempts, recovery_reason, side_effect,
       allow_auto_retry, dedup_key
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      `phid:disp-${dedupKey}`,
      "team-default",
      `q-${dedupKey}`,
      "roger",
      "continuous-orchestration",
      "dispatch",
      "T-ORCH backend build",
      "do the backend work",
      "openai",
      "codex",
      5,
      "queued",
      now,
      0,
      0,
      null,
      "[]",
      null,
      null,
      now,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "none",
      0,
      null,
      "none",
      0,
      dedupKey,
    ],
  );
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

  it("mode (b): enqueue resolves but setItemState crashes → next tick is held, not re-fired to an alternate pool builder", async () => {
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

    let enqueueCalls = 0;
    const enqueue = async (item: BacklogItem) => {
      enqueueCalls += 1;
      const dedup = item.logical_key ?? `orchestration-item:${item.item_id}`;
      const res = { dispatch_phid: `phid:disp-${dedup}`, query_id: `q-${dedup}` };
      await insertActiveDispatch(real, dedup);
      return res;
    };

    const deps: DaemonDeps = {
      adapter,
      config: config(),
      enqueue,
      readUsage: usage,
      readInFlight: noInFlight,
      pools: fakePools(["regina"]),
    };
    const daemon = new ContinuousOrchestrationDaemon(deps);

    // Tick 1: enqueue succeeds, setItemState crashes → item stays 'ready'.
    await daemon.runTick();
    expect(enqueueCalls).toBe(1);
    expect((await getBacklogItem(real, seeded.item_id))?.readiness_state).toBe("ready");

    // Tick 2: the ready row could route to another pool builder, but admission
    // sees the active scheduler dispatch for its dedup key and refuses to fire.
    const second = await daemon.runTick();
    expect(enqueueCalls).toBe(1);
    const finalItem = await getBacklogItem(real, seeded.item_id);
    expect(finalItem?.readiness_state).toBe("ready");
    expect(finalItem?.last_dispatch_phid).toBeNull();
    expect(second.decisions).toContainEqual(
      expect.objectContaining({
        item_id: seeded.item_id,
        action: "held",
        metadata: expect.objectContaining({
          code: "duplicate_dispatch_guard",
          dispatch_phid: "phid:disp-rd003-fire-key",
          dedup_key: "rd003-fire-key",
        }),
      }),
    );
  });
});
