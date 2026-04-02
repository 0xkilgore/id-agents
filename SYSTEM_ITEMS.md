# System Items — id-agents

> Audit inventory of the id-agents codebase. One line per item, numbered sequentially, grouped by category.

Generated: 2026-03-24
Updated: 2026-04-02

---

## A. Source Files

1. `src/agent-manager-db.ts` — Manager service: agent registry, orchestration, all manager REST endpoints, WebSocket server
2. `src/claude-agent-server.ts` — Worker agent REST-AP server (per-agent Express app with /talk, /news, /files)
3. `src/claude-agent.ts` — Claude agent wrapper and entrypoint logic [STATUS: PASS] Curated env whitelist, bypassPermissions intentional, no shell execution
4. `src/claude-agent-cli.ts` — Claude agent CLI entrypoint
5. `src/claude-restap-cli.ts` — Claude REST-AP CLI entrypoint
6. `src/config-parser.ts` — YAML config parsing, parameter substitution, plugin resolution
7. `src/db.ts` — PostgreSQL schema, migrations, connection pool [STATUS: PASS] Idempotent migration chain, parameterized queries, safe FK cascades; silent catch in port backfill, no Pool tuning
8. `src/human-agent-cli.ts` — Human-in-the-loop agent CLI
9. `src/id-agents-cli.ts` — Main CLI entrypoint (npm run id-agents)
10. `src/index.ts` — Package index and re-exports
11. `src/inter-agent-skill.ts` — Agent-facing skill documentation generator
12. `src/inter-agent-tools.ts` — Agent tool definitions for inter-agent communication
13. `src/interactive-agent-cli.ts` — Interactive terminal CLI (commands, readline, prompt, all /commands)
14. `src/interactive-agent-server.ts` — CLI's HTTP server (REST-AP endpoints for the interactive agent)
15. `src/loader-service.ts` — Loader/watchdog service for auto-starting and monitoring manager
16. `src/local-agent-server.ts` — Local agent process spawner and lifecycle manager [STATUS: PASS] Solid lifecycle manager; process.env mutation is non-reentrant but safe in practice since each agent is a separate process
17. `src/start-agent-manager.ts` — Manager startup script
18. `src/start-claude-server.ts` — Worker agent startup script
19. `src/test-claude-agent.ts` — Test/demo script for Claude agent [STATUS: PASS] Clean smoke test, minor `as any` cast and stale pricing strings, no functional issues
20. `src/core/agent-identifier.ts` — Agent display ID, alias normalization, identity resolution
21. `src/core/agent-service.ts` — Shared agent CRUD operations (DB queries)
22. `src/core/config-utils.ts` — Config utilities (findProjectRoot, readDotEnvFile)
23. `src/core/erc7930.ts` — ERC-7930 interoperable address encoding/decoding [STATUS: REMOVED] Source deleted, stale dist/ output remains; dead code
24. `src/core/file-service.ts` — File operations for agent workspace and shared directories
25. `src/core/index.ts` — Core module re-exports
26. `src/core/messaging-service.ts` — Message delivery, news items, query management
27. `src/core/registry-service.ts` — Onchain registry lookups and sync
28. `src/core/safe-compare.ts` — Timing-safe string comparison for API keys
29. `src/core/team-service.ts` — Team CRUD and port range allocation
30. `src/core/types.ts` — Shared TypeScript type definitions
31. `src/harness/claude-agent-sdk.ts` — Claude Agent SDK runtime (uses ANTHROPIC_API_KEY)
32. `src/harness/claude-code-cli.ts` — Claude Code CLI runtime (uses Max plan subscription)
33. `src/harness/index.ts` — Harness module re-exports and factory [STATUS: PASS] Pure factory, exhaustive switch, no dynamic imports
34. `src/harness/types.ts` — Harness type definitions (HarnessMessage, etc.)
35. `src/onchain/idchain-register.ts` — Onchain registration via id-cli (register, subnames, endpoints)
36. `src/examples/inter-agent-demo.ts` — Inter-agent communication demo
37. `src/examples/multi-agent-demo.ts` — Multi-agent orchestration demo
38a. `src/org-chart.ts` — Org chart generator from YAML config org section [STATUS: PASS] Pure function module, no IO/DB/network/shell
38b. `src/harness/codex.ts` — OpenAI Codex CLI harness (spawns `codex exec` processes) [STATUS: PASS] spawn() with array args, prompt via stdin pipe, curated env merge
38c. `src/db/db-service.ts` — Database service interface (repository contracts for teams, agents, queries, news, schedules)
38d. `src/db/db-adapter.ts` — Database adapter abstraction layer
38e. `src/db/pg-adapter.ts` — PostgreSQL adapter implementation
38f. `src/db/sqlite-adapter.ts` — SQLite adapter implementation
38g. `src/db/db-json.ts` — JSON serialization utilities for DB
38h. `src/db/migrations/postgres.ts` — PostgreSQL schema migrations (DDL, indexes, column additions)
38i. `src/db/migrations/sqlite.ts` — SQLite schema migrations
38j. `src/db/repos/postgres/agents-repo.ts` — PostgreSQL agents repository (CRUD, resolve, upsert)
38k. `src/db/repos/postgres/news-repo.ts` — PostgreSQL news repository (add, poll, archive, delete)
38l. `src/db/repos/postgres/queries-repo.ts` — PostgreSQL queries repository (create, complete, upsert)
38m. `src/db/repos/postgres/teams-repo.ts` — PostgreSQL teams repository (getOrCreate, config, registry)
38n. `src/db/repos/postgres/schedules-repo.ts` — PostgreSQL schedules repository
38o. `src/xmtp/xmtp-messaging.ts` — XMTP messaging service: XmtpMessaging class (extends EventEmitter), inbound/outbound message handling, sender allowlist persisted to `.xmtp/allowlist.yaml`, ENS resolution via id-cli for xid.eth names with web3.bio fallback, approval callbacks for human-in-the-loop gating, OWS wallet or raw key signing
38p. `src/xmtp/ows-signer.ts` — OWS-backed XMTP signer: creates XMTP Signer interface that delegates all signing to OWS CLI (`ows sign message`), private key never leaves OWS vault, resolves wallet address via `ows wallet list`

