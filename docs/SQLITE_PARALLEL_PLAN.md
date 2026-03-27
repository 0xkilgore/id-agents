# SQLite Refactor — Parallel Execution Plan

> I (agents) execute the entire refactor using Claude Code sub-agents via the Agent tool.
> Sub-agents run in parallel within each wave. I wait for all agents in a wave to finish
> before launching the next wave. Each sub-agent gets a focused, self-contained task.

---

## Execution Model

```text
ME (agents, coordinator)
  │
  ├─ Agent tool: spawn sub-agents for parallel work
  ├─ Each sub-agent: reads files, writes code, returns result
  ├─ Waves: I launch all agents in a wave simultaneously,
  │         wait for all to complete, then start next wave
  └─ Conflict avoidance: no two agents write the same file
```

**Key constraints:**
- Sub-agents can read any file but should only write files assigned to them
- All work happens in `/Users/nxt3d/projects/id2/id-agents`
- Sub-agents use `mode: "bypassPermissions"` for uninterrupted execution
- Each sub-agent prompt is self-contained (includes all context needed)

---

## Repository Method Inventory

Each method needs a PG and SQLite implementation. This inventory drives the repo implementations.

### TeamsRepository (9 methods, 16 call sites)

| Method | Op | Sites | PG-Specific | Notes |
|--------|-----|-------|-------------|-------|
| `getOrCreateTeamId(name)` | INSERT+RETURNING | 1 | Yes | ON CONFLICT upsert, UUID in JS |
| `getTeam(teamId)` | SELECT | 3 | No | |
| `getTeamByName(name)` | SELECT | 3 | No | |
| `getConfig(teamId)` | SELECT | 2 | Yes (jsonb return) | PG returns object, SQLite returns string |
| `listTeams()` | SELECT | 2 | No | |
| `listTeamsWithConfig()` | SELECT | 1 | Yes (jsonb) | |
| `setRegistrarAddress(teamId, addr)` | UPDATE | 1 | Yes (jsonb_set) | SQLite: read-merge-write |
| `setDefaultRegistry(teamId, chainId, addr)` | UPDATE | 1 | Yes (nested jsonb_set) | SQLite: read-merge-write |
| `deleteTeam(teamId)` | DELETE | 1 | No | |

### AgentsRepository (17 methods, ~65 call sites)

| Method | Op | Sites | PG-Specific | Notes |
|--------|-----|-------|-------------|-------|
| `getById(teamId, agentId)` | SELECT | 2 | No | |
| `getByName(teamId, name)` | SELECT | 8 | Yes (metadata->>'alias') | |
| `resolve(teamId, ref)` | SELECT | 5 | Yes (4 query paths, JSONB+LOWER) | Most complex |
| `getForRouting(teamId, nameOrToken)` | SELECT | 2 | Yes (metadata->>'alias') | |
| `list(teamId, includeAutomator?)` | SELECT | 3 | No | Dynamic type filter |
| `nextPort()` | SELECT | 3 | No | MAX(port) |
| `count(teamId)` | SELECT | 6 | Yes (COUNT(*)::text) | |
| `findInteractive(teamId)` | SELECT | 4 | No | |
| `findByRegistry(teamId, chainId, addr, tokenId)` | SELECT | 2 | Yes (registry->>'field') | |
| `findHeartbeat(teamId)` | SELECT | 2 | Yes (metadata->>'heartbeat') | |
| `create(agent)` | INSERT | 3 | No | 12-14 columns |
| `upsert(agent)` | INSERT | 2 | Yes (ON CONFLICT DO UPDATE) | |
| `updateIdentity(teamId, agentId, fields)` | UPDATE | 1 | No | |
| `updateMetadata(teamId, agentId, metadata)` | UPDATE | 15 | No | Highest frequency |
| `updateStatus(teamId, agentId, status)` | UPDATE | 8 | No | |
| `softDelete(teamId, name, excludeId)` | UPDATE | 1 | No | Sets deleted_at |
| `delete(teamId, agentId)` | DELETE | 4 | No | |

### QueriesRepository (6 methods, ~8 call sites)

| Method | Op | Sites | PG-Specific | Notes |
|--------|-----|-------|-------------|-------|
| `create(teamId, queryId, agentId, prompt)` | INSERT | 2 | No | ON CONFLICT DO NOTHING |
| `upsert(teamId, agentId, query)` | INSERT | 2 | No | ON CONFLICT DO UPDATE |
| `complete(teamId, queryId, result)` | UPDATE | 1 | No | |
| `findTeam(queryId)` | SELECT | 1 | No | |
| `getPending(teamId, agentId)` | SELECT | 2 | No | |
| `cancel(teamId, agentId)` | UPDATE | 2 | No | |

### NewsRepository (5 methods, ~14 call sites)

| Method | Op | Sites | PG-Specific | Notes |
|--------|-----|-------|-------------|-------|
| `add(teamId, agentId, item)` | INSERT | 8 | No | Duplicated across 3 files |
| `poll(teamId, agentId, since, opts)` | SELECT | 3 | No | Dynamic WHERE |
| `getRecent(teamId, types, limit)` | SELECT | 1 | No | |
| `fetchForArchive(teamId, before)` | SELECT | 1 | No | |
| `deleteArchived(teamId, before)` | DELETE | 1 | No | |

**Totals: 37 repository methods, ~103 call sites**

---

## Dependency Graph

