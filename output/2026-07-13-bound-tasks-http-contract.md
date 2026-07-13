# Bound /tasks HTTP Contract Closeout

Date: 2026-07-13
Task: bound-tasks-http-contract
Branch: roger/bound-tasks-http-contract

## Summary

Implemented the P0 manager backend fix for the console-killing `/tasks` payload:

- `GET /tasks?limit=5` now reads five rows from SQL and returns five rows.
- `GET /tasks` defaults to a capped `limit=100`; route max is 500.
- `GET /tasks` returns a slim list projection by default and excludes heavy fields:
  `title_audit`, `currentness`, `linkFields`, `operationTimeline`, `commentRouting`, and `openTarget`.
- Heavy task detail remains available from `/tasks/:ref`, `/tasks/:ref/detail`, and explicitly from `/tasks?include=detail`.
- `GET /tasks/entries` now pushes `limit`/`offset` into the repository query instead of slicing after an unbounded list read.
- Task detail adjacent prefetch now uses a bounded task-list window.
- Legacy `/artifacts` agent-output aggregation now caps the agent scan and stops once the requested artifact limit is reached.

## Sibling Route Audit

- `/dispatches`: already bounded through `parseReadLimit()` and `readDispatches(... LIMIT ?)`.
- `/artifacts/entries`: already bounded through catalog `LIMIT ? OFFSET ?`.
- `/artifacts`: dispatch/query artifact sources were bounded; the legacy agent-output source is now bounded.
- `/reports`: no top-level `/reports` list route found in this checkout. The related `/loops/reports/due` route is a report-obligation projection, not the same list contract.

## Verification

Passed:

- `npm run build:core`
- `npm test -- tests/integration/tasks-list-read-after-write.test.ts`
- `npm test -- tests/integration/task-detail-adjacent-prefetch.test.ts`

Notes:

- An earlier combined integration run hit a 30s `beforeAll` manager startup timeout after the native ABI rebuild. The same suites passed when rerun individually.
- `npm ci` was required in the clean worktree before verification.
