// Pure guardrail core: ordering, cadence, admission, stall detection.

import { describe, it, expect } from "vitest";
import {
  orderCandidates,
  fairInterleaveByLane,
  needsRefuel,
  readyFuel,
  laneKeyOf,
} from "../../src/continuous-orchestration/selection.js";
import { isLoadPoint, tickAdmitLimit, localHHmm } from "../../src/continuous-orchestration/cadence.js";
import {
  planAdmission,
  evaluateStall,
  shouldRunZeroAdmitStallWatchdog,
  type AdmissionContext,
} from "../../src/continuous-orchestration/admission.js";
import { buildAdmissionBreakdown } from "../../src/continuous-orchestration/daemon.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";

let seq = 0;
function item(over: Partial<BacklogItem> = {}): BacklogItem {
  seq += 1;
  return {
    item_id: over.item_id ?? `it${seq}`,
    team_id: "default",
    title: `item ${seq}`,
    track: "T-X",
    to_agent: "roger",
    dispatch_body: "do the thing",
    priority: 5,
    value_score: null,
    readiness_state: "ready",
    risk_class: "build",
    write_scope: [],
    dependencies: [],
    token_estimate: 0,
    provider: null,
    runtime: null,
    is_north_star: false,
    source_refs: [],
    approved_by: "chris",
    approved_at: "2026-06-17T00:00:00Z",
    last_dispatch_phid: null,
    track_drift: false,
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
    ...over,
  };
}

const okGate: UsageGateView = { hard_paused: false, daily_percent: 10, weekly_percent: 5, enforcement: "enforce" };

function ctx(over: Partial<AdmissionContext> = {}): AdmissionContext {
  return {
    mode: "running",
    kill_switch_active: false,
    usage: okGate,
    daily_tokens_used: 0,
    in_flight: 0,
    active_write_scopes: new Set(),
    done_item_ids: new Set(),
    admit_limit: 5,
    ...over,
  };
}

describe("orderCandidates", () => {
  it("ranks north-star, then priority, then value, then oldest", () => {
    const a = item({ item_id: "a", priority: 3, created_at: "2026-06-17T02:00:00Z" });
    const b = item({ item_id: "b", priority: 1, created_at: "2026-06-17T03:00:00Z" });
    const c = item({ item_id: "c", priority: 1, created_at: "2026-06-17T01:00:00Z" });
    const ns = item({ item_id: "ns", priority: 9, is_north_star: true });
    const ordered = orderCandidates([a, b, c, ns]).map((i) => i.item_id);
    expect(ordered).toEqual(["ns", "c", "b", "a"]); // ns first; c before b (older); a last (pri 3)
  });
});

describe("laneKeyOf", () => {
  it("treats equal write_scope sets as one lane regardless of order", () => {
    expect(laneKeyOf(item({ write_scope: ["a", "b"] }))).toBe(laneKeyOf(item({ write_scope: ["b", "a"] })));
  });
  it("buckets scope-less items under a single shared lane", () => {
    expect(laneKeyOf(item({ write_scope: [] }))).toBe(laneKeyOf(item({ write_scope: [] })));
    expect(laneKeyOf(item({ write_scope: [] }))).not.toBe(laneKeyOf(item({ write_scope: ["x"] })));
  });
});