---

## B. CLI Commands (interactive-agent-cli.ts)

38. `/agent <name> rebuild` — Rebuild a single agent
39. `/agents` — List all agents
40. `/agents rebuild` — Rebuild all agents
41. `/ask [/hey] <agent> <msg>` — Talk to agent (continues session) [STATUS: PASS] Event-driven pattern with session continuity, broadcast wildcard, smart remote routing via manager proxy
42. `/ask * <msg>` — Broadcast to all agents
43. `/clear [agent]` — Clear session (start fresh)
44. `/delete <agent>` — Delete agent by name or id
45. `/deploy <config> [params]` — Deploy agents from config
46. `/help` — Show help menu
47. `/news [-l] <agent>` — Check recent messages (-l for full content)
48. `/register <agent>` — Register agent onchain
49. `/status` — Check agent status
50. `/quit` — Exit
51. `/team` — Show current team info
52. `/teams` — List all teams
53. `/team <name>` — Switch to or create team
54. `/team rebuild` — Rebuild manager
55. `/team delete <name>` — Delete a team
56. `/registry` — Show default onchain registry
57. `/registry push` — Push agents to registry
58. `/registry pull <ids>` — Pull agents from registry
59. `/registry set <chainId> <addr>` — Set registry config
60. `/registry set-registrar <addr>` — Set registrar address
61. `/manager` — Manager connection control
62. `/manager status` — Check manager connection status
63. `/manager reload` — Reconnect WebSocket
64. `/manager health` — Check manager health endpoint
65. `/logs [N]` — Show manager activity log
66. `/cancel <agent>` — Cancel running query
67. `/heartbeats` — Heartbeat monitoring
68. `/register-me` — Register CLI agent onchain [STATUS: PASS] Solid self-registration with stable ID persistence and idempotent upsert
69. `/news top <agent>` — Show last few messages
70. `/news archive [days]` — Archive old news to files
70a. `/wallet <agent>` — Manage agent wallets (view address, balance)
70b. `/update <agent> <field> <value>` — Update agent metadata fields
70c. `/sync-wallets` — Sync wallet addresses from deployer key

---