```text
WAVE 0 ─ foundation, all 3 sub-agents parallel (no file overlaps)
  ┌────────────────────────────────────────────────────────────────────┐
  │  Sub-agent A          Sub-agent B           Sub-agent C            │
  │  Adapters + JSON      Interfaces + Types    Migrations             │
  │  ───────────────      ────────────────      ───────────────        │
  │  src/db/              src/db/               src/db/migrations/     │
  │   db-adapter.ts        db-service.ts         postgres.ts           │
  │   pg-adapter.ts        types.ts              sqlite.ts             │
  │   sqlite-adapter.ts                                                │
  │   db-json.ts                                                       │
  └──────────┬───────────────────┬────────────────────┬────────────────┘
             │                   │                    │
             ▼                   ▼                    │
WAVE 1 ─ repos, 4 sub-agents parallel                │
  ┌────────────────────────────────────────────────────────────────────┐
  │  Sub-agent D          Sub-agent E                                  │
  │  PG teams+agents      PG queries+news                              │
  │  repos/postgres/      repos/postgres/                              │
  │   teams-repo.ts        queries-repo.ts                             │
  │   agents-repo.ts       news-repo.ts                                │
  │                                                                    │
  │  Sub-agent F          Sub-agent G                                  │
  │  SQLite teams+agents  SQLite queries+news                          │
  │  repos/sqlite/        repos/sqlite/                                │
  │   teams-repo.ts        queries-repo.ts                             │
  │   agents-repo.ts       news-repo.ts                                │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
WAVE 2 ─ integration, 3 sub-agents parallel
  ┌────────────────────────────────────────────────────────────────────┐
  │  Sub-agent H              Sub-agent I          Sub-agent J         │
  │  manager call sites       server call sites    composition         │
  │  ───────────────          ────────────────     ────────────        │
  │  agent-manager-db.ts      claude-agent-srv     src/db/index.ts     │
  │  (96 queries)             local-agent-srv      (createDb, etc.)    │
  │                           interactive-srv                          │
  │                           (15 queries)                             │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
WAVE 3 ─ testing, 2 sub-agents parallel
  ┌────────────────────────────────────────────────────────────────────┐
  │  Sub-agent K                    Sub-agent L                        │
  │  Conformance tests              Integration verification           │
  │  test/repos/conformance.test.ts grep checks, build verification   │
  │  test/repos/migration.test.ts                                      │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Wave 0: Foundation (3 parallel sub-agents)

All three sub-agents write to different files — no conflicts.

### Sub-agent A — Adapters + JSON Helpers

**Files created:** `src/db/db-adapter.ts`, `src/db/pg-adapter.ts`, `src/db/sqlite-adapter.ts`, `src/db/db-json.ts`

**Prompt:**

```
You are implementing the database adapter layer for the id-agents project at
/Users/nxt3d/projects/id2/id-agents. This is part of a SQLite refactor described
in docs/SQLITE_PLAN.md.

First, run: npm install better-sqlite3 && npm install -D @types/better-sqlite3

Then create these 4 files (create src/db/ directory first):

1. src/db/db-adapter.ts
   Export:
   - interface QueryResult<T = unknown> { rows: T[]; rowCount: number; }
   - interface DbAdapter {
       readonly dialect: 'postgres' | 'sqlite';
       query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
       close(): Promise<void>;
     }

2. src/db/pg-adapter.ts
   Export: class PgAdapter implements DbAdapter
   - Constructor takes pg.Pool
   - dialect = 'postgres'
   - query() delegates to pool.query(), returns { rows: result.rows, rowCount: result.rowCount ?? 0 }
   - close() calls pool.end()

3. src/db/sqlite-adapter.ts
   Export: class SqliteAdapter implements DbAdapter
   - Constructor takes filePath string, opens better-sqlite3 Database
   - Set pragmas: journal_mode=WAL, foreign_keys=ON, busy_timeout=5000, synchronous=NORMAL
   - dialect = 'sqlite'
   - query(): uses db.prepare(sql)
     - If SQL starts with SELECT/WITH or contains RETURNING: use stmt.all(...params), return { rows, rowCount: rows.length }
     - Otherwise: use stmt.run(...params), return { rows: [], rowCount: info.changes }
   - exec(sql: string): void — calls db.exec(sql) for multi-statement DDL
   - close() calls db.close()
   - NOTE: Uses ? placeholders (NOT $1). Repos will write dialect-specific SQL.

4. src/db/db-json.ts
   Export:
   - parseJsonObject(value: unknown): Record<string, unknown>
     If value is null/undefined → return {}
     If value is object → return as-is (PG jsonb comes back as object)
     If value is string → JSON.parse, return object or {} on error
   - stringifyJson(value: unknown): string
     Returns JSON.stringify(value ?? {})
   - parseJsonArray(value: unknown): unknown[]
     Similar to parseJsonObject but returns array

Do NOT create any other files. Do NOT add SQL translation/regex logic.
```

### Sub-agent B — Repository Interfaces + Shared Types

**Files created:** `src/db/types.ts`, `src/db/db-service.ts`

**Prompt:**

```
You are designing the repository interfaces for the id-agents project at
/Users/nxt3d/projects/id2/id-agents. Read docs/SQLITE_PLAN.md for the overall approach.

Read src/agent-manager-db.ts to understand the actual shapes of data returned by queries.
Read src/claude-agent-server.ts, src/local-agent-server.ts, src/interactive-agent-server.ts
for additional query patterns.

Create these 2 files in src/db/:

