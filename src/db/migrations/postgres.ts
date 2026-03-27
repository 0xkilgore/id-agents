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
      runtime text DEFAULT 'claude-agent-sdk',
      PRIMARY KEY (team_id, id)
    );
  `);

  // DEPRECATED: The wallets table is no longer used. Agents share a single deployer key
  // from the AGENT_PRIVATE_KEY env var. Per-agent keys are provided via .env.<agent_id> files.
  // Table kept for backward compatibility with existing databases (migration safety).
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id text NOT NULL,
      address text NOT NULL,
      private_key text NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (team_id, agent_id),
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
    );
  `);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS news_items (
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
  `);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS queries (
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
}