## C. Express Routes — Manager (agent-manager-db.ts)

71. `GET /health` — Manager health check [STATUS: PASS] Minimal read-only, no sensitive data, team-scoped
72. `GET /agents` — List all agents [STATUS: PASS] Team-scoped, agentToResponse omits api_key
73. `GET /agents/status` — Agent status summary [STATUS: PASS] Bounded timeouts on health pings, Promise.allSettled, team-scoped
74. `GET /agents/resolve/:ref` — Resolve agent by name, tokenId, or ERC-7930
75. `GET /agents/by-name/:name` — Get agent by name [STATUS: PASS] Parameterized SQL, two-stage resolution (exact then flexible), team-scoped, read-only
76. `GET /agents/:id` — Get agent by ID [STATUS: REVIEW] Cross-team leak: getById ignores teamId param, any team can read any agent by ID
77. `GET /agents/:name/news` — Get news items for specific agent [STATUS: REVIEW] Query params interpolated raw into proxied URL without encodeURIComponent
78. `POST /agents/spawn` — Spawn a new agent process [STATUS: REVIEW] Triple metadata UPDATE, no name format validation, non-atomic port allocation
79. `POST /agents/register` — Register agent in database [STATUS: PASS] Good ID format regex, type whitelist, stable ID sanitization, parameterized upsert
80. `POST /agents/:id/metadata` — Update agent metadata by ID [STATUS: REVIEW] Arbitrary JSON merge with no key whitelist; cross-team via dbQueryAgentById
81. `POST /agents/by-name/:name/metadata` — Update agent metadata by name [STATUS: REVIEW] Same arbitrary JSON merge as #80, but correctly team-scoped; syncs to running server identity
82. `POST /agents/:id/onchain/register` — Register agent onchain by ID [STATUS: REVIEW] Cross-team via dbQueryAgentById; signing keys from env (safe), execFile (safe)
83. `POST /agents/by-name/:name/onchain/register` — Register agent onchain by name
84. `POST /agents/:id/model` — Change agent model
85. `POST /agents/by-name/:name/move` — Move agent to different team [STATUS: REMOVED] Deleted — team transfers not supported; contained buggy news_items copy query (item 136)
86. `DELETE /agents/:id` — Delete agent by ID [STATUS: REVIEW] Cross-team via dbQueryAgentById; workspace rmSync safely path-guarded
87. `DELETE /agents/by-name/:name` — Delete agent by name [STATUS: PASS] Safe workspace cleanup with path guard, cascading DB delete; empty catch blocks unlike sibling route (minor)
88. `POST /talk` — Send message to manager (triggers LLM) [STATUS: PASS] Clean async-202 pattern, team-scoped
89. `POST /message` — Agent-to-agent messaging (fire-and-forget or wait) [STATUS: PASS] Bounded timeouts, team-scoped resolution
90. `POST /talk-to` — Alias for /message with wait:true [STATUS: PASS] Thin wrapper, timeout bounded 1s-24h
91. `POST /news` — Receive reply or post news item [STATUS: PASS] Parameterized DB ops, bounded 5s forward timeout, team-scoped
92. `GET /news` — Poll for manager news updates [STATUS: PASS] Safe parameterized poll with dynamic $N placeholders
93. `POST /news/archive` — Archive old news items [STATUS: REVIEW] SELECT+DELETE not transactional, no bounds on `days` param
94. `GET /registry/default` — Get default onchain registry config [STATUS: PASS] Read-only, team-scoped, parameterized query
95. `POST /registry/default` — Set default onchain registry config [STATUS: PASS] Parameterized jsonb_set, parseInt validation on chainId
96. `GET /registry/registrar` — Get registrar address [STATUS: PASS] Read-only, team-scoped, returns public address only
97. `POST /registry/registrar` — Set registrar address [STATUS: PASS] Team-scoped, parameterized config update, no format validation but stored as inert text
98. `POST /registry/push` — Push local agents to onchain registry
99. `POST /registry/pull` — Pull agents from onchain registry
100. `GET /teams` — List all teams [STATUS: PASS] Read-only, no secrets exposed, intentionally cross-team for management
101. `POST /teams` — Create a team [STATUS: REVIEW] No validation on team name — path traversal via mkdirSync(teams/${name})
102. `PATCH /teams/:name` — Update team config [STATUS: PASS] Vestigial no-op stub, no mutation
103. `DELETE /teams/:name` — Delete a team [STATUS: PASS] Default team protection added (line 1411), soft-deleted agents cascade-deleted by design
104. `GET /projects` — List projects (alias for teams)
105. `POST /projects` — Create project (alias for teams)
106. `GET /logs` — Get manager activity log
107. `POST /remote` — Execute CLI commands via API (no auth, localhost only) [STATUS: PASS] Auth intentionally removed; servers bind 127.0.0.1
108. `GET /:tokenId` — Reverse-proxy to agent by tokenId [STATUS: REVIEW] SSRF via virtual agent endpoints, leaks API key to user-controllable URL
109. `POST /agents/:name/cancel` — Cancel agent query [STATUS: PASS] Team-scoped, bounded timeout

