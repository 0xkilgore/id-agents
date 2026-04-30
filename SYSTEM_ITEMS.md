# System Items — id-agents

> Audit inventory of the id-agents codebase. One line per item, numbered sequentially, grouped by category.

Generated: 2026-03-24
Updated: 2026-04-28 — thorough audit: §G fixed misplaced wakeup plan ref, §I added new configs + demos, §J added scheduling/security/protocol/erc-draft docs, §K added identity/wallet/catalog skill entries, §L added id-loader.service + agent demo YAMLs, §M rewritten to reflect extraction to standalone Juno repo, added §O bin/ and §P tools/
Updated: 2026-04-28 — deep audit pass: §A reconciled 1:1 with `find src -name '*.ts' -o -name '*.tsx'` (122 files = 122 entries, no stale refs, no missing additions). All src/ files added in the last 14 days are present. Tightened descriptions for items 5 (checkin-autoclose), 6 (checkin-service), 11 (cli/agent-readiness), 119 (event-producer), 120 (retention) to match current code (topics list, 280-byte preview cap, 5-min sweep cadence, env-override names, atomic bulk-close semantics, owner-inbox news_item write, 8s/250ms/750ms readiness probe budget)
Updated: 2026-04-28 — deep audit take 4: §A re-verified 1:1 (still 122/122). Spot-verified magic numbers in code: `DEFAULT_TICK_INTERVAL_MS=30_000` (checkin-service), `DEFAULT_RETENTION_DAYS=7` / `DEFAULT_RETENTION_COUNT=100_000` / `DEFAULT_RETENTION_INTERVAL_MS=5*60*1000` (retention), `PREVIEW_MAX=280` (event-producer), `timeoutMs=8000` / `intervalMs=250` / `perRequestTimeoutMs=750` (agent-readiness). §C cross-checked against current `agent-manager-db.ts` route registrations. §H added missing `frontend` bundle. §N integration test count 37 → 39 (added `talk-to-reply-qid.test.ts`; `query-failed-event`, `checkin-priority-wake`, `checkin-service-boot` already listed). §O corrected `bin/id-agents` (symlink/npm-bin → `dist/interactive-agent-cli.js`, not `src/id-agents-cli.ts`); added `id-agents-dashboard` per `package.json` bin map. §P clarified `tools/test-manager/index.js` is a standalone in-memory REST-AP test manager (no DB) plus its README.
Updated: 2026-04-28 — exhaustive 14-day audit: walked **290 commits** since 2026-04-14, **615 unique paths touched** (532 still extant, 83 deleted — 62 of those `public-agent/` from Juno extraction). §A still 1:1 (122/122). §J item 5 dropped deleted `docs/guides/admin-control.md`. §J item 7 added missing `docs/reference/database.md` and `docs/reference/id-indexer-api.md`. §K item 3 expanded to enumerate `admin-session.js` + `start-listener.js` helpers under `idagents-admin-control`. §N restructured: section now covers all of `tests/` (integration 39 + unit 24 + repos 6 + helpers + pty-flicker.py) with new items 12 (unit suites) and 13 (repo/schema suites). See "Progress Log" appendix at end of file.

---

## A. Source Files

