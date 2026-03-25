# Database Schema Reference

ID Agents uses PostgreSQL for persistent storage of teams, agents, wallets, messages, and queries.

## Overview

The database is automatically migrated on startup via `migrateDb()` in `src/db.ts`. Migrations are idempotent and safe to run multiple times.

## Connection

Set the `DATABASE_URL` environment variable:

```bash
DATABASE_URL=postgres://user:password@localhost:5432/id_agents
```

For local development, start PostgreSQL locally (e.g., via Homebrew or a system service).

## Tables

### teams

Stores team/namespace configuration including port ranges.

```sql
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  port_start integer NOT NULL DEFAULT 4101,
  port_end integer NOT NULL DEFAULT 4125,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `name` | text | Unique team name |
| `config` | jsonb | Team configuration (model defaults, etc.) |
| `port_start` | integer | Start of port range for agents |
| `port_end` | integer | End of port range for agents |
| `created_at` | timestamptz | Creation timestamp |

**Notes:**
- Port allocation is dynamic and sequential across all teams (starting from 4101)
- The `port_start`/`port_end` columns are legacy — actual allocation uses `dbNextPort()` which finds the next globally available port

---

### agents

Registry of all agents (running, stopped, and virtual).

```sql
CREATE TABLE agents (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  model text NOT NULL,
  port integer NOT NULL DEFAULT 0,
  endpoint text,
  working_directory text,
  status text NOT NULL,
  created_at bigint NOT NULL,
  registry jsonb,
  metadata jsonb,
  deleted_at bigint,
  token_id text,
  registry_7930 text,
  PRIMARY KEY (team_id, id)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `team_id` | uuid | Foreign key to teams |
| `id` | text | Unique agent ID within team |
| `name` | text | Human-readable agent name |
| `type` | text | Agent type: `claude`, `virtual`, `interactive` |
| `model` | text | LLM model identifier |
| `port` | integer | Assigned port (0 for virtual agents) |
| `endpoint` | text | External endpoint URL (for virtual agents) |
| `working_directory` | text | Agent's workspace path |
| `status` | text | Current status: `running`, `stopped`, `error` |
| `created_at` | bigint | Creation timestamp (ms) |
| `registry` | jsonb | Legacy registry data |
| `metadata` | jsonb | Additional metadata |
| `deleted_at` | bigint | Soft delete timestamp (null if active) |
| `token_id` | text | Onchain token ID (if registered) |
| `registry_7930` | text | ERC-7930 encoded registry address |

**Indexes:**
```sql
CREATE INDEX agents_team_name_idx ON agents(team_id, name);
CREATE INDEX agents_token_registry_idx ON agents(token_id, registry_7930)
  WHERE token_id IS NOT NULL;
```

**Agent Types:**
- `claude` - Running agent as a local process
- `virtual` - Database-only entry (external/onchain agent)
- `interactive` - User-operated (the CLI user)

---

### wallets

Ethereum wallets for agents (for onchain registration).

```sql
CREATE TABLE wallets (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  address text NOT NULL,
  private_key text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
);
```

| Column | Type | Description |
|--------|------|-------------|
| `team_id` | uuid | Foreign key to teams |
| `agent_id` | text | Foreign key to agents |
| `address` | text | Ethereum address |
| `private_key` | text | Encrypted private key |
| `created_at` | bigint | Creation timestamp (ms) |

**Notes:**
- One wallet per agent
- Private keys are stored encrypted
- Wallets are created on-demand when agent registers onchain

---

### news_items

Async message feed for each agent (REST-AP `/news` endpoint data).

```sql
CREATE TABLE news_items (
  id bigserial PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  timestamp bigint NOT NULL,
  type text NOT NULL,
  message text,
  data jsonb,
  query_id text,
  FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigserial | Primary key |
| `team_id` | uuid | Foreign key to teams |
| `agent_id` | text | Agent that owns this news item |
| `timestamp` | bigint | Event timestamp (ms) |
| `type` | text | Event type: `result`, `error`, `status`, `reply` |
| `message` | text | Human-readable message |
| `data` | jsonb | Additional structured data |
| `query_id` | text | Related query ID (if applicable) |

**Indexes:**
```sql
CREATE INDEX news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
CREATE INDEX news_items_query_idx ON news_items(team_id, agent_id, query_id);
```

**News Types:**
- `result` - Query completed successfully
- `error` - Query failed with error
- `status` - Status update (thinking, working, etc.)
- `reply` - Direct reply from another agent

---

### queries

Work tracking for agent tasks.

```sql
CREATE TABLE queries (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  query_id text NOT NULL,
  status text NOT NULL,
  prompt text,
  created bigint NOT NULL,
  completed bigint,
  result jsonb,
  error text,
  session_id text,
  FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, agent_id, query_id)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `team_id` | uuid | Foreign key to teams |
| `agent_id` | text | Agent handling the query |
| `query_id` | text | Unique query identifier |
| `status` | text | Query status: `pending`, `processing`, `completed`, `error` |
| `prompt` | text | Original prompt/message |
| `created` | bigint | Creation timestamp (ms) |
| `completed` | bigint | Completion timestamp (ms) |
| `result` | jsonb | Query result data |
| `error` | text | Error message (if failed) |
| `session_id` | text | Session ID for conversation continuity |

**Query Statuses:**
- `pending` - Received, waiting to process
- `processing` - Currently being handled
- `completed` - Successfully finished
- `error` - Failed with error

---

## Relationships

```
teams (1) ──────< (N) agents
  │                    │
  │                    ├──< (N) news_items
  │                    │
  │                    ├──< (N) queries
  │                    │
  │                    └──< (1) wallets
```

All child tables cascade delete when a team is deleted.

---

## Common Queries

### List agents in a team
```sql
SELECT * FROM agents
WHERE team_id = $1
  AND deleted_at IS NULL
ORDER BY created_at;
```

### Get agent by name
```sql
SELECT * FROM agents
WHERE team_id = $1
  AND name = $2
  AND deleted_at IS NULL;
```

### Get agent by token ID
```sql
SELECT * FROM agents
WHERE token_id = $1
  AND registry_7930 = $2
  AND deleted_at IS NULL;
```

### Get news since timestamp
```sql
SELECT * FROM news_items
WHERE team_id = $1
  AND agent_id = $2
  AND timestamp > $3
ORDER BY timestamp;
```

### Get query status
```sql
SELECT * FROM queries
WHERE team_id = $1
  AND agent_id = $2
  AND query_id = $3;
```

### Allocate next port
```sql
-- Dynamic sequential port allocation (global across all teams)
SELECT COALESCE(MAX(port), 4100) + 1 as next_port
FROM agents
WHERE port > 0
  AND deleted_at IS NULL;
```

---

## Migrations

Migrations run automatically on startup and are idempotent:

1. **Extensions** - Enable `pgcrypto` for UUID generation
2. **Table renames** - Handle legacy naming (networks → projects → teams)
3. **Create tables** - Create all tables if not exists
4. **Add columns** - Add new columns to existing tables
5. **Backfill data** - Migrate legacy data formats
6. **Create indexes** - Add performance indexes

---

## Extensions

Required PostgreSQL extensions:

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

Used for:
- `gen_random_uuid()` - Generate UUIDs for team IDs

---

## Backup & Recovery

The database contains all persistent state. To backup:

```bash
pg_dump $DATABASE_URL > backup.sql
```

To restore:
```bash
psql $DATABASE_URL < backup.sql
```

For production deployments, configure regular automated backups.
