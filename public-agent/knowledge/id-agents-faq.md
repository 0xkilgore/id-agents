---
title: ID Agents FAQ
---

# ID Agents FAQ

Short answers to the questions new users ask most often about ID Agents.

## What is the difference between `/talk` and `/talk-to`?

`/talk` is the HTTP endpoint on an agent or on the manager — it is what an incoming caller hits to deliver a message. `/talk-to` is the **command** a sender uses to dispatch a message to another agent. You type `/talk-to coder ...` in the CLI (or call the `/talk-to` helper in an agent wrapper script), and under the hood that call resolves the target agent in the manager catalogue and POSTs to the target's `/talk` endpoint. In short: `/talk-to` is the verb you type; `/talk` is the door the message arrives at.

## Why do some things use port 4100 and others use port 4000?

The manager daemon runs on **port 4100**. The interactive CLI runs on **port 4000**. They are two different processes with two different jobs.

- Port 4000 (CLI) accepts `POST /remote` calls so external tools — including the admin-control skill — can dispatch commands as if a human were typing them.
- Port 4100 (daemon) owns the state: `GET /agents`, `GET /query/:id`, `POST /tasks`, `POST /talk-to-manager`, and everything else that needs to survive the CLI being closed.

Polling for agent replies, listing tasks, and any admin query goes to 4100. Dispatch goes to 4000. If you call `GET /query/:id` on port 4000 you will get a 404 — the CLI does not implement that endpoint. A common troubleshooting step is checking whether `localhost` resolved to IPv6 (`::1`) while the daemon bound to IPv4 — use `127.0.0.1` explicitly to avoid the collision.

## How do I add a new agent to an existing team?

Agents are declared in the team's YAML config file under `configs/`. Add a new entry with a `name`, a `role` (the system prompt), a `workingDirectory`, and optionally a `model` and a `runtime` (either `claude-code-cli` or `codex`). Then run `/sync` from the CLI — this is the reconciliation command that compares the config to the running fleet and spawns any missing agents, rebuilds any that have drifted, and stops any that have been removed from the config. `/sync` is the safe, idempotent way to edit a team; prefer it over manual `/spawn` + `/delete` pairs.

## Can I run ID Agents without the interactive CLI?

Yes. The manager daemon on port 4100 is the real engine — the CLI is just a human convenience on top. You can drive the daemon from a Claude Code session via the `idagents-admin-control` skill, which dispatches `/remote` commands, polls `/query/:id`, and listens for replies on a temporary HTTP endpoint. You can also write your own scripts against the REST-AP protocol: every endpoint is documented at `/.well-known/restap.json` on each running agent and on the manager itself.

## What is a "task" in ID Agents?

A task is a tracked unit of work with a title, an owner, a status, and a terminal state. Agents create tasks with `POST /tasks`, claim them with `/tasks/<name>/claim`, do the work, and mark them done with `/tasks/<name>/done`. The convention is that every non-trivial unit of work goes through the task lifecycle so that a verifier walking the task stream can see every action the team has taken and what the outcome was. Tasks are stored in the manager's SQLite database and carry short UUIDs (`#ae8c9bdf`) that are unambiguous even when names repeat across teams.

## What are heartbeats and calendars?

Both are scheduling primitives owned by the manager.

- A **heartbeat** is a periodic wake-up for an agent on a fixed interval. The agent receives a scheduled `/talk` or `/schedule` call and decides what, if anything, to do. Heartbeats are defined per-agent in `configs/heartbeat-<name>.yaml`.
- A **calendar** is a team-wide list of scheduled events with explicit fire times. Good for one-off deadlines, periodic reviews, or anything where the trigger is a specific moment rather than a fixed cadence.

Both route through the same `/schedule` endpoint on the target agent, and scheduled work arrives with an identifying `schedule` object so the agent can tell a wake-up apart from a normal user message.

## Does every agent need a task before it can act?

Non-trivial work must be a task. Single-line answers, greetings, simple look-ups, and work that is already part of an existing claimed task do not need a new task record. The discipline exists so that auditors and other agents can reconstruct what the team did and why — it is not a universal "every HTTP call is a task" rule.

## Which agent runtimes/harnesses are supported?

ID Agents currently supports two agent runtimes:

- **Claude Code CLI** — the default, required baseline.
- **OpenAI Codex** — optional, detected automatically when installed.

The following alternatives are **not supported**: OpenCode, OpenClaw, Cursor, Aider, Cody, Continue.dev, Roo Code, Cline, Warp AI, Windsurf, Zed AI, Goose, and any other CLI or IDE agent not listed as supported above. Adding support for another runtime requires implementing a new harness in `src/harness/` that matches the contract of the existing ones.

---
Keywords: faq, common questions, troubleshooting, problems, issues, help, questions, q&a, headless, port, tasks, team, heartbeat, calendar, difference, compare, opencode, openclaw, cursor, aider, cody, continue.dev, roo code, cline, warp, windsurf, zed ai, goose, harnesses, runtimes, supported, unsupported, compatibility, alternatives
