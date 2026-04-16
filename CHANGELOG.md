# Changelog

## 0.1.53-beta

### Features

- **Runtime-aware agent paths**: Template loader, skill deployer, directory overlay, and personality file write are now all runtime-aware. Claude agents use `.claude/agents/`, `.claude/skills/`, and `.claude/CLAUDE.md`. Codex agents use `.agents/`, `.agents/skills/`, and `AGENTS.md` (at project root).
- **`getRuntimePaths(runtime)`**: New function in `runtime/registry.ts` returns `{ templateDir, overlayTarget, skillsDir, personalityFile, personalityFilename }` for any runtime. Adding a third runtime later requires one new case in this function.
- **Codex template support**: `loadSubAgentTemplate()` checks `.agents/{name}/AGENTS.md` (directory) or `.agents/{name}.md` (file) for Codex agents. `processConfig()` passes `agent.runtime` through for correct lookup.

### Changed

- `loadSubAgentTemplate()`, `copyAgentDirOverlay()`, `copyHeartbeatMd()` all accept an optional `runtime` parameter.
- `deploySkillsToAgent()` accepts `runtime` in its options and writes to the runtime-appropriate skills directory.
- All 4 spawn sites (spawn endpoint, sync-changed, sync-added, remote-deploy) use `getRuntimePaths(effectiveRuntime)` for personality file path.

## 0.1.52-beta

### Features

- **Agent-driven heartbeats via HEARTBEAT.md**: Heartbeat messages move out of YAML config and into a `HEARTBEAT.md` checklist file in the agent's template directory. The scheduler sends a generic wake-up; the agent reads its own checklist and decides what to do.
- **Simplified heartbeat config**: `heartbeat:` in YAML now accepts a plain number (seconds) for the new model. Legacy `heartbeat: {interval, message}` objects still work for backward compatibility.
- **HEARTBEAT.md copy at spawn**: At spawn time, if the agent template directory contains a `HEARTBEAT.md`, it is copied to `{workingDirectory}/HEARTBEAT.md` for the agent to read at runtime.
- **Silent HEARTBEAT_OK**: When an agent responds with exactly `HEARTBEAT_OK`, the response is suppressed from the news feed and logged at debug level only. Keeps the news feed clean when nothing needs attention.

### Removed

- **HEARTBEAT.yaml write at spawn**: The manager no longer writes `HEARTBEAT.yaml` files to agent working directories at spawn time. The new model uses `HEARTBEAT.md` from the agent template directory instead.

### Changed

- `heartbeatToSchedule()` now accepts `number | HeartbeatConfig` — sends the generic wake-up message for number config, custom message for legacy objects.
- `readHeartbeatConfig()` checks both `HEARTBEAT.yaml` (legacy) and `HEARTBEAT.md` (new model).
- `idchain.yaml` heartbeat entries simplified from `{interval, message}` objects to plain numbers.

## 0.1.51-beta

### Features

- **Directory overlay on spawn**: When an agent has a directory-based template at `.claude/agents/<name>/`, the entire directory is recursively copied into `{workingDir}/.claude/` as an overlay at spawn time. This copies skills, hooks, settings, MEMORY.md, and any other agent-specific files alongside the CLAUDE.md instructions. Uses `fs.cpSync` with `{ recursive: true, force: true }`.
- **Spawn order guarantee**: All four spawn paths (deploy, sync-changed, sync-added, remote-deploy) now follow the same order: (1) deploy team skills, (2) overlay agent directory template, (3) write CLAUDE.md with protocol defaults + role body. This ensures agent-specific files overlay team skills, and CLAUDE.md is always written last.
- **`agentTemplate` field**: The `agent` config field is now passed through as `agentTemplate` in spawn payloads, allowing the overlay to use a different template directory than the agent's own name.

## 0.1.50-beta

### Breaking Changes

- **Removed `claudeMd` and `claudeMdFile`** from YAML config (`AgentSpec` and `DeployConfig.defaults`). Agent instructions now come from exactly two sources: framework protocol defaults (injected automatically) and agent role files (`.claude/agents/<name>.md`). YAML config is infrastructure only.

### Features

- **Protocol defaults** (`src/protocol-defaults.ts`): Scheduling, task-discipline, and output convention rules are now a framework-managed constant, prepended to every agent's `CLAUDE.md` at spawn time. Previously these lived as inline YAML in `defaults.claudeMd`.
- **Agent role files**: The `.claude/agents/<name>.md` template body (from 0.1.49) is now the sole source of user-controlled agent instructions. Exposed as `roleBody` on `AgentSpec`.

### Removed

- `defaults.claudeMd` / `defaults.claudeMdFile` config fields
- `agents[].claudeMd` / `agents[].claudeMdFile` config fields
- `resolveClaudeMdFile()` function from config-parser
- `claudeMd` merge logic from `mergeDefaults()`
- `claudeMd` from sync diff fields (protocol defaults are always written)

## 0.1.49-beta

### Features

- **Sub-agent templates**: Agents can now load personality and context from `.claude/agents/<name>.md` files in their `workingDirectory`. The markdown body is prepended to the agent's `claudeMd` at deploy/sync time. Frontmatter `description` is used as a fallback when the config doesn't set one. Use the `agent` field in config to load a template with a different filename (e.g., `agent: security-audit` loads `security-audit.md` instead of the agent's own name).

### New config field

- `agents[].agent` — optional string, loads `.claude/agents/<agent>.md` instead of `.claude/agents/<name>.md`.

## 0.1.48-beta

### Features

- **Always-on task discipline**: Embedded the full task lifecycle rules directly into `defaults.claudeMd` in `configs/idchain.yaml`. Claude Code skills are lazy-loaded (body only enters context on invocation), so the skill file alone was dormant. The rules are now always in context for every idchain agent, matching how the output convention and scheduling sections already work.

### Documentation

- Added a note to `skills/task-discipline/SKILL.md` clarifying that idchain agents get the rules via `defaults.claudeMd` and the skill file is kept as reference.

## 0.1.47-beta

### Features

- **`task-discipline` skill**: New skill that enforces the task lifecycle (create/claim/done) for any multi-step work or work producing artifacts. Agents with this skill automatically use the `/tasks` system and include task names in replies.
- **idchain defaults**: Added `task-discipline` to the default skills list in `configs/idchain.yaml`, so all agents in the idchain team inherit it.

### Documentation

- Updated `docs/guides/tasks.md` with a "Making it required" section explaining how to enable/disable the skill per agent via config.

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
