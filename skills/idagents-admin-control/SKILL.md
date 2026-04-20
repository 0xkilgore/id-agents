---
name: idagents-admin-control
description: Programmatically manage an ID Agents team from a Claude Code session. Dispatch work to agents via /remote on the manager daemon, poll replies by queryId with long-poll support, send messages to the manager's inbox, and coordinate multi-agent tasks. Use when asked to manage or dispatch work to id-agents, talk to specific agents, or act as the team manager.
---

# ID Agents Admin Control Skill

## Overview

This skill enables Claude Code to act as an **admin agent** for the ID Agents manager. It provides:

1. **Temporary listener** — Receives replies from the manager (like a regular agent)
2. **Chat with manager** — Send messages via `/talk` to the human operator's REPL
3. **Remote commands** — Execute CLI commands via `POST /remote` on the manager **daemon** (`:4100`)

## Architecture

```
Claude Code (Admin)                  Manager Daemon (:4100)       Interactive REPL (:4000, optional)
      │                                      │                            │
      │  1. POST /remote ───────────────────▶│                            │
      │     {command:"/ask ecs ..."}          │                            │
      │◀──── 202 {ok,result:{queryId}} ──────│                            │
      │                                      │                            │
      │  2. GET /query/:id?wait=30 ─────────▶│                            │
      │◀──── 200 {status:delivered,result} ──│                            │
      │                                      │                            │
      │  3. POST /talk (optional, human) ────┼───────────────────────────▶│
      │◀──── POST /news (human reply) ───────┼────────────────────────────│
```

**One dispatch surface.** As of 2026-04-20, `/remote` lives on the manager daemon only (`:4100`). The interactive REPL on `:4000` is for human operators — it does not expose `/remote`. Dispatches from scripts or Claude Code sessions always hit `:4100`.

## Restarting the manager

