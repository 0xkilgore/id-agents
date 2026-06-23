// Continuous Orchestration — storage + roadmap import + daemon integration.
// Backed by in-memory SQLite (same migration path as production).

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  insertBacklogItem,
  listBacklogByState,
  promoteToReady,
  getBacklogItem,
  listRecentDecisions,
  getOrchestrationState,
} from "../../src/continuous-orchestration/storage.js";
import { parseRoadmapToBacklog } from "../../src/continuous-orchestration/roadmap-import.js";
import { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig, type ContinuousOrchestrationConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

const okUsage = (used = 0): { view: UsageGateView; daily_tokens_used: number } => ({
  view: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
  daily_tokens_used: used,
});

function makeDaemon(
  adapter: SqliteAdapter,
  over: {
    config?: Partial<ContinuousOrchestrationConfig>;
    enqueue?: (item: BacklogItem) => Promise<{ dispatch_phid: string; query_id: string }>;
    readUsage?: () => Promise<{ view: UsageGateView; daily_tokens_used: number }>;
    inFlight?: number;
    activeScopes?: Set<string>;
    alerts?: string[];
    killSwitch?: boolean;
  } = {},
) {
  const fired: BacklogItem[] = [];
  const alerts = over.alerts ?? [];
  const daemon = new ContinuousOrchestrationDaemon({
    adapter,
    config: { ...defaultConfig(), ...over.config },
    enqueue:
      over.enqueue ??
      (async (item) => {
        fired.push(item);
        return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q_${item.item_id}` };
      }),
    readUsage: over.readUsage ?? (() => Promise.resolve(okUsage())),
    readInFlight: () =>
      Promise.resolve({ count: over.inFlight ?? 0, active_write_scopes: over.activeScopes ?? new Set() }),
    alert: async (m) => {
      alerts.push(m);
    },
    killSwitchActive: () => over.killSwitch ?? false,
    now: () => Date.parse("2026-06-17T18:00:00Z"), // not a load-point
  });
  return { daemon, fired, alerts };
}

async function seedReady(adapter: SqliteAdapter, over: Partial<BacklogItem> = {}) {
  const item = await insertBacklogItem(adapter, {
    title: over.title ?? "do work",
    to_agent: over.to_agent ?? "roger",
    dispatch_body: over.dispatch_body ?? "implement X",
    readiness_state: "ready",
    risk_class: over.risk_class ?? "build",
    priority: over.priority ?? 5,
    write_scope: over.write_scope ?? [],
    token_estimate: over.token_estimate ?? 0,
  });
  return item;
}

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = await freshDb();
});

describe("storage — backlog + approval gate", () => {
  it("inserts as draft and lists by state", async () => {
    await insertBacklogItem(adapter, { title: "a" });
    const drafts = await listBacklogByState(adapter, { state: "draft" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].readiness_state).toBe("draft");
  });

  it("promotes needs_review -> ready only with a dispatch body + agent (the gate)", async () => {
    const noBody = await insertBacklogItem(adapter, { title: "b", readiness_state: "needs_review" });
    const r1 = await promoteToReady(adapter, noBody.item_id, "chris");
    expect(r1.ok).toBe(false); // missing to_agent/dispatch_body

    const ready = await insertBacklogItem(adapter, {
      title: "c",
      readiness_state: "needs_review",
      to_agent: "roger",
      dispatch_body: "go",
    });
    const r2 = await promoteToReady(adapter, ready.item_id, "chris");
    expect(r2.ok).toBe(true);
    expect(r2.item?.readiness_state).toBe("ready");
    expect(r2.item?.approved_by).toBe("chris");
  });

  it("refuses to promote from a non-reviewable state", async () => {
    const done = await insertBacklogItem(adapter, {
      title: "d",
      readiness_state: "done",
      to_agent: "roger",
      dispatch_body: "go",
    });
    const r = await promoteToReady(adapter, done.item_id, "chris");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot promote from done/);
  });
});

describe("roadmap import", () => {
  it("parses track table rows into needs_review drafts (never ready)", () => {
    const md = [
      "## §4 tracks",
      "| Sub-track | What | Status |",
      "|---|---|---|",
      "| **T-CKPT.1** — approve/reject buttons | click APPROVE | NEEDS-CHRIS |",
      "| **T15.4** — Liz NORTH STAR console | console | LIVE |",
      "| prose line, no table | x | y |",
    ].join("\n");
    const { items, tracks } = parseRoadmapToBacklog(md, { source_ref: "roadmap.md" });
    expect(items.length).toBe(2);
    expect(items.every((i) => i.readiness_state === "needs_review")).toBe(true);
    expect(tracks).toContain("T-CKPT.1");
    const ns = items.find((i) => i.track === "T15.4");
    expect(ns?.is_north_star).toBe(true);
  });
});

describe("daemon — dry-run vs live", () => {
  it("dry-run computes would_dispatch and fires NOTHING; item stays ready", async () => {
    const item = await seedReady(adapter);
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: true } });
    await daemon.setMode("running");
    const r = await daemon.runTick();
    expect(fired).toHaveLength(0);
    expect(r.admitted).toHaveLength(1);
    expect(r.decisions.some((d) => d.action === "would_dispatch")).toBe(true);
    const after = await getBacklogItem(adapter, item.item_id);
    expect(after?.readiness_state).toBe("ready"); // untouched in dry-run
  });

  it("live fires the dispatch and flips the item to in_flight", async () => {
    const item = await seedReady(adapter);
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: false } });
    await daemon.setMode("running");
    const r = await daemon.runTick();
    expect(fired).toHaveLength(1);
    expect(r.admitted[0].dispatch_phid).toMatch(/^phid:disp-/);
    const after = await getBacklogItem(adapter, item.item_id);
    expect(after?.readiness_state).toBe("in_flight");
    expect(after?.last_dispatch_phid).toMatch(/^phid:disp-/);
    const decisions = await listRecentDecisions(adapter, {});
    expect(decisions.some((d) => d.action === "dispatched")).toBe(true);
  });

  it("T-ORCH P0: fills up to max_in_flight EVERY tick, even off a load-point", async () => {
    // now() is "2026-06-17T18:00:00Z" — deliberately NOT a cadence load-point.
    // Old behavior admitted only max_new_per_tick (1) between batches; continuous
    // admission fills the lane up to max_in_flight from the ready queue.
    for (let i = 0; i < 5; i++) await seedReady(adapter, { title: `w${i}`, write_scope: [`scope-${i}`] });
    const { daemon, fired } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4, max_new_per_tick: 1 },
    });
    await daemon.setMode("running");
    const r = await daemon.runTick();
    expect(fired).toHaveLength(4); // filled to max_in_flight in ONE off-load-point tick
    expect(r.admitted).toHaveLength(4);
  });

  it("halts (fires nothing) when not running", async () => {
    await seedReady(adapter);
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: false } });
    // default mode is paused
    const r = await daemon.runTick();
    expect(fired).toHaveLength(0);
    expect(r.halted).toMatch(/paused/);
  });

  it("kill switch halts before any admission", async () => {
    await seedReady(adapter);
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: false }, killSwitch: true });
    await daemon.setMode("running");
    const r = await daemon.runTick();
    expect(fired).toHaveLength(0);
    expect(r.halted).toMatch(/kill switch/);
  });
});

describe("daemon — guardrail alerts", () => {
  it("auto-pauses + alerts when the daily token ceiling is hit", async () => {
    await seedReady(adapter);
    const { daemon, alerts } = makeDaemon(adapter, {
      config: { dry_run: false, daily_token_ceiling: 1000 },
      readUsage: () => Promise.resolve(okUsage(1000)),
    });
    await daemon.setMode("running");
    const r = await daemon.runTick();
    expect(r.auto_paused?.reason).toMatch(/ceiling/);
    expect(alerts.some((a) => /AUTO-PAUSED/.test(a))).toBe(true);
    const state = await getOrchestrationState(adapter, "default");
    expect(state.mode).toBe("paused");
    expect(state.auto_paused).toBe(true);
  });

  it("fires a loud STALL alert after N zero-dispatch ticks with work waiting", async () => {
    // A ready item exists but every admission slot is consumed -> fires nothing.
    await seedReady(adapter);
    const { daemon, alerts } = makeDaemon(adapter, {
      config: { dry_run: false, stall_threshold_ticks: 2, max_in_flight: 0 },
    });
    await daemon.setMode("running");
    const r1 = await daemon.runTick();
    expect(r1.admitted).toHaveLength(0);
    expect(r1.stall_alert).toBe(false);
    const r2 = await daemon.runTick();
    expect(r2.zero_ticks).toBe(2);
    expect(r2.stall_alert).toBe(true);
    expect(alerts.some((a) => /STALL/.test(a))).toBe(true);
  });
});
