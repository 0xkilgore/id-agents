// Continuous Orchestration — Stage C build-pool routing (parallel builds).
//
// Proves the parallelism unlock the live 45-min soak demonstrates: one tick
// fires N concurrent builds to N DISTINCT pool members on N DISTINCT worktree
// write_scopes (not serialized to one lane); a 4th item is held "pool capacity
// full" (not lane-locked to a name); a busy primary spills to the next member;
// and across ticks, completed builds self-reconcile out of in_flight (the
// 8a27bba fix) so the backlog `done` count climbs with no strangle.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  insertBacklogItem,
  listBacklogByState,
  getDispatchStatusesByPhid,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import {
  ContinuousOrchestrationDaemon,
  type PoolRouting,
  type ResolvedPool,
} from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig, type ContinuousOrchestrationConfig } from "../../src/continuous-orchestration/config.js";
import { buildPoolRouting } from "../../src/continuous-orchestration/factory.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";

const okUsage = (): { view: UsageGateView; daily_tokens_used: number } => ({
  view: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
  daily_tokens_used: 0,
});

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
});

function fakePools(over: { max_parallel?: number; members?: string[] } = {}): PoolRouting {
  const pool: ResolvedPool = {
    pool_id: "backend",
    repo_root: "/repo/id-agents",
    max_parallel: over.max_parallel ?? 3,
    members: over.members ?? ["roger", "brunel", "hopper"],
  };
  return {
    poolForItem: (item) => (item.track?.startsWith("T-CKPT") ? { ...pool, members: [...pool.members] } : null),
    availableBuilders: (p, building) => p.members.filter((m) => !building.has(m)),
    allocateWorktree: async ({ agent, item }) => ({
      path: `/repo/id-agents/.worktrees/${agent}-${item.item_id.slice(-6)}`,
      branch: `build/${agent}-${item.item_id.slice(-6)}`,
      lease_id: null,
    }),
  };
}

function makeDaemon(over: {
  config?: Partial<ContinuousOrchestrationConfig>;
  pools?: PoolRouting;
  healthyAgents?: Set<string>;
} = {}) {
  const fired: BacklogItem[] = [];
  const daemon = new ContinuousOrchestrationDaemon({
    adapter,
    config: { ...defaultConfig(), enabled: true, dry_run: false, max_in_flight: 10, ...over.config },
    enqueue: async (item) => {
      fired.push(item);
      return { dispatch_phid: `phid:disp-${item.item_id}`, query_id: `q_${item.item_id}` };
    },
    readUsage: async () => okUsage(),
    readInFlight: async () => {
      const inFlight = await listBacklogByState(adapter, { state: "in_flight" });
      const scopes = new Set<string>();
      for (const it of inFlight) for (const s of it.write_scope) scopes.add(s);
      return { count: inFlight.length, active_write_scopes: scopes };
    },
    resolveDispatchStates: (phids) => getDispatchStatusesByPhid(adapter, phids),
    resolveAgentHealth: over.healthyAgents ? async () => over.healthyAgents! : undefined,
    pools: over.pools ?? fakePools(),
    alert: async () => {},
    now: () => Date.parse("2026-06-17T18:00:00Z"), // not a load-point
  });
  return { daemon, fired };
}

async function seedBuildItem(
  n: number,
  over: Partial<Pick<BacklogItem, "title" | "track" | "to_agent" | "dispatch_body" | "write_scope">> = {},
) {
  return insertBacklogItem(adapter, {
    title: over.title ?? `build ${n}`,
    track: over.track ?? "T-CKPT.X",
    to_agent: over.to_agent,
    dispatch_body: over.dispatch_body ?? `implement ${n}`,
    readiness_state: "ready",
    risk_class: "build",
    priority: 5,
    write_scope: over.write_scope ?? ["/repo/id-agents"], // repo root at flesh; daemon late-binds to a worktree
    token_estimate: 0,
  });
}

