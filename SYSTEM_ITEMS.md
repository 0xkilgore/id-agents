# System Items — id-agents

> Audit inventory of the id-agents codebase. One line per item, numbered sequentially, grouped by category.

Generated: 2026-03-24

---

## A. Source Files

1. `src/agent-manager-db.ts` — Manager service: agent registry, orchestration, all manager REST endpoints, WebSocket server
2. `src/claude-agent-server.ts` — Worker agent REST-AP server (per-agent Express app with /talk, /news, /files)
3. `src/claude-agent.ts` — Claude agent wrapper and entrypoint logic
4. `src/claude-agent-cli.ts` — Claude agent CLI entrypoint
5. `src/claude-restap-cli.ts` — Claude REST-AP CLI entrypoint
6. `src/config-parser.ts` — YAML config parsing, parameter substitution, plugin resolution
7. `src/db.ts` — PostgreSQL schema, migrations, connection pool
8. `src/human-agent-cli.ts` — Human-in-the-loop agent CLI
9. `src/id-agents-cli.ts` — Main CLI entrypoint (npm run id-agents)
10. `src/index.ts` — Package index and re-exports
11. `src/inter-agent-skill.ts` — Agent-facing skill documentation generator
12. `src/inter-agent-tools.ts` — Agent tool definitions for inter-agent communication
13. `src/interactive-agent-cli.ts` — Interactive terminal CLI (commands, readline, prompt, all /commands)
14. `src/interactive-agent-server.ts` — CLI's HTTP server (REST-AP endpoints for the interactive agent)
15. `src/loader-service.ts` — Loader/watchdog service for auto-starting and monitoring manager
16. `src/local-agent-server.ts` — Local agent process spawner and lifecycle manager
17. `src/start-agent-manager.ts` — Manager startup script
18. `src/start-claude-server.ts` — Worker agent startup script
19. `src/test-claude-agent.ts` — Test/demo script for Claude agent [STATUS: PASS] Clean smoke test, minor `as any` cast and stale pricing strings, no functional issues
20. `src/core/agent-identifier.ts` — Agent display ID, alias normalization, identity resolution
21. `src/core/agent-service.ts` — Shared agent CRUD operations (DB queries)
22. `src/core/config-utils.ts` — Config utilities (findProjectRoot, readDotEnvFile)
23. `src/core/erc7930.ts` — ERC-7930 interoperable address encoding/decoding
24. `src/core/file-service.ts` — File operations for agent workspace and shared directories
25. `src/core/index.ts` — Core module re-exports
26. `src/core/messaging-service.ts` — Message delivery, news items, query management
27. `src/core/registry-service.ts` — Onchain registry lookups and sync
28. `src/core/safe-compare.ts` — Timing-safe string comparison for API keys
29. `src/core/team-service.ts` — Team CRUD and port range allocation
30. `src/core/types.ts` — Shared TypeScript type definitions
31. `src/harness/claude-agent-sdk.ts` — Claude Agent SDK runtime (uses ANTHROPIC_API_KEY)
32. `src/harness/claude-code-cli.ts` — Claude Code CLI runtime (uses Max plan subscription)
33. `src/harness/index.ts` — Harness module re-exports and factory
34. `src/harness/types.ts` — Harness type definitions (HarnessMessage, etc.)
35. `src/onchain/idchain-register.ts` — Onchain registration via id-cli (register, subnames, endpoints)
36. `src/examples/inter-agent-demo.ts` — Inter-agent communication demo
37. `src/examples/multi-agent-demo.ts` — Multi-agent orchestration demo

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

---

## C. Express Routes — Manager (agent-manager-db.ts)

