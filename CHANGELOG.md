# Changelog

## 0.1.75-beta

### Fixes

- After `/sync` or `/deploy` adds a new agent, the running interactive CLI now reacts immediately. The daemon emits a new WebSocket message type `agents_changed` after every registry mutation (`/sync`, `/deploy`, `/agents/spawn`, `/delete`, `DELETE /agents/:id`, `DELETE /agents/by-name/:name`), and the CLI clears stale per-agent session state for any name that was removed or rebuilt and prints a one-line `🔄 registry: …` hint.
- `/deploy` and `/sync` in the CLI now wait up to 8s for each newly spawned agent's `/.well-known/restap.json` to return 200 before returning to the prompt. This closes a window where an immediate `/ask <new-agent>` would post into a port that was not yet listening and hang forever waiting for a reply that never came.
- Manager-inbox resolution is now hardened end-to-end. `findInteractive` selects the newest interactive row deterministically (`ORDER BY created_at DESC`) in both the SQLite and Postgres repos, eliminating cases where reply routing landed on a stale CLI row after `/sync` re-targeted a team. POST `/talk`, POST `/news`, POST `/schedule`, GET `/news`, and the `/remote news` handler all now go through a shared `resolveManagerInboxId` helper that auto-provisions a stub interactive row (`manager-<team>`) when neither a CLI nor a named "manager" agent is registered. Replies to a freshly-synced team that hasn't yet seen its CLI register no longer silently blackhole.
- The CLI now treats `/sync` and `/deploy` as identity-affecting events. The `/remote` `sync` and `deploy` responses echo the effective `team`/`teamId`, and the CLI re-registers its interactive row against that team (awaiting registration on `/deploy`, switching `activeTeam` and re-registering after `/sync`) before returning to the prompt. Previously `/deploy` fire-and-forgot the re-register, racing subsequent `/ask` calls against an interactive row in the old team.

## 0.1.74-beta

### Demos

- Replace the four editorial + solidity-security demo configs with a single `demo` team (`/deploy demo`): `cto` persona-only plus `developer` backed by the `fullstack-nextjs` library entry. Reverts an accidental copywriter add to the default team.

## 0.1.73-beta

### Documentation

- Add an "Agent Library & Team Configuration" section to the `idagents-admin-control` skill: how to list `/library/agents`, add an agent to a team YAML by referencing a library entry via the `agent:` field, run `/sync`, verify, and the anti-patterns around editing shared library entries or skipping `/sync`.

## 0.1.72-beta

### Documentation

- Sweep docs for the v0.1.69 through v0.1.71 library and sync surfaces: clarify that `agent:` selects a library entry under `configs/agents/<name>/`, `skills:` remains a peer field, and `configs/` is the canonical root.
- Rewrite the `/sync` guide as the canonical operator doc for the v3 engine, including two-step additive deploy, per-runtime mapping, the 4-case ownership rule, receipt location at `<workspace>/.id-agents/receipt.json`, memory-file fallback, `id-agents unsync`, `/library/agents`, `/library/skills`, and the TUI library browsers (`l`, `s`).
- Update root operator docs (`AGENTS.md`, `CONTRIBUTING.md`, architecture reference) to reflect the v3 library layout, receipt-driven sync model, library inventory endpoints, and NOTICE-based license preservation rules for imported content.

## 0.1.71-beta

### TUI

- Drop the `p` pause hotkey and the paused indicator. The feature toggled all polling intervals at once (an internal-debug-style escape hatch). It cluttered every footer hint string and rarely got used in practice. Agents view, tasks, calendar, heartbeats, news, library views all updated to drop `· p pause` from their hint lines, and the `paused` state machinery is removed from `App.tsx`. If you genuinely need to freeze polling, kill the TUI process — it'll come back where you left off.

## 0.1.70-beta

### TUI

- Library · Agents table trimmed: removed `RDME`, `LIC`, and `SUBFOLDERS` columns. The list view now shows only `NAME` and `SHAPE`. The dropped columns were noisy in a list and frequently misleading (e.g. `LIC: no` for entries that have per-skill `LICENSE` files but no top-level one). Detail view (`→`) still shows all of that information.

## 0.1.69-beta

### Features

