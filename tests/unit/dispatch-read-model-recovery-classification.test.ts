/**
 * Cn-EVE.1 (2026-06-16, phid:disp-d70c33cec2ce5a47) — false_expire_recovered
 * ledger classification.
 *
 * Pins the derivation contract for `recovery_classification` on
 * /dispatches read rows. A dispatch is "false_expire_recovered" when the
 * auto-recovery wiring (387f03b) found on-disk evidence (commit SHA on
 * main, artifact at a recorded path, or promotion result) for a row that
 * had been reported failed/expired, and the row got flipped to
 * status='done' with recovery_status in {landed_reconciled, verified_done}.
 *
 * The 4 known instances called out in the dispatch:
 *   1. Roger Task substrate first slice — commit 8945b9e (commit_evidence)
 *   2. W2-1 DispatchVerification — original false-expire (artifact)
 *   3. D3 auto-recovery dispatch itself — agent_error linked-query-terminated;
 *      work landed 3f140ec / 387f03b (commit_evidence)
 *   4. D7 cursor-coder-pilot — agent_error but no work on disk
 *      (NOT recovered — this is the negative case)
 */

import { test, expect } from "vitest";

import {
  deriveEmptySuccessCandidate,
  deriveRecoveryClassification,
} from "../../src/dispatch-scheduler/read-model";

// Shape matching the `RecoveryClassificationRow` Pick from read-model.ts.
type RowFields = {
  status: string;
  subject?: string | null;
  not_before_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  recovery_status: string | null;
  recovery_reason: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  artifact_path: string | null;
  promotion_result_json: string | null;
};

function row(overrides: Partial<RowFields> = {}): RowFields {
  return {
    status: "done",
    recovery_status: "verified_done",
    recovery_reason: "commit abc1234 verified on main",
    failure_kind: "agent_error",
    failure_detail: "linked query terminated mid-flight",
    artifact_path: null,
    promotion_result_json: null,
    ...overrides,
  };
}

// ---------- 4 known instances from the dispatch ----------

test("Cn-EVE.1: Instance #1 — Roger Task substrate (commit_evidence via SHA 8945b9e)", () => {
  const r = row({
    recovery_status: "verified_done",
    recovery_reason: "commit 8945b9e verified on main",
    failure_kind: "linked_query_terminated",
    failure_detail: "agent process exited before /agent-done",
    artifact_path: null,
    promotion_result_json: null,
  });
  const cls = deriveRecoveryClassification(r);
  expect(cls).not.toBeNull();
  expect(cls!.false_expire_recovered).toBe(true);
  expect(cls!.recovery_evidence.kind).toBe("commit_evidence");
  expect(cls!.recovery_evidence.commit_sha).toBe("8945b9e");
  expect(cls!.original_failure_reason?.kind).toBe("linked_query_terminated");
  expect(cls!.original_failure_reason?.detail).toBe(
    "agent process exited before /agent-done",
  );
});

test("Cn-EVE.1: Instance #2 — W2-1 DispatchVerification original false-expire (artifact)", () => {
  // Pattern: failed status got flipped to done, recovery_status=landed_reconciled
  // (not verified_done — this isn't a commit-evidence path), artifact_path
  // points at the verification artifact that proves work landed.
  const r = row({
    recovery_status: "landed_reconciled",
    recovery_reason: "reconciled: landed evidence present",
    failure_kind: "expired",
    failure_detail: "stale in_flight beyond runtime cap",
    artifact_path:
      "/Users/kilgore/Dropbox/Code/id-agents/output/2026-06-12-w2-1-dispatch-verification.md",
    promotion_result_json: null,
  });
  const cls = deriveRecoveryClassification(r);
  expect(cls).not.toBeNull();
  expect(cls!.false_expire_recovered).toBe(true);
  expect(cls!.recovery_evidence.kind).toBe("artifact");
  expect(cls!.recovery_evidence.commit_sha).toBeNull();
  expect(cls!.recovery_evidence.artifact_path).toBe(
    "/Users/kilgore/Dropbox/Code/id-agents/output/2026-06-12-w2-1-dispatch-verification.md",
  );
  expect(cls!.original_failure_reason?.kind).toBe("expired");
});

