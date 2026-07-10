// Continuous Orchestration — storage + roadmap import + daemon integration.
// Backed by in-memory SQLite (same migration path as production).

import express, { type Express } from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  listHeldConfidenceReviewItems,
} from "../../src/continuous-orchestration/storage.js";
import { parseRoadmapToBacklog } from "../../src/continuous-orchestration/roadmap-import.js";
import { ContinuousOrchestrationDaemon, type PoolRouting } from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig, type ContinuousOrchestrationConfig } from "../../src/continuous-orchestration/config.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import { AUTO_READY_CONFIDENCE_THRESHOLD } from "../../src/continuous-orchestration/flesh-policy.js";
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
    pools?: PoolRouting;
    // RD-014: undefined (the default) means "no health resolver wired" —
    // matches every pre-RD-014 test in this file exactly (no gating at all).
    resolveAgentHealth?: (names: string[]) => Promise<Set<string>>;
    resolveAgentRuntimes?: (names: string[]) => Promise<Map<string, string>>;
    modelPolicyPath?: string;
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
    alert: async (m) => {
      alerts.push(m);
    },
    emitNews: async (event) => {
      newsEvents.push(event);
    },
    modelPolicyPath: over.modelPolicyPath,
    readModelPolicyDirectiveDrift: over.modelPolicyPath
      ? undefined
      : () => ({
          status: "match",
          policy_path: "test-model-policy.json",
          directive_targets: { anthropic: 0.5, openai: 0.5 },
          work_share_targets: { anthropic: 0.5, openai: 0.5 },
          diffs: [],
          message: null,
        }),
    pools: over.pools,
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
    token_estimate: over.token_estimate ?? 0,
    provider: over.provider ?? null,
    runtime: over.runtime ?? null,
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
      over.approved_by !== undefined ? over.approved_by : "maestra",
      over.approved_at !== undefined ? over.approved_at : "2026-07-07T00:00:00Z",
      over.flesh_status ?? "needs_chris_batch",
      over.flesh_confidence ?? 0.65,
      over.last_dispatch_phid ?? null,
      item.item_id,
    ],
  );
  return (await getBacklogItem(adapter, item.item_id))!;
}

function writeModelPolicy(seed: {
  directive: Record<string, number>;
  workShare: Record<string, number>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "model-policy-drift-"));
  const policyPath = join(dir, "model-policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify(
      {
        schema_version: 1,
        authorized_directive: { work_share: { targets: seed.directive } },
        work_share: { label: "test", targets: seed.workShare },
        default: { primary: { runtime: "codex" } },
      },
      null,
      2,
    ),
  );
  return policyPath;
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

