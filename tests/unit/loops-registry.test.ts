// Loop registry foundation (CTO Loops spec §4.3/§5.1): static seed catalog
// (L1-L8) serving the /ops/loops read-model DTOs before runtime substrate lands.

import { describe, it, expect } from "vitest";
import {
  SEED_LOOPS,
  listLoops,
  getLoop,
  loopsSummary,
  loopPhidForSlug,
  type LoopSummary,
} from "../../src/loops/registry.js";

const NOW = "2026-06-16T23:00:00.000Z";

const RESERVED_SLUGS = [
  "morning-digest",
  "project-load",
  "inbox-intake",
  "fantasy-baseball",
  "weekly-project-report",
  "weekly-project-report-blowout", // L5 per-project instance (Blowout)
  "biweekly-project-report",
  "maestra-product-log",
  "sentinel-verification-2h",
  "id-agents-parity-weekly", // T-DEPLOY.6 weekly id-agents↔Kapelle parity lane
];

describe("seed catalog", () => {
  it("registers all reserved L1-L8 loops (+ per-project instances) by slug", () => {
    expect(SEED_LOOPS).toHaveLength(10);
    expect(SEED_LOOPS.map((l) => l.slug).sort()).toEqual([...RESERVED_SLUGS].sort());
  });

  it("registers the L5 Blowout weekly-report instance (report, owner blowout, project-bound, Phase-2 disabled)", () => {
    const l = SEED_LOOPS.find((x) => x.slug === "weekly-project-report-blowout")!;
    expect(l.kind).toBe("report");
    expect(l.owner_agent).toBe("blowout");
    expect(l.project?.slug).toBe("blowout");
    expect(l.enabled).toBe(false); // registered + manual-runnable; not auto-scheduled yet
    expect(l.allow_manual_run).toBe(true);
    expect(l.allow_scheduled_run).toBe(true);
  });

  it("registers the T-DEPLOY.6 id-agents↔Kapelle weekly parity lane (verification, owner maestra, Kapelle-bound, registered-disabled)", () => {
    const l = SEED_LOOPS.find((x) => x.slug === "id-agents-parity-weekly")!;
    expect(l.kind).toBe("verification");
    expect(l.owner_agent).toBe("maestra");
    expect(l.project?.project_phid).toBe("phid:proj:kapelle");
    expect(l.enabled).toBe(false); // registered + manual-runnable; not auto-scheduled yet
    expect(l.allow_manual_run).toBe(true);
    expect(l.allow_scheduled_run).toBe(true);
  });

  it("derives a stable canonical loop_phid from the slug", () => {
    for (const l of SEED_LOOPS) {
      expect(l.loop_phid).toBe(`phid:loop:${l.slug}`);
      expect(l.loop_phid).toBe(loopPhidForSlug(l.slug));
    }
  });

  it("every loop is schema-complete for LoopSummary", () => {
    const kinds = new Set(["digest", "report", "intake", "external_data", "verification"]);
    for (const l of SEED_LOOPS) {
      expect(typeof l.name).toBe("string");
      expect(l.name.length).toBeGreaterThan(0);
      expect(kinds.has(l.kind)).toBe(true);
      expect(typeof l.owner_agent).toBe("string");
      expect(typeof l.allow_scheduled_run).toBe("boolean");
      expect(typeof l.allow_manual_run).toBe("boolean");
      expect(typeof l.schedule_label).toBe("string");
      // health is a placeholder rollup (no runs yet)
      expect(l.health.last_run_at).toBeNull();
      expect(l.health.runs_last_7d).toBe(0);
      expect(l.health.consecutive_failures).toBe(0);
    }
  });

  it("placeholder health is 'unknown' for enabled loops and 'disabled' for disabled ones", () => {
    for (const l of SEED_LOOPS) {
      expect(l.health.state).toBe(l.enabled ? "unknown" : "disabled");
    }
  });

  it("phase-1 loops are enabled; phase-2 (L4/L5/L6) are registered but disabled", () => {
    const enabled = (s: string) => SEED_LOOPS.find((l) => l.slug === s)!.enabled;
    expect(enabled("morning-digest")).toBe(true);
    expect(enabled("project-load")).toBe(true);
    expect(enabled("inbox-intake")).toBe(true);
    expect(enabled("maestra-product-log")).toBe(true);
    expect(enabled("sentinel-verification-2h")).toBe(true);
    expect(enabled("fantasy-baseball")).toBe(false);
    expect(enabled("weekly-project-report")).toBe(false);
    expect(enabled("biweekly-project-report")).toBe(false);
  });
});

