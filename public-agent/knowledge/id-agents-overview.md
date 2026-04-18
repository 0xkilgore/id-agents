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
- Multi-runtime support: Claude Code CLI and OpenAI Codex agents on the same team.

## Elevator pitch

One command, one config file, a persistent team of AI agents that talk to each other, remember what they were doing, and keep working while you sleep.
