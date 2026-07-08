# KG-04 KG-07 Task Comment Routing And Created At Closeout

Task: `kg04-task-comment-routing-created-at`
Dispatch: `phid:disp-4c157f92e20ef763`
Branch: `kg04-task-comment-routing-created-at`

## Summary

- Task comment routing now resolves `project:<slug>` owners to logical agent ids before scheduler enqueue.
- Routing receipts now preserve `target_agent_raw`, resolved `target_agent`, and `retryable` metadata for visible routed, pending, and failed states.
- Unresolvable project-labeled owners produce terminal visible failures (`retryable: false`) instead of enqueueing literal project labels.
- Task detail responses now expose explicit frontend-consumable link fields: `openTarget`, `links`, and `linkFields`, plus snake_case timestamp aliases.
- Task doc-model/local-search projections now preserve task `created_at`/`createdAt` alongside `updated_at`/`updatedAt`.

## Verification

- `npm test -- tests/integration/tasks-list-read-after-write.test.ts`
- `npm test -- tests/unit/doc-model-search.test.ts tests/unit/local-search-contract.test.ts tests/unit/tasks-readmodel.test.ts`
- `npm run build`

All commands passed.
