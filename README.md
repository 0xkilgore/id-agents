```
  ██╗██████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗
  ██║██╔══██╗     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝
  ██║██║  ██║     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████╗
  ██║██║  ██║     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║
  ██║██████╔╝     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████║
  ╚═╝╚═════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝
```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Version 0.1.10-beta**

A multi-agent orchestration platform built on the Claude Agent SDK.

ID Agents enables autonomous AI agents to run as local processes, communicate via the REST-AP protocol, and optionally register onchain for verifiable identity.

## Key Features

- **Local agent processes** - Each agent runs as a local Node.js process managed by the manager
- **REST-AP protocol** - Standard protocol for agent discovery and communication
- **Multi-tenant teams** - Isolated teams with separate port ranges and workspaces
- **Multiple runtimes** - Support for Claude Agent SDK and Claude Code CLI harnesses
- **Onchain identity** - ENS-based agent identity via ID Chain (agents get names like `x.agent-15.sep.xid.eth`)
- **Remote API** - Programmatic management via `/remote` endpoint
- **Skills system** - Extensible capabilities (inter-agent communication, admin control, memory)

## Architecture

```
┌─────────────────────────────┐       ┌─────────────────────────────┐
│                             │       │                             │
│      Interactive CLI        │       │    Remote API (/remote)     │
│ (src/interactive-agent-cli) │       │   External tools, scripts,  │
│                             │       │   other Claude Code agents  │
└──────────────┬──────────────┘       └──────────────┬──────────────┘
               │                                     │
               └──────────────┬──────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │                   │
                    │      Manager      │
                    │       :4100       │
                    │  agent-manager-db │
                    │                   │
                    └─────────┬─────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│               │   │               │   │               │
│   Agent A     │   │   Agent B     │   │   Agent C     │
│    :4101      │   │    :4102      │   │    :4103      │
│ (local proc)  │   │ (local proc)  │   │ (local proc)  │
│               │   │               │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
             ┌────────────┐     ┌────────────┐
             │            │     │            │
             │ PostgreSQL │     │ Workspace  │
             │   :5432    │     │   Files    │
             │            │     │            │
             └────────────┘     └────────────┘
```

**Components:**
- **Manager** (`src/agent-manager-db.ts`) - DB-backed API, agent registry, orchestration logic, `/remote` endpoint for programmatic access
- **Worker** (`src/claude-agent-server.ts`) - REST-AP server running Claude in each local agent process
- **Local Agent Server** (`src/local-agent-server.ts`) - Spawns and manages local agent processes

## Quick Start

### Prerequisites

