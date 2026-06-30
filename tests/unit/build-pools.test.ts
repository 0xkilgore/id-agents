// Build-pools lib — selection + registry (CTO build-pool spec, Stage A).

import { describe, it, expect } from "vitest";
import { BuildPoolRegistry } from "../../src/build-pools/registry.js";
import {
  CODEX_ONLY_LOAD_LOOP_ALLOWED_AGENTS,
  selectBuilder,
  isOnline,
  isAvailable,
} from "../../src/build-pools/select.js";
import type { BuildPool, BuilderSlot } from "../../src/build-pools/types.js";

const NOW = new Date("2026-06-23T20:00:00.000Z");
const FRESH = "2026-06-23T19:59:00.000Z"; // 1m ago — online
const STALE = "2026-06-23T19:40:00.000Z"; // 20m ago — offline (>10m window)

function slot(agent: string, over: Partial<BuilderSlot> = {}): BuilderSlot {
  return {
    agent,
    pool_id: "backend",
    state: "idle",
    abi_healthy: true,
    current_dispatch_id: null,
    current_lease_id: null,
    last_assigned_at: null,
    last_seen_at: FRESH,
    ...over,
  };
}

const pool: BuildPool = {
  pool_id: "backend",
  repo_alias: "id-agents",
  repo_root: "/r",
  members: ["roger", "brunel", "hopper"],
  tracks: ["T-ORCH", "T-CKPT"],
  max_parallel: 3,
  merge_strategy: "auto",
};

describe("selectBuilder", () => {
  it("prefers the primary owner (members order) when all idle", () => {
    const slots = [slot("hopper"), slot("brunel"), slot("roger")];
    expect(selectBuilder(pool, slots, { now: NOW })).toBe("roger");
  });

  it("spills to the next member when the primary is busy (late binding)", () => {
    const slots = [slot("roger", { state: "building" }), slot("brunel"), slot("hopper")];
    expect(selectBuilder(pool, slots, { now: NOW })).toBe("brunel");
  });

  it("returns null when no member is available (pool exhausted)", () => {
    const slots = [
      slot("roger", { state: "building" }),
      slot("brunel", { state: "promoting" }),
      slot("hopper", { state: "offline" }),
    ];
    expect(selectBuilder(pool, slots, { now: NOW })).toBeNull();
  });

  it("excludes ABI-unhealthy members (fail-loud safety, spec §8/acceptance 8)", () => {
    const slots = [slot("roger", { abi_healthy: false }), slot("brunel"), slot("hopper")];
    expect(selectBuilder(pool, slots, { now: NOW })).toBe("brunel");
  });

  it("excludes stale (offline) members by heartbeat window", () => {
    const slots = [slot("roger", { last_seen_at: STALE }), slot("brunel"), slot("hopper")];
    expect(selectBuilder(pool, slots, { now: NOW })).toBe("brunel");
  });

  it("tie-breaks least-recently-assigned among equal-preference idle members", () => {
    // Drop the primary so brunel(idx1) vs hopper(idx2): preference would pick
    // brunel, so to test LRU we compare two members at the SAME preference by
    // using a pool where order doesn't decide. Use a flat-preference scenario:
    const flat: BuildPool = { ...pool, members: ["a", "b"] };
    const slots = [
      slot("a", { pool_id: "backend", last_assigned_at: "2026-06-23T19:00:00.000Z" }),
      slot("b", { pool_id: "backend", last_assigned_at: "2026-06-23T18:00:00.000Z" }),
    ];
    // a is earlier in members order, so preference picks a regardless of LRU:
    expect(selectBuilder(flat, slots, { now: NOW })).toBe("a");
    // With a busy, b is the only choice:
    const slots2 = [slot("a", { state: "building" }), slot("b")];
    expect(selectBuilder(flat, slots2, { now: NOW })).toBe("b");
  });

  it("ignores slots from a different pool", () => {
    const slots = [slot("roger", { pool_id: "frontend" }), slot("brunel")];
    expect(selectBuilder(pool, slots, { now: NOW })).toBe("brunel");
  });

  it("single-member pool behaves like the old single lane (regression, acceptance 11)", () => {
    const solo: BuildPool = { ...pool, members: ["roger"], max_parallel: 1 };
    expect(selectBuilder(solo, [slot("roger")], { now: NOW })).toBe("roger");
    expect(selectBuilder(solo, [slot("roger", { state: "building" })], { now: NOW })).toBeNull();
  });

  it("is default-inert: normal frontend selection still picks Claude first when no runtime exclusion is supplied", () => {
    const frontend = BuildPoolRegistry.load({}).byId("frontend")!;
    const slots = frontend.members.map((agent) => slot(agent, { pool_id: "frontend" }));

    expect(selectBuilder(frontend, slots, { now: NOW })).toBe("regina");
  });

  it("supports an explicit Codex-only load-loop guard that excludes Claude/Anthropic/Cursor lanes", () => {
    const frontend = BuildPoolRegistry.load({}).byId("frontend")!;
    const frontendSlots = frontend.members.map((agent) => slot(agent, { pool_id: "frontend" }));

    expect(
      selectBuilder(frontend, frontendSlots, {
        now: NOW,
        allowedAgents: CODEX_ONLY_LOAD_LOOP_ALLOWED_AGENTS,
      }),
    ).toBe("frontend-ui-codex");

    const backend = BuildPoolRegistry.load({}).byId("backend")!;
    const backendSlots = backend.members.map((agent) => slot(agent));
    expect(
      selectBuilder(backend, backendSlots, {
        now: NOW,
        allowedAgents: CODEX_ONLY_LOAD_LOOP_ALLOWED_AGENTS,
      }),
    ).toBe("substrate-orch-codex");
  });

  it("returns null under Codex-only guard when only Claude/Anthropic/Cursor lanes are available", () => {
    const claudeAndCursorOnly: BuildPool = {
      ...pool,
      members: ["regina", "brunel", "frontend-qa-cursor"],
      pool_id: "frontend",
      repo_alias: "kapelle-site",
    };
    const slots = claudeAndCursorOnly.members.map((agent) => slot(agent, { pool_id: "frontend" }));

    expect(
      selectBuilder(claudeAndCursorOnly, slots, {
        now: NOW,
        allowedAgents: CODEX_ONLY_LOAD_LOOP_ALLOWED_AGENTS,
      }),
    ).toBeNull();
  });
});

