# Continuous Orchestration Retry Readiness Contract

`GET /orchestration/backlog` returns each item with an additive `retry_readiness`
object. Existing fields are unchanged.

Field contract:

- `schema_version`: currently `backlog.retry_readiness.v1`.
- `status`: one of `not_retry_candidate`, `retryable_failed_row`,
  `retry_cap_reached`, `non_retryable_failed_row`, `waiting_on_live_dispatch`,
  or `stale_duplicate`.
- `retryable`: `true` only when the row is `needs_review`, has a prior failed
  dispatch, the failure matches the reconciler's transient retry policy, and the
  retry cap has not been reached.
- `stale_duplicate`: `true` when the row still points at prior work that is
  terminal, moot, cancelled, or already promotion-satisfied. These rows are not
  retry fuel.
- `next_action`: UI hint: `retry`, `wait`, `close_or_ignore`,
  `operator_review`, or `none`.
- `prior_dispatch_phid`, `prior_dispatch_status`, `failure_kind`,
  `failure_detail`, `recovery_status`: dispatch evidence used for the decision.
- `dispatch_retry_count` and `retry_cap`: bounded retry ledger values.

Consumers should branch on `retry_readiness.status` or `retry_readiness.retryable`;
they should not infer retry safety from `readiness_state`, `last_dispatch_phid`,
or stale verifier text alone.