1. `src/agent-manager-db.ts` — Manager daemon: WebSocket, team-scoped REST (agents, talk, message, news, query status, tasks, checkins, events, registry, v3 library inventory, scheduler, remote control); optional wallet provisioning per team config; killAgentProcess guard for rebuild/spawn vs manager PID; wakeup `event_log` retention sweep wiring; checkin auto-attach on `/talk-to` and task-terminal auto-close hooks
2. `src/agent-rest-server.ts` — Re-exports `AgentRestServer` and news types from `claude-agent-server` (runtime-neutral)
3. `src/agent-restap-cli.ts` — Re-exports `claude-restap-cli` (runtime-neutral REST-AP CLI entry)
4. `src/checkins/checkin-api-helpers.ts` — Shared HTTP helpers for manager `/checkins` routes (parse duration, payload validation, response shapes)
5. `src/checkins/checkin-autoclose.ts` — Auto-close hook: when a task hits a terminal status, atomically bulk-closes every active/snoozed checkin linked to that task (`closed_reason='linked_task_terminal'`, clears `next_fire_at`/`snooze_until`) and emits one `checkin:closed` event per pre-close snapshot row. Currently bound by direct call from the task-done route
6. `src/checkins/checkin-service.ts` — Per-team checkin due-service on a 30s tick: hard-expire TTL rows first (`checkin:expired`), re-activate snoozed rows when `snooze_until <= now`, fire due rows (write `news_item` to owner inbox + emit `checkin:due` + advance `next_fire_at`), and call optional `dispatchWake` hook so the manager can wake the owner
7. `src/claude-agent-cli.ts` — Claude agent CLI entrypoint
8. `src/claude-agent-server.ts` — Per-agent REST-AP Express app (`/talk`, `/news`, `/query`, files, schedule, optional XMTP)
9. `src/claude-agent.ts` — Claude agent wrapper and entrypoint [STATUS: PASS] Curated env whitelist, bypassPermissions intentional, no shell execution
10. `src/claude-restap-cli.ts` — Worker REST-AP CLI entrypoint
11. `src/cli/agent-readiness.ts` — `waitForAgentReady`: polls a worker's `/.well-known/restap.json` with a deadline (default 8s timeout, 250ms interval, 750ms per-request) so an `/ask` immediately after `/sync` or `/deploy` does not race the listening port
12. `src/cli/public-commands.ts` — Public-team agent CLI subcommands
13. `src/cli/workspace-sync.ts` — Workspace and deploy sync utilities for the CLI
14. `src/config-parser.ts` — YAML config parsing, parameter substitution, plugin resolution; team-level wallet opt-in / scope fields consumed by deploy + manager
15. `src/core/agent-identifier.ts` — Agent display ID, alias normalization, identity resolution
16. `src/core/agent-service.ts` — Shared agent CRUD operations (DB access)
17. `src/core/config-utils.ts` — `findProjectRoot`, dotenv read helpers
18. `src/core/file-service.ts` — File operations for agent workspace and shared directories
19. `src/core/index.ts` — Core re-exports
20. `src/core/messaging-service.ts` — Message delivery, news items, query management
21. `src/core/registry-service.ts` — Onchain registry lookups and sync
22. `src/core/safe-compare.ts` — Timing-safe string compare for API keys
23. `src/core/team-service.ts` — Team CRUD and port range allocation
24. `src/core/types.ts` — Shared TypeScript types
25. `src/db.ts` — Backward-compatible re-exports to `db/` (`createDb`, `migrateDb`, `getOrCreateTeamId` legacy helper) [STATUS: PASS] Thin facade over modular DB layer; same migration safety as before
26. `src/db/db-adapter.ts` — Abstract DB adapter and connection surface
27. `src/db/db-json.ts` — JSON serialization utilities for round-tripping row blobs
28. `src/db/db-service.ts` — Repository interfaces and composite `Db` type: teams, agents, queries, news, schedules, tasks, events, subscriptions, checkins [STATUS: PASS] Dialect-agnostic app-facing API; implementations in `db/repos/`
29. `src/db/index.ts` — `createDb` / `migrateDb` / factory wiring (Postgres or SQLite, env-driven)
30. `src/db/migrations/postgres.ts` — PostgreSQL DDL, indexes, and additive migrations
31. `src/db/migrations/sqlite.ts` — SQLite schema migrations
32. `src/db/pg-adapter.ts` — PostgreSQL `DbAdapter` implementation
33. `src/db/sqlite-adapter.ts` — SQLite `DbAdapter` implementation
34. `src/db/types.ts` — Row and entity types shared by repos and service interfaces
35. `src/db/repos/postgres/agents-repo.ts` — PostgreSQL `AgentsRepository` implementation
36. `src/db/repos/postgres/checkins-repo.ts` — PostgreSQL checkins table access
37. `src/db/repos/postgres/events-repo.ts` — PostgreSQL `event_log` / events repository
38. `src/db/repos/postgres/news-repo.ts` — PostgreSQL news feed repository
39. `src/db/repos/postgres/queries-repo.ts` — PostgreSQL query/work item repository
40. `src/db/repos/postgres/schedules-repo.ts` — PostgreSQL schedule definition/run tables
41. `src/db/repos/postgres/subscriptions-repo.ts` — PostgreSQL event subscription delivery rows
42. `src/db/repos/postgres/tasks-repo.ts` — PostgreSQL manager tasks (`/tasks` lifecycle)
43. `src/db/repos/postgres/teams-repo.ts` — PostgreSQL team repository
44. `src/db/repos/sqlite/agents-repo.ts` — SQLite `AgentsRepository` implementation
45. `src/db/repos/sqlite/checkins-repo.ts` — SQLite checkins repository
46. `src/db/repos/sqlite/events-repo.ts` — SQLite events / `event_log` repository
47. `src/db/repos/sqlite/news-repo.ts` — SQLite news repository
48. `src/db/repos/sqlite/queries-repo.ts` — SQLite query repository
49. `src/db/repos/sqlite/schedules-repo.ts` — SQLite schedule tables
50. `src/db/repos/sqlite/subscriptions-repo.ts` — SQLite subscriptions
51. `src/db/repos/sqlite/tasks-repo.ts` — SQLite tasks
52. `src/db/repos/sqlite/teams-repo.ts` — SQLite team repository
53. `src/examples/inter-agent-demo.ts` — Inter-agent communication demo
54. `src/examples/multi-agent-demo.ts` — Multi-agent orchestration demo
55. `src/harness/claude-agent-sdk.ts` — Claude Agent SDK runtime (uses `ANTHROPIC_API_KEY`)
56. `src/harness/claude-code-cli.ts` — Claude Code CLI ("Max" plan) harness
57. `src/harness/codex.ts` — OpenAI Codex CLI harness (spawns `codex exec`) [STATUS: PASS] spawn with array args, prompt via stdin, curated env merge
58. `src/harness/cursor-cli.ts` — Cursor `cursor-agent` headless harness (`-p --output-format stream-json`, resume support)
59. `src/harness/index.ts` — Harness factory and re-exports [STATUS: PASS] Factory maps runtime id → harness, exhaustive switch, no hidden dynamic imports for core paths
60. `src/harness/types.ts` — `HarnessType` (includes `cursor-cli`, `public-agent-remote`, …), `HarnessMessage`, `HarnessOptions`
61. `src/human-agent-cli.ts` — Human-in-the-loop agent CLI
62. `src/id-agents-cli.ts` — Main `npm run id-agents` CLI
63. `src/index.ts` — Package index and re-exports
64. `src/inter-agent-skill.ts` — Agent-facing skill documentation generator
65. `src/inter-agent-tools.ts` — Tool definitions for inter-agent comms
66. `src/interactive-agent-cli.ts` — Full-screen interactive CLI: `/ask`, manager bridge, deploy, `/sync`, registry, wallet provisioning commands, manager inbox resolution + readiness waits (`agent-readiness`), public agents, TUI launch, tasks (`HELP_ITEMS` + extended handlers)
67. `src/interactive-agent-server.ts` — CLI’s companion HTTP server (REST-AP and `/remote` for manager delegation)
68. `src/lib/agent-library.ts` — v3 library discovery under `configs/agents` / `configs/skills` (listing only, no deploy)
69. `src/lib/env-hygiene.ts` — Sanitize or validate env for subprocess harnesses
70. `src/lib/fatal-handlers.ts` — Process-level fatal error hooks for long-running services
71. `src/lib/library-inventory.ts` — Library content helpers used by manager `/library/*` routes
72. `src/lib/remote-heartbeat.ts` — Optional heartbeat/telemetry toward manager for remote or long-lived clients
73. `src/lib/ssh-deliver.ts` — SSH-based deploy/delivery for public agents
74. `src/loader-service.ts` — Loader/watcher for auto-starting the manager
75. `src/local-agent-server.ts` — Local per-agent process spawner and lifecycle [STATUS: PASS] Solid lifecycle; `process.env` mutation non-reentrant but one process per agent
76. `src/name-validation.ts` — Team/agent name validation, reserved word list, length and charset rules
77. `src/onchain/idchain-register.ts` — id-cli onchain registration (subnames, endpoints, ERC-8004)
78. `src/org-chart.ts` — YAML org chart from config `org` [STATUS: PASS] Pure, no I/O/DB
79. `src/protocol-defaults.ts` — Injected `CLAUDE.md` / framework protocol block (scheduling, task discipline, output convention)
80. `src/runtime/registry.ts` — Runtime profiles and `resolveRuntime`: includes **`public-agent-remote`** for `public-agent/` HTTP worker endpoints alongside local harness IDs (Cursor, Codex, Claude SDK, …)
81. `src/runtime/types.ts` — `RuntimeId`, `RuntimeProfile`, and validation result types
82. `src/scheduling/schedule-config.ts` — Schedule config parsing/merge from team YAML
83. `src/scheduling/schedule-dispatcher.ts` — Resolves which agents receive a schedule tick and builds payloads
84. `src/scheduling/schedule-evaluator.ts` — Interval and calendar schedule evaluation
85. `src/scheduling/schedule-types.ts` — Schedule/dispatch DTOs shared by scheduler
86. `src/scheduling/scheduler-service.ts` — Manager 30s scheduler service (tied to `Db` and agent resolution)
87. `src/start-agent-manager.ts` — One-shot start script for the manager
88. `src/start-agent-rest-server.ts` — One-shot start for `AgentRestServer` (runtime from `ID_HARNESS` / `HARNESS`, port from `CLAUDE_AGENT_PORT`)
89. `src/start-claude-server.ts` — Legacy name: starts worker (delegates to runtime-agnostic path)
90. `src/sync.ts` — v3 `sync` plan: diff spec vs live agents (deterministic skills/plugin ordering for stable “changed” detection), categories new/changed/removed, deploy reconciliation fields
91. `src/test-claude-agent.ts` — Claude agent smoke test [STATUS: PASS] Clean smoke, minor `as any` in places, not a prod entry
92. `src/tui/App.tsx` — Ink TUI root: navigable views — agents, agent detail, news (+detail), tasks (+detail), calendar, heartbeats (+detail), library agents/skills (+detail); polls manager + library endpoints; global hotkeys per `Footer` (`l`/`s` library slice, no pause hotkey since v0.1.71-beta)
93. `src/tui/api/manager.ts` — TUI `fetch` helpers against manager (agents, news, tasks, events, health)
94. `src/tui/api/types.ts` — DTOs for TUI API responses
95. `src/tui/components/AgentDetail.tsx` — TUI: single agent detail pane
96. `src/tui/components/AgentRow.tsx` — TUI: one row in the agents list
97. `src/tui/components/AgentsTable.tsx` — TUI: main agents table
98. `src/tui/components/CalendarView.tsx` — TUI: schedule/calendar slice
99. `src/tui/components/Footer.tsx` — TUI: per-view footer hints (↑↓ navigation, `t` tasks, `l` agents library table, `s` skills library, `c` calendar, `h` heartbeats, Tab team, `q` quit)
100. `src/tui/components/HeartbeatDetail.tsx` — TUI: heartbeat event detail
101. `src/tui/components/HeartbeatsView.tsx` — TUI: heartbeats list
102. `src/tui/components/LibraryAgentDetail.tsx` — TUI: v3 library agent card
103. `src/tui/components/LibraryAgentsTable.tsx` — TUI: library agents list (NAME + SHAPE columns; trimmed layout vs older wider tables)
104. `src/tui/components/LibrarySkillDetail.tsx` — TUI: skill detail
105. `src/tui/components/LibrarySkillsTable.tsx` — TUI: skills table
106. `src/tui/components/NewsDetail.tsx` — TUI: one news item body
107. `src/tui/components/NewsView.tsx` — TUI: news feed
108. `src/tui/components/StatusStrip.tsx` — TUI: connection / team status strip
109. `src/tui/components/TaskDetail.tsx` — TUI: task detail
110. `src/tui/components/TaskRow.tsx` — TUI: one task row
111. `src/tui/components/TasksTable.tsx` — TUI: tasks table
112. `src/tui/components/TeamsPanel.tsx` — TUI: team list / switch
113. `src/tui/hooks/usePolling.ts` — TUI: polling interval hook
114. `src/tui/index.tsx` — TUI `main` — Ink `render` + iTerm2 flash fix for `log-update`
115. `src/tui/util/colors.ts` — TUI: ANSI color helpers
116. `src/tui/util/format.ts` — TUI: text trunc/format
117. `src/tui/util/memory.ts` — TUI: heap / RSS display for status
118. `src/tui/util/schedule.ts` — TUI: next-run and schedule string helpers
119. `src/wakeup-service/event-producer.ts` — Topic emitters for `event_log`: tasks (`task:claimed`, `task:completed`), queries (`query:delivered`, `query:failed`, `query:expired`), checkins (`checkin:created`, `closed`, `snoozed`, `due`, `expired`). Includes a 280-byte message preview cap; producers do not swallow errors so an event-log failure surfaces alongside the lifecycle write
120. `src/wakeup-service/retention.ts` — `event_log` per-team age/count retention sweep (default 7d / 100k rows, env overrides via `EVENT_LOG_RETENTION_DAYS` / `EVENT_LOG_RETENTION_COUNT`); 5-minute default cadence, wired at boot in `agent-manager-db.ts` (`startEventLogRetentionSweep`)
121. `src/xmtp/ows-signer.ts` — OWS-backed XMTP signer: delegates signing to OWS CLI
122. `src/xmtp/xmtp-messaging.ts` — `XmtpMessaging` (EventEmitter), allowlist, inbound `startQuery`, ENS resolution

