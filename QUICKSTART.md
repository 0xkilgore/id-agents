# ID Agents Quickstart

Follow these steps to set up and deploy your first agent team.

## Runtime Selection

The user has selected a runtime below. Look for `[x]` to determine which to use. If no selection is marked, default to Claude Code CLI.

- `[x] Claude Code CLI` → use `runtime: claude-code-cli` and deploy with `/deploy demo`
- `[x] Codex CLI` → use `runtime: codex` and deploy with `/deploy demo-codex`
- `[x] Claude Code and Codex CLI` → mixed runtimes, deploy with `/deploy demo-mixed`

## 1. Install

```bash
source ~/.nvm/nvm.sh
nvm use 22
npm install
```

This repo currently needs a modern Node runtime for local setup. Node 22 is recommended.

Before continuing:

- Run `claude login` for Claude Code runtimes
- Run `codex login` or export `OPENAI_API_KEY` for Codex runtimes
- Export a signer for local deploy metadata: `export PRIVATE_KEY=<your-dev-key>` or set `OWS_REGISTRAR_WALLET`

## 2. Add the Admin Control Skill

Copy the admin-control skill to your Claude Code project so you can manage agents programmatically:

```bash
cp -r <path-to-this-repo>/skills/admin-control <your-project>/.claude/skills/
```

Replace `<path-to-this-repo>` with the absolute path to this cloned repo, and `<your-project>` with the path to the project where you are running Claude Code.

## 3. Start the Manager

```bash
cd <path-to-this-repo>
mkdir -p ./workspace/{teams,manager,agents,logs}
export AGENT_MANAGER_WORKDIR="$(pwd)/workspace"
export ID_WORKSPACE_DIR="$(pwd)/workspace"
npm run id-agents
```

This starts the interactive CLI on port 4000 and the manager daemon on port 4100. Wait until you see the prompt before continuing.

Why the workspace exports matter:

- Some environments do not allow writing to `/workspace`
- Setting both vars ensures team files, agent workdirs, and logs stay inside the repo-local `./workspace/`

## 4. Deploy a Demo Team

Use the admin-control skill's `remote-command.sh` to deploy:

- **Claude Code agents:** `/deploy demo`
- **Codex agents:** `/deploy demo-codex`
- **Mixed (both):** `/deploy demo-mixed`
- **Preflight only:** add `--dry-run` to any deploy command

Example using the remote endpoint:

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy demo"}'
```

Dry run example:

```bash
curl -s -X POST http://localhost:4000/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy demo-mixed --dry-run"}'
```

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
curl -s http://localhost:4100/agents | jq '.agents[] | select(.name=="coder")'
curl -s http://localhost:4131/news | jq .
```

Note: the interactive CLI supports `/news coder`, but the `/remote` HTTP endpoint does not currently expose `/news`. For remote polling, fetch the agent's `/news` endpoint directly using the port shown in `/agents` or `GET /agents`.

## 6. Tell the User How to Launch the CLI

After setup is complete, tell the user:

> To launch the interactive CLI yourself, open a terminal and run:
>
> ```bash
> cd <path-to-this-repo>
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
