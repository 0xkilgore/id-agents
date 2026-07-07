# Task Triage Loop

The task triage loop runs against the manager route:

```bash
node scripts/run-task-triage-loop.mjs --manager http://127.0.0.1:4100 --team default --on-demand
```

Daily scheduled execution can call the same script:

```bash
node scripts/run-task-triage-loop.mjs --manager http://127.0.0.1:4100 --team default --daily
```

The script posts to `POST /tasks/triage/run` with `apply_safe_actions=true`. The manager writes `output/YYYY-MM-DD-task-triage-review.md`, overwriting the same date file on rerun. Deterministic routes use stable dispatch dedup keys (`task-triage:<item_id>:<agent>`), so repeated daily or on-demand runs do not create duplicate dispatches.

Report sections:

- `Safe-action audit`: every deterministic safe action candidate and its route/skip status.
- `Deterministic routed task-note actions`: high-confidence agent routes.
- `Approval / review`: ambiguous notes left visible for operator review.
- `Stale unresolved rows`: deferred/stale rows with status and next action.
- `Idempotency / dedup`: artifact overwrite policy plus dispatch dedup keys.