---

## B. CLI Commands (`interactive-agent-cli.ts` — `HELP_ITEMS` and other handlers)

> Primary user-facing help is the alphabetized `HELP_ITEMS` array. Additional `/commands` (registry, manager, TUI, etc.) are implemented in the same file. Numbering is local to this section.

1. `/agent <name> rebuild` — Rebuild a single agent
2. `/agent <name> wallet provision` — Provision an OWS wallet for one agent
3. `/agents` — List all agents
4. `/agents rebuild` — Rebuild all agents
5. `/ask [/hey] <agent> <msg>` — Talk to an agent (session continues) [STATUS: PASS] Event-driven session routing, manager proxy for remote
6. `/ask * <msg>` — Broadcast
7. `/clear [agent]` — Clear tool/session state
8. `/delete <agent>` / `/delete *` / `/delete --team <name>` — Remove agents
9. `/deploy <config> [params]` — Create agents from YAML
10. `/help` (or `/h`) — Show help
11. `/output <agent>` — List `output/` files
12. `/artifact <agent> <path>` — Read artifact under `output/`
13. `/news [-l] <agent>` — Poll or list news
14. `/public` and `/public *` subcommands — Public team agents (list, add, register-onchain, remove, chat) [STATUS: REVIEW] See code paths for network/remote surfaces
15. `/register <agent>` — Onchain register via manager
16. `/heartbeat` / heartbeats & `/calendar` — List/add/manage scheduled pings and calendar prompts
17. `/task create|list|assign|done|remove` — Manager task lifecycle
18. `/sync <config> [params]` — Reconcile team with config (add/update/remove) via v3 `sync` engine
19. `/status` — Manager/agent health summary
20. `/update <agent> [--wallet] [--name]` — Update metadata
21. `/wallet <agent> [chain]` — Show wallet
22. `/team` / `/team <name>` / `/teams` / `/team delete` — Team switch and list
23. `/quit` (also `/q`, `/exit`) — Exit
24. `/register-me` / `/register-self` — Register the CLI as an onchain agent
25. `/project` / `/projects` / `/team` / `/teams` — Team/project context (overlaps with 22; see code)
26. `/manager` and `/manager status|reload|health` — Manager connection control
27. `/logs [N]` — Manager activity log
28. `/sync-wallets` — Resync agent wallet fields from deployer
29. `/registry` and `/registry push|pull|set|set-registrar` — Onchain registry helpers
30. `/hey <agent> <msg>` — Like `/ask` with explicit session threading
31. `/cancel <agent>` — Cancel in-flight query on a worker

