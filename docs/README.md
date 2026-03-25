# ID Agents Documentation

**Version 0.1.7-beta**

Documentation for the ID Agents multi-agent orchestration platform.

## Architecture

- [Architecture Overview](./reference/architecture.md) - How the manager, agents, and CLI work together. Start here.

## Guides

- [Interactive Agent Guide](./guides/interactive-agent.md) - Run the interactive CLI

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

Skills extend agent capabilities:

- [Skills Overview](../skills/README.md) - Available skills and usage guide
- [Inter-Agent Communication](../skills/inter-agent-communication/SKILL.md) - Agent-to-agent messaging
- [Admin Control](../skills/admin-control/SKILL.md) - Remote CLI management
- [Polling](../skills/polling/SKILL.md) - Async reply monitoring patterns

## Plugins

- [Plugins Overview](../plugins/README.md) - Plugin system and configuration