describe("fairInterleaveByLane", () => {
  it("returns single-lane input unchanged", () => {
    const items = [
      item({ item_id: "a", write_scope: ["repo/x"] }),
      item({ item_id: "b", write_scope: ["repo/x"] }),
    ];
    expect(fairInterleaveByLane(items).map((i) => i.item_id)).toEqual(["a", "b"]);
  });

  it("round-robins across lanes so one lane can't monopolize the prefix", () => {
    // Priority order: 3 from lane A, then 1 from lane B.
    const ordered = [
      item({ item_id: "a1", write_scope: ["A"] }),
      item({ item_id: "a2", write_scope: ["A"] }),
      item({ item_id: "a3", write_scope: ["A"] }),
      item({ item_id: "b1", write_scope: ["B"] }),
    ];
    // B surfaces in slot 2 instead of being buried behind all of A.
    expect(fairInterleaveByLane(ordered).map((i) => i.item_id)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("preserves the globally-top item (North Star stays first) + within-lane order", () => {
    const ns = item({ item_id: "ns", write_scope: ["A"], is_north_star: true });
    const ordered = orderCandidates([
      item({ item_id: "a2", write_scope: ["A"], priority: 5 }),
      item({ item_id: "b1", write_scope: ["B"], priority: 2 }),
      ns,
    ]);
    const fair = fairInterleaveByLane(ordered).map((i) => i.item_id);
    expect(fair[0]).toBe("ns"); // North Star still leads
    expect(fair).toEqual(["ns", "b1", "a2"]); // lane A: ns before a2 preserved
  });

  it("is a no-op for empty input", () => {
    expect(fairInterleaveByLane([])).toEqual([]);
  });
});

describe("admission picks lane-diverse items (fair order + pool gate)", () => {
  const cfg = { ...defaultConfig(), max_in_flight: 5 };
  const lanePool = (over: Partial<AdmissionContext> = {}): Partial<AdmissionContext> => ({
    pool_for: (it) => laneKeyOf(it), // each lane is its own pool (capacity-gated, not single-writer)
    pool_free_slots: new Map([
      [laneKeyOf(item({ write_scope: ["A"] })), 9],
      [laneKeyOf(item({ write_scope: ["B"] })), 9],
    ]),
    pool_free_builders: new Map([
      [laneKeyOf(item({ write_scope: ["A"] })), ["ra1", "ra2", "ra3"]],
      [laneKeyOf(item({ write_scope: ["B"] })), ["rb1", "rb2", "rb3"]],
    ]),
    ...over,
  });

  it("admits one item per lane under a slot cap (vs raw greedy = same-lane)", () => {
    const items = [
      item({ item_id: "a1", write_scope: ["A"] }),
      item({ item_id: "a2", write_scope: ["A"] }),
      item({ item_id: "a3", write_scope: ["A"] }),
      item({ item_id: "b1", write_scope: ["B"] }),
    ];
    // Raw greedy order would admit two from lane A.
    const greedy = planAdmission(items, ctx({ admit_limit: 2, ...lanePool() }), cfg);
    expect(greedy.admit.map((i) => i.item_id)).toEqual(["a1", "a2"]);
    // Fair order admits one from each lane — lane-diverse.
    const fair = planAdmission(fairInterleaveByLane(items), ctx({ admit_limit: 2, ...lanePool() }), cfg);
    expect(fair.admit.map((i) => i.item_id)).toEqual(["a1", "b1"]);
  });
});

describe("parallel-fuel floor (needsRefuel / readyFuel)", () => {
  it("readyFuel counts total + distinct lanes", () => {
    const ready = [
      item({ write_scope: ["A"] }),
      item({ write_scope: ["A"] }),
      item({ write_scope: ["B"] }),
    ];
    expect(readyFuel(ready)).toEqual({ total: 3, lanes: 2 });
  });

  it("refuels when total fuel is short", () => {
    const ready = [item({ write_scope: ["A"] })];
    expect(needsRefuel(ready, { minReadyFuel: 8, minReadyLanes: 1 })).toBe(true);
  });

  it("refuels when lane diversity is short even if the total is fine", () => {
    const ready = Array.from({ length: 10 }, () => item({ write_scope: ["A"] }));
    // total 10 >= 8, but only 1 lane < 2 required → still refuel.
    expect(needsRefuel(ready, { minReadyFuel: 8, minReadyLanes: 2 })).toBe(true);
  });

  it("does NOT refuel when both total and lane floors are satisfied", () => {
    const ready = [
      ...Array.from({ length: 5 }, () => item({ write_scope: ["A"] })),
      ...Array.from({ length: 5 }, () => item({ write_scope: ["B"] })),
    ];
    expect(needsRefuel(ready, { minReadyFuel: 8, minReadyLanes: 2 })).toBe(false);
  });

  it("lane floor of 1 is a no-op (total-only refuel)", () => {
    const ready = Array.from({ length: 10 }, () => item({ write_scope: ["A"] }));
    expect(needsRefuel(ready, { minReadyFuel: 8, minReadyLanes: 1 })).toBe(false);
  });
});

describe("cadence", () => {
  const cfg = { ...defaultConfig(), cadence_load_points: ["07:15", "12:30", "15:30"], timezone: "America/Chicago" };
  // 2026-06-17 12:30 America/Chicago = 17:30 UTC (CDT, -5).
  const at1230 = Date.parse("2026-06-17T17:30:00Z");
  const at1300 = Date.parse("2026-06-17T18:00:00Z");

  it("localHHmm formats in tz", () => {
    expect(localHHmm(at1230, "America/Chicago")).toBe("12:30");
  });
  it("detects a batch load-point", () => {
    expect(isLoadPoint(at1230, cfg)).toBe(true);
    expect(isLoadPoint(at1300, cfg)).toBe(false);
  });
  it("admit limit fills to max_in_flight on EVERY tick (T-ORCH P0 continuous)", () => {
    const c = { ...cfg, max_in_flight: 4, max_new_per_tick: 1 };
    // Continuous: both a load-point and an off-load-point tick may refill the
    // lane up to the in-flight cap (slotsFree applies the real headroom).
    expect(tickAdmitLimit(at1230, c)).toBe(4);
    expect(tickAdmitLimit(at1300, c)).toBe(4);
  });
  it("admit limit never drops below the max_new_per_tick floor", () => {
    const c = { ...cfg, max_in_flight: 0, max_new_per_tick: 2 };
    expect(tickAdmitLimit(at1300, c)).toBe(2);
  });
});

describe("planAdmission — halts", () => {
  const cfg = defaultConfig();
  it("halts on kill switch (wins over everything)", () => {
    const p = planAdmission([item()], ctx({ kill_switch_active: true }), cfg);
    expect(p.halt?.reason).toMatch(/kill switch/);
    expect(p.admit).toHaveLength(0);
  });
  it("halts when not running", () => {
    for (const mode of ["paused", "drain_only", "approve_only", "stopped"] as const) {
      const p = planAdmission([item()], ctx({ mode }), cfg);
      expect(p.halt?.halted).toBe(true);
    }
  });
  it("halts when the usage gate is hard-paused", () => {
    const p = planAdmission([item()], ctx({ usage: { ...okGate, hard_paused: true } }), cfg);
    expect(p.halt?.reason).toMatch(/hard-paused/);
  });
  it("halts at the daily token ceiling", () => {
    const p = planAdmission([item()], ctx({ daily_tokens_used: cfg.daily_token_ceiling }), cfg);
    expect(p.halt?.reason).toMatch(/ceiling/);
  });
});

describe("planAdmission — per-item guardrails", () => {
  const cfg = { ...defaultConfig(), max_in_flight: 5 };

  it("admits ready routine/build items up to the cap", () => {
    const p = planAdmission([item(), item(), item()], ctx({ admit_limit: 2 }), cfg);
    expect(p.admit).toHaveLength(2);
    expect(p.skipped[0].reason).toMatch(/tick admission cap/);
    expect(p.skipped[0].metadata?.code).toBe("tick_admission_cap");
  });

  it("admits a ready build item with no blockers when in_flight is below max_in_flight", () => {
    const p = planAdmission([item({ item_id: "ready-build", risk_class: "build" })], ctx({ in_flight: 3 }), {
      ...cfg,
      max_in_flight: 4,
    });
    expect(p.admit.map((i) => i.item_id)).toEqual(["ready-build"]);
    expect(p.skipped).toHaveLength(0);
  });

  it("respects free in-flight slots over the admit limit", () => {
    const p = planAdmission([item(), item()], ctx({ in_flight: 4, admit_limit: 5 }), cfg);
    expect(p.admit).toHaveLength(1); // only 1 slot free (5-4)
  });

  it("breaks down a ready lane stuck on capacity while another item is admitting", () => {
    const ready = item({ item_id: "ready-capacity", to_agent: "roger" });
    const admitting = item({ item_id: "in-flight", readiness_state: "in_flight", to_agent: "roger" });
    const p = planAdmission([ready], ctx({ in_flight: 5, admit_limit: 5 }), cfg);

    const breakdown = buildAdmissionBreakdown({
      ready: [ready],
      admitting: [admitting],
      plan: p,
      generated_at: "2026-07-10T00:00:00.000Z",
    });

    expect(breakdown).toMatchObject({
      ready_count: 1,
      admitting_count: 1,
      lanes: [
        {
          lane: "roger",
          ready_count: 1,
          admitting_count: 1,
          stuck_reason: "no_in_flight_slots",
          block_reason_counts: { no_in_flight_slots: 1 },
        },
      ],
    });
  });

  it("holds risky classes for approval", () => {
    const p = planAdmission([item({ risk_class: "external" }), item({ risk_class: "destructive" })], ctx(), cfg);
    expect(p.admit).toHaveLength(0);
    expect(p.skipped.every((s) => /requires approval/.test(s.reason))).toBe(true);
  });

  it("blocks items with unresolved dependencies", () => {
    const p = planAdmission([item({ dependencies: ["dep1"] })], ctx(), cfg);
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/dependency not done/);
    expect(p.skipped[0].metadata?.code).toBe("blocked_dependency");
    const p2 = planAdmission([item({ dependencies: ["dep1"] })], ctx({ done_item_ids: new Set(["dep1"]) }), cfg);
    expect(p2.admit).toHaveLength(1);
  });

  it("enforces single-writer lanes (write-scope conflict)", () => {
    const a = item({ item_id: "a", write_scope: ["repo/x"] });
    const b = item({ item_id: "b", write_scope: ["repo/x"] });
    const p = planAdmission([a, b], ctx({ admit_limit: 5 }), cfg);
    expect(p.admit.map((i) => i.item_id)).toEqual(["a"]); // b skipped, lane busy
    expect(p.skipped[0].reason).toMatch(/single-writer lane busy/);
  });

  it("skips when scope is already locked by an in-flight dispatch", () => {
    const p = planAdmission([item({ write_scope: ["repo/y"] })], ctx({ active_write_scopes: new Set(["repo/y"]) }), cfg);
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].metadata?.code).toBe("single_writer_lane_busy");
  });

  it("enforces the token ceiling per-item across the tick", () => {
    const c = { ...cfg, daily_token_ceiling: 100 };
    const a = item({ item_id: "a", token_estimate: 60 });
    const b = item({ item_id: "b", token_estimate: 60 });
    const p = planAdmission([a, b], ctx({ admit_limit: 5 }), c);
    expect(p.admit.map((i) => i.item_id)).toEqual(["a"]); // a=60 ok; a+b=120 > 100
    expect(p.skipped[0].reason).toMatch(/would exceed daily token ceiling/);
  });

  it("skips ready items missing a dispatch body or agent", () => {
    const p = planAdmission([item({ dispatch_body: null })], ctx(), cfg);
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/missing to_agent or dispatch_body/);
  });

  it("labels at least five non-admission classes for zero-admit debugging", () => {
    const cases = [
      {
        name: "risk_class",
        plan: planAdmission([item({ risk_class: "external" })], ctx(), cfg),
        code: "risk_requires_approval",
      },
      {
        name: "blocked_dependency",
        plan: planAdmission([item({ dependencies: ["dep1"] })], ctx(), cfg),
        code: "blocked_dependency",
      },
      {
        name: "agent_availability",
        plan: planAdmission([item({ to_agent: "offline" })], ctx({ healthy_agents: new Set(["roger"]) }), cfg),
        code: "target_unhealthy",
      },
      {
        name: "write_scope_lock",
        plan: planAdmission([item({ write_scope: ["repo/busy"] })], ctx({ active_write_scopes: new Set(["repo/busy"]) }), cfg),
        code: "single_writer_lane_busy",
      },
      {
        name: "config_cap",
        plan: planAdmission([item()], ctx({ in_flight: 5 }), cfg),
        code: "no_in_flight_slots",
      },
    ];

    for (const c of cases) {
      expect(c.plan.admit, c.name).toHaveLength(0);
      expect(c.plan.skipped[0].metadata).toMatchObject({ code: c.code, class: c.name });
    }
  });

  it("holds rows with provider/runtime incompatible with the target lane", () => {
    const p = planAdmission(
      [item({ to_agent: "substrate-orch-codex", provider: "anthropic", runtime: "claude-code-cli" })],
      ctx({ target_agent_runtimes: new Map([["substrate-orch-codex", "codex"]]) }),
      cfg,
    );
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0]).toMatchObject({
      action: "held",
      metadata: { code: "provider_runtime_mismatch", class: "provider_runtime" },
    });
  });

  it("holds Codex-stamped rows targeting a Claude lane until runtime metadata is reconciled", () => {
    const p = planAdmission(
      [item({ to_agent: "cto", provider: "openai", runtime: "codex" })],
      ctx({ target_agent_runtimes: new Map([["cto", "claude-code-cli"]]) }),
      cfg,
    );
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0]).toMatchObject({
      action: "held",
      metadata: {
        code: "provider_runtime_mismatch",
        class: "provider_runtime",
        target: "cto",
        target_runtime: "claude-code-cli",
        target_provider: "anthropic",
      },
    });
  });

  it("holds rows blocked by active clarification or promotion blockers", () => {
    const clarification = planAdmission(
      [item({ item_id: "needs-answer" })],
      ctx({
        ready_item_blockers: new Map([
          ["needs-answer", { code: "clarification_blocker", reason: "needs clarification: Which merge strategy?" }],
        ]),
      }),
      cfg,
    );
    expect(clarification.skipped[0].metadata).toMatchObject({
      code: "clarification_blocker",
      class: "clarification_blocker",
    });

    const promotion = planAdmission(
      [item({ item_id: "needs-promotion" })],
      ctx({
        ready_item_blockers: new Map([
          ["needs-promotion", { code: "promotion_blocker", reason: "missing promotion result" }],
        ]),
      }),
      cfg,
    );
    expect(promotion.skipped[0].metadata).toMatchObject({
      code: "promotion_blocker",
      class: "promotion_blocker",
    });
  });

  it("breaks raw ready down into admissible now and exact post-guardrail block reasons", () => {
    const cfg = { ...defaultConfig(), max_in_flight: 10 };
    const ready = [
      item({ item_id: "admissible", write_scope: ["repo/free"] }),
      item({ item_id: "blocked-dep", dependencies: ["missing"], write_scope: ["repo/dep"] }),
      item({ item_id: "needs-approval", risk_class: "external", write_scope: ["repo/risk"] }),
      item({ item_id: "busy-lane", write_scope: ["repo/busy"] }),
      item({ item_id: "pool-full", write_scope: ["repo/pool-full"] }),
      item({ item_id: "no-builder", write_scope: ["repo/no-builder"] }),
    ];

    const plan = planAdmission(
      ready,
      ctx({
        active_write_scopes: new Set(["repo/busy"]),
        pool_for: (candidate) => {
          if (candidate.item_id === "pool-full") return "full-pool";
          if (candidate.item_id === "no-builder") return "empty-builder-pool";
          return null;
        },
        pool_free_slots: new Map([
          ["full-pool", 0],
          ["empty-builder-pool", 1],
        ]),
        pool_free_builders: new Map([
          ["full-pool", ["builder-a"]],
          ["empty-builder-pool", []],
        ]),
      }),
      cfg,
    );

    const breakdown = Object.fromEntries(
      Object.entries(
        plan.skipped.reduce<Record<string, number>>((counts, decision) => {
          const code = String(decision.metadata?.code ?? "unknown");
          counts[code] = (counts[code] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([a], [b]) => a.localeCompare(b)),
    );
    const blockedTotal = Object.values(breakdown).reduce((sum, count) => sum + count, 0);

    expect(plan.admit.map((candidate) => candidate.item_id)).toEqual(["admissible"]);
    expect(breakdown).toEqual({
      blocked_dependency: 1,
      no_free_pool_builder: 1,
      pool_capacity_full: 1,
      risk_requires_approval: 1,
      single_writer_lane_busy: 1,
    });
    expect(blockedTotal).toBe(ready.length - plan.admit.length);
  });

  it("never admits a non-ready item even if passed in", () => {
    const p = planAdmission([item({ readiness_state: "needs_review" })], ctx(), cfg);
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/not ready/);
  });
});

