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
  chainId: 11155111
  registryAddress: "0x..."
  registrarAddress: "0x..."
  register: true

defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  plugins:
    - name: id-rest-ap
      path: plugins/id-rest-ap

agents:
  - name: coder
    model: claude-sonnet-4-20250514
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
  chainId: 11155111
  registryAddress: "0xABC..."
  registrarAddress: "0xDEF..."
  register: true
```

#### Onchain Object

| Field | Required | Description |
|-------|----------|-------------|
| `chainId` | Yes | EVM chain ID (e.g., 11155111 for Sepolia) |
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
  requireAuth: true
  plugins:
    - name: id-rest-ap
      path: plugins/id-rest-ap
```

#### Defaults Object

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | String | Default agent runtime (`claude-code`, `open-code`, `codex`) |
| `model` | String | Default LLM model |
| `requireAuth` | Boolean | Require API key authentication for all agents |
| `plugins` | Array | Default plugins for Claude Code agents |
| `skills` | Array | Default skills for OpenCode/Codex agents |
| `allowedTools` | Array | Default tool restrictions for all agents |

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
| `apiKey` | No | - | Static API key for this agent (legacy) |
| `requireAuth` | No | From defaults | Require client API key authentication |
| `plugins` | No | From defaults | Plugins for Claude Code agents |
| `skills` | No | From defaults | Skills for OpenCode/Codex agents (.md files) |
| `allowedTools` | No | From defaults | Restrict agent to specific tools |
| `env` | No | `{}` | Environment variables for the agent process |
| `register` | No | From onchain | Whether to register onchain |

### Agent Example

```yaml
agents:
  - name: lead-developer
    model: claude-sonnet-4-20250514
    runtime: claude-code
    systemPrompt: |
      You are a senior software developer.
      Focus on code quality and best practices.
    apiKey: "sk-agent-lead-secret-key"
    plugins:
      - name: id-rest-ap
        path: plugins/id-rest-ap
      - name: git-tools
        path: plugins/git-tools
    register: true
```

### Agent Authentication

There are two ways to protect agents with API keys:

#### 1. Manager-Issued Keys (Recommended)

Use `requireAuth: true` to require clients to authenticate with keys issued by the manager:

```yaml
defaults:
  requireAuth: true  # All agents require auth

agents:
  - name: public-agent
    requireAuth: false  # Override: this agent allows unauthenticated access
  - name: protected-agent
    # Uses defaults.requireAuth = true
```

When `requireAuth` is enabled:
- Clients must include a valid API key in the `X-API-Key` header
- Keys are issued via the manager's `/keys/issue` endpoint
- Agents validate keys by calling the manager's `/keys/validate` endpoint
- Inter-agent communication using `ID_AGENT_API_KEY` is always trusted

```bash
# Issue a client key (requires ID_CONTROL_API_KEY)
curl -X POST http://localhost:4100/keys/issue \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ID_CONTROL_API_KEY" \
  -d '{"name": "my-client", "scopes": ["talk"]}'

# Use the key to talk to an agent
curl http://localhost:4101/talk \
  -H "X-API-Key: sk-id-xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"message": "hello"}'
```

See [API Key Authentication](./api-keys.md) for full details on key management.

#### 2. Static API Key (Legacy)

For simple deployments, you can set a static `apiKey` directly on an agent:

```yaml
agents:
  - name: my-agent
    apiKey: "sk-agent-my-secret-key"
```

The key is passed to the agent process as `AGENT_API_KEY`. This approach is simpler but doesn't support key rotation or revocation.

#### Public Endpoints

The following endpoints are always accessible without authentication:
- `/health` - Health check for monitoring
- `/.well-known/restap.json` - REST-AP discovery

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
defaults:
  apiKey: ${env:ID_AGENT_API_KEY}

agents:
  - name: my-agent
    # API key is read from environment, not stored in config file
```

This keeps sensitive values like API keys out of config files. Set the variable in your `.env` file or shell environment:

```bash
export ID_AGENT_API_KEY=sk-idagent-your-secret-key
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
  chainId: 11155111
  registryAddress: "0x1234567890abcdef1234567890abcdef12345678"
  registrarAddress: "0xabcdef1234567890abcdef1234567890abcdef12"
  register: false

defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  requireAuth: true  # All agents require client API keys
  plugins:
    - name: id-rest-ap
      path: plugins/id-rest-ap

agents:
  # Lead developer
  - name: lead
    model: claude-${model_tier}-4-20250514
    systemPrompt: |
      You are the lead developer.
      Coordinate work and review code from other agents.
    register: true

  # Standard developer
  - name: dev-frontend
    systemPrompt: "You specialize in React and TypeScript."

  # Standard developer
  - name: dev-backend
    systemPrompt: "You specialize in Node.js and databases."

  # Public assistant - no auth required
  - name: public-assistant
    requireAuth: false
    systemPrompt: "You are a helpful public assistant."

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
| `ANTHROPIC_API_KEY` | Anthropic API key (required) |
| `CLAUDE_MODEL` | Default model override |
| `DATABASE_URL` | PostgreSQL connection string |
| `ORCHESTRATOR_TYPE` | Agent runtime type |
| `ID_PROJECT` | Default team/project name |
| `ID_CONTROL_API_KEY` | API key for the `/remote` endpoint |
| `ID_AGENT_API_KEY` | Default API key for agent authentication (used via `${env:ID_AGENT_API_KEY}`) |

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
- Invalid resource limit format
- Undefined parameter reference
