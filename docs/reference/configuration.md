# Configuration Reference

ID Agents supports YAML-based configuration files for defining agent deployments, team settings, and onchain registration.

## Configuration File Format

```yaml
version: "1.0"
team: my-team

parameters:
  - name: environment
    default: development

onchain:
  chainId: 8453
  registryAddress: "0x..."
  registrarAddress: "0x..."
  register: true

defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  plugins:
    - name: id-rest-ap
      path: plugins/id-rest-ap

calendar:
  - title: Daily standup prep
    time: "09:00"
    timezone: America/New_York
    days: [mon, tue, wed, thu, fri]
    agents: [coder, researcher]
    message: Prepare daily updates and blockers
    delivery: talk

agents:
  - name: coder
    model: claude-sonnet-4-20250514
    heartbeat:
      interval: 300
      message: Review open PRs and summarize risks
      delivery: internal
    register: true
  - name: researcher
    systemPrompt: "You are a research specialist."
```

## Top-Level Fields

### version

**Required:** Yes
**Type:** String

Configuration file format version. Currently `"1.0"`.

```yaml
version: "1.0"
```

### team

**Required:** No
**Type:** String
**Default:** `default`

Team/namespace name for the deployment. Agents will be created in this team.

```yaml
team: my-project
```

### parameters

**Required:** No
**Type:** Array of Parameter objects

Define parameters that can be substituted throughout the config using `${name}` syntax.

```yaml
parameters:
  - name: environment
    default: development
  - name: model_tier
    default: haiku
```

Usage:
```yaml
agents:
  - name: worker-${environment}
    model: claude-${model_tier}-4-5-20251001
```

#### Parameter Object

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Parameter name |
| `default` | No | Default value if not provided |
| `description` | No | Human-readable description of the parameter |

### onchain

**Required:** No
**Type:** Onchain object

Configuration for onchain agent registration.

```yaml
onchain:
  chainId: 8453
  registryAddress: "0xABC..."
  registrarAddress: "0xDEF..."
  register: true
```

#### Onchain Object

| Field | Required | Description |
|-------|----------|-------------|
| `chainId` | Yes | EVM chain ID (e.g., 8453 for Base) |
| `registryAddress` | Yes | Agent registry contract address |
| `registrarAddress` | No | Registrar contract address for registration |
| `register` | No | Default registration setting for all agents |

### defaults

**Required:** No
**Type:** Defaults object

Default settings applied to all agents unless overridden.

```yaml
defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  plugins:
    - name: id-rest-ap
      path: plugins/id-rest-ap
```

#### Defaults Object

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | String | Default agent runtime (`claude-code`, `open-code`, `codex`) |
| `model` | String | Default LLM model |
| `plugins` | Array | Default plugins for Claude Code agents |
| `skills` | Array | Default skills for OpenCode/Codex agents |
| `allowedTools` | Array | Default tool restrictions for all agents |

### calendar

**Required:** No
**Type:** Array of Calendar objects

Top-level wall-clock schedules. Use this for one-off dated events or recurring local-time events that target one or more agents.

```yaml
calendar:
  - title: Daily standup prep
    time: "09:00"
    timezone: America/New_York
    days: [mon, tue, wed, thu, fri]
    agents: [coder, researcher]
    message: Prepare daily updates and blockers
    delivery: talk
```

#### Calendar Object

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable schedule title |
| `time` | Yes | Local wall-clock time in `HH:MM` or `HH:MM:SS` |
| `timezone` | No | IANA timezone; defaults to the host timezone |
| `date` | Conditionally | One-off local date in `YYYY-MM-DD` |
| `days` | Conditionally | Recurring weekdays such as `[mon, wed, fri]` |
| `agents` | Yes | Target agent names/refs |
| `message` | No | Message delivered to the target agents |
| `description` | No | Human-readable description |
| `catchUpPolicy` | No | `skip` or `fire_once` |
| `delivery` | No | `talk` or `internal` |

Exactly one of `date` or `days` must be provided.

### agents

**Required:** Yes
**Type:** Array of Agent objects

List of agents to deploy.

```yaml
agents:
  - name: coder
    model: claude-sonnet-4-20250514
  - name: researcher
    runtime: open-code
```

---

## Agent Configuration

Each agent can have the following fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | - | Agent name (must be unique within team) |
| `description` | No | - | Human-readable description of the agent |
| `model` | No | From defaults | LLM model to use |
| `runtime` | No | From defaults | Agent runtime/harness |
| `systemPrompt` | No | - | Custom system prompt |
| `plugins` | No | From defaults | Plugins for Claude Code agents |
| `skills` | No | From defaults | Skills for OpenCode/Codex agents (.md files) |
| `allowedTools` | No | From defaults | Restrict agent to specific tools |
| `env` | No | `{}` | Environment variables for the agent process |
| `register` | No | From onchain | Whether to register onchain |
| `heartbeat` | No | - | Single-agent recurring schedule shorthand |

### Agent Example

```yaml
agents:
  - name: lead-developer
    model: claude-sonnet-4-20250514
    runtime: claude-code
    systemPrompt: |
      You are a senior software developer.
      Focus on code quality and best practices.
    plugins:
      - name: id-rest-ap
        path: plugins/id-rest-ap
      - name: git-tools
        path: plugins/git-tools
    heartbeat:
      interval: 300
      message: Review open PRs and summarize risks.
      delivery: internal
    register: true
```

### heartbeat

Agent-level recurring scheduling shorthand. This compiles into an internal `interval` schedule targeting that one agent.

```yaml
agents:
  - name: coder
    heartbeat:
      interval: 300
      message: Review open PRs and summarize risks
      delivery: internal
      maxBeats: 20
      expiresAfter: 7200
```

