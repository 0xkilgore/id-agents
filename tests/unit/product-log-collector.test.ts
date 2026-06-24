// T-ORCH / L7 (2026-06-24, phid:disp-ac1a5e19abf2f473) — Maestra weekly product
// log deterministic collector. Pins landedDispatchesWithin + the
// collectProductLogDispatchDeltas summary that feeds Maestra's L7 LLM step.

import { test, expect } from "vitest";

import {
  landedDispatchesWithin,
  collectProductLogDispatchDeltas,
  PRODUCT_LOG_WINDOW_MS,
  type DispatchReadRow,
} from "../../src/dispatch-scheduler/read-model";

function row(over: Partial<DispatchReadRow> = {}): DispatchReadRow {
  return {
    id: over.dispatch_phid ?? "phid:disp-x",
    dispatch_id: over.dispatch_phid ?? "phid:disp-x",
    dispatch_phid: over.dispatch_phid ?? "phid:disp-x",
    query_id: null,
    agent_query_id: null,
    target_agent: "regina",
    agent_id: "regina",
    status: "done",
    title: "a dispatch",
    subject: "a dispatch",
    task_name: null,
    queued_at: null,
    in_flight_at: null,
    done_at: null,
    completed_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    failure_kind: null,
    failure_detail: null,
    supersede_link: null,
    needs_input: { clarification_id: null, active: null, history: [], resume_delivery_status: null },
    promotion: { promote: true, strategy: null, required_reason: null, input: null, result: null },
    recovery: { status: "none", attempts: 0, reason: null, side_effect: "none", allow_auto_retry: false },
    evidence: { artifact_path: null, promotion_result: null },
    recovery_classification: null,
    effective_state: "done",
    needs_operator: false,
    sort_group: 4,
    source_metadata: {
      source: "dispatch_scheduler_queue",
      team_id: "t",
      from_actor: null,
      channel: null,
      provider: null,
      runtime: null,
      priority: null,
      attempt_count: null,
      bounce_count: null,
      not_before_at: null,
    },
    source: "manager-http",
    ...over,
  } as DispatchReadRow;
}

const NOW = "2026-06-24T12:00:00Z";

test("landedDispatchesWithin keeps done/recovered/landed in window, newest first", () => {
  const rows = [
    row({ dispatch_phid: "p-old", effective_state: "done", completed_at: "2026-06-10T00:00:00Z" }), // > 7d ago
    row({ dispatch_phid: "p-done", effective_state: "done", completed_at: "2026-06-20T00:00:00Z" }),
    row({ dispatch_phid: "p-rec", effective_state: "done_recovered", completed_at: "2026-06-23T00:00:00Z" }),
    row({ dispatch_phid: "p-land", effective_state: "failed_work_landed_recoverable", completed_at: "2026-06-22T00:00:00Z" }),
    row({ dispatch_phid: "p-fail", effective_state: "failed_needs_operator", completed_at: "2026-06-23T00:00:00Z" }),
    row({ dispatch_phid: "p-flight", effective_state: "in_flight", completed_at: null, updated_at: "2026-06-24T00:00:00Z" }),
  ];
  const landed = landedDispatchesWithin(rows, NOW);
  // p-old excluded (outside 7d); p-fail + p-flight excluded (not landed states).
  expect(landed.map((r) => r.dispatch_phid)).toEqual(["p-rec", "p-land", "p-done"]);
});

test("collectProductLogDispatchDeltas summarizes totals + by-agent + recovered", () => {
  const rows = [
    row({ dispatch_phid: "a1", target_agent: "regina", effective_state: "done", completed_at: "2026-06-23T00:00:00Z" }),
    row({ dispatch_phid: "a2", target_agent: "regina", effective_state: "done_recovered", completed_at: "2026-06-22T00:00:00Z" }),
    row({ dispatch_phid: "a3", target_agent: "cto", effective_state: "done", completed_at: "2026-06-21T00:00:00Z" }),
    row({ dispatch_phid: "a4", target_agent: "cto", effective_state: "failed_work_landed_recoverable", completed_at: "2026-06-20T00:00:00Z" }),
    row({ dispatch_phid: "skip", target_agent: "cto", effective_state: "failed_needs_operator", completed_at: "2026-06-23T00:00:00Z" }),
  ];
  const d = collectProductLogDispatchDeltas(rows, NOW);
  expect(d.schema_version).toBe("loops.product-log.dispatches.v1");
  expect(d.window_hours).toBe(168);
  expect(d.landed_total).toBe(4);
  expect(d.recovered_total).toBe(2); // a2 done_recovered + a4 landed_recoverable
  expect(d.by_agent).toEqual([
    { agent: "cto", landed: 2 },
    { agent: "regina", landed: 2 },
  ]);
  expect(d.items).toHaveLength(4);
  expect(d.items[0].landed_at).toBe("2026-06-23T00:00:00Z"); // newest first
});

test("collector is deterministic + empty-safe", () => {
  const d = collectProductLogDispatchDeltas([], NOW);
  expect(d.landed_total).toBe(0);
  expect(d.by_agent).toEqual([]);
  expect(d.items).toEqual([]);
  expect(d.since).toBe(new Date(Date.parse(NOW) - PRODUCT_LOG_WINDOW_MS).toISOString());
});

test("unparseable now yields no landed rows (guard)", () => {
  expect(landedDispatchesWithin([row()], "not-a-date")).toEqual([]);
});

test("window_hours override narrows the period", () => {
  const rows = [
    row({ dispatch_phid: "recent", effective_state: "done", completed_at: "2026-06-24T06:00:00Z" }),
    row({ dispatch_phid: "yesterday", effective_state: "done", completed_at: "2026-06-23T00:00:00Z" }),
  ];
  // 24h window from NOW (2026-06-24T12:00) → only "recent" (06:00 same day).
  const d = collectProductLogDispatchDeltas(rows, NOW, 24 * 60 * 60 * 1000);
  expect(d.window_hours).toBe(24);
  expect(d.items.map((i) => i.dispatch_phid)).toEqual(["recent"]);
});
