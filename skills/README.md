# Agent Skills

This directory contains skills that agents can use to enhance their capabilities.

## What are Skills?

Skills are packages of instructions and executable scripts that agents can reference to perform specialized tasks. They follow the [Agent Skills Open Standard](https://agentskills.io) and are compatible with Claude and other AI platforms.

## Available Skills

### identity

Injected automatically — tells each agent its name, team, and onchain identity.

- `SKILL.md` - Frontmatter skill (auto-loaded)

### inter-agent

Enables agents to send messages and delegate tasks to other agents via the manager API.

- `SKILL.md` - Frontmatter skill with usage examples

### wallet

OWS wallet operations — view addresses, sign messages/transactions, check balances.

- `SKILL.md` - Frontmatter skill with command examples

### catalog

Lets agents update their own catalog entry (role, expertise, status) visible to the team.

- `SKILL.md` - Frontmatter skill

### admin-control

Enables Claude Code to act as an admin agent for remote management of the team. Includes patterns for sending commands, chatting with the manager, and polling for multi-agent replies.

- `SKILL.md` - Instructions and polling patterns
- `talk-to-manager.sh` - Send message to manager with reply endpoint
- `remote-command.sh` - Execute CLI commands on the manager
- `start-listener.js` - Start temporary HTTP listener for replies
- `admin-session.js` - Interactive admin session

### local-agent

Spawn Claude Code agents locally (no Docker) using your existing Claude Code authentication.

- `SKILL.md` - Instructions and examples
- `spawn-local.sh` - Spawn a local agent from the command line

## Using Skills

### As an Agent

Claude agents running in this environment can access skills by:

1. **Reading the skill documentation:**
   ```bash
   cat ./skills/inter-agent/SKILL.md
   ```

2. **Using the executable scripts:**
   ```bash
   cd ./skills/admin-control
   ./remote-command.sh "/agents"
   ```

3. **Following the instructions** to make direct API calls

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

## Resources

- [Agent Skills Specification](https://agentskills.io)
- [Claude Skills Documentation](https://support.claude.com/en/articles/12512176-what-are-skills)
