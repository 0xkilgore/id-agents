// Continuous Orchestration — storage + roadmap import + daemon integration.
// Backed by in-memory SQLite (same migration path as production).

import express, { type Express } from "express";
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
  getAgentRuntimeMap,
  getHealthyAgentNames,
} from "../../src/continuous-orchestration/storage.js";
import { parseRoadmapToBacklog } from "../../src/continuous-orchestration/roadmap-import.js";
import { ContinuousOrchestrationDaemon, type PoolRouting } from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig, type ContinuousOrchestrationConfig } from "../../src/continuous-orchestration/config.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
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
    newsEvents?: Array<{ type: string; message: string; data?: Record<string, unknown> }>;
    killSwitch?: boolean;
    // RD-014: undefined (the default) means "no health resolver wired" —
    // matches every pre-RD-014 test in this file exactly (no gating at all).
    resolveAgentHealth?: (names: string[]) => Promise<Set<string>>;
    resolveAgentRuntimes?: (names: string[]) => Promise<Map<string, string>>;
    pools?: PoolRouting;
  } = {},
) {
  const fired: BacklogItem[] = [];
  const alerts = over.alerts ?? [];
  const newsEvents = over.newsEvents ?? [];
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
    resolveAgentHealth: over.resolveAgentHealth,
    resolveAgentRuntimes: over.resolveAgentRuntimes,
    pools: over.pools,
    alert: async (m) => {
      alerts.push(m);
    },
    emitNews: async (event) => {
      newsEvents.push(event);
    },
    killSwitchActive: () => over.killSwitch ?? false,
    now: () => Date.parse("2026-06-17T18:00:00Z"), // not a load-point
  });
  return { daemon, fired, alerts, newsEvents };
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
    dependencies: over.dependencies ?? [],
    token_estimate: over.token_estimate ?? 0,
    provider: over.provider ?? null,
    runtime: over.runtime ?? null,
    source_refs: over.source_refs ?? [],
  });
  return item;
}

async function markApproved(adapter: SqliteAdapter, item_id: string) {
  await adapter.query(
    `UPDATE orchestration_backlog_item
       SET approved_by = $1, approved_at = $2
     WHERE item_id = $3`,
    ["maestra", "2026-07-08T12:00:00Z", item_id],
  );
  return (await getBacklogItem(adapter, item_id))!;
}

async function seedApprovedReview(adapter: SqliteAdapter, over: Partial<BacklogItem> = {}) {
  const item = await insertBacklogItem(adapter, {
    title: over.title ?? "approved build fuel",
    track: over.track ?? "T-ORCH",
    to_agent: over.to_agent ?? "roger",
    dispatch_body: over.dispatch_body ?? "[project: kapelle][T-ORCH][BUILD] roger: do work. Verify with tests. Promote on green.",
    readiness_state: "needs_review",
    risk_class: over.risk_class ?? "build",
    priority: over.priority ?? 5,
    write_scope: over.write_scope ?? ["repo/a"],
    dependencies: over.dependencies ?? [],
    token_estimate: over.token_estimate ?? 1000,
    provider: over.provider ?? "openai",
    runtime: over.runtime ?? "codex",
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
      over.approved_by ?? "maestra",
      over.approved_at ?? "2026-07-07T00:00:00Z",
      over.flesh_status ?? "needs_chris_batch",
      over.flesh_confidence ?? 0.65,
      over.last_dispatch_phid ?? null,
      item.item_id,
    ],
  );
  return (await getBacklogItem(adapter, item.item_id))!;
}

