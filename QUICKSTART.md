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

## ⚠️ Permissions Notice — Read Before Deploying

ID Agents runs each agent as a background process with no interactive shell to approve tool use. The default for both runtimes is to bypass approval prompts:

- `claude-code-cli` agents launch with `--dangerously-skip-permissions`
- `codex` agents launch with `--dangerously-bypass-approvals-and-sandbox`

You can opt out by setting `dangerouslySkipPermissions: false` in the YAML config (per agent or under `defaults`), but be warned: any tool-use prompt then has no way to be approved, and the agent will hang silently on the first one. If you're not comfortable giving background agents this level of autonomy, ID Agents is not the right tool for you.

## 1. Install

```bash
npm install
```

## 2. Add the Admin Control Skill

Copy the idagents-admin-control skill into the project where you are running Claude Code (this is your project directory, not the id-agents repo):

```bash
cp -r <path-to-id-agents>/skills/idagents-admin-control <your-claude-code-project>/.claude/skills/
```

For example, if you cloned id-agents to `~/projects/id-agents` and you're running Claude Code in `~/projects/my-app`:

```bash
cp -r ~/projects/id-agents/skills/idagents-admin-control ~/projects/my-app/.claude/skills/
```

## 3. Start the Manager

```bash
cd <path-to-id-agents>
npm run id-agents
```

This starts the interactive CLI on port 4000 and the manager daemon on port 4100.

> **Running this from a Claude Code session?** Spawn the command in the background (Bash tool with `run_in_background: true`). The readline prompt sits idle with no stdin — that's fine. Ports 4000 and 4100 come up normally and every step below works unchanged. If you also want an interactive TTY, open a separate terminal window and run the command there.
>
> **Headless-only alternative:** If you don't need the CLI at all, run `node dist/start-agent-manager.js` and use port 4100. Note: `/deploy` in Step 4 goes through the CLI's `/remote` endpoint on port 4000, so you still need `npm run id-agents` running to deploy a team.

## 4. Deploy the Default Team

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy default"}'
```

`/deploy default` inspects what's installed and adapts:

- **Claude Code + Codex both ready:** deploys the full team — `coder` (Claude) and `researcher` (Codex).
- **Only Claude Code ready:** deploys `coder` only. The `researcher` entry is skipped with a console note so you know why.
- **Neither Claude Code nor Codex ready:** nothing to deploy — install and log in to at least Claude Code (see Prerequisites), then retry.

No second config name to remember. If you want to re-enable a dropped agent later, install/authenticate its runtime and run `/deploy default` again.

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

## 6. Offer to Act as the Team Manager

After deploy completes, you (Claude) are already connected to the team via `/remote` on `http://localhost:4000`. Don't hand the user off to a separate terminal — offer to continue as their team manager:

> I can act as your team manager and communicate directly to your team via /remote. Shall I ask them to say who they are?

If they accept, keep using the `/remote` endpoint to relay between the user and the team — `/agents` for a roster, `/ask <agent> <message>` to send, `/news <agent>` to poll for replies.

## 7. Suggest Next Steps

After the default team is running, suggest the user create their own team. A good starting point:

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
> Then deploy with `/deploy my-config` — either via `/remote` (with you, Claude, as the team manager) or in the interactive CLI.

## 8. Launch a User Surface (Optional)

The daemon on port 4100 runs continuously once Step 3 is up. You can drive the team through any combination of these surfaces — run any, all, or none. They're independent views over the same daemon.

### Claude Code as manager (default)

Nothing to launch. This Claude session is already connected via `/remote` on `http://localhost:4000` using the `idagents-admin-control` skill. Claude relays `/agents`, `/ask`, `/news`, `/deploy` — your whole manager experience happens in the conversation you're in right now.

### TUI dashboard

Real-time view of fleet, tasks, news, calendar, and heartbeats:

```bash
cd <path-to-id-agents>
npm run tui:dev   # source mode, auto-reload during dev
# or
npm run tui       # built mode
```

Key bindings: `a` / `t` / `c` / `h` switch views, `→` drill in, `←` back from drill-down, `q` quit. Full reference at [docs/guides/tui.md](./docs/guides/tui.md).

### Interactive CLI

Manual command entry for scripting or debugging (this is the same surface Step 3 launches):

```bash
cd <path-to-id-agents>
npm run id-agents
```

Type `/help` for commands.

## Next Steps

- [Documentation](https://www.idagents.ai/docs) -- Full docs
- [Configuration](https://www.idagents.ai/docs/configuration) -- YAML config and environment variables
- [Skills](https://www.idagents.ai/docs/skills) -- Extend agent capabilities
- [XMTP Messaging](https://www.idagents.ai/docs/xmtp) -- Encrypted messaging via ENS names
- [Onchain Identity](https://www.idagents.ai/docs/identity) -- Register agents on ID Chain