describe("isOnline / isAvailable", () => {
  it("null/garbage last_seen_at => offline", () => {
    expect(isOnline(slot("x", { last_seen_at: null }), { now: NOW })).toBe(false);
    expect(isOnline(slot("x", { last_seen_at: "not-a-date" }), { now: NOW })).toBe(false);
  });
  it("respects a custom online window", () => {
    expect(isOnline(slot("x", { last_seen_at: STALE }), { now: NOW, onlineWindowMs: 60 * 60 * 1000 })).toBe(true);
  });
  it("isAvailable requires idle + abi_healthy + online", () => {
    expect(isAvailable(slot("x"), { now: NOW })).toBe(true);
    expect(isAvailable(slot("x", { state: "building" }), { now: NOW })).toBe(false);
    expect(isAvailable(slot("x", { abi_healthy: false }), { now: NOW })).toBe(false);
    expect(isAvailable(slot("x", { last_seen_at: STALE }), { now: NOW })).toBe(false);
  });
});

describe("BuildPoolRegistry", () => {
  it("seeds backend + frontend with confirmed backend tracks", () => {
    const r = BuildPoolRegistry.load({});
    expect(r.list().map((p) => p.pool_id).sort()).toEqual(["backend", "frontend"]);
    expect(r.byId("backend")!.tracks).toContain("T-CKPT");
    expect(r.byRepoAlias("kapelle-site")!.pool_id).toBe("frontend");
    expect(r.byId("backend")!.members[0]).toBe("roger");
  });

  it("pools seed maintained live lanes, not stopped legacy Claude builders", () => {
    const r = BuildPoolRegistry.load({});
    const backend = r.byId("backend")!;
    expect(backend.members).toEqual(["roger", "substrate-orch-codex", "substrate-api-codex"]);
    const resolved = r.resolvePool("T-CKPT.7")!;
    expect(resolved.pool_id).toBe("backend");
    expect(resolved.members).not.toEqual(expect.arrayContaining(["brunel", "hopper", "eames", "gaudi"]));
    // Snag #13: frontend pool widened with live idle Claude builders so frontend
    // builds fan out >2 wide instead of stalling on the 2 throttle-prone lanes.
    expect(r.byId("frontend")!.members).toEqual([
      "regina", "brunel", "eames", "gaudi", "hopper", "frontend-ui-codex", "frontend-qa-cursor",
    ]);
    expect(r.byId("frontend")!.max_parallel).toBe(6);
  });

  it("resolvePool matches by track prefix (longest wins); unknown => undefined", () => {
    const r = BuildPoolRegistry.load({});
    expect(r.resolvePool("T-CKPT.7")!.pool_id).toBe("backend");
    expect(r.resolvePool("T-UI.3")!.pool_id).toBe("frontend");
    expect(r.resolvePool("T-NOPE")).toBeUndefined();
  });

  it("max_parallel is env-tunable per pool; garbage ignored", () => {
    expect(BuildPoolRegistry.load({ BUILD_POOL_BACKEND_MAX_PARALLEL: "5" }).byId("backend")!.max_parallel).toBe(5);
    expect(BuildPoolRegistry.load({ BUILD_POOL_BACKEND_MAX_PARALLEL: "x" }).byId("backend")!.max_parallel).toBe(4);
    expect(BuildPoolRegistry.load({ BUILD_POOL_BACKEND_MAX_PARALLEL: "0" }).byId("backend")!.max_parallel).toBe(4);
  });
});
