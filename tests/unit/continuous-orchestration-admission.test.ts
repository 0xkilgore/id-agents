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
  isDeploySafeAdmissionItem,
  isDiskCleanupAdmissionItem,
  shouldRunZeroAdmitStallWatchdog,
  type AdmissionContext,
} from "../../src/continuous-orchestration/admission.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";
import type { DiskHeadroom, DiskHeadroomState } from "../../src/disk-health.js";

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
    retry_safe: false,
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
    dependency_index: new Map(),
    admit_limit: 5,
    ...over,
  };
}

function disk(state: DiskHeadroomState): DiskHeadroom {
  const GiB = 1024 ** 3;
  const availableGib = state === "critical" ? 4 : state === "warn" ? 8 : 20;
  return {
    schema_version: "disk-headroom.v1",
    state,
    path: "/tmp",
    free_bytes: availableGib * GiB,
    available_bytes: availableGib * GiB,
    total_bytes: 100 * GiB,
    free_gib: availableGib,
    available_gib: availableGib,
    total_gib: 100,
    used_percent: 92,
    min_free_bytes: 5 * GiB,
    warn_free_bytes: 10 * GiB,
    reason: state === "ok" ? null : `disk ${state}`,
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

  it("healthy disk admits ordinary build rows", () => {
    const p = planAdmission(
      [item({ item_id: "ordinary-build", title: "implement product feature" })],
      ctx({ disk_headroom: disk("ok") }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["ordinary-build"]);
    expect(p.skipped).toEqual([]);
  });

  it("warning disk admits only cleanup or deploy-safe rows and codes held rows", () => {
    const cleanup = item({ item_id: "cleanup", title: "Disk cleanup: prune old worktrees" });
    const deploySafe = item({ item_id: "deploy-safe", track: "T-DEPLOY", title: "Promote verified build to main" });
    const ordinary = item({ item_id: "ordinary", title: "Build new dashboard feature" });
    const warningDisk = disk("warn");

    expect(isDiskCleanupAdmissionItem(cleanup)).toBe(true);
    expect(isDeploySafeAdmissionItem(deploySafe)).toBe(true);
    expect(warningDisk.available_gib).toBeLessThan(10);

    const p = planAdmission(
      [cleanup, deploySafe, ordinary],
      ctx({ disk_headroom: warningDisk }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["cleanup", "deploy-safe"]);
    expect(p.skipped).toEqual([
      expect.objectContaining({
        item_id: "ordinary",
        action: "held",
        metadata: expect.objectContaining({
          code: "disk_warning_floor",
          class: "infra_resource",
          available_bytes: 8 * 1024 ** 3,
          warn_free_bytes: 10 * 1024 ** 3,
          cleanup_safe: false,
          deploy_safe: false,
        }),
      }),
    ]);
  });

  it("critical disk holds deploy-safe and ordinary rows but still admits cleanup", () => {
    const cleanup = item({ item_id: "cleanup", title: "ENOSPC cleanup pass" });
    const deploySafe = item({ item_id: "deploy-safe", track: "T-DEPLOY", title: "Deploy already verified build" });
    const ordinary = item({ item_id: "ordinary", title: "Implement build feature" });

    const p = planAdmission(
      [cleanup, deploySafe, ordinary],
      ctx({ disk_headroom: disk("critical") }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["cleanup"]);
    expect(p.skipped.map((s) => [s.item_id, s.metadata?.code])).toEqual([
      ["deploy-safe", "disk_critical_floor"],
      ["ordinary", "disk_critical_floor"],
    ]);
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

  it("excludes receipt-backed stale duplicate closeouts from useful fuel", () => {
    const ready = [
      item({ item_id: "fresh-ready", write_scope: ["A"] }),
      item({
        item_id: "done-duplicate",
        write_scope: ["B"],
        last_dispatch_phid: "phid:disp-landed",
        stale_duplicate_closeout_receipt: {
          schema_version: "orchestration.stale_duplicate_closeout_receipt.v1",
          closed_by: "operator",
          closed_at: "2026-07-15T12:00:00.000Z",
          from_state: "ready",
          to_state: "done",
          reason: "close_or_ignore",
          track: "T-ORCH",
          next_action: "close_duplicate_row",
          prior_dispatch_phid: "phid:disp-landed",
          prior_dispatch_status: "done",
          successor_dispatch_phid: null,
          redispatch_safety: {
            safe_to_not_redispatch: true,
            reason: "prior dispatch landed; row is stale duplicate fuel",
          },
        },
      }),
      item({
        item_id: "superseded-duplicate",
        write_scope: ["C"],
        last_dispatch_phid: "phid:disp-superseded",
        stale_duplicate_closeout_receipt: {
          schema_version: "orchestration.stale_duplicate_closeout_receipt.v1",
          closed_by: "operator",
          closed_at: "2026-07-15T12:01:00.000Z",
          from_state: "ready",
          to_state: "superseded",
          reason: "close_or_ignore",
          track: "T-ORCH",
          next_action: "supersede_duplicate_row",
          prior_dispatch_phid: "phid:disp-superseded",
          prior_dispatch_status: "superseded",
          successor_dispatch_phid: null,
          redispatch_safety: {
            safe_to_not_redispatch: true,
            reason: "prior dispatch was superseded; row is stale duplicate fuel",
          },
        },
      }),
    ];

    expect(readyFuel(ready)).toEqual({ total: 1, lanes: 1 });
    expect(needsRefuel(ready, { minReadyFuel: 2, minReadyLanes: 2 })).toBe(true);
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
  it("does not halt at the configured daily token reference", () => {
    const p = planAdmission([item()], ctx({ daily_tokens_used: cfg.daily_token_ceiling }), cfg);
    expect(p.halt).toBeNull();
    expect(p.admit).toHaveLength(1);
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

  it("holds risky classes for approval", () => {
    const p = planAdmission(
      [item({ risk_class: "external", approved_at: null }), item({ risk_class: "destructive", approved_at: null })],
      ctx(),
      cfg,
    );
    expect(p.admit).toHaveLength(0);
    expect(p.skipped.every((s) => /requires approval/.test(s.reason))).toBe(true);
  });

  it("BUG A regression: approved_at admits an item outside AUTO_RUN_RISK (2026-07-07 CTO scope stall)", () => {
    const p = planAdmission(
      [item({ risk_class: "novel", approved_at: "2026-07-07T00:00:00Z" })],
      ctx(),
      cfg,
    );
    expect(p.admit).toHaveLength(1);
  });

  it("BUG A regression: auto_ready_approved_at alone is also sufficient", () => {
    const p = planAdmission(
      [item({ risk_class: "novel", approved_at: null, auto_ready_approved_at: "2026-07-07T00:00:00Z" })],
      ctx(),
      cfg,
    );
    expect(p.admit).toHaveLength(1);
  });

  it("blocks items with unresolved dependencies", () => {
    const p = planAdmission([item({ dependencies: ["dep1"] })], ctx({ dependency_index: new Map([["dep1", false]]) }), cfg);
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/dependency not done/);
    expect(p.skipped[0].metadata?.code).toBe("blocked_dependency");
    const p2 = planAdmission([item({ dependencies: ["dep1"] })], ctx({ dependency_index: new Map([["dep1", true]]) }), cfg);
    expect(p2.admit).toHaveLength(1);
  });

  it("BUG B regression: dependency resolves by logical_key, not just item_id, when target is done", () => {
    const p = planAdmission(
      [item({ dependencies: ["T-ORCH-some-logical-key"] })],
      ctx({ dependency_index: new Map([["T-ORCH-some-logical-key", true]]) }),
      cfg,
    );
    expect(p.admit).toHaveLength(1);
  });

  it("BUG B regression: a dependency matching no known item is held as broken, not silently satisfied", () => {
    const p = planAdmission(
      [item({ dependencies: ["wave23-replaced-smoke-row-do-not-run"] })],
      ctx(),
      cfg,
    );
    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0].metadata?.code).toBe("broken_dependency");
    expect(p.skipped[0].action).toBe("held");
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

  it("does not put coordinator-only or artifact-only dispatches in the exclusive repo write lane", () => {
    const p = planAdmission(
      [
        item({ item_id: "coordinator", title: "coordinate backend work", risk_class: "routine", write_scope: [] }),
        item({ item_id: "artifact", title: "write handoff artifact", risk_class: "routine", write_scope: [] }),
        item({ item_id: "repo-build", write_scope: ["repo/kapelle"] }),
      ],
      ctx({ active_write_scopes: new Set(["repo/kapelle"]), admit_limit: 5 }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["coordinator", "artifact"]);
    expect(p.skipped).toEqual([
      expect.objectContaining({
        item_id: "repo-build",
        action: "skipped",
        reason: "single-writer lane busy: repo/kapelle",
      }),
    ]);
  });

  it("requires later-declared repo mutation intent to pass lane admission before writing", () => {
    const artifactOnly = item({
      item_id: "artifact-only",
      title: "draft output summary",
      risk_class: "routine",
      write_scope: [],
    });
    const declaresMutation = { ...artifactOnly, write_scope: ["repo/kapelle"] };

    const artifactPlan = planAdmission(
      [artifactOnly],
      ctx({ active_write_scopes: new Set(["repo/kapelle"]) }),
      cfg,
    );
    expect(artifactPlan.admit.map((i) => i.item_id)).toEqual(["artifact-only"]);

    const mutationPlan = planAdmission(
      [declaresMutation],
      ctx({ active_write_scopes: new Set(["repo/kapelle"]) }),
      cfg,
    );
    expect(mutationPlan.admit).toHaveLength(0);
    expect(mutationPlan.skipped).toEqual([
      expect.objectContaining({
        item_id: "artifact-only",
        action: "skipped",
        reason: "single-writer lane busy: repo/kapelle",
      }),
    ]);
  });

  it("does not enforce the token reference per-item across the tick", () => {
    const c = { ...cfg, daily_token_ceiling: 100 };
    const a = item({ item_id: "a", token_estimate: 60 });
    const b = item({ item_id: "b", token_estimate: 60 });
    const p = planAdmission([a, b], ctx({ admit_limit: 5 }), c);
    expect(p.admit.map((i) => i.item_id)).toEqual(["a", "b"]);
    expect(p.skipped).toHaveLength(0);
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
        plan: planAdmission([item({ risk_class: "external", approved_at: null })], ctx(), cfg),
        code: "risk_requires_approval",
      },
      {
        name: "blocked_dependency",
        plan: planAdmission([item({ dependencies: ["dep1"] })], ctx({ dependency_index: new Map([["dep1", false]]) }), cfg),
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
      {
        name: "retry_safety",
        plan: planAdmission([item({ last_dispatch_phid: "phid:disp-failed" })], ctx(), cfg),
        code: "duplicate_dispatch_retry_required",
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

  it("admits manual refuel rows that omit provider/runtime when the target lane is registered", () => {
    const p = planAdmission(
      [
        item({
          item_id: "wave53-manual-refuel-no-runtime",
          title: "Wave53 manual refuel row with legacy metadata",
          to_agent: "substrate-api-codex",
          provider: null,
          runtime: null,
        }),
      ],
      ctx({ target_agent_runtimes: new Map([["substrate-api-codex", "codex"]]) }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["wave53-manual-refuel-no-runtime"]);
    expect(p.skipped).toHaveLength(0);
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

  it("holds manually promoted already-dispatched rows unless explicitly marked retry-safe", () => {
    const unsafeRetry = planAdmission(
      [item({ item_id: "unsafe-retry", last_dispatch_phid: "phid:disp-failed" })],
      ctx(),
      cfg,
    );
    expect(unsafeRetry.admit).toHaveLength(0);
    expect(unsafeRetry.skipped[0]).toMatchObject({
      action: "held",
      metadata: {
        code: "duplicate_dispatch_retry_required",
        class: "retry_safety",
        last_dispatch_phid: "phid:disp-failed",
      },
    });

    const safeRetry = planAdmission(
      [item({ item_id: "safe-retry", last_dispatch_phid: "phid:disp-failed", retry_safe: true })],
      ctx(),
      cfg,
    );
    expect(safeRetry.admit.map((i) => i.item_id)).toEqual(["safe-retry"]);
  });

  it("still holds retryable failed duplicate rows until retry_safe is explicitly set", () => {
    const retryableFailed = item({
      item_id: "retryable-failed-duplicate",
      last_dispatch_phid: "phid:disp-retryable-failed",
      retry_readiness: {
        schema_version: "backlog.retry_readiness.v1",
        status: "retryable_failed_row",
        retryable: true,
        stale_duplicate: false,
        manual_promote_required: true,
        reason: "prior dispatch failed with retryable transient evidence",
        next_action: "retry",
        prior_dispatch_phid: "phid:disp-retryable-failed",
        prior_dispatch_status: "failed",
        dispatch_retry_count: 0,
        retry_cap: 1,
        failure_kind: "scheduler_wedged",
        failure_detail: "scheduler wedged during dispatch handoff",
        recovery_status: null,
      },
    });

    const held = planAdmission([retryableFailed], ctx(), cfg);
    expect(held.admit).toHaveLength(0);
    expect(held.skipped[0]).toMatchObject({
      item_id: "retryable-failed-duplicate",
      action: "held",
      metadata: {
        code: "duplicate_dispatch_retry_required",
        class: "retry_safety",
        last_dispatch_phid: "phid:disp-retryable-failed",
      },
    });

    const approved = planAdmission([{ ...retryableFailed, retry_safe: true }], ctx(), cfg);
    expect(approved.admit.map((i) => i.item_id)).toEqual(["retryable-failed-duplicate"]);
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

  it("recovers target_unhealthy rows for healthy real targets while holding stopped substrate-api-codex", () => {
    const p = planAdmission(
      [
        item({ item_id: "healthy-regina", to_agent: "regina", write_scope: ["repo/frontend"] }),
        item({ item_id: "healthy-roger", to_agent: "roger", write_scope: ["repo/backend"] }),
        item({ item_id: "healthy-cto", to_agent: "cto", write_scope: ["repo/spec"] }),
        item({ item_id: "stopped-substrate", to_agent: "substrate-api-codex", write_scope: ["repo/substrate"] }),
        item({ item_id: "pool-builder", to_agent: "pool:builder", write_scope: ["repo/pool"] }),
      ],
      ctx({
        admit_limit: 5,
        pool_for: (candidate) => (candidate.to_agent === "pool:builder" ? "backend" : null),
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["substrate-api-codex", "roger"]]]),
        healthy_agents: new Set(["regina", "roger", "cto"]),
        target_agent_runtimes: new Map([
          ["regina", "claude-code-cli"],
          ["roger", "codex"],
          ["cto", "claude-code-cli"],
          ["substrate-api-codex", "codex"],
        ]),
      }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["healthy-regina", "healthy-roger", "healthy-cto", "pool-builder"]);
    expect(p.assignments["pool-builder"]).toBe("roger");
    expect(p.skipped).toEqual([
      expect.objectContaining({
        item_id: "stopped-substrate",
        action: "held",
        metadata: expect.objectContaining({
          code: "target_unhealthy",
          target: "substrate-api-codex",
        }),
      }),
    ]);
  });

  it("holds a POOL item when no free builder is healthy", () => {
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
    expect(p.skipped[0].metadata?.code).toBe("no_free_pool_builder");
    expect(p.skipped[0].reason).toMatch(/no healthy free builder in pool: backend/);
  });

  it("assigns a later healthy builder instead of hiding pool work as target_unhealthy", () => {
    const p = planAdmission(
      [item({ item_id: "pool-item", to_agent: "pool:builder", write_scope: [] })],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["roger", "substrate-orch-codex"]]]),
        healthy_agents: new Set(["substrate-orch-codex"]),
      }),
      cfg,
    );

    expect(p.admit.map((it) => it.item_id)).toEqual(["pool-item"]);
    expect(p.assignments["pool-item"]).toBe("substrate-orch-codex");
    expect(p.skipped).toHaveLength(0);
  });

  it("assigns a later healthy runtime-compatible builder instead of holding the pool row", () => {
    const p = planAdmission(
      [
        item({
          item_id: "pool-runtime-item",
          to_agent: "pool:builder",
          provider: "openai",
          runtime: "codex",
          write_scope: [],
        }),
      ],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["gaudi", "roger"]]]),
        healthy_agents: new Set(["gaudi", "roger"]),
        target_agent_runtimes: new Map([
          ["gaudi", "claude-code-cli"],
          ["roger", "codex"],
        ]),
      }),
      cfg,
    );

    expect(p.admit.map((it) => it.item_id)).toEqual(["pool-runtime-item"]);
    expect(p.assignments["pool-runtime-item"]).toBe("roger");
    expect(p.skipped).toHaveLength(0);
  });

  it("keeps provider_runtime_mismatch distinct when no healthy pool builder runs the requested runtime", () => {
    const p = planAdmission(
      [
        item({
          item_id: "pool-runtime-mismatch",
          to_agent: "pool:builder",
          provider: "openai",
          runtime: "codex",
          write_scope: [],
        }),
      ],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["gaudi"]]]),
        healthy_agents: new Set(["gaudi"]),
        target_agent_runtimes: new Map([["gaudi", "claude-code-cli"]]),
      }),
      cfg,
    );

    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0]).toMatchObject({
      item_id: "pool-runtime-mismatch",
      action: "held",
      metadata: {
        code: "provider_runtime_mismatch",
        class: "provider_runtime",
        target: "gaudi",
        target_runtime: "claude-code-cli",
      },
    });
  });

  it("keeps duplicate retry safety ahead of target health and runtime repair blockers", () => {
    const p = planAdmission(
      [
        item({
          item_id: "pool-duplicate",
          to_agent: "pool:builder",
          provider: "openai",
          runtime: "codex",
          last_dispatch_phid: "phid:disp-prior",
          write_scope: [],
        }),
      ],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["gaudi"]]]),
        healthy_agents: new Set(["gaudi"]),
        target_agent_runtimes: new Map([["gaudi", "claude-code-cli"]]),
      }),
      cfg,
    );

    expect(p.admit).toHaveLength(0);
    expect(p.skipped[0]).toMatchObject({
      item_id: "pool-duplicate",
      action: "held",
      metadata: {
        code: "duplicate_dispatch_retry_required",
        class: "retry_safety",
        last_dispatch_phid: "phid:disp-prior",
      },
    });
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

  it("admits manual refuel pool rows without explicit provider/runtime pins when the assigned builder is registered", () => {
    const p = planAdmission(
      [
        item({
          item_id: "manual-refuel-pool-no-runtime",
          title: "Manual refuel row with pool lane and legacy metadata",
          to_agent: "pool:backend",
          provider: null,
          runtime: null,
          write_scope: [],
        }),
      ],
      ctx({
        admit_limit: 5,
        pool_for: () => "backend",
        pool_free_slots: new Map([["backend", 1]]),
        pool_free_builders: new Map([["backend", ["substrate-api-codex"]]]),
        target_agent_runtimes: new Map([["substrate-api-codex", "codex"]]),
      }),
      cfg,
    );

    expect(p.admit.map((i) => i.item_id)).toEqual(["manual-refuel-pool-no-runtime"]);
    expect(p.assignments["manual-refuel-pool-no-runtime"]).toBe("substrate-api-codex");
    expect(p.skipped).toHaveLength(0);
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
