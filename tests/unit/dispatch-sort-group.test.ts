/**
 * T13.3 / T-CKPT.2 — dispatch-queue sort_group emitter (phid:disp-
 * dab6b426faa23147, 2026-06-24). Pins the Default Sort Policy `groupRank`
 * map from cto/output/2026-06-16-dispatch-failure-state-taxonomy-scope.md
 * §"Default Sort Policy".
 *
 * T13.2 already emits effective_state + needs_operator per row. This emitter
 * adds the third field the scope's Build Sequence step 3 names — `sort_group`
 * — so the console (T13.4) and the page-title counts order rows from one
 * shared, server-derived rank instead of re-deriving the taxonomy client-side.
 *
 * Scope groupRank (verbatim):
 *   failed_needs_operator: 0
 *   in_flight_needs_operator: 0
 *   queued_needs_operator: 0
 *   in_flight: 1
 *   queued: 2
 *   done_recovered: 3
 *   failed_work_landed_recoverable: 3
 *   done: 4
 *   moot_or_superseded: 5
 */

import { test, expect } from "vitest";

import { deriveSortGroup, readDispatches } from "../../src/dispatch-scheduler/read-model";
import type { DbAdapterLike } from "../../src/supervisor/manager-source-reader";

// ============================================================
// Group 0 — "needs you": any needs_operator row, regardless of state
// ============================================================

test("failed_needs_operator -> group 0", () => {
  expect(deriveSortGroup("failed_needs_operator", true)).toBe(0);
});

test("stale queued (needs_operator) collapses into group 0, not 2", () => {
  expect(deriveSortGroup("queued", true)).toBe(0);
});

test("stale in_flight (needs_operator) collapses into group 0, not 1", () => {
  expect(deriveSortGroup("in_flight", true)).toBe(0);
});

// ============================================================
// Active groups 1-2 (not needs_operator)
// ============================================================

test("in_flight (healthy) -> group 1", () => {
  expect(deriveSortGroup("in_flight", false)).toBe(1);
});

test("queued (ready) -> group 2", () => {
  expect(deriveSortGroup("queued", false)).toBe(2);
});

// ============================================================
// Collapsed terminal groups 3-5
// ============================================================

test("done_recovered -> group 3", () => {
  expect(deriveSortGroup("done_recovered", false)).toBe(3);
});

test("failed_work_landed_recoverable -> group 3 (same band as done_recovered)", () => {
  expect(deriveSortGroup("failed_work_landed_recoverable", false)).toBe(3);
});

test("done -> group 4", () => {
  expect(deriveSortGroup("done", false)).toBe(4);
});

test("moot_or_superseded -> group 5 (bottom)", () => {
  expect(deriveSortGroup("moot_or_superseded", false)).toBe(5);
});

// ============================================================
// Ordering invariants the UI relies on
// ============================================================

test("needs-you always sorts above every non-needs-you band", () => {
  const needsYou = deriveSortGroup("failed_needs_operator", true);
  for (const [state, no] of [
    ["in_flight", false],
    ["queued", false],
    ["done_recovered", false],
    ["failed_work_landed_recoverable", false],
    ["done", false],
    ["moot_or_superseded", false],
  ] as const) {
    expect(needsYou).toBeLessThan(deriveSortGroup(state, no));
  }
});

test("active work (in_flight/queued) sorts above collapsed terminal history", () => {
  const active = Math.max(deriveSortGroup("in_flight", false), deriveSortGroup("queued", false));
  const collapsed = Math.min(
    deriveSortGroup("done_recovered", false),
    deriveSortGroup("done", false),
    deriveSortGroup("moot_or_superseded", false),
  );
  expect(active).toBeLessThan(collapsed);
});

test("moot_or_superseded sorts at or below done (out of the way)", () => {
  expect(deriveSortGroup("moot_or_superseded", false)).toBeGreaterThanOrEqual(
    deriveSortGroup("done", false),
  );
});

// ============================================================
// Fallback — unknown/other raw states stay visible (safe direction)
// ============================================================

test("unknown raw state (not needs_operator) sorts in the active band, not collapsed", () => {
  const g = deriveSortGroup("needs_clarification", false);
  expect(g).toBeLessThanOrEqual(deriveSortGroup("done_recovered", false));
});

test("a needs_operator=true unknown state still sorts to group 0", () => {
  expect(deriveSortGroup("cancelled", true)).toBe(0);
});

// ============================================================
// Row path — readDispatches emits sort_group on every read row
// ============================================================

/** Minimal adapter returning one fixed dispatch row for the read path. */
function adapterWithRow(overrides: Record<string, unknown> = {}): DbAdapterLike {
  const base = {
    dispatch_phid: "phid:disp-test",
    team_id: "t",
    query_id: null,
    to_agent: "roger",
    from_actor: null,
    channel: null,
    subject: "x",
    provider: null,
    runtime: null,
    priority: null,
    status: "done",
    not_before_at: null,
    attempt_count: null,
    bounce_count: null,
    started_at: null,
    completed_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    agent_query_id: null,
    failure_kind: null,
    failure_detail: null,
    clarification_id: null,
    active_clarification_json: null,
    clarification_history_json: null,
    resume_delivery_status: null,
    promote: null,
    promotion_strategy: null,
    promotion_required_reason: null,
    promotion_input_json: null,
    promotion_result_json: null,
    result_json: null,
    artifact_path: null,
    recovery_status: null,
    recovery_attempts: null,
    recovery_reason: null,
    side_effect: null,
    allow_auto_retry: null,
    supersede_link: null,
    ...overrides,
  };
  return {
    async query<T = unknown>(): Promise<{ rows: T[] }> {
      return { rows: [base as unknown as T] };
    },
  };
}

test("readDispatches attaches sort_group consistent with effective_state/needs_operator", async () => {
  const rows = await readDispatches(adapterWithRow({ status: "done" }), "t", "all", 10);
  expect(rows).toHaveLength(1);
  expect(rows[0].effective_state).toBe("done");
  expect(rows[0].needs_operator).toBe(false);
  expect(rows[0].sort_group).toBe(deriveSortGroup(rows[0].effective_state, rows[0].needs_operator));
  expect(rows[0].sort_group).toBe(4);
});

test("readDispatches sorts a hard failure into the needs-you band on the row", async () => {
  const rows = await readDispatches(
    adapterWithRow({ status: "failed", failure_kind: "provider_auth_error", completed_at: null }),
    "t",
    "all",
    10,
  );
  expect(rows[0].effective_state).toBe("failed_needs_operator");
  expect(rows[0].needs_operator).toBe(true);
  expect(rows[0].sort_group).toBe(0);
});