1. src/db/types.ts — Row types matching actual table schemas:

   AgentRow: { team_id: string, id: string, name: string, type: string, model: string,
     port: number, endpoint: string | null, working_directory: string | null,
     status: string, created_at: number, registry: Record<string,unknown> | null,
     metadata: Record<string,unknown> | null, deleted_at: number | null,
     runtime: string, token_id: string | null, domain: string | null,
     api_key: string | null }

   TeamRow: { id: string, name: string, config: Record<string,unknown>,
     port_start: number, port_end: number, created_at: string }

   QueryRow: { team_id: string, agent_id: string, query_id: string, status: string,
     prompt: string | null, created: number, completed: number | null,
     result: Record<string,unknown> | null, error: string | null,
     session_id: string | null }

   NewsItemRow: { id: number, team_id: string, agent_id: string, timestamp: number,
     type: string, message: string | null, data: Record<string,unknown> | null,
     query_id: string | null }

   Note: JSON fields (config, metadata, registry, data, result) are typed as
   Record<string,unknown> | null at the APPLICATION boundary. Repos handle parsing.

2. src/db/db-service.ts — Repository interfaces + Db composite:

   Import types from ./types.ts and DbAdapter from ./db-adapter.ts.

   TeamsRepository interface:
   - getOrCreateTeamId(teamName: string): Promise<string>
   - getTeam(teamId: string): Promise<TeamRow | null>
   - getTeamByName(name: string): Promise<TeamRow | null>
   - getConfig(teamId: string): Promise<Record<string, unknown>>
   - listTeams(): Promise<TeamRow[]>
   - listTeamsWithConfig(): Promise<TeamRow[]>
   - setRegistrarAddress(teamId: string, address: string): Promise<void>
   - setDefaultRegistry(teamId: string, chainId: string, registryAddress: string): Promise<void>
   - deleteTeam(teamId: string): Promise<void>

   AgentsRepository interface:
   - getById(teamId: string, agentId: string): Promise<AgentRow | null>
   - getByName(teamId: string, name: string): Promise<AgentRow | null>
   - resolve(teamId: string, ref: string, tokenId?: string): Promise<AgentRow[]>
   - getForRouting(teamId: string, ref: string, tokenId?: string): Promise<AgentRow | null>
   - list(teamId: string, includeAutomator?: boolean): Promise<AgentRow[]>
   - nextPort(): Promise<number>
   - count(teamId: string): Promise<string>
   - findInteractive(teamId: string): Promise<AgentRow | null>
   - findByRegistry(teamId: string, chainId: string, registryAddress: string, tokenId: string): Promise<AgentRow | null>
   - findHeartbeat(teamId: string): Promise<AgentRow[]>
   - create(agent: Partial<AgentRow> & { team_id: string; id: string; name: string; type: string; model: string; status: string; created_at: number }): Promise<void>
   - upsert(agent: Partial<AgentRow> & { team_id: string; id: string; name: string }): Promise<void>
   - updateIdentity(teamId: string, agentId: string, fields: { name?: string; token_id?: string; domain?: string; endpoint?: string; metadata?: Record<string,unknown> }): Promise<void>
   - updateMetadata(teamId: string, agentId: string, metadata: Record<string,unknown>): Promise<void>
   - updateStatus(teamId: string, agentId: string, status: string, extra?: { port?: number; endpoint?: string; metadata?: Record<string,unknown>; model?: string }): Promise<void>
   - softDelete(teamId: string, name: string, excludeId: string, timestamp: number): Promise<void>
   - deleteAgent(teamId: string, agentId: string): Promise<void>

   QueriesRepository interface:
   - create(teamId: string, queryId: string, agentId: string, prompt: string, created: number, sessionId?: string): Promise<void>
   - upsert(teamId: string, agentId: string, query: Partial<QueryRow> & { query_id: string }): Promise<void>
   - complete(teamId: string, queryId: string, completed: number, result: Record<string,unknown> | null, error?: string): Promise<void>
   - findTeam(queryId: string): Promise<string | null>
   - getPending(teamId: string, agentId: string): Promise<QueryRow[]>
   - cancel(teamId: string, agentId: string, completed: number): Promise<string[]>

   NewsRepository interface:
   - add(teamId: string, agentId: string, item: { timestamp: number; type: string; message?: string; data?: Record<string,unknown>; query_id?: string }): Promise<void>
   - poll(teamId: string, agentId: string, since: number, opts?: { limit?: number; queryId?: string }): Promise<NewsItemRow[]>
   - getRecent(teamId: string, types: string[], limit: number): Promise<NewsItemRow[]>
   - fetchForArchive(teamId: string, before: number): Promise<NewsItemRow[]>
   - deleteArchived(teamId: string, before: number): Promise<void>

   Db interface:
   - adapter: DbAdapter
   - teams: TeamsRepository
   - agents: AgentsRepository
   - queries: QueriesRepository
   - news: NewsRepository
   - close(): Promise<void>

Study the actual call sites in the source files to refine parameter types. The
signatures above are guidelines — adjust based on what you find in the code.

Do NOT write implementations. Only interfaces, types, and exports.
```

### Sub-agent C — Migration Separation

**Files created:** `src/db/migrations/postgres.ts`, `src/db/migrations/sqlite.ts`

**Prompt:**

```
You are separating the database migrations for the id-agents project at
/Users/nxt3d/projects/id2/id-agents. Read docs/SQLITE_PLAN.md Phase 3.

Create src/db/migrations/ directory, then these 2 files:

