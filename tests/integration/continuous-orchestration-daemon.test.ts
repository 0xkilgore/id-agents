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
import { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
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
      over.approved_by === undefined ? "maestra" : over.approved_by,
      over.approved_at === undefined ? "2026-07-07T00:00:00Z" : over.approved_at,
      over.flesh_status ?? "needs_chris_batch",
      over.flesh_confidence ?? 0.65,
      over.last_dispatch_phid ?? null,
      item.item_id,
    ],
  );
  return (await getBacklogItem(adapter, item.item_id))!;
}

async function callApp(app: Express, path: string): Promise<{ status: number; body: any }> {
  return callAppRequest(app, "GET", path);
}

async function callAppRequest(
  app: Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: method === "POST" ? { "content-type": "application/json" } : undefined,
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        });
        const text = await r.text();
        server.close(() => resolve({ status: r.status, body: JSON.parse(text) }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

async function seedDispatch(
  adapter: SqliteAdapter,
  over: { dispatch_phid: string; status: string; artifact_path?: string | null; recovery_status?: string | null },
) {
  const now = "2026-07-08T12:00:00Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, completed_at, updated_at,
        result_json, artifact_path, recovery_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      over.dispatch_phid,
      "team-uuid-9999",
      `q_${over.dispatch_phid}`,
      "roger",
      "co",
      "manager",
      "subject",
      "body",
      "openai",
      "codex",
      over.status,
      now,
      now,
      now,
      over.artifact_path ? JSON.stringify({ artifact_path: over.artifact_path }) : null,
      over.artifact_path ?? null,
      over.recovery_status ?? "none",
    ],
  );
}

async function markReadyAlreadyDispatched(
  adapter: SqliteAdapter,
  itemId: string,
  phid: string,
  opts: { retry_safe?: boolean } = {},
) {
  await adapter.query(
    `UPDATE orchestration_backlog_item
        SET last_dispatch_phid = $1,
            retry_safe = $2,
            updated_at = $3
      WHERE item_id = $4`,
    [phid, opts.retry_safe ? 1 : 0, "2026-07-08T12:01:00Z", itemId],
  );
  return (await getBacklogItem(adapter, itemId))!;
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
    expect(res.body.feedback_outbox_retry_drain).toEqual({
      pending: 0,
      retryable: 0,
      "retry-succeeded": 0,
      "hard-failed": 0,
      disabled: 0,
      "not-recorded": 0,
    });
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

  it("status reports one-lane below-floor ready-lane diversity health", async () => {
    await seedReady(adapter, { title: "ready lane a", write_scope: ["repo/a"] });
    await seedApprovedReview(adapter, {
      title: "candidate lane b",
      write_scope: ["repo/b"],
    });
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 2,
      auto_promote_min_lanes: 2,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      ready_count: 1,
      floor: 2,
      min_ready_lanes: 2,
      below_floor: true,
      below_lanes: true,
      triggered: true,
      candidates_considered: 1,
      promoted_count: 1,
      skipped_count: 0,
      blocker_class_counts: [],
      lanes: {
        build_ready: 1,
        build_ready_lanes: 1,
        ready_lane_keys: ["repo/a"],
        candidate_lane_keys: ["repo/b"],
      },
    });
    expect(res.body.auto_promote_health.candidates).toEqual([
      expect.objectContaining({ title: "candidate lane b", lane: "repo/b", risk_class: "build" }),
    ]);
    expect(res.body.auto_promote_health.summary).toMatch(/ready=1 floor=2, lanes=1\/2/);
    expect(res.body.auto_promote_health.summary).toMatch(/would promote 1/);
  });

  it("status reports two-lane healthy ready-lane diversity health", async () => {
    await seedReady(adapter, { title: "ready lane a", write_scope: ["repo/a"] });
    await seedReady(adapter, { title: "ready lane b", write_scope: ["repo/b"] });
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 2,
      auto_promote_min_lanes: 2,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      ready_count: 2,
      floor: 2,
      min_ready_lanes: 2,
      below_floor: false,
      below_lanes: false,
      triggered: false,
      candidates_considered: 0,
      candidates: [],
      promoted_count: 0,
      skipped_count: 0,
      blocker_class_counts: [],
      lanes: {
        build_ready: 2,
        build_ready_lanes: 2,
        ready_lane_keys: ["repo/a", "repo/b"],
        candidate_lane_keys: [],
      },
    });
    expect(res.body.auto_promote_health.summary).toMatch(/ready build fuel meets floor: ready=2 floor=2, lanes=2\/2/);
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

  it("status shows raw ready fuel as stale when every ready row is blocked by single-writer lane", async () => {
    for (let i = 0; i < 3; i++) {
      await seedReady(adapter, {
        title: `busy lane ready ${i}`,
        write_scope: ["repo/busy"],
      });
    }
    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: false,
        auto_promote_enabled: false,
        min_ready_fuel: 3,
        max_in_flight: 10,
      },
      {
        activeScopes: new Set(["repo/busy"]),
      },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({
      ready: 3,
      raw_ready_fuel: 3,
      admissible_now: 0,
      stale_ready_fuel: true,
    });
    expect(res.body.ready_admission).toMatchObject({
      candidates: 3,
      admissible_now: 0,
      block_reason_counts: {
        single_writer_lane_busy: 3,
      },
      stale_ready_floor: {
        stale: true,
        ready: 3,
        admissible: 0,
        min_ready_fuel: 3,
      },
    });
    expect(res.body.ready_admission.blocker_counts).toEqual([
      { code: "single_writer_lane_busy", category: "lane_eligibility", count: 3 },
    ]);
    expect(res.body.ready_admission.non_admitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "skipped",
          code: "single_writer_lane_busy",
          metadata: expect.objectContaining({ write_scope: "repo/busy" }),
        }),
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

