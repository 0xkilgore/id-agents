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
- **Juno runtime** — one Node process per agent, swap the AI harness (Claude Code CLI, Codex, Claude Agent SDK, or a remote public-agent endpoint) underneath without changing the agent's name or port.

The manager daemon and internal agents are Node.js/TypeScript HTTP services built on Express 5; the public-agent DMZ is built on Hono 4 — both serve the same REST-AP protocol.

## Juno vs. id-agents

**Juno** is the name of id-agents' agent-side runtime — the Node.js REST-AP wrapper process that hosts one AI coding assistant and exposes it on the network. Each Juno agent is one OS process with a name, a workspace, a system prompt, a persistent mailbox, and a harness underneath. The framework is called **id-agents**; **Juno** is specifically the thing each individual agent *is*. The manager daemon is not Juno — Juno only refers to the agent runtime.

## Elevator pitch

One command, one config file, a persistent team of AI agents that talk to each other, remember what they were doing, and keep working while you sleep.

---
Keywords: overview, about, what is, introduction, summary, elevator pitch, id agents, framework, intro, express, hono, web server, http, node, typescript, dependencies, stack, juno, juno runtime, agent runtime, runtime name