1. src/db/migrations/postgres.ts
   - Export: async function migratePostgres(adapter: DbAdapter): Promise<void>
   - Import DbAdapter from '../db-adapter.js'
   - Read src/db.ts and extract the ENTIRE body of the migrateDb() function
   - Replace every db.pool.query(...) with adapter.query(...)
   - Keep ALL existing logic exactly as-is:
     * CREATE EXTENSION pgcrypto
     * All 6 DO $$ blocks (legacy table/column renames)
     * CREATE TABLE IF NOT EXISTS for all 5 tables
     * All ALTER TABLE ADD COLUMN IF NOT EXISTS
     * All CREATE INDEX
     * The getOrCreateTeamId helper (with RETURNING id)
     * The backfill queries
   - This must be a 1:1 extraction. No behavior changes for PG users.
   - Also export: async function getOrCreateTeamIdPg(adapter: DbAdapter, teamName: string): Promise<string>
     (the existing getOrCreateTeamId logic that uses RETURNING)

2. src/db/migrations/sqlite.ts
   - Export: function migrateSqlite(adapter: SqliteAdapter): void
   - Import SqliteAdapter from '../sqlite-adapter.js'
   - Clean DDL schema using adapter.exec():
     * teams: id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, config TEXT DEFAULT '{}',
       port_start INTEGER DEFAULT 4101, port_end INTEGER DEFAULT 4125,
       created_at TEXT DEFAULT CURRENT_TIMESTAMP
     * agents: team_id TEXT NOT NULL, id TEXT NOT NULL, + all columns from the PG schema
       but with TEXT instead of uuid/jsonb and INTEGER instead of bigint
       PRIMARY KEY (team_id, id), FOREIGN KEY refs teams(id) ON DELETE CASCADE
     * wallets: same pattern with composite PK and FK
     * news_items: id INTEGER PRIMARY KEY AUTOINCREMENT, + rest of columns, FK to agents
     * queries: composite PK (team_id, agent_id, query_id), FK to agents
   - Create all 4 indexes (agents_team_name, news_items_agent_time, news_items_query, agents_token)
   - The agents_token_idx should use WHERE token_id IS NOT NULL (partial index)
   - No legacy renames. No DO $$ blocks. SQLite users are fresh installs.

Read the current src/db.ts very carefully to get every column, constraint, and index right.
```

---

## Wave 1: Repository Implementations (4 parallel sub-agents)

**Launch after:** all Wave 0 sub-agents complete.
All 4 sub-agents write to different directories — no conflicts.

### Sub-agent D — PG Teams + Agents Repos

**Files created:** `src/db/repos/postgres/teams-repo.ts`, `src/db/repos/postgres/agents-repo.ts`

**Prompt:**

```
You are implementing the PostgreSQL repository classes for teams and agents in
/Users/nxt3d/projects/id2/id-agents.

Read these files to understand the interfaces and existing queries:
- src/db/db-service.ts (TeamsRepository and AgentsRepository interfaces)
- src/db/db-adapter.ts (DbAdapter interface)
- src/db/types.ts (AgentRow, TeamRow types)
- src/db/db-json.ts (JSON helpers — PG returns jsonb as objects, so you mainly need parseJsonObject for safety)
- src/agent-manager-db.ts (existing queries to extract)
- src/db.ts (getOrCreateTeamId query)

Create src/db/repos/postgres/ directory, then these 2 files:

1. src/db/repos/postgres/teams-repo.ts
   Export: class PgTeamsRepo implements TeamsRepository
   Constructor takes DbAdapter.
   For each method, find the EXISTING SQL in the source files and move it here.
   Use $1, $2 PG-style placeholders. PG returns jsonb as JS objects.

   Key methods:
   - getOrCreateTeamId: INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id
     (generate UUID with randomUUID() from node:crypto)
   - getConfig: SELECT config FROM teams WHERE id = $1 — config comes back as object from PG
   - setRegistrarAddress: UPDATE teams SET config = jsonb_set(config, '{sepolia_registrar_address}', to_jsonb($2::text), true) WHERE id = $1
   - setDefaultRegistry: nested jsonb_set for default_chain_id + default_registry_address

2. src/db/repos/postgres/agents-repo.ts
   Export: class PgAgentsRepo implements AgentsRepository
   Constructor takes DbAdapter.

   Key methods (find exact SQL in agent-manager-db.ts):
   - getByName: SELECT * FROM agents WHERE team_id=$1 AND (name=$2 OR metadata->>'alias'=$2) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1
   - resolve: 4 query paths based on ref format (with/without tokenId, domain, etc.)
     Read the resolveAgents() method in agent-manager-db.ts carefully
   - count: SELECT COUNT(*)::text as count FROM agents WHERE team_id=$1 AND deleted_at IS NULL
   - updateMetadata: UPDATE agents SET metadata=$3 WHERE team_id=$1 AND id=$2
   - updateStatus: varies — some set just status, some also set port/endpoint/metadata/model
     Read all the status update patterns and unify into one method with optional extra fields
   - findByRegistry: queries using registry->>'chainId', registry->>'registryAddress', registry->>'tokenId'
   - findHeartbeat: WHERE metadata->>'heartbeat' = 'true'

   For complex methods (resolve, updateStatus), read the source carefully and implement
   all the variant query paths.
```

### Sub-agent E — PG Queries + News Repos

**Files created:** `src/db/repos/postgres/queries-repo.ts`, `src/db/repos/postgres/news-repo.ts`

**Prompt:**

```
You are implementing the PostgreSQL repository classes for queries and news_items in
/Users/nxt3d/projects/id2/id-agents.

Read these files:
- src/db/db-service.ts (QueriesRepository and NewsRepository interfaces)
- src/db/db-adapter.ts (DbAdapter interface)
- src/db/types.ts (QueryRow, NewsItemRow types)
- src/db/db-json.ts (JSON helpers)
- src/agent-manager-db.ts (query/news queries)
- src/claude-agent-server.ts (dbAddNews, dbUpsertQuery methods)
- src/local-agent-server.ts (query cancellation on shutdown)
- src/interactive-agent-server.ts (dbAddNews, dbUpsertQuery methods)

