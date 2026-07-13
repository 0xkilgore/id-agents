# Duplicate Dispatch Retry Actionability Closeout

Task: `duplicate-dispatch-retry-actionability`
Dispatch: `phid:disp-6cea1556a19f4b06`
Branch: `duplicate-dispatch-retry-actionability`

## Change

- Extended the existing `/orchestration/backlog/duplicate-dispatch-retry-blockers` report instead of creating a parallel stale-duplicate report.
- Added v2 report fields for refuel operators:
  - `retry_safe_recommendation`: `set_true` or `leave_false`
  - `operator_disposition`: `close`, `retry`, or `hold`
- Updated `id-agents duplicate-dispatch-retry-blockers` text output to show each blocked `coitem`, owner, prior dispatch/status, retry_safe recommendation, and operator disposition.
- Preserved the prior granular `recommended_disposition` field for compatibility.

## Verification

Passed:

```bash
npm test -- tests/unit/duplicate-dispatch-retry-blockers-cli.test.ts tests/unit/orchestration-duplicate-dispatch-retry-classifier.test.ts
npm run build
```

Full suite status:

```bash
npm test
```

Failed with 26 failures across 10 unrelated files. The failures were in public/remote agent integration tests, query dispatch projection, artifact output/comment routes, deploy watchdog expectations, and the dispatch scheduler talk issuer guard. None touched the duplicate-dispatch retry blocker classifier or CLI changed in this task.

## Promotion

Skipped. The dispatch requested promotion on green, and the full suite was not green. The scoped implementation is committed on `duplicate-dispatch-retry-actionability` for follow-up promotion after the unrelated suite failures are resolved or explicitly waived.
