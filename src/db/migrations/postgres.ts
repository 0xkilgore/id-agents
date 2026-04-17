// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../db-adapter.js';

export async function migratePostgres(adapter: DbAdapter): Promise<void> {
  // Minimal "migrations" run on startup (idempotent).
  // We keep this simple on purpose: no external migration tooling required.
  // 1) Extensions
  await adapter.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

  // 2) Legacy table migration — references to containers are intentional for backward compat
  // Renames: networks -> containers -> projects -> teams (preserves data for older installs)
  await adapter.query(`
    DO $$
    BEGIN
      -- Step 1: networks -> containers (if needed)
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='networks')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='containers')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='projects')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
      THEN
        ALTER TABLE networks RENAME TO containers;
      END IF;
      -- Step 2: containers -> projects (if needed)
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='containers')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='projects')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
      THEN
        ALTER TABLE containers RENAME TO projects;
      END IF;
      -- Step 3: projects -> teams (if needed)
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='projects')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
      THEN
        ALTER TABLE projects RENAME TO teams;
      END IF;
    END $$;
  `);

  // 3) Create teams table (fresh installs)
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text UNIQUE NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      port_start integer NOT NULL DEFAULT 4101,
      port_end integer NOT NULL DEFAULT 4125,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // 4) Ensure port range columns exist (partial installs)
  await adapter.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS port_start integer NOT NULL DEFAULT 4101;`);
  await adapter.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS port_end integer NOT NULL DEFAULT 4125;`);

  // 4.5) Backfill non-overlapping port ranges for existing teams (only if there are duplicates).
  // We preserve existing agent ports by ensuring port_end >= max(agent.port) for the team.
  // Default size is 25 ports per team; ranges auto-expand if needed to cover existing ports.
  try {
      const dup = await adapter.query<{ port_start: number; port_end: number; c: string }>(
      `SELECT port_start, port_end, COUNT(*)::text as c
       FROM teams
       GROUP BY port_start, port_end
       HAVING COUNT(*) > 1
       LIMIT 1`
    );
    const shouldReassign = (dup.rowCount || 0) > 0;
    if (shouldReassign) {
      const teams = await adapter.query<{ id: string }>(
        `SELECT id
         FROM teams
         ORDER BY created_at ASC, name ASC`
      );

      let cursor = 4101;
      for (const row of teams.rows) {
        const maxPortRes = await adapter.query<{ max_port: number | null }>(
          `SELECT MAX(port) as max_port
           FROM agents
           WHERE team_id = $1 AND deleted_at IS NULL AND port > 0`,
          [row.id]
        );
        const maxPort = maxPortRes.rows[0]?.max_port ?? null;
        const desiredStart = cursor;
        const desiredEnd = Math.max(cursor + 24, maxPort || 0);
        await adapter.query(`UPDATE teams SET port_start = $2, port_end = $3 WHERE id = $1`, [
          row.id,
          desiredStart,
          desiredEnd
        ]);
        cursor = desiredEnd + 1;
      }
    }
  } catch {
    // best-effort; don't block startup
  }

  // 5) Legacy column migration — references to container_id are intentional for backward compat
  // Renames: *_network_id -> *_container_id -> *_project_id -> *_team_id (preserves data)
  // agents
  await adapter.query(`
    DO $$
    BEGIN
      -- network_id -> container_id (if needed)
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='network_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='team_id')
      THEN
        ALTER TABLE agents RENAME COLUMN network_id TO container_id;
      END IF;
      -- container_id -> project_id (if needed)
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='team_id')
      THEN
        ALTER TABLE agents RENAME COLUMN container_id TO project_id;
      END IF;
      -- project_id -> team_id (if needed)
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='team_id')
      THEN
        ALTER TABLE agents RENAME COLUMN project_id TO team_id;
      END IF;
    END $$;
  `);

  // wallets
  await adapter.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='network_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='team_id')
      THEN
        ALTER TABLE wallets RENAME COLUMN network_id TO container_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='team_id')
      THEN
        ALTER TABLE wallets RENAME COLUMN container_id TO project_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='team_id')
      THEN
        ALTER TABLE wallets RENAME COLUMN project_id TO team_id;
      END IF;
    END $$;
  `);

  // news_items
  await adapter.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='network_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='team_id')
      THEN
        ALTER TABLE news_items RENAME COLUMN network_id TO container_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='team_id')
      THEN
        ALTER TABLE news_items RENAME COLUMN container_id TO project_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='team_id')
      THEN
        ALTER TABLE news_items RENAME COLUMN project_id TO team_id;
      END IF;
    END $$;
  `);

  // queries
  await adapter.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='network_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='team_id')
      THEN
        ALTER TABLE queries RENAME COLUMN network_id TO container_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='container_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='team_id')
      THEN
        ALTER TABLE queries RENAME COLUMN container_id TO project_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='project_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='queries' AND column_name='team_id')
      THEN
        ALTER TABLE queries RENAME COLUMN project_id TO team_id;
      END IF;
    END $$;
  `);

  // 6) Create tables (fresh installs)
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
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
      runtime text DEFAULT 'claude-agent-sdk'
    );
  `);

  // DEPRECATED: The wallets table is no longer used. Agents share a single deployer key
  // from the AGENT_PRIVATE_KEY env var. Per-agent keys are provided via .env.<agent_id> files.
  // Table kept for backward compatibility with existing databases (migration safety).
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      address text NOT NULL,
      private_key text NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (agent_id)
    );
  `);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS news_items (
      id bigserial PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      timestamp bigint NOT NULL,
      type text NOT NULL,
      message text,
      data jsonb,
      query_id text,
      kind text,
      reply_expected boolean
    );
  `);

  // news_items: layered metadata columns for upgraded databases.
  // Populated on new writes; old rows stay null.
  await adapter.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS kind text;`);
  await adapter.query(`ALTER TABLE news_items ADD COLUMN IF NOT EXISTS reply_expected boolean;`);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS queries (
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      query_id text NOT NULL,
      status text NOT NULL,
      prompt text,
      created bigint NOT NULL,
      completed bigint,
      result jsonb,
      error text,
      session_id text,
      PRIMARY KEY (agent_id, query_id)
    );
  `);

  // 7) Indexes (only if the expected columns exist)
  await adapter.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name='team_id')
      THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS agents_team_name_idx ON agents(team_id, name)';
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='news_items' AND column_name='team_id')
      THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id)';
      END IF;
    END $$;
  `);

  // 8) Add token_id and domain columns for ENS-based agent identifiers
  await adapter.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_id text;`);
  await adapter.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS domain text;`);

  // 9) Index for token lookups
  await adapter.query(`
    CREATE INDEX IF NOT EXISTS agents_token_idx
    ON agents(token_id)
    WHERE token_id IS NOT NULL;
  `);

  // 10) Migrate existing registry JSONB to new columns
  await adapter.query(`
    UPDATE agents
    SET token_id = registry->>'tokenId'
    WHERE registry->>'tokenId' IS NOT NULL
      AND token_id IS NULL;
  `);
  await adapter.query(`
    UPDATE agents
    SET domain = COALESCE(registry->>'domain', metadata->>'idchain_domain')
    WHERE domain IS NULL
      AND (registry->>'domain' IS NOT NULL OR metadata->>'idchain_domain' IS NOT NULL);
  `);

  // Drop legacy registry_7930 column and index if they exist
  await adapter.query(`DROP INDEX IF EXISTS agents_token_registry_idx;`);
  await adapter.query(`ALTER TABLE agents DROP COLUMN IF EXISTS registry_7930;`);

  // 11) Add api_key column for agent authentication
  await adapter.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key text;`);

  // 12) Add runtime column for harness type
  await adapter.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime text DEFAULT 'claude-agent-sdk';`);

  // 13) Migrate agents PK from (team_id, id) to (id).
  //     Child table FKs change from (team_id, agent_id) -> agents(team_id, id)
  //     to (agent_id) -> agents(id).
  await adapter.query(`
    DO $$
    DECLARE
      fk_name text;
    BEGIN
      -- Only run if agents still has a composite PK including team_id
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
        WHERE table_schema = 'public' AND table_name = 'agents'
          AND constraint_name = 'agents_pkey' AND column_name = 'team_id'
      ) THEN
        RETURN;
      END IF;

      -- Drop all FKs on child tables that reference agents
      FOR fk_name IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
        JOIN information_schema.table_constraints tc2
          ON tc2.constraint_name = rc.unique_constraint_name AND tc2.constraint_schema = rc.unique_constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc2.table_name = 'agents'
          AND tc.table_name IN ('wallets', 'news_items', 'queries')
      LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
          (SELECT table_name FROM information_schema.table_constraints WHERE constraint_name = fk_name AND constraint_type = 'FOREIGN KEY' LIMIT 1),
          fk_name);
      END LOOP;

      -- Change agents PK from (team_id, id) to (id)
      ALTER TABLE agents DROP CONSTRAINT agents_pkey;
      ALTER TABLE agents ADD PRIMARY KEY (id);

      -- Change wallets PK from (team_id, agent_id) to (agent_id)
      ALTER TABLE wallets DROP CONSTRAINT wallets_pkey;
      ALTER TABLE wallets ADD PRIMARY KEY (agent_id);
      ALTER TABLE wallets ADD CONSTRAINT wallets_agent_fk
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

      -- Change queries PK from (team_id, agent_id, query_id) to (agent_id, query_id)
      ALTER TABLE queries DROP CONSTRAINT queries_pkey;
      ALTER TABLE queries ADD PRIMARY KEY (agent_id, query_id);
      ALTER TABLE queries ADD CONSTRAINT queries_agent_fk
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

      -- Add new FK for news_items
      ALTER TABLE news_items ADD CONSTRAINT news_items_agent_fk
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
    END $$;
  `);

  // 14) Scheduling tables
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS schedule_definitions (
      id text PRIMARY KEY,
      kind text NOT NULL,
      title text NOT NULL,
      description text,
      active boolean NOT NULL DEFAULT true,
      message text NOT NULL,
      sender text NOT NULL DEFAULT 'schedule',
      delivery_mode text NOT NULL DEFAULT 'talk',
      timezone text,
      catch_up_policy text NOT NULL DEFAULT 'skip',
      dedupe_window_seconds integer NOT NULL DEFAULT 90,
      interval_seconds integer,
      anchor_at bigint,
      max_runs integer,
      expires_at bigint,
      local_time_seconds integer,
      local_date text,
      days_of_week text,
      source_type text NOT NULL DEFAULT 'yaml',
      source_key text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );
  `);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS schedule_targets (
      schedule_id text NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (schedule_id, agent_id)
    );
  `);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS schedule_runs (
      schedule_id text NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      scheduled_key text NOT NULL,
      scheduled_at bigint NOT NULL,
      fired_at bigint NOT NULL,
      status text NOT NULL,
      error text,
      PRIMARY KEY (schedule_id, agent_id, scheduled_key)
    );
  `);

  await adapter.query(`ALTER TABLE schedule_definitions ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'talk';`);

  await adapter.query(`CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx ON schedule_runs(schedule_id, fired_at);`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS schedule_runs_agent_idx ON schedule_runs(agent_id, fired_at);`);

  // 15) Task management tables
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      uuid text,
      team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
      title text NOT NULL,
      description text,
      status text NOT NULL,
      created_by text REFERENCES agents(id) ON DELETE SET NULL,
      owner text REFERENCES agents(id) ON DELETE SET NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      completed_at bigint
    );
  `);

  // Tasks: ensure uuid column exists for upgraded databases, then backfill
  // and enforce uniqueness. pgcrypto provides gen_random_uuid().
  await adapter.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS uuid text;`);
  await adapter.query(`UPDATE tasks SET uuid = gen_random_uuid()::text WHERE uuid IS NULL OR uuid = '';`);
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid);`);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS task_event_links (
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      schedule_id text NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      created_at bigint NOT NULL,
      PRIMARY KEY (task_id, schedule_id)
    );
  `);

  await adapter.query(`CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);`);
  await adapter.query(`CREATE INDEX IF NOT EXISTS task_event_links_schedule_idx ON task_event_links(schedule_id, task_id);`);
}
