import { describe, expect, it } from "vitest";
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
});