---

## C. Express Routes — Manager (agent-manager-db.ts)

1. `GET /health` — [STATUS: PASS] Read-only, team context where applicable
2. `GET /library/agents` / `GET /library/agents/:name` / `GET /library/skills` / `GET /library/skills/:name` — v3 library file-backed inventory
3. `GET /agents` — List agents [STATUS: PASS] `agentToResponse` omits `api_key`
4. `GET /agents/status` — Summary [STATUS: PASS] `Promise.allSettled`, bounded timeouts, team header
5. `GET /agents/resolve/:ref` — Name / token / ERC-7930 resolution
6. `GET /agents/by-name/:name` — [STATUS: PASS] Two-stage name resolution, parameterized SQL, team-scoped
7. `GET /agents/:id` — [STATUS: REVIEW] Cross-team read via unscoped get-by-id
8. `GET /agents/:name/news` — [STATUS: REVIEW] Proxy: confirm query string encoding to downstream URL
9. `POST /agents/spawn` — [STATUS: REVIEW] Port allocation, validation (see current handler)
10. `POST /agents/register` — [STATUS: PASS] ID regex, type whitelist, parameterized upsert
11. `POST /agents/:id/metadata` (JSON merge) / `POST /agents/by-name/:name/metadata` — [STATUS: REVIEW] Key whitelist vs arbitrary merge; team scoping differs between routes; compare code
12. `POST /agents/:id/onchain/register` / `POST /agents/:id/onchain/redeliver-identity` / by-name onchain — [STATUS: REVIEW] Cross-team risk on `/:id` routes; signing env from process
13. `POST /agents/:id/model` — Update model
14. `POST /agents/:id/probe` — Liveness/health probe toward worker URL
15. `DELETE /agents/:id` / `DELETE /agents/by-name/:name` — [STATUS: REVIEW / PASS] `DELETE :id` cross-team via db path; by-name has safer team scope and workspace cleanup
16. `GET /logs` — Activity log
17. `POST /talk` — [STATUS: PASS] Async-202, team-scoped, scheduler-aware
18. `POST /schedule` — Internal `mode: "internal"` wake-ups (self-directed work) — [STATUS: see handler; validate schedule payload]
19. `POST /message` — A2A [STATUS: PASS] Timeouts, team-scoped
20. `POST /talk-to` — [STATUS: PASS] Thin wrapper, bounded timeout
21. `POST /news-to` — Fire targeted news to an agent inbox (A2A helper)
22. `POST /news` / `GET /news` — [STATUS: PASS] Parameterized, bounded forward timeouts where applicable
23. `POST /news/archive` — [STATUS: REVIEW] `days` and transactional consistency — confirm current handler
24. `GET /query/:id` — [STATUS: see handler] Polled by CLI/remote; team-scoped resolution in `queries` table
25. `GET|POST /registry/default` / `GET|POST /registry/registrar` — [STATUS: PASS] as in prior pass (parameterized, parseInt for chain)
26. `GET /teams` / `POST /teams` / `PATCH /teams/:name` / `DELETE /teams/:name` — [STATUS: mix] `POST` team name path validation, `DELETE` default-team guard — see `agent-manager-db` around team routes
27. `GET /projects` / `POST /projects` — Aliases for `teams` routes
28. `POST /registry/push` / `POST /registry/pull` — Registry sync
29. `POST /remote` — [STATUS: PASS] Localhost-oriented operator pipe (auth model is deployment-specific)
30. `GET /:tokenId` — [STATUS: REVIEW] Agent lookup by **numeric** `token_id` only (`/^\d+$/`); non-numeric single-segment paths call `next()` so literals (`/events`, `/tasks`, …) resolve to routes registered below — SSRF/proxy risks remain for `/(\d+)/(.+)` wildcard proxy (see handler)
31. `POST /agents/:name/cancel` — [STATUS: PASS] Team-scoped cancel
32. `PATCH /agents/:id/metadata` — (wallet / rename) [STATUS: REVIEW] Cross-team on id route; see handler for accepted fields
33. `POST /tasks` / `GET /tasks` / `GET /tasks/:ref` / `POST /tasks/:ref/claim` / `POST /tasks/:ref/done` / `DELETE /tasks/:ref` — Manager-owned task stream (receipt-style lifecycle)
34. `GET /events` — Team-scoped catch-up read over `event_log` (same auth/team resolution as `/remote` via `teamContextMiddleware` → `getTeam`). **Query:** `since` — exclusive seq cursor (non-negative integer, default `0`); `limit` — page size (positive integer, default `100`, max `1000`); `topics` — optional comma-separated filter; alias tokens (`query:terminal`, `task:status`, `agent:lifecycle`) expand via `TOPIC_ALIASES` to concrete topic names server-side. **JSON body:** `events[]` (seq, team, topic, occurred_at, actor, subject, data), `next_seq`, `replay_truncated`, `earliest_available_seq` — see `output/wakeup-service-design.md`
35. `POST /checkins` — Create checkin (optional `owner`, `linked_task`, intervals, `close_when`, … per `output/checkin-primitive-design.md`)
36. `GET /checkins` — List/filter checkins for team
37. `DELETE /checkins/:id` — Remove checkin row
38. `POST /checkins/:id/close` — Close with reason
39. `POST /checkins/:id/snooze` — Snooze until timestamp / duration — [STATUS: REVIEW] Same team gating as `/events`; handlers in `checkin-api-helpers.ts`
40. `ALL /^\/(\d+)\/(.+)$/` — Regex route: proxy `/<numeric-token>/<subpath>` to the matching agent’s HTTP endpoint (virtual/interactive vs local port); see inline `fetch` proxy — [STATUS: REVIEW] Upstream URL derived from agent row

