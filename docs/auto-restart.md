# id-agents auto-restart (Spec 056)

The id-agents manager is run under launchd as a user LaunchAgent so it boots on
login and self-heals on crash. Owned by Cane (infra agent).

## Files

- Plist: `~/Library/LaunchAgents/com.kilgore.id-agents-manager.plist`
- Wrapper: `~/Dropbox/Code/cane/id-agents/scripts/start-id-agents-manager.sh`
- Smoke test: `~/Dropbox/Code/cane/id-agents/scripts/smoke-id-agents-restart.sh`
- Logs: `/tmp/id-agents-manager.log`, `/tmp/id-agents-manager.err`

## Install

```bash
# (one-time) make scripts executable if cloning fresh
chmod +x ~/Dropbox/Code/cane/id-agents/scripts/start-id-agents-manager.sh
chmod +x ~/Dropbox/Code/cane/id-agents/scripts/smoke-id-agents-restart.sh

# stop any manual manager first
pkill -f "local-agent-server.js" || true
pkill -f "start-agent-manager.js" || true
sleep 3

launchctl load ~/Library/LaunchAgents/com.kilgore.id-agents-manager.plist
~/Dropbox/Code/cane/id-agents/scripts/smoke-id-agents-restart.sh
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.kilgore.id-agents-manager.plist
# optional: remove the plist if you want it gone permanently
rm ~/Library/LaunchAgents/com.kilgore.id-agents-manager.plist
```

## Reload after editing the plist or wrapper

```bash
launchctl unload ~/Library/LaunchAgents/com.kilgore.id-agents-manager.plist
launchctl load   ~/Library/LaunchAgents/com.kilgore.id-agents-manager.plist
~/Dropbox/Code/cane/id-agents/scripts/smoke-id-agents-restart.sh
```

## Troubleshooting

| Symptom | First check |
|---|---|
| `launchctl list \| grep id-agents-manager` shows non-zero exit | `tail /tmp/id-agents-manager.err` — usually missing PATH/node, or wrapper script not executable |
| `/health` never comes up | Is `dist/start-agent-manager.js` present? Run `ls -la ~/Dropbox/Code/cane/id-agents/dist/start-agent-manager.js`. If missing, the package needs `npm run build` |
| `/talk` returns 401 | The OAuth gotcha. Run `ps eww -p $(pgrep -f start-agent-manager.js)` and grep for `CLAUDE_CODE_OAUTH_TOKEN`. If present, the wrapper unset block is broken or `launchctl setenv` injected it — `launchctl getenv CLAUDE_CODE_OAUTH_TOKEN` |
| Agents never come online | `tail /tmp/id-agents-manager.log` — look for the `deploy response:` line. If it errored, manually `curl -X POST http://localhost:4100/remote -H 'Content-Type: application/json' -d '{"command":"/sync kilgore-team"}'` |
| KeepAlive not respawning | `ThrottleInterval` is 30s, so a clean kill takes ~30–90s to recover. If it's still down after 2 minutes, `launchctl list` to confirm the agent is loaded; if not, `launchctl load` it |

## Background

Pre-spec, the manager went offline silently when its parent shell exited (e.g. when Chris closed a terminal or a Claude Code session ended). Recovery required a manual `pkill` + `env -u` ritual (see SETUP_LOG.md). Spec 056 captures that ritual into a launchd-supervised wrapper so the failure mode becomes self-healing.
