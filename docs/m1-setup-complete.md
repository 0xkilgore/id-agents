# M1 ID Agents Node — Setup Complete (2026-04-14)

## Network Access

| What | URL |
|------|-----|
| Manager health | `http://tsharkz.local:4100/health` |
| List agents | `http://tsharkz.local:4100/agents` (header: `X-Id-Team: default`) |
| Send command | `POST http://tsharkz.local:4100/remote` |
| M1 agent direct | `http://tsharkz.local:4101` |

**Hostname**: `tsharkz.local` (Bonjour), NOT `kilgore-m1.local`
**Username**: `chrispowers` (NOT kilgore — that's the M4)

## Running Services

### ID Agents
- **Manager**: port 4100, bound to `0.0.0.0` (network-accessible)
- **m1 agent**: port 4101, model `claude-sonnet-4-6`, working dir `/Users/chrispowers/Dropbox/Code/cane`

### Launchd Services

| Service | Plist | Schedule | Logs |
|---------|-------|----------|------|
| Cane email poller | com.kilgore.cane-poller | Always on (KeepAlive) | /tmp/cane-poller.err |
| Morning digest | com.kilgore.morning-digest | M-F 7:15 AM | /tmp/morning-digest.log, .err |
| Task digest | com.kilgore.taskview | Daily 6:30 AM | /tmp/taskview-digest.log, .err |
| Fantasy scout | com.kilgore.fantasy-scout | Sat 11:00 AM | /tmp/fantasy-scout.log, .err |

Otto poller is retired and removed.

## Talking to the M1 from the M4

### Health check
```bash
curl -s http://tsharkz.local:4100/health
```

### List agents
```bash
curl -s http://tsharkz.local:4100/agents -H "X-Id-Team: default"
```

### Ask the m1 agent to do something
```bash
curl -s -X POST http://tsharkz.local:4100/remote \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: default" \
  -d '{"command":"/ask m1 Check all launchd services and report status"}'
```

### Example: full health check
```bash
curl -s -X POST http://tsharkz.local:4100/remote \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: default" \
  -d '{"command":"/ask m1 Run a health check. Run launchctl list | grep kilgore. Tail the last 10 lines of /tmp/cane-poller.err and /tmp/morning-digest.log. Check disk space with df -h /. Report what is running and flag any errors."}'
```

## Key Paths on M1

| What | M1 Path |
|------|---------|
| Taskview / Cane code | ~/Dropbox/Code/cane/taskview/ |
| ID Agents | ~/Dropbox/Code/cane/id-agents/ |
| M1 team config | ~/Dropbox/Code/cane/id-agents/configs/m1-team.yaml |
| LaunchAgents | ~/Library/LaunchAgents/com.kilgore.*.plist |
| Python | /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 |
| Poller script | ~/Dropbox/Code/cane/taskview/otto_poller.py |
| Morning digest | ~/Dropbox/Code/cane/taskview/morning_digest.py |
| Env files | ~/Dropbox/Code/cane/taskview/.env, .env.cane, .env.otto |
| Digest queue | ~/Dropbox/Code/cane/taskview/digest-queue/ |
| M1 agent log | /tmp/m1.log |

## Code Changes Made

### `ID_MANAGER_HOST` env var (new)
Added to `agent-manager-db.ts` and `claude-agent-server.ts`. Set `ID_MANAGER_HOST=0.0.0.0` to bind to all interfaces (required for M4 access). Defaults to `127.0.0.1` if not set.

### Manager startup command
```bash
cd ~/Dropbox/Code/cane/id-agents
ID_MANAGER_HOST=0.0.0.0 \
AGENT_MANAGER_WORKDIR=/Users/chrispowers/Dropbox/Code/cane/id-agents/workspace \
ID_USE_MAX_PLAN=true \
ID_HARNESS=claude-code-cli \
node dist/start-agent-manager.js
```

## Known Issues

1. **Manager process is not persistent** — runs in foreground, won't survive reboot. Needs a launchd plist to auto-start.
2. **Gmail SMTP credentials expired** — `taskview.py digest` email send fails. App password in `.env` needs regenerating.
3. **Telegram 409 conflicts** — intermittent, caused by another bot instance polling the same token from M4 or VPS.
4. **Dropbox path note** — `~/Dropbox/` is a symlink to `~/Library/CloudStorage/Dropbox/`. Both resolve to the same files. Plists use the short form.
