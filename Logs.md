# Logs

Where to look when something goes wrong, or when you want to confirm what just happened.

## Filesystem logs

| Path | What's in it |
|---|---|
| `/tmp/id-agents-manager.log` | Manager daemon stdout and stderr. Spawn events, sync results, scheduler ticks, heartbeat probes, REST errors, port-bind issues. About 16 MB after a full active day. Not rotated. |
| `/tmp/<agent>.log` | Per-agent process stdout. Each agent writes to a file named after the agent (for example `/tmp/jrdev.log`, `/tmp/cto.log`). Includes the harness banner, query queue events, and tool-call traces. The `cursor-cli` harness produces coarse output (lots of `Unknown event type: tool_call` lines), `claude-code-cli` is richer, `codex` falls in between. |
| `/tmp/id-agents-app.log` | Partial TUI bootstrap output. Small and mostly diagnostic. |

To follow the manager live: `tail -F /tmp/id-agents-manager.log`.

To follow a single agent: `tail -F /tmp/<agent>.log`.

## Database (authoritative state)

The SQLite database at `/Users/nxt3d/.id-agents/id-agents.db` is the source of truth. Filesystem logs are the running narrative, the database is the structured record.

| Table | What it tells you |
|---|---|
| `event_log` | Append-only event stream. Topics include `task:claimed`, `task:completed`, `query:delivered`, `query:expired`, `checkin:created`, `checkin:closed`. Best place to see "what happened" with timestamps and actor agent IDs. |
| `tasks` | Task lifecycle records. Columns: `name`, `status`, `created_by`, `owner`, `created_at`, `completed_at`. Useful for verifying that an agent actually owns a task it claims to have completed. |
| `queries` | Every `/remote` dispatch. Columns: `query_id`, `status`, `agent_id`, `result`, `error`. Read this when an agent reply seems wrong or missing. |
| `checkins` | Check-in records produced by the inter-agent check-in system. |
| `news_items` | Agent inbox messages, the substrate behind `/news`. |
| `schedule_definitions`, `schedule_runs`, `schedule_targets` | Scheduler state and run history. |
| `webhook_delivery_attempts` | Outgoing webhook history with success and failure status. |
| `subscriptions` | Active event subscriptions. |
| `agents` | Registered agents. The id-to-name mapping you need to decode `event_log.actor_agent_id`. |
| `teams` | Team registry. Use to translate `team_id` foreign keys. |

## Useful one-liners

Decode the most recent events with human-readable timestamps and actor names:

```bash
sqlite3 ~/.id-agents/id-agents.db "
  SELECT datetime(e.occurred_at,'unixepoch','localtime') AS t,
         e.topic,
         a.name AS actor
  FROM event_log e
  LEFT JOIN agents a ON a.id = e.actor_agent_id
  ORDER BY e.seq DESC
  LIMIT 20;
"
```

Show the last 10 tasks with their creators and owners:

```bash
sqlite3 ~/.id-agents/id-agents.db "
  SELECT t.name,
         t.status,
         ca.name AS created_by,
         oa.name AS owner,
         datetime(t.created_at,'unixepoch','localtime') AS created
  FROM tasks t
  LEFT JOIN agents ca ON ca.id = t.created_by
  LEFT JOIN agents oa ON oa.id = t.owner
  ORDER BY t.created_at DESC
  LIMIT 10;
"
```

Find the recent expired queries (agents that did not respond within the sweeper window):

```bash
sqlite3 ~/.id-agents/id-agents.db "
  SELECT datetime(created_at,'unixepoch','localtime') AS t,
         query_id,
         agent_id,
         status
  FROM queries
  WHERE status = 'expired'
  ORDER BY created_at DESC
  LIMIT 10;
"
```

Follow the manager log and event stream side by side:

```bash
tail -F /tmp/id-agents-manager.log &
watch -n 5 "sqlite3 ~/.id-agents/id-agents.db \"
  SELECT datetime(occurred_at,'unixepoch','localtime') t, topic, actor_agent_id
  FROM event_log ORDER BY seq DESC LIMIT 10;
\""
```

## Stale and removed paths

`/Users/nxt3d/projects/id2/id-agents/workspace/logs/` was the per-agent log location used by an older CLI version. New logs go to `/tmp/<agent>.log` instead. The old directory was cleaned up on 2026-04-27. If you see references to `local-<agent>-<timestamp>.log` paths in older docs, that is the same thing.