test("Cn-EVE.1: Instance #3 — D3 auto-recovery (commit_evidence; 3f140ec / 387f03b)", () => {
  // Pattern: D3 dispatch itself got reported as failed (linked_query_terminated),
  // but the work landed as commits 3f140ec + 387f03b on id-agents/main.
  // The recovery wiring detected the promoted_sha on main and marked
  // verified_done. The commit SHA in recovery_reason is the auth signal.
  const r = row({
    recovery_status: "verified_done",
    recovery_reason: "commit 3f140ec verified on main",
    failure_kind: "linked_query_terminated",
    failure_detail: "agent CLI exited 1 before reply",
    artifact_path: null,
    promotion_result_json: null,
  });
  const cls = deriveRecoveryClassification(r);
  expect(cls).not.toBeNull();
  expect(cls!.false_expire_recovered).toBe(true);
  expect(cls!.recovery_evidence.kind).toBe("commit_evidence");
  expect(cls!.recovery_evidence.commit_sha).toBe("3f140ec");
  expect(cls!.original_failure_reason?.kind).toBe("linked_query_terminated");
});

test("Cn-EVE.1: Instance #4 — D7 cursor-coder-pilot — NOT recovered (negative case)", () => {
  // Pattern: dispatch reported failed (agent_error), no on-disk evidence
  // — the auto-recovery wiring left the row as failed. status stays
  // 'failed', recovery_status stays 'needs_operator'. Must NOT be
  // classified as false_expire_recovered.
  const r = row({
    status: "failed",
    recovery_status: "needs_operator",
    recovery_reason: "no on-disk evidence; needs operator triage",
    failure_kind: "agent_error",
    failure_detail: "cursor-cli child exited 137 (OOM)",
    artifact_path: null,
    promotion_result_json: null,
  });
  expect(deriveRecoveryClassification(r)).toBeNull();
});

// ---------- derivation invariants ----------

test("Cn-EVE.1: clean done row (no failure_kind) is NOT a false-expire", () => {
  const r = row({
    status: "done",
    recovery_status: "none",
    recovery_reason: null,
    failure_kind: null,
    failure_detail: null,
  });
  expect(deriveRecoveryClassification(r)).toBeNull();
});

test("Cn-EVE.1: done row with landed_reconciled but no failure_kind is NOT classified", () => {
  // Edge: a row marked landed_reconciled by an admin override (no prior
  // failure). Without failure_kind, it's not a "false expire" — by
  // definition, false_expire requires a prior (false) failure.
  const r = row({
    status: "done",
    recovery_status: "landed_reconciled",
    recovery_reason: "reconciled: admin override",
    failure_kind: null,
    failure_detail: null,
  });
  expect(deriveRecoveryClassification(r)).toBeNull();
});

test("Cn-EVE.1: promotion-evidence path extracts promoted_sha from promotion_result_json", () => {
  const promo = {
    required: true,
    completed: true,
    repos: [
      {
        path: "/abs/repo",
        base: "main",
        source_branch: "feat-x",
        strategy: "fast_forward",
        promoted_sha: "deadbeef1234567",
        remote_main_sha: "deadbeef1234567",
        pushed: true,
        verified: true,
      },
    ],
  };
  const r = row({
    recovery_status: "landed_reconciled",
    recovery_reason: "reconciled: landed evidence present",
    failure_kind: "expired",
    failure_detail: "stale in_flight",
    artifact_path: null,
    promotion_result_json: JSON.stringify(promo),
  });
  const cls = deriveRecoveryClassification(r);
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.kind).toBe("promotion");
  expect(cls!.recovery_evidence.promotion_sha).toBe("deadbeef1234567");
});

test("Cn-EVE.1: commit_evidence wins over artifact when BOTH are present", () => {
  // Git history is the source of truth for "did this land?". If both
  // commit SHA and artifact are present, surface the row as commit_evidence.
  const r = row({
    recovery_status: "verified_done",
    recovery_reason: "commit abcd1234 verified on main",
    failure_kind: "linked_query_terminated",
    artifact_path: "/some/artifact.md",
  });
  const cls = deriveRecoveryClassification(r);
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.kind).toBe("commit_evidence");
  expect(cls!.recovery_evidence.commit_sha).toBe("abcd1234");
  // artifact_path still surfaced even though kind is commit_evidence.
  expect(cls!.recovery_evidence.artifact_path).toBe("/some/artifact.md");
});

