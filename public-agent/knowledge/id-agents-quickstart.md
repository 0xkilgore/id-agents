---
title: ID Agents Quickstart
---

# ID Agents Quickstart

Spin up a local ID Agents team in a few minutes. You need Node.js 22 or newer, the Claude Code CLI installed and authenticated, and optionally the OpenAI Codex CLI if you plan to run Codex-backed agents.

## 1. Install

Clone the repository and install dependencies:

```bash
git clone https://github.com/<your-fork>/id-agents.git
cd id-agents
npm install
```

## 2. Check your runtimes

ID Agents supports two agent runtimes: the Claude Code CLI (default) and OpenAI Codex. The helper script probes your machine and tells you which are ready:

```bash
./scripts/detect-runtimes.sh
```

Missing runtimes print a one-line install hint. Codex is optional; Claude Code is required for the default config.

## 3. Add the admin control skill (optional)

If you plan to manage the team from a Claude Code session rather than from the interactive CLI, copy the `idagents-admin-control` skill into your global Claude Code skills directory so the assistant can dispatch commands to the running manager.

## 4. Start the manager

Launch the manager daemon and the interactive CLI together:

```bash
npm run id-agents
```

This starts the daemon on port 4100 and the CLI on port 4000. The CLI prompt is where you type commands; the daemon is where agents connect.

## 5. Deploy the default team

From the CLI:

```
/deploy default
```

The default config spins up a small team — typically a manager identity plus a couple of worker agents — and writes a workspace for each one under `workspace/teams/default/`. You can inspect the running team with `/agents`, `/status`, and `/teams`. Swap in a different config with `/deploy <config>`.

## 6. Talk to agents

Send a message to a specific agent:

```
/talk-to coder Which files own login?
```

Broadcast a question to the whole team with `/ask *`, push a passive note with `/news-to`, or tail a specific agent's feed with `/news <agent>`. The CLI also exposes `/task`, `/heartbeat`, and `/calendar` for the higher-level coordination primitives.

## 7. Let Claude Code drive (optional)

If you prefer to delegate the team management to Claude Code itself, start a Claude Code session in the repo and ask it to run through `QUICKSTART.md`. With the `idagents-admin-control` skill installed, Claude Code can start the manager, deploy a team, dispatch work, and poll for replies without a human typing into the CLI.

## 8. Stop the team

`Ctrl-C` in the CLI terminal stops both the CLI and the daemon. Agents are stopped cleanly so their SQLite-backed state survives the restart. Re-run `npm run id-agents` and the team comes back exactly as it was.

## Headless use

You do not have to run the CLI at all. The manager daemon on port 4100 is self-sufficient and will continue to serve REST-AP traffic as long as it is running. The CLI is a convenience for humans, not a dependency of the fleet.

---
Keywords: setup, set up, install, installation, get started, getting started, quickstart, deploy, first time, new user, how to, how do I, onboard, bootstrap, run, start, launch
