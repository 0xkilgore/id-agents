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
  setItemState,
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
    resolveAllAgentRuntimes?: () => Promise<Map<string, string>>;
    modelPolicyPath?: string;
    runtimeModePath?: string | null;
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
    resolveAllAgentRuntimes: over.resolveAllAgentRuntimes,
    alert: async (m) => {
      alerts.push(m);
    },
    emitNews: async (event) => {
      newsEvents.push(event);
    },
    modelPolicyPath: over.modelPolicyPath,
    runtimeModePath: over.runtimeModePath,
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
    track: over.track ?? null,
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

async function seedDispatchStatus(adapter: SqliteAdapter, phid: string, status: "done" | "failed") {
  const now = "2026-07-10T00:00:00.000Z";
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
  over: {
    dispatch_phid: string;
    status: string;
    artifact_path?: string | null;
    recovery_status?: string | null;
    failure_kind?: string | null;
    failure_detail?: string | null;
    recovery_attempts?: number;
    promotion_result_json?: string | null;
  },
) {
  const now = "2026-07-08T12:00:00Z";
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, completed_at, updated_at,
        result_json, artifact_path, recovery_status, failure_kind, failure_detail,
        recovery_attempts, promotion_result_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
      over.failure_kind ?? null,
      over.failure_detail ?? null,
      over.recovery_attempts ?? 0,
      over.promotion_result_json ?? null,
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

  it("requires retry_safe=true before manually promoting an already-dispatched row", async () => {
    const retry = await insertBacklogItem(adapter, {
      title: "manual retry",
      readiness_state: "needs_review",
      to_agent: "roger",
      dispatch_body: "go",
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
         SET last_dispatch_phid = $1
       WHERE item_id = $2`,
      ["phid:disp-failed", retry.item_id],
    );

    const blocked = await promoteToReady(adapter, retry.item_id, "chris");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/retry_safe=true/);

    const approved = await promoteToReady(adapter, retry.item_id, "chris", { retry_safe: true });
    expect(approved.ok).toBe(true);
    expect(approved.item?.readiness_state).toBe("ready");
    expect(approved.item?.retry_safe).toBe(true);
    expect(approved.item?.last_dispatch_phid).toBe("phid:disp-failed");
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

  it("canonicalizes wave32 build-pool codex-cli metadata before late-bound builder admission", async () => {
    await seedAgent(adapter, "substrate-orch-codex", "running", "codex");
    const stale = await seedReady(adapter, {
      title: "wave32 backend pool ready fuel",
      track: "T-ORCH",
      to_agent: "pool:backend",
      provider: "openai",
      runtime: "codex-cli",
      write_scope: ["repos/id-agents"],
      source_refs: ["wave32:kapelle:T-ORCH:backend"],
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
        from_provider: "openai",
        from_runtime: "codex-cli",
        to_provider: "openai",
        to_runtime: "codex",
        reason: "explicit_pool_owner_lane",
      }),
    ]);
    expect(explanation.admissible).toEqual([
      expect.objectContaining({ item_id: stale.item_id, to_agent: "substrate-orch-codex" }),
    ]);
    expect(explanation.non_admitted).toHaveLength(0);
    expect(repaired).toMatchObject({ to_agent: "pool:backend", provider: "openai", runtime: "codex" });
  });

  it("repairs artifact-only CTO ready fuel back to Anthropic Claude in ready admission status", async () => {
    await seedAgent(adapter, "cto", "running", "claude-code-cli");
    const stale = await seedReady(adapter, {
      title: "cto artifact-only status report with stale codex runtime",
      track: "T-MODEL",
      to_agent: "cto",
      provider: "openai",
      runtime: "codex",
      write_scope: ["cto/output"],
      source_refs: ["cto/output/2026-07-12-model-report.md"],
    });
    await markApproved(adapter, stale.item_id);
    const { daemon } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
    });
    await daemon.setMode("running");

    const explanation = await daemon.explainReadyAdmission();
    const repaired = await getBacklogItem(adapter, stale.item_id);

    expect(explanation.ready_runtime_repairs).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        to_agent: "cto",
        from_provider: "openai",
        from_runtime: "codex",
        to_provider: "anthropic",
        to_runtime: "claude-code-cli",
        reason: "artifact_only_target_agent_runtime_claude",
      }),
    ]);
    expect(explanation.admissible).toEqual([
      expect.objectContaining({ item_id: stale.item_id, to_agent: "cto" }),
    ]);
    expect(explanation.non_admitted).toHaveLength(0);
    expect(repaired).toMatchObject({ provider: "anthropic", runtime: "claude-code-cli", readiness_state: "ready" });
  });

  it("keeps real code-scoped build rows strict when provider/runtime mismatches the target lane", async () => {
    await seedAgent(adapter, "cto", "running", "claude-code-cli");
    const stale = await seedReady(adapter, {
      title: "cto code build row with stale codex runtime",
      track: "T-MODEL",
      to_agent: "cto",
      provider: "openai",
      runtime: "codex",
      write_scope: ["src/model-policy"],
    });
    await markApproved(adapter, stale.item_id);
    const { daemon } = makeDaemon(adapter, {
      config: { dry_run: false, max_in_flight: 4 },
      resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
    });
    await daemon.setMode("running");

    const explanation = await daemon.explainReadyAdmission();
    const unrepaired = await getBacklogItem(adapter, stale.item_id);

    expect(explanation.ready_runtime_repairs).toHaveLength(0);
    expect(explanation.admissible).toHaveLength(0);
    expect(explanation.non_admitted).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        action: "held",
        code: "provider_runtime_mismatch",
        metadata: expect.objectContaining({
          class: "provider_runtime",
          target_runtime: "claude-code-cli",
        }),
      }),
    ]);
    expect(unrepaired).toMatchObject({ provider: "openai", runtime: "codex", readiness_state: "ready" });
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

  it("status auto-promote health counts pool worktree duplicates as one repo/write-scope lane", async () => {
    const staleA = await seedReady(adapter, {
      title: "stale duplicate pool row A",
      write_scope: ["/repo/kapelle/.worktrees/backend-a"],
    });
    const staleB = await seedReady(adapter, {
      title: "stale duplicate pool row B",
      write_scope: ["/repo/kapelle/.worktrees/backend-b"],
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
         SET last_dispatch_phid = $1
       WHERE item_id IN ($2, $3)`,
      ["phid:disp-stale", staleA.item_id, staleB.item_id],
    );
    await seedApprovedReview(adapter, {
      title: "fresh distinct repo fuel",
      write_scope: ["/repo/id-agents"],
    });

    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 2,
      auto_promote_min_lanes: 2,
      auto_promote_max_per_tick: 1,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: false,
      below_lanes: true,
      triggered: true,
      promoted_count: 1,
      lanes: {
        build_ready: 2,
        build_ready_lanes: 1,
        ready_lane_keys: ["/repo/kapelle"],
        candidate_lane_keys: ["/repo/id-agents"],
      },
    });
    expect(res.body.flesh.auto_promote.health.lanes).toEqual(res.body.auto_promote_health.lanes);
  });

  it("status exposes admissible_now separately from raw ready with ready block reasons", async () => {
    await seedReady(adapter, { title: "admissible now", write_scope: ["repo/open"] });

    await insertBacklogItem(adapter, {
      title: "pending dependency",
      logical_key: "dep-pending",
      readiness_state: "draft",
      risk_class: "build",
    });
    await seedReady(adapter, {
      title: "blocked by dependency",
      dependencies: ["dep-pending"],
      write_scope: ["repo/dependent"],
    });
    await seedReady(adapter, {
      title: "risk needs approval",
      risk_class: "novel",
      write_scope: ["repo/risk"],
    });
    await seedReady(adapter, {
      title: "single writer busy",
      write_scope: ["repo/busy"],
    });
    await seedReady(adapter, {
      title: "pool full",
      track: "T-FULL",
      to_agent: null,
      write_scope: ["repo/full-pool"],
    });
    await seedReady(adapter, {
      title: "pool has no builder",
      track: "T-EMPTY",
      to_agent: null,
      write_scope: ["repo/empty-pool"],
    });

    const pools: PoolRouting = {
      poolForItem: (item) => {
        if (item.track === "T-FULL") {
          return { pool_id: "full", repo_root: "/repo/full", max_parallel: 0, members: ["roger"] };
        }
        if (item.track === "T-EMPTY") {
          return { pool_id: "empty", repo_root: "/repo/empty", max_parallel: 1, members: [] };
        }
        return null;
      },
      availableBuilders: (pool) => pool.members,
      allocateWorktree: async ({ agent, item, pool }) => ({
        path: `${pool.repo_root}/.worktrees/${agent}-${item.item_id.slice(-6)}`,
        branch: `build/${agent}-${item.item_id.slice(-6)}`,
        lease_id: null,
      }),
    };
    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: false,
        auto_promote_enabled: false,
        max_in_flight: 20,
        max_new_per_tick: 20,
      },
      { activeScopes: new Set(["repo/busy"]), pools },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(6);
    expect(res.body.counts.admissible_now).toBe(1);
    expect(res.body.counts.ready_block_reasons).toEqual({
      no_in_flight_slots: 0,
      tick_admission_cap: 0,
      blocked_dependency: 1,
      risk_requires_approval: 1,
      pool_capacity_full: 1,
      single_writer_lane_busy: 1,
      no_free_pool_builder: 1,
      duplicate_dispatch_retry_required: 0,
    });
    expect(res.body.ready_admission).toMatchObject({
      candidates: 6,
      admissible_now: 1,
      block_reason_counts: res.body.counts.ready_block_reasons,
    });
    const blockedSum = Object.values(res.body.counts.ready_block_reasons)
      .reduce((sum: number, count: unknown) => sum + Number(count), 0);
    expect(blockedSum).toBe(res.body.counts.ready - res.body.counts.admissible_now);
  });

  it("status preserves queue-quality blocker labels used by /ops", async () => {
    await insertBacklogItem(adapter, {
      title: "pending dependency",
      logical_key: "dep-pending-for-ops",
      readiness_state: "draft",
      risk_class: "build",
    });
    await seedReady(adapter, {
      title: "dependency blocked ready",
      dependencies: ["dep-pending-for-ops"],
      write_scope: ["repo/dependency"],
    });
    const retryGuarded = await seedReady(adapter, {
      title: "duplicate retry guard",
      write_scope: ["repo/retry"],
    });
    await adapter.query(
      `UPDATE orchestration_backlog_item
         SET last_dispatch_phid = $1
       WHERE item_id = $2`,
      ["phid:disp-already-fired", retryGuarded.item_id],
    );
    await seedReady(adapter, {
      title: "pool at capacity",
      track: "T-FULL",
      to_agent: null,
      write_scope: ["repo/pool-full"],
    });
    await seedAgent(adapter, "substrate-orch-codex", "running", "codex");
    await seedReady(adapter, {
      title: "runtime mismatch",
      to_agent: "substrate-orch-codex",
      provider: "anthropic",
      runtime: "claude-code-cli",
      write_scope: ["repo/runtime"],
    });

    const pools: PoolRouting = {
      poolForItem: (item) =>
        item.track === "T-FULL"
          ? { pool_id: "full", repo_root: "/repo/full", max_parallel: 0, members: ["substrate-orch-codex"] }
          : null,
      availableBuilders: (pool) => pool.members,
      allocateWorktree: async ({ agent, item, pool }) => ({
        path: `${pool.repo_root}/.worktrees/${agent}-${item.item_id.slice(-6)}`,
        branch: `build/${agent}-${item.item_id.slice(-6)}`,
        lease_id: null,
      }),
    };
    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: false,
        auto_promote_enabled: false,
        max_in_flight: 20,
        max_new_per_tick: 20,
      },
      {
        pools,
        resolveAgentRuntimes: (names) => getAgentRuntimeMap(adapter, names),
      },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(4);
    expect(res.body.counts.admissible_now).toBe(0);
    expect(res.body.ready_admission.blocker_counts).toEqual(
      expect.arrayContaining([
        { code: "blocked_dependency", category: "lane_eligibility", count: 1 },
        { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1 },
        { code: "pool_capacity_full", category: "capacity_gate", count: 1 },
        { code: "provider_runtime_mismatch", category: "runtime_unavailable", count: 1 },
      ]),
    );
    expect(res.body.ready_admission.non_admitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "blocked_dependency", action: "skipped" }),
        expect.objectContaining({ code: "duplicate_dispatch_retry_required", action: "held" }),
        expect.objectContaining({ code: "pool_capacity_full", action: "held" }),
        expect.objectContaining({ code: "provider_runtime_mismatch", action: "held" }),
      ]),
    );
  });

  it("status keeps ready admission and queue quality aligned for retry blockers versus capacity gates", async () => {
    const duplicate = await seedReady(adapter, {
      title: "duplicate retry guard",
      write_scope: ["repo/duplicate"],
    });
    await markReadyAlreadyDispatched(adapter, duplicate.item_id, "phid:disp-prior");
    await seedReady(adapter, {
      title: "clean but capacity gated A",
      write_scope: ["repo/capacity-a"],
    });
    await seedReady(adapter, {
      title: "clean but capacity gated B",
      write_scope: ["repo/capacity-b"],
    });

    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: false,
        auto_promote_enabled: false,
        max_in_flight: 1,
        max_new_per_tick: 10,
        min_ready_fuel: 2,
      },
      { inFlight: 1 },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(3);
    expect(res.body.counts.admissible_now).toBe(0);
    expect(res.body.counts.ready_block_reasons).toMatchObject({
      duplicate_dispatch_retry_required: 1,
      no_in_flight_slots: 2,
    });
    expect(res.body.ready_admission).toMatchObject({
      candidates: 3,
      admissible_now: 0,
      block_reason_counts: res.body.counts.ready_block_reasons,
      stale_ready_floor: {
        stale: true,
        ready: 3,
        admissible: 0,
        min_ready_fuel: 2,
      },
    });
    expect(res.body.ready_admission.blocker_counts).toEqual(
      expect.arrayContaining([
        { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1 },
        { code: "no_in_flight_slots", category: "capacity_gate", count: 2 },
      ]),
    );
    expect(res.body.ready_admission.non_admitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_dispatch_retry_required", action: "held" }),
        expect.objectContaining({ code: "no_in_flight_slots", action: "held" }),
      ]),
    );
    expect(res.body.health.queue_quality.actionable_ready).toBe(2);
    expect(res.body.health.ready_item_blockers).toMatchObject({
      ready: 3,
      actionable: 2,
      min_ready_fuel: 2,
      admissible_now: 0,
      stale_ready_floor: true,
      stale_ready_fuel: {
        active: true,
        reason: "admissible_now=0",
        counts_by_blocker_class: expect.arrayContaining([
          { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1, examples: [duplicate.item_id] },
          { code: "no_in_flight_slots", category: "capacity_gate", count: 2, examples: [expect.any(String), expect.any(String)] },
        ]),
      },
    });
    expect(res.body.health.ready_item_blockers.categories).toEqual([
      expect.objectContaining({
        code: "duplicate_dispatch_retry_required",
        category: "retry_safety",
        count: 1,
        examples: [expect.any(String)],
      }),
    ]);
  });

  it("status reports build-ready fuel lanes and top blockers when raw ready is above floor but admissible is zero", async () => {
    await seedReady(adapter, {
      title: "ready capacity gated A",
      write_scope: ["repo/ready-a"],
    });
    await seedReady(adapter, {
      title: "ready capacity gated B",
      write_scope: ["repo/ready-b"],
    });
    await seedReady(adapter, {
      title: "ready capacity gated C",
      write_scope: ["repo/ready-c"],
    });
    await seedApprovedReview(adapter, {
      title: "candidate review lane B",
      write_scope: ["repo/candidate-b"],
    });
    await seedApprovedReview(adapter, {
      title: "candidate review lane A",
      write_scope: ["repo/candidate-a"],
    });

    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 2,
        auto_promote_min_lanes: 2,
        min_ready_fuel: 2,
        max_in_flight: 1,
        max_new_per_tick: 10,
      },
      { inFlight: 1 },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({
      ready: 3,
      admissible_now: 0,
      ready_block_reasons: {
        no_in_flight_slots: 3,
      },
    });
    expect(res.body.ready_admission).toMatchObject({
      candidates: 3,
      admissible_now: 0,
      block_reason_counts: res.body.counts.ready_block_reasons,
      stale_ready_floor: {
        stale: true,
        ready: 3,
        admissible: 0,
        min_ready_fuel: 2,
      },
    });
    expect(res.body.ready_admission.blocker_counts).toEqual([
      { code: "no_in_flight_slots", category: "capacity_gate", count: 3 },
    ]);
    expect(res.body.ready_admission.non_admitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "no_in_flight_slots", action: "held" }),
      ]),
    );
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: false,
      below_lanes: false,
      triggered: false,
      candidates_considered: 0,
      promoted_count: 0,
      lanes: {
        build_ready: 3,
        build_ready_lanes: 3,
        ready_lane_keys: ["repo/ready-a", "repo/ready-b", "repo/ready-c"],
        candidate_lane_keys: ["repo/candidate-a", "repo/candidate-b"],
      },
      next_action: {
        code: "none",
        summary: "ready build fuel meets the configured floor",
      },
    });
    expect(res.body.auto_promote_health.summary).toBe("ready build fuel meets floor: ready=3 floor=2, lanes=3/2");
    expect(res.body.flesh.auto_promote.health.lanes).toEqual(res.body.auto_promote_health.lanes);
  });

  it("status preserves auto-promote lane health after immediate dispatch drains one ready lane", async () => {
    const drained = await seedReady(adapter, {
      title: "ready lane drained by dispatch",
      priority: 1,
      write_scope: ["repo/drained-ready"],
    });
    await seedReady(adapter, {
      title: "ready lane kept A",
      priority: 5,
      write_scope: ["repo/kept-ready-a"],
    });
    await seedReady(adapter, {
      title: "ready lane kept B",
      priority: 5,
      write_scope: ["repo/kept-ready-b"],
    });
    await seedApprovedReview(adapter, {
      title: "candidate restores lane diversity",
      priority: 1,
      write_scope: ["repo/candidate-restores-diversity"],
    });

    const config: Partial<ContinuousOrchestrationConfig> = {
      dry_run: false,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 2,
      auto_promote_min_lanes: 3,
      min_ready_fuel: 2,
      max_in_flight: 1,
      max_new_per_tick: 1,
    };
    const { daemon, fired } = makeDaemon(adapter, { config });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    expect(fired.map((item) => item.item_id)).toEqual([drained.item_id]);
    expect(tick.admitted).toEqual([{ item_id: drained.item_id, dispatch_phid: `phid:disp-${drained.item_id}` }]);
    await daemon.stop();

    const { app, daemon: statusDaemon } = mountStatusApp(adapter, config, { inFlight: 1 });
    await statusDaemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: false,
      below_lanes: false,
      triggered: false,
      candidates_considered: 0,
      promoted_count: 0,
      lanes: {
        build_ready: 2,
        build_ready_lanes: 3,
        ready_lane_keys: ["repo/kept-ready-a", "repo/kept-ready-b"],
        candidate_lane_keys: ["repo/candidate-restores-diversity"],
      },
      next_action: {
        code: "none",
        summary: "ready build fuel meets the configured floor",
      },
    });
    expect(res.body.auto_promote_health.summary).toBe(
      "ready build fuel below raw floor but daemon capacity is occupied: ready_plus_in_flight=3 floor=2, in_flight=1/1, lanes=3/3",
    );
    expect(res.body.flesh.auto_promote.health.lanes).toEqual(res.body.auto_promote_health.lanes);
  });

  it("status reports clean capacity-only ready rows without stale queue-quality floor", async () => {
    await seedReady(adapter, {
      title: "clean capacity only A",
      write_scope: ["repo/capacity-only-a"],
    });
    await seedReady(adapter, {
      title: "clean capacity only B",
      write_scope: ["repo/capacity-only-b"],
    });

    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: false,
        auto_promote_enabled: false,
        max_in_flight: 1,
        max_new_per_tick: 10,
        min_ready_fuel: 2,
      },
      { inFlight: 1 },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.ready_admission).toMatchObject({
      candidates: 2,
      admissible_now: 0,
      block_reason_counts: {
        no_in_flight_slots: 2,
      },
      stale_ready_floor: {
        stale: true,
        ready: 2,
        admissible: 0,
        min_ready_fuel: 2,
      },
    });
    expect(res.body.ready_admission.blocker_counts).toEqual([
      { code: "no_in_flight_slots", category: "capacity_gate", count: 2 },
    ]);
    expect(res.body.health.queue_quality.actionable_ready).toBe(2);
    expect(res.body.health.ready_item_blockers).toMatchObject({
      ready: 2,
      actionable: 2,
      min_ready_fuel: 2,
      admissible_now: 0,
      stale_ready_floor: true,
      categories: [],
      stale_ready_fuel: {
        active: true,
        owner_lane: "orchestration",
        reason: "admissible_now=0",
        counts_by_blocker_class: [
          {
            code: "no_in_flight_slots",
            category: "capacity_gate",
            count: 2,
            examples: [expect.any(String), expect.any(String)],
          },
        ],
      },
    });
  });

  it("status exposes stale-ready fuel as actionable when ready=11 is below floor=12 with retry and lane blockers", async () => {
    const duplicate = await seedReady(adapter, {
      title: "duplicate retry guard below floor",
      write_scope: ["repo/duplicate-floor"],
    });
    await markReadyAlreadyDispatched(adapter, duplicate.item_id, "phid:disp-prior-floor");
    const laneBusy = await seedReady(adapter, {
      title: "single writer lane busy below floor",
      write_scope: ["repo/busy-floor"],
    });
    for (let i = 0; i < 9; i++) {
      await seedReady(adapter, {
        title: `clean below-floor ready ${i}`,
        write_scope: [`repo/clean-below-floor-${i}`],
      });
    }

    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        auto_flesh_enabled: false,
        auto_promote_enabled: false,
        max_in_flight: 20,
        max_new_per_tick: 20,
        min_ready_fuel: 12,
      },
      { activeScopes: new Set(["repo/busy-floor"]) },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({
      ready: 11,
      admissible_now: 9,
      ready_block_reasons: {
        duplicate_dispatch_retry_required: 1,
        single_writer_lane_busy: 1,
      },
    });
    expect(res.body.ready_admission).toMatchObject({
      candidates: 11,
      admissible_now: 9,
      stale_ready_floor: {
        stale: false,
        ready: 11,
        admissible: 9,
        min_ready_fuel: 12,
      },
    });
    expect(res.body.health.ready_item_blockers).toMatchObject({
      ready: 11,
      actionable: 10,
      min_ready_fuel: 12,
      admissible_now: 9,
      stale_ready_floor: true,
      stale_ready_fuel: {
        active: true,
        owner_lane: "orchestration",
        recommended_action: "clear the top ready-admission blockers or promote/refuel safe backlog candidates until ready fuel is admissible",
        reason: "actionable_ready=10 is below min_ready_fuel=12",
      },
    });
    expect(res.body.health.ready_item_blockers.stale_ready_fuel.counts_by_blocker_class).toEqual(
      expect.arrayContaining([
        {
          code: "duplicate_dispatch_retry_required",
          category: "retry_safety",
          count: 1,
          examples: [duplicate.item_id],
        },
        {
          code: "single_writer_lane_busy",
          category: "lane_eligibility",
          count: 1,
          examples: [laneBusy.item_id],
        },
      ]),
    );
    expect(res.body.health.ready_item_blockers.stale_ready_fuel.examples).toEqual(
      expect.arrayContaining([duplicate.item_id, laneBusy.item_id]),
    );
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
    expect(res.body.auto_promote_health.summary).toMatch(/next: manually \/promote safe retries or close stale already-dispatched rows/);
  });

  it("status next action distinguishes stale already-dispatched auto-promote blockers", async () => {
    await seedReady(adapter, {
      title: "only ready build fuel",
      write_scope: ["repo/ready"],
    });
    await seedApprovedReview(adapter, {
      title: "stale already-dispatched candidate",
      write_scope: ["repo/stale-a"],
      last_dispatch_phid: "phid:disp-stale-a",
    });
    await seedApprovedReview(adapter, {
      title: "stale already-dispatched candidate two",
      write_scope: ["repo/stale-b"],
      last_dispatch_phid: "phid:disp-stale-b",
    });
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 4,
      auto_promote_min_lanes: 3,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: true,
      below_lanes: true,
      candidates_considered: 2,
      promoted_count: 0,
      skipped_count: 2,
      next_action: {
        code: "manual_promote_or_close_already_dispatched",
        summary: "manually /promote safe retries or close stale already-dispatched rows",
      },
    });
    expect(res.body.auto_promote_health.blocker_class_counts).toEqual([
      expect.objectContaining({ class: "already_dispatched", count: 2 }),
    ]);
    expect(res.body.auto_promote_health.summary).toMatch(/close stale already-dispatched rows/);
    expect(res.body.auto_promote_health.summary).toMatch(/manually \/promote safe retries/);
    expect(res.body.auto_promote_health.summary).not.toMatch(/author new lane-diverse rows/);
  });

  it("status next action distinguishes true confidence-held auto-promote blockers", async () => {
    await seedReady(adapter, {
      title: "only ready build fuel",
      write_scope: ["repo/ready"],
    });
    await seedApprovedReview(adapter, {
      title: "confidence-held candidate",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD - 0.05,
      write_scope: ["repo/confidence-a"],
    });
    await seedApprovedReview(adapter, {
      title: "confidence-held candidate two",
      approved_by: null,
      approved_at: null,
      flesh_status: "needs_chris_batch",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD - 0.03,
      write_scope: ["repo/confidence-b"],
    });
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 4,
      auto_promote_min_lanes: 3,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: true,
      below_lanes: true,
      candidates_considered: 2,
      promoted_count: 0,
      skipped_count: 2,
      next_action: {
        code: "author_lane_diverse_rows",
        summary: "author new lane-diverse build rows; confidence-held candidates are not auto-promote fuel",
      },
    });
    expect(res.body.auto_promote_health.blocker_class_counts).toEqual([
      expect.objectContaining({ class: "confidence_threshold", count: 2 }),
    ]);
    expect(res.body.auto_promote_health.summary).toMatch(/author new lane-diverse build rows/);
    expect(res.body.auto_promote_health.summary).toMatch(/confidence-held candidates/);
    expect(res.body.auto_promote_health.summary).not.toMatch(/close stale already-dispatched rows/);
  });

  it("status summarizes manual-promote health without implying empty fuel", async () => {
    const retryable = await seedApprovedReview(adapter, {
      title: "retryable failed candidate",
      write_scope: ["repo/retryable"],
      last_dispatch_phid: "phid:disp-retryable",
    });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-retryable",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in_flight claim released by reconciler",
      recovery_attempts: 1,
    });
    const stale = await seedApprovedReview(adapter, {
      title: "stale landed candidate",
      write_scope: ["repo/stale"],
      last_dispatch_phid: "phid:disp-landed",
    });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-landed",
      status: "done",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });
    const held = await seedApprovedReview(adapter, {
      title: "confidence-held candidate",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD - 0.01,
      write_scope: ["repo/confidence-held"],
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
      triggered: true,
      candidates_considered: 3,
      promoted_count: 0,
      skipped_count: 3,
      next_action: {
        code: "manual_promote_or_close_already_dispatched",
      },
      operator_summary: {
        schema_version: "orchestration.auto_promote_operator_summary.v1",
        retryable_failed_rows: 1,
        stale_duplicate_rows: 1,
        confidence_held_rows: 1,
        empty_fuel: false,
      },
    });
    expect(res.body.auto_promote_health.skipped_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: retryable.item_id }),
        expect.objectContaining({ item_id: stale.item_id }),
        expect.objectContaining({ item_id: held.item_id }),
      ]),
    );
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/retryable_failed_rows=1/);
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/stale_duplicate_rows=1/);
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/confidence_held_rows=1/);
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/gated fuel/i);
    expect(res.body.auto_promote_health.operator_summary.summary).not.toMatch(/empty fuel/i);
    expect(res.body.auto_promote_health.operator_summary.safe_actions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/manually \/promote retryable failed rows/i),
        expect.stringMatching(/close stale duplicate rows/i),
        expect.stringMatching(/re-flesh confidence-held rows/i),
        expect.stringMatching(/gated fuel; rows exist/i),
      ]),
    );
  });

  it("status summarizes manual-promote health without implying empty fuel", async () => {
    const retryable = await seedApprovedReview(adapter, {
      title: "retryable failed candidate",
      write_scope: ["repo/retryable"],
      last_dispatch_phid: "phid:disp-retryable",
    });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-retryable",
      status: "failed",
      failure_kind: "scheduler_wedged",
      failure_detail: "stale in_flight claim released by reconciler",
      recovery_attempts: 1,
    });
    const stale = await seedApprovedReview(adapter, {
      title: "stale landed candidate",
      write_scope: ["repo/stale"],
      last_dispatch_phid: "phid:disp-landed",
    });
    await seedDispatch(adapter, {
      dispatch_phid: "phid:disp-landed",
      status: "done",
      promotion_result_json: JSON.stringify({ completed: true, repos: [{ verified: true }] }),
    });
    const held = await seedApprovedReview(adapter, {
      title: "confidence-held candidate",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD - 0.01,
      write_scope: ["repo/confidence-held"],
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
      triggered: true,
      candidates_considered: 3,
      promoted_count: 0,
      skipped_count: 3,
      next_action: {
        code: "manual_promote_or_close_already_dispatched",
      },
      operator_summary: {
        schema_version: "orchestration.auto_promote_operator_summary.v1",
        retryable_failed_rows: 1,
        stale_duplicate_rows: 1,
        confidence_held_rows: 1,
        empty_fuel: false,
      },
    });
    expect(res.body.auto_promote_health.skipped_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: retryable.item_id }),
        expect.objectContaining({ item_id: stale.item_id }),
        expect.objectContaining({ item_id: held.item_id }),
      ]),
    );
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/retryable_failed_rows=1/);
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/stale_duplicate_rows=1/);
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/confidence_held_rows=1/);
    expect(res.body.auto_promote_health.operator_summary.summary).toMatch(/gated fuel/i);
    expect(res.body.auto_promote_health.operator_summary.summary).not.toMatch(/empty fuel/i);
    expect(res.body.auto_promote_health.operator_summary.safe_actions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/manually \/promote retryable failed rows/i),
        expect.stringMatching(/close stale duplicate rows/i),
        expect.stringMatching(/re-flesh confidence-held rows/i),
        expect.stringMatching(/gated fuel; rows exist/i),
      ]),
    );
  });

  it("status reports below-floor and below-lane build-ready health without fake idle action", async () => {
    await seedReady(adapter, {
      title: "only ready build lane",
      write_scope: ["repo/ready-a"],
    });
    await seedApprovedReview(adapter, {
      title: "already dispatched candidate",
      write_scope: ["repo/candidate-a"],
      last_dispatch_phid: "phid:disp-prior",
    });
    await seedApprovedReview(adapter, {
      title: "review held candidate",
      risk_class: "external",
      write_scope: ["repo/candidate-b"],
    });

    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 4,
      auto_promote_min_lanes: 3,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(1);
    expect(res.body.auto_promote_health).toMatchObject({
      floor: 4,
      min_ready_lanes: 3,
      below_floor: true,
      below_lanes: true,
      triggered: true,
      candidates_considered: 2,
      promoted_count: 0,
      skipped_count: 2,
      lanes: {
        build_ready: 1,
        build_ready_lanes: 1,
        ready_lane_keys: ["repo/ready-a"],
        candidate_lane_keys: ["repo/candidate-a", "repo/candidate-b"],
      },
      next_action: {
        code: "manual_promote_or_close_already_dispatched",
      },
    });
    expect(res.body.auto_promote_health.next_action.code).not.toBe("none");
    expect(res.body.auto_promote_health.next_action.summary).not.toMatch(/\b(?:ok|idle)\b/i);
    expect(res.body.auto_promote_health.blocker_class_counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: "already_dispatched", count: 1 }),
        expect.objectContaining({ class: "review_held_risk", count: 1 }),
      ]),
    );
    expect(res.body.auto_promote_health.summary).toMatch(/ready=1 floor=4, lanes=1\/3/);
    expect(res.body.auto_promote_health.summary).toMatch(/blocker classes:/);
    expect(res.body.auto_promote_health.summary).toMatch(/next: manually \/promote safe retries or close stale already-dispatched rows/);
    expect(res.body.flesh.auto_promote.health.next_action).toEqual(res.body.auto_promote_health.next_action);
  });

  it("status recommends closing stale already-dispatched rows when prior dispatch is done", async () => {
    await seedDispatchStatus(adapter, "phid:disp-stale-done", "done");
    const stale = await seedApprovedReview(adapter, {
      title: "already dispatched completed row",
      write_scope: ["repo/already-done"],
      last_dispatch_phid: "phid:disp-stale-done",
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
    expect(res.body.auto_promote_health.next_action).toMatchObject({
      code: "close_stale_already_dispatched_rows",
      summary: expect.stringMatching(/close stale already-dispatched rows/i),
    });
    expect(res.body.auto_promote_health.skipped_items).toEqual([
      expect.objectContaining({
        item_id: stale.item_id,
        prior_dispatch_phid: "phid:disp-stale-done",
        prior_dispatch_status: "done",
      }),
    ]);
    expect(res.body.auto_promote_health.summary).toMatch(/already-dispatched statuses: done=1, retryable=0, unknown=0/);
    expect(res.body.auto_promote_health.summary).toMatch(/next: close stale already-dispatched rows/i);
  });

  it("status recommends manual promotion for already-dispatched safe retries when prior dispatch failed", async () => {
    await seedDispatchStatus(adapter, "phid:disp-safe-retry", "failed");
    const retry = await seedApprovedReview(adapter, {
      title: "already dispatched failed retry",
      write_scope: ["repo/already-failed"],
      last_dispatch_phid: "phid:disp-safe-retry",
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
    expect(res.body.auto_promote_health.next_action).toMatchObject({
      code: "manual_promote_safe_retries",
      summary: expect.stringMatching(/manually \/promote safe retry rows/i),
    });
    expect(res.body.auto_promote_health.skipped_items).toEqual([
      expect.objectContaining({
        item_id: retry.item_id,
        prior_dispatch_phid: "phid:disp-safe-retry",
        prior_dispatch_status: "failed",
      }),
    ]);
    expect(res.body.auto_promote_health.summary).toMatch(/already-dispatched statuses: done=0, retryable=1, unknown=0/);
    expect(res.body.auto_promote_health.summary).toMatch(/next: manually \/promote safe retry rows/i);
  });

  it("status recommends authoring new lane-diverse rows for true confidence-held candidates", async () => {
    await seedApprovedReview(adapter, {
      title: "true confidence-held candidate",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: AUTO_READY_CONFIDENCE_THRESHOLD - 0.02,
      write_scope: ["repo/confidence-held"],
    });
    const { app, daemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 12,
      auto_promote_min_lanes: 2,
    });
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: true,
      below_lanes: true,
      candidates_considered: 1,
      promoted_count: 0,
      skipped_count: 1,
      next_action: {
        code: "author_lane_diverse_rows",
        summary: expect.stringMatching(/author new lane-diverse build rows/i),
      },
    });
    expect(res.body.auto_promote_health.blocker_class_counts).toEqual([
      expect.objectContaining({ class: "confidence_threshold", count: 1 }),
    ]);
    expect(res.body.auto_promote_health.summary).toMatch(/confidence-held candidates are not auto-promote fuel/i);
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

  it("status treats dispatched refuel-wave rows as capacity fuel when raw ready drops below floor", async () => {
    const first = await seedReady(adapter, { title: "wave item one", write_scope: ["repo/wave-a"] });
    const second = await seedReady(adapter, { title: "wave item two", write_scope: ["repo/wave-b"] });
    await setItemState(adapter, first.item_id, "in_flight", { dispatch_phid: "phid:disp-wave-a" });
    await setItemState(adapter, second.item_id, "in_flight", { dispatch_phid: "phid:disp-wave-b" });

    const { app, daemon } = mountStatusApp(
      adapter,
      {
        dry_run: true,
        max_in_flight: 2,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 8,
        auto_promote_min_lanes: 2,
      },
      { inFlight: 2 },
    );
    await daemon.setMode("running");

    const res = await callApp(app, "/orchestration/status");

    expect(res.status).toBe(200);
    expect(res.body.counts.ready).toBe(0);
    expect(res.body.counts.in_flight).toBe(2);
    expect(res.body.auto_promote_health).toMatchObject({
      below_floor: false,
      triggered: false,
      promoted_count: 0,
      lanes: {
        build_ready: 0,
        build_in_flight: 2,
        ready_plus_in_flight: 2,
        capacity_occupied: true,
      },
    });
    expect(res.body.auto_promote_health.summary).toMatch(/capacity is occupied/);
    expect(res.body.auto_promote_health.summary).toMatch(/in_flight=2\/2/);
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

  it("dedupes unchanged model-policy drift alerts across repeated ticks", async () => {
    const modelPolicyPath = writeModelPolicy({
      directive: { anthropic: 0.5, openai: 0.5, cursor: 0 },
      workShare: { anthropic: 0.05, openai: 0.95, cursor: 0 },
    });
    const { daemon, alerts } = makeDaemon(adapter, { modelPolicyPath });

    await daemon.runTick();
    await daemon.runTick();
    await daemon.runTick();

    expect(alerts.filter((a) => /model-policy drift/.test(a))).toHaveLength(1);
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

  it("fires a drift alert when desired provider mix disagrees with generated runtime-mode", async () => {
    const modelPolicyPath = writeModelPolicy({
      directive: { anthropic: 0.05, openai: 0.95, cursor: 0 },
      workShare: { anthropic: 0.05, openai: 0.95, cursor: 0 },
    });
    const runtimeModePath = join(mkdtempSync(join(tmpdir(), "runtime-mode-drift-")), "runtime-mode.generated.yaml");
    writeFileSync(
      runtimeModePath,
      [
        "agents:",
        "  substrate-api-codex:",
        "    runtime: codex",
        "  substrate-db-codex:",
        "    runtime: codex",
      ].join("\n"),
    );
    const { daemon, alerts, newsEvents } = makeDaemon(adapter, { modelPolicyPath, runtimeModePath });

    const r = await daemon.runTick();

    expect(r.model_policy_drift.status).toBe("drift");
    expect(r.model_policy_drift.runtime_mix?.status).toBe("drift");
    expect(r.model_policy_drift.runtime_mix?.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "runtime_mode", provider: "anthropic", desired: 0.05, actual: 0 }),
      ]),
    );
    expect(r.decisions.some((d) => d.action === "model_policy_drift_alert")).toBe(true);
    expect(alerts.some((a) => /runtime mix drift/.test(a))).toBe(true);
    expect(newsEvents).toEqual([
      expect.objectContaining({
        type: "model_policy.drift",
        data: expect.objectContaining({
          runtime_mix: expect.objectContaining({ status: "drift", runtime_mode_path: runtimeModePath }),
        }),
      }),
    ]);
  });

  it("fires a drift alert when desired provider mix disagrees with live agent runtime telemetry", async () => {
    const modelPolicyPath = writeModelPolicy({
      directive: { anthropic: 0.05, openai: 0.95, cursor: 0 },
      workShare: { anthropic: 0.05, openai: 0.95, cursor: 0 },
    });
    const { daemon, alerts } = makeDaemon(adapter, {
      modelPolicyPath,
      runtimeModePath: null,
      resolveAllAgentRuntimes: async () =>
        new Map([
          ["substrate-api-codex", "codex"],
          ["substrate-db-codex", "codex"],
        ]),
    });

    const r = await daemon.runTick();

    expect(r.model_policy_drift.runtime_mix?.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "agent_actual", provider: "anthropic", desired: 0.05, actual: 0 }),
      ]),
    );
    expect(alerts.some((a) => /runtime mix drift/.test(a))).toBe(true);
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

  it("dedupes unchanged STALL alerts across repeated ticks and emits one recovery", async () => {
    await seedReady(adapter);
    const { daemon, alerts } = makeDaemon(adapter, {
      config: { dry_run: false, stall_threshold_ticks: 2, max_in_flight: 0 },
    });
    await daemon.setMode("running");

    await daemon.runTick();
    await daemon.runTick();
    await daemon.runTick();
    expect(alerts.filter((a) => /STALL/.test(a))).toHaveLength(1);

    await daemon.setMode("paused");
    await daemon.runTick();
    expect(alerts.filter((a) => /STALL recovered/.test(a))).toHaveLength(1);
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

  it("does not run low-fuel refuel loops when raw ready is below floor because in_flight is full", async () => {
    for (let i = 0; i < 2; i++) {
      const item = await seedReady(adapter, { title: `capacity held ${i}`, write_scope: [`repo/capacity-${i}`] });
      await setItemState(adapter, item.item_id, "in_flight", { dispatch_phid: `phid:disp-capacity-${i}` });
    }
    await seedReady(adapter, { title: "raw ready remains below floor", write_scope: ["repo/raw-ready"] });
    await seedApprovedReview(adapter, { title: "safe follow-up candidate", write_scope: ["repo/follow-up"] });

    const { daemon, newsEvents } = makeDaemon(adapter, {
      config: {
        dry_run: false,
        stall_threshold_ticks: 2,
        min_ready_fuel: 8,
        max_in_flight: 2,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 8,
        auto_promote_min_lanes: 2,
      },
      inFlight: 2,
    });
    await daemon.setMode("running");

    const r1 = await daemon.runTick();
    const r2 = await daemon.runTick();

    expect(r1.admitted).toHaveLength(0);
    expect(r1.auto_promote).toBeNull();
    expect(r1.refuel).toBeNull();
    expect(r2.zero_ticks).toBe(2);
    expect(r2.stall_alert).toBe(true);
    expect(r2.refuel).toBeNull();
    expect(r2.decisions.some((d) => d.action === "refuel")).toBe(false);
    expect(r2.decisions.some((d) => d.action === "fleet_blockage")).toBe(false);
    expect(newsEvents).toHaveLength(0);
  });

  it("fires a single-tick empty-pipe alert when all needs_review candidates are confidence or already-dispatched skips", async () => {
    const lowConfidence = await seedApprovedReview(adapter, {
      title: "low confidence needs human decision",
      approved_by: null,
      approved_at: null,
      flesh_status: "fleshed",
      flesh_confidence: 0.55,
      write_scope: ["repo/low-confidence"],
    });
    const alreadyDispatched = await seedApprovedReview(adapter, {
      title: "already dispatched needs reconciliation",
      last_dispatch_phid: "phid:disp-old",
      write_scope: ["repo/already-dispatched"],
    });

    const { daemon, newsEvents } = makeDaemon(adapter, {
      config: {
        dry_run: false,
        auto_flesh_enabled: true,
        auto_promote_enabled: true,
        auto_promote_floor: 8,
        auto_promote_min_lanes: 1,
        max_flesh_per_tick: 0,
      },
    });
    await daemon.setMode("running");

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
    expect(tick.decisions.some((d) => d.action === "fleet_blockage" && d.metadata?.kind === "empty_auto_promote_pipe")).toBe(true);

    const { app, daemon: statusDaemon } = mountStatusApp(adapter, {
      dry_run: true,
      auto_flesh_enabled: true,
      auto_promote_enabled: true,
      auto_promote_floor: 8,
      auto_promote_min_lanes: 1,
    });
    await statusDaemon.setMode("running");
    const status = await callApp(app, "/orchestration/status");

    expect(status.status).toBe(200);
    expect(status.body.auto_promote_health.empty_pipe_alert).toMatchObject({
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
    expect(before.body.ready_admission.candidates).toBe(3);

    const res = await callAppRequest(app, "POST", "/orchestration/reconcile/stale-ready", { actor: "hopper" });

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
          receipt: expect.objectContaining({
            schema_version: "orchestration.stale_duplicate_closeout_receipt.v1",
            closed_by: "hopper",
            from_state: "ready",
            to_state: "done",
            reason: "close_or_ignore",
            prior_dispatch_phid: "phid:disp-closed",
            prior_dispatch_status: "done",
            successor_dispatch_phid: null,
            redispatch_safety: expect.objectContaining({
              safe_to_not_redispatch: true,
              reason: expect.stringContaining("duplicate completed work"),
            }),
          }),
        }),
        expect.objectContaining({
          item_id: superseded.item_id,
          dispatch_phid: "phid:disp-superseded",
          to_state: "superseded",
          artifact_path: "/repo/output/superseded.md",
          receipt: expect.objectContaining({
            closed_by: "hopper",
            reason: "close_or_ignore",
            successor_dispatch_phid: null,
            redispatch_safety: expect.objectContaining({
              safe_to_not_redispatch: true,
              reason: expect.stringContaining("not retry fuel"),
            }),
          }),
        }),
      ]),
    );

    const closedAfter = (await getBacklogItem(adapter, closed.item_id))!;
    const supersededAfter = (await getBacklogItem(adapter, superseded.item_id))!;
    const retryAfter = (await getBacklogItem(adapter, retry.item_id))!;
    expect(closedAfter.readiness_state).toBe("done");
    expect(closedAfter.updated_by).toBe("hopper");
    expect(closedAfter.stale_duplicate_closeout_receipt).toMatchObject({
      closed_by: "hopper",
      from_state: "ready",
      to_state: "done",
      reason: "close_or_ignore",
      prior_dispatch_phid: "phid:disp-closed",
      prior_dispatch_status: "done",
      successor_dispatch_phid: null,
      redispatch_safety: {
        safe_to_not_redispatch: true,
        reason: expect.stringContaining("duplicate completed work"),
      },
    });
    expect(closedAfter.source_refs).toContain("roadmap:t-orch:closed");
    expect(closedAfter.source_refs).toContain("dispatch_artifact:/repo/output/closed.md");
    expect(supersededAfter.readiness_state).toBe("superseded");
    expect(supersededAfter.updated_by).toBe("hopper");
    expect(supersededAfter.stale_duplicate_closeout_receipt).toMatchObject({
      closed_by: "hopper",
      from_state: "ready",
      to_state: "superseded",
      reason: "close_or_ignore",
      prior_dispatch_phid: "phid:disp-superseded",
      prior_dispatch_status: "failed",
      successor_dispatch_phid: null,
      redispatch_safety: {
        safe_to_not_redispatch: true,
        reason: expect.stringContaining("not retry fuel"),
      },
    });
    expect(supersededAfter.source_refs).toContain("dispatch_artifact:/repo/output/superseded.md");
    expect(retryAfter.readiness_state).toBe("ready");
    expect(retryAfter.retry_safe).toBe(true);
    expect(retryAfter.stale_duplicate_closeout_receipt).toBeNull();
    expect(retryAfter.source_refs).toEqual(["roadmap:t-orch:retry"]);

    const after = await callApp(app, "/orchestration/status");
    expect(after.status).toBe(200);
    expect(after.body.counts.ready).toBe(1);
    expect(after.body.ready_admission.candidates).toBe(1);
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