test("Cn-EVE.1: artifact_path is surfaced on the recovery_evidence regardless of kind", () => {
  const r = row({
    recovery_status: "verified_done",
    recovery_reason: "commit cafe1234 verified on main",
    failure_kind: "agent_error",
    artifact_path: "/some/closeout.md",
  });
  const cls = deriveRecoveryClassification(r);
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.artifact_path).toBe("/some/closeout.md");
});

test("Cn-EVE.1: reason_text is preserved verbatim for operator audit", () => {
  const reason = "commit fedc1234 verified on main (D3 wiring detected on-disk landed)";
  const cls = deriveRecoveryClassification(row({ recovery_reason: reason }));
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.reason_text).toBe(reason);
});

test("Cn-EVE.1: original_failure_reason preserved across recovery", () => {
  const cls = deriveRecoveryClassification(
    row({
      failure_kind: "stale_runtime_cap",
      failure_detail: "claude-cli exceeded 60-min cap",
    }),
  );
  expect(cls).not.toBeNull();
  expect(cls!.original_failure_reason?.kind).toBe("stale_runtime_cap");
  expect(cls!.original_failure_reason?.detail).toBe("claude-cli exceeded 60-min cap");
});

test("Cn-EVE.1: rows still in_flight are NOT classified (not yet terminal)", () => {
  expect(deriveRecoveryClassification(row({ status: "in_flight" }))).toBeNull();
});

test("Cn-EVE.1: queued rows are NOT classified", () => {
  expect(deriveRecoveryClassification(row({ status: "queued" }))).toBeNull();
});

test("Cn-EVE.1: recovery_status='recovering' (mid-flight) is NOT classified", () => {
  // Active recovery — the row is being re-dispatched, not yet a false-expire
  // recovery decision.
  expect(
    deriveRecoveryClassification(row({ status: "done", recovery_status: "recovering" })),
  ).toBeNull();
});

test("Cn-EVE.1: malformed promotion_result_json doesn't crash the deriver", () => {
  const cls = deriveRecoveryClassification(
    row({
      recovery_status: "landed_reconciled",
      recovery_reason: "reconciled: landed evidence present",
      artifact_path: null,
      promotion_result_json: "{ not valid json",
    }),
  );
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.kind).toBe("unknown");
  expect(cls!.recovery_evidence.promotion_sha).toBeNull();
});

test("Cn-EVE.1: longer commit SHAs (40 chars) are extracted from recovery_reason", () => {
  const cls = deriveRecoveryClassification(
    row({
      recovery_reason: "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 verified on main",
    }),
  );
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.commit_sha).toBe(
    "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  );
});

test("Cn-EVE.1: recovery_status='landed_reconciled' without artifact OR promotion is 'unknown'", () => {
  // Defensive: a recovered row should never normally lack ALL evidence,
  // but the deriver shouldn't crash if it does — it surfaces as 'unknown'
  // so an operator can see the row was recovered but the evidence
  // pointer is missing (audit signal).
  const cls = deriveRecoveryClassification(
    row({
      recovery_status: "landed_reconciled",
      recovery_reason: "reconciled: legacy data; no evidence pointer",
      failure_kind: "agent_error",
      artifact_path: null,
      promotion_result_json: null,
    }),
  );
  expect(cls).not.toBeNull();
  expect(cls!.recovery_evidence.kind).toBe("unknown");
  expect(cls!.recovery_evidence.commit_sha).toBeNull();
  expect(cls!.recovery_evidence.artifact_path).toBeNull();
  expect(cls!.recovery_evidence.promotion_sha).toBeNull();
});

test("empty-success guard: fast done with no artifact/promotion/substantial output is classified", () => {
  const cls = deriveRecoveryClassification({
    status: "done",
    not_before_at: "2026-06-30T03:26:00.000Z",
    started_at: "2026-06-30T03:26:10.000Z",
    completed_at: "2026-06-30T03:26:31.000Z",
    recovery_status: null,
    recovery_reason: null,
    failure_kind: null,
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({ reply: "Done." }),
  });
  expect(cls).not.toBeNull();
  expect(cls!.false_expire_recovered).toBe(false);
  expect(cls!.empty_success_candidate).toBe(true);
  expect(cls!.completion_evidence?.elapsed_ms).toBe(21_000);
});

