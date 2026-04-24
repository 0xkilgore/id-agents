# Prompt Log

Short, high-level descriptions of significant changes, written in the voice of a PM or lead dev briefing an engineer. Newest entries at the top.

Entries are synthesized prompts, not verbatim chat messages. They can describe completed work or work that has not started yet. Use this file to track ideas, plan upcoming work, and record what landed.

**Statuses:** `proposed` (idea, not yet decided), `planned` (will be done), `in progress` (being worked on), `done` (landed).

---

## 2026-04-24: Agent-config v3 slice 2 simplification, direct library resolve

**Status:** in progress

Reality check is complete: the skills system is real and must stay behaviorally unchanged, but the old agent-role override path is not in use and does not need compatibility handling. Simplify slice 2 accordingly. The `agent` field now means exactly one thing in config parsing and deploy/sync flow: resolve directly to the library folder `config/agents/<agent>/` and overlay that into the target workspace's `.claude/` before skills run. There is no two-stage lookup, no role-template fallback, and no warning path for "both resolutions match".

Clean up dead legacy code instead of preserving it. Remove any request or config plumbing that still treats `agent` as a role-template alias, keep role-body loading pinned to the real agent name from the runtime-native template directory, and continue leaving `skills:` untouched. Slice 3 should build on this simplified contract rather than carrying migration scaffolding forward.

---

## 2026-04-15: Runtime-aware template loader and skill deployer, 0.1.53-beta

**Status:** done

Make the agent template loader and skill deployer runtime-aware so Codex agents use native Codex conventions instead of Claude conventions. Claude runtimes use `.claude/agents/` for templates, `.claude/skills/` for skills, and `.claude/CLAUDE.md` for personality. Codex uses `.agents/` for templates, `.agents/skills/` for skills, and `AGENTS.md` at the project root.

New `getRuntimePaths(runtime)` function in `runtime/registry.ts` centralizes path resolution. Returns `{ templateDir, overlayTarget, skillsDir, personalityFile, personalityFilename }`. Today handles `claude-*` and `codex`; adding a third runtime is one new case.

Updated `loadSubAgentTemplate()`, `copyAgentDirOverlay()`, `copyHeartbeatMd()` in config-parser.ts to accept optional `runtime` parameter. Updated `deploySkillsToAgent()` in agent-manager-db.ts to accept `runtime` in opts and write to runtime-aware skills directory. All 4 spawn sites pass `effectiveRuntime` through and write the personality file to the runtime-appropriate path.

`processConfig()` now passes `agent.runtime` to `loadSubAgentTemplate()` so Codex agents have their templates loaded from `.agents/` after mergeDefaults resolves the runtime.

17 new unit tests: `getRuntimePaths` for all runtime variants, `loadSubAgentTemplate` with Claude and Codex (including isolation — Claude template not visible to Codex), `copyAgentDirOverlay` with both runtimes, `copyHeartbeatMd` with both runtimes, `processConfig` integration with Codex loading from `.agents/`.

---

## 2026-04-15: Agent-driven heartbeats via HEARTBEAT.md, 0.1.52-beta

**Status:** done

Redesign the heartbeat system from manager-driven to agent-driven. The heartbeat message moves out of the YAML config (`heartbeat: {interval, message}`) and into a `HEARTBEAT.md` checklist file in the agent template directory (`.claude/agents/{name}/HEARTBEAT.md`). The scheduler becomes a dumb wake-up timer — it sends a generic message telling the agent to read its own checklist. The agent decides what to do by reading HEARTBEAT.md from its working directory root.

YAML config simplifies from `heartbeat: {interval: 86400, message: "..."}` to just `heartbeat: 86400`. Legacy object format still works for backward compatibility. `heartbeatToSchedule()` accepts `number | HeartbeatConfig` and sends the generic wake-up for the new model, preserving the custom message for legacy.

At spawn time, `copyHeartbeatMd()` copies HEARTBEAT.md from the agent template directory to the working directory root. All four spawn paths include this step. HEARTBEAT.yaml is no longer written at spawn time (removed from all 4 sites + remote-deploy).

Silent no-ops: when an agent responds with exactly `HEARTBEAT_OK`, the `query.completed` and `response.saved` news items are suppressed. Logged at debug level with a green heart icon instead.

