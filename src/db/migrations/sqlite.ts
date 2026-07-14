// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import type { SqliteAdapter } from '../sqlite-adapter.js';

/** PK (team_id, query_id); nullable agent_id for manager inbox rows. */
async function migrateQueriesTeamQueryPkSqlite(adapter: SqliteAdapter): Promise<void> {
  const { rows } = await adapter.query<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='queries'`,
  );
  if (!rows[0]?.sql) return;
  const norm = rows[0].sql.toLowerCase().replace(/\s+/g, ' ');
  if (
    norm.includes('primary key (team_id, query_id)') ||
    norm.includes('primary key(team_id,query_id)')
  ) {
    return;
  }

  adapter.exec(`
    ALTER TABLE queries RENAME TO queries_legacy_mgrfk;

    CREATE TABLE queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (team_id, query_id)
    );

    INSERT INTO queries SELECT * FROM queries_legacy_mgrfk;

    DROP TABLE queries_legacy_mgrfk;
  `);
  adapter.exec(
    `CREATE INDEX IF NOT EXISTS queries_team_owner_idx ON queries(team_id, owner_kind, owner_id)`,
  );
}

/** Nullable agent_id for manager-owned news rows (preserve ids). */
async function migrateNewsItemsNullableAgentSqlite(adapter: SqliteAdapter): Promise<void> {
  const meta = await adapter.query<Record<string, unknown>>(
    `SELECT * FROM pragma_table_info('news_items') WHERE name='agent_id'`,
  );
  const pinfo = meta.rows[0];
  if (!pinfo) return;
  const nn = Number((pinfo as { notnull?: unknown }).notnull ?? 0);
  if (nn === 0) return;

  adapter.exec(`DROP INDEX IF EXISTS news_items_agent_time_idx`);
  adapter.exec(`DROP INDEX IF EXISTS news_items_query_idx`);

  adapter.exec(`
    ALTER TABLE news_items RENAME TO news_items_legacy_nn;

    CREATE TABLE news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      kind TEXT,
      reply_expected INTEGER,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT ''
    );

    INSERT INTO news_items SELECT * FROM news_items_legacy_nn;

    DROP TABLE news_items_legacy_nn;
  `);

  adapter.exec(`
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS news_items_team_owner_time_idx ON news_items(team_id, owner_kind, owner_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_owner_query_idx ON news_items(team_id, owner_kind, owner_id, query_id);
  `);
}

/**
 * Null manager-owned FK slots and delete hidden manager-<team> shadow agent rows.
 * Hard-fails if orphan refs would violate integrity (runs after PK/nullable migrations).
 */
export async function migrateDeleteManagerShadowAgentsSqlite(adapter: SqliteAdapter): Promise<void> {
  const probe = async (sql: string): Promise<number> => {
    try {
      const r = await adapter.query<{ c: number }>(sql);
      return Number(r.rows[0]?.c ?? 0);
    } catch {
      return 0;
    }
  };

  const hardOrphans: Array<{ label: string; sql: string }> = [
    { label: 'wallets', sql: `SELECT COUNT(*) as c FROM wallets WHERE agent_id GLOB 'manager-*'` },
    {
      label: 'schedule_targets',
      sql: `SELECT COUNT(*) as c FROM schedule_targets WHERE agent_id GLOB 'manager-*'`,
    },
    { label: 'schedule_runs', sql: `SELECT COUNT(*) as c FROM schedule_runs WHERE agent_id GLOB 'manager-*'` },
  ];
  for (const { label, sql } of hardOrphans) {
    const c = await probe(sql);
    if (c > 0) {
      throw new Error(
        `migrateDeleteManagerShadowAgentsSqlite: ${c} row(s) in ${label} still reference manager-* ids`,
      );
    }
  }

  // Historical manager-created tasks/checkins can safely lose the shadow FK:
  // these columns are nullable metadata, unlike wallets/schedule tables above.
  await adapter.query(`UPDATE tasks SET owner = NULL WHERE owner GLOB 'manager-*' OR owner = 'virtual_manager'`);
  await adapter.query(`UPDATE tasks SET created_by = NULL WHERE created_by GLOB 'manager-*' OR created_by = 'virtual_manager'`);
  await adapter.query(`UPDATE checkins SET owner_agent_id = NULL WHERE owner_agent_id GLOB 'manager-*' OR owner_agent_id = 'virtual_manager'`);
  await adapter.query(`UPDATE checkins SET created_by_agent_id = NULL WHERE created_by_agent_id GLOB 'manager-*' OR created_by_agent_id = 'virtual_manager'`);

  // Legacy default-team manager rows used `virtual_manager` as the agent FK
  // before owner_kind/owner_id existed. Promote them to manager ownership so
  // the rest of the cleanup can treat them exactly like manager-<team> rows.
  await adapter.query(`
    UPDATE queries
    SET owner_kind = 'manager',
        owner_id = team_id
    WHERE agent_id = 'virtual_manager'
      AND owner_kind = 'agent'
      AND owner_id = 'virtual_manager'
  `);
  await adapter.query(`
    UPDATE news_items
    SET owner_kind = 'manager',
        owner_id = team_id
    WHERE agent_id = 'virtual_manager'
      AND owner_kind = 'agent'
      AND owner_id = 'virtual_manager'
  `);

  const badQ = await adapter.query<{ c: number }>(`
    SELECT COUNT(*) as c FROM queries
    WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')
      AND (owner_kind != 'manager' OR owner_id != team_id)
  `);
  if (Number(badQ.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: queries rows carry manager-* agent_id without owner_kind=manager + owner_id=team_id',
    );
  }

  const badN = await adapter.query<{ c: number }>(`
    SELECT COUNT(*) as c FROM news_items
    WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')
      AND (owner_kind != 'manager' OR owner_id != team_id)
  `);
  if (Number(badN.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: news_items carry manager-* agent_id without owner_kind=manager + owner_id=team_id',
    );
  }

  await adapter.query(`UPDATE queries SET agent_id = NULL WHERE owner_kind = 'manager'`);
  await adapter.query(`UPDATE news_items SET agent_id = NULL WHERE owner_kind = 'manager'`);

  const leftQ = await adapter.query<{ c: number }>(
    `SELECT COUNT(*) as c FROM queries WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')`,
  );
  if (Number(leftQ.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: queries still reference manager-* after owner nulling — migrate writes before rerunning delete migration',
    );
  }

  const leftN = await adapter.query<{ c: number }>(
    `SELECT COUNT(*) as c FROM news_items WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')`,
  );
  if (Number(leftN.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: news_items still reference manager-* after owner nulling',
    );
  }

  await adapter.query(`DELETE FROM agents WHERE id GLOB 'manager-*' OR id = 'virtual_manager'`);
}