test("empty-success guard: recent coordinator refuel with no artifact is flagged with refuel-specific reason", () => {
  const cls = deriveRecoveryClassification({
    status: "done",
    subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
    started_at: "2026-07-12T12:06:07.191Z",
    completed_at: "2026-07-12T12:06:09.189Z",
    recovery_status: null,
    recovery_reason: null,
    failure_kind: null,
    failure_detail: null,
    artifact_path: null,
    promotion_result_json: null,
    result_json: null,
  });
  expect(cls).not.toBeNull();
  expect(cls!.false_expire_recovered).toBe(false);
  expect(cls!.empty_success_candidate).toBe(true);
  expect(cls!.empty_success_reason).toBe(
    "coordinator refuel done within 2m with no artifact_path or result evidence",
  );
  expect(cls!.completion_evidence?.result_keys).toEqual([]);
});

test("empty-success guard: recent refuel wave with task evidence and artifact_path is clean", () => {
  const result = {
    summary:
      "Created and owner-claimed 16 Kapelle backlog tasks; exact-name verification found 16/16 assigned, doing, tracked, and actionable_ready.",
    artifact_path: "output/refuel-kapelle-ready-backlog-wave-15.md",
    created_tasks: 16,
    claimed_tasks: 16,
    actionable_ready_after: 282,
  };
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
      started_at: "2026-07-12T12:26:12.949Z",
      completed_at: "2026-07-12T12:28:51.091Z",
      artifact_path: "output/refuel-kapelle-ready-backlog-wave-15.md",
      promotion_result_json: null,
      result_json: JSON.stringify(result),
    }).empty_success_candidate,
  ).toBe(false);
});

test("empty-success guard: wave 16 artifact-backed refuel with accepted count is clean", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
      started_at: "2026-07-12T13:16:07.191Z",
      completed_at: "2026-07-12T13:16:09.189Z",
      artifact_path: "output/refuel-kapelle-ready-backlog-wave-16.md",
      promotion_result_json: null,
      result_json: JSON.stringify({
        artifact_path: "output/refuel-kapelle-ready-backlog-wave-16.md",
        accepted_count: 12,
      }),
    }).empty_success_candidate,
  ).toBe(false);
});

test("empty-success guard: wave 17 promoted count is substantial evidence", () => {
  const cls = deriveEmptySuccessCandidate({
    status: "done",
    subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
    started_at: "2026-07-12T14:04:31.000Z",
    completed_at: "2026-07-12T14:04:33.000Z",
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({
      promoted_count: 8,
      accepted_count: 8,
    }),
  });

  expect(cls.empty_success_candidate).toBe(false);
  expect(cls.result_keys).toEqual(["accepted_count", "promoted_count"]);
});

test("empty-success guard: wave 18 output sources and created rows are substantial evidence", () => {
  const cls = deriveEmptySuccessCandidate({
    status: "done",
    subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
    started_at: "2026-07-12T14:29:55.429Z",
    completed_at: "2026-07-12T14:30:07.000Z",
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({
      sources: [
        "agent-platform/output/2026-07-12-kapelle-refuel-wave-18.md",
        "cto/output/2026-07-12-kapelle-pool-status.md",
      ],
      created_rows: [
        { item_id: "coitem_18a", title: "Kapelle P1: Verify source links", readiness_state: "needs_review" },
        { item_id: "coitem_18b", title: "Kapelle P1: Patch source badges", readiness_state: "needs_review" },
      ],
    }),
  });

  expect(cls.empty_success_candidate).toBe(false);
  expect(cls.result_keys).toEqual(["created_rows", "sources"]);
});

test("empty-success guard: wave 19 promote counts and post-status verification are substantial evidence", () => {
  const cls = deriveEmptySuccessCandidate({
    status: "done",
    subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
    started_at: "2026-07-12T14:45:10.000Z",
    completed_at: "2026-07-12T14:45:17.000Z",
    artifact_path: null,
    promotion_result_json: null,
    result_json: JSON.stringify({
      promote_counts: {
        considered: 12,
        promoted: 5,
        skipped: 7,
      },
      post_status_verification: {
        ready_before: 7,
        ready_after: 12,
        needs_review_after: 34,
        verified: true,
      },
    }),
  });

  expect(cls.empty_success_candidate).toBe(false);
  expect(cls.result_keys).toEqual(["post_status_verification", "promote_counts"]);
});

