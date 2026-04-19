---
name: idagents-admin-control
description: Programmatically manage an ID Agents team from a Claude Code session. Dispatch work to agents via /remote, poll replies by queryId, send messages to the manager's inbox, and coordinate multi-agent tasks. Use when asked to manage or dispatch work to id-agents, talk to specific agents, or act as the team manager.
---

# ID Agents Admin Control Skill

## Overview

This skill enables Claude Code to act as an **admin agent** for the ID Agents manager. It provides:

1. **Temporary listener** - Receives replies from the manager (like a regular agent)
2. **Chat with manager** - Send messages via `/talk` and receive responses
3. **Remote commands** - Execute CLI commands via `/remote`

## Architecture

```
Claude Code (Admin)                    Manager CLI
      │                                     │
      │  1. Start temp listener on port     │
      │                                     │
      │  2. POST /talk ────────────────────▶│
      │     {message, reply_endpoint}       │
      │                                     │ User sees question
      │                                     │ User replies
      │◀──────────────── POST /news ────────│
      │  3. Receive reply at temp listener  │
      │                                     │
      │  4. Execute /remote if approved     │
```

## Restarting the manager

If `curl http://127.0.0.1:4100/agents` refuses the connection, the manager daemon is down. Known cause: occasional self-kill during `/agent rebuild` (port-kill logic catches the manager's own PID).

Restart command (works headless — no interactive terminal needed):

```bash
cd /Users/nxt3d/projects/id2/id-agents && nohup bash -c 'tail -f /dev/null | npm run id-agents' > /tmp/id-agents.log 2>&1 &
```

The `tail -f /dev/null` keeps stdin open so the interactive CLI doesn't exit on EOF when detached from a terminal. State is SQLite-backed so the full team rehydrates automatically — do NOT run `npm run claude:manager` directly, it assumes a fresh init and spawns a deploy flow that can clobber your registry.

**If the combined launcher above fails** with `Manager did not start in time` in `/tmp/id-agents.log`, there's a race condition inside the CLI's child-process boot. Fall back to launching the daemon standalone:

```bash
# Force-kill any stale CLI / daemon processes first
ps -ef | grep -E "interactive-agent|start-agent-manager" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
# Start daemon alone
cd /Users/nxt3d/projects/id2/id-agents && nohup node dist/start-agent-manager.js > /tmp/id-agents-daemon.log 2>&1 &
```

The standalone daemon reads the same SQLite state, rehydrates the team, and does not need the interactive CLI to be present. The CLI on :4000 isn't required for dispatch/polling when you're calling REST endpoints directly from a Claude Code session.

Verify the daemon is up and the team is back:

```bash
until curl -sS --max-time 2 http://127.0.0.1:4100/agents >/dev/null 2>&1; do sleep 2; done; echo "UP"
curl -sS http://127.0.0.1:4100/agents | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['agents']),'agents')"
```

Agents listen on their own ports and survive manager crashes, so replies they generate while the manager is down will be queued and delivered once it's back. In-flight dispatches that were posted directly to an agent's `/news` endpoint (not manager-proxied) are unaffected.

## Setup

Two ports, two jobs — keep them straight:

| Port | What lives there | Use for |
|------|------------------|---------|
| `4000` | Interactive CLI (only runs when `npm run id-agents` is active) | **Dispatch:** `POST /remote` with `/ask`, `/agents`, `/deploy`, etc. |
| `4100` | Manager daemon (always running) | **Polling and admin queries:** `GET /query/:id`, `GET /agents`, `POST /talk-to`. |

`GET /query/:id` **does not exist** on port 4000. Polling there returns a 404 or the wrong JSON shape. Always poll against `127.0.0.1:4100`.

### IPv6 vs IPv4 gotcha (macOS especially)

On macOS, `localhost` frequently resolves to `::1` (IPv6) first. Our servers bind to `0.0.0.0` / `127.0.0.1` (IPv4), so a `curl localhost:4000` can **silently hit a different process** if some other dev tool (Vite, Next.js, etc.) happens to be listening on `[::1]:4000` in IPv6. Symptom: the JSON you get back has nothing to do with id-agents.

Always use `127.0.0.1` (not `localhost`) in every curl example, or pass `-4` to force IPv4. The snippets below follow this rule.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MANAGER_URL` | `http://127.0.0.1:4000` | Dispatch via the interactive CLI's `/remote`. |
| `MANAGER_DAEMON_URL` | `http://127.0.0.1:4100` | Polling via the manager daemon's `/query/:id`, `/agents`, etc. |
| `ID_TEAM` | *(unset)* | Optional team header for daemon requests. Default team is used if unset. |
| `ADMIN_LISTENER_PORT` | `4050` | Local listener port when using the reply-listener scripts. |

## Usage

### Start Admin Session

Run the admin session script which starts a listener and provides an interactive interface:

```bash
node skills/idagents-admin-control/admin-session.js
```

Or use individual scripts:

### 1. Start Listener

Start a temporary HTTP server to receive replies:

```bash
node skills/idagents-admin-control/start-listener.js [port]
# Default port: 4050
# Outputs: Listening on http://127.0.0.1:4050
```

### 2. Send Message to Manager

Send a message and specify your reply endpoint:

```bash
./skills/idagents-admin-control/talk-to-manager.sh "What agents are running?" http://127.0.0.1:4050
```

### 3. Execute Remote Command

Execute a CLI command:

```bash
./skills/idagents-admin-control/remote-command.sh "/agents"
./skills/idagents-admin-control/remote-command.sh "/spawn new-agent"
./skills/idagents-admin-control/remote-command.sh "/ask coder-b Build a REST API"
```

## Available Remote Commands

| Command | Description |
|---------|-------------|
| `/agents` | List all agents |
| `/agents rebuild` | Rebuild all agents |
| `/status` | Show team health |
| `/deploy <config> [params]` | Deploy agents from config (e.g. `/deploy idchain`) |
| `/delete <name>` | Delete agent |
| `/ask <agent> <msg>` | Send message to agent (continues session) |
| `/ask * <msg>` | Broadcast to all agents |
| `/hey <agent> <msg>` | Alias for /ask |
| `/clear [agent]` | Clear agent session |
| `/agent <name> start\|stop\|rebuild` | Agent lifecycle |
| `/model <agent> <model>` | Change agent's model |
| `/news [-l] <agent>` | Get agent's news feed (-l for full content) |
| `/register <agent>` | Register agent onchain |
| `/team` | Show current team |
| `/teams` | List all teams |
| `/team <name>` | Switch to or create team |
| `/team delete <name>` | Delete a team |
| `/tasks` | List tasks |
| `/task add <title>` | Create task |
| `/task <id> assign\|start\|complete` | Update task |
| `/heartbeat <agent> enable\|disable` | Control heartbeats |
| `/help` | Show help |

## Workflow Example

```bash
# 1. Ask manager for permission
./talk-to-manager.sh "I need to spawn 3 agents for a project. Is that OK?"

# 2. Wait for user approval (arrives at listener)

# 3. If approved, execute commands
./remote-command.sh "/spawn designer"
./remote-command.sh "/spawn frontend"
./remote-command.sh "/spawn backend"

# 4. Notify manager
./talk-to-manager.sh "Done! Spawned designer, frontend, and backend agents."
```

## Polling for Agent Replies

After dispatching work to an agent via `/remote` on port 4000, poll **`GET /query/<id>` on port 4100** for the reply. The queryId comes back from the dispatch call; the query endpoint tells you the lifecycle state without any timestamp filter. Always run dispatch and poll as separate steps, and run the poll in the background.

> Different ports on purpose: dispatch goes through the interactive CLI (`4000`), polling goes through the manager daemon (`4100`). The daemon is the source of truth for query state — the CLI just forwards dispatches.

A query moves through one of these statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Accepted, not yet picked up by the agent |
| `processing` | Agent is working on it |
| `delivered` | Agent replied — `result` contains the message |
| `failed` | Agent errored — `error` contains the message |
| `expired` | Stuck in pending/processing past the sweeper cutoff (15 min) |

Only `delivered`, `failed`, and `expired` are terminal.

### Response shape from `POST /remote` with `/ask`

The interactive CLI wraps every command result as `{ success, result, timestamp }`. For `/ask`, `result` is a **human-readable string**, not a structured object:

```json
{
  "success": true,
  "result": "Message sent to coder. Query ID: query_1776400000000_ab1cd. Poll /news?query_id=query_1776400000000_ab1cd for response.",
  "timestamp": 1776400000000
}
```

There is no top-level `queryId` field. Extract it with the regex `query_[0-9a-z_]+` against `result`. The snippets below do exactly that.

### Single Agent

**Dispatch (foreground, one-shot).** Capture the queryId.

```bash
QID=$(curl -s -X POST http://127.0.0.1:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask <agent> <task>"}' \
  | python3 -c "import sys,json,re; d=json.load(sys.stdin); s=d.get('result') if isinstance(d.get('result'),str) else ''; m=re.search(r'query_[0-9a-z_]+', s or ''); print(m.group(0) if m else (d.get('query_id') or ''))")
echo "queryId=$QID"
```

**Poll (background, non-blocking).** Run with `run_in_background: true` (Claude Code Bash tool) so the conversation continues while the reply arrives. Poll the **daemon** on port 4100.

```bash
# Poll every 10s for up to 15 minutes — long tasks routinely take 5-15 min.
DAEMON="${MANAGER_DAEMON_URL:-http://127.0.0.1:4100}"
for i in $(seq 1 90); do
  body=$(curl -s "$DAEMON/query/$QID" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"})
  status=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
  case "$status" in
    delivered)
      echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result') or {}; print(r.get('message') or r)"
      break ;;
    failed|expired)
      echo "TERMINAL=$status"
      echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error') or d)"
      break ;;
  esac
  sleep 10
done
```

No `BEFORE` timestamp, no `outbound.reply` filter, no news-feed scraping. The queryId is the only state you need.

### Multiple Agents (threshold-based)

**Dispatch (foreground, one-shot).** Fan out and collect queryIds.

```bash
declare -A QIDS
for agent in agent-a agent-b agent-c; do
  qid=$(curl -s -X POST http://127.0.0.1:4000/remote \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} <task>\"}" \
    | python3 -c "import sys,json,re; d=json.load(sys.stdin); s=d.get('result') if isinstance(d.get('result'),str) else ''; m=re.search(r'query_[0-9a-z_]+', s or ''); print(m.group(0) if m else (d.get('query_id') or ''))")
  QIDS[$agent]=$qid
done
```

**Poll (background, non-blocking).** Run with `run_in_background: true`. Wait for a threshold (e.g. 2 of 3 delivered) instead of all agents.

```bash
# Wait for 2 of 3 delivered, check every 10s, max 15 minutes.
DAEMON="${MANAGER_DAEMON_URL:-http://127.0.0.1:4100}"
for i in $(seq 1 90); do
  done_count=0
  results=""
  for agent in "${!QIDS[@]}"; do
    body=$(curl -s "$DAEMON/query/${QIDS[$agent]}" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"})
    status=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
    if [ "$status" = "delivered" ] || [ "$status" = "failed" ] || [ "$status" = "expired" ]; then
      done_count=$((done_count+1))
      msg=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result') or {}; print((r.get('message') or d.get('error') or '')[:200].replace(chr(10),' '))")
      results="${results}${agent} [${status}]: ${msg}\n"
    fi
  done
  if [ "$done_count" -ge 2 ]; then echo -e "$results"; break; fi
  sleep 10
done
```

**Tips:** Use the returned queryId — do not scrape the news feed for replies. Use a threshold rather than waiting for every agent. If an agent is stuck, the sweeper will flip its query to `expired` after 15 minutes so your loop is guaranteed to terminate.

### Anti-patterns

**Do not combine dispatch and poll into one synchronous block.** It blocks the conversation until the agent replies or the loop times out, makes a tool-rejection ambiguous (nothing runs, the user has no idea what was supposed to happen), and hides the queryId behind a wall of "no reply yet" lines.

**Do not run the poll in the foreground.** Even split into two steps, a foreground poll still blocks. Use `run_in_background: true` so the caller can keep working while the reply arrives.

**Do not poll the news feed to find replies.** `/news` is for the agent's own inbox stream; reply discovery belongs to `GET /query/<id>`. The news feed does not give you a clear "not yet" vs "expired" vs "failed" distinction, and timestamp filtering is easy to get wrong across clock skew or restarts.

## Best Practices

1. **Always ask before acting** - Use `/talk` to get approval before executing commands
2. **Keep sessions short** - Start listener, do work, stop listener
3. **Handle timeouts** - Replies may take time if user is away
4. **Check results** - Verify command execution succeeded

## Important Notes

- The listener must be running to receive replies
- This is designed for Claude Code terminal sessions
- Unlike persistent agents, the listener stops when the session ends
- The manager (user) must be running the CLI to respond
