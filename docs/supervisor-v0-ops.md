# Supervisor v0 — Watch-and-Alert (Operator Note)

## What it is

A manager-side observation loop that monitors dispatches, agents, and news feeds
for reliability failures. It emits structured alerts to a JSONL file and manager
console logs. **v0 is read-only** — it does not dispatch work, restart agents,
send messages, or mutate any manager state.

## Enablement

Disabled by default. To enable:

```bash
export SUPERVISOR_WATCH_ENABLED=true
```

With the flag unset or set to anything other than `true`, the supervisor does not
start and the manager behaves identically to before this change.

## Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `SUPERVISOR_WATCH_ENABLED` | `false` | Master enable flag |
| `SUPERVISOR_POLL_INTERVAL_SECONDS` | `30` | Seconds between poll ticks |
| `SUPERVISOR_WATCHED_AGENTS` | `all` | Comma-separated agent list, or `all` |
| `SUPERVISOR_STUCK_QUERY_SECONDS` | `1800` | Seconds before a dispatch is "stuck" |
| `SUPERVISOR_NO_PROGRESS_SECONDS` | `600` | Seconds without news before "no progress" |
| `SUPERVISOR_AGENT_DOWN_SECONDS` | `300` | Seconds without heartbeat before "down" |
| `SUPERVISOR_NEWS_ERROR_WINDOW_SECONDS` | `900` | Window for repeated error detection |
| `SUPERVISOR_NEWS_ERROR_REPEAT_COUNT` | `3` | Error count threshold within window |
| `SUPERVISOR_ALERT_FILE_PATH` | `./var/supervisor-alerts.jsonl` | JSONL alert file path |
| `SUPERVISOR_LOCAL_NOTIFICATIONS` | `false` | macOS notification for critical alerts |

## Alert file

Alerts are appended as JSON lines to `SUPERVISOR_ALERT_FILE_PATH`. Each line is
a `SupervisorAlertRecord` with `alert_id`, `dedupe_key`, `status` (open/updated/resolved),
`kind`, `severity`, `confidence`, timestamps, evidence, and a config snapshot.

Tail the file for live monitoring:

```bash
tail -f var/supervisor-alerts.jsonl | jq .
```

## What it watches

1. **Stuck queries** — in-flight dispatches exceeding the stuck threshold
2. **Agent down** — watched agents with no recent activity
3. **Build failures** — terminal dispatches that failed (build-like subjects)
4. **Promotion failures** — build dispatches missing Spec 054 v2 promotion metadata
5. **Repeated news errors** — same error pattern appearing N+ times in a window

## v0 non-authority boundary

The supervisor **must not** and **does not**:

- Create, claim, cancel, or retry tasks/dispatches
- Send `/talk`, `/news-to`, or direct messages
- Restart agents or processes
- Run tests, builds, or promotions
- Mutate dispatch graphs, scheduler queues, or agent state
- Use an LLM for any decision

These capabilities are deferred to Phase 1+ after the alert stream proves accurate.

## Alert state on restart

On startup with an existing JSONL file, the supervisor replays records to
reconstruct open alert state. Without replay, alerts may re-open with the same
`dedupe_key` after restart (documented behavior for v0).
