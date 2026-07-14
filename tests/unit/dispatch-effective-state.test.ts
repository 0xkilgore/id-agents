/**
 * T13.2 — dispatch effective_state derivation (phid:disp-1e2819f568b08704,
 * 2026-06-17). Pins the 8 derivation rules from
 * cto/output/2026-06-16-dispatch-failure-state-taxonomy-scope.md
 * §"Derivation Rules" AND the 44-failed corpus pattern Chris observed on
 * 2026-06-16 (35 restart-casualties + 9 rate-limit moot + remainder
 * genuine).
 */

import { test, expect } from "vitest";

import {
  deriveEffectiveActionableState,
  deriveEffectiveState,
  deriveNeedsOperator,
} from "../../src/dispatch-scheduler/read-model";

type RowFields = {
  status: string;
  subject?: string | null;
  recovery_status: string | null;
  recovery_reason: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  artifact_path: string | null;
  promotion_result_json: string | null;
  result_json?: string | null;
  not_before_at: string | null;
  started_at: string | null;
  completed_at?: string | null;
  updated_at: string;
};

function row(overrides: Partial<RowFields> = {}): RowFields {
  return {
    status: "failed",
    recovery_status: null,
    recovery_reason: null,
    failure_kind: null,
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    not_before_at: null,
    started_at: null,
    updated_at: "2026-06-17T00:00:00Z",
    ...overrides,
  };
}

// ============================================================
// Rule 4 — triaged moot (infra-death / superseded)
// ============================================================

test("Rule 4: failed + recovery_status=moot -> moot_or_superseded (NOT needs_operator)", () => {
  const r = row({ status: "failed", recovery_status: "moot", failure_kind: "scheduler_wedged" });
  expect(deriveEffectiveState(r)).toBe("moot_or_superseded");
  expect(deriveNeedsOperator(r)).toBe(false);
});

test("Rule 4: a wedge WITHOUT the moot marker still needs an operator", () => {
  const r = row({ status: "failed", recovery_status: "none", failure_kind: "scheduler_wedged" });
  expect(deriveEffectiveState(r)).toBe("failed_needs_operator");
});

// ============================================================
// Rule 1 — raw active states
// ============================================================

test("Rule 1: queued -> queued", () => {
  expect(deriveEffectiveState(row({ status: "queued" }))).toBe("queued");
});

test("Rule 1: in_flight -> in_flight", () => {
  expect(deriveEffectiveState(row({ status: "in_flight" }))).toBe("in_flight");
});

// ============================================================
// Rule 2 — done states
// ============================================================

test("Rule 2: clean done -> done (no recovery_status)", () => {
  expect(
    deriveEffectiveState(row({ status: "done", recovery_status: "none" })),
  ).toBe("done");
});

test("Rule 2: refuel wave with task evidence and artifact_path stays done, not needs_review", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
        recovery_status: null,
        started_at: "2026-07-12T12:26:12.949Z",
        completed_at: "2026-07-12T12:28:51.091Z",
        artifact_path: "output/refuel-kapelle-ready-backlog-wave-15.md",
        promotion_result_json: null,
        result_json: JSON.stringify({
          artifact_path: "output/refuel-kapelle-ready-backlog-wave-15.md",
          created_tasks: 16,
          claimed_tasks: 16,
        }),
      }),
    ),
  ).toBe("done");
});

test("Rule 2: refuel wave with accepted/promoted counts stays done, not needs_review", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
        recovery_status: null,
        started_at: "2026-07-12T14:04:31.000Z",
        completed_at: "2026-07-12T14:04:33.000Z",
        artifact_path: null,
        promotion_result_json: null,
        result_json: JSON.stringify({
          accepted_count: 8,
          promoted_count: 8,
        }),
      }),
    ),
  ).toBe("done");
});

test("Rule 2: refuel no-code promotion closeout stays done, not needs_review", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
        recovery_status: null,
        not_before_at: "2026-07-12T14:28:33.526Z",
        completed_at: "2026-07-12T14:28:35.479Z",
        artifact_path: null,
        promotion_result_json: JSON.stringify({
          required: false,
          completed: false,
          reason: "Backlog-only orchestration dispatch; no repo branch/build metadata and no code promotion required.",
        }),
        result_json: null,
      }),
    ),
  ).toBe("done");
});

test("Rule 2: fast empty maestra closeout without evidence still needs_review", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        subject: "Kapelle P1: Draft Chris feedback and infra status brief",
        recovery_status: null,
        not_before_at: "2026-07-12T13:26:56.568Z",
        completed_at: "2026-07-12T13:26:59.243Z",
        artifact_path: null,
        promotion_result_json: null,
        result_json: null,
      }),
    ),
  ).toBe("needs_review");
});

