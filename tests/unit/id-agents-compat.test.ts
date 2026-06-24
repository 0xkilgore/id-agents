// T-DEPLOY.6 (2026-06-24, phid:disp-2d7ff3d0e9efb752) — id-agents ↔ Kapelle
// compat suite. The drift guard for the standing id-agents↔Kapelle sync lane:
// id-agents (the manager/runtime) and the Kapelle product evolve in separate
// repos but share the manager HTTP read-model contract that kapelle-site's ops
// console consumes. This suite PINS that contract from the manager side so a
// change here that would silently break Kapelle fails THIS build instead.
//
// The canonical surface + field list is documented in docs/id-agents-parity.md.
// If a field below changes, update BOTH the ledger and kapelle-site together
// (the PR/release checklist in the ledger).

import { test, expect } from "vitest";

import { readDispatches } from "../../src/dispatch-scheduler/read-model";
import type { DbAdapterLike } from "../../src/supervisor/manager-source-reader";

// ── The contract kapelle-site/app/ops/_lib/dispatchStatus.ts depends on ──────
// Top-level fields the Kapelle ops console reads off every /dispatches row.
// Sourced from kapelle-site OpsDispatchSummary + dispatchStatus consumption.
const KAPELLE_CONSUMED_DISPATCH_FIELDS = [
  "id",
  "dispatch_id",
  "dispatch_phid",
  "query_id",
  "status", // raw lifecycle status
  "effective_state", // derived taxonomy (T13.2) — the UI branches on this
  "needs_operator", // derived needs-you flag (T13.2)
  "sort_group", // derived sort band (T13.3) — the queue orders on this
  "target_agent",
  "agent_id",
  "title",
  "subject",
  "queued_at",
  "in_flight_at",
  "completed_at",
  "updated_at",
  "failure_kind",
  "failure_detail",
  "supersede_link",
] as const;

// Nested blocks Kapelle consumes (recovery posture + evidence + provenance).
const KAPELLE_CONSUMED_NESTED_BLOCKS = [
  "recovery",
  "evidence",
  "recovery_classification",
  "source_metadata",
] as const;

// The effective_state union Kapelle's UI exhaustively branches on. Renaming or
// dropping any of these is a breaking change that must land in both repos.
const CONTRACT_EFFECTIVE_STATES = [
  "failed_work_landed_recoverable",
  "moot_or_superseded",
  "failed_needs_operator",
  "queued",
  "in_flight",
  "done",
  "done_recovered",
] as const;

function adapterReturning(row: Record<string, unknown>): DbAdapterLike {
  const base = {
    dispatch_phid: "phid:disp-compat",
    team_id: "t",
    query_id: "q1",
    to_agent: "regina",
    from_actor: "user:chris",
    channel: null,
    subject: "compat row",
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
    ...row,
  };
  return {
    async query<T = unknown>(): Promise<{ rows: T[] }> {
      return { rows: [base as unknown as T] };
    },
  };
}

test("id-agents↔Kapelle: every dispatch read row carries the consumed top-level fields", async () => {
  const rows = await readDispatches(adapterReturning({ status: "done" }), "t", "all", 10);
  expect(rows).toHaveLength(1);
  const row = rows[0] as unknown as Record<string, unknown>;
  for (const field of KAPELLE_CONSUMED_DISPATCH_FIELDS) {
    expect(
      Object.prototype.hasOwnProperty.call(row, field),
      `read-model dropped Kapelle-consumed field "${field}" — update docs/id-agents-parity.md + kapelle-site together`,
    ).toBe(true);
  }
});

test("id-agents↔Kapelle: every dispatch read row carries the consumed nested blocks", async () => {
  const rows = await readDispatches(adapterReturning({ status: "done" }), "t", "all", 10);
  const row = rows[0] as unknown as Record<string, unknown>;
  for (const block of KAPELLE_CONSUMED_NESTED_BLOCKS) {
    expect(
      Object.prototype.hasOwnProperty.call(row, block),
      `read-model dropped Kapelle-consumed block "${block}" — see docs/id-agents-parity.md`,
    ).toBe(true);
    expect(typeof row[block]).toBe("object");
  }
  const sm = row.source_metadata as Record<string, unknown>;
  expect(sm.source).toBe("dispatch_scheduler_queue");
  expect(Object.prototype.hasOwnProperty.call(sm, "from_actor")).toBe(true);
});

test("id-agents↔Kapelle: effective_state stays within the contracted union", async () => {
  // Exercise representative rows; each derived effective_state must be a value
  // Kapelle's UI knows how to render.
  const cases: Array<Record<string, unknown>> = [
    { status: "queued" },
    { status: "in_flight", started_at: "2026-06-24T00:00:00Z" },
    { status: "done" },
    { status: "done", recovery_status: "landed_reconciled", failure_kind: "rate_limit_error" },
    { status: "failed", failure_kind: "provider_auth_error" },
    { status: "failed", recovery_status: "moot" },
    { status: "failed", recovery_status: "landed_reconciled" },
  ];
  for (const c of cases) {
    const rows = await readDispatches(adapterReturning(c), "t", "all", 10);
    const state = (rows[0] as unknown as { effective_state: string }).effective_state;
    expect(
      (CONTRACT_EFFECTIVE_STATES as readonly string[]).includes(state),
      `effective_state "${state}" is not in the Kapelle contract union — a new state must be added to docs/id-agents-parity.md + kapelle-site's DispatchEffectiveState`,
    ).toBe(true);
  }
});

test("id-agents↔Kapelle: sort_group stays a 0..5 band Kapelle can order by", async () => {
  const rows = await readDispatches(
    adapterReturning({ status: "failed", failure_kind: "provider_auth_error", completed_at: null }),
    "t",
    "all",
    10,
  );
  const sg = (rows[0] as unknown as { sort_group: number }).sort_group;
  expect(Number.isInteger(sg)).toBe(true);
  expect(sg).toBeGreaterThanOrEqual(0);
  expect(sg).toBeLessThanOrEqual(5);
});
