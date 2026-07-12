// Continuous Orchestration — in_flight COMPLETION RECONCILIATION + STALE REAPER.
//
// The P0 loop-strangle fix: a daemon-fired item set to `in_flight` holds its
// write-scope lock until its dispatch terminates. Before this, nothing released
// it, so after ~max_in_flight fires every lane locked forever and the loop idled
// all night. These tests prove the lock is released AUTOMATICALLY and the loop
// sustains. Backed by in-memory SQLite (same migration path as production).

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  insertBacklogItem,
  listBacklogByState,
  getBacklogItem,
  getDispatchStatusesByPhid,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig, type ContinuousOrchestrationConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";

const BASE = Date.parse("2026-06-17T18:00:00Z"); // not a load-point
const okUsage = (): { view: UsageGateView; daily_tokens_used: number } => ({
  view: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
  daily_tokens_used: 0,
});

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = await freshDb();
});

/** Insert a ready item then move it to in_flight with a dispatch phid (the
 *  exact production fire path: insert ready → setItemState in_flight). */
async function seedInFlight(
  over: Partial<BacklogItem> & { dispatch_phid?: string | null } = {},
): Promise<BacklogItem> {
  const item = await insertBacklogItem(adapter, {
    title: over.title ?? "work",
    to_agent: over.to_agent ?? "roger",
    dispatch_body: over.dispatch_body ?? "do X",
    readiness_state: "ready",
    risk_class: "build",
    priority: over.priority ?? 5,
    write_scope: over.write_scope ?? ["repoX"],
    token_estimate: 0,
  });
  await setItemState(adapter, item.item_id, "in_flight", {
    dispatch_phid: over.dispatch_phid ?? `phid:disp-${item.item_id}`,
  });
  return (await getBacklogItem(adapter, item.item_id))!;
}

/** Insert a ready item then move it to queued with a dispatch phid. This covers
 *  the already-dispatched/pre-run handoff where the scheduler row may terminally
 *  close before the backlog item ever flips to in_flight. */
async function seedQueued(
  over: Partial<BacklogItem> & { dispatch_phid?: string | null } = {},
): Promise<BacklogItem> {
  const item = await insertBacklogItem(adapter, {
    title: over.title ?? "queued work",
    to_agent: over.to_agent ?? "roger",
    dispatch_body: over.dispatch_body ?? "do queued X",
    readiness_state: "ready",
    risk_class: "build",
    priority: over.priority ?? 5,
    write_scope: over.write_scope ?? ["repoX"],
    token_estimate: 0,
  });
  await setItemState(adapter, item.item_id, "queued", {
    dispatch_phid: over.dispatch_phid ?? `phid:disp-${item.item_id}`,
  });
  return (await getBacklogItem(adapter, item.item_id))!;
}

/** Backdate an item's updated_at so the daemon's injected clock can age it past
 *  the stale window deterministically (setItemState stamps real wall-clock). */
async function backdateUpdatedAt(itemId: string, iso: string) {
  await adapter.query(`UPDATE orchestration_backlog_item SET updated_at = $1 WHERE item_id = $2`, [iso, itemId]);
}

/** Seed a dispatch_scheduler_queue row (team_id is any string — no FK). */
async function seedDispatch(phid: string, status: string, teamId = "team-uuid-9999", recoveryStatus = "none") {
  const now = new Date(BASE).toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at, recovery_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      phid,
      teamId,
      `q_${phid}`,
      "roger",
      "co",
      "manager",
      "s",
      "b",
      "anthropic",
      "claude-code-cli",
      status,
      now,
      now,
      recoveryStatus,
    ],
  );
}