Create these 2 files in src/db/repos/postgres/:

1. src/db/repos/postgres/queries-repo.ts
   Export: class PgQueriesRepo implements QueriesRepository
   Constructor takes DbAdapter.

   Methods:
   - create: INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, session_id) VALUES ($1,$2,$3,$4,'pending',$5,$6) ON CONFLICT (team_id, agent_id, query_id) DO NOTHING
   - upsert: INSERT INTO queries (...) VALUES (...) ON CONFLICT (team_id, agent_id, query_id) DO UPDATE SET status=EXCLUDED.status, completed=EXCLUDED.completed, result=EXCLUDED.result, error=EXCLUDED.error, session_id=EXCLUDED.session_id
     (find the exact version in claude-agent-server.ts or interactive-agent-server.ts)
   - complete: UPDATE queries SET status='completed', completed=$3, result=$4 WHERE team_id=$1 AND query_id=$2 AND status='pending'
   - findTeam: SELECT team_id FROM queries WHERE query_id=$1 LIMIT 1
   - getPending: SELECT * FROM queries WHERE team_id=$1 AND agent_id=$2 AND status IN ('pending','processing')
   - cancel: UPDATE queries SET status='cancelled', completed=$3 WHERE team_id=$1 AND agent_id=$2 AND status IN ('pending','processing')
     Return the query_ids that were cancelled (query them first)

2. src/db/repos/postgres/news-repo.ts
   Export: class PgNewsRepo implements NewsRepository
   Constructor takes DbAdapter.

   Methods:
   - add: INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
   - poll: SELECT type, timestamp, message, data FROM news_items WHERE team_id=$1 AND agent_id=$2 AND timestamp > $3 [optional: AND query_id=$4] ORDER BY timestamp DESC LIMIT $N
     Build the WHERE clause dynamically based on opts
   - getRecent: SELECT id, query_id, type, message, timestamp, data FROM news_items WHERE team_id=$1 AND type IN (...) ORDER BY timestamp DESC LIMIT $N
   - fetchForArchive: SELECT * FROM news_items WHERE team_id=$1 AND timestamp < $2 ORDER BY timestamp ASC
   - deleteArchived: DELETE FROM news_items WHERE team_id=$1 AND timestamp < $2

Read the actual queries from the source files carefully. Consolidate duplicates.
```

### Sub-agent F — SQLite Teams + Agents Repos

**Files created:** `src/db/repos/sqlite/teams-repo.ts`, `src/db/repos/sqlite/agents-repo.ts`

**Prompt:**

```
You are implementing the SQLite repository classes for teams and agents in
/Users/nxt3d/projects/id2/id-agents.

Read these files:
- src/db/db-service.ts (TeamsRepository and AgentsRepository interfaces)
- src/db/db-adapter.ts (DbAdapter interface)
- src/db/types.ts (AgentRow, TeamRow types)
- src/db/db-json.ts (parseJsonObject, stringifyJson helpers)
- src/db/repos/postgres/teams-repo.ts (PG version for reference)
- src/db/repos/postgres/agents-repo.ts (PG version for reference)

Create src/db/repos/sqlite/ directory, then these 2 files.

KEY DIFFERENCES from PostgreSQL:
1. Use ? placeholders (NOT $1, $2)
2. JSON columns stored as TEXT:
   - Read: parseJsonObject(row.config) to get JS object
   - Write: stringifyJson(obj) to store as TEXT
3. No jsonb_set() — use read-merge-write:
   - Read current JSON
   - Parse in JS
   - Merge changes
   - Write back full string
4. No metadata->>'alias' — use json_extract(metadata, '$.alias')
5. No registry->>'tokenId' — use json_extract(registry, '$.tokenId')
6. COUNT(*)::text → CAST(COUNT(*) AS TEXT)
7. UUID: use randomUUID() from node:crypto
8. ON CONFLICT works the same way
9. RETURNING works the same way (use adapter.query which detects it)

1. src/db/repos/sqlite/teams-repo.ts
   Export: class SqliteTeamsRepo implements TeamsRepository

   Key differences from PG:
   - getOrCreateTeamId: same logic but ? placeholders
   - getConfig: returns TEXT, must parseJsonObject()
   - listTeamsWithConfig: parse config for each row
   - setRegistrarAddress: READ config → parseJsonObject → set key → stringifyJson → UPDATE
   - setDefaultRegistry: READ config → parseJsonObject → set 2 keys → stringifyJson → UPDATE

2. src/db/repos/sqlite/agents-repo.ts
   Export: class SqliteAgentsRepo implements AgentsRepository

   Key differences from PG:
   - getByName: WHERE json_extract(metadata, '$.alias') = ? instead of metadata->>'alias' = $2
   - resolve: all 4 paths use json_extract instead of ->>
   - findByRegistry: json_extract(registry, '$.chainId'), etc.
   - findHeartbeat: json_extract(metadata, '$.heartbeat') = 'true'
   - count: CAST(COUNT(*) AS TEXT)
   - create: stringifyJson for metadata/registry fields
   - upsert: stringifyJson for metadata field
   - updateMetadata: stringifyJson before writing
   - Every read that returns agents must parseJsonObject on metadata and registry fields

   Important: when reading rows, parse ALL JSON columns:
   private parseRow(row: any): AgentRow {
     return {
       ...row,
       metadata: parseJsonObject(row.metadata),
       registry: parseJsonObject(row.registry),
     };
   }
