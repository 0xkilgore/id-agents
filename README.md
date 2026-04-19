```
  ██╗██████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗
  ██║██╔══██╗     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝
  ██║██║  ██║     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████╗
  ██║██║  ██║     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║
  ██║██████╔╝     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████║
  ╚═╝╚═════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝
```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Version 0.1.53-beta**

Run a team of AI coding agents from a single chat. Each agent is a real process with full tool access — Claude Code, OpenAI Codex, or both. No UI needed. Connect from any terminal, Telegram, or SSH session.

## Key Features

- **Multiple runtimes** - Claude Code CLI and OpenAI Codex — mix and match in the same team
- **Public-agent support** - register any REST-AP service that publishes `/.well-known/restap.json` with `service_type: "public-agent"` into the `public` team via `/public add <domain>`. The id-agents manager handles wallet provisioning, ID Chain registration, SSH-delivered identity files, heartbeat probes, and DMZ metadata. **[Juno](https://github.com/idchain-world/juno)** is the reference public-agent implementation we ship — capability-limited by design, safe to point at the internet — but any service that speaks the same protocol works
- **Task system** - Create, assign, claim, and track tasks across agents (`/task` commands + `/tasks` REST API)
- **Scheduling** - Heartbeat intervals and calendar events for automated recurring work
- **Org chart** - Define team structure with groups and tags so agents know their peers and leads
- **Skills & plugins** - Standard Claude Code skills and plugins, declared in config and deployed to each agent
- **Agent wallets** - Automatic multi-chain wallets via [OWS](https://github.com/open-wallet-standard/core)
- **Onchain identity** - ENS-based agent identity via ID Chain (e.g., `x.agent-15.xid.eth`)
- **Remote API** - Programmatic management via `/remote` endpoint and `/tasks` REST API
- **TUI Dashboard** - Live terminal dashboard for the running team — agents list, news feed, message detail (`npm run tui:dev`)

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
- **Worker** (`src/agent-rest-server.ts`) - REST-AP server running each local agent process
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

> **⚠️ Permissions:** ID Agents runs each agent as a background process. By default, `claude-code-cli` agents spawn with `--dangerously-skip-permissions` and `codex` agents spawn with `--dangerously-bypass-approvals-and-sandbox`, because background processes have no shell to approve tool prompts. You can opt out per agent (or under `defaults`) with `dangerouslySkipPermissions: false`, but the agents will then hang silently on the first tool-use prompt. If you are not comfortable giving background agents this level of autonomy, ID Agents is not the right tool for you. See [QUICKSTART.md](./QUICKSTART.md#-permissions-notice--read-before-deploying) for the full notice.

### Recommended: Let Claude set it up

The fastest way to start is to let a Claude Code session do it. Claude clones the repo, installs the `idagents-admin-control` skill, starts the manager, deploys the default team, then offers to act as your team manager.

Paste this into any Claude Code session:

> Set up id-agents by following the QUICKSTART at https://github.com/idchain-world/id-agents/blob/main/QUICKSTART.md

<details>
<summary>Prefer to install the skill yourself first?</summary>

```bash
git clone https://github.com/idchain-world/id-agents.git
cp -r id-agents/skills/idagents-admin-control <your-claude-code-project>/.claude/skills/
```

Then paste the prompt above into Claude Code.

</details>

See [QUICKSTART.md](./QUICKSTART.md) for the full step-by-step.

### Manual install

Prefer to run the steps yourself? Skip the skill and use the interactive CLI directly.

#### 1) Setup

```bash
# First, make sure Claude Code CLI is installed and logged in
claude login

# Then clone and set up ID Agents
git clone https://github.com/idchain-world/id-agents.git
cd id-agents
npm install
```

That's it — no database setup needed. ID Agents uses SQLite by default (stored at `~/.id-agents/id-agents.db`). For PostgreSQL, set `DATABASE_URL` in a `.env` file.

#### 2) Run the interactive CLI

```bash
npm run id-agents
```

Custom port (default: 4100):

```bash
MANAGER_PORT=5000 npm run id-agents
```

#### 3) Deploy and talk to agents

`configs/default.yaml` is the source of truth — whatever is in the file is what gets deployed. Before deploying, edit it to match the runtimes on this host:

```bash
./scripts/detect-runtimes.sh   # tells you which of the 4 cases below applies
```

The default team always has 2 agents (`coder` + `researcher`). Only the runtime mix changes per host:

| Claude ready | Codex ready | Edit `configs/default.yaml` | Final team |
|---|---|---|---|
| ✓ | ✓ | Flip ONLY `researcher`'s runtime to `codex`. | `coder` (Claude) + `researcher` (Codex) |
| ✓ | ✗ | No edit. | `coder` + `researcher` (both Claude) |
| ✗ | ✓ | Flip `defaults.runtime` from `claude-code-cli` to `codex`. | `coder` + `researcher` (both Codex) |
| ✗ | ✗ | Stop. Run `claude login` or `codex login` first. | — |

`detect-runtimes.sh` prints the exact commands for the `mixed` and `all-codex` rows — see [QUICKSTART Step 4](./QUICKSTART.md) for the full snippets.

Then deploy and talk to the team:

```
/deploy default
/ask coder Write a hello world function
```

See [QUICKSTART Step 4](./QUICKSTART.md) for the full detection commands.

To update a running team later (add/remove/change agents without losing sessions), use [`/sync`](docs/guides/sync-command.md) instead of `/deploy`.

### Connecting a Manager

ID Agents runs the servers and agent processes. You connect to it through a "manager" — any AI coding agent that can reach the `/remote` API. This can be Claude Code CLI, Codex, OpenClaw, or any other agent that can make HTTP requests.

```bash
# The manager is whatever you're chatting in — it controls the team via /remote
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/status"}'
```

Connect from anywhere — terminal, mobile (via Telegram), SSH, or any tool that can POST to `/remote`.

### TUI Dashboard

Launch the live terminal dashboard to watch the running team without polling by hand:

```bash
npm run tui:dev          # source mode (tsx)
npm run tui              # build + run from dist/
```

The TUI talks to the manager at `MANAGER_URL` (default `http://localhost:4100`) and has three pages: the agents table, the per-agent news feed, and a news-item detail view. Navigate with the arrow keys. `Tab` cycles teams, `p` pauses polling, `q` quits.

```
↑↓ nav · → news · Tab team · p pause · q quit
```

iTerm2 is the recommended terminal — it renders the alt-screen content flicker-free. See [docs/guides/tui.md](./docs/guides/tui.md) for the full keybindings reference and terminal compatibility notes.

## REST-AP Protocol

[REST-AP (REST Agent Protocol)](https://github.com/nxt3d/rest-ap) defines how agents communicate ([local docs](./docs/protocol/rest-ap.md)):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/restap.json` | GET | Discovery catalog |
| `/talk` | POST | Send message (triggers LLM processing, async) |
| `/schedule` | POST | Enqueue manager-owned internal scheduled work (optional) |
| `/news` | GET | Poll for updates (free, no LLM cost) |
| `/news` | POST | Receive replies without processing |

**Agent-internal endpoint:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/talk-to` | POST | Synchronous agent-to-agent communication (blocks until reply) |

**Manager-specific endpoints:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agents` | GET | List all agents |
| `/message` | POST | Fire-and-forget agent-to-agent messaging (no reply) |
| `/remote` | POST | Execute CLI commands programmatically (no auth required) |

## Scheduling

ID Agents has one manager-owned scheduling system with two schedule kinds:
- `heartbeat` schedules for recurring work every N seconds
- `calendar` schedules for one-off or recurring wall-clock events

The manager is the only component that decides when a run is due. Agents do not run independent schedulers. Every due run is logged in the database before dispatch, which makes scheduling restart-safe and prevents double-fires.

### Authoring model

For single-agent recurring work, keep scheduling close to the agent with `heartbeat`. The agent reads its own `HEARTBEAT.md` checklist when woken up:

```yaml
agents:
  - name: monitor
    heartbeat: 300  # seconds — agent reads HEARTBEAT.md
```

Place the checklist at `.claude/agents/{name}/HEARTBEAT.md` in the agent's working directory. It is copied to the root at spawn time. If nothing needs attention, the agent responds with `HEARTBEAT_OK` and the response is silently suppressed from the news feed.

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
/delete *                   # Delete all agents in current team
/delete --team <name>       # Delete all agents in specified team
/deploy <config>            # Deploy agents from config (clean/first-time)
/sync <config>              # Reconcile running team with config (preserves sessions)
/output <agent>             # List files in agent's output directory
/artifact <agent> <path>    # Read a file from agent's output directory
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

The Manager exposes a `/remote` endpoint (no authentication required — localhost only) that lets any external tool — including another Claude Code session — interact with your agent team programmatically. This is how you manage agents from outside the interactive CLI. Deploy and sync commands (`/deploy`, `/sync`) also work via `/remote`.

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
- `/delete *` - Delete all agents in current team
- `/delete --team <name>` - Delete all agents in specified team
- `/deploy <config>` - Deploy agents from YAML config (clean/first-time)
- `/sync <config>` - [Reconcile running team with config](docs/guides/sync-command.md) (preserves sessions)
- `/news [-l] <name>` - Check recent messages
- `/output <name>` - List files in agent's output directory
- `/artifact <name> <path>` - Read a file from agent's output directory
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
| `xmtp` | Encrypted messaging via ENS names using the [XMTP](https://xmtp.org/) protocol |
| `idagents-admin-control` | Remote CLI management — chat with manager, execute commands (external skill) |

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

All configs should include `skills: [identity, inter-agent, catalog]` at minimum. Skills from defaults and per-agent lists are merged (deduped). You can also download skills from Anthropic or the community and drop them in.

Skills are deployed at deploy time via `deploySkillsToAgent`. The target directory is runtime-aware: `.claude/skills/` for Claude agents, `.agents/skills/` for Codex agents.

### Plugins

Plugins are [Claude Code plugins](https://docs.anthropic.com/en/docs/claude-code/plugins) (MCP servers, tool providers). They can also bundle skills in their own `skills/` subdirectory.

```yaml
defaults:
  plugins:
    - name: frontend-design
      path: ../plugins/claude-code/frontend-design
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

**Per-agent environment (set automatically by the manager):**

| Variable | Description |
|----------|-------------|
| `ID_AGENT_PORT` | The agent's own REST-AP port (e.g., `4101`) |
| `ID_AGENT_NAME` | Agent name |
| `ID_AGENT_ALIAS` | Agent alias (same as name) |
| `ID_TEAM` | Team name |
| `MANAGER_URL` | Manager base URL (e.g., `http://localhost:4100`) |

### YAML Configuration

Deploy multiple agents from a config file:

```yaml
version: "1"
team: my-team

onchain:
  chainId: 8453

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-opus-4-6
  skills:
    - identity
    - inter-agent
    - catalog
    - wallet

agents:
  - name: coder
    description: "Writes and reviews code"
    workingDirectory: /path/to/project
    heartbeat: 300  # seconds — agent reads HEARTBEAT.md
    domain: coder.agent-1.xid.eth  # Preserved across redeploys
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

### Agent Instructions: Two Sources

Every agent's `CLAUDE.md` is composed from exactly two sources:

1. **Protocol defaults** (`src/protocol-defaults.ts`) — framework-managed rules injected into every agent automatically: scheduling awareness, task-discipline lifecycle, output convention. Users never edit these in YAML.
2. **Agent role file** (`{workingDirectory}/.claude/agents/{name}.md`) — role-specific personality and context, editable by the user, versionable in git. If the file does not exist, the agent runs with protocol defaults only.

The YAML config provides **infrastructure only**: name, workingDirectory, model, runtime, heartbeat, skills. No `claudeMd` field.

Two file patterns are supported (checked in this order), and paths are **runtime-aware**:

| Runtime | Template Directory | Personality File | Skills Directory |
|---------|-------------------|-----------------|-----------------|
| `claude-code-cli` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `claude-agent-sdk` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `codex` | `.agents/` | `AGENTS.md` (project root) | `.agents/skills/` |

```
# Claude agent layout
myproject/
  .claude/
    agents/
      coder/
        CLAUDE.md           # directory pattern (priority)
      security-audit.md     # single-file pattern (fallback)

# Codex agent layout
myproject/
  .agents/
    cto/
      AGENTS.md             # directory pattern (priority)
    researcher.md           # single-file pattern (fallback)
```

The directory pattern takes priority over the single-file pattern. Use the directory pattern when the agent needs additional supporting files alongside its role definition.

A role file uses optional YAML frontmatter for metadata:

```markdown
---
description: Security audit specialist
---

You are a security auditor. Focus on OWASP Top 10 vulnerabilities.
Always check for injection, XSS, and authentication issues.
```

- **Body** becomes the agent's role content, appended after protocol defaults in `CLAUDE.md`.
- **`description`** from frontmatter is used as the agent's description if the config doesn't set one.

Use the `agent` field in config to load a role file with a different filename than the agent's name:

```yaml
agents:
  - name: auditor
    agent: security-audit          # loads security-audit/CLAUDE.md or security-audit.md
    workingDirectory: /path/to/project
```

This lets you promote Claude Code sub-agents (`.claude/agents/*.md`) into full id-agents workers with identity, while keeping the role file in the project repo where it belongs.

## Onchain Identity

Agents register on [ID Chain](https://github.com/idchain-world) for verifiable ENS-based identity:

```
/register my-agent
```

This does two things:
1. Registers a sequential agent name (e.g., `agent-15.xid.eth`)
2. Creates a subname with the agent's local alias (e.g., `x.agent-15.xid.eth`)

The subname is the agent's primary identity. The `tokenId` is the bytes32 namehash of the full ENS name — the true onchain identifier.

**Identity format:**
- `x.agent-15.xid.eth` (default: alias.sequential-name.xid.eth)
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

## XMTP Encrypted Messaging

Agents can send and receive end-to-end encrypted messages via the [XMTP](https://xmtp.org/) protocol. This enables cross-team and cross-system communication with any wallet address or ENS name.

**How it works:**
- Each agent gets its own XMTP identity derived from its OWS wallet
- Messages are encrypted end-to-end using the MLS protocol
- Send to any ENS name (`agent-15.xid.eth`, `vitalik.eth`) or wallet address
- Inbound messages are routed through the agent's LLM and replies are sent back automatically

**Sending a message (from an agent):**
```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/xmtp/send \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-15.xid.eth", "message": "Hello from across the network"}'
```

**Security model:**
- **Closed by default** — agents only accept messages from explicitly allowed senders
- **3-tier allowlist** — trusted senders (auto-accepted), unknown senders (approval required), blocked senders (silently dropped)
- **OWS signing** — private keys never leave the OWS vault; all XMTP signing is delegated to `ows sign message`
- **Prompt boundary** — inbound XMTP messages are clearly marked as external untrusted input before reaching the LLM

**Data storage:** XMTP data is stored at `~/.xmtp/{address}/` (outside project repos):
- `{env}.db3` — encrypted MLS database (message history, conversation keys)
- `db.key` — auto-generated DB encryption key (mode 0600)
- `allowlist.yaml` — persisted sender allowlist

**Configuration:** Add the `xmtp` skill to your agent config. XMTP starts automatically when an OWS wallet is available:
```yaml
defaults:
  skills: [identity, inter-agent, catalog, xmtp]
```

Set `openMode: true` in the agent config to accept messages from any sender (not recommended for production).

## Inter-Agent Communication

Agents communicate using two methods — both via `curl` from the Bash tool (not SendMessage or built-in Claude Code tools):

**`/talk-to` (primary, synchronous):** Send a message to another agent and block until reply. Called on the agent's own port:

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "your question?", "timeout": 120000}'
```

**`/message` (fire-and-forget):** One-way notification via the manager. No reply expected:

```bash
curl -s -X POST $MANAGER_URL/message \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"to": "agent-name", "message": "FYI: deployment is done"}'
```

### Loop Prevention

Triggered messages (from schedules and heartbeats) include a `noAutoReply` flag that prevents the agent from automatically replying back to the sender. The response is stored in the agent's own news feed instead, preventing infinite ping-pong loops between agents. If the agent responds with exactly `HEARTBEAT_OK`, the response is silently suppressed from the news feed and only logged at debug level.

## Ports and Networking

| Component | Port | Description |
|-----------|------|-------------|
| Interactive CLI | 4000 | CLI server for local interactive sessions |
| Manager | 4100 | Main API, `/remote` endpoint, agent registry |
| Agents | 4101+ | Dynamic per-team range (25 ports per team) |

## Documentation

- [docs/README.md](./docs/README.md) - Documentation index
- [docs/protocol/rest-ap.md](./docs/protocol/rest-ap.md) - REST-AP protocol specification
- [docs/guides/interactive-agent.md](./docs/guides/interactive-agent.md) - Interactive CLI guide
- [docs/reference/configuration.md](./docs/reference/configuration.md) - Configuration reference
- [docs/reference/database.md](./docs/reference/database.md) - Database schema
- [docs/guides/tasks.md](./docs/guides/tasks.md) - Task tracking with `/task`
- [docs/guides/news-feed.md](./docs/guides/news-feed.md) - News feed and message channels
- [docs/guides/agent-outputs.md](./docs/guides/agent-outputs.md) - Agent output convention and `/artifact`
- [docs/guides/heartbeats.md](./docs/guides/heartbeats.md) - Agent-driven heartbeat system

## Development

```bash
npm run build           # Compile TypeScript
npm run dev             # Development mode
npm run id-agents       # Interactive CLI
npm test                # Run tests
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
