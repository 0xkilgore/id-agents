// RD-003 (Fable critique 2026-07-01): the CO daemon fire transition is non-atomic
// — bindItemForFire persists before enqueue, so a failure/crash strands or
// double-fires items. These tests reproduce both failure modes.

import { describe, expect, it } from "vitest";
import { ContinuousOrchestrationDaemon, type DaemonDeps } from "../../src/continuous-orchestration/daemon.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { insertBacklogItem, getBacklogItem, setItemState, setMode } from "../../src/continuous-orchestration/storage.js";
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

async function seedNeedsReviewItem(adapter: SqliteAdapter, overrides: Partial<BacklogItem>): Promise<BacklogItem> {
  const seeded = await insertBacklogItem(adapter, {
    team_id: "default",
    title: overrides.title ?? "T-ORCH backend review candidate",
    track: "T-ORCH",
    to_agent: "roger",
    dispatch_body: "[project: kapelle][T-ORCH][BUILD] roger: do the backend work; verify; promote per Spec 054",
    readiness_state: "needs_review",
    risk_class: "build",
    write_scope: overrides.write_scope ?? ["repo/unit"],
    token_estimate: 1000,
    provider: "openai",
    runtime: "codex",
  });
  await adapter.query(
    `UPDATE orchestration_backlog_item
       SET approved_by = $1,
           approved_at = $2,
           flesh_status = $3,
           flesh_confidence = $4,
           last_dispatch_phid = $5
     WHERE item_id = $6`,
    [
      overrides.approved_by !== undefined ? overrides.approved_by : "maestra",
      overrides.approved_at !== undefined ? overrides.approved_at : "2026-07-11T00:00:00Z",
      overrides.flesh_status ?? "fleshed",
      overrides.flesh_confidence ?? 0.95,
      overrides.last_dispatch_phid ?? null,
      seeded.item_id,
    ],
  );
  return (await getBacklogItem(adapter, seeded.item_id))!;
}

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

async function seedReadyBuildFuel(adapter: SqliteAdapter, index: number): Promise<BacklogItem> {
  await setMode(adapter, "default", "running");
  return insertBacklogItem(adapter, {
    team_id: "default",
    logical_key: `ready-fuel-${index}`,
    title: `ready fuel ${index}`,
    track: "T-ORCH",
    to_agent: "roger",
    dispatch_body: `[project: kapelle][T-ORCH][BUILD] roger: ready fuel ${index}`,
    readiness_state: "ready",
    risk_class: "build",
    write_scope: [`repo/ready-${index}`],
    token_estimate: 1000,
    provider: "openai",
    runtime: "codex",
  });
}

