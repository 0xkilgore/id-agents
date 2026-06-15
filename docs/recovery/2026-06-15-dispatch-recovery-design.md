# Dispatch Recovery System — design + checkpoint

**Date:** 2026-06-15
**Dispatch:** phid:disp-b329f522b1271e1b (P0 incident reliability patch)
**Branch:** feat/dispatch-recovery
**Status:** CHECKPOINT — building.

## Incident

24 expired/stuck dispatches on /ops. Terminal failures with
`failure_detail = "linked query terminated expired"` (produced by
`applyQueryEvidenceToInFlight` in scheduler-service.ts when the linked query
status is terminal/expired) were left as dead failures with no automatic
recovery — including dispatches that ACTUALLY landed (W3-11, the expiry fix
itself committed/promoted but got marked expired). Operators had to babysit.

## Goal

Auto-recover/retry failed/expired dispatches when safe; only surface to the
operator after exhaustion or genuine unsafety. Never auto-resend external
side effects (email/payment/delete/user-visible) without explicit opt-in.

## Shippable patch (this dispatch)

### A. Recovery classifier (pure) — `src/dispatch-recovery/classifier.ts`
`classifyRecovery(input): DispatchRecoveryDecision` where decision ∈
`landed | retryable | unsafe_side_effect | exhausted | needs_operator`.

Rules (in order):
1. **landed** — the dispatch actually produced evidence of completion despite
   the failed marker: a non-empty `artifact_path`, OR a completed promotion
   block (`promotion_result.completed === true`). → reconcile, do NOT retry.
2. **unsafe_side_effect** — the dispatch is an external/irreversible action
   (channel or metadata marks it email/payment/delete/user-visible) and does
   NOT carry an explicit `allow_auto_retry: true` opt-in. → needs_operator;
   never auto-resend.
3. **exhausted** — recovery attempts already at/over the cap. → needs_operator.
4. **retryable** — internal work whose failure is a recoverable transient
   (`linked query terminated expired`, `scheduler_wedged`, provider transient)
   and under the attempt cap. → auto-requeue with lineage + backoff.
5. **needs_operator** — anything ambiguous (default).

### B. Recovery service/job — `src/dispatch-recovery/service.ts`
`DispatchRecoveryService.runOnce()` scans terminal-failed dispatches, classifies
each, and:
- `retryable` (within per-run budget) → reuse the existing bounced/requeue
  machinery (`markBounced(kind:"recovery", lineage…)` + `requeueAfterBounce`)
  with capped attempts + backoff; record recovery lineage metadata.
- `landed` → reconcile to done/landed (no retry).
- `unsafe_side_effect` / `exhausted` / `needs_operator` → leave failed, flag
  as `needs_operator` (NOT panic) for /ops.
Env-gated: `DISPATCH_RECOVERY_ENABLED` (default false during rollout, opt-in),
`DISPATCH_RECOVERY_MAX_ATTEMPTS` (default 3), `DISPATCH_RECOVERY_BUDGET`
(max auto-retries per run, default 10).

### C/D. Side-effect protection + de-panic
Built into the classifier (C) and the service's decision surface (D): only
`exhausted`/`unsafe_side_effect`/`needs_operator` warrant operator attention;
`retryable`/`landed` are handled automatically and reported as `recovering`/
`recovered`.

### E. Tests
- classifier: `linked query terminated expired` internal work → **retryable**
  (the headline regression); external-side-effect dispatch without opt-in →
  **unsafe_side_effect** (no auto-retry); landed (artifact present) → **landed**;
  attempts at cap → **exhausted**.
- service: a failed/expired internal dispatch is auto-requeued (re-enters the
  queue); an external-side-effect dispatch is NOT resent.

## Next patch target (if runtime expires mid-build)
If unfinished, the minimum landed slice is the pure `classifier.ts` + its tests
(the decision logic is the load-bearing part and is reused by the service).
Next: wire `DispatchRecoveryService.runOnce()` and a manager-side interval +
the `recovering` /ops surface.