function makeDaemon(over: {
  config?: Partial<ContinuousOrchestrationConfig>;
  nowMs?: number;
  fired?: BacklogItem[];
} = {}) {
  const fired = over.fired ?? [];
  const daemon = new ContinuousOrchestrationDaemon({
    adapter,
    config: { ...defaultConfig(), enabled: true, dry_run: false, ...over.config },
    enqueue: async (item) => {
      fired.push(item);
      return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q_${item.item_id}` };
    },
    readUsage: async () => okUsage(),
    // Real in-flight read so lock release is observable through admission.
    readInFlight: async () => {
      const inFlight = await listBacklogByState(adapter, { state: "in_flight" });
      const scopes = new Set<string>();
      for (const it of inFlight) for (const s of it.write_scope) scopes.add(s);
      return { count: inFlight.length, active_write_scopes: scopes };
    },
    resolveDispatchStates: (phids) => getDispatchStatusesByPhid(adapter, phids),
    alert: async () => {},
    now: () => over.nowMs ?? BASE,
  });
  return { daemon, fired };
}

describe("completion reconciliation — terminal dispatch releases the lock", () => {
  it("already-dispatched queued rows close when their dispatch is terminal done/failed_needs_operator", async () => {
    const done = await seedQueued({ dispatch_phid: "phid:disp-queued-done" });
    const failed = await seedQueued({ dispatch_phid: "phid:disp-queued-failed-needs-operator" });
    await seedDispatch("phid:disp-queued-done", "done");
    await seedDispatch("phid:disp-queued-failed-needs-operator", "failed_needs_operator");

    const { daemon, fired } = makeDaemon();
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(2);
    expect((await getBacklogItem(adapter, done.item_id))!.readiness_state).toBe("done");
    expect((await getBacklogItem(adapter, failed.item_id))!.readiness_state).toBe("needs_review");
    expect(fired.map((i) => i.item_id)).not.toContain(done.item_id);
    expect(fired.map((i) => i.item_id)).not.toContain(failed.item_id);
    expect(await listBacklogByState(adapter, { state: "queued" })).toHaveLength(0);
  });

  it("preserves queued and in_flight rows whose dispatch is still active", async () => {
    const queued = await seedQueued({ dispatch_phid: "phid:disp-still-queued" });
    const inFlight = await seedInFlight({ dispatch_phid: "phid:disp-still-in-flight" });
    await seedDispatch("phid:disp-still-queued", "queued");
    await seedDispatch("phid:disp-still-in-flight", "in_flight");
    await backdateUpdatedAt(inFlight.item_id, new Date(BASE + 29 * 60_000).toISOString());

    const { daemon } = makeDaemon({ config: { stale_in_flight_ms: 30 * 60_000 }, nowMs: BASE + 31 * 60_000 });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(0);
    expect((await getBacklogItem(adapter, queued.item_id))!.readiness_state).toBe("queued");
    expect((await getBacklogItem(adapter, inFlight.item_id))!.readiness_state).toBe("in_flight");
  });

  it("preserves queued rows waiting on needs_input/clarification", async () => {
    const item = await seedQueued({ dispatch_phid: "phid:disp-queued-needs-input" });
    await seedDispatch("phid:disp-queued-needs-input", "needs_clarification");
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());

    const { daemon } = makeDaemon({ config: { stale_in_flight_ms: 30 * 60_000 }, nowMs: BASE + 31 * 60_000 });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(0);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("queued");
  });

  it("done → done, failed → needs_review, cancelled → cancelled", async () => {
    const done = await seedInFlight({ dispatch_phid: "phid:disp-done" });
    const failed = await seedInFlight({ dispatch_phid: "phid:disp-failed" });
    const cancelled = await seedInFlight({ dispatch_phid: "phid:disp-cancelled" });
    await seedDispatch("phid:disp-done", "done");
    await seedDispatch("phid:disp-failed", "failed");
    await seedDispatch("phid:disp-cancelled", "cancelled");

    const { daemon } = makeDaemon();
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(3);
    expect((await getBacklogItem(adapter, done.item_id))!.readiness_state).toBe("done");
    expect((await getBacklogItem(adapter, failed.item_id))!.readiness_state).toBe("needs_review");
    expect((await getBacklogItem(adapter, cancelled.item_id))!.readiness_state).toBe("cancelled");
    // No items remain in_flight → all lanes unlocked.
    expect(await listBacklogByState(adapter, { state: "in_flight" })).toHaveLength(0);
  });

  it("mooted dispatch clarification releases the in_flight lock to needs_review", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-mooted-clarification" });
    await seedDispatch("phid:disp-mooted-clarification", "needs_clarification", "team-uuid-9999", "moot");

    const { daemon } = makeDaemon();
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("needs_review");
    expect(await listBacklogByState(adapter, { state: "in_flight" })).toHaveLength(0);
  });

  it("leaves a FRESH non-terminal dispatch in_flight (a live build within the window)", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-live" });
    await seedDispatch("phid:disp-live", "in_flight"); // resolvable, non-terminal, RUNNING
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());

    // Only 5m old — a live build the scheduler owns; must NOT be reaped.
    const { daemon } = makeDaemon({ config: { stale_in_flight_ms: 30 * 60_000 }, nowMs: BASE + 5 * 60_000 });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(0);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("in_flight");
  });

  it("REAPS a stale RESOLVABLE-but-non-terminal (stuck/zombie) dispatch — the strangle case", async () => {
    // A dispatch that stayed `in_flight` because its worker died/parked and the
    // scheduler never recovered it. Previously left in_flight forever (lock held);
    // now released once past the stale window.
    const item = await seedInFlight({ dispatch_phid: "phid:disp-zombie" });
    await seedDispatch("phid:disp-zombie", "in_flight");
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());

    const { daemon } = makeDaemon({ config: { stale_in_flight_ms: 30 * 60_000 }, nowMs: BASE + 31 * 60_000 });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("needs_review");
  });

  it("does NOT reap a PENDING (non-moot) needs_clarification dispatch, no matter how stale", async () => {
    // Root-caused 2026-07-04: a dispatch parked in needs_clarification (waiting
    // on an external human/manager decision — its duration is unrelated to
    // whether the worker is alive) got phantom-lock-reaped by this exact
    // staleness window every ~10 min for 3+ hours. Only recovery_status='moot'
    // (the ALREADY-CORRECT signal for an abandoned clarification, covered by
    // the "mooted dispatch clarification" test above) should release it.
    const item = await seedInFlight({ dispatch_phid: "phid:disp-pending-clarification" });
    await seedDispatch("phid:disp-pending-clarification", "needs_clarification"); // recovery_status default "none", NOT moot
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());

    // Absurdly far past any stale window (10x the default pool window) —
    // proves this is not merely "not stale yet", it is exempt entirely.
    const { daemon } = makeDaemon({ config: { pool_stale_in_flight_ms: 10 * 60_000 }, nowMs: BASE + 100 * 60_000 });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(0);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("in_flight");
  });
});

// ── DOUBLE-FIRE regression (2026-07-04): a phantom-reaped item must never be
//    silently auto-promoted back to `ready` and re-fired in the SAME tick that
//    reaped it — daemon.ts's own reconciler comment says reaping goes "to
//    needs_review... NEVER an auto-refire", but auto-promote-policy.ts had no
//    way to tell a just-reaped (or genuinely-failed) retry apart from a
//    freshly-fleshed item that has never fired, so it silently re-fired both.
describe("reap → auto-promote interaction — a reaped item must wait for a human /promote", () => {
  async function markFleshedHighConfidence(itemId: string) {
    await adapter.query(
      `UPDATE orchestration_backlog_item SET flesh_status = 'fleshed', flesh_confidence = 0.95 WHERE item_id = $1`,
      [itemId],
    );
  }

  it("a stale phantom-locked pool build is reaped but NOT auto-promoted/re-fired in the same tick", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-phantom-autopromote", write_scope: ["/repo/.worktrees/roger-a"] });
    await seedDispatch("phid:disp-phantom-autopromote", "in_flight"); // resolvable, non-terminal, stuck
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());
    await markFleshedHighConfidence(item.item_id); // otherwise-perfect auto-promote candidate

    const fired: BacklogItem[] = [];
    const { daemon } = makeDaemon({
      fired,
      config: {
        pool_stale_in_flight_ms: 10 * 60_000,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 1,
        auto_promote_min_lanes: 1,
      },
      nowMs: BASE + 11 * 60_000, // just past the pool stale window
    });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(1);
    // Reaped to needs_review — and MUST STAY there, not bounce straight back to
    // ready/in_flight via auto-promote in this same tick.
    const after = (await getBacklogItem(adapter, item.item_id))!;
    expect(after.readiness_state).toBe("needs_review");
    // No re-fire happened: the only dispatch on record is the original one.
    expect(fired.map((i) => i.item_id)).not.toContain(item.item_id);
  });
});

// ── POOL path (Stage C): each build holds a DISTINCT worktree write_scope.
//    A dead pool worker's dispatch frequently never reaches terminal, so the
//    backlog item would otherwise hold its pool slot + worktree lock forever.
describe("POOL builds — completion + zombie reaping frees the pool slot", () => {
  /** Seed a pool-shaped in_flight build: a distinct worktree write_scope + a pool builder. */
  async function seedPoolBuild(phid: string, agent: string, worktree: string) {
    return seedInFlight({ dispatch_phid: phid, to_agent: agent, write_scope: [worktree] });
  }

  it("a completed pool build (dispatch done) reconciles out of in_flight automatically", async () => {
    const build = await seedPoolBuild("phid:disp-pool-done", "hopper", "/repo/.worktrees/hopper-a");
    await seedDispatch("phid:disp-pool-done", "done");

    const { daemon } = makeDaemon();
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, build.item_id))!.readiness_state).toBe("done");
    expect(await listBacklogByState(adapter, { state: "in_flight" })).toHaveLength(0);
  });

  it("a dead pool worker (dispatch stuck in_flight) is reaped; a fresh sibling build is left running", async () => {
    const dead = await seedPoolBuild("phid:disp-pool-dead", "hopper", "/repo/.worktrees/hopper-dead");
    const live = await seedPoolBuild("phid:disp-pool-live", "brunel", "/repo/.worktrees/brunel-live");
    await seedDispatch("phid:disp-pool-dead", "in_flight"); // worker died, dispatch never terminalized
    await seedDispatch("phid:disp-pool-live", "in_flight"); // genuinely building
    await backdateUpdatedAt(dead.item_id, new Date(BASE).toISOString());           // stale
    await backdateUpdatedAt(live.item_id, new Date(BASE + 28 * 60_000).toISOString()); // fresh

    const { daemon } = makeDaemon({ config: { stale_in_flight_ms: 30 * 60_000 }, nowMs: BASE + 31 * 60_000 });
    const tick = await daemon.runTick();

    // Only the dead build's slot is freed; the live sibling keeps its distinct worktree lock.
    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, dead.item_id))!.readiness_state).toBe("needs_review");
    expect((await getBacklogItem(adapter, live.item_id))!.readiness_state).toBe("in_flight");
  });

  it("SOAK — a phantom pool build is reaped with NO manual release, freeing the pool slot the next tick", async () => {
    const phantom = await seedPoolBuild("phid:disp-pool-phantom", "hopper", "/repo/.worktrees/hopper-x");
    await seedDispatch("phid:disp-pool-phantom", "in_flight"); // stuck; no worker actually running
    await backdateUpdatedAt(phantom.item_id, new Date(BASE).toISOString());

    const { daemon } = makeDaemon({ config: { stale_in_flight_ms: 30 * 60_000 }, nowMs: BASE + 45 * 60_000 });
    const tick = await daemon.runTick();

    // Reaped automatically — no manual release, no interim-reaper assist.
    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, phantom.item_id))!.readiness_state).toBe("needs_review");
    expect(await listBacklogByState(adapter, { state: "in_flight" })).toHaveLength(0);
  });

  it("reaps a dead POOL build on the short window while a same-aged MAIN-lane build is still protected", async () => {
    const pool = await seedPoolBuild("phid:disp-pool-fast", "hopper", "/repo/.worktrees/hopper-fast");
    const main = await seedInFlight({ dispatch_phid: "phid:disp-main-slow", write_scope: ["id-agents"] });
    await seedDispatch("phid:disp-pool-fast", "in_flight");
    await seedDispatch("phid:disp-main-slow", "in_flight");
    await backdateUpdatedAt(pool.item_id, new Date(BASE).toISOString());
    await backdateUpdatedAt(main.item_id, new Date(BASE).toISOString());

    // 11m old: past the pool window (10m) but within the shared-scope window (30m).
    const { daemon } = makeDaemon({
      config: { stale_in_flight_ms: 30 * 60_000, pool_stale_in_flight_ms: 10 * 60_000 },
      nowMs: BASE + 11 * 60_000,
    });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, pool.item_id))!.readiness_state).toBe("needs_review"); // pool reaped fast
    expect((await getBacklogItem(adapter, main.item_id))!.readiness_state).toBe("in_flight");    // main still protected
  });
});

describe("stale reaper — unresolvable dispatch self-heals after the window", () => {
  it("reaps an in_flight item whose dispatch is unresolvable AND older than stale_in_flight_ms", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-missing" }); // no dispatch row seeded
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());
    const { daemon } = makeDaemon({
      config: { stale_in_flight_ms: 30 * 60_000 },
      nowMs: BASE + 31 * 60_000,
    });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("needs_review");
  });

  it("does NOT reap a fresh in_flight item (within the stale window)", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-missing2" });
    await backdateUpdatedAt(item.item_id, new Date(BASE).toISOString());
    const { daemon } = makeDaemon({
      config: { stale_in_flight_ms: 30 * 60_000 },
      nowMs: BASE + 5 * 60_000,
    });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(0);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("in_flight");
  });
});

describe("dry-run posture — compute + log, mutate nothing", () => {
  it("emits would_reconcile and leaves the item in_flight", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-dry" });
    await seedDispatch("phid:disp-dry", "done");
    const { daemon } = makeDaemon({ config: { dry_run: true } });
    const tick = await daemon.runTick();

    expect(tick.decisions.some((d) => d.action === "would_reconcile")).toBe(true);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("in_flight");
  });
});

describe("SOAK — the loop sustains: fire → complete → reconcile → fire again", () => {
  it("a completed dispatch frees its lane so the next item fires (no manual step)", async () => {
    // Single lane (max_in_flight 1), two items contending for the same write_scope.
    const first = await seedInFlight({ dispatch_phid: "phid:disp-first", write_scope: ["repoX"] });
    const second = await insertBacklogItem(adapter, {
      title: "second",
      to_agent: "roger",
      dispatch_body: "do Y",
      readiness_state: "ready",
      risk_class: "build",
      priority: 5,
      write_scope: ["repoX"],
      token_estimate: 0,
    });

    // Default orchestration mode is `paused`; the loop only admits while running.
    const { daemon: modeSetter } = makeDaemon({ config: { max_in_flight: 1 } });
    await modeSetter.setMode("running");

    // Tick 1: first's dispatch still ACTIVE → lane locked → second cannot fire.
    await seedDispatch("phid:disp-first", "active");
    const fired1: BacklogItem[] = [];
    const t1 = await makeDaemon({ config: { max_in_flight: 1 }, fired: fired1 }).daemon.runTick();
    expect(t1.reconciled).toBe(0);
    expect(fired1.map((i) => i.item_id)).not.toContain(second.item_id);

    // first's dispatch now completes.
    await adapter.query(`UPDATE dispatch_scheduler_queue SET status = $1 WHERE dispatch_phid = $2`, [
      "done",
      "phid:disp-first",
    ]);

    // Tick 2: reconcile releases first's lock BEFORE admission → second fires.
    const fired2: BacklogItem[] = [];
    const t2 = await makeDaemon({ config: { max_in_flight: 1 }, fired: fired2 }).daemon.runTick();
    expect(t2.reconciled).toBe(1);
    expect((await getBacklogItem(adapter, first.item_id))!.readiness_state).toBe("done");
    expect(fired2.map((i) => i.item_id)).toContain(second.item_id);
  });
});

describe("getDispatchStatusesByPhid — phid-only, no team filter (trap avoidance)", () => {
  it("resolves a dispatch keyed by team UUID via phid alone", async () => {
    await seedDispatch("phid:disp-uuidteam", "done", "team-uuid-abcdef"); // team is a UUID, not 'default'
    const map = await getDispatchStatusesByPhid(adapter, ["phid:disp-uuidteam", "phid:disp-absent"]);
    expect(map.get("phid:disp-uuidteam")).toBe("done");
    expect(map.has("phid:disp-absent")).toBe(false); // missing phids absent (treated as unresolvable)
  });
});