async function seedDispatchStatus(adapter: SqliteAdapter, phid: string, status: string): Promise<void> {
  const now = "2026-07-13T12:00:00.000Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      phid,
      "team-uuid-test",
      `q_${phid}`,
      "roger",
      "co",
      "manager",
      "subject",
      "body",
      "openai",
      "codex",
      status,
      now,
      now,
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

  it("reconciles terminal stale ready rows before admission without weakening retry-safe failed rows", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    await seedDispatchStatus(adapter, "phid:disp-already-done", "done");
    const staleDone = await insertBacklogItem(adapter, {
      team_id: "default",
      title: "already completed duplicate",
      to_agent: "roger",
      dispatch_body: "duplicate",
      readiness_state: "ready",
      risk_class: "build",
      write_scope: ["repo/stale-done"],
    });
    await setItemState(adapter, staleDone.item_id, "ready", { dispatch_phid: "phid:disp-already-done" });

    await seedDispatchStatus(adapter, "phid:disp-retryable-failed", "failed");
    await adapter.query(
      `UPDATE dispatch_scheduler_queue
          SET failure_kind = $1,
              failure_detail = $2
        WHERE dispatch_phid = $3`,
      ["scheduler_wedged", "transient scheduler wedge", "phid:disp-retryable-failed"],
    );
    const retryableFailed = await insertBacklogItem(adapter, {
      team_id: "default",
      title: "retryable failed duplicate",
      to_agent: "roger",
      dispatch_body: "retry only after operator approval",
      readiness_state: "ready",
      risk_class: "build",
      write_scope: ["repo/retryable-failed"],
    });
    await setItemState(adapter, retryableFailed.item_id, "ready", { dispatch_phid: "phid:disp-retryable-failed" });

    const fresh = await insertBacklogItem(adapter, {
      team_id: "default",
      logical_key: "fresh-after-stale-reconcile",
      title: "fresh admissible work",
      to_agent: "roger",
      dispatch_body: "do fresh work",
      readiness_state: "ready",
      risk_class: "build",
      write_scope: ["repo/fresh"],
    });

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
    });

    const result = await daemon.runTick();

    expect(result.stale_ready_reconciled).toMatchObject({
      closed: 1,
      superseded: 0,
      preserved_retry_safe: 0,
      dry_run: false,
      items: [
        {
          item_id: staleDone.item_id,
          dispatch_phid: "phid:disp-already-done",
          to_state: "done",
        },
      ],
    });
    expect(result.admitted.map((item) => item.item_id)).toEqual([fresh.item_id]);
    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: staleDone.item_id,
          action: "stale_ready_reconcile",
          dispatch_phid: "phid:disp-already-done",
        }),
        expect.objectContaining({
          item_id: retryableFailed.item_id,
          action: "held",
          metadata: expect.objectContaining({ code: "duplicate_dispatch_retry_required" }),
        }),
      ]),
    );
    expect((await getBacklogItem(adapter, staleDone.item_id))?.readiness_state).toBe("done");
    expect((await getBacklogItem(adapter, retryableFailed.item_id))?.readiness_state).toBe("ready");
    expect((await getBacklogItem(adapter, fresh.item_id))?.readiness_state).toBe("in_flight");
  });

  it("scans past duplicate retry blockers and admits fresh ready rows up to the tick cap", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    const duplicateRows: BacklogItem[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const phid = `phid:disp-duplicate-retry-${i}`;
      await seedDispatchStatus(adapter, phid, "failed");
      await adapter.query(
        `UPDATE dispatch_scheduler_queue
            SET failure_kind = $1,
                failure_detail = $2
          WHERE dispatch_phid = $3`,
        ["scheduler_wedged", "transient scheduler wedge", phid],
      );
      const row = await insertBacklogItem(adapter, {
        team_id: "default",
        title: `blocked duplicate retry ${i}`,
        to_agent: "roger",
        dispatch_body: `retry row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        priority: 1,
        write_scope: [`repo/duplicate-retry-${i}`],
      });
      await setItemState(adapter, row.item_id, "ready", { dispatch_phid: phid });
      duplicateRows.push((await getBacklogItem(adapter, row.item_id))!);
    }

    const freshRows: BacklogItem[] = [];
    for (let i = 1; i <= 3; i += 1) {
      freshRows.push(await insertBacklogItem(adapter, {
        team_id: "default",
        title: `fresh admissible ready ${i}`,
        to_agent: "roger",
        dispatch_body: `fresh row ${i}`,
        readiness_state: "ready",
        risk_class: "build",
        priority: 2,
        write_scope: [`repo/fresh-admissible-${i}`],
      }));
    }

    const enqueued: string[] = [];
    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: {
        ...config(),
        max_enqueues_per_tick: 2,
        max_new_per_tick: 2,
        max_in_flight: 5,
        stall_threshold_ticks: 3,
      },
      enqueue: async (item) => {
        enqueued.push(item.item_id);
        return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` };
      },
      readUsage: usage,
      readInFlight: noInFlight,
    });

    const before = await daemon.explainReadyAdmission();
    const result = await daemon.runTick();

    expect(before).toMatchObject({
      candidates: 6,
      useful_ready: 3,
      admissible_now: 2,
      block_reason_counts: {
        duplicate_dispatch_retry_required: 3,
        tick_admission_cap: 1,
      },
    });
    const admittedItemIds = result.admitted.map((item) => item.item_id);
    const freshItemIds = new Set(freshRows.map((item) => item.item_id));
    expect(admittedItemIds).toHaveLength(2);
    expect(admittedItemIds.every((itemId) => freshItemIds.has(itemId))).toBe(true);
    expect(enqueued).toEqual(admittedItemIds);
    expect(result.zero_ticks).toBe(0);
    expect(result.decisions).toEqual(
      expect.arrayContaining(
        duplicateRows.map((item, index) =>
          expect.objectContaining({
            item_id: item.item_id,
            action: "held",
            metadata: expect.objectContaining({
              code: "duplicate_dispatch_retry_required",
              last_dispatch_phid: `phid:disp-duplicate-retry-${index + 1}`,
            }),
          }),
        ),
      ),
    );
    expect((await getBacklogItem(adapter, duplicateRows[0].item_id))?.readiness_state).toBe("ready");
    const freshStates = await Promise.all(freshRows.map((item) => getBacklogItem(adapter, item.item_id)));
    expect(freshStates.filter((item) => item?.readiness_state === "in_flight")).toHaveLength(2);
    expect(freshStates.filter((item) => item?.readiness_state === "ready")).toHaveLength(1);
  });
});