If `curl http://127.0.0.1:4100/agents` refuses the connection, the manager daemon is down. Known cause: occasional self-kill during `/agent rebuild` (port-kill logic catches the manager's own PID).

```bash
# Force-kill any stale CLI / daemon processes first
ps -ef | grep -E "interactive-agent|start-agent-manager" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
# Start daemon standalone (no CLI required for dispatch/polling)
cd /Users/nxt3d/projects/id2/id-agents && nohup node dist/start-agent-manager.js > /tmp/id-agents-daemon.log 2>&1 &
```

The standalone daemon reads the same SQLite state, rehydrates the team, and does not need the interactive CLI. Verify:

```bash
until curl -sS --max-time 2 http://127.0.0.1:4100/agents >/dev/null 2>&1; do sleep 2; done; echo "UP"
curl -sS http://127.0.0.1:4100/agents | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['agents']),'agents')"
```

The full launcher (`npm run id-agents`) starts both the daemon and the interactive REPL — use it when a human is going to type at the prompt. For scripted or Claude-session work you only need the daemon.

## Ports

| Port | What lives there | Use for |
|------|------------------|---------|
| `4000` | Interactive CLI REPL (only runs when `npm run id-agents` is active) | **Human operator only.** `/talk` to chat with the person running the REPL. No `/remote` surface — returns 404. |
| `4100` | Manager daemon (always running) | **Dispatch and polling.** `POST /remote`, `GET /query/:id` (supports `?wait=<sec>` long-poll), `GET /agents`, `POST /talk-to`, public-team admin. |

### IPv6 vs IPv4 gotcha (macOS especially)

On macOS, `localhost` frequently resolves to `::1` (IPv6) first. Our servers bind to `0.0.0.0` / `127.0.0.1` (IPv4), so a `curl localhost:4100` can **silently hit a different process** if some other dev tool (Vite, Next.js, etc.) happens to be listening on `[::1]:4100` in IPv6. Symptom: the JSON you get back has nothing to do with id-agents.

Always use `127.0.0.1` (not `localhost`) in every curl example, or pass `-4` to force IPv4. The snippets below follow this rule.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MANAGER_URL` | `http://127.0.0.1:4100` | Manager daemon base URL. All dispatch (`/remote`) and polling (`/query/:id`) go here. |
| `ID_TEAM` | *(unset)* | Optional team header (`X-Id-Team`) for daemon requests. Default team is used if unset. |
| `ADMIN_LISTENER_PORT` | `4050` | Local listener port when using the reply-listener scripts. |

## Usage

### Start Admin Session

```bash
node skills/idagents-admin-control/admin-session.js
```

Or use individual scripts:

### 1. Start Listener

```bash
node skills/idagents-admin-control/start-listener.js [port]
# Default port: 4050
```

### 2. Talk to the Human Manager (REPL operator)

`/talk` is only meaningful when a human is running the REPL on `:4000`. It posts a message into their inbox and returns when they reply (via the listener you started above).

```bash
./skills/idagents-admin-control/talk-to-manager.sh "What agents are running?" http://127.0.0.1:4050
```

### 3. Execute Remote Command

```bash
./skills/idagents-admin-control/remote-command.sh "/agents"
./skills/idagents-admin-control/remote-command.sh "/deploy idchain"
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
| `/hey <agent> <msg>` | Alias for `/ask` |
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
| `/public list` | List registered public-agents |
| `/public add <domain> [--ssh-target=...] [--internal-port=N]` | Register a public-agent |
| `/public remove <name\|domain>` | Deregister a public-agent |
| `/help` | Show help |

## Public-Team Admin (direct daemon endpoints)

`/remote` is the primary dispatch surface, but public-team registration can also be driven through dedicated daemon endpoints when you want to skip command-string parsing.

**Onchain registration (ID Chain + ERC-8004) is a separate skill.** Once a public-agent is registered with the manager here, invoke the `register-public-agents` skill to assign its xid.eth name and mint the ERC-8004 record whose `agentURI` advertises the MCP endpoint. That skill covers Base mainnet only and deliberately does NOT apply to local agents (use `/register <agent>` instead).

All public-team requests require two headers:

```
X-Id-Team: public
X-Id-Admin: 1
```

Same authorization rules as `/remote`: **ask before acting** on any write (register/delete).

### Helper scripts

```bash
./skills/idagents-admin-control/public-list.sh
./skills/idagents-admin-control/public-add.sh <name> <domain> [ssh_target] [internal_port]
./skills/idagents-admin-control/public-remove.sh <name_or_domain>
```

### Direct endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agents` | List agents in the current team. |
| `POST` | `/agents/register` | Upsert a public-agent. Body: `{name, runtime:"public-agent-remote", customer_domain, public_endpoint_url, ssh_target?, internal_endpoint_url?}`. |
| `DELETE` | `/agents/:id` | Deregister by id (resolve name→id first via `/agents`). |

### Reserved names

Certain agent names collide with CLI commands and are rejected by the register endpoint (`{"error":"invalid_name", ...}`). Known reserved: `help`, `agents`, `status`, `team`, `deploy`, `ask`, `hey`, `delete`, `register`, `public`. If you need one of these as a logical identifier, suffix it (`help-idagents`, `status-probe`, etc).

## Polling for Agent Replies

After dispatching work via `POST /remote`, poll `GET /query/<id>?wait=<seconds>` for the reply. Long-poll (`?wait=30`) is supported and strongly preferred — the daemon holds the connection open and returns as soon as the status transitions, or at the timeout, whichever comes first.

A query moves through one of these statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Accepted, not yet picked up by the agent |
| `processing` | Agent is working on it |
| `delivered` | Agent replied — `result` contains the message |
| `failed` | Agent errored — `error` contains the message |
| `expired` | Stuck in pending/processing past the sweeper cutoff (15 min) |

Only `delivered`, `failed`, and `expired` are terminal.

### Response shape from `POST /remote`

The daemon returns:

```json
{
  "ok": true,
  "result": {
    "queryId": "query_1776400000000_ab1cd",
    "status": "pending",
    "agent": "coder-b"
  }
}
```

Extract `queryId` directly from `.result.queryId` — no regex parsing required.

### Single Agent

**Dispatch + long-poll.** One-shot, no sleep loop needed for short tasks.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
QID=$(curl -s -X POST "$MGR/remote" \
  ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask <agent> <task>"}' \
  | jq -r '.result.queryId')
echo "queryId=$QID"

# Long-poll 30s; returns immediately on terminal status.
curl -s "$MGR/query/$QID?wait=30" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"}
```

**Background long-polling loop** (for tasks that may exceed a single wait window). Run with `run_in_background: true` (Claude Code Bash tool) so the conversation continues.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
# Up to 15 min total — each call holds the socket for up to 30s.
# NB: `qstatus` not `status` — zsh makes `$status` read-only (mirrors $?).
for i in $(seq 1 30); do
  body=$(curl -s "$MGR/query/$QID?wait=30" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"})
  qstatus=$(echo "$body" | jq -r '.status // empty')
  case "$qstatus" in
    delivered)
      echo "$body" | jq -r '.result.message // .result'
      break ;;
    failed|expired)
      echo "TERMINAL=$qstatus"
      echo "$body" | jq -r '.error // .'
      break ;;
  esac
done
```

### Multiple Agents (threshold-based)

**Dispatch.** Fan out and collect queryIds.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
declare -A QIDS
for agent in agent-a agent-b agent-c; do
  qid=$(curl -s -X POST "$MGR/remote" \
    ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} <task>\"}" \
    | jq -r '.result.queryId')
  QIDS[$agent]=$qid
done
```

**Poll with long-poll + threshold.** Wait for 2 of 3 before returning.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
for i in $(seq 1 30); do
  done_count=0
  results=""
  for agent in "${!QIDS[@]}"; do
    body=$(curl -s "$MGR/query/${QIDS[$agent]}?wait=30" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"})
    qstatus=$(echo "$body" | jq -r '.status // empty')
    if [ "$qstatus" = "delivered" ] || [ "$qstatus" = "failed" ] || [ "$qstatus" = "expired" ]; then
      done_count=$((done_count+1))
      msg=$(echo "$body" | jq -r '(.result.message // .error // "")' | head -c 200 | tr '\n' ' ')
      results="${results}${agent} [${qstatus}]: ${msg}\n"
    fi
  done
  [ "$done_count" -ge 2 ] && { echo -e "$results"; break; }
done
```

**Tips:** Use the returned queryId — do not scrape the news feed for replies. Use a threshold rather than waiting for every agent. If an agent is stuck, the sweeper will flip its query to `expired` after 15 minutes.

### Anti-patterns

**Do not POST to `:4000/remote`.** That endpoint no longer exists (removed 2026-04-20). Requests return 404. Use `:4100/remote`.

**Do not combine dispatch and poll into one synchronous foreground block.** It blocks the conversation until the agent replies or the loop times out, makes a tool-rejection ambiguous, and hides the queryId behind a wall of "no reply yet" lines. Dispatch in the foreground, poll in the background.

**Do not poll the news feed to find replies.** `/news` is the agent's inbox stream; reply discovery belongs to `GET /query/<id>`. The news feed does not give you a clear "not yet" vs "expired" vs "failed" distinction.

## Best Practices

1. **Always ask before acting** — Use `/talk` to get approval from the human before destructive commands
2. **Keep sessions short** — Start listener, do work, stop listener
3. **Prefer long-poll** — `?wait=30` beats a 10s sleep loop for latency and load
4. **Check results** — Verify command execution succeeded

## Important Notes

- The listener is only needed when you expect the human to reply via `/talk` → `/news`.
- Dispatch + poll work without the interactive REPL running at all. The daemon on `:4100` is sufficient.
- Unlike persistent agents, the listener stops when the Claude Code session ends.