---

## D. Express Routes — Worker Agent (claude-agent-server.ts)

1. `GET /health` — Trivial liveness; no sensitive data; auth bypass where appropriate [STATUS: PASS]
2. `GET /.well-known/restap.json` / `GET /catalog` / `PATCH /catalog` — REST-AP and catalog: discovery + mutable catalog [STATUS: PASS] (catalog is public-by-design; name/tokenId may be overridden on GET)
3. `POST /talk` / `POST /clear` / `POST /cancel` — LLM, session reset, cancel: `POST /talk` [STATUS: PASS] async 202, query queue, schedule integration; `POST /cancel` checks harness
4. `GET /news` / `POST /news` — Poll and post news [STATUS: PASS] As in prior pass
5. `GET /query/:id` — [STATUS: PASS] Agent-scoped, parameterized
6. `POST /talk-to` — A2A via manager [STATUS: PASS] Localhost / agent URL from manager, bounded max timeout
7. `PATCH /identity` — Update agent identity [STATUS: PASS] Type and body-size checks; 10KB body cap
8. `GET /files/list` — JSON file listing [STATUS: REVIEW] Merges `/tmp` and working directory; exposes all readable files under `/tmp` as in earlier audit
9. `GET /files` — Browser navigation over file roots
10. `POST /files/upload` — Upload to agent workspace (size limit) [STATUS: PASS] `path.basename` traversal protection; UTF-8; auth per local model
11. `USE /files` — `express.static` (includes `/tmp` mount) [STATUS: REVIEW] Serves all of `/tmp` readably when mounted first
12. `USE /files/teams` — Team shared `express.static` [STATUS: PASS] Index disabled; manager path
13. `USE /files/shared` — Back-compat alias to team shared [STATUS: PASS]
14. `POST /schedule` — Receive scheduled work on the worker: validates message + `schedule` object, `noAutoReply` to block loops, `mode: "internal"` for wake-ups
15. `POST /xmtp/send` / `GET /xmtp/status` — XMTP bridge [STATUS: PASS] 503 when disabled; see `skills/xmtp` and `xmtp-messaging.ts` for allowlist and ENS

---

## E. Express Routes — Interactive Server (interactive-agent-server.ts)

1. `GET /.well-known/restap.json` — Catalog
2. `POST /remote` — Remote `id-agents` commands for the CLI [STATUS: REVIEW] `apiKeyValidator` exists in module but is not always wired in the handler; confirm current behavior before relying on it
3. `POST /talk` / `GET /news` / `POST /news` — CLI agent loop: talk + poll + ingest; `POST /news` [STATUS: PASS] Thorough noAutoReply/loop noise filtering; confirm pending-question path if you modify it
4. `POST /schedule` — Queues internal schedule as pending work for the CLI user agent

---

## F. Database Tables (db/migrations/ — postgres.ts / sqlite.ts)

1. `teams` — [STATUS: PASS] (see prior audit: names, default team protection, etc.)
2. `agents` — [STATUS: REVIEW] (plaintext api_key; soft-delete semantics; runtime column)
3. `wallets` — Deprecated private-key storage; prefer OWS
4. `news_items` — [STATUS: FIXED] Transfer bug removed; feed for agents and human
5. `queries` — [STATUS: PASS] Query/work unit with session id
6. `schedule_definitions` / `schedule_targets` / `schedule_runs` — Manager scheduler persistence
7. `tasks` / `task_event_links` — Task lifecycle, optional event linkage
8. `event_log` — Wakeup and audit stream (per-team retention via `wakeup-service/retention.ts`)
9. `subscriptions` / `webhook_delivery_attempts` — Outbound event subscription delivery
10. `checkins` — Repeating attention prompts with snooze, TTL, link to tasks and news

---

## G. XMTP Messaging Subsystem

### Integration (claude-agent-server.ts)

1. XMTP client — Lazy `import()` when OWS or XMTP env present; per-agent DB under `.xmtp/`; inbound `noAutoReply`; replies via normal query result path

### Skill

2. `skills/xmtp/SKILL.md` — `curl` examples for `/xmtp/send` and `/xmtp/status`, ENS and security notes

### Scripts

3. `scripts/check-ens-resolution.mjs` — xid.eth CCIP-Read / viem smoke test; `MAINNET_RPC_URL`

### Security Model

4. Sender allowlist tiers (trusted / open when empty / blocked when non-empty)
5. OWS — Signing never in-process key material when using OWS signer
6. MLS / identity verification for inbound
7. `xmtp_` query prefix and `noAutoReply` isolation for loop prevention

---

## H. Bundled v3 library (`configs/agents/`, `configs/skills/`)

1. `configs/agents/*` — Ship-ready agent bundles (`copywriter`, `devops`, `editor`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `security`, `solidity-security`): each has `CLAUDE.md`, optional `README.md`, nested `skills/<name>/SKILL.md` plus references/scripts — enumerated by `src/lib/agent-library.ts` and `/library/agents*`
2. `configs/skills/*` — Standalone skill packages referenced by YAML `skills:` lists — enumerated by `/library/skills*`
3. Import footprint — Recent history adds hundreds of third-party–style assets under agent bundles (React rulesets, CodeQL refs, etc.); treated as content, not runtime TypeScript