test("Rule 2: clean done with no failure_kind -> done (even with landed_reconciled)", () => {
  // Edge: row reached done via the recovery wiring but was never marked failed
  // (admin override / non-failure landed_reconciled). Still emit `done` — the
  // taxonomy `done_recovered` requires a prior failure to be a meaningful label.
  expect(
    deriveEffectiveState(
      row({ status: "done", recovery_status: "landed_reconciled", failure_kind: null }),
    ),
  ).toBe("done");
});

test("Rule 2: done after recovery (failure_kind preserved) -> done_recovered", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        recovery_status: "landed_reconciled",
        failure_kind: "linked_query_terminated",
      }),
    ),
  ).toBe("done_recovered");
});

test("Rule 2: done after verified_done (commit-evidence reconcile) -> done_recovered", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        recovery_status: "verified_done",
        failure_kind: "agent_error",
        recovery_reason: "commit abc1234 verified on main",
      }),
    ),
  ).toBe("done_recovered");
});

test("Rule 2: done after retry_done -> done_recovered", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "done",
        recovery_status: "retry_done",
        failure_kind: "rate_limit_error",
      }),
    ),
  ).toBe("done_recovered");
});

// ============================================================
// Rule 3 — recovery evidence proves work landed (status STILL failed)
// ============================================================

test("Rule 3: failed + landed_reconciled -> failed_work_landed_recoverable", () => {
  // The restart-casualty pattern Chris saw: status stayed `failed` because
  // /agent-done never landed, but the recovery wiring found on-disk evidence.
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "landed_reconciled",
        failure_kind: "linked_query_terminated",
        artifact_path: "/abs/some/closeout.md",
      }),
    ),
  ).toBe("failed_work_landed_recoverable");
});

test("Rule 3: failed + verified_done (commit evidence) -> failed_work_landed_recoverable", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "verified_done",
        recovery_reason: "commit 3f140ec verified on main",
        failure_kind: "linked_query_terminated",
      }),
    ),
  ).toBe("failed_work_landed_recoverable");
});

test("Rule 3: failed linked-query-expired + completed verified promotion -> failed_work_landed_recoverable", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "none",
        failure_kind: "agent_error",
        failure_detail: "linked query terminated expired",
        promotion_result_json: JSON.stringify({
          required: true,
          completed: true,
          repos: [
            {
              path: "/Users/kilgore/Dropbox/Code/cane/id-agents",
              base: "main",
              source_branch: "routing-lifecycle-hygiene",
              promoted_sha: "abc123",
              remote_main_sha: "abc123",
              pushed: true,
              verified: true,
            },
          ],
        }),
      }),
    ),
  ).toBe("failed_work_landed_recoverable");
});

test("Rule 3: completed promotion with unverified repo does not mask historical linked-query expiry", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "none",
        failure_kind: "agent_error",
        failure_detail: "linked query terminated expired",
        promotion_result_json: JSON.stringify({
          required: true,
          completed: true,
          repos: [{ path: "/repo", verified: false }],
        }),
      }),
    ),
  ).toBe("historical_failure");
});

test("linked-query-expired terminal failures are historical and non-actionable", () => {
  const expired = row({
    status: "failed",
    recovery_status: "none",
    failure_kind: "agent_error",
    failure_detail: "linked query terminated expired",
  });
  const effective = deriveEffectiveState(expired);

  expect(effective).toBe("historical_failure");
  expect(deriveNeedsOperator(expired)).toBe(false);
  expect(deriveEffectiveActionableState(effective, false)).toEqual({
    state: "historical_failure",
    action_kind: "none",
    needs_you: false,
  });
});

// ============================================================
// Rule 5 — recovery-terminal failure statuses
// ============================================================

test("Rule 5: failed + unsafe_side_effect -> failed_needs_operator", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "unsafe_side_effect",
        failure_kind: "linked_query_terminated",
      }),
    ),
  ).toBe("failed_needs_operator");
});

test("Rule 5: failed + exhausted -> failed_needs_operator", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "exhausted",
        failure_kind: "agent_error",
      }),
    ),
  ).toBe("failed_needs_operator");
});

test("Rule 5: failed + needs_operator recovery_status -> failed_needs_operator", () => {
  expect(
    deriveEffectiveState(
      row({
        status: "failed",
        recovery_status: "needs_operator",
        failure_kind: "agent_error",
      }),
    ),
  ).toBe("failed_needs_operator");
});

// ============================================================
// Rule 6 — strict-mode hard failures
// ============================================================

test.each([
  "provider_auth_error",
  "context_length_error",
  "tool_error",
  "agent_refusal",
  "malformed_agent_response",
  "dispatch_id_mismatch",
  "dispatch_not_found",
  "unknown_error",
])("Rule 6: failed + %s -> failed_needs_operator", (kind) => {
  expect(
    deriveEffectiveState(row({ status: "failed", failure_kind: kind })),
  ).toBe("failed_needs_operator");
});