/** Mark a fired dispatch terminal so reconcile releases the in_flight lock. */
async function completeDispatch(phid: string, status = "done") {
  const now = new Date(Date.parse("2026-06-17T18:00:00Z")).toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [phid, "team-uuid", `q_${phid}`, "roger", "co", "manager", "s", "b", "anthropic", "claude-code-cli", status, now, now],
  );
}

describe("pool routing — N concurrent builds on distinct worktrees", () => {
  it("one tick fires 3 builds to 3 DISTINCT builders on 3 DISTINCT worktree scopes; 4th held 'pool capacity full'", async () => {
    for (let i = 0; i < 4; i++) await seedBuildItem(i);
    const { daemon, fired } = makeDaemon({ config: { max_in_flight: 10 } });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    expect(fired).toHaveLength(3); // pool max_parallel=3 caps it, not serialized to 1
    const builders = new Set(fired.map((i) => i.to_agent));
    expect(builders).toEqual(new Set(["roger", "brunel", "hopper"])); // 3 DISTINCT members
    const scopes = new Set(fired.flatMap((i) => i.write_scope));
    expect(scopes.size).toBe(3); // 3 DISTINCT worktree write_scopes
    expect([...scopes].every((s) => s.includes("/.worktrees/"))).toBe(true);

    // The held 4th item is "pool capacity full" — NOT lane-locked to a name.
    const held = tick.decisions.find((d) => d.reason?.includes("pool capacity full"));
    expect(held).toBeTruthy();

    const inFlight = await listBacklogByState(adapter, { state: "in_flight" });
    expect(inFlight).toHaveLength(3);
  });

  it("late binding: a busy primary (roger) spills to the next member, not held", async () => {
    // roger already building (in_flight).
    const busy = await seedBuildItem(0);
    await setItemState(adapter, busy.item_id, "in_flight", { dispatch_phid: "phid:disp-busy" });
    await adapter.query(`UPDATE orchestration_backlog_item SET to_agent = $1 WHERE item_id = $2`, ["roger", busy.item_id]);
    await completeDispatch("phid:disp-busy", "active"); // still running

    await seedBuildItem(1);
    const { daemon, fired } = makeDaemon();
    await daemon.setMode("running");
    await daemon.runTick();

    expect(fired).toHaveLength(1);
    expect(fired[0].to_agent).not.toBe("roger"); // roger busy → spilled
    expect(["brunel", "hopper"]).toContain(fired[0].to_agent);
  });
});

describe("SOAK — backlog drains in parallel with no strangle", () => {
  it("over multiple ticks, completed builds self-reconcile and the done count climbs (3-wide)", async () => {
    for (let i = 0; i < 9; i++) await seedBuildItem(i);
    const { daemon } = makeDaemon({ config: { max_in_flight: 10 } });
    await daemon.setMode("running");

    let doneCount = 0;
    for (let round = 0; round < 5; round++) {
      const tick = await daemon.runTick();
      // in_flight never exceeds the pool width (3) — parallel but capped.
      const inFlight = await listBacklogByState(adapter, { state: "in_flight" });
      expect(inFlight.length).toBeLessThanOrEqual(3);
      // Complete whatever was just fired so the next tick reconciles + refills.
      for (const a of tick.admitted) {
        if (a.dispatch_phid) await completeDispatch(a.dispatch_phid, "done");
      }
      const done = await listBacklogByState(adapter, { state: "done" });
      expect(done.length).toBeGreaterThanOrEqual(doneCount); // monotonic, no strangle
      doneCount = done.length;
    }

    // All 9 items drained to done across the rounds (3-wide, self-reconciling).
    expect(doneCount).toBe(9);
    expect(await listBacklogByState(adapter, { state: "ready" })).toHaveLength(0);
    expect(await listBacklogByState(adapter, { state: "in_flight" })).toHaveLength(0);
  });
});

