# Orchestration Status Fields

`GET /orchestration/status` is consumed by Kapelle `/ops` to explain why the
continuous orchestration ready queue is, or is not, dispatching work.

## Ready Admission

`counts.ready` is the raw number of backlog rows in `ready`.
`counts.admissible_now` is the number that would pass admission guardrails on a
read-only status check. The status route does not enqueue, reconcile, or mutate
tick counters.

`counts.ready_block_reasons` is a compact legacy summary for the common capacity
and lane blockers:

- `no_in_flight_slots`
- `tick_admission_cap`
- `blocked_dependency`
- `risk_requires_approval`
- `pool_capacity_full`
- `single_writer_lane_busy`
- `no_free_pool_builder`

`ready_admission.blocker_counts` is the stable, operator-facing label surface for
`/ops`. Each entry has:

- `code`: exact admission blocker code.
- `category`: operator action group.
- `count`: number of ready candidates blocked by that code.

Important labels include:

- `duplicate_dispatch_retry_required` / `retry_safety`: the row already has a
  prior dispatch and must be explicitly marked retry-safe before it fires again.
- `provider_runtime_mismatch` / `runtime_unavailable`: requested provider or
  runtime cannot land on the resolved target lane.
- `pool_capacity_full` / `capacity_gate`: the build pool has no free parallel
  capacity.
- `no_in_flight_slots` / `capacity_gate`: global in-flight capacity is
  saturated. `/ops` should wait for slots to free or close active dispatches;
  it should not add filler rows just to raise ready fuel.
- `blocked_dependency` / `lane_eligibility`: at least one declared dependency is
  known but not done.

`ready_admission.non_admitted` carries per-item details with `item_id`, `title`,
`to_agent`, `risk_class`, `action`, `code`, `reason`, and optional `metadata`.

## Queue Quality

`health.queue_quality` summarizes broader queue health:

- `raw_queued`: queued plus bounced dispatch scheduler rows.
- `actionable_ready`: ready rows that pass basic payload, risk, and dependency
  checks.
- `needs_approval`: rows waiting on review or approval gates.
- `duplicate_or_noop_backfill`: artifact acknowledgements that should not create
  new work.
- `suppressed_by_dedupe`: duplicate acknowledgement patterns suppressed by the
  read-model.
- `blocked_or_failed`: blocked backlog plus failed/cancelled/clarification
  dispatches and retryable route failures.
- `task_action_receipts`: routed, failed, needs-Chris, and consumed artifact
  comment routing receipt counts.
- `top_noise_patterns`: grouped duplicate/no-op acknowledgement patterns.
