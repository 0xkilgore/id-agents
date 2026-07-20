# Dispatch shadow outbox

`DISPATCH_OUTBOX_SHADOW_ENABLED=1` enables transactional capture of accepted
scheduler lifecycle transitions. Legacy `dispatch_scheduler_queue` remains the
only authority. Each immutable `dispatch.operation.v1` envelope has a stable
idempotency key and is written by a SQLite trigger in the scheduler mutation's
transaction.

`DispatchOperationOutboxWorker` is the replay boundary. A sink must deduplicate
on `idempotency_key`. Rows are leased for five minutes, retried with bounded
exponential backoff, and dead-lettered after ten attempts; sink failure never
changes scheduler state.

Rollback is immediate: unset the environment flag and restart the manager (or
set `dispatch_operation_outbox_control.shadow_enabled` to `0`). Pending rows
are retained for diagnosis/replay. No schema rollback or legacy-row rewrite is
required. Re-enabling resumes capture and replay; this initial slice does not
grant the shadow journal command authority.