#### Heartbeat Object

| Field | Required | Description |
|-------|----------|-------------|
| `interval` | Yes | Recurrence interval in seconds |
| `message` | Yes | Message delivered on each run |
| `maxBeats` | No | Maximum successful runs before the schedule stops |
| `expiresAfter` | No | Number of seconds after activation before the schedule expires |
| `delivery` | No | `talk` or `internal` |

Defaults:
- `heartbeat.delivery` defaults to `internal`
- `calendar.delivery` defaults to `talk`

---

## Plugin Configuration

Plugins extend agent capabilities with additional tools and instructions.

### Plugin Object

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Plugin identifier |
| `path` | Yes | Path to plugin directory |

```yaml
plugins:
  - name: id-rest-ap
    path: plugins/id-rest-ap
  - name: custom-tools
    path: plugins/custom-tools
```

Plugins are copied to the agent's working directory at spawn time. Each agent owns its copy and can modify it.

---

## Skills Configuration (OpenCode/Codex)

Skills are `.md` files that get concatenated into `AGENTS.md` for OpenCode and Codex agents.

### Skill Object

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill name (e.g., "inter-agent" loads `inter-agent.md`) |
| `path` | No | Custom path to skill file (defaults to `plugins/opencode/<name>.md`) |

```yaml
agents:
  - name: my-agent
    runtime: open-code
    skills:
      - name: inter-agent
      - name: custom-skill
        path: /path/to/custom.md
```

Skills provide instructions and context to agents using runtimes that read `AGENTS.md` for project configuration.

---

## Process Configuration

Settings for agent processes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `env` | Object | `{}` | Environment variables for the agent process |

```yaml
env:
  MY_VAR: "value"
  DEBUG: "true"
```

---

## Runtime Options

ID Agents supports multiple LLM runtimes (harnesses):

| Runtime | Description | Features |
|---------|-------------|----------|
| `claude-code` | Claude Agent SDK | Full tool access, session support |
| `open-code` | OpenCode CLI | Multi-provider support |
| `codex` | Codex CLI | OpenAI's coding agent |

```yaml
defaults:
  runtime: claude-code

agents:
  - name: agent-a
    runtime: claude-code
  - name: agent-b
    runtime: open-code
```

---

## Model Options

Common model identifiers:

| Model | Description |
|-------|-------------|
| `claude-haiku-4-5-20251001` | Fast, efficient for simple tasks |
| `claude-sonnet-4-20250514` | Balanced capability and speed |
| `claude-opus-4-5-20251101` | Most capable, complex tasks |

```yaml
agents:
  - name: quick-worker
    model: claude-haiku-4-5-20251001
  - name: senior-dev
    model: claude-sonnet-4-20250514
```

---

## Parameter Substitution

Use `${name}` syntax to reference parameters defined in the config:

```yaml
parameters:
  - name: env
    default: dev
  - name: tier
    default: haiku

team: project-${env}

agents:
  - name: worker-${env}
    model: claude-${tier}-4-5-20251001
```

Parameters can be overridden at deploy time via CLI or API.

### Environment Variables

Use `${env:VAR_NAME}` syntax to reference environment variables:

```yaml
agents:
  - name: my-agent
    env:
      MY_SECRET: ${env:MY_SECRET_VALUE}
```

This keeps sensitive values out of config files. Set the variable in your `.env` file or shell environment:

```bash
export MY_SECRET_VALUE=some-secret
```

---

## Complete Example

```yaml
version: "1.0"
team: production-team

parameters:
  - name: model_tier
    default: sonnet

onchain:
  chainId: 8453
  registryAddress: "0x1234567890abcdef1234567890abcdef12345678"
  registrarAddress: "0xabcdef1234567890abcdef1234567890abcdef12"
  register: false

defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  plugins:
    - name: id-rest-ap
      path: plugins/id-rest-ap

calendar:
  - title: Daily standup prep
    time: "09:00"
    timezone: America/New_York
    days: [mon, tue, wed, thu, fri]
    agents: [lead, dev-frontend, dev-backend]
    message: Prepare daily updates and blockers
    delivery: talk

agents:
  # Lead developer
  - name: lead
    model: claude-${model_tier}-4-20250514
    systemPrompt: |
      You are the lead developer.
      Coordinate work and review code from other agents.
    heartbeat:
      interval: 300
      message: Review recent changes and coordinate the team.
      delivery: internal
    register: true

  # Standard developer
  - name: dev-frontend
    systemPrompt: "You specialize in React and TypeScript."

  # Standard developer
  - name: dev-backend
    systemPrompt: "You specialize in Node.js and databases."

  # Researcher with different runtime
  - name: researcher
    runtime: open-code
    model: gpt-4-turbo
```

---

## Environment Variables

Configuration can also be provided via environment variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (not needed with Claude Max plan) |
| `CLAUDE_MODEL` | Default model override |
| `DATABASE_URL` | PostgreSQL connection string |
| `ORCHESTRATOR_TYPE` | Agent runtime type |
| `PUBLIC_BASE_URL` | Public URL base for agents (e.g., `https://idbot.live`) |

Environment variables take precedence over config file values for most settings.

---

## Config File Locations

ID Agents looks for configuration files in:

1. Path specified via CLI: `/deploy path/to/config.yaml`
2. Team config: `configs/<team-name>.yaml`
3. Default config: `configs/default.yaml`

---

## Validation

Configuration files are validated on load. Common errors:

- Missing required `version` field
- Invalid `runtime` value
- Missing `name` in agents array
- Invalid `calendar.time`, `calendar.days`, or `calendar.delivery`
- Missing required `heartbeat.interval` or `heartbeat.message`
- Invalid resource limit format
- Undefined parameter reference
