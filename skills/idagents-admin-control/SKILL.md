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

## Setup

Know the manager endpoint (default: `http://localhost:4000`)

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
# Outputs: Listening on http://localhost:4050
```

### 2. Send Message to Manager

Send a message and specify your reply endpoint:

```bash
./skills/idagents-admin-control/talk-to-manager.sh "What agents are running?" http://localhost:4050
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_URL` | `http://localhost:4000` | Manager endpoint |
| `ADMIN_LISTENER_PORT` | `4050` | Port for temp listener |

## Polling for Agent Replies

After dispatching work to agents via `/remote`, poll for replies using timestamp filtering. Always run dispatch and poll as separate steps. Run the poll in the background.

### Single Agent

**Dispatch (foreground, one-shot).** Returns the queryId immediately.

```bash
BEFORE=$(date +%s)000

curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask <agent> <task>"}'
```

Capture the timestamp BEFORE dispatching so the poll can filter out stale replies.

**Poll (background, non-blocking).** Run with `run_in_background: true` (Claude Code Bash tool) so the conversation continues while the reply arrives.

```bash
# Poll every 10s for up to 10 minutes (long tasks routinely take 5-15 min)
for i in $(seq 1 60); do
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

Adjust the max wait to fit the task. Implementation work, multi-file edits, and code review routinely take 5-15 minutes, so the 2-minute defaults of older patterns will time out before the agent finishes.

### Multiple Agents (threshold-based)

**Dispatch (foreground, one-shot).** Fan out to all agents.

```bash
BEFORE=$(date +%s)000

for agent in agent-a agent-b agent-c; do
  curl -s -X POST http://localhost:4000/remote \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} <task>\"}"
done
```

**Poll (background, non-blocking).** Run with `run_in_background: true`. Wait for a threshold (e.g. 2 of 3 replies) instead of all agents.

```bash
# Wait for 2 of 3, check every 10s, max 10 minutes
for i in $(seq 1 60); do
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

**Tips:** Record the timestamp BEFORE dispatching. Use a threshold rather than waiting for all agents. If an agent keeps returning stale replies, use `/clear <agent>`.

### Anti-patterns

**Do not combine dispatch and poll into one synchronous block.** It blocks the conversation until the agent replies or the loop times out, makes a tool-rejection ambiguous (nothing runs, the user has no idea what was supposed to happen), and hides the queryId behind a wall of "no reply yet" lines.

**Do not run the poll in the foreground.** Even split into two steps, a foreground poll still blocks. Use `run_in_background: true` so the caller can keep working while the reply arrives.

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
