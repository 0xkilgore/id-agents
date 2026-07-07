// CO floor-triggered auto-promote policy (admission-v2 follow-up).
//
// Proves the pool self-maintains its build-ready floor across lanes by promoting
// safe needs_review items, while NEVER auto-promoting approval-gated/destructive
// work (the existing flesh-policy safety gate is reused).

import { describe, it, expect } from "vitest";
import {
  selectAutoPromotions,
  autoPromoteRejections,
} from "../../src/continuous-orchestration/auto-promote-policy.js";
import { AUTO_READY_CONFIDENCE_THRESHOLD } from "../../src/continuous-orchestration/flesh-policy.js";
import type { BacklogItem } from "../../src/continuous-orchestration/types.js";

let seq = 0;
function item(over: Partial<BacklogItem> = {}): BacklogItem {
  seq += 1;
  return {
    item_id: over.item_id ?? `it${seq}`,
    team_id: "default",
    title: `item ${seq}`,
    track: "T-ORCH",
    to_agent: "roger",
    dispatch_body: "[project: kapelle][T-ORCH] roger: do the thing; verify; promote per Spec 054",
    priority: 5,
    value_score: null,
    readiness_state: "needs_review",
    risk_class: "build",
    write_scope: ["repo/a"],
    dependencies: [],
    token_estimate: 1000,
    provider: null,
    runtime: null,
    is_north_star: false,
    source_refs: [],
    approved_by: null,
    approved_at: null,
    last_dispatch_phid: null,
    track_drift: false,
    flesh_status: "fleshed",
    flesh_source: null,
    flesh_confidence: 0.9,
    flesh_error: null,
    flesh_attempts: 1,
    fleshed_at: "2026-06-24T00:00:00Z",
    auto_ready_approved_at: null,
    auto_ready_policy_version: null,
    flesh_patch: null,
    updated_by: null,
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    ...over,
  } as BacklogItem;
}

const OPTS = { floor: 4, minLanes: 2, maxPerPass: 10 };

describe("selectAutoPromotions — floor trigger", () => {
  it("does NOT trigger when build-ready fuel + lanes already meet the floor", () => {
    const ready = [
      item({ readiness_state: "ready", write_scope: ["a"] }),
      item({ readiness_state: "ready", write_scope: ["b"] }),
      item({ readiness_state: "ready", write_scope: ["c"] }),
      item({ readiness_state: "ready", write_scope: ["d"] }),
    ];
    const plan = selectAutoPromotions([item()], ready, OPTS);
    expect(plan.triggered).toBe(false);
    expect(plan.promote).toEqual([]);
  });

  it("triggers and tops up to the floor from needs_review", () => {
    const ready = [item({ readiness_state: "ready", write_scope: ["a"] })]; // 1 build-ready
    const needsReview = [
      item({ item_id: "n1", write_scope: ["b"] }),
      item({ item_id: "n2", write_scope: ["c"] }),
      item({ item_id: "n3", write_scope: ["d"] }),
      item({ item_id: "n4", write_scope: ["e"] }),
    ];
    const plan = selectAutoPromotions(needsReview, ready, OPTS);
    expect(plan.triggered).toBe(true);
    // floor 4, already 1 ready → promote 3 to reach 4.
    expect(plan.promote.length).toBe(3);
  });

  it("restores the floor in one pass when eligible approved rows exceed the soft max", () => {
    const ready = [item({ readiness_state: "ready", write_scope: ["a"] })]; // 1 build-ready
    const needsReview = [
      item({ item_id: "b", write_scope: ["b"], flesh_confidence: 0.65, approved_by: "maestra" }),
      item({ item_id: "c", write_scope: ["c"], flesh_confidence: 0.65, approved_by: "maestra" }),
      item({ item_id: "d", write_scope: ["d"], flesh_confidence: 0.65, approved_by: "maestra" }),
      item({ item_id: "e", write_scope: ["e"], flesh_confidence: 0.65, approved_by: "maestra" }),
    ];
    const plan = selectAutoPromotions(needsReview, ready, { floor: 4, minLanes: 3, maxPerPass: 1 });
    expect(plan.promote.map((p) => p.item_id)).toEqual(["b", "c", "d"]);
    expect(new Set(plan.promote.map((p) => p.write_scope[0])).size).toBe(3);
  });
});

describe("selectAutoPromotions — lane coverage first", () => {
  it("prefers candidates that introduce a NEW write-scope to meet minLanes", () => {
    const ready = [item({ readiness_state: "ready", write_scope: ["a"] })]; // lanes: {a}
    // Many same-lane (a) high-confidence + a couple new-lane (b, c) lower-confidence.
    const needsReview = [
      item({ item_id: "a1", write_scope: ["a"], flesh_confidence: 0.99 }),
      item({ item_id: "a2", write_scope: ["a"], flesh_confidence: 0.98 }),
      item({ item_id: "bNew", write_scope: ["b"], flesh_confidence: 0.85 }),
      item({ item_id: "cNew", write_scope: ["c"], flesh_confidence: 0.84 }),
    ];
    const plan = selectAutoPromotions(needsReview, ready, { floor: 2, minLanes: 2, maxPerPass: 1 });
    // maxPerPass 1, lanes below 2 → the ONE promotion must be a new lane, not the
    // higher-confidence same-lane item.
    expect(plan.promote.length).toBe(1);
    expect(["bNew", "cNew"]).toContain(plan.promote[0].item_id);
  });
});