HEARTBEAT.md files created for all 6 idchain agents with heartbeat enabled: contracts, web, gateway, indexer, cli, agents. Each contains the same security review checklist that was previously inline in the YAML message.

12 new unit tests covering config parsing (number vs legacy object, defaults inheritance), schedule creation (generic vs custom message, maxBeats/expiresAfter preservation), and copyHeartbeatMd (missing dir, no file, copy, overwrite).

---

## 2026-04-15: Recursive directory overlay on spawn, 0.1.51-beta

**Status:** done

When an agent has a directory-based template at `.claude/agents/<name>/`, copy the entire directory into `{workingDir}/.claude/` as an overlay at spawn time — not just CLAUDE.md, but skills, hooks, settings.json, MEMORY.md, everything. Uses `fs.cpSync(src, dest, { recursive: true, force: true })` via `copyAgentDirOverlay()` in config-parser. All four spawn paths (main spawn endpoint, sync-changed, sync-added, remote-deploy) now follow a consistent three-step order: (1) deploy team-level skills, (2) overlay agent directory template, (3) write CLAUDE.md with protocol defaults + role body. This means agent-specific files win over team skills when names collide, and CLAUDE.md is always written last with the canonical protocol defaults regardless of what was in the overlay. The `agent` config field passes through as `agentTemplate` in spawn payloads. 9 new unit tests covering the overlay function: missing dir, non-directory, single file copy, nested skills, hooks, MEMORY.md, full tree, force overwrite, additive behavior.

---

## 2026-04-15: Two-source claudeMd simplification and directory-based agents, 0.1.50-beta

**Status:** done

Collapse the agent instruction system from N sources down to exactly two: framework protocol defaults and agent role files. Protocol defaults (scheduling, task-discipline, output convention) move from an inline YAML string in `configs/idchain.yaml` into a framework constant in `src/protocol-defaults.ts`, prepended to every agent's `CLAUDE.md` unconditionally at spawn time. Agent personality lives in `.claude/agents/` in the project repo, exposed as `roleBody` on `AgentSpec`. The `claudeMd`, `claudeMdFile`, and `resolveClaudeMdFile()` are all removed from the config schema and processing pipeline. The YAML config becomes infrastructure-only: name, workingDirectory, model, runtime, heartbeat, skills.

Support both Claude Code sub-agent patterns for role files. Directory pattern takes priority: `{workingDirectory}/.claude/agents/{name}/CLAUDE.md` (checked first, supports MEMORY.md and agent-specific skills alongside the definition). Single-file fallback: `{workingDirectory}/.claude/agents/{name}.md`. If neither exists, agent gets protocol defaults only. This makes it trivial to promote any Claude Code sub-agent into a persistent id-agents worker with identity by just adding a line to the team config.

---

## 2026-04-15: Sub-agent templates from .claude/agents/, 0.1.49-beta

**Status:** done

Add support for loading agent personality from `.claude/agents/<name>.md` files in the agent's working directory. During deploy and sync, after determining workingDirectory and name, check if the template file exists. If it does, parse YAML frontmatter and markdown body. Prepend the body to the agent's claudeMd (before defaults and agent-level config) and use the frontmatter `description` as a fallback when the config doesn't specify one. Also add an `agent` field to AgentSpec so config can point at a different template filename — e.g., `agents: [{name: auditor, agent: security-audit}]` loads `security-audit.md` instead of `auditor.md`. This bridges the gap between Claude Code sub-agents (which already use `.claude/agents/`) and id-agents workers, letting users promote a sub-agent into a full worker with identity while keeping the personality file in the project repo. New `loadSubAgentTemplate()` and `parseSubAgentTemplate()` functions in config-parser, called from processConfig. 17 unit tests covering frontmatter parsing, file-exists/missing, and processConfig integration.

---

## 2026-04-15: Always-on task-discipline via defaults.claudeMd, 0.1.48-beta

**Status:** done

