# SQLite-First Database Refactor Plan

> Zero-config onboarding: no `DATABASE_URL` required, SQLite file created automatically.
> PostgreSQL remains supported as an optional backend for multi-process or shared deployments.
> Goal: keep runtime behavior simple for users, while making the implementation explicit and maintainable.

## Design Goal

Use:
- SQLite by default
- PostgreSQL when `DATABASE_URL` is set
- One shared application-facing database API
- Explicit dialect-specific query implementations where SQL actually differs

Avoid:
- broad regex SQL translation
- pretending PostgreSQL-flavored SQL is portable everywhere
- leaking dialect quirks into unrelated application code

This is a larger refactor than a translation-layer approach, but it produces more reliable code and a cleaner long-term architecture.

---

## Current State

| Metric | Count |
|--------|-------|
| Total `pool.query()` calls | 140 |
| Files with queries | 5 (`db.ts`, `agent-manager-db.ts`, `claude-agent-server.ts`, `local-agent-server.ts`, `interactive-agent-server.ts`) |
| Tables | 5 (`teams`, `agents`, `wallets`, `news_items`, `queries`) |
| Main PG-specific features in use | JSONB operators/functions, `DO $$`, `gen_random_uuid()`, type casts |

### Main Refactor Pressure Points

| Area | Problem |
|------|---------|
| Query execution | Current code depends directly on `pg.Pool` |
| JSON columns | PG returns JSON as objects; SQLite will store JSON as `TEXT` |
| Migrations | Current startup migration is PostgreSQL-specific |
| SQL portability | Several queries use JSONB features that should not be hidden behind regex rewriting |

---

## Architecture Overview

### The Desired Runtime Model

```text
createDb()
  ├─ DATABASE_URL set
  │    └─ PostgreSQL adapter + PostgreSQL repositories + PostgreSQL migrations
  └─ DATABASE_URL unset
       └─ SQLite adapter + SQLite repositories + SQLite migrations
```

### The Desired Application Model

Application code should depend on a small database service surface, not on raw SQL everywhere.

Example:

```typescript
await db.teams.getOrCreateTeamId(teamName);
await db.teams.setDefaultRegistry(teamId, chainId, registryAddress);
await db.agents.findMostRecentByName(teamId, name);
await db.agents.resolveAgents(teamId, ref);
await db.queries.upsert(...args);
```

That gives:
- one interface for the rest of the app
- portable behavior at the call site
- explicit SQL differences inside backend-specific repository implementations

---

## Phase 1: Define the Database Boundary

### 1.1 Keep a Small Adapter Layer

Create `src/db-adapter.ts`:

```typescript
// src/db-adapter.ts
// SPDX-License-Identifier: MIT

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface DbAdapter {
  readonly dialect: 'postgres' | 'sqlite';
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}
```

The adapter is only for:
- connection lifecycle
- raw query execution
- dialect identification

It is not responsible for:
- hiding all SQL differences
- rewriting complex queries
- emulating PostgreSQL features in SQLite

### 1.2 Create a Higher-Level `Db` Service

Create `src/db-service.ts`:

```typescript
export interface TeamsRepository {
  getOrCreateTeamId(teamName: string): Promise<string>;
  getConfig(teamId: string): Promise<Record<string, unknown>>;
  setRegistrarAddress(teamId: string, registrarAddress: string): Promise<void>;
  setDefaultRegistry(teamId: string, chainId: number, registryAddress: string): Promise<void>;
}

export interface AgentsRepository {
  findMostRecentByName(teamId: string, name: string): Promise<AgentRow | null>;
  resolveAgents(teamId: string, ref: string): Promise<AgentRow[]>;
  listAgents(teamId: string, includeAutomator?: boolean): Promise<AgentRow[]>;
  nextPort(): Promise<number>;
}

export interface QueriesRepository {
  upsert(...args: unknown[]): Promise<void>;
}

export interface Db {
  adapter: DbAdapter;
  teams: TeamsRepository;
  agents: AgentsRepository;
  queries: QueriesRepository;
  close(): Promise<void>;
}
```

The exact repository split can change, but the rule should hold:
- move behavior-oriented operations behind repositories
- do not expose `pool` or raw adapter access as the main API for application code

### 1.3 Thin PostgreSQL Adapter

