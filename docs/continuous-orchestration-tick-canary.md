# Continuous orchestration tick canary

This canary exercises the current production-shaped backlog without mutating the
production database or enabling the LaunchAgent loop.

1. Confirm `GET /orchestration/status` reports `config.enabled=false`. Stop if it
   does not. Do not edit the production plist.
2. Create a disposable directory with `mktemp -d`, then snapshot the live SQLite
   database with SQLite's online `.backup` command.
3. Start the candidate manager on an unused loopback port with the manager Node
   binary, `SQLITE_PATH` pointed at the snapshot,
   `CONTINUOUS_ORCHESTRATION_ENABLED=false`, and
   `CONTINUOUS_ORCHESTRATION_DRY_RUN=true`.
4. Wait until `GET /health` succeeds. For each of three sequential manual
   `POST /orchestration/tick` calls, poll `GET /health` concurrently with a
   two-second timeout. Record tick ID, tick response, probe count, failures, and
   maximum health latency.
5. Pass only when all three ticks return `ok=true`, all tick IDs are distinct,
   no health probe fails, no dispatch is admitted in dry-run, and the canary
   manager remains alive. Stop the canary manager and remove the snapshot.

Re-enable criteria are stricter than a canary pass: focused regression and full
build green; three production-snapshot dry-run ticks green with zero health
failures; production manager `/health` stable; candidate SHA promoted and remote
`main` verified; orchestration state reviewed for no unsafe admission; explicit
operator approval to change the LaunchAgent environment. Re-enable is a separate
operator action and is never performed by this procedure.