```

### Sub-agent G — SQLite Queries + News Repos

**Files created:** `src/db/repos/sqlite/queries-repo.ts`, `src/db/repos/sqlite/news-repo.ts`

**Prompt:**

```
You are implementing the SQLite repository classes for queries and news_items in
/Users/nxt3d/projects/id2/id-agents.

Read these files:
- src/db/db-service.ts (QueriesRepository and NewsRepository interfaces)
- src/db/db-adapter.ts (DbAdapter interface)
- src/db/types.ts (QueryRow, NewsItemRow types)
- src/db/db-json.ts (parseJsonObject, stringifyJson)
- src/db/repos/postgres/queries-repo.ts (PG version for reference)
- src/db/repos/postgres/news-repo.ts (PG version for reference)

Create these 2 files in src/db/repos/sqlite/:

KEY DIFFERENCES from PostgreSQL:
1. Use ? placeholders (NOT $1)
2. JSON columns (data, result) stored as TEXT — parse on read, stringify on write
3. ON CONFLICT works identically
4. RETURNING works identically (SQLite 3.35+)

1. src/db/repos/sqlite/queries-repo.ts
   Export: class SqliteQueriesRepo implements QueriesRepository
   - Mirror PG versions but with ? placeholders
   - Parse result column with parseJsonObject on read
   - stringifyJson for result on write
   - For cancel: query pending query_ids first, then update, return the ids

2. src/db/repos/sqlite/news-repo.ts
   Export: class SqliteNewsRepo implements NewsRepository
   - Mirror PG version but with ? placeholders
   - Parse data column with parseJsonObject on read
   - stringifyJson for data on write
   - poll: dynamic WHERE with ? (track param positions manually since ? is positional)

These are simpler than the teams/agents repos since queries and news_items
have minimal JSON-operator usage.
```

---

## Wave 2: Integration (3 parallel sub-agents)

**Launch after:** all Wave 1 sub-agents complete.
Each sub-agent writes to different files — no conflicts.

### Sub-agent H — Manager Call Sites (agent-manager-db.ts)

**Files modified:** `src/agent-manager-db.ts`

**Prompt:**

```
You are migrating all ~96 raw SQL queries in agent-manager-db.ts to use repository
methods, in /Users/nxt3d/projects/id2/id-agents.

Read these files first:
- src/db/db-service.ts (Db interface with teams, agents, queries, news repos)
- src/db/types.ts (row types)
- src/agent-manager-db.ts (the file you will modify)

THE TASK: Replace every this.db.pool.query(...) call with the appropriate
repository method call (this.db.teams.*, this.db.agents.*, this.db.queries.*, this.db.news.*).

Step 1: Change the Db type import. The class should use the Db type from src/db/db-service.ts
        instead of the old { pool } type.

Step 2: For each db.pool.query() call, map it to a repo method:

  TEAMS queries:
  - SELECT config FROM teams WHERE id = $1 → this.db.teams.getConfig(teamId)
  - UPDATE teams SET config = jsonb_set(...) → this.db.teams.setRegistrarAddress(...) or setDefaultRegistry(...)
  - SELECT id, name FROM teams WHERE name = $1 → this.db.teams.getTeamByName(name)
  - SELECT ... FROM teams ORDER BY → this.db.teams.listTeams() or listTeamsWithConfig()
  - DELETE FROM teams WHERE id = $1 → this.db.teams.deleteTeam(teamId)
  - COUNT agents for team → this.db.agents.count(teamId)

  AGENTS queries:
  - SELECT * FROM agents WHERE team_id=$1 AND id=$2 → this.db.agents.getById(teamId, id)
  - SELECT * FROM agents WHERE ... name=$2 OR metadata->>'alias'=$2 → this.db.agents.getByName(teamId, name)
  - The multi-path resolution queries → this.db.agents.resolve(teamId, ref, tokenId)
  - SELECT * FROM agents WHERE team_id=$1 AND deleted_at IS NULL → this.db.agents.list(teamId)
  - SELECT MAX(port) → this.db.agents.nextPort()
  - SELECT COUNT(*)::text → this.db.agents.count(teamId)
  - INSERT INTO agents → this.db.agents.create(agent)
  - INSERT ... ON CONFLICT → this.db.agents.upsert(agent)
  - UPDATE agents SET metadata=$3 → this.db.agents.updateMetadata(teamId, id, metadata)
  - UPDATE agents SET status=$3 → this.db.agents.updateStatus(teamId, id, status)
  - UPDATE agents SET deleted_at → this.db.agents.softDelete(teamId, name, excludeId, timestamp)
  - DELETE FROM agents → this.db.agents.deleteAgent(teamId, id)

  QUERIES queries:
  - INSERT INTO queries → this.db.queries.create(...)
  - UPDATE queries SET status='completed' → this.db.queries.complete(...)
  - SELECT team_id FROM queries WHERE query_id → this.db.queries.findTeam(queryId)
  - SELECT ... status IN ('pending','processing') → this.db.queries.getPending(teamId, agentId)
  - UPDATE queries SET status='cancelled' → this.db.queries.cancel(teamId, agentId, now)

  NEWS queries:
  - INSERT INTO news_items → this.db.news.add(teamId, agentId, { timestamp, type, message, data, query_id })
  - SELECT FROM news_items → this.db.news.poll(teamId, agentId, since, opts)
  - SELECT ... type IN ('query', 'query.pending', 'pending_question') → this.db.news.getRecent(teamId, types, limit)
  - SELECT for archive → this.db.news.fetchForArchive(teamId, before)
  - DELETE FROM news_items → this.db.news.deleteArchived(teamId, before)