describe("backend pool routing (real registry)", () => {
  it("a frontend-pool tick fans out to isolated Kapelle worktrees instead of serializing through Regina", async () => {
    for (let i = 0; i < 4; i++) {
      await seedBuildItem(i, {
        title: `T-UI /ops smoke ${i}`,
        track: "T-UI",
        to_agent: "pool:frontend",
        dispatch_body: "Verify /ops frontend routing health in kapelle-site",
        write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
      });
    }
    const { daemon, fired } = makeDaemon({
      config: { max_in_flight: 10 },
      pools: buildPoolRouting({ BUILD_POOL_FRONTEND_MAX_PARALLEL: "3" }),
    });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    expect(fired).toHaveLength(3);
    expect(fired.map((i) => i.to_agent)).toEqual(["regina", "brunel", "eames"]);
    const scopes = fired.flatMap((i) => i.write_scope);
    expect(new Set(scopes).size).toBe(3);
    expect(scopes.every((s) => s.startsWith("/Users/kilgore/Dropbox/Code/kapelle-site/.worktrees/"))).toBe(true);
    expect(scopes.every((s) => !s.endsWith("/Code/regina") && !s.includes("/Dropbox/Code/regina/"))).toBe(true);

    const poolFires = tick.decisions.filter((d) => d.reason?.includes("pool frontend →"));
    expect(poolFires).toHaveLength(3);
    for (const name of ["regina", "brunel", "eames"]) {
      expect(poolFires.some((d) => d.reason?.includes(`→ ${name} `))).toBe(true);
    }
    expect(tick.decisions.some((d) => d.reason?.includes("pool capacity full"))).toBe(true);
  });

  it("preserves wave17/wave18 explicit kapelle-site to_agent values instead of reassigning them to the frontend pool", async () => {
    const explicitRows = [
      {
        wave: "wave17",
        agent: "cto",
        title: "wave17 cto review - kapelle-site release routing",
        body: "Review kapelle-site /ops release routing without changing owner.",
        scope: "/repo/kapelle-site/wave17-cto",
      },
      {
        wave: "wave18",
        agent: "regina",
        title: "wave18 regina fix - kapelle-site approval console",
        body: "Fix kapelle-site approval console wiring in the Regina lane.",
        scope: "/repo/kapelle-site/wave18-regina",
      },
      {
        wave: "wave18",
        agent: "roger",
        title: "wave18 roger audit - kapelle-site orchestration telemetry",
        body: "Audit kapelle-site orchestration telemetry from the Roger lane.",
        scope: "/repo/kapelle-site/wave18-roger",
      },
    ];
    for (let i = 0; i < explicitRows.length; i++) {
      const row = explicitRows[i];
      await seedBuildItem(i, {
        title: row.title,
        track: "T-UI",
        to_agent: row.agent,
        dispatch_body: `[${row.wave}] ${row.body}`,
        write_scope: [row.scope],
      });
    }
    const { daemon, fired } = makeDaemon({
      config: { max_in_flight: 10 },
      pools: buildPoolRouting({ BUILD_POOL_FRONTEND_MAX_PARALLEL: "6" }),
    });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    expect(fired.map((i) => i.to_agent).sort()).toEqual(explicitRows.map((row) => row.agent).sort());
    expect(fired.flatMap((i) => i.write_scope).every((s) => !s.includes("/.worktrees/"))).toBe(true);
    expect(fired.flatMap((i) => i.write_scope).every((s) => s.includes("kapelle-site"))).toBe(true);
    expect(tick.decisions.some((d) => d.reason?.includes("pool frontend"))).toBe(false);
    expect(tick.decisions.some((d) => d.reason?.includes("pool backend"))).toBe(false);
  });

  it("a backend-track tick fires to the maintained backend Codex lanes", async () => {
    // Wire the REAL seed router (not the fake) so this proves the live routing
    // table. Legacy local Claude builder names were removed from the seed pool
    // after they stopped being heartbeat-backed; the current live backend lanes
    // are roger + the two substrate Codex builders.
    // Width-5 here proves env tuning does not invent unavailable members.
    for (let i = 0; i < 5; i++) await seedBuildItem(i);
    const { daemon, fired } = makeDaemon({
      config: { max_in_flight: 10 },
      pools: buildPoolRouting({ BUILD_POOL_BACKEND_MAX_PARALLEL: "5" }),
    });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    const builders = new Set(fired.map((i) => i.to_agent));
    // The operator's verify signal: decision log shows pool backend → live lanes.
    expect(builders).toEqual(new Set(["roger", "substrate-orch-codex", "substrate-api-codex"]));
    // Every fire is a backend-pool decision naming its builder + worktree.
    const poolFires = tick.decisions.filter((d) => d.reason?.includes("pool backend →"));
    expect(poolFires.length).toBe(3);
    for (const name of ["roger", "substrate-orch-codex", "substrate-api-codex"]) {
      expect(poolFires.some((d) => d.reason?.includes(`→ ${name} `))).toBe(true);
    }
  });

  it("frontend pool skips an expired Regina lane and selects healthy codex/cursor capacity", async () => {
    await seedBuildItem(0, {
      title: "Kapelle P1 - frontend source metadata rendering",
      track: "T-UI",
      to_agent: "pool:frontend",
      dispatch_body: "Patch kapelle-site /ops source metadata rendering.",
      write_scope: ["/repo/kapelle-site"],
    });
    const { daemon, fired } = makeDaemon({
      config: { max_in_flight: 10 },
      pools: buildPoolRouting({ BUILD_POOL_FRONTEND_MAX_PARALLEL: "6" }),
      healthyAgents: new Set(["frontend-ui-codex", "frontend-qa-cursor"]),
    });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    expect(fired).toHaveLength(1);
    expect(["frontend-ui-codex", "frontend-qa-cursor"]).toContain(fired[0].to_agent);
    expect(fired[0].to_agent).not.toBe("regina");
    const dispatch = tick.decisions.find((d) => d.action === "dispatched");
    expect(dispatch?.metadata?.lane_blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "regina",
          code: "target_unhealthy",
          reason: "agent is not healthy/online",
        }),
      ]),
    );
  });

  it("frontend pool does not keep selecting overloaded Regina when codex/cursor lanes are free", async () => {
    const busy = await seedBuildItem(0, {
      title: "Kapelle P1 - existing Regina build",
      track: "T-UI",
      to_agent: "pool:frontend",
      dispatch_body: "Existing frontend build.",
      write_scope: ["/repo/kapelle-site/.worktrees/regina-busy"],
    });
    await setItemState(adapter, busy.item_id, "in_flight", { dispatch_phid: "phid:disp-regina-busy" });
    await adapter.query(`UPDATE orchestration_backlog_item SET to_agent = $1 WHERE item_id = $2`, ["regina", busy.item_id]);
    await completeDispatch("phid:disp-regina-busy", "active");
    await seedBuildItem(1, {
      title: "Kapelle P1 - next frontend capacity build",
      track: "T-UI",
      to_agent: "pool:frontend",
      dispatch_body: "Use available frontend pool capacity.",
      write_scope: ["/repo/kapelle-site"],
    });
    const { daemon, fired } = makeDaemon({
      config: { max_in_flight: 10 },
      pools: buildPoolRouting({ BUILD_POOL_FRONTEND_MAX_PARALLEL: "6" }),
      healthyAgents: new Set(["regina", "frontend-ui-codex", "frontend-qa-cursor"]),
    });
    await daemon.setMode("running");

    const tick = await daemon.runTick();

    expect(fired).toHaveLength(1);
    expect(["frontend-ui-codex", "frontend-qa-cursor"]).toContain(fired[0].to_agent);
    expect(fired[0].to_agent).not.toBe("regina");
    const dispatch = tick.decisions.find((d) => d.action === "dispatched");
    expect(dispatch?.metadata?.lane_blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "regina",
          code: "lane_busy",
          reason: "builder already has an in-flight pool item",
        }),
      ]),
    );
  });

  it("default backend width is bounded by available maintained backend lanes", async () => {
    for (let i = 0; i < 6; i++) await seedBuildItem(i);
    const { daemon, fired } = makeDaemon({
      config: { max_in_flight: 10 },
      pools: buildPoolRouting({}), // seed default
    });
    await daemon.setMode("running");
    await daemon.runTick();

    expect(fired).toHaveLength(3);
    expect(new Set(fired.map((i) => i.to_agent)).size).toBe(3); // 3 DISTINCT maintained builders
  });
});