describe("ready admission target-unhealthy receipts", () => {
  it("surfaces operator-readable receipts for offline explicit targets without admitting them", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    const substrateApi = await insertBacklogItem(adapter, {
      team_id: "default",
      logical_key: "live-queue-substrate-api-offline",
      title: "[project: kapelle][T-RELY][BUILD] substrate-api-codex offline fixture",
      track: "T-RELY",
      to_agent: "substrate-api-codex",
      dispatch_body: "Live queue fixture: backend row held because substrate-api-codex is offline.",
      readiness_state: "ready",
      risk_class: "build",
      write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents/src/continuous-orchestration"],
    });
    const brunel = await insertBacklogItem(adapter, {
      team_id: "default",
      logical_key: "live-queue-brunel-offline",
      title: "[project: kapelle][T-UI][BUILD] brunel offline fixture",
      track: "T-UI",
      to_agent: "brunel",
      dispatch_body: "Live queue fixture: frontend row held because brunel is offline.",
      readiness_state: "ready",
      risk_class: "build",
      write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site/app/ops"],
    });
    const coderMax = await insertBacklogItem(adapter, {
      team_id: "default",
      logical_key: "live-queue-coder-max-offline",
      title: "[project: kapelle][T-RELY][BUILD] coder-max offline fixture",
      track: "T-RELY",
      to_agent: "coder-max",
      dispatch_body: "Live queue fixture: backend row held because coder-max is offline.",
      readiness_state: "ready",
      risk_class: "build",
      write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents/src/dispatch-scheduler"],
    });

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
      resolveAgentHealth: async () => new Set(["roger"]),
    });

    const status = await daemon.explainReadyAdmission();

    expect(status.admissible).toEqual([]);
    expect(status.useful_ready).toBe(0);
    expect(status.blocker_counts).toEqual([
      { code: "target_unhealthy", category: "runtime_unavailable", count: 3 },
    ]);
    expect(status.non_admitted.map((row) => row.item_id).sort()).toEqual(
      [substrateApi.item_id, brunel.item_id, coderMax.item_id].sort(),
    );
    for (const row of status.non_admitted) {
      expect(row.action).toBe("held");
      expect(row.code).toBe("target_unhealthy");
      expect(row.metadata).toMatchObject({
        code: "target_unhealthy",
        class: "agent_availability",
        target: row.to_agent,
        target_unhealthy_receipt: {
          code: "target_unhealthy",
          target: row.to_agent,
          prior_owner: row.to_agent,
          safe_action: "reroute_or_supersede",
          counts_as_useful_build_fuel: false,
        },
      });
      expect(row.target_unhealthy_receipt).toEqual(row.metadata?.target_unhealthy_receipt);
      expect(row.target_unhealthy_receipt?.safe_action_summary).toContain("Do not refire silently");
    }
  });
});