109a. `PATCH /agents/:id/metadata` — Update agent wallet/name by ID [STATUS: REVIEW] Cross-team via dbQueryAgentById; accepts wallet_address and name rename without validation

---

## D. Express Routes — Worker Agent (claude-agent-server.ts)

110. `GET /health` — Worker health check [STATUS: PASS] Trivial, no sensitive data, auth correctly bypassed
111. `GET /.well-known/restap.json` — REST-AP catalog (endpoint discovery) [STATUS: PASS] Clean discovery endpoint, correct auth bypass, comprehensive capability docs, catalog spread is public-by-design
112. `GET /catalog` — View agent catalog metadata [STATUS: PASS] Clean read-only endpoint with identity overlay, properly synced to DB and restap.json
113. `PATCH /catalog` — Update agent catalog metadata [STATUS: PASS] Arbitrary keys accepted but catalog is public-by-design; name/tokenId overridden on GET
114. `POST /talk` — Send message to agent (triggers LLM) [STATUS: PASS] Async 202 pattern, serialized query queue prevents concurrency issues, proper session continuity and auto-reply logic
115. `POST /clear` — Clear agent session [STATUS: PASS] Trivial session reset, no user input consumed
116. `POST /cancel` — Cancel running query [STATUS: PASS] Graceful harness capability check
117. `GET /news` — Poll agent news feed [STATUS: PASS] Parameterized poll, safe parseInt, bounded character-range pagination
118. `POST /news` — Receive reply or post news item [STATUS: PASS] noAutoReply loop prevention, waiter resolution, parameterized DB writes
119. `GET /query/:id` — Get query status by ID [STATUS: PASS] Agent-scoped, parameterized queries
120. `POST /talk-to` — Agent-to-agent via worker (forwards to manager) [STATUS: PASS] Localhost-only guard, bounded timeout 10min max, agent URL from manager list
121. `PATCH /identity` — Update agent identity [STATUS: PASS] Fixed: added type validation (string/object checks) and 10KB body limit to prevent abuse
122. `GET /files/list` — List available files [STATUS: REVIEW] Recursively lists /tmp directory, exposing all readable temp files
123. `GET /files` — Browse files
124. `POST /files/upload` — Upload file to agent (50MB limit) [STATUS: PASS] Clean traversal protection via path.basename, UTF-8 only, auth consistent with local-first model
125. `USE /files` — Static file serving (working directory) [STATUS: REVIEW] Also serves entire /tmp directory
126. `USE /files/teams` — Static file serving (team shared directory) [STATUS: PASS] Manager-assigned path, express.static traversal protection, index disabled
127. `USE /files/shared` — Static file serving (global shared directory) [STATUS: PASS] Backwards-compat alias for /files/teams
127a. `POST /schedule` — Receive scheduled work (worker agent) — Validates message and schedule object, mode must be 'internal', noAutoReply to prevent loops
127b. `POST /xmtp/send` — Send an encrypted XMTP message to any ENS name or wallet address; requires `to` and `message` body fields; returns 503 if XMTP not enabled for this agent; resolves ENS names via id-cli (xid.eth) and web3.bio (other names)
127c. `GET /xmtp/status` — Check if XMTP is enabled for this agent; returns `{ enabled, address }`

---