Create `src/pg-adapter.ts`:

```typescript
import { Pool } from 'pg';
import { DbAdapter, QueryResult } from './db-adapter.js';

export class PgAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
```

### 1.4 Thin SQLite Adapter

Create `src/sqlite-adapter.ts`:

```typescript
import Database from 'better-sqlite3';
import { DbAdapter, QueryResult } from './db-adapter.js';

export class SqliteAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const;
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);

    if (/^\s*(SELECT|WITH|INSERT\b[\s\S]*RETURNING|UPDATE\b[\s\S]*RETURNING|DELETE\b[\s\S]*RETURNING)/i.test(sql)) {
      const rows = stmt.all(...params) as T[];
      return { rows, rowCount: rows.length };
    }

    const info = stmt.run(...params);
    return { rows: [], rowCount: info.changes };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
```

Important: the SQLite adapter should stay simple. It should not become a PostgreSQL emulation layer.

---

## Phase 2: Normalize JSON at the Repository Boundary

This is one of the key stability improvements over the translation-based plan.

### 2.1 Storage Rule

| Backend | Storage |
|---------|---------|
| PostgreSQL | `jsonb` |
| SQLite | `TEXT` containing JSON |

### 2.2 Application Rule

Application-facing repository methods should always return parsed JS objects for:
- `teams.config`
- `agents.metadata`
- `agents.registry`
- `queries.result`
- `news_items.data`

### 2.3 Shared Helpers

Create `src/db-json.ts`:

```typescript
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}
```

Rule:
- repositories parse JSON on read
- repositories stringify JSON on write for SQLite
- callers should not need to know which backend is in use

---

## Phase 3: Separate Migrations Fully by Dialect

Do not translate DDL.

### 3.1 PostgreSQL Migration

Keep the existing migration logic in a dedicated function:

```typescript
export async function migratePostgres(db: DbAdapter): Promise<void> {
  // existing PostgreSQL migration logic from db.ts
}
```

This preserves:
- `CREATE EXTENSION`
- legacy `DO $$` rename blocks
- `jsonb`
- `gen_random_uuid()`
- existing upgrade safety for current PG users

### 3.2 SQLite Migration

Create a clean SQLite schema for new installs:

```typescript
export function migrateSqlite(adapter: SqliteAdapter): void {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      port_start INTEGER NOT NULL DEFAULT 4101,
      port_end INTEGER NOT NULL DEFAULT 4125,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agents (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      model TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      working_directory TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      registry TEXT,
      metadata TEXT,
      deleted_at INTEGER,
      runtime TEXT DEFAULT 'claude-agent-sdk',
      token_id TEXT,
      domain TEXT,
      api_key TEXT,
      PRIMARY KEY (team_id, id)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      address TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, agent_id),
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE,
      PRIMARY KEY (team_id, agent_id, query_id)
    );

    CREATE INDEX IF NOT EXISTS agents_team_name_idx ON agents(team_id, name);
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS agents_token_idx ON agents(token_id) WHERE token_id IS NOT NULL;
  `);
}
```

SQLite users are assumed to be fresh installs. No legacy rename emulation is needed.

---

## Phase 4: Build Explicit Repository Implementations

This is the main refactor.

### 4.1 Repository Layout

Recommended file structure:

```text
src/db/
  db-service.ts
  db-adapter.ts
  pg-adapter.ts
  sqlite-adapter.ts
  db-json.ts
  migrations/
    postgres.ts
    sqlite.ts
  repos/
    postgres/
      teams-repo.ts
      agents-repo.ts
      queries-repo.ts
    sqlite/
      teams-repo.ts
      agents-repo.ts
      queries-repo.ts