---

## I. Root team YAML & samples (`configs/`)

1. `configs/default.yaml` — Default team recipe (agents + optional wallet blocks); sole tracked default after Apr-17 collapse of legacy presets
2. `configs/demo.yaml` — Compact demo team (`/deploy demo`) at repo root `configs/`; resolves the copywriter library entry
3. `configs/idchain.yaml` — idchain deployment preset for agents sync/library injection defaults
4. `configs/apps.yaml`, `configs/personal.yaml` — Local customization configs (gitignored; the `.example` starters were retired)
5. `configs/coder-demo.yaml`, `configs/composer.yaml`, `configs/cto.yaml`, `configs/cursor-smoke.yaml`, `configs/review.yaml` — Personal/dev-only team presets (composer, CTO seat, cursor smoke harness, review crew, coder demo)
6. `configs/demos/foundry-demo.yaml`, `configs/demos/foundry-codex-demo.yaml`, `configs/demos/foundry-cursor-demo.yaml`, `configs/demos/solidity-dev-team.yaml` — Archived demo team configs (editorial/solidity-security demos consolidated into root `demo.yaml` Apr-25)

---

## J. Documentation (`docs/` + repo root)

1. `docs/guides/sync-command.md` — Canonical v3 `/sync` semantics (reconcile vs deploy)
2. `docs/guides/tui.md` — Terminal dashboard usage
3. `docs/guides/tasks.md` — Manager task lifecycle for operators
4. `docs/guides/interactive-agent.md`, `docs/guides/news-feed.md`, `docs/guides/heartbeats.md`, `docs/guides/agent-outputs.md` — CLI/TUI feature guides
5. `docs/guides/idagents-admin-control.md` — Admin-control skill operator flows (the older `docs/guides/admin-control.md` was deleted Apr-23)
6. `docs/guides/public-team-bootstrap.md`, `docs/public-team-design.md`, `docs/public-team-review-2026-04-18.md` — Public-team architecture and review notes
7. `docs/reference/architecture.md`, `docs/reference/configuration.md`, `docs/reference/harnesses.md`, `docs/reference/database.md`, `docs/reference/id-indexer-api.md` — Reference material aligned with `SYSTEM_ITEMS` (DB schema reference; ID Networks Indexer API for Agent Registry / Smart Credentials)
8. `docs/deployment/hetzner.md`, `docs/deployment/hetzner-setup.md` — Hosting recipes
9. `docs/MODULAR_RUNTIME_PLAN.md`, `docs/research/*` — Planning / research notes
10. `docs/WAKEUP_SERVICE_PLAN.md` — Wakeup-service rollout plan (companion to v1 design); covers event_log / subscriptions / retention staged delivery
11. `docs/SCHEDULING_PLAN.md` — Scheduling subsystem plan (manager-owned scheduler + worker `/schedule` semantics)
12. `docs/SECURITY_AUDIT_NEW_FEATURES.md` — Rolling audit notes for newly landed features (checkin primitive, wakeup service, library/v3, public-team)
13. `docs/erc-draft-agent-identifiers.md` — ERC draft for agent identifier resolution (companion to ERC-7930/onchain registry work)
14. `docs/protocol/*` — Protocol-level specs (REST-AP, message envelope details) referenced from harnesses and skills
15. `CONTRIBUTING.md` — Contributor workflow; references sync/library docs touched in recent releases
16. `README.md`, `QUICKSTART.md` — Repo entrypoints; version/changelog pointers track npm package (`package.json`)
17. `CHANGELOG.md` — Beta release notes (current line: v0.1.79-beta — killAgentProcess narrow guard)
18. `PromptLog.md`, `Logs.md`, `REVIEW_LOG.md`, `SECURITY.md`, `NOTICE`, `LICENSE` — Repo-root governance, release log, prompt log, license/notices

---

## K. Repo-root agent skills (`skills/`)

1. `skills/README.md` — Index: deployed skills (`identity`, `inter-agent`, `catalog`, `wallet`, `xmtp`) vs external (`idagents-admin-control`)
2. `skills/inter-agent/SKILL.md` — Inter-agent messaging + recent checkin attachment/lifecycle documentation [STATUS: docs refreshed in-period]
3. `skills/idagents-admin-control/SKILL.md` + helpers (`admin-session.js` entrypoint, `start-listener.js` reply listener, `management-loop.sh`, `talk-to-manager.sh`, `remote-command.sh`) — Operator bridge for `/remote` workflows
4. `skills/idagents-register-public-agents/SKILL.md` — Register ENS-backed public agents from CI/tools (renamed from `register-public-agents` Apr-22)
5. `skills/task-discipline/SKILL.md` — Mirror of manager task lifecycle expectations for agents (also embedded in `protocol-defaults.ts` for always-on enforcement since v0.1.48-beta)
6. `skills/xmtp/SKILL.md` — XMTP operational guidance for agents (`curl` worker endpoints); complements §G
7. `skills/identity/SKILL.md` — Always-loaded agent identity (name, team, ENS) skill — referenced by `inter-agent` resolution and TUI display
8. `skills/wallet/SKILL.md` — OWS wallet operations (addresses, signing, balances, agent access) — paired with optional `wallet:` block in team YAML
9. `skills/catalog/SKILL.md` — REST-AP catalog updater so agents publish role/expertise/status to manager + peers

---

## L. Root scripts (`scripts/`)

1. `scripts/check-ens-resolution.mjs` — ENS xid.eth CCIP-Read smoke test (viem); pair with XMTP section G
2. `scripts/verify-tui-public.ts` — Verify TUI ↔ manager `/public` surfaces for regression runs
3. `scripts/detect-runtimes.sh` — Discover installed harness CLIs on PATH for diagnostics
4. `scripts/test-longpoll.sh` — Long-poll integration harness helper
5. `scripts/fix-xmtp-bindings.sh` — Repair XMTP native bindings when installs drift
6. `scripts/deploy-manager.sh`, `scripts/setup-hetzner.sh` — Deployment helpers for operators
7. `scripts/register-team.ts` — Utility registration helper for teams/agents (script-time)
8. `scripts/id-loader.service` — systemd unit for the loader/watcher (`Restart=always`, port 3100); referenced by Hetzner deployment guide
9. `scripts/dev-poetry.yaml`, `scripts/poet-series.yaml`, `scripts/poetry-research.yaml`, `scripts/example.yaml` — Sample team configs co-located with scripts (manual deploy/test recipes, not part of the canonical `configs/` set)

