# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta] - 2025-01-18

### Added

- **Core Platform**
  - Multi-agent orchestration with local processes
  - PostgreSQL-backed agent registry
  - REST-AP protocol for agent communication
  - Interactive CLI for agent management

- **Agent Runtimes**
  - Claude Agent SDK harness (primary runtime)
  - Claude Code CLI harness (uses Max plan subscription)

- **API Key Authentication**
  - Client key issuance with scopes and expiration
  - Hash-based key storage (secrets never stored)
  - Per-agent `requireAuth` configuration
  - `/keys`, `/keys issue`, `/keys revoke` CLI commands

- **Multi-Tenancy**
  - Team-based isolation with separate port ranges
  - Per-team workspaces and managers
  - `/team` CLI commands

- **Onchain Identity**
  - ERC-7930 registry integration
  - Agent NFT registration
  - Wallet generation per agent

- **Remote Management**
  - `/remote` endpoint for programmatic CLI access
  - Full CLI command parity via REST API

- **Skills & Plugins**
  - Inter-agent communication skill
  - Admin control skill
  - REST-AP client testing skill
  - Plugin system for Claude Code agents

- **Documentation**
  - REST-AP protocol specification
  - Configuration reference
  - API key authentication guide
  - Database schema reference
  - Deployment guides

### Security

- API key authentication system
- Environment-based secrets management
- Process isolation for agents

---

## [Unreleased]

### Planned

- Kubernetes orchestrator support
- Agent monitoring dashboard
- Enhanced inter-agent workflows