// RD-014: the admission daemon previously fired dispatches to a lane with no
// live check that the target runtime was actually up — root cause of the
// pending-lane cascade (+149 failed dispatches in one overnight wave per the
// routing audit). These prove the gate rejects an unhealthy target and still
// lets a healthy candidate through in the same tick.
describe("planAdmission — RD-014 agent-health gate", () => {
  const cfg = { ...defaultConfig(), max_in_flight: 5 };

  it("rejects a non-pool item whose to_agent is not in healthy_agents, with a clear reason", () => {
    const p = planAdmission(
      [item({ to_agent: "gaudi" })],
      ctx({ admit_limit: 5, healthy_agents: new Set(["roger"]) }),
      cfg,
    );
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/target agent 'gaudi' is not healthy/);
  });

  it("admits a non-pool item whose to_agent IS in healthy_agents", () => {
    const p = planAdmission(
      [item({ to_agent: "roger" })],
      ctx({ admit_limit: 5, healthy_agents: new Set(["roger"]) }),
      cfg,
    );
    expect(p.admit).toHaveLength(1);
  });

  it("does not health-gate at all when healthy_agents is undefined (resolver unavailable — pre-RD-014 fallback)", () => {
    const p = planAdmission([item({ to_agent: "nobody-knows-this-agent" })], ctx({ admit_limit: 5 }), cfg);
    expect(p.admit).toHaveLength(1);
  });

  it("a candidate with an unhealthy target does not block a healthy candidate later in the same tick", () => {
    const unhealthy = item({ item_id: "a", to_agent: "gaudi" });
    const healthy = item({ item_id: "b", to_agent: "roger" });
    const p = planAdmission(
      [unhealthy, healthy],
      ctx({ admit_limit: 5, healthy_agents: new Set(["roger"]) }),
      cfg,
    );
    expect(p.admit.map((i) => i.item_id)).toEqual(["b"]);
    expect(p.skipped[0].item_id).toBe("a");
  });

  it("rejects a POOL item whose assigned builder is not healthy", () => {
    const p = planAdmission(
      [item({ item_id: "pool-item", write_scope: [] })],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["substrate-api-codex"]]]),
        healthy_agents: new Set(["roger"]), // substrate-api-codex is NOT healthy
      }),
      cfg,
    );
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/target agent 'substrate-api-codex' is not healthy/);
  });

  it("admits a POOL item whose assigned builder IS healthy", () => {
    const p = planAdmission(
      [item({ item_id: "pool-item", write_scope: [] })],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["roger"]]]),
        healthy_agents: new Set(["roger"]),
      }),
      cfg,
    );
    expect(p.admit).toHaveLength(1);
    expect(p.assignments["pool-item"]).toBe("roger");
  });
});

