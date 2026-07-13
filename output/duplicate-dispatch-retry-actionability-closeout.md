# Duplicate Dispatch Retry Actionability Closeout

Task: `duplicate-dispatch-retry-actionability`
Dispatch: `phid:disp-434103a522397471`
Branch: `duplicate-dispatch-retry-actionability`

## Change

- Extended the existing `/orchestration/backlog/duplicate-dispatch-retry-blockers` report instead of creating a parallel stale-duplicate report.
- Added v2 report fields for refuel operators:
  - `retry_safe_recommendation`: `set_true` or `leave_false`
  - `operator_disposition`: `close`, `retry`, or `hold`
- Updated `id-agents duplicate-dispatch-retry-blockers` text output to show each blocked `coitem`, owner, prior dispatch/status, retry_safe recommendation, and operator disposition.
- Preserved the prior granular `recommended_disposition` field for compatibility.
- Added per-item `ready_item_blockers.items[]` details to orchestration health, inherited by `/orchestration/status`, with prior dispatch id/status, retry-safe requirement, close/retry/hold disposition, recommended action, and stale duplicate closeout receipt presence.

## Verification

Passed:

```bash
npm test -- tests/unit/duplicate-dispatch-retry-blockers-cli.test.ts tests/unit/orchestration-duplicate-dispatch-retry-classifier.test.ts
npm test -- tests/unit/orchestration-health-projection.test.ts tests/unit/orchestration-duplicate-dispatch-retry-classifier.test.ts tests/unit/duplicate-dispatch-retry-blockers-cli.test.ts tests/integration/continuous-orchestration-daemon.test.ts
npm run build
```

## Promotion

Completed via `id-agents promote-to-main`.

- strategy: `squash`
- promoted branch: `duplicate-dispatch-retry-actionability`
- base: `main`
- remote: `origin`
- promoted SHA: `2a14293940f4a4a334e6ee04593088268408422b`
- remote main SHA: `2a14293940f4a4a334e6ee04593088268408422b`