---

## M. Public-agent runtime (extracted to standalone Juno repo)

The public-facing agent runtime that previously lived under `public-agent/` was **extracted to a standalone repo (Juno)** in commit `58cc1f8` on 2026-04-19. There is no longer a `public-agent/` subtree in this repo — the build artifacts, REST routes, OpenRouter adapter, MCP shim, knowledge-base tooling, and Dockerfiles are all maintained in the Juno repo.

What remains in this repo:

1. `runtime: public-agent-remote` — Runtime profile in `src/runtime/registry.ts` that points the manager + CLI at remote Juno endpoints (deploy, register, heartbeat-probe, SSH delivery)
2. `src/lib/ssh-deliver.ts`, `src/lib/remote-heartbeat.ts` — Operator-side delivery + ad-hoc probing for remote Juno instances
3. `src/cli/public-commands.ts` + `/public` subcommands in interactive CLI — Operator UX for managing remote Juno agents (list, register, register-onchain, chat)
4. `docs/public-team-design.md`, `docs/public-team-review-2026-04-18.md`, `docs/guides/public-team-bootstrap.md` — Architecture, review notes, and bootstrap runbook (stable references to the now-external runtime)
5. `skills/idagents-register-public-agents/SKILL.md` — Skill for registering ENS-backed Juno agents from CI/tools

---

## N. Tests (`tests/`)

Layout: `tests/integration/` (39 files), `tests/unit/` (24 files), `tests/repos/` (6 files), `tests/helpers/` (shared `manager-client.ts` etc.), plus `tests/pty-flicker.py` standalone TUI smoke. The list below samples integration suites from recent churn — representative, not exhaustive.

1. `tests/integration/wakeup-service-events-read.test.ts`, `tests/integration/team-isolation.test.ts` — `GET /events` catch-up and subscription wiring
2. `tests/integration/checkins-api.test.ts`, `checkin-due-service.test.ts`, `checkin-e2e.test.ts`, `checkin-task-autoclose.test.ts`, `checkin-talkto-autoattach.test.ts`, `checkin-service-boot.test.ts`, `checkin-priority-wake.test.ts` — Checkin primitive + boot/priority edges
3. `tests/integration/query-failed-event.test.ts` — `query:failed` / wakeup producer alignment with manager lifecycle
4. `tests/integration/event-log-retention.test.ts` — Retention sweep semantics against live repos
5. `tests/integration/sync-command.test.ts` — `/sync` deterministic diff + CLI wiring
6. `tests/integration/wallet-opt-in*.test.ts`, `tests/integration/manager-inbox-resolution.test.ts`, `tests/integration/agents-changed.test.ts` — Wallet opt-in + inbox/readiness flows
7. `tests/integration/library-routes.test.ts` — Manager `/library/agents` & `/library/skills` HTTP contracts
8. `tests/integration/workspace-sync.test.ts` — Workspace / deploy sync paths (`cli/workspace-sync`)
9. `tests/integration/codex-spawn-personality-refresh.test.ts` — Codex harness spawn + metadata refresh
10. `tests/integration/news-reply-triggers-receiver.test.ts` — News fan-out / receiver triggers
11. **Further integration suites** — Auth/config/redaction (`api-key-auth`, `require-auth-config`, `secret-hygiene`, `response-redaction`, `ssh-target-log-redaction`); remote/mesh (`remote-runtime`, `remote-heartbeat`, `remote-commands`, `mesh-membership`, `external-client`, `admin-mesh-bypass-remote-blocked`); registry/public (`registry-pull-discovery`, `public-onchain`, `cli-public-register`); agents (`agent-lifecycle`, `agent-capabilities`, `agent-relay`, …); heartbeat (`heartbeat-separation`); A2A reply correlation (`talk-to-reply-qid`). The integration directory currently holds **39** files — treat this list as sampling, not exhaustive.
12. **Unit tests (`tests/unit/`, 24 files)** — Pure-function and small-surface checks: `agent-manager-process-guard`, `agent-manager-wallet`, `agent-readiness`, `artifact-traversal`, `bulk-delete`, `cursor-cli-parser`, `deployer-address-null`, `env-hygiene`, `event-log-retention`, `fatal-handlers`, `heartbeat`, `merge-defaults-register`, `name-validation`, `news-trigger-default`, `protocol-defaults`, `runtime-paths`, `runtime-registry`, `sub-agent-template`, `sync-diff`, `team-config-parser`, `team-delete-safety`, `wallet-opt-in`
13. **Repo / schema tests (`tests/repos/`, 6 files)** — Direct repo + migration coverage: `migration.test.ts`, `checkins-schema.test.ts`, `find-interactive-determinism.test.ts`, `wakeup-service-schema.test.ts`, `wakeup-service-producers.test.ts`, `wakeup-service-checkin-events.test.ts`

---

## O. Binaries (`bin/`)

1. `bin/id-agents` — Symlink-style npm bin entry resolving to `dist/interactive-agent-cli.js` (per `package.json` `bin.id-agents`); the local `bin/id-agents` symlink target is the globally-installed copy under `lib/node_modules/id-agents/dist/interactive-agent-cli.js`
2. `id-agents-dashboard` — Second `package.json` bin entry → `dist/tui/index.js` (Ink TUI from `src/tui/index.tsx`); not present as a tracked file under `bin/`, only published via npm bin map

---

## P. Tools (`tools/`)

1. `tools/test-manager/index.js` — Standalone in-memory REST-AP manager (no DB) for testing agent communication outside the full CLI infra: external agent registration by URL, `/talk-to`, `/talk`, `/news`, discovery, ping; runs as `node tools/test-manager/index.js [--port=N]` (default 5000)
2. `tools/test-manager/README.md` — Operator/dev usage doc for the test manager (paired with `scripts/test-longpoll.sh` for long-poll smoke runs)

---

## Progress Log — 2026-04-28 exhaustive 14-day audit (`systemitems-exhaustive-audit`)

**Scope:** every commit from 2026-04-14 through 2026-04-28 inclusive (covers v0.1.43-beta → v0.1.79-beta and the public-agent → Juno extraction).