export async function migrateSqlite(adapter: SqliteAdapter): Promise<void> {
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
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
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
      customer_domain TEXT,
      public_endpoint_url TEXT,
      internal_endpoint_url TEXT,
      ssh_target TEXT
    );

    CREATE TABLE IF NOT EXISTS wallets (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id)
    );

    CREATE TABLE IF NOT EXISTS logical_agent_identities (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      logical_agent TEXT NOT NULL,
      display_name TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, logical_agent)
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      kind TEXT,
      reply_expected INTEGER,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (team_id, query_id)
    );

    CREATE INDEX IF NOT EXISTS agents_team_name_idx ON agents(team_id, name);
    CREATE INDEX IF NOT EXISTS agents_team_visible_list_idx
      ON agents(team_id, deleted_at, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logical_agent_identities_team_idx
      ON logical_agent_identities(team_id, logical_agent);
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS agents_token_idx ON agents(token_id) WHERE token_id IS NOT NULL;

    -- T-CKPT.agent-sharing/F4: agent sharing/delegation grants over the Monday
    -- actor-ref seed model. share = visibility for the grantee; delegate =
    -- act-as/dispatch rights. Cross-org sharing is intentionally out of scope.
    CREATE TABLE IF NOT EXISTS agent_grant (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      grantor_actor_ref TEXT NOT NULL,
      grantee_actor_ref TEXT NOT NULL,
      grant_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_grant_agent_idx ON agent_grant(team_id, agent_id);
    CREATE INDEX IF NOT EXISTS agent_grant_grantee_idx ON agent_grant(team_id, grantee_actor_ref);

    -- Multi-LLM Slice B: runtime policy read model. A logical agent ("*" for
    -- default) can declare allowed provider lanes and an ordered runtime/model
    -- fallback chain without baking Claude-only assumptions into code.
    CREATE TABLE IF NOT EXISTS agent_runtime_policy (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      logical_agent TEXT NOT NULL,
      allowed_lanes_json TEXT NOT NULL DEFAULT '[]',
      fallback_order_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, logical_agent)
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_policy_team_idx
      ON agent_runtime_policy(team_id, enabled, logical_agent);

    CREATE TABLE IF NOT EXISTS schedule_definitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      message TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'schedule',
      delivery_mode TEXT NOT NULL DEFAULT 'talk',
      timezone TEXT,
      catch_up_policy TEXT NOT NULL DEFAULT 'skip',
      dedupe_window_seconds INTEGER NOT NULL DEFAULT 90,
      interval_seconds INTEGER,
      anchor_at INTEGER,
      max_runs INTEGER,
      expires_at INTEGER,
      local_time_seconds INTEGER,
      local_date TEXT,
      days_of_week TEXT,
      source_type TEXT NOT NULL DEFAULT 'yaml',
      source_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_targets (
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (schedule_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      scheduled_key TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      fired_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (schedule_id, agent_id, scheduled_key)
    );

    CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx ON schedule_runs(schedule_id, fired_at);
    CREATE INDEX IF NOT EXISTS schedule_runs_agent_idx ON schedule_runs(agent_id, fired_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
      owner TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      track TEXT NOT NULL DEFAULT '(unassigned)',
      UNIQUE(team_id, name)
    );

    CREATE TABLE IF NOT EXISTS task_event_links (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, schedule_id)
    );

    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS task_event_links_schedule_idx ON task_event_links(schedule_id, task_id);

    CREATE TABLE IF NOT EXISTS event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      actor_agent_id TEXT,
      subject_kind TEXT,
      subject_id TEXT,
      occurred_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS event_log_team_seq_idx ON event_log(team_id, seq);
    CREATE INDEX IF NOT EXISTS event_log_team_topic_seq_idx ON event_log(team_id, topic, seq);
    CREATE INDEX IF NOT EXISTS event_log_team_subject_idx ON event_log(team_id, subject_kind, subject_id, seq);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      owner_agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_acked_seq INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS subscriptions_team_owner_idx
      ON subscriptions(team_id, owner_agent_id, status);

    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      event_seq INTEGER NOT NULL,
      scheduled_at INTEGER NOT NULL,
      attempted_at INTEGER,
      status TEXT NOT NULL,
      http_status INTEGER,
      error TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_once_idx
      ON webhook_delivery_attempts(subscription_id, event_seq);

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      linked_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      interval_seconds INTEGER NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL,
      close_when TEXT NOT NULL,
      max_iterations INTEGER,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      next_fire_at INTEGER,
      snooze_until INTEGER,
      ttl_expires_at INTEGER,
      last_fire_at INTEGER,
      last_event_seq INTEGER REFERENCES event_log(seq) ON DELETE SET NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      closed_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS checkins_due_idx
      ON checkins(team_id, status, next_fire_at)
      WHERE next_fire_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS checkins_owner_idx
      ON checkins(team_id, owner_agent_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS checkins_task_idx
      ON checkins(team_id, linked_task_id, status);

    CREATE INDEX IF NOT EXISTS checkins_ttl_idx
      ON checkins(team_id, ttl_expires_at)
      WHERE ttl_expires_at IS NOT NULL AND status IN ('active', 'snoozed');

    CREATE TABLE IF NOT EXISTS dispatch_scheduler_queue (
      dispatch_phid               TEXT PRIMARY KEY,
      team_id                     TEXT NOT NULL,
      query_id                    TEXT NOT NULL,
      to_agent                    TEXT NOT NULL,
      from_actor                  TEXT NOT NULL,
      channel                     TEXT NOT NULL,
      subject                     TEXT NOT NULL,
      body_markdown               TEXT NOT NULL,
      provider                    TEXT NOT NULL,
      runtime                     TEXT NOT NULL,
      priority                    INTEGER NOT NULL DEFAULT 5,
      status                      TEXT NOT NULL,
      not_before_at               TEXT NOT NULL,
      attempt_count               INTEGER NOT NULL DEFAULT 0,
      bounce_count                INTEGER NOT NULL DEFAULT 0,
      last_bounce_json            TEXT,
      bounce_history_json         TEXT NOT NULL DEFAULT '[]',
      started_at                  TEXT,
      completed_at                TEXT,
      updated_at                  TEXT NOT NULL,
      agent_query_id              TEXT,
      usage_policy_snapshot_json  TEXT,
      failure_kind                TEXT,
      failure_detail              TEXT,
      target_url                  TEXT,
      result_json                 TEXT,
      recovery_status             TEXT DEFAULT 'none',
      recovery_attempts           INTEGER NOT NULL DEFAULT 0,
      recovery_reason             TEXT,
      side_effect                 TEXT NOT NULL DEFAULT 'none',
      allow_auto_retry            INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS dispatch_scheduler_eligible_idx
      ON dispatch_scheduler_queue(status, provider, runtime, not_before_at, priority);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_queue_read_idx
      ON dispatch_scheduler_queue(team_id, status, provider, runtime, priority DESC, not_before_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_in_flight_read_idx
      ON dispatch_scheduler_queue(team_id, status, provider, runtime, started_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_bounced_read_idx
      ON dispatch_scheduler_queue(team_id, status, provider, runtime, not_before_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_recent_terminal_idx
      ON dispatch_scheduler_queue(team_id, status, completed_at DESC, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_recent_list_idx
      ON dispatch_scheduler_queue(
        team_id,
        status,
        COALESCE(completed_at, started_at, updated_at, not_before_at) DESC,
        dispatch_phid DESC
      );
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_clarifications_read_idx
      ON dispatch_scheduler_queue(team_id, status, updated_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_query_id_idx
      ON dispatch_scheduler_queue(query_id);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_agent_query_id_idx
      ON dispatch_scheduler_queue(agent_query_id);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_team_agent_query_idx
      ON dispatch_scheduler_queue(team_id, agent_query_id)
      WHERE agent_query_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_scheduler_team_query_idx
      ON dispatch_scheduler_queue(team_id, query_id);

    -- ── Usage Meter (Spec 2026-05-31) ────────────────────────────────
    -- Per-event Anthropic token usage attributed to an agent.
    CREATE TABLE IF NOT EXISTS agent_usage_event (
      event_id                    TEXT PRIMARY KEY,
      provider                    TEXT NOT NULL DEFAULT 'anthropic',
      agent_id                    TEXT NOT NULL,
      dispatch_id                 TEXT,
      query_id                    TEXT,
      session_id                  TEXT,
      model                       TEXT,
      ts                          INTEGER NOT NULL,
      input_tokens                INTEGER NOT NULL DEFAULT 0,
      output_tokens               INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
      raw_tokens                  INTEGER NOT NULL,
      weighted_tokens             INTEGER NOT NULL,
      source                      TEXT NOT NULL,
      confidence                  TEXT NOT NULL,
      idempotency_key             TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS agent_usage_event_agent_ts_idx
      ON agent_usage_event(agent_id, ts);
    CREATE INDEX IF NOT EXISTS agent_usage_event_provider_ts_idx
      ON agent_usage_event(provider, ts);
    CREATE INDEX IF NOT EXISTS agent_usage_event_dispatch_idx
      ON agent_usage_event(dispatch_id)
      WHERE dispatch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS agent_usage_event_query_idx
      ON agent_usage_event(query_id)
      WHERE query_id IS NOT NULL;

    -- Pre-rolled daily/weekly usage per agent (and synthetic _global).
    CREATE TABLE IF NOT EXISTS agent_usage_rollup (
      provider             TEXT NOT NULL,
      agent_id             TEXT NOT NULL,
      window_kind          TEXT NOT NULL CHECK (window_kind IN ('day', 'week')),
      window_start         TEXT NOT NULL,
      window_end           TEXT NOT NULL,
      raw_tokens           INTEGER NOT NULL,
      weighted_tokens      INTEGER NOT NULL,
      requests             INTEGER NOT NULL,
      models_json          TEXT NOT NULL DEFAULT '[]',
      source_coverage_json TEXT NOT NULL DEFAULT '{}',
      computed_at          TEXT NOT NULL,
      PRIMARY KEY (provider, agent_id, window_kind, window_start)
    );

    -- Audit log of gate decisions (one row per global/agent decision).
    CREATE TABLE IF NOT EXISTS usage_gate_decision (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      scope           TEXT NOT NULL CHECK (scope IN ('global', 'agent')),
      agent_id        TEXT,
      state           TEXT NOT NULL,
      decision        TEXT NOT NULL,
      reason          TEXT NOT NULL,
      daily_pct       REAL,
      weekly_pct      REAL,
      policy_version  TEXT NOT NULL,
      metadata_json   TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS usage_gate_decision_ts_idx
      ON usage_gate_decision(ts);
    CREATE INDEX IF NOT EXISTS usage_gate_decision_agent_idx
      ON usage_gate_decision(agent_id, ts)
      WHERE agent_id IS NOT NULL;

    -- Continuous Orchestration: machine-readable backlog the daemon pulls from.
    -- Items enter as draft/needs_review (e.g. roadmap import) and are promoted
    -- to 'ready' only through a human/approval gate. The daemon NEVER invents
    -- work; it admits READY rows within guardrails.
    CREATE TABLE IF NOT EXISTS orchestration_backlog_item (
      item_id            TEXT PRIMARY KEY,
      team_id            TEXT NOT NULL,
      logical_key        TEXT,
      title              TEXT NOT NULL,
      track              TEXT,
      to_agent           TEXT,
      dispatch_body      TEXT,
      priority           INTEGER NOT NULL DEFAULT 5,
      value_score        REAL,
      readiness_state    TEXT NOT NULL DEFAULT 'draft',
      risk_class         TEXT NOT NULL DEFAULT 'routine',
      write_scope_json   TEXT NOT NULL DEFAULT '[]',
      dependencies_json  TEXT NOT NULL DEFAULT '[]',
      token_estimate     INTEGER,
      provider           TEXT,
      runtime            TEXT,
      is_north_star      INTEGER NOT NULL DEFAULT 0,
      source_refs_json   TEXT NOT NULL DEFAULT '[]',
      approved_by        TEXT,
      approved_at        TEXT,
      last_dispatch_phid TEXT,
      retry_safe         INTEGER NOT NULL DEFAULT 0,
      dispatch_retry_count INTEGER NOT NULL DEFAULT 0,
      stale_duplicate_closeout_receipt_json TEXT,
      updated_by         TEXT,
      track_drift        INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orchestration_backlog_ready_idx
      ON orchestration_backlog_item(team_id, readiness_state, priority, created_at);
    -- Append-only audit of every tick decision (dispatched / would_dispatch /
    -- skipped / held / guardrail_halt / stall_alert / auto_pause).
    CREATE TABLE IF NOT EXISTS orchestration_decision_log (
      decision_id   TEXT PRIMARY KEY,
      team_id       TEXT NOT NULL,
      tick_id       TEXT NOT NULL,
      ts            TEXT NOT NULL,
      item_id       TEXT,
      action        TEXT NOT NULL,
      reason        TEXT NOT NULL,
      dispatch_phid TEXT,
      dry_run       INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS orchestration_decision_tick_idx
      ON orchestration_decision_log(team_id, tick_id, ts);

    -- Singleton per team: live mode + guardrail counters.
    CREATE TABLE IF NOT EXISTS orchestration_state (
      team_id                TEXT PRIMARY KEY,
      mode                   TEXT NOT NULL DEFAULT 'paused',
      consecutive_zero_ticks INTEGER NOT NULL DEFAULT 0,
      last_admission_block_reasons_json TEXT NOT NULL DEFAULT '{}',
      last_tick_at           TEXT,
      last_dispatch_at       TEXT,
      auto_paused            INTEGER NOT NULL DEFAULT 0,
      auto_pause_reason      TEXT,
      updated_at             TEXT NOT NULL
    );
  `);

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS logical_agent_identities (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      logical_agent TEXT NOT NULL,
      display_name TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, logical_agent)
    );
    CREATE INDEX IF NOT EXISTS logical_agent_identities_team_idx
      ON logical_agent_identities(team_id, logical_agent);
  `);

  try {
    adapter.exec(`ALTER TABLE schedule_definitions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'talk'`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Continuous-orchestration backlog: stable logical-work key for idempotent
  // roadmap import/refuel. Nullable + non-unique to avoid migration failure on
  // pre-existing duplicate live rows; storage helpers enforce forward dedup.
  try {
    adapter.exec(`ALTER TABLE orchestration_backlog_item ADD COLUMN logical_key TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE orchestration_state ADD COLUMN last_admission_block_reasons_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // Column already exists in upgraded databases.
  }
  adapter.exec(`
    CREATE INDEX IF NOT EXISTS orchestration_backlog_logical_key_idx
      ON orchestration_backlog_item(team_id, logical_key)
      WHERE logical_key IS NOT NULL;
  `);

  // Continuous-orchestration backlog: actor-attributed PATCH updates.
  try {
    adapter.exec(`ALTER TABLE orchestration_backlog_item ADD COLUMN updated_by TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Continuous-orchestration backlog: track-conformance drift flag (Spec L1b).
  // Set at ingest when an item's track does not conform to the canonical-track-
  // registry. Warn + tag — never blocks ingestion.
  try {
    adapter.exec(`ALTER TABLE orchestration_backlog_item ADD COLUMN track_drift INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Daemon SELF-REFUEL (auto-flesh) — turn imported roadmap skeletons into
  // dispatch-ready READY items automatically. All additive, default-safe,
  // idempotent. See cto/output/2026-06-22-daemon-autonomous-engine-gap-scope.md.
  for (const stmt of [
    `ALTER TABLE orchestration_backlog_item ADD COLUMN retry_safe INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN dispatch_retry_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN stale_duplicate_closeout_receipt_json TEXT`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN flesh_status TEXT NOT NULL DEFAULT 'unfleshed'`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN flesh_source TEXT`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN flesh_confidence REAL`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN flesh_error TEXT`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN flesh_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN fleshed_at TEXT`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN auto_ready_approved_at TEXT`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN auto_ready_policy_version TEXT`,
    `ALTER TABLE orchestration_backlog_item ADD COLUMN flesh_patch_json TEXT`,
    // Daemon-attributed usage (Gap 2): spend-scope attribution on usage events.
    `ALTER TABLE agent_usage_event ADD COLUMN initiator_actor TEXT`,
    `ALTER TABLE agent_usage_event ADD COLUMN orchestration_tick_id TEXT`,
    `ALTER TABLE agent_usage_event ADD COLUMN orchestration_item_id TEXT`,
    `ALTER TABLE agent_usage_event ADD COLUMN spend_scope TEXT NOT NULL DEFAULT 'fleet'`,
  ]) {
    try {
      adapter.exec(stmt);
    } catch {
      // Column already exists in upgraded databases.
    }
  }
  adapter.exec(`
    CREATE INDEX IF NOT EXISTS orchestration_backlog_flesh_idx
      ON orchestration_backlog_item(team_id, readiness_state, flesh_status, priority, created_at);
    CREATE INDEX IF NOT EXISTS agent_usage_event_spend_scope_ts_idx
      ON agent_usage_event(spend_scope, ts);

    -- Append-only audit of every flesh decision (one row per item per attempt).
    CREATE TABLE IF NOT EXISTS orchestration_flesh_log (
      flesh_log_id        TEXT PRIMARY KEY,
      item_id             TEXT NOT NULL,
      team_id             TEXT NOT NULL,
      actor_ref           TEXT NOT NULL,
      source_ref          TEXT,
      input_hash          TEXT NOT NULL,
      output_hash         TEXT,
      decision            TEXT NOT NULL,
      reason              TEXT NOT NULL,
      proposed_patch_json TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orchestration_flesh_log_item_idx
      ON orchestration_flesh_log(team_id, item_id, created_at);
  `);

  // Tasks: add uuid column for short-id lookups (#xxxxxxxx)
  try {
    adapter.exec(`ALTER TABLE tasks ADD COLUMN uuid TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Tasks: canonical-track tagging (Spec — canonical-track-registry).
  // Existing tasks (1362 at migration time) carry no track → default to
  // '(unassigned)'; new writes validate against the registry (soft-warn only).
  try {
    adapter.exec(`ALTER TABLE tasks ADD COLUMN track TEXT NOT NULL DEFAULT '(unassigned)'`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // news_items: layered metadata (talk|notify plus reply_expected) on top of
  // the existing event `type`. Populated on new writes; old rows stay null.
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN kind TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN reply_expected INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // queries / news_items: inbox ownership (owner_kind + owner_id), legacy agent_id retained.
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'agent'`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'agent'`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists in upgraded databases.
  }
  await adapter.query(`
    UPDATE queries SET
      owner_kind = CASE WHEN agent_id GLOB 'manager-*' THEN 'manager' ELSE 'agent' END,
      owner_id = CASE WHEN agent_id GLOB 'manager-*' THEN team_id ELSE agent_id END
    WHERE owner_id = ''
  `);
  await adapter.query(`
    UPDATE news_items SET
      owner_kind = CASE WHEN agent_id GLOB 'manager-*' THEN 'manager' ELSE 'agent' END,
      owner_id = CASE WHEN agent_id GLOB 'manager-*' THEN team_id ELSE agent_id END
    WHERE owner_id = ''
  `);
  adapter.exec(`
    CREATE INDEX IF NOT EXISTS queries_team_owner_idx ON queries(team_id, owner_kind, owner_id);
    CREATE INDEX IF NOT EXISTS news_items_team_owner_time_idx ON news_items(team_id, owner_kind, owner_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_owner_query_idx ON news_items(team_id, owner_kind, owner_id, query_id);
  `);

  // Remote endpoint columns for public-agent-remote registry entries (Phase 2).
  // All four columns are nullable so existing rows stay intact (backfill-safe).
  // Each ALTER is wrapped in try/catch so a repeated migration call is a no-op.
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN customer_domain TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN public_endpoint_url TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN internal_endpoint_url TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN ssh_target TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Phase 5: remote heartbeat probe columns.
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_seen INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_probed_at INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_error TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Backfill uuid for any existing rows that lack one
  const missing = await adapter.query<{ id: string }>(`SELECT id FROM tasks WHERE uuid IS NULL OR uuid = ''`);
  for (const row of missing.rows) {
    await adapter.query(`UPDATE tasks SET uuid = ? WHERE id = ?`, [crypto.randomUUID(), row.id]);
  }

  adapter.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid)`);

  // Multi-LLM Slice B: runtime policy read model for upgraded databases.
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_policy (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      logical_agent TEXT NOT NULL,
      allowed_lanes_json TEXT NOT NULL DEFAULT '[]',
      fallback_order_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, logical_agent)
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_policy_team_idx
      ON agent_runtime_policy(team_id, enabled, logical_agent);
  `);

  // Spec 054 v2 ─ dispatch_scheduler_queue clarification + promotion columns.
  // All additive, default-safe, idempotent (try/catch so re-running is a no-op).
  for (const stmt of [
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN clarification_id TEXT`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN active_clarification_json TEXT`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN clarification_history_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN resume_delivery_status TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN promote INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN promotion_strategy TEXT NOT NULL DEFAULT 'auto'`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN promotion_required_reason TEXT`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN promotion_result_json TEXT`,
    // Spec 054 v2 Part 2 ─ enqueue-side promotion input (repo, branch,
    // base, remote, optional skip-reason). JSON-encoded; null on
    // non-build dispatches.
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN promotion_input_json TEXT`,
    // Spec 056 ─ first-class artifact path sourced from
    // /agent-done.result.artifact_path. Null until done-time.
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN artifact_path TEXT`,
    // Recovery-state columns. Additive, default-safe; NOT NULL columns
    // carry a DEFAULT so sqlite ADD COLUMN accepts them on existing rows.
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN recovery_status TEXT DEFAULT 'none'`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN recovery_reason TEXT`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN side_effect TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN allow_auto_retry INTEGER NOT NULL DEFAULT 0`,
    // T-RECON.2 (2026-06-22): supersede_link — when a failed dispatch's work was
    // redone/superseded by a later dispatch, this points at the superseding
    // dispatch_phid so the read-model mootes it (rule 7/4) out of NEEDS-YOU.
    // The documented v2 follow-up; null until a supersede/retry/reassign sets it.
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN supersede_link TEXT`,
    // P0 control-plane Slice 3 (2026-06-25): dedup_key collapses re-fires of the
    // same logical work. The pre-insert guard reuses an existing NON-TERMINAL
    // dispatch for the key; the partial unique index below is the DB backstop.
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN dedup_key TEXT`,
    // T-RELIABILITY (2026-07-04): durable classification of FAILED rows into
    // real_failure / replay_duplicate / superseded, split out of the ~1100+
    // failed-dispatch count (2026-06-30 overnight routing audit) so reliability
    // metrics stop conflating scheduler-replay noise with genuine task
    // failures. Null until the sweep (sweepReliabilityClassification) runs.
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN reliability_classification TEXT`,
    `ALTER TABLE dispatch_scheduler_queue ADD COLUMN reliability_classification_reason TEXT`,
  ]) {
    try {
      adapter.exec(stmt);
    } catch {
      // Column already exists in upgraded databases.
    }
  }

  // P0 control-plane Slice 3 — at most ONE active dispatch per (team, dedup_key).
  // Partial unique index over the NON-TERMINAL, non-recovered statuses:
  // terminal/mooted/reconciled rows are excluded so a legitimate refire is allowed.
  adapter.exec(`DROP INDEX IF EXISTS dispatch_scheduler_dedup_active_idx`);
  adapter.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_scheduler_dedup_active_idx
      ON dispatch_scheduler_queue(team_id, dedup_key)
      WHERE dedup_key IS NOT NULL
        AND status IN ('queued','in_flight','bounced','needs_clarification','resume_delivery_failed')
        AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done');
  `);

  // Spec 056 ─ artifact_path index + one-time backfill from result_json.
  adapter.exec(`
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_artifact_path_idx
      ON dispatch_scheduler_queue(team_id, artifact_path)
      WHERE artifact_path IS NOT NULL;
  `);
  await adapter.query(`
    UPDATE dispatch_scheduler_queue
    SET artifact_path = json_extract(result_json, '$.artifact_path')
    WHERE artifact_path IS NULL
      AND result_json IS NOT NULL
      AND json_extract(result_json, '$.artifact_path') IS NOT NULL
      AND json_extract(result_json, '$.artifact_path') != ''
  `);

  adapter.exec(`
    CREATE INDEX IF NOT EXISTS agents_team_visible_list_idx
      ON agents(team_id, deleted_at, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_queue_read_idx
      ON dispatch_scheduler_queue(team_id, status, provider, runtime, priority DESC, not_before_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_in_flight_read_idx
      ON dispatch_scheduler_queue(team_id, status, provider, runtime, started_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_bounced_read_idx
      ON dispatch_scheduler_queue(team_id, status, provider, runtime, not_before_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_recent_terminal_idx
      ON dispatch_scheduler_queue(team_id, status, completed_at DESC, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_recent_list_idx
      ON dispatch_scheduler_queue(
        team_id,
        status,
        COALESCE(completed_at, started_at, updated_at, not_before_at) DESC,
        dispatch_phid DESC
      );
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_clarifications_read_idx
      ON dispatch_scheduler_queue(team_id, status, updated_at, dispatch_phid);
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_team_agent_query_idx
      ON dispatch_scheduler_queue(team_id, agent_query_id)
      WHERE agent_query_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS dispatch_scheduler_reliability_idx
      ON dispatch_scheduler_queue(team_id, status, reliability_classification);
  `);

  await migrateQueriesTeamQueryPkSqlite(adapter);
  await migrateNewsItemsNullableAgentSqlite(adapter);
  await migrateDeleteManagerShadowAgentsSqlite(adapter);

  // B1 (2026-06-08): worker-progress evidence column on queries. Stamped on
  // every harness output (thinking / tool_use / progress) so the manager can
  // derive silence_age_seconds and distinguish working-but-slow from
  // silently-wedged. Idempotent; runs after the queries-PK rebuild so the
  // column is added to the final shape, not the legacy one.
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN last_output_at INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN manager_dispatch_id TEXT`);
  } catch { /* already exists */ }
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN manager_query_id TEXT`);
  } catch { /* already exists */ }

  // Tasks: migrate from global name UNIQUE to (team_id, name) UNIQUE.
  // SQLite does not support DROP CONSTRAINT, so we use the rename-copy-swap pattern
  // guarded by a PRAGMA check to detect whether the old global uniqueness is still present.
  await migrateTasks_TeamNameUnique(adapter);

  // P6 Agent Performance Telemetry tables (idempotent — CREATE IF NOT EXISTS).
  const { migrateTelemetryTables } = await import('../../telemetry/storage.js');
  migrateTelemetryTables(adapter);

  // P2 Inbox 2.0 read-model tables (idempotent — CREATE IF NOT EXISTS).
  const { migrateInboxTables } = await import('../../inbox/storage.js');
  migrateInboxTables(adapter);

  // Task comment reactor v0 — durable note intake + routing receipts.
  const { migrateTaskCommentTables } = await import('../../task-comments/storage.js');
  await migrateTaskCommentTables(adapter);

  // Kapelle B11 — artifact review surface (idempotent — CREATE IF NOT EXISTS).
  const { migrateOutputsTables } = await import('../../outputs/storage.js');
  await migrateOutputsTables(adapter);

  // DV3 — doc-model FTS indexes (desk + tasks) for GET /search.
  const { migrateDocModelFtsIndexes } = await import('../../doc-model/fts-migration.js');
  await migrateDocModelFtsIndexes(adapter);

  // Doc-model substrate slice 1 — artifacts as documents (op-log + projection).
  const { migrateDocModelDocumentTables } = await import('../../doc-model/artifact-document.js');
  await migrateDocModelDocumentTables(adapter);

  // P1 Dependency-Graph Orchestrator tables (idempotent — CREATE IF NOT EXISTS).
  const { migrateGraphTables } = await import('../../graph/storage.js');
  migrateGraphTables(adapter);

  // Build-pool merge-queue (idempotent — CREATE IF NOT EXISTS).
  const { migrateMergeQueueTables } = await import('../../merge-queue/storage.js');
  await migrateMergeQueueTables(adapter);
}

/**
 * Idempotent migration: change tasks uniqueness from `name UNIQUE` to
 * `UNIQUE(team_id, name)`.
 *
 * Approach: check if the tasks table has a column-level UNIQUE on `name`
 * (present when `name TEXT NOT NULL UNIQUE` was used). If it does, rebuild
 * the table with the new composite constraint.
 *
 * This runs on every start but is a no-op if the constraint is already correct.
 */
async function migrateTasks_TeamNameUnique(adapter: SqliteAdapter): Promise<void> {
  // Inspect the existing CREATE TABLE SQL for the tasks table
  const { rows } = await adapter.query<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`,
  );
  if (!rows[0]) return; // table doesn't exist yet (first run handled by CREATE TABLE above)

  const ddl = rows[0].sql || '';

  // If the DDL already has UNIQUE(team_id, name), migration is done
  if (ddl.includes('UNIQUE(team_id, name)') || ddl.includes('UNIQUE (team_id, name)')) return;

  // Check whether the old global name UNIQUE is present (column-level UNIQUE on name)
  // Look for 'name TEXT NOT NULL UNIQUE' pattern
  if (!ddl.toLowerCase().includes('name text not null unique')) return;

  // Rename-copy-swap migration
  adapter.exec(`
    ALTER TABLE tasks RENAME TO tasks_old;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
      owner TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(team_id, name)
    );

    INSERT INTO tasks SELECT * FROM tasks_old;

    DROP TABLE tasks_old;

    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid);
  `);
}

/**
 * Reverse inbox ownership projection for legacy readers: for rows with
 * `owner_kind = 'manager'`, set `agent_id = manager-<team name>` from `teams`.
 * Not run on startup — tests call this explicitly.
 */
export async function downMigrateInboxOwnershipSqlite(adapter: SqliteAdapter): Promise<void> {
  await adapter.query(`
    UPDATE queries
    SET agent_id = 'manager-' || (SELECT name FROM teams WHERE teams.id = queries.team_id)
    WHERE owner_kind = 'manager'
  `);
  await adapter.query(`
    UPDATE news_items
    SET agent_id = 'manager-' || (SELECT name FROM teams WHERE teams.id = news_items.team_id)
    WHERE owner_kind = 'manager'
  `);
}

/**
 * Recreate hidden manager-<team> stub rows then dual-write legacy agent_id (tests / rollback).
 */
export async function downMigrateRecreateManagerShadowAgentsSqlite(adapter: SqliteAdapter): Promise<void> {
  const ts = Date.now();
  const meta = JSON.stringify({ canReceiveDirectMessages: false, shadowOnly: true });
  const { rows: teams } = await adapter.query<{ id: string; name: string }>(
    `SELECT id, name FROM teams`,
  );
  for (const t of teams) {
    const shadowId = `manager-${t.name}`;
    const { rows: cntRows } = await adapter.query<{ c: number }>(
      `SELECT (
        (SELECT COUNT(*) FROM queries WHERE team_id = ? AND owner_kind = 'manager') +
        (SELECT COUNT(*) FROM news_items WHERE team_id = ? AND owner_kind = 'manager')
      ) AS c`,
      [t.id, t.id],
    );
    if (Number(cntRows[0]?.c) === 0) continue;

    await adapter.query(
      `INSERT OR REPLACE INTO agents (
        id, team_id, name, type, model, port, endpoint, working_directory,
        status, created_at, registry, metadata, deleted_at, runtime,
        token_id, domain, api_key,
        customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target,
        last_seen, last_probed_at, last_error, consecutive_failures
      ) VALUES (
        ?, ?, 'manager', 'interactive', '', 0, '', NULL,
        'stub', ?, NULL, ?, ?, 'claude-agent-sdk',
        NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 0
      )`,
      [shadowId, t.id, ts, meta, ts],
    );
  }
  await downMigrateInboxOwnershipSqlite(adapter);
}