describe("selectAutoPromotions — ranking + cap", () => {
  it("promotes highest-confidence first up to the configured floor", () => {
    const ready: BacklogItem[] = [];
    const needsReview = [
      item({ item_id: "low", write_scope: ["a"], flesh_confidence: 0.83 }),
      item({ item_id: "high", write_scope: ["a"], flesh_confidence: 0.97 }),
      item({ item_id: "mid", write_scope: ["a"], flesh_confidence: 0.9 }),
    ];
    const plan = selectAutoPromotions(needsReview, ready, { floor: 2, minLanes: 1, maxPerPass: 2 });
    expect(plan.promote.map((p) => p.item_id)).toEqual(["high", "mid"]);
  });
});

describe("autoPromoteRejections — safety gate (never auto-promote unsafe work)", () => {
  const thr = AUTO_READY_CONFIDENCE_THRESHOLD;
  it("rejects destructive / non-build risk classes", () => {
    expect(autoPromoteRejections(item({ risk_class: "destructive" }), thr)).toContainEqual(
      expect.stringContaining("not auto-promotable"),
    );
    expect(autoPromoteRejections(item({ risk_class: "external" }), thr).length).toBeGreaterThan(0);
    expect(autoPromoteRejections(item({ risk_class: "costly" }), thr).length).toBeGreaterThan(0);
  });

  it("rejects high-risk denylist matches (force-push, delete data, rotate keys, prod deploy)", () => {
    expect(autoPromoteRejections(item({ dispatch_body: "force-push to main" }), thr).length).toBeGreaterThan(0);
    expect(autoPromoteRejections(item({ title: "delete production data" }), thr).length).toBeGreaterThan(0);
    expect(autoPromoteRejections(item({ dispatch_body: "rotate api keys" }), thr).length).toBeGreaterThan(0);
  });

  it("rejects null / below-threshold confidence", () => {
    expect(autoPromoteRejections(item({ flesh_confidence: null }), thr)).toContainEqual(
      expect.stringContaining("no flesh_confidence"),
    );
    expect(autoPromoteRejections(item({ flesh_confidence: thr - 0.01 }), thr)).toContainEqual(
      expect.stringContaining("< "),
    );
  });

  it("accepts explicit approval as the confidence override but keeps other safety gates", () => {
    expect(autoPromoteRejections(item({ flesh_confidence: 0.65, approved_by: "maestra" }), thr)).toEqual([]);
    expect(autoPromoteRejections(item({ flesh_confidence: null, flesh_status: "approved_ready" }), thr)).toEqual([]);
    expect(autoPromoteRejections(item({ flesh_confidence: null, auto_ready_approved_at: "2026-07-07T00:00:00Z" }), thr)).toEqual([]);
    expect(autoPromoteRejections(item({ flesh_confidence: 0.65, approved_by: "maestra", risk_class: "costly" }), thr)).toContainEqual(
      expect.stringContaining("not auto-promotable"),
    );
  });

  it("rejects an item that was already dispatched once (last_dispatch_phid set) — the reap/failure de-dup guard", () => {
    // Root-caused 2026-07-04: an item lands back in needs_review two ways —
    // freshly fleshed (never fired, last_dispatch_phid null) or RE-parked
    // there by the reconciler after a phantom-lock reap or a genuine failure
    // (last_dispatch_phid still set — setItemState's COALESCE preserves it).
    // Only the former is safe to auto-promote; the latter must wait for a
    // human /promote (daemon.ts's own comment: "release to needs_review...
    // NEVER an auto-refire"). Before this gate, both looked identical here.
    expect(autoPromoteRejections(item({ approved_by: "maestra", last_dispatch_phid: "phid:disp-already-fired" }), thr)).toContainEqual(
      expect.stringContaining("already dispatched once"),
    );
  });

  it("rejects non-needs_review state, unfleshed items, and empty write_scope", () => {
    expect(autoPromoteRejections(item({ readiness_state: "ready" }), thr).length).toBeGreaterThan(0);
    expect(autoPromoteRejections(item({ dispatch_body: null }), thr)).toContainEqual(
      expect.stringContaining("not fleshed"),
    );
    expect(autoPromoteRejections(item({ write_scope: [] }), thr)).toContainEqual(
      expect.stringContaining("empty write_scope"),
    );
  });

  it("accepts a safe, high-confidence, fleshed build item in needs_review", () => {
    expect(autoPromoteRejections(item(), thr)).toEqual([]);
  });

  it("excludes denylisted/destructive items from a triggered pass", () => {
    const ready: BacklogItem[] = [];
    const needsReview = [
      item({ item_id: "safe", write_scope: ["a"] }),
      item({ item_id: "destructive", risk_class: "destructive", write_scope: ["b"] }),
      item({ item_id: "denylisted", dispatch_body: "deploy to production", write_scope: ["c"] }),
    ];
    const plan = selectAutoPromotions(needsReview, ready, { floor: 5, minLanes: 1, maxPerPass: 10 });
    expect(plan.promote.map((p) => p.item_id)).toEqual(["safe"]);
    expect(plan.skipped.map((s) => s.item_id).sort()).toEqual(["denylisted", "destructive"]);
  });
});