```

### 4.2 Shared Rule for Query Placement

Use this decision rule:

| Query Type | Placement |
|------------|-----------|
| Standard CRUD with portable SQL | May be shared |
| JSON operators/functions differ by backend | Separate PG and SQLite implementations |
| DDL / migrations | Always separate |
| PG-specific casts/functions | Always separate |

### 4.3 Example: `getOrCreateTeamId`

PostgreSQL:

```typescript
const result = await adapter.query<{ id: string }>(
  `INSERT INTO teams (id, name)
   VALUES ($1, $2)
   ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
   RETURNING id`,
  [randomUUID(), teamName]
);
```

SQLite:

```typescript
const result = await adapter.query<{ id: string }>(
  `INSERT INTO teams (id, name)
   VALUES (?, ?)
   ON CONFLICT(name) DO UPDATE SET name = excluded.name
   RETURNING id`,
  [randomUUID(), teamName]
);
```

This duplication is acceptable. It is clearer than translating one form into another.

### 4.4 Example: Team Config Reads/Writes

PostgreSQL read:

```typescript
const result = await adapter.query<{ config: Record<string, unknown> }>(
  `SELECT config FROM teams WHERE id = $1`,
  [teamId]
);
return result.rows[0]?.config ?? {};
```

SQLite read:

```typescript
const result = await adapter.query<{ config: string }>(
  `SELECT config FROM teams WHERE id = ?`,
  [teamId]
);
return parseJsonObject(result.rows[0]?.config);
```

PostgreSQL write:

```typescript
await adapter.query(
  `UPDATE teams
   SET config = jsonb_set(config, '{sepolia_registrar_address}', to_jsonb($2::text), true)
   WHERE id = $1`,
  [teamId, registrarAddress]
);
```

SQLite write:

```typescript
const current = await this.getConfig(teamId);
const next = { ...current, sepolia_registrar_address: registrarAddress };

await adapter.query(
  `UPDATE teams SET config = ? WHERE id = ?`,
  [stringifyJson(next), teamId]
);
```

This is slower than an in-place JSON operator, but simpler and more reliable for this dataset size.

### 4.5 Example: Agent Resolution Queries

PostgreSQL:

```typescript
SELECT * FROM agents
WHERE team_id = $1
  AND (LOWER(name) = $2 OR LOWER(metadata->>'alias') = $2)
  AND deleted_at IS NULL
ORDER BY created_at DESC
```

SQLite:

```typescript
SELECT * FROM agents
WHERE team_id = ?
  AND (LOWER(name) = ? OR LOWER(json_extract(metadata, '$.alias')) = ?)
  AND deleted_at IS NULL
ORDER BY created_at DESC
```

Again: explicit branching is better than generic SQL rewriting.

### 4.6 Example: Metadata Merge

PostgreSQL can use `jsonb` merge operators.

SQLite implementation should instead:
1. read current metadata
2. parse JSON
3. merge in JS
4. write back full JSON string

That is easier to reason about than reproducing PG JSON semantics in SQL.

---

## Phase 5: Compose the DB Service

### 5.1 `createDb()`

```typescript
import { Pool } from 'pg';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { PgAdapter } from './pg-adapter.js';

