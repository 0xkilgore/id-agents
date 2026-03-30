```
  ██╗██████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗
  ██║██╔══██╗     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝
  ██║██║  ██║     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████╗
  ██║██║  ██║     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║
  ██║██████╔╝     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████║
  ╚═╝╚═════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝
```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Version 0.1.33-beta**

Multi-agent orchestration optimized for a single chat interface. Your Claude Code session is the control plane — you talk to it, it coordinates a team of agents that are real coding processes with full tool access. No UI, no dashboard. The manager runs headless over SSH, Telegram, or mobile, and supports mixed runtimes (Claude Code and OpenAI Codex) in the same team.

## Key Features

- **Multiple runtimes** - Claude Code CLI and OpenAI Codex — mix and match in the same team
- **Task system** - Create, assign, claim, and track tasks across agents (`/task` commands + `/tasks` REST API)
- **Scheduling** - Heartbeat intervals and calendar events for automated recurring work
- **Org chart** - Define team structure with groups and tags so agents know their peers and leads
- **Skills & plugins** - Standard Claude Code skills and plugins, declared in config and deployed to each agent
- **Agent wallets** - Automatic multi-chain wallets via [OWS](https://github.com/open-wallet-standard/core)
- **Onchain identity** - ENS-based agent identity via ID Chain (e.g., `x.agent-15.sep.xid.eth`)
- **Remote API** - Programmatic management via `/remote` endpoint and `/tasks` REST API

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
             │  Database  │     │ Workspace  │
             │  (SQLite)  │     │   Files    │
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
- **Claude Code CLI** — install from [claude.ai/code](https://claude.ai/code) and run `claude login`
- **Claude Pro or Max plan** (agents use your Claude Code subscription — no API key needed)
- **OpenAI Codex CLI** (optional) — install from [github.com/openai/codex](https://github.com/openai/codex) and run `codex login`
- **[id-cli](https://github.com/idchain-world/id-cli)** (optional, for onchain agent registration)
- **[OWS CLI](https://github.com/open-wallet-standard/core)** (optional, for agent wallets)

> **Important:** You must be logged into Claude Code CLI before starting ID Agents. Run `claude login` in your terminal and complete the authentication. If you use Claude Code in VS Code, you still need to log in via the terminal — open VS Code's integrated terminal and run `claude login` there.

### 1) Setup

```bash
# First, make sure Claude Code CLI is installed and logged in
claude login

# Then clone and set up ID Agents
git clone https://github.com/idchain-world/id-agents.git
cd id-agents
npm install
```

That's it — no database setup needed. ID Agents uses SQLite by default (stored at `~/.id-agents/id-agents.db`). For PostgreSQL, set `DATABASE_URL` in a `.env` file.

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
/deploy claude-code    # or /deploy codex
/ask coder Write a hello world function
```

### Mobile Access

When you run `npm run id-agents`, you're just running a normal Claude Code CLI session. You can connect it to your phone the same way you'd connect any Claude Code session — via Telegram, the Claude Code app, or any other channel. There's nothing special about the manager; it's just a Claude Code session with your agent team available via `/remote`.

> **Tip:** Connect your mobile device to this session (the one running the manager), not to individual agent sessions. From here you can `/ask` any agent, `/deploy` teams, check `/status`, and manage everything through one connection. See the [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) for mobile setup options.

## REST-AP Protocol

[REST-AP (REST Agent Protocol)](https://github.com/nxt3d/rest-ap) defines how agents communicate ([local docs](./docs/protocol/rest-ap.md)):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/restap.json` | GET | Discovery catalog |
| `/talk` | POST | Send message (triggers LLM processing, async) |
| `/schedule` | POST | Enqueue manager-owned internal scheduled work (optional) |
| `/news` | GET | Poll for updates (free, no LLM cost) |
| `/news` | POST | Receive replies without processing |

**Manager-specific endpoints:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agents` | GET | List all agents |
| `/message` | POST | Agent-to-agent messaging (fire-and-forget or wait) |
| `/remote` | POST | Execute CLI commands programmatically |

## Scheduling

ID Agents has one manager-owned scheduling system with two schedule kinds:
- `heartbeat` schedules for recurring work every N seconds
- `calendar` schedules for one-off or recurring wall-clock events

The manager is the only component that decides when a run is due. Agents do not run independent schedulers. Every due run is logged in the database before dispatch, which makes scheduling restart-safe and prevents double-fires.

### Authoring model

For single-agent recurring work, keep scheduling close to the agent with `heartbeat`:

```yaml
agents:
  - name: monitor
    heartbeat:
      interval: 300
      message: "Check system health and report status"
```

For wall-clock events, use top-level `calendar`:

```yaml
calendar:
  - title: "Morning X engagement"
    time: "09:00"
    timezone: "America/New_York"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    message: "Review timeline and draft replies"
    delivery: internal
```

### Delivery modes

Schedules support two delivery modes:
- `talk` - manager posts the scheduled payload to the agent's `/talk` endpoint
- `internal` - manager posts the scheduled payload to the agent's `/schedule` endpoint so the agent can treat it as internal self-directed work

Defaults:
- `heartbeat` defaults to `internal`
- `calendar` defaults to `talk`

The `from` field in the delivery payload comes from the schedule's `sender` field. Defaults:
- Heartbeats default to `from: "heartbeat"`
- Calendar events default to `from: "schedule"`
- You can override with `--sender` when adding a schedule via the CLI

The payload sent to agents is structured like:

```json
{
  "from": "heartbeat",
  "mode": "internal",
  "schedule": {
    "id": "sch_123",
    "kind": "interval",
    "title": "monitor heartbeat",
    "scheduledKey": "interval:sch_123@1711612800"
  },
  "message": "Check system health and report status"
}
```

See [Scheduling Plan](./docs/SCHEDULING_PLAN.md) for the full design.

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
/heartbeat                   # List heartbeats
/heartbeat add <agent> <seconds> <message>  # Add heartbeat
/heartbeat pause|resume|remove <id>         # Manage heartbeat
/calendar                    # List calendar events
/calendar add <agent> <time> <days|date> <message>  # Add calendar event
/calendar pause|resume|remove <id>          # Manage calendar event
/task create "<title>" [--name <slug>] [--owner <agent>]  # Create task
/task list [--status todo|doing|done]                    # List tasks
/task assign <name> <agent>  # Assign task
/task done <name>            # Complete task
/task remove <name>          # Delete task
/update <agent> [--wallet|--name]  # Update agent properties
/wallet <agent> [chain]     # Show agent wallet addresses
/quit                       # Exit
```

## Remote API

The Manager exposes a `/remote` endpoint that lets any external tool — including another Claude Code session — interact with your agent team programmatically. This is how you manage agents from outside the interactive CLI.

**From a terminal or script:**

```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/agents"}'
```

**From another Claude Code session:** If you're working in Claude Code on a different project, you can dispatch tasks to your agent team by calling the `/remote` endpoint via Bash. For example, ask your contracts agent to review code:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask contracts Review the latest changes to IDRegistry.sol"}'
```

Then check for the reply:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/news contracts"}'
```

This means any Claude Code instance on the same machine can coordinate with your agent team — dispatching work, checking results, and managing the fleet without switching to the interactive CLI.

**Available Commands:**
- `/agent <name> rebuild` - Rebuild a single agent
- `/agents` - List all agents
- `/agents rebuild` - Rebuild all agents
- `/ask <name> <message>` - Send message to agent
- `/clear [agent]` - Clear session
- `/delete <name>` - Delete agent
- `/deploy` - List available configs
- `/deploy <config>` - Deploy agents from YAML config
- `/news [-l] <name>` - Check recent messages
- `/register <name>` - Register agent onchain
- `/status` - Show status
- `/heartbeat` - List heartbeats
- `/heartbeat add <agent> <seconds> <message>` - Add heartbeat
- `/heartbeat pause|resume|remove <id>` - Manage heartbeat
- `/calendar` - List calendar events
- `/calendar add <agent> <time> <days|date> <message>` - Add calendar event
- `/calendar pause|resume|remove <id>` - Manage calendar event
- `/task create "<title>"` - Create task
- `/task list` - List tasks
- `/task assign <name> <agent>` - Assign task
- `/task done <name>` - Complete task
- `/task remove <name>` - Delete task

## Task API

The Manager exposes dedicated `/tasks` REST endpoints for agent task coordination. Agents should use these instead of `/remote` for task operations — it's simpler, safer, and doesn't expose arbitrary CLI access.

| Route | Method | Description |
|-------|--------|-------------|
| `/tasks` | POST | Create a task (`{ title, name?, description?, team?, from? }`) |
| `/tasks` | GET | List tasks (query params: `status`, `owner`, `team`) |
| `/tasks/:name` | GET | Get a single task by name |
| `/tasks/:name/claim` | POST | Claim a task (`{ agent_id }`) |
| `/tasks/:name/done` | POST | Mark task complete (`{ agent_id }`) |
| `/tasks/:name` | DELETE | Remove a task |

**Create and claim a task:**

```bash
# Create
curl -s -X POST http://localhost:4100/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix the overflow bug", "name": "fix-overflow"}'

# Claim
curl -s -X POST http://localhost:4100/tasks/fix-overflow/claim \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent"}'

# Mark done
curl -s -X POST http://localhost:4100/tasks/fix-overflow/done \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent"}'

# List open tasks
curl -s "http://localhost:4100/tasks?status=todo"
```

Task statuses: `todo` (unclaimed), `doing` (in progress), `done` (completed). The `agent_id` field accepts agent names or aliases, resolved against the current team.

## Skills & Plugins

Skills and plugins extend agent capabilities. Both are declared in the YAML config and automatically deployed to each agent's working directory at deploy time.

### Skills

Skills use the standard [Claude Code skill format](https://docs.anthropic.com/en/docs/claude-code/skills) — a `SKILL.md` file with YAML frontmatter inside a named directory. Drop any skill into `skills/` and reference it by name in your config.

**Built-in skills:**

| Skill | Description |
|-------|-------------|
| `identity` | Agent name, team, and onchain ENS domain |
| `inter-agent` | Messaging, delegation, news feed for multi-agent coordination |
| `catalog` | REST-AP self-description visible to other agents |
| `wallet` | OWS multi-chain wallet addresses (skipped if no wallet) |

**Adding a skill:**

1. Create a directory in `skills/` with a `SKILL.md` file:

```
skills/my-skill/
  SKILL.md
```

2. Add YAML frontmatter to `SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does. Claude uses this to decide when to invoke it.
---

# My Skill

Instructions for the agent...
```

3. Reference it in your config:

```yaml
defaults:
  skills: [identity, inter-agent, catalog, wallet, my-skill]
```

Skills from defaults and per-agent lists are merged (deduped). You can also download skills from Anthropic or the community and drop them in.

### Plugins

Plugins are [Claude Code plugins](https://docs.anthropic.com/en/docs/claude-code/plugins) (MCP servers, tool providers). They can also bundle skills in their own `skills/` subdirectory.

```yaml
defaults:
  plugins:
    - name: id-rest-ap
      path: ../plugins/claude-code/id-rest-ap
```

See [Skills README](./skills/README.md) for the full skill directory listing.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | PostgreSQL connection string (SQLite used by default if not set) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (not needed with Claude Pro or Max — run `claude login` instead) |
| `CLAUDE_MODEL` | No | Default model (e.g., `claude-opus-4-6`) |
| `OWS_REGISTRAR_WALLET` | No | OWS wallet name for onchain signing (recommended over raw key) |
| `ID_REGISTRAR_PRIVATE_KEY` | No | Wallet private key for onchain registration (fallback if OWS not used) |
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
  skills:
    - identity
    - inter-agent
    - catalog
    - wallet
  plugins:
    - name: id-rest-ap
      path: ../plugins/claude-code/id-rest-ap

agents:
  - name: coder
    description: "Writes and reviews code"
    workingDirectory: /path/to/project
    heartbeat:
      interval: 300
      message: "Review open PRs and summarize risks"
      delivery: internal
    domain: coder.agent-1.sep.xid.eth  # Preserved across redeploys
    tokenId: "0xabcd..."               # Namehash of the ENS domain
  - name: researcher
    description: "Research and analysis"
    workingDirectory: /path/to/research
    skills: [custom-research-skill]    # Added to defaults

calendar:
  - title: "Daily standup prep"
    time: "09:00"
    timezone: "America/New_York"
    days: [mon, tue, wed, thu, fri]
    agents: [coder, researcher]
    message: "Prepare daily updates and blockers"
    delivery: talk
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

## Agent Wallets (OWS)

If [OWS](https://github.com/open-wallet-standard/core) (Open Wallet Standard) is installed, each agent automatically gets a multi-chain wallet at deploy time. Wallets are encrypted in the OWS vault at `~/.ows/`.

**What happens at deploy:**
1. Manager creates an OWS wallet per agent (e.g., `idchain-contracts`)
2. Wallet addresses are written as ENS records via `/sync-wallets`
3. A `wallet` skill is deployed so the agent knows its own addresses

**Asking an agent for its address:**
```
/ask contracts What is your Bitcoin address?
→ bc1q3aat33mm4jd602y8q7g3w972g0a8zle72srkkz
```

**Onchain signing:** The manager uses a separate registrar wallet (`OWS_REGISTRAR_WALLET`) for signing registration and record-setting transactions. The private key never leaves the OWS vault — signing is delegated to `ows sign tx` via [id-cli](https://github.com/idchain-world/id-cli).

```bash
# .env
OWS_REGISTRAR_WALLET=idchain-registrar
```

**OWS policies** can restrict which chains and contracts the registrar wallet can interact with. Create a policy and attach it to an API key for scoped access:

```bash
ows policy create --file idchain-policy.json
ows key create --name "id-agents" --wallet idchain-registrar --policy idchain-only
# Set the API key for policy enforcement:
# OWS_PASSPHRASE=ows_key_...
```

## Org Chart

Teams can define an organizational structure in their YAML config under the `org:` key. This gives agents awareness of who they work with, who leads what, and how the team is organized.

**Two primitives:**

- **Groups** — recursive hierarchy with optional `lead`, `members`, `description`, and nested `groups`
- **Tags** — flat labels that cut across groups (e.g., `reviewers: [alice, bob]`)

**What happens at deploy:**

1. The org chart is rendered into `ORG_CHART.md` and written to the shared team folder
2. Each agent's `identity` skill is populated with their role context — which group they belong to, their peers, their lead, and any tags they carry

**Example config:**

```yaml
org:
  groups:
    engineering:
      lead: alice
      description: "Core product development"
      members: [bob, carol]
      groups:
        infra:
          lead: carol
          members: [dave]
    security:
      lead: eve
      members: [frank]

  tags:
    reviewers: [alice, eve]
    oncall: [carol, frank]
```

**Generated `ORG_CHART.md`:**

```markdown
# Team Org Chart

## engineering
Core product development
- **Lead:** alice
- **Members:** bob, carol

### infra
- **Lead:** carol
- **Members:** dave

## security
- **Lead:** eve
- **Members:** frank

## Tags
- **reviewers:** alice, eve
- **oncall:** carol, frank
```

When `alice` is deployed, her identity skill knows she leads `engineering`, is tagged as a `reviewer`, and can see the full org chart for context on who to delegate to or consult.

## Ports and Networking

| Component | Port | Description |
|-----------|------|-------------|
| Manager | 4100 | Main API + `/remote` endpoint |
| Workers | 4101+ | Dynamic per-team range (25 ports per team) |

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
