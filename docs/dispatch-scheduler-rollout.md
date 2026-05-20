# Dispatch Scheduler — Operator Rollout Guide

This is the manager-side concurrency gateway from
`docs/superpowers/plans/2026-05-19-concurrency-scheduler.md`. It ends
the recurring Anthropic-throttle bounce class by enforcing a max-N cap
on simultaneous /talk dispatches and requeuing throttled work with
backoff.

## What ships

A new in-process scheduler runs alongside the manager (no separate
service required). The canonical store is `dispatch_scheduler_queue`
in the existing manager SQLite (`~/.id-agents/id-agents.db`).

Three gateway modes via `DISPATCH_GATEWAY_MODE`:

| Mode | Behaviour |
|---|---|
| `off` | Scheduler not used. Manager continues legacy direct-/talk fanout. |
| `shadow` (default) | Manager enqueues a Dispatch doc **and** continues to call legacy /talk. Both paths observe the same caller contract; the queue is populated for parity but does not control dispatch. |
| `enforce` | Scheduler is the sole /talk caller for default-team inter-agent messages. Manager `/message` returns `status: queued`; `/talk-to` long-polls the Dispatch doc lifecycle. |

Other env knobs (all optional):

| Var | Default | Effect |
|---|---|---|
| `DISPATCH_SCHEDULER_ENABLED` | `true` | Set `false` to disable bootstrap + ticking entirely. Rollback switch. |
| `DISPATCH_MAX_IN_FLIGHT_ANTHROPIC` | `3` | Safe cap. Manager must approve raising. |
| `DISPATCH_TICK_INTERVAL_MS` | `2000` | Drain cadence. |

## Rollout sequence

### 1. Verify the running manager exposes the new routes

After a restart, the manager publishes two new endpoints:

```bash
curl -sS http://localhost:4100/system-live/dispatch | jq
# → { ok: true, dispatch: { in_flight, queued, bounced, max_safe,
#                            available_slots, oldest_queued_age_ms,
#                            last_bounce_kind, mode, policy_version } }

curl -sS -X POST http://localhost:4100/dispatch/enqueue \
  -H 'content-type: application/json' \
  -d '{"to_agent":"coder-max","from_actor":"operator","message":"smoke ping"}'
# → { ok: true, query_id: "query_...", dispatch_phid: "phid:disp-...", status: "queued" }
```

If the snapshot route 503s with `dispatch_scheduler_not_initialised`,
the adapter is not SQLite (e.g. Postgres mode) or the bootstrap
errored — check the manager log for `[Manager] Failed to bootstrap
dispatch scheduler`.

### 2. Shadow (default — no behaviour change)

Restart the manager with the default env or
`DISPATCH_GATEWAY_MODE=shadow`. Every manager-routed `/message` or
`/talk-to` will:
- still call legacy `/talk` (caller contract unchanged)
- also `enqueueDispatch` a doc into the queue (visible in
  `/system-live/dispatch` and the `dispatch_scheduler_queue` table)

Observe parity for at least one Claude burst:

```bash
# Enqueue 8 in shadow (legacy still runs alongside)
for i in $(seq 1 8); do
  curl -sS -X POST http://localhost:4100/talk-to \
    -H 'content-type: application/json' \
    -d "{\"to\":\"coder-max\",\"message\":\"burst $i\"}" &
done
wait

# Snapshot — should show 8 docs in the scheduler regardless of legacy
curl -sS http://localhost:4100/system-live/dispatch | jq
```

In shadow the snapshot will show every dispatch the legacy path
launched, but the scheduler's `in_flight`/`queued` numbers are
advisory — legacy is still in control.

### 3. Enforce

Set `DISPATCH_GATEWAY_MODE=enforce` and restart. Manager `/message`
and `/talk-to` now route exclusively through the scheduler. With
`DISPATCH_MAX_IN_FLIGHT_ANTHROPIC=3`, a burst of 8 dispatches
launches at most 3 immediately and queues the rest:

```bash
# Live evidence (run from the manager workdir):
for i in $(seq 1 8); do
  curl -sS -X POST http://localhost:4100/dispatch/enqueue \
    -H 'content-type: application/json' \
    -d "{\"to_agent\":\"coder-max\",\"from_actor\":\"operator\",\"message\":\"burst $i\"}"
done

curl -sS http://localhost:4100/system-live/dispatch | jq
# → in_flight ≤ 3, queued = 5, available_slots = 0
```

`/talk-to` callers still see the same response shape; the body now
includes `status: "completed"` after a reply arrives or
`status: "queued"` / `status: "pending"` when the wait timer expires.

### 4. Provider throttle behaviour

When Anthropic returns `Server is temporarily limiting requests` or
HTTP 429/529, the scheduler:
1. Marks the Dispatch doc `bounced` with `last_bounce.kind = "provider_throttle"`.
2. Sets `not_before_at = now + computeBackoffMs(attempt_count)` (30s → 60s → 120s → 240s → 5m cap).
3. Frees the in-flight slot so the next eligible queued doc starts.
4. On the next tick after the backoff window, requeues and retries.
5. After `DISPATCH_MAX_ATTEMPTS=5` (default), terminal-fails with
   `failure_kind = provider_rate_limit_exhausted`.

The throttle is **never** silent. Operator can inspect:

```bash
curl -sS http://localhost:4100/system-live/dispatch | jq '.dispatch.bounced'
# → number of currently-bouncing docs
```

## Rollback

If anything looks off after enforce:

```bash
# Option A: drop back to shadow (legacy path resumes; queue keeps observing)
DISPATCH_GATEWAY_MODE=shadow ./scripts/start-id-agents-manager.sh

# Option B: full disable (no enqueue, no tick)
DISPATCH_SCHEDULER_ENABLED=false ./scripts/start-id-agents-manager.sh
```

In both cases the existing `dispatch_scheduler_queue` rows are left
intact — they are the audit trail for what was queued, started,
bounced, and completed.

## What this does NOT do

- The legacy Reactor `dispatch_summary` table on `:4250` is not yet
  populated from the scheduler. The promoted Phase A Dispatch
  read-side is independent. A future step can dual-write a summary
  row per scheduler dispatch so dashboards reading from `:4250` see
  the same activity — see "Reactor extension" in
  `output/concurrency-scheduler-finish-report.md`.
- Multi-team scheduling: this build binds one SchedulerHandle to the
  `default` team. Dispatches to other teams continue on legacy paths.
- The `inter-agent-tools` and `claude-agent-server` direct /talk
  call sites are still on legacy. They remain MUST_MIGRATE in the
  static guard test — the next coder lane picks them up after
  shadow → enforce parity proves out on the primary handleMessage
  path.

## Tests

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run tests/unit/dispatch-scheduler-*.test.ts
# → 10 files, 122 tests, all green

# Live integration burst (does NOT require a running manager):
node /tmp/scheduler-live-burst.mjs
# → 8 dispatches, cap=3, 8 transport calls total, no double-posting
```