Claude Code skills are lazy-loaded — the skill name appears in the skills list but the SKILL.md body only enters context when an agent actively invokes it. That meant task-discipline was dormant even though every idchain agent had it in their skills list. Fix: embed the full task lifecycle rules (create, claim, work, done, reply with task name) directly into `defaults.claudeMd` in `configs/idchain.yaml`, alongside the existing Scheduling block. The skill file is kept as documentation and for non-idchain agents. Now every idchain agent has the rules in context from the moment it starts, no invocation required.

---

## 2026-04-15: task-discipline skill and idchain defaults, 0.1.47-beta

**Status:** done

New `task-discipline` skill (`skills/task-discipline/SKILL.md`) that makes the task lifecycle mandatory for multi-step work. Agents with this skill create a task before starting, claim it, write artifacts to `./output/`, mark done, and include the task name in the reply. Added to `configs/idchain.yaml` defaults so all idchain agents inherit it. Docs updated with a "Making it required" section explaining opt-in/opt-out via config. Agents that need to skip it can override their skills list without `task-discipline`.

---

## 2026-04-15: Name validation and empty-team requirement for destructive commands, 0.1.46-beta

**Status:** done

Add two safety speed bumps to the delete chain so nobody wipes a team with a single command. First, `/team delete <name>` refuses when the team still has agents, pointing the operator at `/delete --team <name>` as a prerequisite. Three explicit actions required to fully wipe a team including its record. Second, validate team and agent names at creation time against reserved command verbs, shell wildcards, flag-like prefixes, whitespace and control characters, and length over 64. Existing teams and agents are grandfathered, validation is creation-time only.

---

## 2026-04-15: Bulk delete, output convention, docs, 0.1.45-beta

**Status:** done

Ship three features plus three docs pages. `/delete *` deletes every agent in the current team with a confirmation prompt. `/delete --team <name>` does the same for a specified team. No `/delete --all` across teams, deliberately omitted to prevent one-command system-wide wipes. Working directories are never touched by any delete variant. Formalize `{workingDirectory}/output/` as the convention for agent artifacts, inject a preamble into each agent's CLAUDE.md telling them to write there, expose `/output <agent>` to list files and `/artifact <agent> <path>` to read one with path-traversal and size caps. New docs pages clarify that `/news` is for loop-safe messages and multi-reply catching (not the audit trail people keep trying to build on top of it) and that `/tasks` is the first-class work coordinator for research-then-code workflows.

---

## 2026-04-15: Config parser and deploy safety fixes, 0.1.44-beta

**Status:** done

Two small but blocking bug fixes based on integrator feedback. Make `defaults.register: false` actually propagate to agents that do not specify their own `register` field. Previously this was silently dropped, and every deploy failed with "Missing signer" unless a wallet was configured, which no first-time user has. Second, change `getDeployerAddress()` to return null rather than throwing when no deployer is configured. Callers now handle null gracefully and omit the `agent_account` field from metadata. Together these unblock the "no wallet, no ENS, just spin up a team" onboarding path.

---

## 2026-04-15: /sync command and orphan process fix, 0.1.43-beta

**Status:** done

First integrator hit the deploy-duplicate bug where running `/deploy idchain` on an already-running team left orphan processes on old ports and wiped news, query, and schedule history via cascade delete. Root cause was that deploy was full nuke-and-recreate with no diffing, and the old process was never killed before the DB row was deleted. Fix in two parts. Kill the old process on its existing port before deleting the DB row so orphans stop accumulating. Add a new `/sync <config>` command that reconciles a running team with its config file, diffing into added, removed, changed, and unchanged agents. Only changed agents rebuild in place (same ID, same port, new config), preserving sessions, news, queries for everyone else. `/deploy` stays as nuke-and-recreate for clean deploys.

---

## 2026-04-10: Autodetect runtime in QUICKSTART, prefer mixed team

**Status:** done (v0.1.42-beta)

Replace the manual runtime checkbox selection in QUICKSTART.md with automatic detection of Claude Code and Codex. For each runtime, check that the binary is installed **and** the user is actually authenticated. Binary only checks give false positives that cause deploys to crash halfway through. When both runtimes are ready, default to the mixed demo team because it is the best first demo. Fall back to whichever single runtime is ready if only one works. If the user has a CLI installed but not logged in, tell them exactly which `login` command to run to unlock the mixed team.
