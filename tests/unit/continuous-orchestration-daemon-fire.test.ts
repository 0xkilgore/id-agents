// RD-003 (Fable critique 2026-07-01): the CO daemon fire transition is non-atomic
// — bindItemForFire persists before enqueue, so a failure/crash strands or
// double-fires items. These tests reproduce both failure modes.

import { describe, expect, it } from "vitest";
import { ContinuousOrchestrationDaemon, type DaemonDeps } from "../../src/continuous-orchestration/daemon.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { insertBacklogItem, getBacklogItem, recordTickOutcome, setItemState, setMode } from "../../src/continuous-orchestration/storage.js";
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
    kill_switch_path: "/tmp/id-agents-test-kill-switch-never",
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

function targetUnhealthyReroutePools(): NonNullable<DaemonDeps["pools"]> {
  const pool = {
    pool_id: "backend",
    repo_root: "/repo",
    max_parallel: 3,
    members: ["roger", "substrate-orch-codex", "substrate-api-codex"],
  };
  return {
    poolForItem: () => null,
    availableBuilders: () => ["roger"],
    healthyEquivalentTarget: ({ unhealthyTarget, healthyAgents, busyAgents }) => {
      if (!pool.members.includes(unhealthyTarget)) return null;
      const candidates = pool.members.filter((agent) =>
        agent !== unhealthyTarget &&
        healthyAgents.has(agent) &&
        !busyAgents.has(agent)
      );
      return candidates[0] ? { pool, target: candidates[0], candidates } : null;
    },
    allocateWorktree: async () => ({ path: "/repo/.worktrees/wt-reroute", branch: "b-reroute", lease_id: null }),
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

async function seedTargetUnhealthyReadyItem(adapter: SqliteAdapter, overrides: Partial<BacklogItem> = {}): Promise<BacklogItem> {
  await setMode(adapter, "default", "running");
  const seeded = await insertBacklogItem(adapter, {
    team_id: "default",
    logical_key: overrides.logical_key ?? "target-unhealthy-ready",
    title: overrides.title ?? "[project: kapelle][T-ORCH][BUILD] unhealthy backend target",
    track: "T-ORCH",
    to_agent: overrides.to_agent ?? "substrate-api-codex",
    dispatch_body: overrides.dispatch_body ?? "do backend work",
    readiness_state: "ready",
    risk_class: "build",
    write_scope: overrides.write_scope ?? ["/repo/backend"],
    token_estimate: 1000,
    provider: "openai",
    runtime: "codex",
  });
  if (overrides.last_dispatch_phid) {
    await adapter.query(
      `UPDATE orchestration_backlog_item SET last_dispatch_phid = $1 WHERE item_id = $2`,
      [overrides.last_dispatch_phid, seeded.item_id],
    );
  }
  return (await getBacklogItem(adapter, seeded.item_id))!;
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

    const enqueued: string[] = [];
    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => {
        enqueued.push(item.item_id);
        return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` };
      },
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
    expect(enqueued).toEqual([fresh.item_id]);
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
    const closed = await getBacklogItem(adapter, staleDone.item_id);
    expect(closed?.readiness_state).toBe("done");
    expect(closed?.stale_duplicate_closeout_receipt).toMatchObject({
      schema_version: "orchestration.stale_duplicate_closeout_receipt.v1",
      from_state: "ready",
      to_state: "done",
      next_action: "close_duplicate_row",
      prior_dispatch_phid: "phid:disp-already-done",
      prior_dispatch_status: "done",
      redispatch_safety: {
        safe_to_not_redispatch: true,
      },
    });
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

  it("emits one actionable zero-admit incident for repeated full-capacity ticks until blocker state changes", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 2,
      fired: false,
      admission_block_reasons: {
        no_in_flight_slots: 2,
        duplicate_dispatch_retry_required: 1,
      },
    });

    const duplicate = await insertBacklogItem(adapter, {
      team_id: "default",
      title: "duplicate retry needs operator decision",
      to_agent: "roger",
      dispatch_body: "retry only with explicit operator approval",
      readiness_state: "ready",
      risk_class: "build",
      priority: 1,
      write_scope: ["/repo/kapelle/duplicate"],
    });
    await setItemState(adapter, duplicate.item_id, "ready", { dispatch_phid: "phid:disp-still-active" });
    for (let i = 0; i < 2; i += 1) {
      await insertBacklogItem(adapter, {
        team_id: "default",
        title: `capacity-held ready row ${i}`,
        to_agent: "roger",
        dispatch_body: "ready but capacity is full",
        readiness_state: "ready",
        risk_class: "build",
        priority: 2,
        write_scope: [`/repo/kapelle/capacity-${i}`],
      });
    }

    const alerts: string[] = [];
    const fullRuntime = async () => ({ count: 2, active_write_scopes: new Set<string>() });
    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: {
        ...config(),
        max_in_flight: 2,
        max_enqueues_per_tick: 5,
        max_new_per_tick: 5,
        stall_threshold_ticks: 3,
      },
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: fullRuntime,
      resolveAgentHealth: async () => new Set(["roger"]),
      readDiskHeadroom: async () => ({
        schema_version: "disk-headroom.v1",
        state: "ok",
        path: "/tmp",
        free_bytes: 50 * 1024 ** 3,
        available_bytes: 50 * 1024 ** 3,
        total_bytes: 100 * 1024 ** 3,
        free_gib: 50,
        available_gib: 50,
        total_gib: 100,
        used_percent: 50,
        min_free_bytes: 5 * 1024 ** 3,
        warn_free_bytes: 10 * 1024 ** 3,
        reason: null,
      }),
      alert: async (message) => { alerts.push(message); },
    });

    const first = await daemon.runTick();
    const second = await daemon.runTick();
    const third = await daemon.runTick();

    const incidentAlerts = () => alerts.filter((message) => message.includes("zero-admit incident"));
    expect(first.zero_ticks).toBe(3);
    expect(first.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "zero_admit_incident",
          metadata: expect.objectContaining({
            incident_code: "zero_admit_ready_blocked",
            no_in_flight_slots: 2,
            duplicate_dispatch_retry_required: 1,
            recommended_action: expect.stringContaining("wait for in-flight slots to free"),
            blocker_counts: [
              { code: "no_in_flight_slots", category: "capacity_gate", count: 2 },
              { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1 },
            ],
          }),
        }),
      ]),
    );
    expect(first.decisions.some((decision) => decision.action === "stall_alert")).toBe(false);
    expect(second.decisions.some((decision) => decision.action === "zero_admit_incident")).toBe(false);
    expect(third.decisions.some((decision) => decision.action === "zero_admit_incident")).toBe(false);
    expect(incidentAlerts()).toHaveLength(1);
    expect(incidentAlerts()[0]).toContain("no_in_flight_slots=2");
    expect(incidentAlerts()[0]).toContain("duplicate_dispatch_retry_required=1");
    expect(incidentAlerts()[0]).toContain("Recommended action");

    const secondDuplicate = await insertBacklogItem(adapter, {
      team_id: "default",
      title: "second duplicate retry needs operator decision",
      to_agent: "roger",
      dispatch_body: "retry only with explicit operator approval",
      readiness_state: "ready",
      risk_class: "build",
      priority: 1,
      write_scope: ["/repo/kapelle/duplicate-2"],
    });
    await setItemState(adapter, secondDuplicate.item_id, "ready", { dispatch_phid: "phid:disp-still-active-2" });

    const changed = await daemon.runTick();
    expect(changed.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "zero_admit_incident",
          metadata: expect.objectContaining({
            duplicate_dispatch_retry_required: 2,
            recommended_action: expect.stringContaining("duplicate_dispatch_retry_required=2"),
          }),
        }),
      ]),
    );
    expect(incidentAlerts()).toHaveLength(2);
  });
});

describe("target_unhealthy reroute receipts", () => {
  it("reroutes a fresh target_unhealthy ready row to a healthy same-pool equivalent and emits a receipt", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    const seeded = await seedTargetUnhealthyReadyItem(adapter);
    const enqueued: BacklogItem[] = [];

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => {
        enqueued.push(item);
        return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` };
      },
      readUsage: usage,
      readInFlight: noInFlight,
      resolveAgentHealth: async () => new Set(["roger"]),
      resolveAgentRuntimes: async () => new Map([["roger", "codex"], ["substrate-api-codex", "codex"]]),
      pools: targetUnhealthyReroutePools(),
    });

    const result = await daemon.runTick();
    const updated = await getBacklogItem(adapter, seeded.item_id);
    const rerouteDecision = result.decisions.find((decision) => decision.action === "target_unhealthy_reroute");

    expect(enqueued.map((item) => item.to_agent)).toEqual(["roger"]);
    expect(updated?.to_agent).toBe("roger");
    expect(updated?.readiness_state).toBe("in_flight");
    expect(rerouteDecision).toMatchObject({
      item_id: seeded.item_id,
      metadata: {
        unhealthy_target: "substrate-api-codex",
        proposed_healthy_target: "roger",
        receipt: {
          action: "rerouted",
          unhealthy_target: "substrate-api-codex",
          proposed_healthy_target: "roger",
          duplicate_retry_refired: false,
          prior_dispatch_evidence: {
            last_dispatch_phid: null,
            status: null,
            retry_safe: false,
          },
        },
      },
    });
  });

  it("holds a previously dispatched target_unhealthy row with prior dispatch evidence and does not refire it", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await seedDispatchStatus(adapter, "phid:disp-prior-unhealthy", "queued");
    const seeded = await seedTargetUnhealthyReadyItem(adapter, {
      logical_key: "target-unhealthy-duplicate",
      last_dispatch_phid: "phid:disp-prior-unhealthy",
    });
    const enqueued: BacklogItem[] = [];

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => {
        enqueued.push(item);
        return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` };
      },
      readUsage: usage,
      readInFlight: noInFlight,
      resolveAgentHealth: async () => new Set(["roger"]),
      resolveAgentRuntimes: async () => new Map([["roger", "codex"], ["substrate-api-codex", "codex"]]),
      pools: targetUnhealthyReroutePools(),
    });

    const result = await daemon.runTick();
    const updated = await getBacklogItem(adapter, seeded.item_id);
    const rerouteDecision = result.decisions.find((decision) => decision.action === "target_unhealthy_reroute");

    expect(enqueued).toEqual([]);
    expect(updated?.to_agent).toBe("substrate-api-codex");
    expect(updated?.readiness_state).toBe("ready");
    expect(rerouteDecision).toMatchObject({
      item_id: seeded.item_id,
      dispatch_phid: "phid:disp-prior-unhealthy",
      metadata: {
        receipt: {
          action: "held",
          unhealthy_target: "substrate-api-codex",
          proposed_healthy_target: "roger",
          duplicate_retry_refired: false,
          prior_dispatch_evidence: {
            last_dispatch_phid: "phid:disp-prior-unhealthy",
            status: "queued",
            retry_safe: false,
          },
        },
      },
    });
    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: seeded.item_id,
          action: "held",
          metadata: expect.objectContaining({ code: "duplicate_dispatch_retry_required" }),
        }),
      ]),
    );
  });
});

describe("ready admission target-unhealthy receipts", () => {
  it("reports Wave79-style zero-admissible target_unhealthy rows with safe reroute or hold receipts", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    const seeded: BacklogItem[] = [];
    for (const target of ["substrate-api-codex", "brunel", "coder-max"]) {
      for (let i = 1; i <= 3; i += 1) {
        seeded.push(await insertBacklogItem(adapter, {
          team_id: "default",
          logical_key: `wave79-${target}-${i}`,
          title: `[project: kapelle][T-ORCH][BUILD] Wave79 ${target} target_unhealthy ${i}`,
          track: "T-ORCH",
          to_agent: target,
          dispatch_body: `Wave79 fixture ${i}: hold or safely reroute ${target}.`,
          readiness_state: "ready",
          risk_class: "build",
          write_scope: [`/repo/wave79/${target}/${i}`],
          provider: "openai",
          runtime: "codex",
        }));
      }
    }

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
      resolveAgentHealth: async () => new Set(["roger"]),
      resolveAgentRuntimes: async () => new Map([["roger", "codex"], ["substrate-api-codex", "codex"]]),
      pools: targetUnhealthyReroutePools(),
    });

    const status = await daemon.explainReadyAdmission();
    const rowsById = new Map(status.non_admitted.map((row) => [row.item_id, row]));
    const substrateRows = seeded.filter((row) => row.to_agent === "substrate-api-codex");
    const heldRows = seeded.filter((row) => row.to_agent !== "substrate-api-codex");

    expect(status.candidates).toBe(9);
    expect(status.admissible_now).toBe(0);
    expect(status.admissible).toEqual([]);
    expect(status.useful_ready).toBe(0);
    expect(status.blocker_counts).toEqual([
      { code: "target_unhealthy", category: "runtime_unavailable", count: 9 },
    ]);
    expect(status.non_admitted.map((row) => row.item_id).sort()).toEqual(
      seeded.map((row) => row.item_id).sort(),
    );
    expect(status.recommended_action).toContain("target_unhealthy=9 rows");
    const countByTarget = (target: string) =>
      status.target_unhealthy_groups
        .filter((group) => group.target === target)
        .reduce((sum, group) => sum + group.count, 0);
    expect(countByTarget("substrate-api-codex")).toBe(3);
    expect(countByTarget("brunel")).toBe(3);
    expect(countByTarget("coder-max")).toBe(3);
    expect(status.target_unhealthy_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "substrate-api-codex",
          count: 1,
          proposed_healthy_target: "roger",
          examples: expect.arrayContaining([
            expect.objectContaining({ item_id: substrateRows[0].item_id, prior_owner: "substrate-api-codex" }),
          ]),
        }),
        expect.objectContaining({
          target: "brunel",
          count: 1,
          proposed_healthy_target: null,
        }),
        expect.objectContaining({
          target: "coder-max",
          count: 1,
          proposed_healthy_target: null,
        }),
      ]),
    );

    for (const row of substrateRows) {
      const receipt = rowsById.get(row.item_id)?.target_unhealthy_receipt;
      expect(receipt).toMatchObject({
        code: "target_unhealthy",
        target: "substrate-api-codex",
        prior_owner: "substrate-api-codex",
        proposed_healthy_target: "roger",
        hold_reason: null,
        prior_dispatch_evidence: {
          last_dispatch_phid: null,
          status: null,
          recovery_status: null,
          retry_safe: false,
        },
        counts_as_useful_build_fuel: false,
      });
    }
    for (const row of heldRows) {
      const receipt = rowsById.get(row.item_id)?.target_unhealthy_receipt;
      expect(receipt).toMatchObject({
        code: "target_unhealthy",
        target: row.to_agent,
        prior_owner: row.to_agent,
        proposed_healthy_target: null,
        hold_reason: expect.stringContaining("no healthy compatible target"),
        prior_dispatch_evidence: {
          last_dispatch_phid: null,
          status: null,
          recovery_status: null,
          retry_safe: false,
        },
        counts_as_useful_build_fuel: false,
      });
      expect(receipt?.safe_action_summary).toContain("Do not refire silently");
    }
  });

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
    expect(status.target_unhealthy_groups).toEqual([
      expect.objectContaining({
        target: "brunel",
        lane: "/Users/kilgore/Dropbox/Code/kapelle-site/app/ops",
        count: 1,
        examples: [
          expect.objectContaining({
            item_id: brunel.item_id,
            title: brunel.title,
            prior_owner: "brunel",
          }),
        ],
        recommended_action: expect.stringContaining("Reroute to a compatible healthy agent"),
      }),
      expect.objectContaining({
        target: "coder-max",
        lane: "/Users/kilgore/Dropbox/Code/cane/id-agents/src/dispatch-scheduler",
        count: 1,
        recommended_action: expect.stringContaining("downclassify/supersede"),
      }),
      expect.objectContaining({
        target: "substrate-api-codex",
        lane: "/Users/kilgore/Dropbox/Code/cane/id-agents/src/continuous-orchestration",
        count: 1,
        recommended_action: expect.stringContaining("restart target owner substrate-api-codex"),
      }),
    ]);
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
          safe_action: "reroute_downclassify_or_owner_restart",
          counts_as_useful_build_fuel: false,
        },
      });
      expect(row.target_unhealthy_receipt).toEqual(row.metadata?.target_unhealthy_receipt);
      expect(row.target_unhealthy_receipt?.safe_action_summary).toContain("Do not refire silently");
      expect(row.target_unhealthy_receipt?.safe_action_summary).toContain("downclassify/supersede");
      expect(row.target_unhealthy_receipt?.safe_action_summary).toContain("restart the owner only when safe");
    }
  });

  it("excludes terminal duplicate-dispatch ready rows from ready fuel while preserving manual retry blockers", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    const terminalStatuses = ["done", "cancelled", "moot", "superseded"] as const;
    for (let i = 0; i < 8; i += 1) {
      const phid = `phid:disp-terminal-duplicate-${i}`;
      const item = await seedReadyBuildFuel(adapter, i + 1);
      await setItemState(adapter, item.item_id, "ready", { dispatch_phid: phid });
      await seedDispatchStatus(adapter, phid, terminalStatuses[i % terminalStatuses.length]);
    }

    const promotedPhid = "phid:disp-promotion-verified-duplicate";
    const promoted = await seedReadyBuildFuel(adapter, 9);
    await setItemState(adapter, promoted.item_id, "ready", { dispatch_phid: promotedPhid });
    await seedDispatchStatus(adapter, promotedPhid, "failed");
    await adapter.query(
      `UPDATE dispatch_scheduler_queue
          SET promotion_result_json = $1
        WHERE dispatch_phid = $2`,
      [
        JSON.stringify({ completed: true, repos: [{ verified: true, promoted_sha: "abc", remote_main_sha: "abc" }] }),
        promotedPhid,
      ],
    );

    const retryable = await seedReadyBuildFuel(adapter, 10);
    await setItemState(adapter, retryable.item_id, "ready", { dispatch_phid: "phid:disp-retryable-duplicate" });
    await seedDispatchStatus(adapter, "phid:disp-retryable-duplicate", "failed");
    await adapter.query(
      `UPDATE dispatch_scheduler_queue
          SET failure_kind = 'scheduler_wedged',
              failure_detail = 'stale in-flight claim'
        WHERE dispatch_phid = 'phid:disp-retryable-duplicate'`,
    );

    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: config(),
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
    });

    const status = await daemon.explainReadyAdmission();

    expect(status.candidates).toBe(1);
    expect(status.useful_ready).toBe(0);
    expect(status.stale_ready_floor).toMatchObject({
      stale: true,
      ready: 1,
      reason: expect.stringContaining("raw_ready_fuel=1"),
    });
    expect(status.blocker_counts).toEqual([
      { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 10 },
    ]);
    expect(status.recommended_action).toContain("duplicate_dispatch_retry_required=10 rows");
    expect(status.non_admitted).toHaveLength(10);
    expect(status.non_admitted.find((row) => row.item_id === retryable.item_id)).toMatchObject({
      code: "duplicate_dispatch_retry_required",
      metadata: {
        duplicate_retry: {
          next_action: "mark_retry_safe_to_refire",
          operator_disposition: "retry",
          retry_safe_recommendation: "set_true",
        },
      },
    });
  });

  it("deduplicates target-unhealthy ready-blocked Telegram incidents across consecutive ticks", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    for (let i = 0; i < 7; i += 1) {
      await insertBacklogItem(adapter, {
        team_id: "default",
        logical_key: `wave91-unhealthy-${i}`,
        title: `wave91 target unhealthy ${i}`,
        track: "T-RELY",
        to_agent: i < 4 ? "brunel" : "coder-max",
        dispatch_body: "hold until target is healthy",
        readiness_state: "ready",
        risk_class: "build",
        write_scope: [`/repo/wave91/unhealthy-${i}`],
      });
    }
    const dependency = await insertBacklogItem(adapter, {
      team_id: "default",
      logical_key: "wave91-blocking-dependency",
      title: "wave91 dependency not done",
      track: "T-RELY",
      to_agent: "roger",
      dispatch_body: "dependency",
      readiness_state: "blocked_dependency",
      risk_class: "build",
      write_scope: ["/repo/wave91/dependency-root"],
    });
    for (let i = 0; i < 3; i += 1) {
      await insertBacklogItem(adapter, {
        team_id: "default",
        logical_key: `wave91-blocked-dependency-${i}`,
        title: `wave91 blocked dependency ${i}`,
        track: "T-RELY",
        to_agent: "roger",
        dispatch_body: "blocked until dependency finishes",
        readiness_state: "ready",
        risk_class: "build",
        write_scope: [`/repo/wave91/dependency-${i}`],
        dependencies: [dependency.item_id],
      });
    }
    await recordTickOutcome(adapter, "default", {
      zero_ticks: 2,
      fired: false,
      admission_block_reasons: {
        target_unhealthy: 7,
        blocked_dependency: 3,
      },
    });

    const alerts: string[] = [];
    const daemon = new ContinuousOrchestrationDaemon({
      adapter,
      config: {
        ...config(),
        min_ready_fuel: 8,
        max_enqueues_per_tick: 20,
        max_new_per_tick: 20,
        max_in_flight: 20,
        stall_threshold_ticks: 3,
      },
      enqueue: async (item) => ({ dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q-${item.item_id}` }),
      readUsage: usage,
      readInFlight: noInFlight,
      resolveAgentHealth: async () => new Set(["roger"]),
      readDiskHeadroom: async () => ({
        schema_version: "disk-headroom.v1",
        state: "ok",
        path: "/tmp",
        free_bytes: 50 * 1024 ** 3,
        available_bytes: 50 * 1024 ** 3,
        total_bytes: 100 * 1024 ** 3,
        free_gib: 50,
        available_gib: 50,
        total_gib: 100,
        used_percent: 50,
        min_free_bytes: 5 * 1024 ** 3,
        warn_free_bytes: 10 * 1024 ** 3,
        reason: null,
      }),
      alert: async (message) => { alerts.push(message); },
    });

    const first = await daemon.runTick();
    const second = await daemon.runTick();

    expect(first.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "target_unhealthy_incident",
          metadata: expect.objectContaining({
            incident_code: "ready_fuel_blocked_by_target_unhealthy",
            affected_targets: ["brunel", "coder-max"],
            blocker_counts: [
              { code: "target_unhealthy", category: "runtime_unavailable", count: 7 },
              { code: "blocked_dependency", category: "lane_eligibility", count: 3 },
            ],
          }),
        }),
      ]),
    );
    expect(first.decisions.some((decision) => decision.action === "stall_alert")).toBe(false);
    expect(second.decisions.some((decision) => decision.action === "target_unhealthy_incident")).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("target-unhealthy ready-blocked incident");
    expect(alerts[0]).toContain("target_unhealthy=7");
    expect(alerts[0]).toContain("blocked_dependency=3");
    expect(alerts[0]).toContain("Affected targets: brunel, coder-max");
  });
});

