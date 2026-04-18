---
title: ID Agents Quickstart
---

# ID Agents Quickstart

Two ways to stand up a local ID Agents team. The agent-driven method below is the recommended easiest path; the manual walkthrough after it is for operators who want to run each step themselves.

## Recommended: let Claude Code set it up (easiest)

The fastest way to start is to open any Claude Code session and paste this single prompt:

> Set up id-agents by following the QUICKSTART at https://github.com/idchain-world/id-agents/blob/main/QUICKSTART.md

Claude Code then handles the whole setup end-to-end: it clones the repo, runs the runtime-detection script and edits the default config if OpenAI Codex is present, installs the `idagents-admin-control` skill into your Claude Code project, runs `npm install`, starts the manager daemon on port 4100 and the interactive CLI on port 4000, runs `/deploy default` to bring up the team, and then offers to continue as your team manager so you can keep dispatching work through the same Claude Code session. All you need locally is Node.js 22+, an authenticated Claude Code CLI (`claude login`), and optionally the Codex CLI for mixed-runtime teams.

## Manual path

Prefer to run the steps yourself? The same result, one command at a time.

### 1. Install

```bash
git clone https://github.com/<your-fork>/id-agents.git
cd id-agents
npm install
```

### 2. Check your runtimes

```bash
./scripts/detect-runtimes.sh
```

ID Agents supports two agent runtimes: the Claude Code CLI (default) and OpenAI Codex. Missing runtimes print a one-line install hint. Codex is optional; Claude Code is required for the default config.

### 3. Start the manager

```bash
npm run id-agents
```

This starts the manager daemon on port 4100 and the interactive CLI on port 4000. The CLI prompt is where you type commands; the daemon is where agents connect.

### 4. Deploy the default team

From the CLI:

```
/deploy default
```

The default config spins up a small team under `workspace/teams/default/`. Inspect the running team with `/agents`, `/status`, and `/teams`. Swap configs with `/deploy <config>`.

### 5. Talk to agents

```
/talk-to coder Which files own login?
```

Broadcast a question with `/ask *`, push a passive note with `/news-to`, or tail a feed with `/news <agent>`. `/task`, `/heartbeat`, and `/calendar` cover the higher-level coordination primitives.

### 6. Stop the team

`Ctrl-C` in the CLI terminal stops both the CLI and the daemon. Agent state is SQLite-backed so the team comes back exactly as it was on the next `npm run id-agents`.

## Headless use

You do not have to run the CLI at all. The manager daemon on port 4100 is self-sufficient and will continue to serve REST-AP traffic as long as it is running. The CLI is a convenience for humans, not a dependency of the fleet.

---
Keywords: setup, set up, install, installation, get started, getting started, quickstart, deploy, first time, new user, how to, how do I, onboard, bootstrap, run, start, launch, easiest, easier, easiest way, automated, agent-driven, Claude Code setup, one-click, paste this prompt, let Claude do it, hands-off
