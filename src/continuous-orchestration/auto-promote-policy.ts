// Continuous Orchestration — floor-triggered AUTO-PROMOTE policy (ADMISSION-V2
// follow-up).
//
// admission-v2 made admission lane-aware, but the parallel pool still drained
// to < floor because already-FLESHED items sit in `needs_review` awaiting a
// manual /promote. The auto-flesh refuel only converts UNFLESHED skeletons; it
// never drains the needs_review backlog. This policy closes that gap: when
// build-ready fuel is below the floor, it auto-promotes the highest-confidence,
// low-risk, non-destructive needs_review items to READY — PER-LANE, so the pool
// stays fed across distinct write-scopes, not just in aggregate.
//
// SAFETY: reuses the EXACT auto-ready gate (flesh-policy.ts) — risk_class must be
// auto-runnable, the dispatch body/title must clear the high-risk denylist, and
// confidence must clear the threshold. Approval-gated + destructive items
// (DV4/DV5 flips, T-OSS structural, anything risk_class destructive/external/
// costly/novel or matching the denylist) are NEVER auto-promoted — they stay in
// needs_review/needs_chris_batch for the human gate. Pure + fully unit-tested;
// the daemon wires I/O (listReadyItems + promoteToReady) around it.

import { AUTO_READY_CONFIDENCE_THRESHOLD, matchesHighRiskDenylist } from "./flesh-policy.js";
import { laneKeyOf } from "./selection.js";
import type { BacklogItem, RiskClass } from "./types.js";

/** Only `build` items count toward — and feed — the build-ready floor. */
const PROMOTABLE_RISK = new Set<RiskClass>(["build"]);

export interface AutoPromoteOptions {
  /** Build-ready fuel floor: promote until this many build items are READY. */
  floor: number;
  /** Distinct write-scopes the build-ready pool must span. */
  minLanes: number;
  /** Max promotions in a single pass (cost/safety bound). */
  maxPerPass: number;
  /** Confidence floor; defaults to the flesh-policy auto-ready threshold. */
  confidenceThreshold?: number;
}

export interface AutoPromoteSkip {
  item_id: string;
  reasons: string[];
}

export interface AutoPromotePlan {
  /** True when build-ready fuel was below floor/lanes and a top-up was attempted. */
  triggered: boolean;
  /** Items to promote needs_review -> ready, in promotion order. */
  promote: BacklogItem[];
  /** Candidates rejected by the safety gate (audit). */
  skipped: AutoPromoteSkip[];
  /** Build-ready totals before the pass (for logging). */
  before: { build_ready: number; build_lanes: number };
}

/** Why an item is NOT a safe auto-promote candidate (empty = safe). */
export function autoPromoteRejections(
  item: BacklogItem,
  confidenceThreshold: number,
): string[] {
  const reasons: string[] = [];
  if (item.readiness_state !== "needs_review") {
    reasons.push(`state ${item.readiness_state} (only needs_review is auto-promotable)`);
  }
  if (!item.to_agent || !item.dispatch_body) {
    reasons.push("missing to_agent or dispatch_body (not fleshed)");
  }
  if (!PROMOTABLE_RISK.has(item.risk_class)) {
    reasons.push(`risk_class '${item.risk_class}' is not auto-promotable (build only)`);
  }
  if (item.write_scope.length === 0) {
    reasons.push("empty write_scope (build work must declare a lane)");
  }
  const denyHit = matchesHighRiskDenylist(item.dispatch_body, item.title);
  if (denyHit) reasons.push(`high-risk denylist match: /${denyHit}/`);
  // Confidence is required: a null/low confidence holds for the human gate.
  if (item.flesh_confidence == null) {
    reasons.push("no flesh_confidence (cannot assert it is high-confidence)");
  } else if (item.flesh_confidence < confidenceThreshold) {
    reasons.push(`confidence ${item.flesh_confidence.toFixed(2)} < ${confidenceThreshold}`);
  }
  return reasons;
}

/** Rank safe candidates: highest confidence, then value, then priority (1=top). */
function rankCandidates(items: BacklogItem[]): BacklogItem[] {
  return [...items].sort((a, b) => {
    const ca = a.flesh_confidence ?? 0;
    const cb = b.flesh_confidence ?? 0;
    if (ca !== cb) return cb - ca;
    const va = a.value_score ?? -Infinity;
    const vb = b.value_score ?? -Infinity;
    if (va !== vb) return vb - va;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.item_id.localeCompare(b.item_id);
  });
}

/**
 * Decide which needs_review items to auto-promote so the build-ready pool meets
 * its floor AND spans minLanes distinct write-scopes. Pure: the caller supplies
 * the current READY items + the needs_review backlog and performs the writes.
 *
 * Selection is two-phase and lane-first: (1) cover NEW lanes (write-scopes not
 * already build-ready) until minLanes is met, then (2) top up the total until
 * the floor is met — both bounded by maxPerPass.
 */
export function selectAutoPromotions(
  needsReview: BacklogItem[],
  ready: BacklogItem[],
  opts: AutoPromoteOptions,
): AutoPromotePlan {
  const confidenceThreshold = opts.confidenceThreshold ?? AUTO_READY_CONFIDENCE_THRESHOLD;
  const buildReady = ready.filter((r) => PROMOTABLE_RISK.has(r.risk_class));
  const before = { build_ready: buildReady.length, build_lanes: new Set(buildReady.map(laneKeyOf)).size };

  const belowFuel = before.build_ready < opts.floor;
  const belowLanes = before.build_lanes < opts.minLanes;
  if (!belowFuel && !belowLanes) {
    return { triggered: false, promote: [], skipped: [], before };
  }

  const skipped: AutoPromoteSkip[] = [];
  const safe: BacklogItem[] = [];
  for (const item of needsReview) {
    const reasons = autoPromoteRejections(item, confidenceThreshold);
    if (reasons.length === 0) safe.push(item);
    else skipped.push({ item_id: item.item_id, reasons });
  }

  const ranked = rankCandidates(safe);
  const promote: BacklogItem[] = [];
  const lanes = new Set(buildReady.map(laneKeyOf));
  let total = before.build_ready;

  // Phase 1 — lane coverage: prefer candidates introducing a NEW lane.
  for (const item of ranked) {
    if (promote.length >= opts.maxPerPass) break;
    if (lanes.size >= opts.minLanes) break;
    const lane = laneKeyOf(item);
    if (lanes.has(lane)) continue;
    promote.push(item);
    lanes.add(lane);
    total += 1;
  }

  // Phase 2 — total top-up: fill remaining floor with the best remaining items.
  const chosen = new Set(promote.map((p) => p.item_id));
  for (const item of ranked) {
    if (promote.length >= opts.maxPerPass) break;
    if (total >= opts.floor) break;
    if (chosen.has(item.item_id)) continue;
    promote.push(item);
    chosen.add(item.item_id);
    lanes.add(laneKeyOf(item));
    total += 1;
  }

  return { triggered: true, promote, skipped, before };
}