describe("empty auto-promote pipe alert", () => {
  it("closes terminal stale needs_review rows and promotes safe current rows when useful fuel is 4 of 12", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await setMode(adapter, "default", "running");

    for (let i = 1; i <= 4; i += 1) {
      await seedReadyBuildFuel(adapter, i);
    }

    const staleReviewRows: BacklogItem[] = [];
    for (let i = 1; i <= 6; i += 1) {
      await seedDispatchStatus(adapter, `phid:disp-stale-review-${i}`, "done");
      staleReviewRows.push(await seedNeedsReviewItem(adapter, {
        title: `terminal stale review duplicate ${i}`,
        last_dispatch_phid: `phid:disp-stale-review-${i}`,
        write_scope: [`repo/stale-review-${i}`],
      }));
    }

    const safeRows: BacklogItem[] = [];
    for (let i = 1; i <= 8; i += 1) {
      safeRows.push(await seedNeedsReviewItem(adapter, {
        title: `safe current review fuel ${i}`,
        write_scope: [`repo/current-review-${i}`],
      }));
    }

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

    const tick = await daemon.runTick();

    expect(tick.stale_ready_reconciled).toMatchObject({
      closed: 6,
      superseded: 0,
      preserved_retry_safe: 0,
      dry_run: false,
    });
    expect(tick.stale_ready_reconciled.items.map((item) => item.from_state)).toEqual(
      Array(6).fill("needs_review"),
    );
    expect(tick.auto_promote).toMatchObject({
      triggered: true,
      promoted: 8,
      skipped: 0,
      candidates_considered: 8,
      before: { build_ready: 4 },
    });

    for (const stale of staleReviewRows) {
      const row = await getBacklogItem(adapter, stale.item_id);
      expect(row?.readiness_state).toBe("done");
      expect(row?.stale_duplicate_closeout_receipt).toMatchObject({
        from_state: "needs_review",
        to_state: "done",
        prior_dispatch_status: "done",
      });
    }
    for (const safe of safeRows) {
      expect(["ready", "in_flight"]).toContain((await getBacklogItem(adapter, safe.item_id))?.readiness_state);
    }

    const status = await daemon.explainAutoPromoteHealth();
    expect(status.lanes.ready_plus_in_flight).toBeGreaterThanOrEqual(7);
    expect(status.below_floor).toBe(false);
    expect(status.triggered).toBe(false);
    expect(status.candidates_considered).toBe(0);
    expect(status.candidates.map((item) => item.item_id)).not.toEqual(
      expect.arrayContaining(staleReviewRows.map((item) => item.item_id)),
    );
  });

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
