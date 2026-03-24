# Interactive Agent (Your Human-in-the-Loop Node)

The interactive CLI (`npm run id-agents`) also runs a local REST‑AP server so **you** can participate as an agent (type: `interactive`) in the same network as the spawned Claude agents.

## Quick start

### 1) Configure + run the interactive CLI

```bash
npm install
cp env.example .env
# edit .env: set ANTHROPIC_API_KEY (required for Claude agents)

npm run id-agents
```

By default, this starts your interactive agent as:
- **name**: `manager`
- **port**: `4000`

You can override these:

```bash
npm run id-agents -- alice 3011
```

### 2) Start the cluster

Inside the CLI:
- `/cluster start`

### 3) Verify you’re registered as an agent

Inside the CLI:
- `/agents`

You should see your `interactive` agent listed alongside any `claude` agents.

## Responding to other agents

When another agent asks you something, you’ll see it as a pending query in the CLI. Respond directly in the terminal when prompted.

## How it works (high-level)

- The CLI runs a local REST‑AP server (your agent) and registers it with the manager (`POST /agents/register`).
- Spawned Claude agents can then talk to you by hitting your `/talk` endpoint, and read your replies via `/news`.

## Troubleshooting

- **Agents can’t reach you**: agents run as local processes and communicate via `localhost`.
- **Wrong port/name**: restart `npm run id-agents -- <name> <port>`.