Some queries may not map cleanly. For those, use this.db.adapter.query() as a
temporary escape hatch and add a // TODO: move to repository comment.

Work through the file methodically, top to bottom. This is the largest migration task.
```

### Sub-agent I — Server Call Sites (3 files)

**Files modified:** `src/claude-agent-server.ts`, `src/local-agent-server.ts`, `src/interactive-agent-server.ts`

**Prompt:**

```
You are migrating raw SQL queries in 3 server files to use repository methods,
in /Users/nxt3d/projects/id2/id-agents.

Read these files first:
- src/db/db-service.ts (Db interface)
- src/db/types.ts (row types)

Then modify these 3 files:

1. src/claude-agent-server.ts (5 queries):
   - The private dbAddNews() method → replace body with: await this.db.news.add(teamId, agentId, { timestamp, type, message, data, query_id })
     Then replace all calls to dbAddNews with this.db.news.add
     Then delete the dbAddNews method
   - The private dbUpsertQuery() method → replace with this.db.queries.upsert(...)
     Then delete the method
   - The metadata merge query (COALESCE(metadata, '{}'::jsonb) || $3::jsonb) →
     this.db.agents.updateMetadata(teamId, agentId, mergedMetadata)
     Note: the caller should merge the metadata in JS before calling updateMetadata
   - GET /news handler query → this.db.news.poll(teamId, agentId, since, { limit, queryId })
   - GET /query/:id handler → this.db.queries.getPending() or add a getByQueryId method
     Read the actual query to determine the right repo method

2. src/local-agent-server.ts (6 queries):
   - UPDATE agents SET status='running' → this.db.agents.updateStatus(teamId, agentId, 'running')
   - INSERT INTO agents ... ON CONFLICT → this.db.agents.upsert(agent)
   - SELECT pending queries → this.db.queries.getPending(teamId, agentId)
   - UPDATE queries SET status='cancelled' → this.db.queries.cancel(teamId, agentId, Date.now())
   - INSERT INTO news_items (cancelled) → this.db.news.add(teamId, agentId, { ... })
   - UPDATE agents SET status='stopped' → this.db.agents.updateStatus(teamId, agentId, 'stopped')
   - db.pool.end() → this.db.close() (at shutdown)

3. src/interactive-agent-server.ts (4 queries):
   - dbAddNews() → this.db.news.add(...)  (then delete method)
   - dbUpsertQuery() → this.db.queries.upsert(...)  (then delete method)
   - GET /news query → this.db.news.poll(teamId, agentId, since, opts)
   - getPendingQueries() → this.db.queries.getPending(teamId, agentId)

Also update the Db type import in each file to use src/db/db-service.ts.
Remove any direct 'pg' imports that are no longer needed.
```

### Sub-agent J — Composition (createDb + index.ts)

**Files created/modified:** `src/db/index.ts`, modified `src/db.ts`

**Prompt:**

```
You are wiring together the adapter layer, repositories, and migrations for the
id-agents project at /Users/nxt3d/projects/id2/id-agents.

