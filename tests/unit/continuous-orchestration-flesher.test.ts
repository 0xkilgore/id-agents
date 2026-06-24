// Daemon SELF-REFUEL — flesher, auto-ready policy, and flesh-pass runner.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import { fleshItem } from "../../src/continuous-orchestration/flesher.js";
import {
  validateFleshPatch,
  evaluateAutoReady,
  matchesHighRiskDenylist,
} from "../../src/continuous-orchestration/flesh-policy.js";
import { validateOptionsFromConfig } from "../../src/continuous-orchestration/flesher.js";
import { runFleshPass } from "../../src/continuous-orchestration/flesh-runner.js";
import {
  insertBacklogItem,
  getBacklogItem,
  listBacklogByState,
  listFleshLog,
} from "../../src/continuous-orchestration/storage.js";
import type { BacklogItem, FleshPatch } from "../../src/continuous-orchestration/types.js";

const cfg = defaultConfig();
const flesh = cfg.flesh;

let seq = 0;
function skeleton(over: Partial<BacklogItem> = {}): BacklogItem {
  seq += 1;
  return {
    item_id: over.item_id ?? `it${seq}`,
    team_id: "default",
    title: over.title ?? `T-ORCH.${seq} — wire the lane-fill heartbeat`,
    track: over.track ?? "T-ORCH",
    to_agent: null,
    dispatch_body: null,
    priority: 5,
    value_score: null,
    readiness_state: "needs_review",
    risk_class: "build",
    write_scope: [],
    dependencies: [],
    token_estimate: null,
    provider: null,
    runtime: null,
    is_north_star: false,
    source_refs: ["roadmap.md"],
    approved_by: null,
    approved_at: null,
    last_dispatch_phid: null,
    updated_by: null,
    track_drift: false,
    flesh_status: "unfleshed",
    flesh_source: null,
    flesh_confidence: null,
    flesh_error: null,
    flesh_attempts: 0,
    fleshed_at: null,
    auto_ready_approved_at: null,
    auto_ready_policy_version: null,
    flesh_patch: null,
    created_at: "2026-06-22T00:00:00Z",
    updated_at: "2026-06-22T00:00:00Z",
    ...over,
  };
}

function runFlesh(item: BacklogItem) {
  return fleshItem({ item, config: flesh, knownItemIds: new Set(), remainingDaemonBudget: Number.POSITIVE_INFINITY });
}

describe("flesher — deterministic generation", () => {
  it("produces a valid, auto-ready FleshPatch for a representative T-ORCH skeleton", () => {
    const r = runFlesh(skeleton({ track: "T-ORCH", title: "T-ORCH.3 — daemon self-refuel auto-flesh" }));
    expect(r.patch.dispatch_body.startsWith("[project: kapelle]")).toBe(true);
    expect(r.patch.dispatch_body).toContain("[T-ORCH]");
    expect(r.patch.dispatch_body).toMatch(/roger:/);
    expect(r.patch.to_agent).toBe("roger");
    expect(r.patch.write_scope.length).toBeGreaterThan(0);
    expect(r.patch.risk_class).toBe("build");
    expect(Number.isFinite(r.patch.token_estimate)).toBe(true);
    expect(r.validation_errors).toEqual([]);
    expect(r.patch.ready_decision).toBe("auto_ready");
  });

  it("is deterministic: same skeleton + config => same patch + hashes", () => {
    const item = skeleton({ item_id: "stable", title: "T-CKPT.1 — checkpoint persistence" });
    const a = runFlesh(item);
    const b = runFlesh(item);
    expect(a.output_hash).toBe(b.output_hash);
    expect(a.patch.dispatch_body).toBe(b.patch.dispatch_body);
  });

  it("handles a representative T-CKPT row", () => {
    const r = runFlesh(skeleton({ track: "T-CKPT", title: "T-CKPT.2 — restore from snapshot" }));
    expect(r.patch.to_agent).toBe("roger");
    expect(r.validation_errors).toEqual([]);
  });

  it("an unrecognized track still fleshes but holds for batch (lower confidence)", () => {
    const r = runFlesh(skeleton({ track: "T-ZZZ", title: "T-ZZZ.9 — speculative idea" }));
    // default lane still assigns roger, but confidence stays below the auto bar.
    expect(r.patch.confidence).toBeLessThan(0.82);
    expect(r.patch.ready_decision).toBe("needs_chris_batch");
  });
});

describe("auto-ready policy — risk gating", () => {
  const validateOpts = validateOptionsFromConfig(flesh);

  it("accepts a routine/build patch with valid fields", () => {
    const r = runFlesh(skeleton({ track: "T-ORCH", title: "T-ORCH.4 — add a status route" }));
    const decision = evaluateAutoReady({
      patch: r.patch,
      sourceTitle: "T-ORCH.4 — add a status route",
      knownItemIds: new Set(),
      remainingDaemonBudget: Number.POSITIVE_INFINITY,
      validate: validateOpts,
    });
    expect(decision.ready_decision).toBe("auto_ready");
  });

  it("rejects destructive/external work via the denylist (needs_chris_batch, conf 0)", () => {
    for (const title of [
      "T-ORCH.5 — delete production database rows",
      "T-ORCH.6 — force-push the rewritten history",
      "T-ORCH.7 — purchase more API credits",
      "T-ORCH.8 — change the budget ceiling to unlimited",
      "T-ORCH.9 — send an email blast to the mailing list",
    ]) {
      const r = runFlesh(skeleton({ title }));
      expect(r.patch.confidence).toBe(0);
      expect(r.patch.ready_decision).toBe("needs_chris_batch");
      expect(matchesHighRiskDenylist(title)).not.toBeNull();
    }
  });

  it("rejects a patch whose token_estimate cannot fit the remaining daemon budget", () => {
    const r = runFlesh(skeleton({ track: "T-ORCH", title: "T-ORCH.10 — big job" }));
    const decision = evaluateAutoReady({
      patch: r.patch,
      sourceTitle: "T-ORCH.10 — big job",
      knownItemIds: new Set(),
      remainingDaemonBudget: 1, // can't fit the default estimate
      validate: validateOpts,
    });
    expect(decision.ready_decision).toBe("needs_chris_batch");
  });
});

