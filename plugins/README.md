# ID Agent Plugins

This folder contains optional plugins that can be attached to agents to extend their capabilities.

## Plugin Structure

Each plugin is a folder containing:

```
plugin-name/
  plugin.json     # Plugin manifest (required)
  SKILL.md        # Instructions injected into agent context
  *.sh            # Shell scripts for agent tools
  src/            # Optional TypeScript/JavaScript code
```

## Available Plugins

### js-static-analysis

**Path:** `plugins/claude-code/js-static-analysis`

JavaScript static analysis skills for memory optimization, performance profiling, and low-level debugging.

### frontend-design

**Path:** `plugins/claude-code/frontend-design`

Frontend design skills for creating UI components, layouts, and visual designs.

**Note:** Inter-agent communication is handled by **skills** (deployed to `.claude/skills/`), not plugins. The old `id-rest-ap` plugin is no longer used. See `skills/README.md`.

## Using Plugins

### In YAML Config Files

```yaml
defaults:
  plugins:
    - name: js-static-analysis
      path: ../plugins/claude-code/js-static-analysis
```

### Per-Agent

```yaml
agents:
  - name: my-agent
    plugins:
      - name: frontend-design
        path: ../plugins/claude-code/frontend-design
```

## Plugin Ownership Model

When an agent is spawned, plugins are **copied** to the agent's working directory. Agents own their copies and can customize them without affecting other agents.

## Creating a New Plugin

1. Create a folder under `plugins/claude-code/`
2. Add a `plugin.json` manifest
3. Create a `SKILL.md` with instructions for the agent
4. Add any shell scripts or code the agent needs
5. Reference the plugin in your config file
