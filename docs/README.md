# ID Agents Documentation

**Version 0.1.43-beta**

Documentation for the ID Agents multi-agent orchestration platform.

## Architecture

- [Architecture Overview](./reference/architecture.md) - How the manager, agents, and CLI work together. Start here.
- [Scheduling Plan](./SCHEDULING_PLAN.md) - Unified interval/calendar scheduling, delivery modes, and `/schedule` endpoint design
- [Modular Runtime Plan](./MODULAR_RUNTIME_PLAN.md) - Runtime registry, validation, and mixed-team launch design for Claude and Codex runtimes

## Guides

- [Interactive Agent Guide](./guides/interactive-agent.md) - Run the interactive CLI
- [Sync Command Guide](./guides/sync-command.md) - Update a running team without losing sessions (`/sync` vs `/deploy`)
- [Admin Control Guide](./guides/admin-control.md) - Programmatic team management via `/remote`, talk-to-manager, and agent reply polling

## Protocols

- [REST-AP Protocol](./protocol/rest-ap.md) - REST Agent Protocol specification for agent communication

## Reference

- [Architecture](./reference/architecture.md) - System architecture, message flow, database schema, key files
- [Configuration](./reference/configuration.md) - YAML configuration file reference
- [Database Schema](./reference/database.md) - PostgreSQL database tables and schema
- [Harnesses](./reference/harnesses.md) - LLM runtime backends (Claude Agent SDK, Claude Code CLI)
- [ID Indexer API](./reference/id-indexer-api.md) - Onchain agent registry indexer API

## Deployment

- [Hetzner Cloud Deployment](./deployment/hetzner.md) - Single VM deployment guide
- [Hetzner VPS Setup](./deployment/hetzner-setup.md) - Detailed VPS setup guide

## ERC Drafts

- [Agent Identifiers](./erc-draft-agent-identifiers.md) - EIP draft for onchain agent identifiers

## Skills

Skills are deployed to each agent's `.claude/skills/` directory at deploy time. All configs should include `skills: [identity, inter-agent, catalog]` at minimum.

- [Skills Overview](../skills/README.md) - Available skills and usage guide
- [Identity](../skills/identity/SKILL.md) - Agent name, team, onchain domain
- [Inter-Agent](../skills/inter-agent/SKILL.md) - Agent-to-agent messaging via `/talk-to`
- [Catalog](../skills/catalog/SKILL.md) - REST-AP self-description
- [Wallet](../skills/wallet/SKILL.md) - OWS wallet operations
- [Admin Control](../skills/admin-control/SKILL.md) - Remote CLI management
- [Local Agent](../skills/local-agent/SKILL.md) - Spawn Claude Code agents locally

## Plugins

- [Plugins Overview](../plugins/README.md) - Plugin system and configuration
