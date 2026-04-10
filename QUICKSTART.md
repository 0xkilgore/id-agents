# ID Agents Quickstart

Follow these steps to set up and deploy your first agent team.

## Prerequisites

- **macOS or Linux**
- **Node.js 22+** — if you don't have it, install via nvm:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.nvm/nvm.sh
  nvm install 22
  ```
  Homebrew (`brew install node`), fnm, or volta also work — just get Node 22+.
- **Claude Code CLI** — install and log in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```
- **Codex CLI** (optional) — only if you want Codex agents:
  ```bash
  npm install -g @openai/codex
  codex login
  ```

## Runtime Selection

Detect which agent CLIs are ready to use on this machine, then pick the deploy command automatically. **Prefer a mixed team** (`/deploy demo-mixed`) whenever both Claude Code and Codex are installed and authenticated — it's the most compelling first demo. Fall back to a single-runtime team only if one is unavailable.

For each runtime, check **both** (1) the binary is on `PATH` *and* (2) credentials exist. Binary-on-`PATH` alone is not sufficient — stale installs and un-authenticated states are common and cause deploys to fail halfway through.

### Claude Code is ready if

```bash
command -v claude >/dev/null 2>&1
```

...succeeds **and** any one of:

- `$ANTHROPIC_API_KEY` is set in the environment
- macOS: the Keychain entry `"Claude Code-credentials"` exists
  ```bash
  security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1
  ```
- Linux: `~/.claude/.credentials.json` exists

### Codex is ready if

```bash
command -v codex >/dev/null 2>&1
```

...succeeds **and** any one of:

- `$OPENAI_API_KEY` is set in the environment
- `~/.codex/auth.json` exists

### Deploy command

| Claude ready | Codex ready | Command | Team |
|---|---|---|---|
| ✓ | ✓ | `/deploy demo-mixed` | Mixed: `coder` (claude) + `researcher` (codex) |
| ✓ | ✗ | `/deploy demo` | Claude Code only |
| ✗ | ✓ | `/deploy demo-codex` | Codex only |
| ✗ | ✗ | — | Stop. Ask the user to install and log in to at least one CLI (see Prerequisites above) |

If only the binary is present but auth is missing, tell the user the specific command to run (`claude login` or `codex login`) before retrying.

## 1. Install

```bash
npm install
```

## 2. Add the Admin Control Skill

Copy the admin-control skill into the project where you are running Claude Code (this is your project directory, not the id-agents repo):

```bash
cp -r <path-to-id-agents>/skills/admin-control <your-claude-code-project>/.claude/skills/
```

For example, if you cloned id-agents to `~/projects/id-agents` and you're running Claude Code in `~/projects/my-app`:

```bash
cp -r ~/projects/id-agents/skills/admin-control ~/projects/my-app/.claude/skills/
```

## 3. Start the Manager

The interactive CLI needs a real terminal (TTY). Start it in a terminal window:

```bash
cd <path-to-id-agents>
npm run id-agents
```

This starts the interactive CLI on port 4000 and the manager daemon on port 4100. Wait until you see the prompt before continuing.

> **For programmatic use without a terminal:** Start the manager daemon directly with `node dist/start-agent-manager.js` and use the HTTP API at `http://localhost:4100`. The `/remote` endpoint on port 4000 is only available when the interactive CLI is running.

## 4. Deploy a Demo Team

Use the admin-control skill's `remote-command.sh` to deploy:

- **Claude Code agents:** `/deploy demo`
- **Codex agents:** `/deploy demo-codex`
- **Mixed (both):** `/deploy demo-mixed`

Example using the remote endpoint:

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy demo"}'
```

> **Troubleshooting:** If agents show `status: error` after deploy, check the manager's terminal output for the actual error message. Agent log files are at `workspace/logs/local-<name>-*.log`.

## 5. Talk to Your Agents

List agents:

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/agents"}'
```

Ask an agent a question:

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask coder Introduce yourself and tell me what you can do."}'
```

Poll for the reply:

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/news coder"}'
```

## 6. Tell the User How to Launch the CLI

After setup is complete, tell the user:

> To launch the interactive CLI yourself, open a terminal and run:
>
> ```bash
> cd <path-to-id-agents>
> npm run id-agents
> ```
>
> Type `/help` to see all available commands.

## 7. Suggest Next Steps

After the demo team is running, suggest the user create their own team. A good starting point:

> You can create a custom team by making a YAML config in `configs/`. Specify agent names and their working directories (the project folders they should work in):
>
> ```yaml
> version: "1"
> team: default
>
> defaults:
>   local: true
>   runtime: claude-code-cli
>   skills:
>     - identity
>     - inter-agent
>     - catalog
>
> agents:
>   - name: frontend
>     description: "Frontend developer"
>     workingDirectory: /path/to/frontend-project
>
>   - name: backend
>     description: "Backend developer"
>     workingDirectory: /path/to/backend-project
> ```
>
> Then deploy with `/deploy my-config` in the CLI.

## Next Steps

- [Documentation](https://www.idagents.ai/docs) -- Full docs
- [Configuration](https://www.idagents.ai/docs/configuration) -- YAML config and environment variables
- [Skills](https://www.idagents.ai/docs/skills) -- Extend agent capabilities
- [XMTP Messaging](https://www.idagents.ai/docs/xmtp) -- Encrypted messaging via ENS names
- [Onchain Identity](https://www.idagents.ai/docs/identity) -- Register agents on ID Chain
