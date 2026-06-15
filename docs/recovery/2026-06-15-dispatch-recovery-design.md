# Dispatch Recovery System — design + checkpoint

**Date:** 2026-06-15
**Dispatch:** phid:disp-b329f522b1271e1b (P0 incident reliability patch)
**Branch:** feat/dispatch-recovery
**Status:** SHIPPED (foundation) — pure classifier + recovery service landed &
fully tested (19 tests; both required regressions green). Reactor/manager wiring
is the next patch (see "Next patch target").

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

## What shipped this patch

- `src/dispatch-recovery/classifier.ts` — pure `classifyRecovery()` +
  `DEFAULT_RECOVERY_CONFIG`. 11 tests.
- `src/dispatch-recovery/service.ts` — `DispatchRecoveryService.runOnce()`
  (env-gated, budgeted, capped-exponential backoff, never throws) +
  `recoveryConfigFromEnv()`. 8 tests.
- Regressions proven: a failed dispatch with
  `failure_detail="linked query terminated expired"` becomes an automatic
  requeue; an external-side-effect dispatch is NOT auto-resent.

Safe to ship dark: `DISPATCH_RECOVERY_ENABLED` defaults **false**. Nothing runs
until the wiring below is added AND the flag is set.

## Next patch target (the wiring to make it live)

1. **Reactor adapter** implementing `DispatchRecoveryReactor` over
   `SqliteDispatchReactor`:
   - `listFailedForRecovery()` → `SELECT * FROM dispatch_scheduler_queue WHERE
     team_id=? AND status='failed' AND updated_at >= <lookback>`, mapped to
     `RecoverableDispatch`. Compute `recovery_attempts` by counting
     `bounce_history` entries with `kind='recovery'`. Source `side_effect` /
     `allow_auto_retry` from the dispatch message metadata (add a
     `recovery_metadata` field on enqueue, or parse from body/subject; default
     `side_effect:"none"`, `allow_auto_retry:false`).
   - `requeueForRecovery(phid,{reason,next_attempt_at})` → `markBounced(phid,
     {kind:"recovery", message:reason, next_attempt_at})` then
     `requeueAfterBounce(phid)` (reuses existing machinery; sweepBounced
     re-dispatches after the backoff).
   - `markRecoveryLanded(phid)` → reconcile: if `artifact_path` exists or
     promotion completed, `markDoneWithResult` (or a new `markRecoveryLanded`
     terminal that flips failed→done with a recovery note).
   - `recordRecoveryOutcome(phid,{decision,reason})` → write a recovery row /
     stamp a `recovery_status` so /ops shows `recovering` vs `needs_operator`
     (de-panic: only `unsafe_side_effect`/`exhausted`/`needs_operator` alert).
2. **Manager interval** in `AgentManagerDb` startup beside the scheduler:
   `new DispatchRecoveryService({reactor: adapter, ...recoveryConfigFromEnv(env)})`
   on a 5-min interval (`runOnce()`), `stop()` on shutdown.
3. **/ops surface**: a `recovering` lane so the 24 stuck rows show as
   auto-recovering, not as operator panic.
4. Backfill the 24 existing expired rows by running `runOnce()` once with the
   flag on.
