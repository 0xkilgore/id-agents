# Interactive Agent (Your Human-in-the-Loop Node)

The interactive CLI (`npm run id-agents`) also runs a local REST‑AP server so **you** can participate as an agent (type: `interactive`) in the same network as the spawned local agents.

## Quick start

### 1) Configure + run the interactive CLI

```bash
npm install
cp env.example .env
# edit .env: set DATABASE_URL (required for PostgreSQL)
# For Claude runtimes: set `ANTHROPIC_API_KEY` or run `claude login`
# For Codex runtimes: run `codex login` or set `OPENAI_API_KEY`

npm run id-agents
```

By default, this starts your interactive agent with:
- **Interactive CLI server**: `4000`
- **Manager port**: `4100`
- **Agent ports**: `4101+` (dynamically assigned)

You can override the manager port:

```bash
npm run id-agents -- --port 5000
MANAGER_PORT=5000 npm run id-agents
```

### 2) Deploy agents

Inside the CLI:
- `/deploy <config>` — Deploy agents from a YAML config
- `/deploy local-agent <name>` — Deploy a single local agent

### 3) Verify agents are running

Inside the CLI:
- `/agents` — List all agents with status and ports
- `/status` — Check agent health

You should see your `interactive` agent listed alongside any deployed local agents.

## CLI Commands

| Command | Description |
|---------|-------------|
| `/agent <name> rebuild` | Rebuild a single agent |
| `/agents` | List all agents |
| `/agents rebuild` | Rebuild all agents |
| `/ask <agent> <msg>` | Talk to agent (continues session) |
| `/hey <agent> <msg>` | Alias for /ask |
| `/ask * <msg>` | Broadcast to all agents |
| `/clear [agent]` | Clear session (start fresh) |
| `/delete <agent>` | Delete agent |
| `/deploy <config>` | Deploy agents from config |
| `/help` | Show help |
| `/news [-l] <agent>` | Check recent messages (-l for full content) |
| `/register <agent>` | Register agent onchain |
| `/status` | Check agent status |
| `/team` | Show current team |
| `/teams` | List all teams |
| `/team <name>` | Switch to or create team |
| `/team delete <name>` | Delete a team |
| `/quit` | Exit |

## Responding to other agents

When another agent asks you something, you'll see it as a pending query in the CLI. Respond directly in the terminal when prompted.

## How it works (high-level)

- The CLI runs a local REST‑AP server (your agent) and registers it with the manager (`POST /agents/register`).
- Spawned local agents can then talk to you by hitting your `/talk` endpoint, and read your replies via `/news`.

## Multi-team support

Switch between teams to manage different groups of agents:

```
/team my-project    # Switch to (or create) a team
/teams              # List all teams
/team delete old    # Delete a team
```

Each team gets its own set of agents, port allocations, and workspace directory.

## Troubleshooting

- **Agents can't reach you**: agents run as local processes and communicate via `localhost`.
- **Wrong port**: restart with `npm run id-agents -- --port <port>`.
