---
title: ID Agents Overview
---

# ID Agents Overview

ID Agents is an open-source framework for running a team of long-lived Claude Code and Codex agents as a coordinated fleet on your own machine. Each agent is its own process with a name, a workspace, a system prompt, and a persistent mailbox. A single manager daemon keeps the roster, routes messages between agents, stores history in SQLite, and enforces a shared protocol called REST-AP so that every agent is reachable via a small set of HTTP endpoints.

## What it solves

Most coding agents today live and die inside one terminal session. ID Agents gives you the opposite: agents that stick around, listen for messages, speak to each other, run on heartbeats and calendars, and can be deployed, swapped, or retired from a single config file. You can ask one agent a question and have it delegate to another without losing context, or let several agents run in parallel while you watch their output streams.

## Key features

- Multi-agent teams deployed from a single YAML config.
- REST-AP protocol — every agent speaks the same HTTP vocabulary.
- Local-first: everything runs on your machine, no cloud required.
- Scheduling via heartbeats and a shared calendar so agents can wake themselves up.
- Task discipline — every non-trivial unit of work is a tracked task with a terminal state.
- Multi-runtime support: internal agents run Claude Code CLI, OpenAI Codex, or the Claude Agent SDK directly.
- **Juno** — a separate, public-facing runtime for DMZ agents that talk to end users outside the trusted mesh. Capability-limited by design (guard classifier, KB-only tools, rate limits, token budget).

The manager daemon and internal agents are Node.js/TypeScript HTTP services built on Express 5; the public-agent DMZ runtime (Juno) is built on Hono 4 — both serve the same REST-AP protocol.

## What is Juno?

**Juno** is id-agents' public-facing agent runtime — a Hono-based Node process designed for agents that talk to end users outside the trusted mesh. It is the only runtime id-agents ships that is safe to point at the public internet. Juno bakes in:

- A **guard classifier** that runs on every turn before the main model call.
- A **bounded tool set** — only `search_knowledge` and `read_knowledge`. No shell, no filesystem, no outbound HTTP except the OpenRouter inference call.
- **Per-IP rate limits** and a **daily token budget**.
- **Fail-closed operator endpoints** (`/inbox`, `/news`, `/mcp`) reachable only over an SSH tunnel with `PUBLIC_AGENT_AUTH_KEY`.

Internal / private agents do **not** run Juno. They use a `claude-code-cli`, `codex`, or `claude-agent-sdk` harness directly, with full shell and filesystem access — fine for a trusted local team, unsafe to expose publicly. Juno is specifically the runtime that fills the public / DMZ boundary. Juno is not the manager daemon, and it is not "the agent-side runtime" in general — it is the public runtime.

## Elevator pitch

One command, one config file, a persistent team of AI agents that talk to each other, remember what they were doing, and keep working while you sleep.

---
Keywords: overview, about, what is, introduction, summary, elevator pitch, id agents, framework, intro, express, hono, web server, http, node, typescript, dependencies, stack, juno, public runtime, dmz runtime, public-facing, capability-limited, guard, budget, rate limit, public agent
