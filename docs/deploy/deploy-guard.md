# Deploy Guard — fleet freshness + HTTP liveness + post-deploy smoke + auto-rollback (T-DEPLOY.1/.5)

Automates the "merged != running" drift recovery so it stops costing manual
intervention. Three parts:

## 1. Fleet freshness alert (T-DEPLOY.1) — built into the manager

The manager runs a freshness monitor (every 60s) that tracks how long the
running build has been behind `origin/main` and alerts once it stays stale past
a threshold (default **15 min**), with bounded re-alerting and a recovery
notice when it catches up.

- Signal source: `/health.build` (`build_sha`, `origin_main_sha`,
  `behind_origin`).
- New `/health.freshness` block: `{ state, behind_origin_since, last_alert_at }`
  where `state ∈ fresh | stale | stale_alerted`.
- Alerts go to Telegram via the existing `sendTelegramAlert` (needs
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`; otherwise logged only).
- Tunable: `DEPLOY_FRESHNESS_THRESHOLD_MS` (default 900000).
- Note: `behind_origin` is computed from the local `origin/main` ref. Agent
  promotions are FF-pushes that update that ref in the shared repo, so drift is
  detected without an explicit fetch. If `origin/main` can move via an external
  push, keep a periodic `git fetch` running so the signal stays accurate.

## 2. Post-deploy smoke (T-DEPLOY.5) — `deploy-guard smoke`

Run **after** the kickstart to prove the new build is actually serving:

```bash
PID_BEFORE=$(lsof -ti tcp:4100 -sTCP:LISTEN | head -1)   # capture BEFORE kickstart
# … kickstart the manager (launchctl kickstart -k <label>) …
PID_AFTER=$(lsof -ti tcp:4100 -sTCP:LISTEN | head -1)    # after it comes back up

node dist/deploy-guard/cli.js smoke \
  --base-url http://127.0.0.1:4100 \
  --pid-before "$PID_BEFORE" --pid-after "$PID_AFTER" \
  --auto-rollback            # add --execute to actually roll back on failure
```

Smoke checks (all must pass):
- `pid_changed` — the process actually restarted.
- `build_sha_matches_origin` — running build == `origin/main`.
- `not_behind_origin` — `behind_origin === false`.
- `manager_nominal` — optional; enabled by callers that require
  `/health.nominal === true`.
- each key route returns 200 (`/health`, `/loops`, `/outputs/inbox`; override
  with `--routes a,b,c`).

On **pass**: the current `build_sha` is recorded as the last-good build at
`var/deploy-guard/last-good-build.json`. Exit 0.

On **fail**: prints the smoke failures + the rollback decision. Exit 1.

## 3. External HTTP-liveness watchdog (T-RELY)

`scripts/manager-http-liveness-watchdog.mjs` is a launchd-managed process
outside the agent fleet. It checks `GET /health` every minute with a 2s budget,
checks `/dispatches/health` only when `/health` returns quickly enough, and
treats listener PID / launchd PID as diagnostics rather than success.

Decision contract:
- `/health` success resets the HTTP failure streak.
- `/health` success with `/dispatches/health` timeout is degraded, not a
  restart trigger.
- two consecutive `/health` failures trigger diagnostics plus
  `launchctl kickstart -k gui/$(id -u)/com.kilgore.id-agents-manager`.
- diagnostics are captured before restart under
  `/tmp/manager-http-liveness-watchdog-diagnostics`.
- restart loops are bounded by a 5 minute cooldown and escalation after repeated
  restart attempts or exceeded recovery budget.

Dry run:

```bash
node scripts/manager-http-liveness-watchdog.mjs --dry-run
```

Install/update launchd job after deploying the script to the clean deploy
checkout:

```bash
cp scripts/launchd/com.kilgore.manager-http-liveness-watchdog.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.kilgore.manager-http-liveness-watchdog.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.kilgore.manager-http-liveness-watchdog.plist
launchctl kickstart -k "gui/$(id -u)/com.kilgore.manager-http-liveness-watchdog"
```

Use `touch /tmp/manager-http-liveness-watchdog.pause` as the kill switch while
investigating. Logs are in `/tmp/manager-http-liveness-watchdog.log` and launchd
output is in `/tmp/manager-http-liveness-watchdog.launchd.log`. Incident
artifacts are written only on restart/escalation to
`/Users/kilgore/Dropbox/Code/agent-platform/output`.

## 4. External freshness watchdog (T-DEPLOY.5)

`scripts/deploy-freshness-watchdog.mjs` is a launchd-managed process outside
the agent fleet. It checks `/health` every 15 minutes and runs the manager
redeploy sequence when either:

- `freshness.state` is `stale` or `stale_alerted` for 2 consecutive checks.
- the dedicated deploy checkout is missing.
- the manager launchd plist no longer points at the dedicated deploy checkout.
- `/health` is unreadable immediately after a prior watchdog action.

Redeploys use `/Users/kilgore/Dropbox/Code/cane/id-agents-deploy-main`, a clean
`origin/main` checkout, and leave the primary developer checkout untouched. If
closeout still classifies stale, the watchdog writes a failure artifact and
posts the exact manual command:

```bash
/Users/kilgore/Dropbox/Code/cane/scripts/manager-promote-rebuild-restart.sh && curl -sS http://localhost:4100/health
```

Use `touch /tmp/deploy-watchdog.pause` as the kill switch while investigating.
Logs are in `/tmp/deploy-watchdog.log` and launchd output is in
`/tmp/deploy-watchdog.launchd.log`.

## 5. Auto-rollback (T-DEPLOY.5)

On a failing smoke, `decideRollback` picks the **last-good SHA** as the target.
With `--auto-rollback --execute`, the CLI performs:

1. `git checkout --detach <last-good-sha>`
2. `npm run build`
3. kickstart the manager (`DEPLOY_GUARD_KICKSTART_CMD`, e.g.
   `launchctl kickstart -k gui/$(id -u)/com.kilgore.id-agents-manager`)

Without `--execute` it prints the plan (dry-run — the safe default).

Rollback is **skipped** (needs operator) when:
- no last-good build is recorded yet, or
- the current build already IS the last-good (rolling back to self is futile).

### Standalone rollback

```bash
node dist/deploy-guard/cli.js rollback --to <sha> --execute
```

## Wiring into manager-deploy-runbook.md

Append to the runbook's deploy sequence, after the kickstart step:

```bash
node dist/deploy-guard/cli.js smoke \
  --base-url http://127.0.0.1:4100 \
  --pid-before "$PID_BEFORE" --pid-after "$PID_AFTER" \
  --auto-rollback --execute \
  || echo "DEPLOY SMOKE FAILED — see rollback output above"
```

Set once in the manager environment:
- `DEPLOY_GUARD_KICKSTART_CMD` = the exact `launchctl kickstart` for the manager
  service label.
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` for freshness alerts.