describe("evaluateStall", () => {
  const cfg = { ...defaultConfig(), stall_threshold_ticks: 3 };
  it("counts consecutive zero-dispatch ticks with work available", () => {
    let z = 0;
    let r = evaluateStall(z, { mode: "running", halted: false, candidates_available: 2, admitted: 0 }, cfg);
    expect(r).toEqual({ zero_ticks: 1, alert: false });
    r = evaluateStall(r.zero_ticks, { mode: "running", halted: false, candidates_available: 2, admitted: 0 }, cfg);
    r = evaluateStall(r.zero_ticks, { mode: "running", halted: false, candidates_available: 2, admitted: 0 }, cfg);
    expect(r).toEqual({ zero_ticks: 3, alert: true }); // loud alert at threshold
  });
  it("resets when a dispatch fires", () => {
    const r = evaluateStall(2, { mode: "running", halted: false, candidates_available: 5, admitted: 1 }, cfg);
    expect(r).toEqual({ zero_ticks: 0, alert: false });
  });
  it("does not count idle (no candidates) or halted ticks as a stall", () => {
    expect(evaluateStall(2, { mode: "running", halted: false, candidates_available: 0, admitted: 0 }, cfg).zero_ticks).toBe(0);
    expect(evaluateStall(2, { mode: "running", halted: true, candidates_available: 9, admitted: 0 }, cfg).zero_ticks).toBe(0);
    expect(evaluateStall(2, { mode: "paused", halted: true, candidates_available: 9, admitted: 0 }, cfg).zero_ticks).toBe(0);
  });
});

describe("shouldRunZeroAdmitStallWatchdog", () => {
  const cfg = { ...defaultConfig(), stall_threshold_ticks: 3, min_ready_fuel: 8 };

  it("trips only at the zero-admit threshold while admissible ready fuel is below floor", () => {
    expect(shouldRunZeroAdmitStallWatchdog(2, 3, cfg)).toBe(false);
    expect(shouldRunZeroAdmitStallWatchdog(3, 8, cfg)).toBe(false);
    expect(shouldRunZeroAdmitStallWatchdog(3, 7, cfg)).toBe(true);
    expect(shouldRunZeroAdmitStallWatchdog(24, 3, cfg)).toBe(true);
  });

  it("treats a full raw READY queue as below floor when zero items are admissible", () => {
    expect(shouldRunZeroAdmitStallWatchdog(174, 0, cfg)).toBe(true);
  });
});
