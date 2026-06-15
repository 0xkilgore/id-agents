# Dispatch Recovery — live wiring (checkpoint)

**Dispatch:** phid:disp-253f2e090bcef768 (P0 follow-up)
**Branch:** feat/dispatch-recovery-wiring (off origin/main @ 1bebc894 — foundation present)
**Status:** BUILDING.

## Goal
Wire the recovery foundation (classifier+service) into the live manager so landed
work stops sitting as failed/expired. landed beats retry — never duplicate work
when promotion/artifact evidence exists.

## Plan
1. Additive DispatchDoc + reactor Row + migrations(sqlite/postgres) fields:
   recovery_status (none|recovering|landed_reconciled|needs_operator|exhausted|unsafe_side_effect),
   recovery_attempts (int), recovery_reason (text). side_effect/allow_auto_retry
   sourced from dispatch metadata (default none/false).
2. DispatchRecoveryReactor adapter on SqliteDispatchReactor:
   - listFailedForRecovery: SELECT failed in lookback → RecoverableDispatch
     (recovery_attempts from column; promotion_completed from promotion_result_json;
     artifact_path from column; side_effect/allow_auto_retry default safe).
   - requeueForRecovery: markBounced(kind:"recovery")+requeueAfterBounce, bump recovery_attempts, set recovery_status=recovering.
   - markRecoveryLanded: flip failed→done, recovery_status=landed_reconciled (landed beats retry; no re-dispatch).
   - recordRecoveryOutcome: set recovery_status + recovery_reason (operator surface; NOT panic).
3. Wire DispatchRecoveryService.runOnce on a bounded periodic job in AgentManagerDb
   (env DISPATCH_RECOVERY_ENABLED), never throws out of the loop.
4. Backfill/reconcile the four phids (b329f522…, 5b04adac…, 88793d3a…, 21cacf93…).
5. read-model / /dispatches exposes recovery_status + promotion so /ops stops counting landed rows as attention.
6. Tests: adapter unit + reconciliation integration (expired+promotion→landed_reconciled no-retry; expired internal no-evidence→requeue; external→unsafe/operator).

## Next target if runtime expires
Min landed slice = additive fields + adapter + reconcile + unit tests (the live
reconcile is the load-bearing part). Then wiring + backfill.
