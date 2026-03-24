# Agent Skills

This directory contains skills that agents can use to enhance their capabilities.

## What are Skills?

Skills are packages of instructions and executable scripts that agents can reference to perform specialized tasks. They follow the [Agent Skills Open Standard](https://agentskills.io) and are compatible with Claude and other AI platforms.

## Available Skills

### inter-agent-communication

Enables agents to discover and communicate with other agents in the cluster.

**Use cases:**
- Delegate tasks to specialized agents
- Coordinate multi-agent workflows
- Get second opinions or validation
- Scale work across multiple agents

**Files:**
- `SKILL.md` - Instructions and examples
- `list-agents.sh` - List all available agents
- `talk-to-agent.sh` - Send message to an agent
- `wait-for-response.sh` - Wait for agent's response
- `broadcast-to-agents.sh` - Send message to multiple agents
- `pay-agent.sh` - Payment system integration

### admin-control

Enables Claude Code to act as an admin agent for remote management of the ID Agents manager.

**Use cases:**
- Remote control of agent cluster from Claude Code
- Execute CLI commands via API
- Monitor and manage agents programmatically
- Build automation and orchestration workflows

**Files:**
- `SKILL.md` - Instructions and examples
- `talk-to-manager.sh` - Send message to manager with reply endpoint
- `remote-command.sh` - Execute CLI commands with API key
- `start-listener.js` - Start temporary HTTP listener for replies

### local-agent

Spawn and manage local Claude Code agents using your existing authentication.

**Use cases:**
- Use your Claude Code login instead of API keys
- Debug and develop without container isolation
- Run agents with full filesystem access
- Participate in team workflows alongside containerized agents

**Files:**
- `SKILL.md` - Instructions and examples
- `spawn-local.sh` - Spawn a local agent from command line

### restap-client

A generic REST-AP client for testing and interacting with agents via the REST-AP protocol.

**Use cases:**
- Test REST-AP endpoints from the command line
- Debug agent communication issues
- Quick integration testing
- External client simulation

**Files:**
- `SKILL.md` - Instructions and examples
- `talk.sh` - Send a message to an agent
- `news.sh` - Get news/replies from an agent
- `discover.sh` - Get agent discovery document
- `listen.sh` - Start a temporary listener for replies

## Using Skills

### As an Agent

Claude agents running in this environment can access skills by:

1. **Reading the skill documentation:**
   ```bash
   cat ./skills/inter-agent-communication/SKILL.md
   ```

2. **Using the executable scripts:**
   ```bash
   cd ./skills/inter-agent-communication
   ./list-agents.sh
   ./talk-to-agent.sh "coding-agent" "Create a button"
   ```

3. **Following the instructions** to make direct REST-AP calls

### As a Developer

To add a new skill:

1. Create a new directory: `skills/your-skill-name/`
2. Add a `SKILL.md` file with:
   - Overview and purpose
   - Usage instructions
   - Examples
   - Best practices
3. (Optional) Add executable scripts
4. (Optional) Add templates, data files, or other resources

## Skill Structure

```
skills/
├── your-skill-name/
│   ├── SKILL.md                 # Main instructions (required)
│   ├── script.sh                # Executable scripts (optional)
│   ├── template.txt             # Templates (optional)
│   └── data.json                # Data files (optional)
```

## Standard Skill Format

Each `SKILL.md` should include:

1. **# Skill Name** - Clear, descriptive title
2. **## Overview** - What the skill does
3. **## Available Operations** - What actions are possible
4. **## Usage Examples** - Concrete examples
5. **## When to Use** - Guidance on when to apply the skill
6. **## Best Practices** - Tips for effective use
7. **## Important Notes** - Warnings, limitations, considerations

## Future Skills

Ideas for additional skills:

- **file-sharing** - Share files between agents via workspace
- **task-coordination** - Coordinate complex multi-agent tasks
- **result-aggregation** - Combine results from multiple agents
- **agent-monitoring** - Monitor health and progress of agents
- **resource-management** - Manage CPU/memory/cost across agents

## Contributing

To contribute a skill:

1. Follow the standard skill format
2. Test the skill with real agents
3. Document all edge cases
4. Include clear examples
5. Submit via pull request

## Resources

- [Agent Skills Specification](https://agentskills.io)
- [Claude Skills Documentation](https://support.claude.com/en/articles/12512176-what-are-skills)
- [REST-AP Protocol](../docs/protocol/rest-ap.md)