**Numbers:**
- **Commits walked:** 290 (one-line summary captured to `/tmp/sysaudit.log`, 1916 lines incl. file-status rows).
- **Unique paths touched:** 615 — 532 still present in the tree, 83 deleted.
- **Top buckets touched (extant):** `configs/` 337 (mostly v3 library bundle import), `src/` 83, `tests/` 66, `docs/` 21, `skills/` 10, `scripts/` 3, plus repo-root governance files.
- **Top buckets deleted:** `public-agent/` 62 (extracted to standalone Juno repo, commit `58cc1f8`), legacy `configs/` 16 (`apps.yaml.example`, `personal.yaml.example`, `claude-code.yaml`, `codex*.yaml`, `default-mixed.yaml`, `demo-codex.yaml`, `example-team.yaml`, `xmtp-test.yaml`, `claudeMd-{manager,pm}.md`, `demos/{editorial,solidity-security}*`), `src/tui/components/{Header,NewsPanel,TasksStatusStrip}.tsx` (refactored into newer `App.tsx` + per-view components), `docs/guides/admin-control.md` (replaced by `idagents-admin-control.md`), root `HEARTBEAT.yaml` (retired in favor of agent-driven `HEARTBEAT.md`).
- **Gaps closed in this pass:** 4 — (1) deleted `docs/guides/admin-control.md` reference removed from §J, (2) `docs/reference/database.md` + `docs/reference/id-indexer-api.md` added to §J, (3) `admin-session.js` + `start-listener.js` enumerated under §K idagents-admin-control entry, (4) §N expanded from integration-only to full `tests/` tree (added items 12 unit, 13 repos).
- **Descriptions tightened/clarified in this pass:** 0 net new beyond take-4 (already done in prior pass: items 5, 6, 11, 119, 120 in §A; bin/tools entries in §O/§P; `frontend` bundle in §H).
- **Verifications performed (no edit needed — already accurate):** §A 1:1 reconcile against `find src` (122/122); §C route table cross-checked against 60 route registrations in `agent-manager-db.ts`; magic numbers re-confirmed by reading source (checkin-service, retention, event-producer, agent-readiness); skill listings against `find skills`; doc listings against `find docs`; configs/agents bundles (`copywriter`, `devops`, `editor`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `security`, `solidity-security` — 9 bundles); §M Juno extraction confirmed by 62 deleted `public-agent/` paths in this window.
- **Per-commit-cluster reasoning notes (semantic groupings, not 1:1 commit list):**
  1. **Wakeup-service v1 (commits `9413f05` → `80ac4c7`, ~6 commits):** event_log + subscriptions schema/repos, task/query lifecycle producers, GET /events catch-up, event_log retention sweep. All landing src files already in §A items 119, 120 + §F item 8 + §C items 34. Doc `docs/WAKEUP_SERVICE_PLAN.md` → §J item 10.
  2. **Checkin primitive (commits `8be7924` → `7f6ddef`, ~9 commits):** checkins table + repo, lifecycle event producers, REST API (create/list/close/snooze), due-service tick loop, /talk-to auto-attach, task-terminal auto-close, end-to-end test, inter-agent SKILL doc. Landing src files in §A items 4, 5, 6 + §C items 35-39 + §F item 10. Tests in §N items 2.
  3. **v3 agent-config library (commits `0d86099` → `a21cd0f`, ~15 commits):** library enumerators, config-parser direct library resolve, runtime-aware sync remap, codex/cursor sync mapping, undeploy + CLI exit-code, slice-7 library inventory endpoints, slice-8 TUI library browser views. Landing src files in §A items 14, 68, 71, 90 + §C items 2 + §H items 1, 2 + TUI components §A 102-105.
  4. **Public-agent → Juno extraction (commit `58cc1f8` and runup `08661e5` → `8829ad6`, ~30 commits):** entire `public-agent/` subtree moved to standalone repo. What remains is captured in §M; new doc `public-team-design.md` and `public-team-review-2026-04-18.md` already in §J item 6 / §M item 4.
  5. **Wallet opt-in (commits `2587e85` + `1fde264d`-related, ~3 commits):** team YAML wallet block + on-demand provisioning. Touches `src/config-parser.ts` (§A 14) + `src/agent-manager-db.ts` (§A 1) + interactive-agent-cli (§A 66). Tests in §N item 6.
  6. **Manager hardening (commits `9297d92` `72a4ac1` `6cd8369` `8947c4f`, ~5 commits):** killAgentProcess self-PID guard / narrow-rebuild guard, manager-inbox resolution + CLI re-register on team switch, DELETE /teams SQLite crash fix, deterministic skills diff in /sync. Captured in §A item 1 description + §C item 26 + §A item 11 (agent-readiness probe).
  7. **TUI dashboard build-out (commits `a9025f6` → `5db1434`, ~30 commits):** Ink/React shell, agents/news/tasks/calendar/heartbeats/library views, status strip, footer, flicker fixes. Landing src files in §A items 92-118.
  8. **Cursor CLI runtime (commits `1c3dd10` `7a6a737e` `a8eed57f`, ~5 commits):** new harness alongside Codex/Claude SDK. §A item 58 + §A item 60 + §A item 80 (runtime registry).
  9. **Inter-agent / news (commits `93f03a5` `8436a2b` `1abedb9` and surrounding):** /news-to endpoint, GET /query/:id polling, two-verb skill rewrite, daemon-only dispatch, news kind/reply_expected metadata, since_id cursor. Landing src files in §A items 1, 8, 20, 64, 65 + §C items 21, 24.
  10. **Task lifecycle (commits `8a105f4` `3d30d64` `9624b23`):** GET /query/:id, manager task subset, short UUID handle, task-discipline skill + always-on protocol injection. §A items 33 (route §C) + §K item 5 + §A item 79.
- **Files with no SYSTEM_ITEMS entry — judged as ephemera and intentionally NOT added:** `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `tests/helpers/manager-client.ts` (test-only helper), `tests/pty-flicker.py` (one-off PTY check), `src/tui/tsconfig.json` (build config), `Logs.md` (gitignored runtime log), `configs/personal.yaml` / `configs/apps.yaml` (already noted as gitignored in §I item 4).

