# Stale Duplicate Selector Repair

Task: repair-stale-duplicate-selector
Dispatch: phid:disp-f1258066639d1ee9

## Summary

Repaired the stale already-dispatched ready/needs_review reconciliation path so dry-run reports include rows whose prior dispatch is done, promotion-verified, superseded/moot/cancelled, or failed due to linked query expiry. Retry-safe failed rows remain excluded from closeout because those are explicit bounded-refire fuel.

The dry-run report suggests closeout/supersession through `stale_duplicate_closeout_receipt` and does not refire any row.

## Coverage

- done prior dispatch: reported as `to_state=done`, `next_action=close_duplicate_row`
- failed retry_safe row: excluded and counted as `preserved_retry_safe`
- active prior dispatch: excluded
- failed expired-linked-query prior dispatch: reported as `to_state=superseded`, `next_action=supersede_duplicate_row`

## Verification

- `npm test -- --run tests/integration/continuous-orchestration-daemon.test.ts`
- `npm run build:core`