## E. Express Routes — Interactive Server (interactive-agent-server.ts)

128. `GET /.well-known/restap.json` — CLI agent REST-AP catalog
129. `POST /remote` — Remote command execution for CLI [STATUS: REVIEW] apiKeyValidator exists but never called in handler
130. `POST /talk` — Send message to CLI agent
131. `GET /news` — Poll CLI agent news
132. `POST /news` — Receive reply to CLI agent [STATUS: PASS] Solid passive ingest with thorough loop/noise filtering, minor dead-code nit in pending-question block
132a. `POST /schedule` — Receive scheduled work (interactive server) — Validates message and schedule metadata, queues as pending query

---

## F. Database Tables (db.ts, db/migrations/)

133. Table `teams` — Namespace/tenant config (id, name, config jsonb, port_start, port_end) [STATUS: PASS] UUID PKs, UNIQUE NOT NULL on name, idempotent upsert, default team deletion blocked
134. Table `agents` — Agent registry (team_id, id, name, type, model, port, endpoint, status, registry jsonb, metadata jsonb, token_id, api_key, runtime) [STATUS: REVIEW] api_key stored as plaintext; no partial UNIQUE on (team_id, name) for active agents
135. Table `wallets` — Agent Ethereum wallets [deprecated] (team_id, agent_id, address, private_key)
136. Table `news_items` — Async message feed (team_id, agent_id, timestamp, type, message, data jsonb, query_id) [STATUS: FIXED] Bug resolved — deleted the broken transfer function (item 85) that referenced non-existent columns
137. Table `queries` — Work/request tracking (team_id, agent_id, query_id, status, prompt, result jsonb, session_id) [STATUS: PASS] Composite PK, parameterized ops, team-scoped via FK cascade

---

## G. XMTP Messaging Subsystem

### Integration (claude-agent-server.ts)

138. XMTP client lifecycle (lines 1638–1716) — Per-agent XMTP client started automatically when `OWS_WALLET` or `XMTP_WALLET_KEY` + `XMTP_DB_ENCRYPTION_KEY` env vars are present; dynamic `import()` to avoid loading native bindings when XMTP is not configured; DB stored at `.xmtp/<env>-<port>.db3` in agent's working directory; inbound messages routed through `startQuery()` with `noAutoReply: true` to prevent auto-reply loops; query results polled at 1s interval with 5min timeout and sent back as XMTP reply

### Skill

139. `skills/xmtp/SKILL.md` — Agent skill for XMTP messaging; instructs agents to use `curl` against `/xmtp/send` and `/xmtp/status` endpoints; documents ENS name and wallet address resolution, inbound message flow, and security properties

### Config

140. `configs/xmtp-test.yaml` — Test team config with two agents (alice, bob) for XMTP encrypted messaging tests; uses claude-code-cli runtime, claude-sonnet-4-6 model, includes identity/inter-agent/catalog/xmtp skills

### Scripts

141. `scripts/check-ens-resolution.mjs` — ENS resolution test script; resolves xid.eth names via CCIP-Read using viem; defaults to checking alice/bob agent-23/24 subnames; configurable via `MAINNET_RPC_URL` env var

### Security Model

142. XMTP sender allowlist — Three-tier trust model: **trusted** (on allowlist → auto-accepted, bypasses approval callback), **unknown** (not on allowlist but allowlist is empty → goes through approval callback), **blocked** (not on allowlist when allowlist is non-empty → silently dropped before content reaches agent LLM). Allowlist persisted to `.xmtp/allowlist.yaml` with ENS names for readability. Resolved addresses stored lowercase.
143. OWS signing — Private key never leaves OWS vault; all XMTP signing delegated to `ows sign message` CLI; agent address resolved from `ows wallet list` output; Signer interface uses dummy key for identifier (signing is real via OWS)
144. MLS encryption — All XMTP messages are end-to-end encrypted via MLS (Messaging Layer Security) protocol; sender identity cryptographically verified before message content is exposed to approval callback or agent LLM
145. Inbound message isolation — `noAutoReply: true` flag on inbound XMTP queries prevents the agent from triggering auto-reply chains; query ID prefixed with `xmtp_` for traceability; sender address included in prompt for LLM context
