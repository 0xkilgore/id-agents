# Changelog

## 0.1.46-beta

### Safety

- **Empty-team requirement on `/team delete`**: Refuses to delete a team that still has agents. Operator must run `/delete --team <name>` first to empty the team, then `/team delete <name>` to remove the team record. Three explicit actions required to fully wipe a team.
- **Name validation for teams and agents**: At creation time, team and agent names are rejected if they match reserved command verbs (delete, deploy, sync, etc.), contain shell wildcards (`*`, `?`, `[`, `]`), start with `-` or `--`, contain whitespace or control characters, are empty, or exceed 64 characters. Existing teams and agents are grandfathered.

## 0.1.45-beta

### Features

- **Bulk delete**: `/delete *` deletes all agents in the current team. `/delete --team <name>` targets a specific team. Confirmation required in interactive CLI. Working directories are never touched.
- **Agent output convention**: Agents now write artifacts to `./output/` by convention (injected into CLAUDE.md at deploy time).
- **`/output <agent>`**: Lists files in an agent's output directory with filename, size, and modification time.
- **`/artifact <agent> <path>`**: Reads a file from an agent's output directory. Rejects directory traversal and files over 1MB.

### Documentation

- Added `/task` usage guide (`docs/guides/tasks.md`) covering the handoff pattern and stale task verifier.
- Added `/news` clarification guide (`docs/guides/news-feed.md`) distinguishing news from task tracking and artifact sharing.
- Added agent outputs guide (`docs/guides/agent-outputs.md`).

## 0.1.44-beta

### Bug Fixes

- **`defaults.register` propagation**: `register: false` in config defaults now correctly propagates to agents that don't set `register` explicitly. Previously only agent-level `register` was respected.
- **`getDeployerAddress()` null safety**: Returns `null` instead of throwing when no OWS wallet or private key is configured. Deploys with `register: false` no longer require wallet configuration.

## 0.1.43-beta

### Features

- **`/sync` command**: New config reconciliation command that updates running teams without full teardown. Diffs agents into new/removed/changed/unchanged categories and applies minimal changes.
- **Orphan process fix**: `/deploy` now kills old agent processes before deleting DB records, preventing port leaks.

### Documentation

- Added `/sync` command guide and updated all deployment docs with `/sync` vs `/deploy` distinction.
