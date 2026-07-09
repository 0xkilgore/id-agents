# KG-07 Comment Routing Reactor Observability

## Summary

Added a read-only route-attempt projection at `GET /comment-routing/attempts`.

The projection normalizes durable route state from:

- artifact comment/reaction route metadata stored on `artifact_operations`
- task comment routing rows stored in `task_comment_events`

Each row includes source type, artifact/task/comment ids where applicable, target agent, dispatch/query ids, error, projected status, source ref, and retry affordance metadata.

## Statuses

- `routed`: route produced a dispatch receipt
- `failed`: route reached a non-pending failure state
- `pending`: route is retryable and still within the timeout window
- `timeout`: route is still pending/retryable but older than the configured timeout window

`timeout` is projected at read time only; the endpoint does not mutate durable route rows.

## Verification

- `npm run build:core`
- `npx vitest run tests/unit/comment-routing-attempts-projection.test.ts`

`npm test -- tests/unit/comment-routing-attempts-projection.test.ts` was attempted first and failed in the existing `pretest` ABI guard because `better-sqlite3` was not loadable under `/opt/homebrew/bin/node` v23.7.0 even after the guard rebuilt dependencies. Direct Vitest passed.
