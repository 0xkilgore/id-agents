# Dispatch Recovery — live wiring closeout

**Dispatch:** phid:disp-253f2e090bcef768 (P0 follow-up)
**Promoted SHA:** 387f03b05756294f34907fc011e66ae3017f7e22 (id-agents main)
**Branch:** feat/dispatch-recovery-wiring

## Shipped (live integration, not foundation-only)

- Additive recovery columns on `dispatch_scheduler_queue` (DispatchDoc + reactor
  Row/INSERT(41 ?)/rowToDoc + sqlite/postgres migrations, safe defaults):
  recovery_status, recovery_attempts, recovery_reason, side_effect,
  allow_auto_retry. read-model exposes `recovery` + `evidence`
  (promotion/artifact) blocks for /ops.
- `SqliteDispatchReactor` IS the live `DispatchRecoveryReactor` adapter:
  listFailedForRecovery (failed-in-lookback, excludes already-triaged),
  requeueForRecovery (failed → bounced via existing bounce machinery + backoff +
  recovery_status=recovering + attempts++), markRecoveryLanded (failed → done +
  landed_reconciled, guarded/idempotent — LANDED BEATS RETRY, no re-dispatch),
  recordRecoveryOutcome (stamp recovery_status; operator surface, not panic).
- `DispatchRecoveryService.start()/stop()`: a backfill pass on boot + a bounded
  periodic loop; never throws out of the manager loop.
- Wired into `AgentManagerDb` startup beside the verification job + scheduler
  (env `DISPATCH_RECOVERY_ENABLED` default OFF), stopped on shutdown.

## Tests
classifier 11, service+start/stop 10, fields 2, end-to-end integration over real
sqlite 4 (failed+promotion → done/landed_reconciled NO retry; internal expired no
evidence → requeued w/ recovery metadata; external side effect → unsafe, not
resent; idempotent on 2nd pass). Full suite **1679 passed / 0 failed** (Node 23);
`npm run build` clean.

## The four phids — exact status + what the job will do

Verified live (read-only via GET /dispatches): all four are `status=failed`,
`failure_detail="linked query terminated expired"`, AND carry
`promotion.result.completed=true` with `repos[].pushed=verified=true` on the
dispatch row:

| phid | status now | promotion.completed | classifier → action |
|---|---|---|---|
| disp-b329f522b1271e1b | failed | true | LANDED → reconcile to done/landed_reconciled |
| disp-5b04adac9be9e613 | failed | true | LANDED → reconcile to done/landed_reconciled |
| disp-88793d3a3faf7199 | failed | true | LANDED → reconcile to done/landed_reconciled |
| disp-21cacf932ee3e212 | failed | true | LANDED → reconcile to done/landed_reconciled |

The evidence is ON the rows, so the recovery job reconciles all four to
`done` (recovery_status `landed_reconciled`) — NO re-dispatch, no duplicated
work. This is exercised by the integration test (real sqlite, same shape).

## Operator action (to actually reconcile the 24 / these 4)

1. Restart the manager on `387f03b` (loads the wired recovery service + the
   migrations that add the recovery columns).
2. Set `DISPATCH_RECOVERY_ENABLED=true` (default off). On boot, `start()` runs
   one backfill pass immediately → the four (and every landed-failed row in the
   30d lookback) flip to done/landed_reconciled; recoverable internal failures
   without evidence requeue with backoff; external side effects route to
   needs-operator. Then it runs every `DISPATCH_RECOVERY_INTERVAL_MS` (default
   5 min). Tune `DISPATCH_RECOVERY_BUDGET` / `_MAX_ATTEMPTS` / `_BACKOFF_MS`.
3. /ops should read `recovery_status` (and the read-model `recovery`/`evidence`
   blocks) so reconciled/recovering rows stop counting as operator attention.

I did NOT mutate the live DB directly (the running manager holds the sqlite
single-writer); the boot-time backfill does it safely on restart, and I verified
the exact row data + classifier outcome above so the result is deterministic.