- **Agent config v3 system** — full implementation across 8 slices (`0d86099` through `60338b6`):
  - Library at `configs/agents/<name>/` accepts two native shapes (Claude `<name>/CLAUDE.md` and AGENTS.md `<name>.md` + `<name>/`)
  - Standalone skill library at `configs/skills/<name>/`
  - New peer fields on team-config agent entries: `agent: <string>` and `skills: [<string>...]`
  - Sync engine (`src/cli/workspace-sync.ts`): SHA-256 + 4-case ownership logic + atomic receipt at `<workspace>/.id-agents/receipt.json`
  - Per-runtime mapping for Claude / Codex / Cursor (CLAUDE.md → AGENTS.md, skills → `.agents/skills/` or `.cursor/skills/`)
  - Memory-file fallback: existing `CLAUDE.md` → sidecar at `.claude/rules/agent-<name>.md`; existing `AGENTS.md` for Codex/Cursor → marker-fenced append (preserves user edits)
  - `id-agents sync <config>` and `id-agents unsync <config>` one-shot CLIs
  - Manager `/library/agents` and `/library/skills` read-only inventory endpoints
  - TUI library browsers: `l` for agents, `s` for skills, `→` for detail, with README preview cap
- **Library content imported** (`564b8b1`): 9 agent entries (`copywriter`, `devops`, `editor`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `security` — CC-BY-SA-4.0, `solidity-security`) and 8 demo team configs at `configs/demos/`. `NOTICE` at the repo root credits all upstream skill authors.
- **`s` library-skills hotkey** now reachable from agents/tasks/calendar/heartbeats views, not just from library-agents.

### Fixes

- **v3 deploy persona overwrite** (`7e7a314`, `658efcc`, `7b962b9`): library entry's `CLAUDE.md` no longer clobbered by the framework personality writer. Sidecar approach for Claude (lands at `.claude/rules/agent-<name>.md`); marker-fenced append into root `AGENTS.md` for Codex/Cursor preserves user edits.
- **Library root resolution unified** (`7e7a314`): `copyLibraryAgentOverlay` now honors `ID_LIBRARY_ROOT` env var the same way the slice-7 manager endpoints do, so library entries can live in any clone of the public-agents content.
- **Symlinked library entries** (`7e7a314`): `cpSync` now uses `dereference: true` so symlinked entries copy their target's contents.
- **TUI `from:` label missing on inbound notify** (`d359733`): `extractParty` in `NewsView.tsx` now matches `notify` and `message` types in the inbound branch.
- **Refuse-with-error exit code** (`3e8858f`): `id-agents sync` exits non-zero (was 0) when refusing to deploy onto a workspace with a pre-existing `AGENTS.md` not in our receipt.

### Tests

- 377 passing / 82 skipped: per-slice integration coverage for sync (4-case ownership), unsync, library enumeration (both shapes), per-runtime mapping, memory-file fallback (Claude sidecar + Codex/Cursor append), drift detection, idempotency.

## 0.1.68-beta

### Features

