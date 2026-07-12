import { describe, expect, it } from "vitest";
import { planAdmission } from "../../src/continuous-orchestration/admission.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import { buildPoolRouting } from "../../src/continuous-orchestration/factory.js";
import type { BacklogItem } from "../../src/continuous-orchestration/types.js";

function item(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    item_id: "coitem_test",
    team_id: "default",
    title: "UI - Full-width ops layout",
    track: "T-CKPT",
    to_agent: "frontend-ui-codex",
    dispatch_body: "Fix /ops/projects layout in kapelle-site",
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
    approved_at: "2026-06-26T00:00:00.000Z",
    last_dispatch_phid: null,
    track_drift: false,
    created_at: "2026-06-26T00:00:00.000Z",
    updated_at: "2026-06-26T00:00:00.000Z",
    ...over,
  };
}

describe("continuous orchestration pool routing", () => {
  it("routes stale T-CKPT /ops UI rows to the frontend pool", () => {
    const pools = buildPoolRouting({});
    const pool = pools.poolForItem(item());
    expect(pool?.pool_id).toBe("frontend");
    // Snag #13: widened with live idle Claude builders (listed first) so frontend
    // work fans out instead of stalling on the 2 throttle-prone codex/cursor lanes.
    expect(pool?.members).toEqual([
      "regina", "brunel", "eames", "gaudi", "hopper", "frontend-ui-codex", "frontend-qa-cursor",
    ]);
  });

  it("frontend pool fans out to multiple idle Claude builders when the codex/cursor lanes are busy", () => {
    const pools = buildPoolRouting({});
    const pool = pools.poolForItem(item())!;
    // both throttle-prone lanes building -> still 5 Claude builders free
    const free = pools.availableBuilders(pool, new Set(["frontend-ui-codex", "frontend-qa-cursor"]));
    expect(free).toEqual(["regina", "brunel", "eames", "gaudi", "hopper"]);
    expect(free.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps non-UI T-CKPT rows in the backend pool", () => {
    const pools = buildPoolRouting({});
    const pool = pools.poolForItem(
      item({
        title: "T-ORCH - scheduler recovery",
        dispatch_body: "Patch id-agents dispatch lifecycle",
        write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents"],
      }),
    );
    expect(pool?.pool_id).toBe("backend");
    expect(pool?.members).toEqual(["roger", "substrate-orch-codex", "substrate-api-codex"]);
  });

  it("keeps wave17/wave18 explicit kapelle-site owners out of the frontend pool", () => {
    const pools = buildPoolRouting({});
    const rows = [
      item({
        item_id: "coitem_wave17_cto",
        title: "wave17 cto review - kapelle-site release routing",
        track: "T-UI",
        to_agent: "cto",
        dispatch_body: "Review the kapelle-site /ops release plan without changing owner.",
        write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
      }),
      item({
        item_id: "coitem_wave18_regina",
        title: "wave18 regina fix - kapelle-site approval console",
        track: "T-SITE",
        to_agent: "regina",
        dispatch_body: "Fix kapelle-site approval console wiring in the Regina lane.",
        write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site/app/ops"],
      }),
      item({
        item_id: "coitem_wave18_roger",
        title: "wave18 roger audit - kapelle-site orchestration telemetry",
        track: "T-UI",
        to_agent: "roger",
        dispatch_body: "Audit kapelle-site orchestration telemetry from the Roger lane.",
        write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
      }),
    ];

    expect(rows.map((row) => pools.poolForItem(row))).toEqual([null, null, null]);
  });

  it("preserves explicit non-pool target agents even when frontend heuristics match", () => {
    const pools = buildPoolRouting({});
    for (const to_agent of ["cto", "maestra", "sentinel"]) {
      const pool = pools.poolForItem(
        item({
          item_id: `coitem_${to_agent}`,
          title: "Scope artifact routing visibility",
          to_agent,
          dispatch_body: "Review the artifact comments dashboard routing contract",
          write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
        }),
      );
      expect(pool, to_agent).toBeNull();
    }
  });

  it("routes an explicit pool sentinel to the frontend pool", () => {
    const pools = buildPoolRouting({});
    const pool = pools.poolForItem(
      item({
        to_agent: "pool:frontend",
        write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
      }),
    );

    expect(pool?.pool_id).toBe("frontend");
    expect(pool?.members).toContain("regina");
  });

  it("smokes pool:frontend saturation: active captains are skipped, worktrees are isolated, blockers are explicit", async () => {
    const pools = buildPoolRouting({});
    const pool = pools.poolForItem(
      item({
        item_id: "coitem_frontend_smoke",
        to_agent: "pool:frontend",
        track: "T-UI",
        title: "[project: kapelle][T-UI][BUILD] pool:frontend smoke",
        write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
      }),
    )!;

    expect(pool.pool_id).toBe("frontend");

    // Regina/Brunel/Eames are already building in the saturated wave, so the
    // next frontend dispatches must spill to the remaining lanes instead of
    // colliding with those active branches.
    const activeCaptains = new Set(["regina", "brunel", "eames"]);
    const freeBuilders = pools.availableBuilders(pool, activeCaptains);
    expect(freeBuilders).toEqual(["gaudi", "hopper", "frontend-ui-codex", "frontend-qa-cursor"]);

    const first = item({
      item_id: "coitem_frontend_first",
      to_agent: "pool:frontend",
      track: "T-UI",
      title: "Kapelle /ops projects frontend polish",
      write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
    });
    const second = item({
      item_id: "coitem_frontend_second",
      to_agent: "pool:frontend",
      track: "T-UI",
      title: "Kapelle artifact inbox frontend polish",
      write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
    });

    const [firstWt, secondWt] = await Promise.all([
      pools.allocateWorktree({ agent: freeBuilders[0]!, item: first, pool }),
      pools.allocateWorktree({ agent: freeBuilders[1]!, item: second, pool }),
    ]);
    expect(firstWt.path).toContain("/.worktrees/");
    expect(secondWt.path).toContain("/.worktrees/");
    expect(firstWt.path).not.toBe(secondWt.path);
    expect(firstWt.branch).not.toBe(secondWt.branch);
    expect(firstWt.path).toContain("gaudi-");
    expect(secondWt.path).toContain("hopper-");

    const saturatedByCapacity = planAdmission(
      [first],
      {
        mode: "running",
        kill_switch_active: false,
        usage: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
        daily_tokens_used: 0,
        in_flight: 0,
        active_write_scopes: new Set(),
        done_item_ids: new Set(),
        admit_limit: 1,
        pool_for: () => "frontend",
        pool_free_slots: new Map([["frontend", 0]]),
        pool_free_builders: new Map([["frontend", freeBuilders]]),
      },
      defaultConfig(),
    );
    expect(saturatedByCapacity.skipped[0]).toMatchObject({
      action: "held",
      metadata: { code: "pool_capacity_full", pool_id: "frontend" },
    });

    const saturatedByBuilders = planAdmission(
      [first],
      {
        mode: "running",
        kill_switch_active: false,
        usage: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
        daily_tokens_used: 0,
        in_flight: 0,
        active_write_scopes: new Set(),
        done_item_ids: new Set(),
        admit_limit: 1,
        pool_for: () => "frontend",
        pool_free_slots: new Map([["frontend", 1]]),
        pool_free_builders: new Map([["frontend", []]]),
      },
      defaultConfig(),
    );
    expect(saturatedByBuilders.skipped[0]).toMatchObject({
      action: "held",
      metadata: { code: "no_free_pool_builder", pool_id: "frontend" },
    });
  });

  it("honors a backend-track operator target instead of rerouting to frontend or roger", () => {
    const pools = buildPoolRouting({});
    const backendItem = item({
      item_id: "coitem_backend_read_models",
      title: "T-ORCH - substrate read-model artifact routing",
      track: "T-ORCH",
      to_agent: "substrate-api-codex",
      dispatch_body: "[project: kapelle][T-ORCH] substrate-api-codex: fix backend read-model dispatch routing",
      write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents/src/project-tracks"],
    });
    const pool = pools.poolForItem(backendItem);

    expect(pool).toBeNull();

    const plan = planAdmission(
      [backendItem],
      {
        mode: "running",
        kill_switch_active: false,
        usage: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
        daily_tokens_used: 0,
        in_flight: 0,
        active_write_scopes: new Set(),
        dependency_index: new Map(),
        admit_limit: 1,
        pool_for: (it) => pools.poolForItem(it)?.pool_id ?? null,
      },
      defaultConfig(),
    );

    expect(plan.admit.map((it) => it.item_id)).toEqual(["coitem_backend_read_models"]);
    expect(plan.assignments).toEqual({});
  });

  it("preserves a wave17 cto clarification row instead of routing kapelle-site scope through the frontend pool", () => {
    const pools = buildPoolRouting({});
    const ctoClarification = item({
      item_id: "coitem_wave17_cto_clarification",
      title:
        "[project: kapelle][T-RELY][BUILD][REGRESSION] substrate-orch-codex: tick_2d16caa4 routed explicit to_agent=cto through frontend pool",
      track: "T-RELY",
      to_agent: "cto",
      dispatch_body: `Blocked on a clarification - Spec 054 v2

If you cannot safely continue because the dispatch is ambiguous, call POST /agent-needs-input with the manager dispatch_id.

Maestra refuel note 2026-07-07: Infra regression: explicit non-pool backlog rows routed through frontend pool.`,
      write_scope: ["/Users/kilgore/Dropbox/Code/kapelle-site"],
    });
    const pool = pools.poolForItem(ctoClarification);

    expect(pool).toBeNull();

    const plan = planAdmission(
      [ctoClarification],
      {
        mode: "running",
        kill_switch_active: false,
        usage: { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" },
        daily_tokens_used: 0,
        in_flight: 0,
        active_write_scopes: new Set(),
        dependency_index: new Map(),
        admit_limit: 1,
        pool_for: (it) => pools.poolForItem(it)?.pool_id ?? null,
        pool_free_slots: new Map([["frontend", 1]]),
        pool_free_builders: new Map([["frontend", ["regina"]]]),
      },
      defaultConfig(),
    );

    expect(plan.admit.map((it) => it.item_id)).toEqual(["coitem_wave17_cto_clarification"]);
    expect(plan.assignments).toEqual({});
  });
});