71. `GET /health` — Manager health check
72. `GET /agents` — List all agents
73. `GET /agents/status` — Agent status summary
74. `GET /agents/resolve/:ref` — Resolve agent by name, tokenId, or ERC-7930
75. `GET /agents/by-name/:name` — Get agent by name [STATUS: PASS] Parameterized SQL, two-stage resolution (exact then flexible), team-scoped, read-only
76. `GET /agents/:id` — Get agent by ID
77. `GET /agents/:name/news` — Get news items for specific agent
78. `POST /agents/spawn` — Spawn a new agent process
79. `POST /agents/register` — Register agent in database
80. `POST /agents/:id/metadata` — Update agent metadata by ID
81. `POST /agents/by-name/:name/metadata` — Update agent metadata by name
82. `POST /agents/:id/onchain/register` — Register agent onchain by ID
83. `POST /agents/by-name/:name/onchain/register` — Register agent onchain by name
84. `POST /agents/:id/model` — Change agent model
85. `POST /agents/by-name/:name/move` — Move agent to different team [STATUS: REMOVED] Deleted — team transfers not supported; contained buggy news_items copy query (item 136)
86. `DELETE /agents/:id` — Delete agent by ID
87. `DELETE /agents/by-name/:name` — Delete agent by name [STATUS: PASS] Safe workspace cleanup with path guard, cascading DB delete; empty catch blocks unlike sibling route (minor)
88. `POST /talk` — Send message to manager (triggers LLM)
89. `POST /message` — Agent-to-agent messaging (fire-and-forget or wait)
90. `POST /talk-to` — Alias for /message with wait:true
91. `POST /news` — Receive reply or post news item
92. `GET /news` — Poll for manager news updates
93. `POST /news/archive` — Archive old news items
94. `GET /registry/default` — Get default onchain registry config
95. `POST /registry/default` — Set default onchain registry config
96. `GET /registry/registrar` — Get registrar address
97. `POST /registry/registrar` — Set registrar address
98. `POST /registry/push` — Push local agents to onchain registry
99. `POST /registry/pull` — Pull agents from onchain registry
100. `GET /teams` — List all teams
101. `POST /teams` — Create a team
102. `PATCH /teams/:name` — Update team config
103. `DELETE /teams/:name` — Delete a team
104. `GET /projects` — List projects (alias for teams)
105. `POST /projects` — Create project (alias for teams)
106. `GET /logs` — Get manager activity log
107. `POST /remote` — Execute CLI commands via API (requires admin key)
108. `GET /:tokenId` — Reverse-proxy to agent by tokenId
109. `POST /agents/:name/cancel` — Cancel agent query

---

## D. Express Routes — Worker Agent (claude-agent-server.ts)

110. `GET /health` — Worker health check
111. `GET /.well-known/restap.json` — REST-AP catalog (endpoint discovery)
112. `GET /catalog` — View agent catalog metadata
113. `PATCH /catalog` — Update agent catalog metadata
114. `POST /talk` — Send message to agent (triggers LLM) [STATUS: PASS] Async 202 pattern, serialized query queue prevents concurrency issues, proper session continuity and auto-reply logic
115. `POST /clear` — Clear agent session
116. `POST /cancel` — Cancel running query
117. `GET /news` — Poll agent news feed
118. `POST /news` — Receive reply or post news item
119. `GET /query/:id` — Get query status by ID
120. `POST /talk-to` — Agent-to-agent via worker (forwards to manager)
121. `PATCH /identity` — Update agent identity [STATUS: PASS] Fixed: added type validation (string/object checks) and 10KB body limit to prevent abuse
122. `GET /files/list` — List available files
123. `GET /files` — Browse files
124. `POST /files/upload` — Upload file to agent (50MB limit)
125. `USE /files` — Static file serving (working directory)
126. `USE /files/teams` — Static file serving (team shared directory)
127. `USE /files/shared` — Static file serving (global shared directory)

---

## E. Express Routes — Interactive Server (interactive-agent-server.ts)

128. `GET /.well-known/restap.json` — CLI agent REST-AP catalog
129. `POST /remote` — Remote command execution for CLI
130. `POST /talk` — Send message to CLI agent
131. `GET /news` — Poll CLI agent news
132. `POST /news` — Receive reply to CLI agent

---

## F. Database Tables (db.ts)

133. Table `teams` — Namespace/tenant config (id, name, config jsonb, port_start, port_end)
134. Table `agents` — Agent registry (team_id, id, name, type, model, port, endpoint, status, registry jsonb, metadata jsonb, token_id, registry_7930, api_key, runtime)
135. Table `wallets` — Agent Ethereum wallets [deprecated] (team_id, agent_id, address, private_key)
136. Table `news_items` — Async message feed (team_id, agent_id, timestamp, type, message, data jsonb, query_id) [STATUS: FIXED] Bug resolved — deleted the broken transfer function (item 85) that referenced non-existent columns
137. Table `queries` — Work/request tracking (team_id, agent_id, query_id, status, prompt, result jsonb, session_id, sender_name)