describe("empty auto-promote pipe alert", () => {
  it("excludes stale terminal already-dispatched rows from low-fuel health while preserving failed retry blockers", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    for (let i = 1; i <= 6; i += 1) {
      await seedReadyBuildFuel(adapter, i);
    }

    for (let i = 1; i <= 5; i += 1) {
      await seedDispatchStatus(adapter, `phid:disp-done-${i}`, "done");
      await seedNeedsReviewItem(adapter, {
        title: `stale terminal already dispatched ${i}`,
        last_dispatch_phid: `phid:disp-done-${i}`,
        write_scope: [`repo/stale-done-${i}`],
      });
    }

    const failedRows: BacklogItem[] = [];
    for (let i = 1; i <= 3; i += 1) {
      await seedDispatchStatus(adapter, `phid:disp-failed-${i}`, "failed");
      failedRows.push(await seedNeedsReviewItem(adapter, {
        title: `retryable failed already dispatched ${i}`,
        last_dispatch_phid: `phid:disp-failed-${i}`,
        write_scope: [`repo/failed-${i}`],
      }));
    }

    const lowConfidence = await seedNeedsReviewItem(adapter, {
      title: "low confidence non-dispatched candidate",
      approved_by: null,
      approved_at: null,
      flesh_confidence: 0.55,
      write_scope: ["repo/low-confidence-contract"],
    });

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: {
        ...config(),
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 12,
        auto_promote_min_lanes: 1,
        max_flesh_per_tick: 0,
      },
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
    });

    const status = await daemon.explainAutoPromoteHealth();

    expect(status.lanes.build_ready).toBe(6);
    expect(status.floor).toBe(12);
    expect(status.below_floor).toBe(true);
    expect(status.triggered).toBe(true);
    expect(status.promoted_count).toBe(0);
    expect(status.candidates_considered).toBe(4);
    expect(status.candidates.map((item) => item.item_id).sort()).toEqual(
      [...failedRows.map((item) => item.item_id), lowConfidence.item_id].sort(),
    );
    expect(status.candidates.map((item) => item.title)).not.toContain("stale terminal already dispatched 1");
    expect(status.skipped_count).toBe(4);
    expect(status.blocker_class_counts).toEqual([
      { class: "already_dispatched", count: 3, label: "already-dispatched rows" },
      { class: "confidence_threshold", count: 1, label: "confidence threshold" },
    ]);
    expect(status.next_action).toEqual({
      code: "manual_promote_safe_retries",
      summary: "mark retry_safe=true only for an intentional bounded refire of retryable failed rows",
    });
  });

  it("fires on one tick when every needs_review candidate is confidence-threshold or already-dispatched blocked", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    const lowConfidence = await seedNeedsReviewItem(adapter, {
      title: "low confidence needs human decision",
      approved_by: null,
      approved_at: null,
      flesh_confidence: 0.55,
      write_scope: ["repo/low-confidence"],
    });
    const alreadyDispatched = await seedNeedsReviewItem(adapter, {
      title: "already dispatched needs reconciliation",
      last_dispatch_phid: "phid:disp-old",
      write_scope: ["repo/already-dispatched"],
    });

    const newsEvents: Array<{ type: string; message: string; data?: Record<string, unknown> }> = [];
    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: {
        ...config(),
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 8,
        auto_promote_min_lanes: 1,
        max_flesh_per_tick: 0,
      },
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
      emitNews: async (event) => {
        newsEvents.push(event);
      },
    });

    const tick = await daemon.runTick();

    expect(tick.zero_ticks).toBe(0);
    expect(tick.auto_promote).toMatchObject({
      triggered: true,
      promoted: 0,
      skipped: 2,
      candidates_considered: 2,
    });
    expect(newsEvents).toEqual([
      expect.objectContaining({
        type: "fleet.blockage",
        data: expect.objectContaining({
          kind: "empty_auto_promote_pipe",
          ready: 0,
          admissible_now: 0,
          items: expect.arrayContaining([
            expect.objectContaining({
              item_id: lowConfidence.item_id,
              blocker_classes: ["confidence_threshold"],
              next_actions: ["needs a human /promote decision or Chris batch review"],
            }),
            expect.objectContaining({
              item_id: alreadyDispatched.item_id,
              blocker_classes: ["already_dispatched"],
              next_actions: [
                "needs reconciliation (verify done-vs-failed per output/2026-07-11-needs-review-promotion-reconciliation.md) or a fresh authored wave",
              ],
            }),
          ]),
        }),
      }),
    ]);

    const status = await daemon.explainAutoPromoteHealth();
    expect(status.empty_pipe_alert).toMatchObject({
      active: true,
      ready: 0,
      admissible_now: 0,
      reason: "ready_and_admissible_zero_all_needs_review_skipped_by_confidence_or_already_dispatched",
      items: expect.arrayContaining([
        expect.objectContaining({
          item_id: lowConfidence.item_id,
          next_actions: ["needs a human /promote decision or Chris batch review"],
        }),
        expect.objectContaining({
          item_id: alreadyDispatched.item_id,
          next_actions: [
            "needs reconciliation (verify done-vs-failed per output/2026-07-11-needs-review-promotion-reconciliation.md) or a fresh authored wave",
          ],
        }),
      ]),
    });
  });
});
