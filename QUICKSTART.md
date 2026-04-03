# ID Agents Quickstart

Follow these steps to set up and deploy your first agent team.

## 1. Install

```bash
npm install
```

## 2. Add the Admin Control Skill

Copy the admin-control skill to your Claude Code project so you can manage agents programmatically:

```bash
cp -r <path-to-this-repo>/skills/admin-control <your-project>/.claude/skills/
```

Replace `<path-to-this-repo>` with the absolute path to this cloned repo, and `<your-project>` with the path to the project where you are running Claude Code.

## 3. Start the Manager

```bash
cd <path-to-this-repo>
npm run id-agents
```

This starts the interactive CLI on port 4000 and the manager daemon on port 4100. Wait until you see the prompt before continuing.

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

## 6. Use the CLI Directly

For a richer experience, use the interactive CLI directly in your terminal:

```bash
cd <path-to-this-repo>
npm run id-agents
```

Then type commands like:

```
/agents
/ask coder What can you help me with?
/ask researcher Find best practices for TypeScript project structure
/news coder
```

## Next Steps

- [Documentation](https://www.idagents.ai/docs) -- Full docs
- [Configuration](https://www.idagents.ai/docs/configuration) -- YAML config and environment variables
- [Skills](https://www.idagents.ai/docs/skills) -- Extend agent capabilities
- [XMTP Messaging](https://www.idagents.ai/docs/xmtp) -- Encrypted messaging via ENS names
- [Onchain Identity](https://www.idagents.ai/docs/identity) -- Register agents on ID Chain