- **Node.js** 20+
- **PostgreSQL** (for agent state persistence)
- **Claude Code** or Anthropic API key
- **[id-cli](https://github.com/idchain-world/id-cli)** (optional, for onchain agent registration via `/register`)

### 1) Setup

```bash
git clone https://github.com/idchain-world/id-agents.git
cd id-agents
npm install
cp env.example .env
# edit .env: set DATABASE_URL
# For Claude Max plan: run `claude login` first (no API key needed)
```

### 2) Run the interactive CLI

```bash
npm run id-agents
```

Custom port (default: 4100):

```bash
npm run id-agents -- --port 5000   # Manager on 5000, agents on 5001+
MANAGER_PORT=5000 npm run id-agents  # Same, via env var
```

### 3) Deploy and talk to agents

```
/deploy <config>
/ask coder1 Write a hello world function
```

## REST-AP Protocol

[REST-AP (REST Agent Protocol)](https://github.com/nxt3d/rest-ap) defines how agents communicate ([local docs](./docs/protocol/rest-ap.md)):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/restap.json` | GET | Discovery catalog |
| `/talk` | POST | Send message (triggers LLM processing, async) |
| `/news` | GET | Poll for updates (free, no LLM cost) |
| `/news` | POST | Receive replies without processing |

**Manager-specific endpoints:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agents` | GET | List all agents |
| `/message` | POST | Agent-to-agent messaging (fire-and-forget or wait) |
| `/remote` | POST | Execute CLI commands programmatically |

## CLI Commands

```
/agent <name> rebuild       # Rebuild a single agent
/agents                     # List all agents
/agents rebuild             # Rebuild all agents
/ask <agent> <message>      # Talk to agent (continues session)
/hey <agent> <message>      # Alias for /ask
/ask * <message>            # Broadcast to all agents
/clear [agent]              # Clear session (start fresh)
/delete <agent>             # Delete agent
/deploy <config>            # Deploy agents from config
/help                       # Show help
/news [-l] <agent>          # Check recent messages (-l for full content)
/register <agent>           # Register agent onchain
/status                     # Check agent status
/quit                       # Exit
```

## Remote API

The Manager exposes a `/remote` endpoint for programmatic CLI-like access:

```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/agents"}'
```

**Available Commands:**
- `/agent <name> rebuild` - Rebuild a single agent
- `/agents` - List all agents
- `/agents rebuild` - Rebuild all agents
- `/ask <name> <message>` - Send message to agent
- `/clear [agent]` - Clear session
- `/delete <name>` - Delete agent
- `/deploy <config>` - Deploy agents from YAML config
- `/news [-l] <name>` - Check recent messages
- `/register <name>` - Register agent onchain
- `/status` - Show status

## Skills

Skills extend agent capabilities:

| Skill | Description |
|-------|-------------|
| [inter-agent-communication](./skills/inter-agent-communication/) | `/talk-to` for agent-to-agent messaging |
| [admin-control](./skills/admin-control/) | Remote management of manager CLI |

See [Skills README](./skills/README.md) for details.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (not needed with Claude Max plan — run `claude login` instead) |
| `CLAUDE_MODEL` | No | Default model (e.g., `claude-opus-4-6`) |
| `ID_REGISTRAR_PRIVATE_KEY` | No | Wallet private key for onchain agent registration |
| `PUBLIC_BASE_URL` | No | Public URL base for agents (e.g., `https://idbot.live`) |

### YAML Configuration

Deploy multiple agents from a config file:

```yaml
version: "1"
team: my-team

onchain:
  chainId: 11155111
  registryAddress: "0xceb79FcAfe0E9F3513fb70fB8A3841302dB4f477"

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-opus-4-6

agents:
  - name: coder
    description: "Writes and reviews code"
    workingDirectory: /path/to/project
    domain: coder.agent-1.sep.xid.eth  # Preserved across redeploys
    tokenId: "0xabcd..."               # Namehash of the ENS domain
  - name: researcher
    description: "Research and analysis"
    workingDirectory: /path/to/research
```

See [Configuration Reference](./docs/reference/configuration.md) for full options.

## Onchain Identity

Agents register on [ID Chain](https://github.com/idchain-world) for verifiable ENS-based identity:

```
/register my-agent
```

This does two things:
1. Registers a sequential agent name (e.g., `agent-15.sep.xid.eth`)
2. Creates a subname with the agent's local alias (e.g., `x.agent-15.sep.xid.eth`)

The subname is the agent's primary identity. The `tokenId` is the bytes32 namehash of the full ENS name — the true onchain identifier.

**Identity format:**
- `x.agent-15.sep.xid.eth` (default: alias.sequential-name.chain.xid.eth)
- `myagent.eth` (custom ENS name, linked via ENS)

Once registered, the `domain` and `tokenId` can be saved in the YAML config to persist the identity across redeploys.

## Ports and Networking

| Component | Port | Description |
|-----------|------|-------------|
| Manager | 4100 | Main API + `/remote` endpoint |
| Workers | 4101+ | Dynamic per-team range (25 ports per team) |
| PostgreSQL | 5432 | Database |

## Documentation

- [docs/README.md](./docs/README.md) - Documentation index
- [docs/protocol/rest-ap.md](./docs/protocol/rest-ap.md) - REST-AP protocol specification
- [docs/guides/interactive-agent.md](./docs/guides/interactive-agent.md) - Interactive CLI guide
- [docs/reference/configuration.md](./docs/reference/configuration.md) - Configuration reference
- [docs/reference/database.md](./docs/reference/database.md) - Database schema

## Development

```bash
npm run build           # Compile TypeScript
npm run dev             # Development mode
npm run id-agents       # Interactive CLI
npm test                # Run tests
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
