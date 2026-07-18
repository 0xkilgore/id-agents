Task: stale-duplicate-dispatch-supersede-reconcile

Acceptance criteria
- Failed prior-dispatch rows with deterministic supersede evidence (`reliability_classification = superseded`) are treated as stale duplicates, not retry candidates.
- The stale-ready reconciliation sweep automatically supersedes those stale duplicate backlog rows without touching live rows or broadening retry safety.
- Existing close-disposition handling for terminal or non-retryable failed duplicate rows remains intact.

Files changed
- src/continuous-orchestration/duplicate-dispatch-terminal-disposition.ts
- src/continuous-orchestration/backlog-retry-readiness.ts
- src/continuous-orchestration/duplicate-dispatch-retry-classifier.ts
- src/continuous-orchestration/duplicate-dispatch-retry-receipt.ts
- src/continuous-orchestration/storage.ts
- tests/unit/duplicate-dispatch-retry-classifier.test.ts
- tests/unit/orchestration-health-projection.test.ts
- tests/integration/continuous-orchestration-daemon.test.ts

Evidence
- `node scripts/run-vitest.mjs run tests/unit/duplicate-dispatch-retry-classifier.test.ts tests/unit/orchestration-health-projection.test.ts`
- `node scripts/run-vitest.mjs run tests/integration/continuous-orchestration-daemon.test.ts -t "closes or supersedes terminal rows, preserves retry-safe work, cites artifacts, and corrects ready counts"`

Result
- Deterministic supersede evidence now collapses stale duplicate retry blockers into stale-duplicate closeout instead of leaving them permanently idle in `duplicate_dispatch_retry_required`.
