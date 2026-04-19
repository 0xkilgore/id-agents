---
title: ID Agents Architecture
---

# ID Agents Architecture

ID Agents is organised around a single manager daemon and a small fleet of agent processes. Every component speaks the same HTTP protocol, REST-AP, so the manager, the agents, and external admin tools interact through the same endpoints rather than through in-memory function calls.

## The manager daemon

The manager runs as a long-lived Node.js process on port **4100**. It owns the source of truth for the team: the list of agents, their ports, their configs, their inboxes, the shared task queue, the calendar, and the news stream. It stores everything in SQLite so that a restart does not lose state. The manager mints query IDs for dispatched work, sweeps stale queries, and exposes endpoints like `GET /agents`, `POST /tasks`, `GET /query/:id`, and `POST /talk-to-manager` to callers.

## The interactive CLI

A separate interactive CLI listens on port **4000**. It is the human surface — the thing you type commands into — and it forwards commands to the manager daemon on 4100 via a `/remote` endpoint. The split matters: dispatch goes through 4000, polling and admin queries go through 4100. When no human is at the keyboard the CLI may be stopped and the daemon on 4100 keeps running on its own.

## Agent processes

Each agent runs as its own operating-system process starting at port **4101** and counting up (4102, 4103, …). Under the hood each process wraps a Claude Code CLI or an OpenAI Codex session. The agent exposes the same REST-AP endpoints as the manager: `/.well-known/restap.json` for its catalogue, `/talk` for synchronous questions, `/news` for the passive feed, `/schedule` for scheduled wake-ups. Its working directory, system prompt, model, and permission settings come from the team's YAML config.

## Workspaces and persistence

Each agent owns a directory under `workspace/teams/<team>/<agent>/`. Files it writes, its heartbeat record, and its session state all live there. The manager's SQLite database stores messages, tasks, news items, and scheduled events outside of those per-agent directories so that a corrupted workspace does not take down the team-wide history.

## Message flow

A typical conversation looks like this: you type a command in the CLI on port 4000, the CLI relays it through `POST /remote` to the manager on 4100, the manager looks up the target agent and forwards the message to that agent's `/talk` endpoint on its own port, the agent processes the message with its language model, writes a reply back to the manager as a `/news` event, and the CLI picks up the reply either synchronously (via a query ID) or by polling the news feed.

## REST-AP protocol

REST-AP is a lightweight convention rather than a heavyweight framework: agents advertise their capabilities at `/.well-known/restap.json`, messages ride over HTTP JSON, and `/talk-to`, `/news-to`, and `/schedule` all share the same shape across manager and agents. The uniformity is what lets a new agent — or an external service like this public agent — join the conversation without custom integration code.

## HTTP stack

The manager daemon and each internal agent's REST-AP server are **Express 5** applications running on Node.js, written in TypeScript. The manager owns its SQLite database (history, tasks, news, scheduled events) and exposes the same HTTP JSON surface as any agent.

The **public-agent** — the DMZ-facing service that answers outside callers — runs on **Hono 4**, also Node.js/TypeScript. Hono was chosen for its smaller surface area and faster cold-start when serving untrusted traffic. Despite the different frameworks the public-agent speaks the same REST-AP protocol over HTTP JSON, so from an external caller's point of view it is indistinguishable from any other ID Agents endpoint.

Storage: SQLite for the manager (history, tasks, news, scheduled events); per-agent workspaces for files; no database inside the public-agent itself — it is a read-through proxy with its own knowledge base and inbox stored as flat JSON files on disk.

---
Keywords: architecture, design, components, structure, ports, manager, daemon, sqlite, rest-ap, protocol, workspace, process, how it works, express, hono, framework, web server, http, node, typescript, dependencies, stack