// ============================================================
// Rule 7 — retryable provider failures without supersede/evidence
// ============================================================

test.each([
  "rate_limit_error",
  "provider_server_error",
  "provider_timeout",
])("Rule 7: failed + %s without supersede/landed -> failed_needs_operator", (kind) => {
  expect(
    deriveEffectiveState(row({ status: "failed", failure_kind: kind })),
  ).toBe("failed_needs_operator");
});

// ============================================================
// Rule 8 — fallback
// ============================================================

test("Rule 8: failed + unknown failure_kind -> failed_needs_operator", () => {
  expect(
    deriveEffectiveState(
      row({ status: "failed", failure_kind: "some_new_failure_we_dont_know_about" }),
    ),
  ).toBe("failed_needs_operator");
});

test("Rule 8: failed with no failure_kind at all -> failed_needs_operator", () => {
  // Defensive — should not normally happen but must not crash.
  expect(deriveEffectiveState(row({ status: "failed", failure_kind: null }))).toBe(
    "failed_needs_operator",
  );
});

// ============================================================
// Passthrough for unknown statuses
// ============================================================

test("non-failed, non-active status passes through (e.g. cancelled)", () => {
  expect(deriveEffectiveState(row({ status: "cancelled" }))).toBe("cancelled");
});

test("needs_clarification passes through (operator clarification is its own state)", () => {
  expect(deriveEffectiveState(row({ status: "needs_clarification" }))).toBe(
    "needs_clarification",
  );
});

test("needs_clarification that blocks dependencies stays a live clarification blocker", () => {
  const r = row({
    status: "needs_clarification",
    subject: "[project: kapelle][T-DEP] blocked on upstream API contract",
    not_before_at: "2026-07-13T10:00:00.000Z",
    started_at: "2026-07-13T10:00:15.000Z",
    completed_at: null,
    updated_at: "2026-07-13T10:02:00.000Z",
    recovery_status: "none",
    failure_kind: null,
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({
      clarification_id: "clar_dependency_contract",
      blocked_dependency_item_ids: ["coitem-downstream-build"],
      question: "Which API contract version should downstream builds target?",
    }),
  });

  expect(deriveEffectiveState(r)).toBe("needs_clarification");
  expect(deriveNeedsOperator(r, Date.parse("2026-07-13T12:00:00.000Z"))).toBe(false);
});

test("expired retryable clarification noise is not promoted to needs_review fuel by closeout classification", () => {
  const r = row({
    status: "needs_clarification",
    subject: "[project: kapelle][T-ORCH] retryable provider noise clarification",
    not_before_at: "2026-07-13T09:00:00.000Z",
    started_at: "2026-07-13T09:00:10.000Z",
    completed_at: null,
    updated_at: "2026-07-13T09:01:00.000Z",
    recovery_status: "moot",
    recovery_reason: "clarification expired as retryable noise after replacement dispatch succeeded",
    failure_kind: "provider_timeout",
    failure_detail: "transient provider timeout while waiting for clarification resume",
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({
      clarification_id: "clar_retryable_noise",
      expired: true,
      retryable_noise: true,
    }),
  });

  expect(deriveEffectiveState(r)).toBe("needs_clarification");
  expect(deriveNeedsOperator(r, Date.parse("2026-07-13T12:00:00.000Z"))).toBe(false);
});

test("needs_clarification requiring operator input preserves the clarification state", () => {
  const r = row({
    status: "needs_clarification",
    subject: "[project: kapelle][T-ORCH] choose promotion strategy",
    not_before_at: "2026-07-13T11:00:00.000Z",
    started_at: "2026-07-13T11:00:10.000Z",
    completed_at: null,
    updated_at: "2026-07-13T11:01:00.000Z",
    recovery_status: "none",
    failure_kind: null,
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({
      clarification_id: "clar_operator_strategy",
      question: "Should this divergent branch merge, squash, or wait?",
      options: ["merge", "squash", "wait"],
    }),
  });

  expect(deriveEffectiveState(r)).toBe("needs_clarification");
  expect(deriveNeedsOperator(r, Date.parse("2026-07-13T12:00:00.000Z"))).toBe(false);
});

// ============================================================
// 44-failed corpus (2026-06-16 operator-trust incident)
// ============================================================
// Chris's split:
//   35 restart-casualties — work landed; recovery wiring reconciled
//    9 rate-limit moot — sentinel retries; replacement done (will be
//                       moot_or_superseded once supersede_link lands;
//                       for now falls to failed_needs_operator)
//   ~few genuine failures — auth errors / agent refusals
//
// This block locks the migration expectation per the dispatch
// acceptance: 35 -> recoverable/moot, genuine -> needs_operator.