async function callApp(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const text = await r.text();
        server.close(() => resolve({ status: r.status, body: JSON.parse(text) }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function mountStatusApp(
  adapter: SqliteAdapter,
  config: Partial<ContinuousOrchestrationConfig> = {},
  deps: Parameters<typeof makeDaemon>[1] = {},
): { app: Express; daemon: ContinuousOrchestrationDaemon } {
  const fullConfig = { ...defaultConfig(), ...config };
  const { daemon } = makeDaemon(adapter, { ...deps, config: fullConfig });
  const app = express();
  app.use(express.json());
  mountContinuousOrchestrationRoutes(app, {
    daemon,
    adapter,
    config: fullConfig,
    teamId: "default",
  });
  return { app, daemon };
}

/** Minimal valid `agents` row — RD-014 health-gate tests only care about name+status. */
async function seedAgent(adapter: SqliteAdapter, name: string, status: string, runtime = "claude-code-cli") {
  await adapter.query(
    `INSERT OR IGNORE INTO teams (id, name) VALUES ($1, $2)`,
    ["team-uuid-9999", "default"],
  );
  await adapter.query(
    `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`agent_${name}`, "team-uuid-9999", name, "claude", "claude-fable-5", 0, status, Date.now(), runtime],
  );
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

  it("admits a ready build item with no blockers when daemon in_flight is below max_in_flight", async () => {
    const item = await seedReady(adapter, { title: "admittable build", write_scope: ["free-lane"] });
    const { daemon, fired } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      inFlight: 3,
    });
    await daemon.setMode("running");

    const r = await daemon.runTick();

    expect(r.admitted.map((a) => a.item_id)).toEqual([item.item_id]);
    expect(fired.map((i) => i.item_id)).toEqual([item.item_id]);
  });

  it("explains intentionally non-admittable ready rows with typed reason codes", async () => {
    const item = await seedReady(adapter, { title: "busy lane build", write_scope: ["repo/busy"] });
    const { daemon } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      inFlight: 1,
      activeScopes: new Set(["repo/busy"]),
    });
    await daemon.setMode("running");

    const explanation = await daemon.explainReadyAdmission();

    expect(explanation.candidates).toBe(1);
    expect(explanation.admissible).toHaveLength(0);
    expect(explanation.non_admitted).toEqual([
      expect.objectContaining({
        item_id: item.item_id,
        action: "skipped",
        code: "single_writer_lane_busy",
      }),
    ]);
  });

  it("exposes provider/runtime non-admission diagnostics through ready admission explanation", async () => {
    await seedAgent(adapter, "substrate-orch-codex", "running", "codex");
    const item = await seedReady(adapter, {
      title: "wrong runtime lane",
      to_agent: "substrate-orch-codex",
      provider: "anthropic",
      runtime: "claude-code-cli",
    });
    const { daemon } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
    });
    await daemon.setMode("running");

    const explanation = await daemon.explainReadyAdmission();

    expect(explanation.admissible).toHaveLength(0);
    expect(explanation.non_admitted).toEqual([
      expect.objectContaining({
        item_id: item.item_id,
        action: "held",
        code: "provider_runtime_mismatch",
        metadata: expect.objectContaining({
          class: "provider_runtime",
          target_runtime: "codex",
        }),
      }),
    ]);
  });

  it("status exposes raw ready versus admissible now with block-reason breakdown", async () => {
    const admissible = await seedReady(adapter, { title: "admissible now", write_scope: ["repo/free"] });
    await seedReady(adapter, { title: "blocked dependency", dependencies: ["coitem_missing"], write_scope: ["repo/dep"] });
    await seedReady(adapter, { title: "risk approval", risk_class: "external", write_scope: ["repo/risk"] });
    await seedReady(adapter, { title: "single writer busy", write_scope: ["repo/busy"] });
    await seedReady(adapter, { title: "pool full candidate", write_scope: ["repo/pool-full"] });
    await seedReady(adapter, { title: "no free builder candidate", write_scope: ["repo/no-builder"] });
    await insertBacklogItem(adapter, {
      title: "pool full active",
      to_agent: "builder-a",
      dispatch_body: "already running",
      readiness_state: "in_flight",
      risk_class: "build",
      write_scope: ["repo/pool-full-active"],
    });
    const poolForItem: PoolRouting["poolForItem"] = (item) => {
      if (item.title.includes("pool full")) {
        return { pool_id: "pool-full", repo_root: "/repo/full", max_parallel: 1, members: ["builder-a"] };
      }
      if (item.title.includes("no free builder")) {
        return { pool_id: "no-builder", repo_root: "/repo/no-builder", max_parallel: 1, members: ["builder-b"] };
      }
      return null;
    };
    const { app, daemon } = mountStatusApp(
      adapter,
      { dry_run: true, max_in_flight: 10 },
      {
        activeScopes: new Set(["repo/busy"]),
        pools: {
          poolForItem,
          availableBuilders: (pool) => (pool.pool_id === "no-builder" ? [] : pool.members),
          allocateWorktree: async ({ agent, item }) => ({ path: `/tmp/${item.item_id}`, branch: item.item_id, lease_id: agent }),
        },
      },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");
    const breakdown = res.body.counts.ready_blocked_by_reason;
    const blockedTotal = Object.values(breakdown).reduce((sum: number, n) => sum + Number(n), 0);

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(6);
    expect(res.body.counts.admissible_now).toBe(1);
    expect(res.body.ready_admission.admissible_now).toBe(1);
    expect(res.body.ready_admission.admissible).toEqual([
      expect.objectContaining({ item_id: admissible.item_id }),
    ]);
    expect(breakdown).toMatchObject({
      blocked_dependency: 1,
      risk_requires_approval: 1,
      pool_capacity_full: 1,
      single_writer_lane_busy: 1,
      no_free_pool_builder: 1,
    });
    expect(blockedTotal).toBe(res.body.counts.ready - res.body.counts.admissible_now);
  });

  it("status reports capacity saturation, not low fuel, when raw ready is above floor but in-flight slots are full", async () => {
    for (let i = 0; i < 10; i++) {
      await seedReady(adapter, { title: `capacity-held ready ${i}`, write_scope: [`repo/capacity-${i}`] });
    }
    const { app, daemon } = mountStatusApp(
      adapter,
      { dry_run: true, min_ready_fuel: 8, max_in_flight: 4 },
      { inFlight: 4 },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(10);
    expect(res.body.counts.admissible_now).toBe(0);
    expect(res.body.counts.ready_blocked_by_reason).toMatchObject({ no_in_flight_slots: 10 });
    expect(res.body.ready_admission.stale_ready_floor).toMatchObject({
      stale: true,
      status: "capacity_saturated",
      ready: 10,
      admissible: 0,
      min_ready_fuel: 8,
    });
    expect(res.body.ready_admission.stale_ready_floor.summary).toMatch(/capacity saturated/);
    expect(res.body.ready_admission.stale_ready_floor.next_action).toMatch(/Do not refuel/);
    expect(res.body.ready_admission.stale_ready_floor.summary).not.toMatch(/low ready fuel/);
  });

  it("status reports raw ready as unusable when all ready rows are blocked by write-scope locks", async () => {
    for (let i = 0; i < 11; i++) {
      await seedReady(adapter, { title: `locked ready ${i}`, write_scope: ["repo/locked"] });
    }
    const { app, daemon } = mountStatusApp(
      adapter,
      { dry_run: true, min_ready_fuel: 8, max_in_flight: 20 },
      { activeScopes: new Set(["repo/locked"]) },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({
      ready: 11,
      raw_ready: 11,
      useful_ready: 0,
      admissible_now: 0,
      ready_blocked_by_reason: { single_writer_lane_busy: 11 },
    });
    expect(res.body.counts.top_blocking_lanes[0]).toMatchObject({
      lane: "repo/locked",
      code: "single_writer_lane_busy",
      count: 11,
    });
    expect(res.body.ready_admission).toMatchObject({
      raw_ready: 11,
      useful_ready: 0,
      admissible_now: 0,
    });
    expect(res.body.ready_admission.stale_ready_floor.next_action).toMatch(/widen\/split|locks to clear/);
    expect(res.body.ready_admission.stale_ready_floor.next_action).not.toMatch(/author filler/i);
  });

  it("status reports low fuel only when raw ready itself is below the floor", async () => {
    for (let i = 0; i < 3; i++) {
      await seedReady(adapter, { title: `low fuel ready ${i}`, write_scope: [`repo/low-${i}`] });
    }
    const { app, daemon } = mountStatusApp(adapter, { dry_run: true, min_ready_fuel: 8, max_in_flight: 8 });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(3);
    expect(res.body.counts.admissible_now).toBe(3);
    expect(res.body.ready_admission.stale_ready_floor).toMatchObject({
      stale: false,
      status: "low_ready_fuel",
      ready: 3,
      admissible: 3,
      min_ready_fuel: 8,
    });
    expect(res.body.ready_admission.stale_ready_floor.next_action).toMatch(/Refuel or promote/);
  });

  it("repairs stale Claude metadata for approved Roger Codex ready fuel before admission and logs it", async () => {
    await seedAgent(adapter, "roger", "running", "codex");
    const stale = await seedReady(adapter, {
      title: "roger codex ready fuel with stale runtime",
      to_agent: "roger",
      provider: "anthropic",
      runtime: "claude-code-cli",
    });
    await markApproved(adapter, stale.item_id);
    const { daemon, fired } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
    });
    await daemon.setMode("running");

    const result = await daemon.runTick();
    const repaired = await getBacklogItem(adapter, stale.item_id);
    const decisions = await listRecentDecisions(adapter, {});

    expect(result.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        to_agent: "roger",
        from_provider: "anthropic",
        from_runtime: "claude-code-cli",
        to_provider: "openai",
        to_runtime: "codex",
      }),
    ]);
    expect(result.admitted.map((a) => a.item_id)).toEqual([stale.item_id]);
    expect(fired[0]).toMatchObject({ provider: "openai", runtime: "codex" });
    expect(repaired).toMatchObject({ provider: "openai", runtime: "codex", readiness_state: "in_flight" });
    expect(decisions.some((d) => d.action === "ready_metadata_repair" && d.item_id === stale.item_id)).toBe(true);
  });

  it("repairs stale Claude metadata for approved frontend Codex ready fuel in ready admission status", async () => {
    await seedAgent(adapter, "frontend-ui-codex", "running", "codex");
    const stale = await seedReady(adapter, {
      title: "frontend lane ready fuel with stale runtime",
      to_agent: "frontend-ui-codex",
      provider: "anthropic",
      runtime: "claude-code-cli",
    });
    await markApproved(adapter, stale.item_id);
    const { daemon } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
    });
    await daemon.setMode("running");

    const explanation = await daemon.explainReadyAdmission();
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(explanation.admissible).toEqual([
      expect.objectContaining({ item_id: stale.item_id, to_agent: "frontend-ui-codex" }),
    ]);
    expect(explanation.non_admitted).toHaveLength(0);
    expect(repaired).toMatchObject({ provider: "openai", runtime: "codex", readiness_state: "ready" });
  });

  it("repairs stale Codex metadata for approved CTO Claude artifact ready fuel in status admission", async () => {
    await seedAgent(adapter, "cto", "running", "claude-code-cli");
    const stale = await seedReady(adapter, {
      title: "CTO artifact-only ready fuel with stale codex runtime",
      to_agent: "cto",
      provider: "openai",
      runtime: "codex",
      source_refs: ["cto/output/2026-07-12-ready-floor-blocker.md"],
    });
    await markApproved(adapter, stale.item_id);
    const { app, daemon } = mountStatusApp(
      adapter,
      { dry_run: true, max_in_flight: 4 },
      { resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names) },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        to_agent: "cto",
        from_provider: "openai",
        from_runtime: "codex",
        to_provider: "anthropic",
        to_runtime: "claude-code-cli",
      }),
    ]);
    expect(res.body.ready_admission.admissible).toEqual([
      expect.objectContaining({ item_id: stale.item_id, to_agent: "cto" }),
    ]);
    expect(res.body.ready_admission.ready_runtime_repairs).toEqual([]);
    expect(res.body.ready_admission.non_admitted).toHaveLength(0);
    expect(repaired).toMatchObject({ provider: "anthropic", runtime: "claude-code-cli", readiness_state: "ready" });
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

  it("auto-promotes approved fleshed build fuel to restore the ready floor and permits approved retry fuel", async () => {
    await seedApprovedReview(adapter);
    await seedApprovedReview(adapter, { write_scope: ["repo/b"] });
    await seedApprovedReview(adapter, { write_scope: ["repo/c"] });
    const dup = await seedApprovedReview(adapter, {
      write_scope: ["repo/d"],
      last_dispatch_phid: "phid:disp-already-fired",
    });

    const { daemon, fired } = makeDaemon(adapter, {
      config: {
        dry_run: false,
        max_in_flight: 0,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 3,
        auto_promote_min_lanes: 3,
        auto_promote_max_per_tick: 4,
      },
    });
    await daemon.setMode("running");

    const r = await daemon.runTick();

    expect(fired).toHaveLength(0);
    expect(r.auto_promote?.promoted).toBe(3);
    expect(r.auto_promote?.skipped_items).not.toEqual(expect.arrayContaining([expect.objectContaining({ item_id: dup.item_id })]));
    const ready = await listBacklogByState(adapter, { state: "ready" });
    expect(ready).toHaveLength(3);
    expect(new Set(ready.map((i) => i.write_scope[0])).size).toBe(3);
  });

  it("status explains below-floor auto-promote with no candidates", async () => {
    for (let i = 0; i < 8; i++) {
      await seedReady(adapter, { title: `ready ${i}`, write_scope: [`repo/ready-${i}`] });
    }
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 12,
      max_in_flight: 12,
      auto_promote_min_lanes: 1,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(8);
    expect(res.body.auto_promote_health).toMatchObject({
      min_ready_fuel: 8,
      floor: 12,
      below_floor: true,
      triggered: true,
      candidates_considered: 0,
      promoted_count: 0,
      skipped_count: 0,
    });
    expect(res.body.auto_promote_health.summary).toMatch(/ready=8 floor=12/);
    expect(res.body.auto_promote_health.summary).toMatch(/no needs_review candidates/);
  });

  it("status explains below-floor auto-promote blocked by safety risk", async () => {
    for (let i = 0; i < 8; i++) {
      await seedReady(adapter, { title: `ready ${i}`, write_scope: [`repo/ready-${i}`] });
    }
    const risky = await seedApprovedReview(adapter, {
      title: "blocked destructive candidate",
      risk_class: "destructive",
      write_scope: ["repo/risky"],
    });
    const alreadyDispatched = await seedApprovedReview(adapter, {
      title: "blocked already dispatched candidate",
      write_scope: ["repo/already-dispatched"],
      last_dispatch_phid: "phid:disp-already-dispatched",
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET approved_by = NULL,
              approved_at = NULL,
              auto_ready_approved_at = NULL,
              flesh_confidence = 0.95
        WHERE item_id = $1`,
      [alreadyDispatched.item_id],
    );
    const blockedDependency = await seedApprovedReview(adapter, {
      title: "blocked dependency candidate",
      write_scope: ["repo/dependency"],
      dependencies: ["dep-123"],
    });
    const lowConfidence = await seedApprovedReview(adapter, {
      title: "blocked low confidence candidate",
      write_scope: ["repo/low-confidence"],
      flesh_status: "fleshed",
      flesh_confidence: 0.4,
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET approved_by = NULL,
              approved_at = NULL,
              auto_ready_approved_at = NULL
        WHERE item_id = $1`,
      [lowConfidence.item_id],
    );
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 12,
      max_in_flight: 12,
      auto_promote_min_lanes: 1,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      floor: 12,
      below_floor: true,
      candidates_considered: 4,
      promoted_count: 0,
      skipped_count: 4,
      blocker_counts: {
        already_dispatched: 1,
        review_held_risk: 1,
        blocked_dependencies: 1,
        confidence_threshold: 1,
      },
    });
    expect(res.body.auto_promote_health.blocker_classes).toEqual(
      expect.arrayContaining([
        { blocker_class: "already_dispatched", count: 1 },
        { blocker_class: "review_held_risk", count: 1 },
        { blocker_class: "blocked_dependencies", count: 1 },
        { blocker_class: "confidence_threshold", count: 1 },
      ]),
    );
    expect(res.body.auto_promote_health.next_action).toMatch(/already-dispatched|review-held|dependency|confidence|flesh/);
    expect(res.body.auto_promote_health.summary).toMatch(/promoted 0 of 4; blockers:/);
    expect(res.body.auto_promote_health.summary).toMatch(/next:/);
    expect(res.body.auto_promote_health.skipped_items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        item_id: risky.item_id,
        reasons: expect.arrayContaining([expect.stringContaining("not auto-promotable")]),
      }),
      expect.objectContaining({
        item_id: alreadyDispatched.item_id,
        reasons: expect.arrayContaining([expect.stringContaining("already dispatched once")]),
      }),
      expect.objectContaining({
        item_id: blockedDependency.item_id,
        reasons: expect.arrayContaining([expect.stringContaining("blocked dependencies")]),
      }),
      expect.objectContaining({
        item_id: lowConfidence.item_id,
        reasons: expect.arrayContaining([expect.stringContaining("confidence 0.40 <")]),
      }),
    ]));
    expect(res.body.auto_promote_health.top_skip_reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining("not auto-promotable"), count: 1 }),
      ]),
    );
  });

  it("status includes provider/runtime repair interaction before admission diagnostics", async () => {
    await seedAgent(adapter, "roger", "running", "codex");
    const stale = await seedReady(adapter, {
      title: "approved stale runtime ready fuel",
      to_agent: "roger",
      provider: "anthropic",
      runtime: "claude-code-cli",
      write_scope: ["repo/stale"],
    });
    await markApproved(adapter, stale.item_id);
    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 12,
        max_in_flight: 12,
      },
      { resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names) },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        from_provider: "anthropic",
        from_runtime: "claude-code-cli",
        to_provider: "openai",
        to_runtime: "codex",
      }),
    ]);
    expect(res.body.ready_admission.admissible).toEqual([
      expect.objectContaining({ item_id: stale.item_id, to_agent: "roger" }),
    ]);
    expect(repaired).toMatchObject({ provider: "openai", runtime: "codex", readiness_state: "ready" });
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

  it("emits fleet.blockage and runs flesh/run when zero-admit stall has low ready fuel", async () => {
    for (let i = 0; i < 3; i++) {
      await seedReady(adapter, { title: `ready ${i}`, write_scope: [`ready-${i}`] });
    }
    await insertBacklogItem(adapter, {
      title: "T-ORCH.9 — add a read-only watchdog status route",
      track: "T-ORCH",
      readiness_state: "needs_review",
      source_refs: ["roadmap.md"],
    });

    const { daemon, newsEvents } = makeDaemon(adapter, {
      config: {
        dry_run: false,
        stall_threshold_ticks: 2,
        min_ready_fuel: 8,
        max_in_flight: 0,
        max_flesh_per_tick: 5,
      },
    });
    await daemon.setMode("running");

    const r1 = await daemon.runTick();
    expect(r1.stall_alert).toBe(false);
    expect(r1.refuel).toBeNull();

    const r2 = await daemon.runTick();
    expect(r2.stall_alert).toBe(true);
    expect(newsEvents).toHaveLength(1);
    expect(newsEvents[0].type).toBe("fleet.blockage");
    expect(newsEvents[0].data).toMatchObject({ zero_ticks: 2, ready: 3, min_ready_fuel: 8 });
    expect(r2.refuel?.considered).toBe(1);
    expect(r2.refuel?.auto_ready).toBe(1);
    expect(r2.decisions.some((d) => d.action === "fleet_blockage")).toBe(true);
    expect(r2.decisions.some((d) => d.action === "refuel" && d.metadata?.trigger === "zero_admit_stall_watchdog")).toBe(true);

    const readyAfter = await listBacklogByState(adapter, { state: "ready" });
    expect(readyAfter).toHaveLength(4);
  });
});

// RD-014: admission previously fired to a lane with no live check the target
// runtime was actually up — root cause of the pending-lane cascade (+149
// failed dispatches in one overnight wave per the routing audit).
describe("RD-014 — admission health gate (real getHealthyAgentNames against the agents table)", () => {
  it("getHealthyAgentNames returns only running, non-deleted agents by name (no team filter)", async () => {
    await seedAgent(adapter, "roger", "running");
    await seedAgent(adapter, "gaudi", "pending");
    await seedAgent(adapter, "hopper", "stopped");
    const healthy = await getHealthyAgentNames(adapter, ["roger", "gaudi", "hopper", "unknown-agent"]);
    expect(healthy).toEqual(new Set(["roger"]));
  });

  it("a running agent that flips to pending MID-TICK is excluded from the very next tick's admission", async () => {
    await seedAgent(adapter, "roger", "running");
    const first = await seedReady(adapter, { title: "first", to_agent: "roger", write_scope: ["lane-1"] });

    const { daemon, fired } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 5 },
      resolveAgentHealth: (names) => getHealthyAgentNames(adapter, names),
    });
    await daemon.setMode("running");

    // Tick 1: roger is running — admits normally.
    const t1 = await daemon.runTick();
    expect(fired.map((i) => i.item_id)).toContain(first.item_id);
    expect((await getBacklogItem(adapter, first.item_id))!.readiness_state).toBe("in_flight");

    // roger flips to pending mid-tick (e.g. a restart/redeploy in progress).
    await adapter.query(`UPDATE agents SET status = 'pending' WHERE name = 'roger'`);
    const second = await seedReady(adapter, { title: "second", to_agent: "roger", write_scope: ["lane-2"] });

    // Tick 2: same daemon, same target agent — now held, not fired.
    const t2 = await daemon.runTick();
    expect(fired.map((i) => i.item_id)).not.toContain(second.item_id);
    expect((await getBacklogItem(adapter, second.item_id))!.readiness_state).toBe("ready");
    expect(
      t2.decisions.some((d) => d.item_id === second.item_id && /not healthy\/online/.test(d.reason)),
    ).toBe(true);
  });

  it("falls back to no gating when resolveAgentHealth is not wired (legacy/degraded default)", async () => {
    await seedReady(adapter, { title: "no health resolver wired", to_agent: "nobody-registered-this-agent" });
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: false, max_in_flight: 5 } }); // no resolveAgentHealth
    await daemon.setMode("running");
    await daemon.runTick();
    expect(fired).toHaveLength(1);
  });
});
