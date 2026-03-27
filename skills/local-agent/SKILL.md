# Local Agent Skill

This skill enables you to spawn and manage Claude Code agents that run locally (outside of Docker containers), using your existing Claude Code authentication.

## Overview

Local agents are perfect when you need:
- **Authenticated access**: Use your Claude Code login instead of API keys
- **Full local filesystem access**: No container isolation
- **Development/debugging**: Easier to debug and inspect
- **Resource efficiency**: No Docker overhead

Local agents register with the team manager and participate in inter-agent communication just like containerized agents.

## Spawn a Local Agent

### Using the Deploy Command (Recommended)

From the ID Agents interactive CLI:

```
/deploy local-agent [name]
```

Examples:
```
/deploy local-agent my-assistant
/deploy local-agent my-coder opus
```

You can also create your own config with `local: true`:

```yaml
# configs/my-local-team.yaml
version: "1"
defaults:
  local: true
agents:
  - name: researcher
  - name: coder
```

Then deploy with `/deploy my-local-team`.

### Using the Shell Script

```bash
# From the skills directory
./skills/local-agent/spawn-local.sh <agent-name> [--team <team>] [--port <port>]

# Examples
./skills/local-agent/spawn-local.sh researcher
./skills/local-agent/spawn-local.sh coder --team myproject --port 24001
```

### Using the TypeScript Module Directly

```bash
npx tsx src/local-agent-server.ts <agent-name> [options]

# Options:
#   --team, -t <name>    Team name (default: ID_TEAM env or 'default')
#   --port, -p <port>    Port to listen on (auto-allocated if not specified)
#   --dir, -d <path>     Working directory (auto-created if not specified)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ID_TEAM` | Team name | `default` |
| `MANAGER_URL` | Manager URL | `http://localhost:4100` |
| `DATABASE_URL` | PostgreSQL connection (optional) | - |
| `CLAUDE_MODEL` | Default model | `claude-sonnet-4-20250514` |

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                    Your Local Machine                           │
│  ┌─────────────────────┐     ┌─────────────────────────────┐   │
│  │   Local Agent       │     │   Docker Containers         │   │
│  │   (port 24001)      │     │  ┌────────┐  ┌────────┐     │   │
│  │                     │     │  │Agent A │  │Agent B │     │   │
│  │   Uses your local   │◄───►│  │(4101) │  │(4102) │     │   │
│  │   Claude Code auth  │     │  └────────┘  └────────┘     │   │
│  │                     │     └─────────────────────────────┘   │
│  └─────────────────────┘                                       │
│           │                                                     │
│           │ Registers                                           │
│           ▼                                                     │
│  ┌─────────────────────┐                                       │
│  │   Manager (4100)   │                                       │
│  │   Coordinates all   │                                       │
│  │   agents            │                                       │
│  └─────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────┘
```

1. **Startup**: Local agent starts an Express server with REST-AP endpoints
2. **Registration**: Agent registers with the manager so other agents can discover it
3. **Communication**: Other agents talk to it via `/talk` and `/talk-to` endpoints
4. **LLM Execution**: Uses your local Claude Code session (no API key needed)
5. **Shutdown**: Agent unregisters from manager when stopped

## Interacting with Local Agents

Once spawned, local agents expose the standard REST-AP endpoints:

### Talk to the Agent

```bash
curl -X POST http://localhost:24001/talk \
  -H "Content-Type: application/json" \
  -d '{"message": "What files are in the current directory?"}'
```

### Check News/Results

```bash
curl http://localhost:24001/news?since=0
```

### From Another Agent

Other agents in the same team can use `/talk-to`:

```bash
curl -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "my-local-agent", "message": "Help me with this task"}'
```

## When to Use Local Agents

| Use Case | Local Agent | Containerized Agent |
|----------|-------------|---------------------|
| Development/testing | ✅ Easier debugging | Isolated environment |
| Authenticated access | ✅ Uses your login | Requires API key |
| Full disk access | ✅ No restrictions | Sandboxed |
| Production isolation | Limited | ✅ Recommended |
| Multiple instances | Manual port management | ✅ Auto-scaled |
| Resource control | Host resources | ✅ Container limits |

## Best Practices

1. **Use descriptive names**: Other agents discover by name, so be clear
2. **Set appropriate team**: Ensures agent joins the right group
3. **Monitor the terminal**: Local agents log to stdout for easy debugging
4. **Graceful shutdown**: Use Ctrl+C to unregister properly
5. **Port conflicts**: Let the system auto-allocate ports unless you have a reason

## Important Notes

- Local agents share your filesystem - they can read/write anywhere you can
- Only one local agent can bind to a specific port at a time
- Local agents use your Claude Code session, so API usage counts toward your account
- The agent continues running until you stop it (Ctrl+C or kill the process)
- If the manager is not running, the agent still works but won't be discoverable

## Troubleshooting

### Agent not discoverable by other agents

Make sure:
1. The manager is running (`/cluster start`)
2. The agent successfully registered (check startup logs)
3. Both agents are in the same team

### Port already in use

Either:
- Let the system auto-allocate: `./spawn-local.sh my-agent`
- Choose a different port: `./spawn-local.sh my-agent --port 24005`

### Database connection failed

This is usually fine - the agent will run in memory-only mode. For persistence:
- Set `DATABASE_URL` environment variable
- Ensure PostgreSQL is running
