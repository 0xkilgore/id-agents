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

/** Backdate an item's updated_at so the daemon's injected clock can age it past
 *  the stale window deterministically (setItemState stamps real wall-clock). */
async function backdateUpdatedAt(itemId: string, iso: string) {
  await adapter.query(`UPDATE orchestration_backlog_item SET updated_at = $1 WHERE item_id = $2`, [iso, itemId]);
}

/** Seed a dispatch_scheduler_queue row (team_id is any string — no FK). */
async function seedDispatch(phid: string, status: string, teamId = "team-uuid-9999") {
  const now = new Date(BASE).toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [phid, teamId, `q_${phid}`, "roger", "co", "manager", "s", "b", "anthropic", "claude-code-cli", status, now, now],
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

  it("leaves an ACTIVE (non-terminal) dispatch in_flight even when stale-aged", async () => {
    const item = await seedInFlight({ dispatch_phid: "phid:disp-active" });
    await seedDispatch("phid:disp-active", "active");

    // now far past the stale window — active dispatches are the scheduler's to
    // recover; reaping one would double-fire, so it must stay in_flight.
    const { daemon } = makeDaemon({ nowMs: BASE + 60 * 60_000 });
    const tick = await daemon.runTick();

    expect(tick.reconciled).toBe(0);
    expect((await getBacklogItem(adapter, item.item_id))!.readiness_state).toBe("in_flight");
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
