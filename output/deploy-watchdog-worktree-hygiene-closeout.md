# Deploy Watchdog Worktree Hygiene Closeout

- Task: deploy-watchdog-worktree-hygiene
- Agent: roger
- Repo: `/Users/kilgore/Dropbox/Code/cane/id-agents`
- Worktree used: `/Users/kilgore/Dropbox/Code/roger/worktrees/deploy-watchdog-worktree-hygiene`
- Branch: `codex/deploy-watchdog-worktree-hygiene`

## Changes

- Added `scripts/lib/deploy-watchdog-worktree-hygiene.mjs` to classify deploy checkout hygiene from `git status --porcelain --untracked-files=all`.
- `scripts/deploy-freshness-watchdog.mjs` now treats the deploy checkout as unhealthy unless it exists, is on `main`, and has no non-ignored local changes.
- Before rebuild, restart, and promotion verification, the watchdog refuses dirty deploy checkouts by default and throws a failure naming changed files plus remediation.
- Added explicit override support via `DEPLOY_WATCHDOG_ALLOW_DIRTY_CHECKOUT=1`; this logs changed files instead of silently hard-resetting/cleaning.
- Removed the watchdog's default `git reset --hard` and `git clean -ffd` cleanup path. Updating the deploy checkout now uses `git merge --ff-only origin/main`.
- Primary checkout hygiene logging now includes changed file names while still preserving primary work and rebuilding only from the deploy checkout.

## Verification

- `npm test -- tests/unit/deploy-watchdog-worktree-hygiene.test.ts tests/unit/deploy-watchdog-node-modules-fix.test.ts tests/unit/deploy-watchdog-decision.test.ts`
  - 3 files passed, 23 tests passed.
- `npm run build:core`
  - TypeScript core build passed.
- `node --check scripts/deploy-freshness-watchdog.mjs && node --check scripts/lib/deploy-watchdog-worktree-hygiene.mjs`
  - Syntax checks passed.

## Coverage

- Clean main checkout passes.
- Dirty checkout with tracked and untracked changes fails with changed file names and remediation.
- Ignored files, including ignored `node_modules` cache content, do not dirty the checkout.
- Source regression prevents reintroducing `git reset --hard` / `git clean -ffd` in the deploy watchdog.

## Notes

- The first `npm test` attempt in the fresh worktree rebuilt `better-sqlite3` for `/opt/homebrew/bin/node`; after that ABI repair, the targeted suite passed normally.