describe("stale already-dispatched ready reconciliation route", () => {
  it("closes or supersedes terminal rows, preserves retry-safe work, cites artifacts, and corrects ready counts", async () => {
    const closed = await seedReady(adapter, {
      title: "terminal done duplicate",
      write_scope: ["repo/closed"],
      source_refs: ["roadmap:t-orch:closed"],
    });
    const superseded = await seedReady(adapter, {
      title: "terminal failed duplicate",
      write_scope: ["repo/superseded"],
      source_refs: ["roadmap:t-orch:superseded"],
    });
    const retry = await seedReady(adapter, {
      title: "operator-approved unsafe retry",
      write_scope: ["repo/retry"],
      source_refs: ["roadmap:t-orch:retry"],
    });

    await markReadyAlreadyDispatched(adapter, closed.item_id, "phid:disp-closed");
    await markReadyAlreadyDispatched(adapter, superseded.item_id, "phid:disp-superseded");
    await markReadyAlreadyDispatched(adapter, retry.item_id, "phid:disp-retry", { retry_safe: true });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-closed",
      status: "done",
      artifact_path: "/repo/output/closed.md",
    });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-superseded",
      status: "failed",
      artifact_path: "/repo/output/superseded.md",
    });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-retry",
      status: "done",
      artifact_path: "/repo/output/retry.md",
    });

    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: false,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 3,
    });
    await daemon.setMode("running");

    const before = await callApp(app, "/orchestration/status");
    expect(before.status).toBe(200);
    expect(before.body.counts.ready).toBe(3);
    expect(before.body.auto_promote_health.ready_count).toBe(3);

    const res = await callAppRequest(app, "POST", "/orchestration/reconcile/stale-ready");

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      scanned: 3,
      closed: 1,
      superseded: 1,
      preserved_retry_safe: 1,
      dry_run: false,
    });
    expect(res.body.result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: closed.item_id,
          dispatch_phid: "phid:disp-closed",
          to_state: "done",
          artifact_path: "/repo/output/closed.md",
        }),
        expect.objectContaining({
          item_id: superseded.item_id,
          dispatch_phid: "phid:disp-superseded",
          to_state: "superseded",
          artifact_path: "/repo/output/superseded.md",
        }),
      ]),
    );

    const closedAfter = (await getBacklogItem(adapter, closed.item_id))!;
    const supersededAfter = (await getBacklogItem(adapter, superseded.item_id))!;
    const retryAfter = (await getBacklogItem(adapter, retry.item_id))!;
    expect(closedAfter.readiness_state).toBe("done");
    expect(closedAfter.source_refs).toContain("roadmap:t-orch:closed");
    expect(closedAfter.source_refs).toContain("dispatch_artifact:/repo/output/closed.md");
    expect(supersededAfter.readiness_state).toBe("superseded");
    expect(supersededAfter.source_refs).toContain("dispatch_artifact:/repo/output/superseded.md");
    expect(retryAfter.readiness_state).toBe("ready");
    expect(retryAfter.retry_safe).toBe(true);
    expect(retryAfter.source_refs).toEqual(["roadmap:t-orch:retry"]);

    const after = await callApp(app, "/orchestration/status");
    expect(after.status).toBe(200);
    expect(after.body.counts.ready).toBe(1);
    expect(after.body.auto_promote_health.ready_count).toBe(1);
    expect(after.body.ready_admission.admissible.map((item: { item_id: string }) => item.item_id)).toEqual([
      retry.item_id,
    ]);
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