describe("listLoops", () => {
  it("returns the versioned list envelope from the seed catalog", () => {
    const res = listLoops(NOW);
    expect(res.schema_version).toBe("loops-list-v1");
    expect(res.source).toBe("seed_catalog");
    expect(res.generated_at).toBe(NOW);
    expect(res.loops).toHaveLength(10);
  });

  it("computes filter facets over the full catalog with counts", () => {
    const { filters } = listLoops(NOW);
    const owners = Object.fromEntries(filters.owners.map((o) => [o.value, o.count]));
    expect(owners["maestra"]).toBe(4); // morning-digest, project-load, maestra-product-log, id-agents-parity-weekly
    const kinds = Object.fromEntries(filters.kinds.map((k) => [k.value, k.count]));
    expect(kinds["report"]).toBe(5); // project-load, weekly, weekly-blowout, biweekly, maestra-product-log
    expect(filters.statuses.find((s) => s.value === "unknown")?.count).toBe(5);
    expect(filters.statuses.find((s) => s.value === "disabled")?.count).toBe(5);
  });

  it("filters by owner_agent", () => {
    const res = listLoops(NOW, { owner_agent: "sentinel" });
    expect(res.loops.map((l) => l.slug)).toEqual(["sentinel-verification-2h"]);
  });

  it("filters by kind", () => {
    const res = listLoops(NOW, { kind: "report" });
    expect(res.loops.every((l: LoopSummary) => l.kind === "report")).toBe(true);
    expect(res.loops).toHaveLength(5);
  });

  it("filters by health status", () => {
    expect(listLoops(NOW, { status: "disabled" }).loops).toHaveLength(5);
    expect(listLoops(NOW, { status: "unknown" }).loops).toHaveLength(5);
  });

  it("filters by free-text query over name/slug/description", () => {
    const res = listLoops(NOW, { q: "inbox" });
    expect(res.loops.map((l) => l.slug)).toEqual(["inbox-intake"]);
  });

  it("filters by project_phid", () => {
    const res = listLoops(NOW, { project_phid: "phid:proj:kapelle" });
    expect(res.loops.map((l) => l.slug).sort()).toEqual([
      "id-agents-parity-weekly",
      "maestra-product-log",
      "sentinel-verification-2h",
    ]);
  });
});

describe("getLoop", () => {
  it("resolves by slug and by loop_phid", () => {
    expect(getLoop("morning-digest")?.slug).toBe("morning-digest");
    expect(getLoop("phid:loop:morning-digest")?.slug).toBe("morning-digest");
  });

  it("returns null for unknown / display-only ids", () => {
    expect(getLoop("not-a-loop")).toBeNull();
    expect(getLoop("")).toBeNull();
    expect(getLoop("3")).toBeNull(); // a row number is never a mutation/read target
  });
});

describe("loopsSummary", () => {
  it("reports honest registry-only rollups (no runs yet)", () => {
    const s = loopsSummary(NOW);
    expect(s.schema_version).toBe("loops-dashboard-summary-v1");
    expect(s.total_enabled).toBe(5);
    expect(s.healthy_count).toBe(0);
    expect(s.degraded_count).toBe(0);
    expect(s.failed_count).toBe(0);
    expect(s.next_scheduled).toEqual([]); // no runtime computing next fire yet
    expect(s.degraded).toEqual([]);
  });
});