test("44-corpus #1: restart-casualty (linked_query_terminated + landed evidence)", () => {
  // The dominant pattern: 35 of 44. Status=failed, recovery wiring caught
  // the on-disk landed-work, but raw `status` stays failed because the
  // original /agent-done never landed.
  const state = deriveEffectiveState(
    row({
      status: "failed",
      failure_kind: "linked_query_terminated",
      recovery_status: "verified_done",
      recovery_reason: "commit deadbeef verified on main",
    }),
  );
  expect(state).toBe("failed_work_landed_recoverable");
});

test("44-corpus #2: restart-casualty (artifact-evidence reconcile)", () => {
  const state = deriveEffectiveState(
    row({
      status: "failed",
      failure_kind: "linked_query_terminated",
      recovery_status: "landed_reconciled",
      artifact_path: "/abs/path/to/closeout.md",
    }),
  );
  expect(state).toBe("failed_work_landed_recoverable");
});

test("44-corpus #3: rate-limit moot — without supersede_link falls to needs_operator (safe)", () => {
  // 9 of 44. Once supersede_link lands as a column, this pattern flips to
  // moot_or_superseded. For now the row surfaces to the operator — the
  // SAFE direction per scope §7 ("retryable does not mean ignorable").
  // This test pins that intermediate behavior; when v2 lands, the test
  // becomes a clear migration signal.
  const state = deriveEffectiveState(
    row({
      status: "failed",
      failure_kind: "rate_limit_error",
      recovery_status: "none",
    }),
  );
  expect(state).toBe("failed_needs_operator");
});

test("44-corpus #4: genuine auth failure", () => {
  const state = deriveEffectiveState(
    row({
      status: "failed",
      failure_kind: "provider_auth_error",
      failure_detail: "Anthropic 401 — key revoked",
    }),
  );
  expect(state).toBe("failed_needs_operator");
});

test("44-corpus #5: genuine agent_refusal", () => {
  const state = deriveEffectiveState(
    row({
      status: "failed",
      failure_kind: "agent_refusal",
    }),
  );
  expect(state).toBe("failed_needs_operator");
});

// ============================================================
// needs_operator derivation
// ============================================================

test("needs_operator: failed_needs_operator -> true", () => {
  expect(
    deriveNeedsOperator(row({ status: "failed", failure_kind: "agent_refusal" })),
  ).toBe(true);
});

test("needs_operator: failed_work_landed_recoverable -> false (collapsed)", () => {
  expect(
    deriveNeedsOperator(
      row({
        status: "failed",
        failure_kind: "linked_query_terminated",
        recovery_status: "verified_done",
      }),
    ),
  ).toBe(false);
});

test("needs_operator: done -> false", () => {
  expect(deriveNeedsOperator(row({ status: "done" }))).toBe(false);
});

test("needs_operator: done_recovered -> false (recovery handled it)", () => {
  expect(
    deriveNeedsOperator(
      row({
        status: "done",
        recovery_status: "verified_done",
        failure_kind: "agent_error",
      }),
    ),
  ).toBe(false);
});

test("needs_operator: queued fresh (within stale window) -> false", () => {
  const now = Date.parse("2026-06-17T12:00:00Z");
  expect(
    deriveNeedsOperator(
      row({
        status: "queued",
        not_before_at: "2026-06-17T11:55:00Z", // 5 min ago < 20 min stale
      }),
      now,
    ),
  ).toBe(false);
});

test("needs_operator: queued stale (>20 min) -> true", () => {
  const now = Date.parse("2026-06-17T12:00:00Z");
  expect(
    deriveNeedsOperator(
      row({
        status: "queued",
        not_before_at: "2026-06-17T11:30:00Z", // 30 min ago
      }),
      now,
    ),
  ).toBe(true);
});

test("needs_operator: in_flight fresh (within stale window) -> false", () => {
  const now = Date.parse("2026-06-17T12:00:00Z");
  expect(
    deriveNeedsOperator(
      row({
        status: "in_flight",
        started_at: "2026-06-17T11:30:00Z", // 30 min ago < 45 min stale
      }),
      now,
    ),
  ).toBe(false);
});

test("needs_operator: in_flight stale (>45 min) -> true", () => {
  const now = Date.parse("2026-06-17T12:00:00Z");
  expect(
    deriveNeedsOperator(
      row({
        status: "in_flight",
        started_at: "2026-06-17T11:00:00Z", // 60 min ago
      }),
      now,
    ),
  ).toBe(true);
});

test("needs_operator: queued with no not_before_at returns false (no staleness signal)", () => {
  expect(
    deriveNeedsOperator(row({ status: "queued", not_before_at: null })),
  ).toBe(false);
});

test("needs_operator: in_flight with no started_at returns false", () => {
  expect(
    deriveNeedsOperator(row({ status: "in_flight", started_at: null })),
  ).toBe(false);
});
