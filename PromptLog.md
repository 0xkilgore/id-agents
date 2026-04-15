# Prompt Log

Short, high-level descriptions of significant changes, written in the voice of a PM or lead dev briefing an engineer. Newest entries at the top.

Entries are synthesized prompts, not verbatim chat messages. They can describe completed work or work that has not started yet. Use this file to track ideas, plan upcoming work, and record what landed.

**Statuses:** `proposed` (idea, not yet decided), `planned` (will be done), `in progress` (being worked on), `done` (landed).

---

## 2026-04-15: Name validation and empty-team requirement for destructive commands, 0.1.46-beta

**Status:** done

Add two safety speed bumps to the delete chain so nobody wipes a team with a single command. First, `/team delete <name>` refuses when the team still has agents, pointing the operator at `/delete --team <name>` as a prerequisite. Three explicit actions required to fully wipe a team including its record. Second, validate team and agent names at creation time against reserved command verbs, shell wildcards, flag-like prefixes, whitespace and control characters, and length over 64. Existing teams and agents are grandfathered, validation is creation-time only.

---

## 2026-04-15: Bulk delete, output convention, docs, 0.1.45-beta

**Status:** done

Ship three features plus three docs pages. `/delete *` deletes every agent in the current team with a confirmation prompt. `/delete --team <name>` does the same for a specified team. No `/delete --all` across teams, deliberately omitted to prevent one-command system-wide wipes. Working directories are never touched by any delete variant. Formalize `{workingDirectory}/output/` as the convention for agent artifacts, inject a preamble into each agent's CLAUDE.md telling them to write there, expose `/output <agent>` to list files and `/artifact <agent> <path>` to read one with path-traversal and size caps. New docs pages clarify that `/news` is for loop-safe messages and multi-reply catching (not the audit trail people keep trying to build on top of it) and that `/tasks` is the first-class work coordinator for the Roger-style research-then-code pattern.

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