function testPoolRouting(): PoolRouting {
  const pool = {
    pool_id: "backend",
    repo_root: "/tmp/id-agents",
    max_parallel: 2,
    members: ["substrate-orch-codex", "substrate-api-codex"],
  };
  return {
    poolForItem: (item) => (item.to_agent === "pool:backend" || item.track === "T-ORCH" ? { ...pool } : null),
    availableBuilders: (p, building) => p.members.filter((m) => !building.has(m)),
    allocateWorktree: async ({ agent, item }) => ({
      path: `/tmp/id-agents/.worktrees/${agent}-${item.item_id}`,
      branch: `build/${agent}-${item.item_id}`,
      lease_id: null,
    }),
  };
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

  it("repairs stale Claude metadata for approved Regina ready fuel without changing the logical owner", async () => {
    await seedAgent(adapter, "regina", "stopped", "claude-code-cli");
    const stale = await seedReady(adapter, {
      title: "regina-owned ready fuel with stale runtime",
      to_agent: "regina",
      provider: "anthropic",
      runtime: "claude-code-cli",
    });
    await markApproved(adapter, stale.item_id);
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: false, max_in_flight: 4 } });
    await daemon.setMode("running");

    const result = await daemon.runTick();
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(result.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        to_agent: "regina",
        from_provider: "anthropic",
        from_runtime: "claude-code-cli",
        to_provider: "openai",
        to_runtime: "codex",
        reason: "legacy_owner_lane_unavailable",
      }),
    ]);
    expect(fired[0]).toMatchObject({ to_agent: "regina", provider: "openai", runtime: "codex" });
    expect(repaired).toMatchObject({ to_agent: "regina", provider: "openai", runtime: "codex" });
  });

  it("repairs stale Claude metadata for approved Roger ready fuel without changing the logical owner", async () => {
    await seedAgent(adapter, "roger", "offline", "claude-code-cli");
    const stale = await seedReady(adapter, {
      title: "roger-owned ready fuel with stale runtime",
      to_agent: "roger",
      provider: "anthropic",
      runtime: "claude-code-cli",
    });
    await markApproved(adapter, stale.item_id);
    const { daemon, fired } = makeDaemon(adapter, { config: { dry_run: false, max_in_flight: 4 } });
    await daemon.setMode("running");

    const result = await daemon.runTick();
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(result.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        to_agent: "roger",
        to_provider: "openai",
        to_runtime: "codex",
        reason: "legacy_owner_lane_unavailable",
      }),
    ]);
    expect(fired[0]).toMatchObject({ to_agent: "roger", provider: "openai", runtime: "codex" });
    expect(repaired).toMatchObject({ to_agent: "roger", provider: "openai", runtime: "codex" });
  });

  it("repairs stale Claude metadata for explicit build-pool ready fuel before admission without changing the logical owner", async () => {
    await seedAgent(adapter, "substrate-orch-codex", "running", "codex");
    const stale = await seedReady(adapter, {
      title: "pool-owned backend ready fuel with stale runtime",
      track: "T-ORCH",
      to_agent: "pool:backend",
      provider: "anthropic",
      runtime: "claude-code-cli",
    });
    await markApproved(adapter, stale.item_id);
    const { daemon } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      pools: testPoolRouting(),
      resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
    });
    await daemon.setMode("running");

    const explanation = await daemon.explainReadyAdmission();
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(explanation.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        to_agent: "pool:backend",
        to_provider: "openai",
        to_runtime: "codex",
        reason: "explicit_pool_owner_lane",
      }),
    ]);
    expect(explanation.admissible).toEqual([
      expect.objectContaining({ item_id: stale.item_id, to_agent: "substrate-orch-codex" }),
    ]);
    expect(repaired).toMatchObject({ to_agent: "pool:backend", provider: "openai", runtime: "codex" });
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

  it("auto-promotes approved fleshed build fuel to restore the ready floor with duplicate gate evidence", async () => {
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
        auto_promote_max_per_tick: 1,
      },
    });
    await daemon.setMode("running");

    const r = await daemon.runTick();

    expect(fired).toHaveLength(0);
    expect(r.auto_promote?.promoted).toBe(3);
    expect(r.auto_promote?.skipped_items).toEqual([
      expect.objectContaining({
        item_id: dup.item_id,
        reasons: expect.arrayContaining([expect.stringContaining("already dispatched once")]),
      }),
    ]);
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
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 12,
      auto_promote_min_lanes: 1,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      floor: 12,
      below_floor: true,
      candidates_considered: 1,
      promoted_count: 0,
      skipped_count: 1,
    });
    expect(res.body.auto_promote_health.skipped_items).toEqual([
      expect.objectContaining({
        item_id: risky.item_id,
        reasons: expect.arrayContaining([expect.stringContaining("not auto-promotable")]),
      }),
    ]);
    expect(res.body.auto_promote_health.top_skip_reasons[0]).toEqual(
      expect.objectContaining({ reason: expect.stringContaining("not auto-promotable"), count: 1 }),
    );
  });

  it("status groups below-floor auto-promote blockers and recommends the next move", async () => {
    for (let i = 0; i < 8; i++) {
      await seedReady(adapter, { title: `ready ${i}`, write_scope: [`repo/ready-${i}`] });
    }
    await seedApprovedReview(adapter, {
      title: "already dispatched retry",
      write_scope: ["repo/already"],
      last_dispatch_phid: "phid:disp-old",
    });
    await seedApprovedReview(adapter, {
      title: "review held external",
      risk_class: "external",
      write_scope: ["repo/risk"],
    });
    await seedApprovedReview(adapter, {
      title: "dependency blocked",
      write_scope: ["repo/deps"],
      dependencies: ["coitem_upstream"],
    });
    await seedApprovedReview(adapter, {
      title: "low confidence",
      approved_by: null,
      flesh_status: "fleshed",
      flesh_confidence: 0.55,
      write_scope: ["repo/confidence"],
    });
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 12,
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
      next_action: {
        code: "manual_promote_or_close_already_dispatched",
      },
    });
    expect(res.body.auto_promote_health.blocker_class_counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: "already_dispatched", count: 1 }),
        expect.objectContaining({ class: "review_held_risk", count: 1 }),
        expect.objectContaining({ class: "blocked_dependencies", count: 1 }),
        expect.objectContaining({ class: "confidence_threshold", count: 1 }),
      ]),
    );
    expect(res.body.auto_promote_health.summary).toMatch(/blocker classes:/);
    expect(res.body.auto_promote_health.summary).toMatch(/already_dispatched=1/);
    expect(res.body.auto_promote_health.summary).toMatch(/next: manually \/promote/);
  });

  it("surfaces below-threshold flesh rows as held confidence review, separate from plain needs_review", async () => {
    await seedApprovedReview(adapter, {
      title: "below confidence held one",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: 0.65,
      write_scope: ["repo/low-a"],
    });
    await seedApprovedReview(adapter, {
      title: "below confidence held two",
      approved_by: null,
      approved_at: null,
      flesh_status: "needs_chris_batch",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD - 0.01,
      write_scope: ["repo/low-b"],
    });
    await seedApprovedReview(adapter, {
      title: "above confidence plain review",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD,
      write_scope: ["repo/high"],
    });
    await seedApprovedReview(adapter, {
      title: "approved low confidence override",
      approved_by: "maestra",
      approved_at: "2026-07-08T12:00:00Z",
      flesh_status: "needs_chris_batch",
      flesh_confidence: 0.65,
      write_scope: ["repo/approved-low"],
    });
    await insertBacklogItem(adapter, {
      title: "plain unfleshed review",
      readiness_state: "needs_review",
      risk_class: "build",
      write_scope: ["repo/plain"],
    });
    const { app } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
    });

    const status = await callApp(app, "/orchestration/status");
    const held = await callApp(app, "/orchestration/flesh/held-confidence-review");

    expect(status.status).toBe(200);
    expect(status.body.counts.held_confidence_review).toBe(2);
    expect(status.body.counts.needs_review).toBe(3);
    expect(status.body.flesh.auto_promote.confidence_threshold).toBe(AUTO_READY_CONFIDENCE_THRESHOLD);
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({
      ok: true,
      confidence_threshold: AUTO_READY_CONFIDENCE_THRESHOLD,
      count: 2,
    });
    expect(held.body.items.map((item: BacklogItem) => item.title)).toEqual([
      "below confidence held one",
      "below confidence held two",
    ]);

    const direct = await listHeldConfidenceReviewItems(adapter, {
      confidence_threshold: AUTO_READY_CONFIDENCE_THRESHOLD,
    });
    expect(direct.map((item) => item.title)).toEqual(held.body.items.map((item: BacklogItem) => item.title));
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
  it("fires a drift alert when model-policy work_share diverges from the authorized directive", async () => {
    const modelPolicyPath = writeModelPolicy({
      directive: { anthropic: 0.5, openai: 0.5, cursor: 0 },
      workShare: { anthropic: 0.05, openai: 0.95, cursor: 0 },
    });
    const { daemon, alerts, newsEvents } = makeDaemon(adapter, { modelPolicyPath });

    const r = await daemon.runTick();

    expect(r.model_policy_drift.status).toBe("drift");
    expect(r.decisions.some((d) => d.action === "model_policy_drift_alert")).toBe(true);
    expect(alerts.some((a) => /model-policy drift/.test(a))).toBe(true);
    expect(newsEvents).toEqual([
      expect.objectContaining({
        type: "model_policy.drift",
        data: expect.objectContaining({ status: "drift", policy_path: modelPolicyPath }),
      }),
    ]);
  });

  it("does not alert when model-policy work_share matches the authorized directive", async () => {
    const modelPolicyPath = writeModelPolicy({
      directive: { anthropic: 0.5, openai: 0.5, cursor: 0 },
      workShare: { anthropic: 0.5, openai: 0.5, cursor: 0 },
    });
    const { daemon, alerts, newsEvents } = makeDaemon(adapter, { modelPolicyPath });

    const r = await daemon.runTick();

    expect(r.model_policy_drift.status).toBe("match");
    expect(r.decisions.some((d) => d.action === "model_policy_drift_alert")).toBe(false);
    expect(alerts.some((a) => /model-policy drift/.test(a))).toBe(false);
    expect(newsEvents).toEqual([]);
  });

  it("warns but does not auto-pause when the configured token reference is hit", async () => {
    await seedReady(adapter);
    const { daemon, alerts } = makeDaemon(adapter, {
      config: { dry_run: false, daily_token_ceiling: 1000 },
      readUsage: () => Promise.resolve(okUsage(1000)),
    });
    await daemon.setMode("running");
    const r = await daemon.runTick();
    expect(r.auto_paused).toBeNull();
    expect(alerts.some((a) => /AUTO-PAUSED/.test(a))).toBe(false);
    const state = await getOrchestrationState(adapter, "default");
    expect(state.mode).toBe("running");
    expect(state.auto_paused).toBe(false);
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