describe("validateFleshPatch — structural validation", () => {
  const opts = validateOptionsFromConfig(flesh);
  const base: FleshPatch = {
    to_agent: "roger",
    dispatch_body: "[project: kapelle][T-ORCH] roger: implement X. Verify with npm test. Spec 054 promotion.",
    risk_class: "build",
    write_scope: [flesh.default_lane.write_scopes[0]],
    dependencies: [],
    token_estimate: 100000,
    provider: "anthropic",
    runtime: "claude-code-cli",
    value_score: null,
    priority: 5,
    confidence: 0.9,
    ready_decision: "auto_ready",
    reason: "",
  };

  it("passes a well-formed build patch", () => {
    expect(validateFleshPatch(base, opts)).toEqual([]);
  });

  it("flags a missing project tag", () => {
    const errs = validateFleshPatch({ ...base, dispatch_body: "roger: do X" }, opts);
    expect(errs.join(" ")).toMatch(/must start with \[project: kapelle\]/);
  });

  it("flags empty write_scope for build work", () => {
    const errs = validateFleshPatch({ ...base, write_scope: [] }, opts);
    expect(errs.join(" ")).toMatch(/write_scope must be non-empty/);
  });

  it("flags a write_scope broader than known project scopes", () => {
    const errs = validateFleshPatch({ ...base, write_scope: ["/etc"] }, opts);
    expect(errs.join(" ")).toMatch(/broader than known project scopes/);
  });

  it("flags a non-auto-runnable risk class", () => {
    const errs = validateFleshPatch({ ...base, risk_class: "external" }, opts);
    expect(errs.join(" ")).toMatch(/not auto-runnable/);
  });
});

describe("runFleshPass — DB-backed pass", () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
  });

  it("dry-run produces proposed patches and mutates nothing", async () => {
    for (let i = 0; i < 6; i++) {
      await insertBacklogItem(adapter, {
        title: `T-ORCH.${i} — wire the thing ${i}`,
        track: "T-ORCH",
        readiness_state: "needs_review",
        source_refs: ["roadmap.md"],
      });
    }
    const summary = await runFleshPass(adapter, cfg, { dry_run: true, limit: 5 });
    expect(summary.dry_run).toBe(true);
    expect(summary.considered).toBe(5);
    expect(summary.auto_ready).toBeGreaterThanOrEqual(5);
    // Nothing mutated: still needs_review + unfleshed, no flesh log.
    const stillReview = await listBacklogByState(adapter, { state: "needs_review" });
    expect(stillReview.length).toBe(6);
    expect(stillReview.every((i) => i.flesh_status === "unfleshed")).toBe(true);
    expect((await listFleshLog(adapter, {})).length).toBe(0);
  });

  it("live run fills dispatch fields, promotes safe items to READY, logs decisions", async () => {
    const safe = await insertBacklogItem(adapter, {
      title: "T-ORCH.1 — add a read-only status route",
      track: "T-ORCH",
      readiness_state: "needs_review",
      source_refs: ["roadmap.md"],
    });
    const risky = await insertBacklogItem(adapter, {
      title: "T-ORCH.2 — force-push the rewritten branch history",
      track: "T-ORCH",
      readiness_state: "needs_review",
      source_refs: ["roadmap.md"],
    });

    const summary = await runFleshPass(adapter, cfg, { dry_run: false, limit: 10 });
    expect(summary.auto_ready).toBe(1);
    expect(summary.needs_chris_batch).toBe(1);

    const safeAfter = await getBacklogItem(adapter, safe.item_id);
    expect(safeAfter?.readiness_state).toBe("ready");
    expect(safeAfter?.dispatch_body).toBeTruthy();
    expect(safeAfter?.to_agent).toBe("roger");
    expect(safeAfter?.flesh_status).toBe("approved_ready");

    const riskyAfter = await getBacklogItem(adapter, risky.item_id);
    expect(riskyAfter?.readiness_state).toBe("needs_review");
    expect(riskyAfter?.flesh_status).toBe("needs_chris_batch");
    // The patch is stored for one-click approval even though it didn't auto-ready.
    expect(riskyAfter?.flesh_patch).toBeTruthy();

    // No READY item may have a null dispatch_body.
    const ready = await listBacklogByState(adapter, { state: "ready" });
    expect(ready.every((i) => !!i.dispatch_body && !!i.to_agent)).toBe(true);

    const log = await listFleshLog(adapter, {});
    expect(log.length).toBe(2);
  });
});