- **Default `trigger: true` on replies with `in_reply_to`**: when an agent posts a reply to `/news` with `in_reply_to` set, the receiver is now auto-woken by default instead of the reply sitting passively in the inbox. Closes the gap where a long-running pair-program loop (lead dispatches to worker, worker exceeds lead's poll window) required an external kick to resume. New helper `resolveNewsTrigger({in_reply_to, trigger})` in `src/core/messaging-service.ts`; applied in both `src/claude-agent-server.ts` (worker `POST /news`) and `src/agent-manager-db.ts` (manager `POST /news`). Callers can still opt out with `trigger: false`.
- Loop safety double-gated: the existing triggered-branch passes `noAutoReply: true` to `startQuery`, and `craftNewsTriggerPrompt` instructs the LLM not to reply to the sender.

### Fixes

- **TUI multi-team blindness**: `fetchAgentNews` and `fetchAgentsLatestNewsTs` in `src/tui/api/manager.ts` now accept an optional `teamName` and pass it as `x-id-team` header. `src/tui/App.tsx` threads the selected agent's `teamName` through. Previously, news and news-timestamp requests were header-less and resolved against the daemon default team, which made the News view empty and the freshness dot gray for any agent not in the default team.

### Tests

- 311 passing / 82 skipped: 5 new `news-trigger-default` unit cases + 3 new `news-reply-triggers-receiver` integration cases.

## 0.1.67-beta

### TUI

- News view now shows a sender/recipient column between Type and Message: `from: <sender>` for inbound items, `to: <recipient>` for outbound items, blank for self-status events. `to:` is indented two spaces so the colons align with `from:`. Protocol-level `remote` is rewritten to `manager` to match message bodies.

## 0.1.66-beta

### Fixes

- **Parent Claude Code session env leak** (P0): when the manager was launched from a shell that was itself a child of a Claude Code session (`!<cmd>` inside claude, IDE integrated terminal, tmux pane from inside claude), the blanket `startsWith('CLAUDE')` filter in `spawnLocalAgentProcess` forwarded session-handoff vars (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_AGENT_SDK_VERSION`) into child agents. Child `claude` CLIs honored the leaked OAuth token ahead of their own keychain/login, leading to 401 on every dispatch while `/health` stayed green. Replaced with an explicit deny-list (`SESSION_HANDOFF_VARS`) in new `src/lib/env-hygiene.ts`; non-session `CLAUDE_*` config vars still forward. Boot now warns if the manager itself is running under a parent Claude session.
- **Silent-stop forensic trail** (P0, partial): added top-level `unhandledRejection` + `uncaughtException` handlers in `src/lib/fatal-handlers.ts`. Log with `[FATAL]` prefix and `process.exit(1)` so supervisors (systemd, launchd, nohup wrappers) can restart cleanly instead of the process limping along with a dead tick loop.
- **XMTP dependency declared** (P1): `@xmtp/node-sdk` is now an explicit `dependencies` entry (was resolving through `@xmtp/agent-sdk` hoisting only). Fresh installs no longer fail with `Cannot find module '@xmtp/node-sdk'`.

### Tests

- 299 passing / 82 skipped: 7 new env-hygiene cases, fatal-handlers coverage, +existing.

## 0.1.65-beta

### Features

- **Cursor CLI runtime**: new `runtime: cursor-cli` alongside `claude-code-cli` and `codex`. Ships `CursorCliHarness` (stdin prompt, stream-json parsing, `-f` force-trust, `--resume` + `--model`), profile in `src/runtime/registry.ts` with preflight auth check, `scripts/detect-runtimes.sh` advisory update, `configs/cursor-smoke.yaml`. CTO-approved with dedicated `.cursor/` paths and auth-missing-as-warning constraints.
- **Cursor stream-json parser** (bugfix): `CursorCliHarness` now recognizes cursor-agent's real event schema (`system/init`, `user`, `thinking/delta`, `thinking/completed`, `assistant`, `result{success|error}`), extracts the assistant reply, and synthesizes a result if the process exits cleanly without a terminal event. Fixes hang-forever behavior on every `/ask` to a cursor agent. 6 new parser unit tests.

### Changed

- **Task-endpoint team resolution**: `/tasks`, `/tasks/:ref/claim`, `/tasks/:ref/done` now resolve the caller's team from body `agent_id`/`from` when no `X-Id-Team` header is supplied (via new `resolveAcrossTeams(ref)` in the agents repo). Fixes `id-agents-app` (team `idchain`) being rejected as 404 because the default CLAUDE.md boilerplate omits the team header. **Note:** CTO flagged that this weakens cross-team isolation since body identity isn't authenticated — accepted as designed for this single-tenant local system where any caller already has full shell access. Explicit `X-Id-Team` headers still short-circuit the fallback and enforce the team they specify.

### Tests

- 286 pass, 82 skip: 6 new cursor parser tests + 2 new team-isolation integration tests.

### Docs

- admin-control skill: reword "Talk to the Human Manager" section to reflect the daemon-owned inbox — `/talk` persists regardless of whether a human is at the REPL.

## 0.1.63-beta

### Features

- **Long-poll on `GET /query/:id`**: optional `?wait=<0-30>` blocks until state change or timeout via an in-process waiter map keyed by `teamId:queryId`. Wakes fire from `POST /news` terminal transitions and `cancelPendingQueriesForAgent`. Default `wait=0` preserves existing behavior. Typical latency improvement: short-poll 5.8s → long-poll 4.1s for an `echo` dispatch.
- **Daemon `POST /schedule`**: scheduling endpoint mirrors the CLI surface so clients can schedule directly against `:4100` without depending on the REPL being up.

### Changed

- **Shared-DB query writes across all runtimes**: dropped the `DATABASE_URL` gate in `src/local-agent-server.ts` so SQLite agents now open and migrate the shared DB by default. Same fix extended to `src/start-agent-manager.ts` (worker role). Agents persist `pending`/`processing`/terminal rows so `:4100/query/<id>` is authoritative for both claude and codex runtimes. Memory-only fallback preserved with a warning.
- **`/talk` pre-writes `pending`**: agent `/talk` handler writes the query row before returning the `queryId`, eliminating the race where concurrent pollers saw 404 for a freshly-dispatched query.
- **Manager inbox moved to daemon**: `POST :4100/talk`, `POST :4100/schedule`, `GET :4100/news` are now authoritative for the `interactive_manager` inbox. The CLI REPL reads the same DB-backed view; inbox survives CLI outages.

### Removed

- **CLI `/remote` endpoint**: `POST http://127.0.0.1:4000/remote` removed. Dispatch lives exclusively on `POST http://127.0.0.1:4100/remote` with response shape `{ok, result:{queryId,status,agent}, error?}`. `MANAGER_URL` default in the admin-control skill flips from `:4000` to `:4100`.
- **Deprecated CLI write endpoints**: `POST :4000/talk`, `POST :4000/schedule`, `POST :4000/news` return `410 Gone` with `Location: http://127.0.0.1:4100/...`. `:4000/talk` for `server.respond()` remains.

### Tests

- `scripts/test-longpoll.sh`: new durable regression matrix (10 cases) covering single-agent claude and codex, backward-compat, concurrent parallel dispatch, kill-mid-flight, planted-stale-row, already-terminal, nonexistent-id, cancel-via-stop, and manager-restart mid-flight.

## 0.1.58-beta

### Features

- **TUI Tasks view**: new top-level page listing `/task` records, grouped by team with status color coding (done gray, todo yellow, doing green), per-row drill-in via `→` opening a full-page Task Detail view with title, description, owner, timestamps, and linked events.
- **TUI Calendar view**: new top-level page showing upcoming scheduled items sorted by next occurrence. Heartbeat-kind items are filtered out so they don't duplicate the Heartbeats view.
- **TUI Heartbeats view**: new top-level page listing agents with active heartbeats, showing interval, last fire, next fire, with per-row drill-in via `→` loading the agent's full `HEARTBEAT.md` in a scrollable body.
- **Per-agent news freshness indicator**: new `N` column on the Agents table showing a colored dot whose color reflects the age of the agent's most recent news item (greenBright < 1m → green < 5m → yellow < 15m → gray). Batched fetch per 2s poll cycle, bucketed against the 10s cooldown epoch so the dot only re-renders on band crossings.

### Changed

- **TUI navigation refactor**: Tasks is now a drill-down from Agents (press `t` to open, `←` to return) rather than a peer top-level view. Calendar and Heartbeats are peer top-level views reached via `c` / `h`. The `← back` hint is moved to the end of every footer so it reads as an exit action, and removed from top-level views where `←` has nowhere to go back to.

### Fixed

- **`idagents-admin-control` skill not loading**: added the missing YAML frontmatter (`name` + `description`) to `SKILL.md`. Without it Claude Code's skill loader silently skipped the skill, so new admin sessions couldn't pick it up.
- **Three polling onboarding gotchas in the admin-control skill**:
  - Wrong endpoint: introduced `MANAGER_DAEMON_URL` (default `http://127.0.0.1:4100`) for polling and reserves `MANAGER_URL` (port 4000) for dispatch. The old skill example pointed polling at port 4000 which has no `/query/:id` route.
  - IPv6 vs IPv4 collision: all examples and shell scripts now use `127.0.0.1` instead of `localhost` so polling doesn't silently hit a different dev server listening on `[::1]:4000`.
  - QueryId extraction: the `/remote /ask` response returns `result` as a human-readable string (not a structured `queryId` field). Documented the `query_[0-9a-z_]+` regex extraction explicitly with a structured-field fallback.
- **Calendar + Heartbeats scroll-drawing artifacts**: the `TeamsPanel` chips bar has variable height that made fixed `*_CHROME_ROWS` constants unreliable, causing the list to overflow the terminal by 2-3 rows on narrow widths and scroll the previous frame up on every redraw (leaking chrome fragments). Calendar drops the chips bar entirely; Heartbeats stabilizes the chrome calculation so it no longer overflows.

### Removed

- **`feature/tui-dashboard` worktree and branch**: the worktree was useful during initial TUI development but all TUI work has been merged back to main. The tui agent now works on the main checkout directly alongside `agents` and `cto`. Local worktree removed, local + origin branches deleted.

## 0.1.57-beta

### Changed

- **QUICKSTART.md consolidated Launch section**: a single `## 8. Launch a User Surface (Optional)` block now documents the three ways to interact with a running team (Claude Code as manager via the `idagents-admin-control` skill, the TUI dashboard via `npm run tui:dev` / `npm run tui`, and the interactive CLI via `npm run id-agents`) with copy-pasteable start commands. Removes the older piecemeal mentions that were scattered across Step 6 and a separate TUI step.

## 0.1.56-beta

### Features

- **`/news-to` trigger passthrough**: the agent-local `/news-to` helper now accepts an optional `trigger: true` field and passes it through to the target's `/news` endpoint. Enables async delegation (recipient processes the message, no sync reply) as a third pattern alongside `/talk-to` (sync delegation) and plain `/news-to` (passive notification).

### Fixed

- **Manager inbox write-path routing**: the `/agents` catalog was returning the interactive CLI's port (4000) as the URL for the manager identity, so `/news-to manager` calls from agent wrappers died at a dead port. Fixed by storing the daemon's `managementPort` on the manager instance and returning `http://localhost:<managementPort>` for interactive-type agents in `agentToResponse`. Wrappers re-fetch `/agents` on every `/news-to` call, so no fleet rebuild is required.
- **Manager inbox read-path routing**: the `/remote /news <agent>` command computed `baseEndpoint` directly from the DB row, bypassing `agentToResponse` entirely. For interactive agents this still resolved to port 4000. Fixed by short-circuiting the read path for `type === 'interactive'` to read directly from `news_items` via the DB, using the same `findInteractive` lookup that `POST /news` uses for writes.

### Changed

- **`inter-agent` skill promotes trigger examples to the top**: the three canonical usage patterns (`/talk-to`, `/news-to` plain, `/news-to` + `trigger:true`) are now the first thing agents see in the skill, each as a fully-formed copy-pasteable curl block. Added a prominent warning that `trigger:true` must be a literal boolean in the JSON body — omitting it is a silent delivery failure. Added a decision helper: when in doubt between `/news-to` + `trigger:true` and `/talk-to`, use `/talk-to`. Changes lifted to the top of the skill so they're the nearest reference material when an LLM is constructing a curl call.

## 0.1.55-beta

### Features

- **`GET /query/<id>` on the manager daemon**: new queryId-based polling primitive. Returns `{ query_id, status, result?, error?, agent, created_at, completed_at? }` with lifecycle `pending | processing | delivered | failed | expired`. Replaces the fragile timestamp-filter polling pattern used by the admin-control skill. Composes cleanly with the inbox redesign: `POST /talk manager` creates a query record; `GET /query/<id>` is the deterministic wait mechanism.
- **`/news-to` on agent's local wrapper**: mirror of `/talk-to` for fire-and-forget notifications. Payload `{ to, message, data? }`. Looks up target via the manager catalog, POSTs directly to target's `/news`, returns 202 immediately. Two-verb model: `/talk-to` when you want a reply, `/news-to` when you don't.
- **Manager daemon serves `/talk` and `/news` for the `manager` identity**: the manager inbox no longer depends on the interactive CLI being online. Agent-to-manager escalations land in a durable DB-backed inbox regardless of whether any human surface is connected.
- **`/news ?since_id=<n>&limit=N` cursor**: server-side monotonic cursor on `/news` on both agent and manager endpoints. Replaces the timestamp-filter race-prone pattern. Timestamp `?since=<ms>` still accepted for one release with a deprecation header.
- **Stuck-query sweeper**: background task marks queries older than a timeout as `failed` or `expired`, so crashed agents no longer leave queries stuck in `pending` forever.
- **`kind` and `reply_expected` metadata on news items**: structured fields layered on top of existing typed events (`query.received`, `outbound.reply`, etc.) so downstream UIs can filter by semantic intent rather than guessing from event type.
- **Task short UUIDs**: every task record now carries a random short UUID. Manager commands accept either `name` or `#shortid` (first 8 chars) as a reference. Unambiguous even when names collide across teams or contexts.

### Changed

- **`inter-agent` skill rewritten for two-verb model**: `/talk-to` (reply expected) and `/news-to` (fire-and-forget). Drops `/message` from agent-facing examples. Zero flags. Teaches the long-running-work pattern (quick `/talk-to` ACK followed by delayed `/news-to` from the worker when results are ready).
- **`idagents-admin-control` skill rewritten for queryId polling**: primary wait pattern is now `GET /query/<id>` until status is terminal. Timestamp-filter polling moved to a legacy footnote. Polls documented as background-only (`run_in_background: true`) with sensible defaults.

### Deprecated

- **`POST /message` on the manager daemon**: returns a deprecation warning in the response header and logs. Functional for one release, will be removed in a subsequent version. Callers should switch to `/news-to` (fire-and-forget) or `/talk-to` (sync) on the agent's local wrapper.

### Fixed

- **`--dangerously-skip-permissions` default behavior**: agent spawn now defaults to skip-permissions for both claude-code-cli and codex runtimes when the YAML `dangerouslySkipPermissions` field is unset. Explicit `false` is honored. The codex equivalent (`--dangerously-bypass-approvals-and-sandbox`) is wired for codex-runtime agents.
- **Permissions documentation**: QUICKSTART and README softened from "forced" to "default-with-override," clarifying that agents run with bypass by default but the user can set explicit `false` in config.
- **TUI documentation shipped across the repo**: new `docs/guides/tui.md`, Quick Start subsection in README, new step in QUICKSTART, link in `docs/README.md`.

## 0.1.54-beta

### Features

- **TUI monitoring dashboard**: New real-time terminal dashboard at `src/tui/`, invoked with `npm run tui:dev` (source) or `npm run tui` (built). Three-page stack (agents list → news list → news detail) navigated via `←`/`→`; `↑`/`↓` for row selection and scrolling; `Tab`/`Shift+Tab` to cycle team filter. Includes a compact status strip showing one glyph per agent across the full fleet, per-type news item colors, and an age-colored cooldown indicator fading bright green → green → yellow → gray at 15 minutes. Built on `ink` + React. Flicker-free on iTerm2 via a stdout transform that rewrites ink's erase-and-redraw escape sequences to cursor-home overwrites, combined with fixed-height padded layouts on both pages.
- **`tui` agent in `idchain` config**: New team member with `workingDirectory` set to a git worktree (`feature/tui-dashboard`) so dashboard development does not block work on `main`. Demonstrates the worktree-based agent pattern.

### Changed

- **Skill rename**: `admin-control` → `idagents-admin-control` across the skills directory, docs, and references. Disambiguates the skill when loaded alongside other admin tools.
- **QUICKSTART.md Step 6**: Now instructs Claude to offer to continue as the team manager via `/remote` after deploy completes, instead of handing the user off to a separate interactive CLI terminal.
- **README.md Quick Start**: Leads with the agent-driven quickstart (paste the skill, ask Claude to run QUICKSTART.md). Manual install demoted to a secondary subsection.
- **Polling guidance in `idagents-admin-control`**: Dispatch and poll are now documented as two distinct steps. Poll is marked background-only with `run_in_background: true` and max wait bumped from 2 minutes to 10 minutes. A new Anti-patterns subsection warns against combined dispatch+poll blocks and foreground polling.

### Fixed

- **`/ask manager` self-trap at the CLI**: The interactive CLI now rejects `/ask manager` with a friendly hint pointing to `/talk`. `manager` is reserved in `name-validation.ts`. Agent-to-manager escalation via `inter-agent-tools` is preserved because that path is legitimate.
- **Missing API key produces a hint, not a stack trace**: Spawning a claude-runtime agent without `ANTHROPIC_API_KEY`, or a codex agent without `OPENAI_API_KEY`, now prints a single-line setup hint at spawn time. Manager startup is unaffected.
- **`/team` and `/teams` empty states**: When no teams exist, the commands print a friendly message pointing to `/team <name>` or `/deploy <config>` instead of showing a stale `default` header.
- **Hide `manager` row from `/agents` CLI listing**: The interactive CLI filters out `type === 'interactive'` rows when printing the agents table. `GET /agents` still returns the row for admin tooling and `/remote` dispatchers.

### Removed

- **Root `HEARTBEAT.yaml`**: Retired in favor of per-agent `HEARTBEAT.md` (introduced in 0.1.52). The untracked `HEARTBEAT.md` at the repo root is now gitignored.

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