test("empty-success guard: empty wave evidence containers still need review", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
      started_at: "2026-07-12T14:45:10.000Z",
      completed_at: "2026-07-12T14:45:17.000Z",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({
        sources: [],
        created_rows: [],
        promote_counts: {
          considered: 0,
          promoted: 0,
          skipped: 0,
        },
        post_status_verification: {},
      }),
    }).empty_success_candidate,
  ).toBe(true);
});

test("empty-success guard: recent maestra refuel with explicit no-code promotion closeout is clean", () => {
  const cls = deriveEmptySuccessCandidate({
    status: "done",
    subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
    not_before_at: "2026-07-12T14:28:33.526Z",
    completed_at: "2026-07-12T14:28:35.479Z",
    artifact_path: null,
    promotion_result_json: JSON.stringify({
      required: false,
      completed: false,
      reason: "Backlog-only orchestration dispatch; no repo branch/build metadata and no code promotion required.",
    }),
    result_json: null,
  });

  expect(cls.empty_success_candidate).toBe(false);
  expect(cls.result_keys).toEqual([]);
});

test("empty-success guard: recent maestra empty closeout without evidence still needs review", () => {
  const cls = deriveEmptySuccessCandidate({
    status: "done",
    subject: "Kapelle P1: Draft Chris feedback and infra status brief",
    not_before_at: "2026-07-12T13:26:56.568Z",
    completed_at: "2026-07-12T13:26:59.243Z",
    artifact_path: null,
    promotion_result_json: null,
    result_json: null,
  });

  expect(cls.empty_success_candidate).toBe(true);
  expect(cls.reason).toBe(
    "done within 2m with no artifact_path, verified promotion, explicit noop/skip evidence, or substantial result output",
  );
});

test("empty-success guard: zero accepted/promoted counts without artifact still need review", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
      started_at: "2026-07-12T14:04:31.000Z",
      completed_at: "2026-07-12T14:04:33.000Z",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({
        accepted_count: 0,
        promoted_count: 0,
      }),
    }).empty_success_candidate,
  ).toBe(true);
});

test("empty-success guard: task/coitem evidence counts as substantial even with terse result text", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      subject: "[project: kapelle][AUTONOMOUS project-load-loop - backlog ran low, refueling] Re",
      started_at: "2026-07-12T12:26:12.949Z",
      completed_at: "2026-07-12T12:26:20.000Z",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({
        created_tasks: 3,
        follow_up_backlog_item: "coitem_9a123d92-df4d-4e1c-8a22-c49441b7c97b",
      }),
    }).empty_success_candidate,
  ).toBe(false);
});

test("empty-success guard: explicit skip/noop evidence is preserved as clean done", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      started_at: "2026-06-30T03:26:10.000Z",
      completed_at: "2026-06-30T03:26:31.000Z",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({
        skipped: true,
        reason: "Skipped: upstream dispatch already produced the requested artifact.",
      }),
    }).empty_success_candidate,
  ).toBe(false);
});

test("empty-success guard: substantial worker output is not suspect", () => {
  const substantial =
    "Verified existing implementation and intentionally made no code changes because the requested behavior is already covered by current tests and live route evidence.";
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      started_at: "2026-06-30T03:26:10.000Z",
      completed_at: "2026-06-30T03:26:31.000Z",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({ summary: substantial }),
    }).empty_success_candidate,
  ).toBe(false);
});

test("empty-success guard: terse summary or closeout text is not substantial evidence", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      started_at: "2026-07-12T13:26:56.568Z",
      completed_at: "2026-07-12T13:26:59.243Z",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({ summary: "Done.", closeout: "OK" }),
    }).empty_success_candidate,
  ).toBe(true);
});

test("empty-success guard: missing timing does not classify legacy done rows", () => {
  expect(
    deriveEmptySuccessCandidate({
      status: "done",
      artifact_path: null,
      promotion_result_json: null,
      result_json: JSON.stringify({ reply: "Done." }),
    }).empty_success_candidate,
  ).toBe(false);
});