Read these files:
- src/db/db-adapter.ts (DbAdapter)
- src/db/db-service.ts (Db, repository interfaces)
- src/db/pg-adapter.ts (PgAdapter)
- src/db/sqlite-adapter.ts (SqliteAdapter)
- src/db/migrations/postgres.ts (migratePostgres)
- src/db/migrations/sqlite.ts (migrateSqlite)
- src/db/repos/postgres/*.ts (PG repo classes)
- src/db/repos/sqlite/*.ts (SQLite repo classes)
- src/db.ts (current createDb and migrateDb — will be replaced)

Create src/db/index.ts — the main entry point:

export async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    // PostgreSQL mode
    const { Pool } = await import('pg');
    const { PgAdapter } = await import('./pg-adapter.js');
    const adapter = new PgAdapter(new Pool({ connectionString: databaseUrl }));
    return createPostgresDb(adapter);
  }

  // SQLite mode (zero-config default)
  const { SqliteAdapter } = await import('./sqlite-adapter.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const dataDir = path.join(os.homedir(), '.id-agents');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'id-agents.db');
  const adapter = new SqliteAdapter(dbPath);
  console.log(`Database: SQLite (${dbPath})`);
  return createSqliteDb(adapter);
}

function createPostgresDb(adapter: PgAdapter): Db {
  // Import and instantiate all PG repos
  return {
    adapter,
    teams: new PgTeamsRepo(adapter),
    agents: new PgAgentsRepo(adapter),
    queries: new PgQueriesRepo(adapter),
    news: new PgNewsRepo(adapter),
    close: () => adapter.close(),
  };
}

function createSqliteDb(adapter: SqliteAdapter): Db {
  // Import and instantiate all SQLite repos
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    close: () => adapter.close(),
  };
}

export async function migrateDb(db: Db): Promise<void> {
  if (db.adapter.dialect === 'postgres') {
    const { migratePostgres } = await import('./migrations/postgres.js');
    await migratePostgres(db.adapter);
    console.log('Database: PostgreSQL');
  } else {
    const { migrateSqlite } = await import('./migrations/sqlite.js');
    migrateSqlite(db.adapter as SqliteAdapter);
  }
}

Also re-export Db, DbAdapter, and types for convenience:
export type { Db } from './db-service.js';
export type { DbAdapter } from './db-adapter.js';

Then modify src/db.ts to re-export from src/db/index.ts for backward compatibility:
export { createDb, migrateDb } from './db/index.js';
export type { Db } from './db/db-service.js';

This ensures existing imports of './db.js' still work during the transition.
```

---

## Wave 3: Validation (2 parallel sub-agents)

**Launch after:** all Wave 2 sub-agents complete.

### Sub-agent K — Conformance Tests

**Files created:** `test/repos/conformance.test.ts`, `test/repos/migration.test.ts`

**Prompt:**

```
You are writing tests for the database refactor in /Users/nxt3d/projects/id2/id-agents.

Create test/ directory structure if needed, then write:

1. test/repos/conformance.test.ts
   Using node:test and node:assert (built-in, no extra deps).

   Test structure:
   - Create an in-memory SQLite Db using SqliteAdapter(':memory:')
   - Run migrateSqlite on it
   - Run the same tests that verify repository behavior

   TeamsRepository tests:
   - getOrCreateTeamId creates team and returns UUID string
   - Calling getOrCreateTeamId again with same name returns same ID
   - getConfig returns a JS object (not string)
   - setRegistrarAddress updates config.sepolia_registrar_address
   - setDefaultRegistry updates config.default_chain_id and default_registry_address
   - deleteTeam removes team (and cascades to agents)

   AgentsRepository tests:
   - create + getById roundtrip
   - getByName matches by metadata alias
   - updateMetadata persists and returns correctly
   - updateStatus changes status
   - list returns only non-deleted agents
   - count returns string
   - softDelete sets deleted_at, agent excluded from list
   - deleteAgent removes agent

   QueriesRepository tests:
   - create + getPending roundtrip
   - upsert creates then updates same record
   - complete sets status and result
   - cancel marks pending as cancelled

   NewsRepository tests:
   - add + poll roundtrip
   - poll filters by timestamp (only items after 'since')
   - poll filters by queryId
   - deleteArchived removes old items only

2. test/repos/migration.test.ts
   - Verify SQLite migration creates all 5 tables
   - Verify all 4 indexes exist (query sqlite_master)
   - Verify foreign keys are enforced (insert agent with bad team_id should fail)
   - Verify AUTOINCREMENT on news_items.id

Run the tests with: npx tsx --test test/repos/*.test.ts
(install tsx if needed: npm install -D tsx)

Make sure tests actually pass. Fix any issues you find in the repo implementations.
```

### Sub-agent L — Build Verification + Cleanup

**Prompt:**

```
You are doing final verification of the SQLite refactor in
/Users/nxt3d/projects/id2/id-agents.

Run these checks:

1. TypeScript compilation:
   npx tsc --noEmit
   Fix any type errors across the codebase.

2. Grep for remaining pool.query references:
   Search for 'pool.query' in src/ — there should be NONE outside of src/db/pg-adapter.ts
   If any remain, they are missed call sites. List them.

3. Grep for direct 'pg' imports:
   Search for "from 'pg'" in src/ — should only be in src/db/pg-adapter.ts
   If found elsewhere, flag them.

4. Verify no circular imports in src/db/

5. Verify the Db type is used consistently — search for the old Db type pattern
   (the one with { pool: Pool }) and ensure it's replaced everywhere.

6. Check that package.json has better-sqlite3 in dependencies and
   @types/better-sqlite3 in devDependencies.

7. Run: npm run build (if build script exists) or npx tsc

Report all findings. Fix simple issues (type errors, missing imports).
Flag complex issues for manual review.
```

---

## Execution Checklist

```
[ ] Wave 0: Launch sub-agents A, B, C in parallel
    [ ] A: Adapters + db-json created
    [ ] B: Interfaces + types created
    [ ] C: Migrations separated
[ ] Wave 1: Launch sub-agents D, E, F, G in parallel
    [ ] D: PG teams + agents repos
    [ ] E: PG queries + news repos
    [ ] F: SQLite teams + agents repos
    [ ] G: SQLite queries + news repos
[ ] Wave 2: Launch sub-agents H, I, J in parallel
    [ ] H: agent-manager-db.ts migrated (96 queries)
    [ ] I: 3 server files migrated (15 queries)
    [ ] J: createDb/migrateDb composition wired
[ ] Wave 3: Launch sub-agents K, L in parallel
    [ ] K: Conformance + migration tests pass
    [ ] L: Build verification clean
```

---

## File Layout (Final State)

```text
src/
  db.ts                   ← Re-exports from src/db/index.ts (backward compat)
  db/
    index.ts              ← createDb(), migrateDb()
    db-adapter.ts         ← DbAdapter interface, QueryResult type
    db-service.ts         ← Db interface, repository interfaces
    db-json.ts            ← parseJsonObject(), stringifyJson()
    types.ts              ← AgentRow, TeamRow, QueryRow, NewsItemRow
    pg-adapter.ts         ← PgAdapter class
    sqlite-adapter.ts     ← SqliteAdapter class
    migrations/
      postgres.ts         ← Extracted from old db.ts
      sqlite.ts           ← Clean schema
    repos/
      postgres/
        teams-repo.ts
        agents-repo.ts
        queries-repo.ts
        news-repo.ts
      sqlite/
        teams-repo.ts
        agents-repo.ts
        queries-repo.ts
        news-repo.ts

test/
  repos/
    conformance.test.ts
    migration.test.ts
```

---

## Key Decisions

1. **No regex SQL translation** — each backend writes its own SQL
2. **JSON at the boundary** — repos parse/stringify JSON, callers get objects
3. **UUIDs in JS** — `randomUUID()` for both backends
4. **Lazy-load SQLite** — `await import()` in createDb so PG-only users don't need better-sqlite3
5. **Read-merge-write** for SQLite JSON updates
6. **`~/.id-agents/id-agents.db`** — default SQLite path
7. **Backward compat** — `src/db.ts` re-exports from `src/db/index.ts`
