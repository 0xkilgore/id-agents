# ID Agents Documentation

**Version 0.1.0-beta**

This folder contains longer-form documentation for the ID Agents system.

## Guides

- [Interactive Agent Guide](./guides/interactive-agent.md) - Run the interactive CLI as a human-in-the-loop agent

## Protocols

- [REST-AP Protocol](./protocol/rest-ap.md) - REST Agent Protocol specification for agent communication

## Reference

- [API Key Authentication](./reference/api-keys.md) - Client authentication and key management
- [Configuration](./reference/configuration.md) - YAML configuration file reference
- [Database Schema](./reference/database.md) - PostgreSQL database tables and schema
- [Agent Harnesses](./reference/harnesses.md) - LLM runtime backends
- [ID Indexer API](./reference/id-indexer-api.md) - ID Indexer API reference (separate service)

## ERC Drafts

- [Human Readable Token Identifiers](./erc-draft-agent-identifiers.md) - EIP draft for onchain agent identifiers

## Deployment

- [Hetzner Cloud Guide](./deployment/hetzner.md) - Cloud deployment with Docker orchestrator and external DB

## Skills

Skills documentation is maintained in the [skills/](../skills/) directory:

- [Skills Overview](../skills/README.md) - Available skills and usage guide
- [Inter-Agent Communication](../skills/inter-agent-communication/SKILL.md) - Agent-to-agent messaging
- [Admin Control](../skills/admin-control/SKILL.md) - Remote CLI management
- [REST-AP Client](../skills/restap-client/SKILL.md) - Shell scripts for testing REST-AP agents

## Plugins

Plugin documentation is maintained in the [plugins/](../plugins/) directory:

- [Plugins Overview](../plugins/README.md) - Plugin system and configuration

