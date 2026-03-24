# Admin Control Skill

## Overview

This skill enables Claude Code to act as an **admin agent** for the ID Agents manager. It provides:

1. **Temporary listener** - Receives replies from the manager (like a regular agent)
2. **Chat with manager** - Send messages via `/talk` and receive responses
3. **Remote commands** - Execute CLI commands via `/remote` with API key

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
      │  4. Execute /remote (with API key)  │
      │     if approved                     │
```

## Setup

1. Get the admin API key:
   ```bash
   cat ~/.id-agents/admin.key
   ```

2. Know the manager endpoint (default: `http://localhost:4000`)

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

Execute a CLI command with the API key:

```bash
./skills/admin-control/remote-command.sh "/agents"
./skills/admin-control/remote-command.sh "/spawn new-agent"
./skills/admin-control/remote-command.sh "/ask coder-b Build a REST API"
```

## Available Remote Commands

| Command | Description |
|---------|-------------|
| `/agents` | List all agents |
| `/status` | Show cluster health |
| `/deploy <config> [params]` | Deploy agent using config |
| `/delete <name>` | Delete agent |
| `/ask <agent> <msg>` | Send message to agent |
| `/hey <agent> <msg>` | Continue session with agent |
| `/cancel <agent>` | Cancel running query |
| `/clear <agent>` | Clear agent session |
| `/list` | Show pending queries |
| `/agent <name> start\|stop\|rebuild` | Agent lifecycle |
| `/model <agent> <model>` | Change agent's model |
| `/news <agent>` | Get agent's news feed |
| `/team` | Show current team |
| `/teams` | List all teams |
| `/tasks` | List tasks |
| `/task add <title> [--phase X]` | Create task |
| `/task <id> assign\|start\|complete` | Update task |
| `/keys` | List API keys |
| `/keys issue <name>` | Issue new API key |
| `/registry` | Show registry info |
| `/heartbeat <agent> enable\|disable` | Control heartbeats |

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
| `ADMIN_API_KEY` | from `~/.id-agents/admin.key` | API key for /remote |
| `ADMIN_LISTENER_PORT` | `4100` | Port for temp listener |

## Persistent State (Memory Skill)

For persistent state management across sessions, use the **memory skill**:

```
skills/memory/SKILL.md   # Documentation
skills/memory/MEMORY.md  # State file (TODOs, history)
skills/memory/loop.sh    # Continuous operation loop
```

See `skills/memory/SKILL.md` for details on managing TODO lists and session state.

## Best Practices

1. **Always ask before acting** - Use `/talk` to get approval before executing commands
2. **Keep sessions short** - Start listener, do work, stop listener
3. **Handle timeouts** - Replies may take time if user is away
4. **Check results** - Verify command execution succeeded

## Security

- The API key is stored in `~/.id-agents/admin.key` with mode 0600
- `/remote` endpoint requires the API key
- Admin agent is hidden from regular `/agents` listing
- Only the manager CLI can see admin agents

## Important Notes

- The listener must be running to receive replies
- This is designed for Claude Code terminal sessions
- Unlike persistent agents, the listener stops when the session ends
- The manager (user) must be running the CLI to respond
