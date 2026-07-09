# Usage Meter Truth Fix

Task: `usage-meter-truth-fix-1783634082569`
Dispatch/query: `query_1783634082569_4942e1o`
Branch: `usage-meter-truth-fix-1783634082569`

## Summary

- `/usage` keeps weighted-token burn visible but does not expose configured token policy values as budgets or percentages.
- Per-agent `/usage` windows now omit static policy denominators, so stale config entries cannot make roger/cto look over-budget under the wrong runtime/provider.
- Scheduler concurrency no longer treats `budget_state=hard_pause|soft_pause` as a reason to reduce safe concurrency.
- Continuous orchestration daily/weekly token ceiling values are reference/warning numbers only. They do not halt admission or auto-pause the daemon.
- `hard_paused` remains available for real provider-limit signals from scheduler bounces and for explicit emergency/usage gate behavior.

## Verification

```bash
node scripts/run-vitest.mjs run \
  tests/unit/usage-meter-service.test.ts \
  tests/unit/dispatch-scheduler-policy.test.ts \
  tests/unit/dispatch-scheduler-service.test.ts \
  tests/unit/continuous-orchestration-admission.test.ts \
  tests/integration/continuous-orchestration-factory.test.ts \
  tests/integration/continuous-orchestration-daemon.test.ts \
  tests/unit/orchestration-roadmap-dedup.test.ts
```

Result: 7 files passed, 161 tests passed.

```bash
npm run build:core
```

Result: passed.

Smoke covered by `tests/unit/usage-meter-service.test.ts`: an over-reference burn of 1,500 weighted tokens against a configured 1,000 daily token reference still returns `budget: null` and `percent_consumed: null`; provider and agent windows also return null denominators.
