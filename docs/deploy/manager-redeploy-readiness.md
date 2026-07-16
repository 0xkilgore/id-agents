# Manager Redeploy Readiness

`GET /health` includes `manager_redeploy_readiness`, a bounded gate for deciding whether
`origin/main` can be safely deployed from the protected deploy checkout.

The gate is report-only. It does not restart the manager.

## Ready Signal

Proceed only when:

- `state` is `stale_ready`
- `can_deploy_origin_main` is `true`
- `blockers` is empty
- `deploy_checkout.state` is `ready`
- `disk_headroom.state` is `ok` or `warn`
- `supervisor_freshness.state` is `fresh`

`fresh` means the running manager already matches `origin/main`; no redeploy is needed.

## Blocked Signals

Do not redeploy when any blocker is present, especially:

- `disk_critical` or `disk_unknown`
- `checkout_dirty`
- `checkout_divergent`
- `checkout_wrong_branch`
- `supervisor_stale`, `supervisor_error`, `supervisor_stopped`, or `supervisor_disabled`

Fix the blocker first, then re-check `/health`.

## Safe Command Reference

Use the command reported in `manager_redeploy_readiness.safe_command` as the canonical
preflight reference. The default is a dry run:

```bash
DEPLOY_WATCHDOG_DRY_RUN=1 node scripts/deploy-freshness-watchdog.mjs --dry-run
```

Run the live deploy watchdog only after the readiness gate is green and the operator has
confirmed the restart window. This readiness gate must not restart the manager itself.