export async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    const adapter = new PgAdapter(new Pool({ connectionString: databaseUrl }));
    return createPostgresDbService(adapter);
  }

  const { SqliteAdapter } = await import('./sqlite-adapter.js');
  const dataDir = path.join(os.homedir(), '.id-agents');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'id-agents.db');
  const adapter = new SqliteAdapter(dbPath);
  return createSqliteDbService(adapter);
}
```

### 5.2 `migrateDb()`

```typescript
export async function migrateDb(db: Db): Promise<void> {
  if (db.adapter.dialect === 'postgres') {
    await migratePostgres(db.adapter);
    return;
  }

  migrateSqlite(db.adapter as SqliteAdapter);
}
```

### 5.3 Startup Logging

```typescript
if (db.adapter.dialect === 'sqlite') {
  console.log(`Database: SQLite (${dbPath})`);
} else {
  console.log('Database: PostgreSQL');
}
```

---

## Phase 6: Refactor Call Sites Gradually

The codebase does not need to switch from 140 raw queries to repositories in one step.

### 6.1 First Pass

Extract high-value operations first:
- `getOrCreateTeamId`
- team config reads/writes
- agent lookup by name / alias / token
- query tracking upserts
- metadata merge/update paths

These are the places where backend-specific behavior already exists.

### 6.2 Second Pass

Move the rest of the repeated query logic from:
- `agent-manager-db.ts`
- `claude-agent-server.ts`
- `local-agent-server.ts`
- `interactive-agent-server.ts`

into repositories.

### 6.3 Temporary Compromise Allowed

For truly portable queries, a temporary raw-query helper is fine:

```typescript
db.adapter.query(...)
```

But:
- new PG-specific queries should not be added directly to application code
- any query touching JSON should move into repositories

---

## Phase 7: Backend Differences to Handle Explicitly

### 7.1 Placeholder Style

| Backend | Placeholder Style |
|---------|-------------------|
| PostgreSQL | `$1`, `$2`, ... |
| SQLite | `?`, `?1`, `?2`, ... |

Do not translate placeholder style generically at runtime. Write the right SQL in each repository implementation.

### 7.2 JSON Support

| Operation | PostgreSQL | SQLite |
|----------|------------|--------|
| Read field | `metadata->>'alias'` | `json_extract(metadata, '$.alias')` |
| Merge object | `jsonb` operators/functions | Read/merge/write in JS |
| Partial update | `jsonb_set(...)` | Read/modify/write in JS |

### 7.3 UUID Generation

Generate UUIDs in application code with `randomUUID()` for both backends where practical.

This reduces backend-specific behavior and simplifies inserts.

### 7.4 Concurrency Model

| Scenario | SQLite | PostgreSQL |
|----------|--------|------------|
| Single manager process | Good fit | Good fit |
| Multi-process writes | Limited | Preferred |
| Shared/deployed environment | Acceptable for light use | Better default |

Recommendation:
- market SQLite as the default local backend
- keep PostgreSQL as the recommended backend for multi-process/shared deployments

---

## Phase 8: Testing Strategy

### 8.1 Repository Conformance Tests

Test the same repository behavior against both backends.

Examples:
- create and fetch team
- get-or-create team by name
- read/write team config
- resolve agent by alias
- resolve agent by token + alias
- upsert query status
- merge metadata update

The test target should be repository behavior, not SQL text transformation.

### 8.2 Migration Tests

PostgreSQL:
- existing startup migrations still succeed
- existing PG installs still work unchanged

SQLite:
- fresh database initializes correctly
- expected indexes exist
- foreign keys are enforced

### 8.3 Integration Checklist

- [ ] Start manager with no `DATABASE_URL` and confirm SQLite is created
- [ ] Start manager with `DATABASE_URL` and confirm PostgreSQL is used
- [ ] `/agents` works on SQLite
- [ ] `/deploy` works on SQLite
- [ ] `/chat` works on SQLite
- [ ] `/news` works on SQLite
- [ ] `/team` and `/teams` work on SQLite
- [ ] query tracking upserts work on both backends
- [ ] agent metadata-dependent features behave the same on both backends
- [ ] existing PostgreSQL deployment still starts and behaves correctly

### 8.4 Regression Guardrails

- [ ] No application code depends on `db.pool`
- [ ] No PostgreSQL-specific JSON SQL remains in shared application logic
- [ ] SQLite-only behavior is not implemented through broad SQL regex rewriting
- [ ] `better-sqlite3` is lazy-loaded and not required for PostgreSQL-only startup

---

## Suggested Implementation Order

| Order | Area | Why |
|-------|------|-----|
| 1 | adapters + db service composition | establishes runtime selection cleanly |
| 2 | separate migrations | removes the largest backend-specific startup risk |
| 3 | teams repository | small surface, includes config JSON behavior |
| 4 | agents repository | highest-value query cleanup |
| 5 | queries repository | validates upsert path on both backends |
| 6 | migrate server call sites | finish removing `db.pool` coupling |
| 7 | tests | lock in backend parity |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Refactor takes longer than regex approach | High | Medium | Accept the larger change in exchange for lower long-term maintenance cost |
| Missed call site still depends on PG row shape | Medium | Medium | move JSON-heavy logic into repositories first |
| SQLite write contention in larger deployments | Low | Medium | keep PostgreSQL available and recommended for multi-process/shared use |
| Repository split feels verbose at first | Medium | Low | keep repo interfaces small and behavior-oriented |
| Breaking existing PG installs | Low | High | keep PG migrations and PG query implementations explicit and close to current behavior |

---

## Summary

This refactor should optimize for:
- simple user experience
- explicit backend selection
- explicit SQL differences
- minimal magic
- strong tests around behavior rather than SQL rewriting

In practical terms:
- SQLite becomes the default
- PostgreSQL remains supported
- users switch backends with configuration, not code changes
- the implementation becomes more verbose, but substantially more robust
