# ID Agent Plugins

This folder contains plugins that can be attached to Claude Agent SDK agents to extend their capabilities.

## Plugin Structure

Each plugin is a folder containing:

```
plugin-name/
  plugin.json     # Plugin manifest (required)
  SKILL.md        # Instructions injected into agent context
  *.sh            # Shell scripts for agent tools
  src/            # Optional TypeScript/JavaScript code
```

## Plugin Manifest (plugin.json)

```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "description": "What this plugin does",
  "type": "local",
  "entrypoint": "SKILL.md",
  "scripts": ["script1.sh", "script2.sh"]
}
```

## Available Plugins

Plugins are organized by runtime in the `claude-code/` subdirectory:

### id-rest-ap

**Path:** `plugins/claude-code/id-rest-ap`

ID implementation of the REST-AP protocol for inter-agent communication.

**Features:**
- List available agents (`list-agents.sh`)
- Send messages to agents (`talk-to-agent.sh`)
- Broadcast to multiple agents (`broadcast-to-agents.sh`)
- Wait for responses (`wait-for-response.sh`)
- Pay agents for services (`pay-agent.sh`)

### js-static-analysis

**Path:** `plugins/claude-code/js-static-analysis`

JavaScript static analysis skills for memory optimization, performance profiling, and low-level debugging.

**Features:**
- Memory leak detection
- Performance profiling guidance
- V8 debugging techniques

### frontend-design

**Path:** `plugins/claude-code/frontend-design`

Frontend design skills for creating UI components, layouts, and visual designs.

**Features:**
- UI component design patterns
- Layout and spacing guidance
- Visual design best practices

## Default Configuration

Default plugins are defined in `configs/default.yaml`:

```yaml
version: "1"
defaults:
  model: claude-haiku-4-5-20251001
  plugins:
    - name: id-rest-ap
      path: /app/plugins/id-rest-ap
```

This configuration is loaded automatically when the agent manager starts. All agents spawned via `/spawn` will receive these default plugins unless overridden.

## Using Plugins

### Default Plugins

Plugins listed in `configs/default.yaml` are automatically included for all agents. The out-of-the-box default includes `id-rest-ap`.

### Customizing Defaults

To change the default plugins for all agents, edit `configs/default.yaml`:

```yaml
version: "1"
defaults:
  model: claude-haiku-4-5-20251001
  plugins:
    - name: id-rest-ap
      path: /app/plugins/id-rest-ap
    - name: my-custom-plugin
      path: /app/plugins/my-custom-plugin
```

### Per-Agent Plugins

#### In YAML Config Files

```yaml
agents:
  - name: my-agent
    plugins:
      - name: my-custom-plugin
        path: plugins/my-custom-plugin
```

#### Via CLI

```bash
/spawn my-agent haiku plugins/my-custom-plugin
```

#### Via API

```json
POST /agents/spawn
{
  "name": "my-agent",
  "plugins": [
    { "name": "my-custom-plugin", "path": "plugins/my-custom-plugin" }
  ]
}
```

Note: Default plugins from `configs/default.yaml` are automatically merged with any agent-specific plugins (agent plugins take precedence for same name).

## Plugin Ownership Model

When an agent is spawned, plugins are **copied** to the agent's working directory:

```
/workspace/agents/<agent-id>/plugins/
  id-rest-ap/
  my-custom-plugin/
```

**Key behaviors:**

1. **Agents own their plugins** - After spawn, each agent has its own copy of the plugin files
2. **Agents can customize** - An agent can modify its own plugin files (scripts, SKILL.md) without affecting other agents
3. **Rebuild preserves changes** - `/agents rebuild` uses the agent's existing plugins, preserving any customizations
4. **Reset wipes everything** - `/agents reset` deletes entire agent directories and rebuilds from config (destructive!)

### Complete Reset

To completely refresh all agents with a clean state:

```bash
# Reset using default config
/agents reset

# Reset using a specific config
/agents reset configs/my-config.yaml
```

**⚠️ WARNING: This is a destructive operation!**

This will:
1. Stop all agent containers
2. **Delete entire agent working directories** (all files, not just plugins)
3. Create fresh directories with plugins from config
4. Restart agents with clean state

Only the agent's identity (id, name, wallet address) and database record are preserved. All files, customizations, and session data are wiped.

## Creating a New Plugin

1. Create a new folder under `plugins/claude-code/` (or appropriate runtime directory)
2. Add a `plugin.json` manifest
3. Create a `SKILL.md` with instructions for the agent
4. Add any shell scripts or code the agent needs
5. Reference the plugin in your config file

Example plugin structure:
```
plugins/claude-code/my-plugin/
├── plugin.json
├── SKILL.md
└── my-script.sh
```

The plugin will be available at `/app/plugins/my-plugin` inside agent containers.
