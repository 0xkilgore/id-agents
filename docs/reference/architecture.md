# Architecture

## Overview

ID Agents has three layers:

```
Interactive CLI → Manager → Agent Processes
```

### 1. Manager (`src/agent-manager-db.ts`)

The central process running on port 4100 (configurable via `--port` or `MANAGER_PORT`).

**Responsibilities:**
- Stores agent state in PostgreSQL
- Handles the `/remote` API for programmatic access (no auth required)
- Proxies messages between agents via `/message`
- Spawns and stops agent processes
- Manages onchain ENS registration via id-cli
- Runs health checks every 30 seconds (marks agents online/offline)
- Serves the `/agents` list with health status

**Key endpoints:**
- `GET /health` — Manager health check
- `GET /agents` — List all agents with health status
- `POST /remote` — Execute CLI commands programmatically
- `POST /message` — Agent-to-agent messaging

### 2. Agent Processes (`src/local-agent-server.ts` + `src/claude-agent-server.ts`)

Each agent runs as a separate Node.js process with its own Express server on a dynamically assigned port (4101+, sequential).

**Responsibilities:**
- Hosts REST-AP endpoints (`/talk`, `/news`, `/health`)
- When a message arrives on `/talk`, spawns an LLM session to process it
- Stores replies in an in-memory news feed (backed by PostgreSQL)
- Serves `/.well-known/restap.json` for discovery

**REST-AP endpoints per agent:**
- `POST /talk` — Send a message (triggers LLM processing)
- `GET /news` — Poll for replies (free, no LLM cost)
- `GET /health` — Agent health check
- `GET /.well-known/restap.json` — Service discovery catalog
- `PATCH /catalog` — Update agent catalog metadata
- `PATCH /identity` — Update agent's onchain identity (called by manager)

### 3. Interactive CLI (`src/interactive-agent-cli.ts`)

The user-facing terminal interface.

**Responsibilities:**
- Connects to the manager on startup (auto-starts it if not running)
- Provides commands: `/ask`, `/deploy`, `/agents`, `/status`, `/register`, etc.
- Polls agent news feeds for replies
- Manages agent lifecycle (deploy, rebuild, delete)

## Message Flow

```
User types: /ask coder hello

1. CLI resolves "coder" → finds agent on port 4101
2. CLI → POST http://localhost:4101/talk {"message": "hello"}
3. Agent queues the request and returns 202 with query_id
4. Agent spawns LLM session (Claude Agent SDK or Claude Code CLI)
5. LLM processes the message, generates a reply
6. Reply stored in agent's news feed
7. Agent auto-sends reply to the CLI's /news endpoint
8. Reply displayed to user
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `teams` | Team isolation (default: default) |
| `agents` | Agent state — name, port, status, registry (ENS domain), metadata |
| `news_items` | Async message feed per agent (with timestamps for polling) |
| `queries` | Query tracking for reply routing between agents |
| `wallets` | Deprecated — keys now stored in per-agent .env files |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/agent-manager-db.ts` | Manager — routes, DB, spawning, registration, health checks |
| `src/claude-agent-server.ts` | Agent REST-AP server (per-agent Express app) |
| `src/local-agent-server.ts` | Agent process bootstrap and CLI arg parsing |
| `src/interactive-agent-cli.ts` | User-facing CLI |
| `src/config-parser.ts` | YAML config parsing and parameter substitution |
| `src/onchain/idchain-register.ts` | ENS registration via id-cli |
| `src/core/agent-identifier.ts` | ENS name parsing and display |
| `src/db.ts` | PostgreSQL schema, migrations, connection pool |
| `src/inter-agent-skill.ts` | Inter-agent communication skill injection |
| `src/harness/claude-code-cli.ts` | Claude Code CLI harness for spawning LLM sessions |

## Onchain Identity

Each agent can register on ID Chain for a verifiable ENS name:

1. `/register <agent>` calls `id-cli register` → gets `agent-N.xid.eth`
2. Automatically creates a subname: `<alias>.agent-N.xid.eth`
3. The `tokenId` is the bytes32 namehash of the full ENS name
4. Identity persisted in YAML config (`domain`, `tokenId`, `address` fields)

## Health Monitoring

The manager pings each agent's `/health` endpoint every 30 seconds:
- **online** — agent responded within 3 seconds
- **offline** — agent did not respond
- **unknown** — not yet checked

Health status is visible in `/agents` response and `/status` CLI command.

## Per-Agent Environment

Each agent can have its own `.env.<name>.<address>` file in the repo root containing a `PRIVATE_KEY` for onchain operations. The manager loads this file when spawning the agent and merges it into the process environment.
