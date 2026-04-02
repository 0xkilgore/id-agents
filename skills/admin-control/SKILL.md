# Admin Control Skill

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

## Setup

Know the manager endpoint (default: `http://localhost:4000`)

## Usage

### Start Admin Session

Run the admin session script which starts a listener and provides an interactive interface:

```bash
node skills/admin-control/admin-session.js
```

Or use individual scripts:

### 1. Start Listener

Start a temporary HTTP server to receive replies:

```bash
node skills/admin-control/start-listener.js [port]
# Default port: 4100
# Outputs: Listening on http://localhost:4100
```

### 2. Send Message to Manager

Send a message and specify your reply endpoint:

```bash
./skills/admin-control/talk-to-manager.sh "What agents are running?" http://localhost:4100
```

### 3. Execute Remote Command

Execute a CLI command:

```bash
./skills/admin-control/remote-command.sh "/agents"
./skills/admin-control/remote-command.sh "/spawn new-agent"
./skills/admin-control/remote-command.sh "/ask coder-b Build a REST API"
```

## Available Remote Commands

| Command | Description |
|---------|-------------|
| `/agents` | List all agents |
| `/agents rebuild` | Rebuild all agents |
| `/status` | Show team health |
| `/deploy <config> [params]` | Deploy agents from config |
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_URL` | `http://localhost:4000` | Manager endpoint |
| `ADMIN_LISTENER_PORT` | `4100` | Port for temp listener |

## Polling for Agent Replies

After dispatching work to agents via `/remote`, poll for replies using timestamp filtering.

### Single Agent

```bash
BEFORE=$(date +%s)000

curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask <agent> <task>"}'

# Poll every 10s for up to 2 minutes
for i in $(seq 1 12); do
  reply=$(curl -s -X POST http://localhost:4000/remote \
    -H "Content-Type: application/json" \
    -d '{"command":"/news <agent>"}' | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('result',{}).get('items',[])
for item in reversed(items):
    if item.get('type')=='outbound.reply' and item.get('timestamp',0) > $BEFORE:
        print(item['data']['message'][:2000])
        break
" 2>/dev/null)
  if [ -n "$reply" ]; then echo "REPLY: $reply"; break; fi
  sleep 10
done
```

### Multiple Agents (threshold-based)

```bash
BEFORE=$(date +%s)000

for agent in agent-a agent-b agent-c; do
  curl -s -X POST http://localhost:4000/remote \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} <task>\"}"
done

# Wait for 2 of 3, check every 10s, max 3 minutes
for i in $(seq 1 18); do
  results=""
  for agent in agent-a agent-b agent-c; do
    reply=$(curl -s -X POST http://localhost:4000/remote \
      -H "Content-Type: application/json" \
      -d "{\"command\":\"/news ${agent}\"}" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('result',{}).get('items',[])
    for item in reversed(items):
        if item.get('type')=='outbound.reply' and item.get('timestamp',0) > $BEFORE:
            print(item['data']['message'][:200].replace(chr(10), ' '))
            break
except: pass
" 2>/dev/null)
    if [ -n "$reply" ]; then results="${results}${agent}: ${reply}\n"; fi
  done
  count=$(echo -e "$results" | grep -c ":" 2>/dev/null || echo 0)
  if [ "$count" -ge 2 ]; then echo -e "$results"; break; fi
  sleep 10
done
```

**Tips:** Record the timestamp BEFORE dispatching to filter stale replies. Use a threshold rather than waiting for all agents. If an agent keeps returning stale replies, use `/clear <agent>`.

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
