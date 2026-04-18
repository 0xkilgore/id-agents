// SPDX-License-Identifier: MIT

/**
 * Repository interfaces and composite Db service.
 *
 * These interfaces define the application-facing database API.
 * Each repository has dialect-specific implementations (postgres / sqlite)
 * that handle SQL differences, JSON parsing, and placeholder styles internally.
 *
 * Application code depends only on these interfaces — never on raw SQL or
 * a specific adapter.
 */

import type { DbAdapter } from './db-adapter.js';
import type { AgentRow, TeamRow, QueryRow, NewsItemRow, ScheduleDefinitionRow, ScheduleRunRow, TaskRow, TaskEventLinkRow } from './types.js';

// ---------------------------------------------------------------------------
// TeamsRepository
// ---------------------------------------------------------------------------

export interface TeamsRepository {
  /**
   * Find or create a team by name. Returns the team's UUID.
   * If the team already exists, returns its existing id.
   */
  getOrCreateTeamId(teamName: string): Promise<string>;

  /** Fetch a single team by id, or null if not found. */
  getTeam(teamId: string): Promise<TeamRow | null>;

  /** Fetch a single team by name, or null if not found. */
  getTeamByName(name: string): Promise<TeamRow | null>;

  /** Return the parsed config JSON for a team (empty object if none). */
  getConfig(teamId: string): Promise<Record<string, unknown>>;

  /** List all teams ordered by created_at descending. */
  listTeams(): Promise<TeamRow[]>;

  /** List all teams with their full config (for /projects compat). */
  listTeamsWithConfig(): Promise<TeamRow[]>;

  /** Set the registrar_address in the team config. */
  setRegistrarAddress(teamId: string, address: string): Promise<void>;

  /** Set both default_chain_id and default_registry_address in the team config. */
  setDefaultRegistry(teamId: string, chainId: string, registryAddress: string): Promise<void>;

  /** Permanently delete a team row. */
  deleteTeam(teamId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// AgentsRepository
// ---------------------------------------------------------------------------

export interface AgentsRepository {
  /** Look up an agent by its primary key (id). Non-deleted only. */
  getById(agentId: string): Promise<AgentRow | null>;

  /**
   * Look up the most recent non-deleted agent by exact name match
   * (also checks metadata->>'alias'). Falls back to flexible resolution
   * via parseAgentRef if no exact match.
   */
  getByName(teamId: string, name: string): Promise<AgentRow | null>;

  /**
   * Resolve all non-deleted agents matching a reference string.
   * The ref is parsed into alias / tokenId / domain components.
   * Returns all matches (caller decides how to handle ambiguity).
   */
  resolve(teamId: string, ref: string, tokenId?: string): Promise<AgentRow[]>;

  /**
   * Resolve a single agent for message routing.
   * Supports name, id, alias, displayId (alias.tokenId), and ENS domain.
   * Returns null if not found, most-recent if ambiguous.
   */
  getForRouting(teamId: string, ref: string, tokenId?: string): Promise<AgentRow | null>;

  /**
   * List all non-deleted agents in a team.
   * By default hides automator agents; pass includeAutomator=true to include them.
   */
  list(teamId: string, includeAutomator?: boolean): Promise<AgentRow[]>;

  /**
   * Global sequential port allocation.
   * Returns the next available port (max port across all claude agents + 1,
   * starting at 4101 if no agents exist).
   */
  nextPort(): Promise<number>;

  /** Count non-deleted agents in a team. Returns count as a string. */
  count(teamId: string): Promise<string>;

  /** Find the interactive-type agent for a team (most recent, non-deleted). */
  findInteractive(teamId: string): Promise<AgentRow | null>;

  /**
   * Find an agent by onchain registry identity (chainId + registryAddress + tokenId).
   * Matches against the registry JSONB column.
   */
  findByRegistry(teamId: string, chainId: string, registryAddress: string, tokenId: string): Promise<AgentRow | null>;

  /**
   * Find agents that have heartbeat enabled in their metadata.
   * Returns running agents where metadata->>'heartbeat' = 'true'.
   */
  findHeartbeat(teamId: string): Promise<AgentRow[]>;

  /**
   * Insert a new agent row.
   * Required fields: team_id, id, name, type, model, status, created_at.
   * All other fields from AgentRow are optional (use Partial).
   */
  create(
    agent: Partial<AgentRow> & {
      team_id: string;
      id: string;
      name: string;
      type: string;
      model: string;
      status: string;
      created_at: number;
    },
  ): Promise<void>;

  /**
   * Insert-or-update an agent row (ON CONFLICT by team_id + id).
   * Required fields: team_id, id, name. All other fields merged on conflict.
   */
  upsert(agent: Partial<AgentRow> & { team_id: string; id: string; name: string }): Promise<void>;

  /**
   * Update identity-related columns for an agent: name, token_id, domain,
   * endpoint, and/or metadata (full replace).
   */
  updateIdentity(
    agentId: string,
    fields: {
      name?: string;
      token_id?: string;
      domain?: string;
      endpoint?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;

  /** Replace the full metadata JSON for an agent. */
  updateMetadata(agentId: string, metadata: Record<string, unknown>): Promise<void>;

  /**
   * Update agent status, with optional extra column updates
   * (port, endpoint, metadata, model).
   */
  updateStatus(
    agentId: string,
    status: string,
    extra?: {
      port?: number;
      endpoint?: string;
      metadata?: Record<string, unknown>;
      model?: string;
    },
  ): Promise<void>;

  /**
   * Soft-delete agents matching a team + name, excluding a specific id.
   * Sets deleted_at to the given timestamp.
   * Used for dedup when re-registering by name.
   */
  softDelete(teamId: string, name: string, excludeId: string, timestamp: number): Promise<void>;

  /** Permanently delete an agent row (cascades to wallets, news, queries). */
  deleteAgent(agentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// QueriesRepository
// ---------------------------------------------------------------------------

export interface QueriesRepository {
  /** Insert a new query row. */
  create(
    teamId: string,
    queryId: string,
    agentId: string,
    prompt: string,
    created: number,
    sessionId?: string,
  ): Promise<void>;

  /** Look up a single query by agent_id and query_id. */
  getById(agentId: string, queryId: string): Promise<QueryRow | null>;

  /**
   * Look up a single query by team_id and query_id.
   * Team-scoped one-row lookup (query_ids are globally unique in practice but
   * enforcing the team scope prevents cross-team leakage over the HTTP API).
   */
  getByQueryIdForTeam(teamId: string, queryId: string): Promise<QueryRow | null>;

  /**
   * Mark queries older than `cutoffMs` and still in the given terminal-or-open
   * statuses as `expired`. Returns the number of rows updated.
   * Used by the crash sweeper to clear stuck queries whose agent process died.
   */
  expireStale(cutoffCreated: number, statuses: string[]): Promise<number>;

  /**
   * Insert-or-update a query row (ON CONFLICT by agent_id, query_id).
   * On conflict, updates status, completed, result, error, and session_id.
   */
  upsert(
    teamId: string,
    agentId: string,
    query: Partial<QueryRow> & { query_id: string },
  ): Promise<void>;

  /**
   * Mark a query as completed: set status='completed', completed timestamp,
   * and result JSON.
   */
  complete(
    teamId: string,
    queryId: string,
    completed: number,
    result: Record<string, unknown> | null,
  ): Promise<void>;

  /**
   * Look up the team_id that owns a query (by query_id alone, across all teams).
   * Used to route replies to the correct team.
   */
  findTeam(queryId: string): Promise<string | null>;

  /**
   * Get all pending/processing queries for an agent, ordered by created ascending.
   */
  getPending(agentId: string): Promise<QueryRow[]>;

  /**
   * Cancel all pending/processing queries for an agent.
   * Sets status='cancelled' and completed timestamp.
   * Returns the list of cancelled query_ids.
   */
  cancel(agentId: string, completed: number): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// NewsRepository
// ---------------------------------------------------------------------------

export interface NewsRepository {
  /** Insert a news item for an agent. */
  add(
    teamId: string,
    agentId: string,
    item: {
      timestamp: number;
      type: string;
      message?: string;
      data?: Record<string, unknown>;
      query_id?: string;
      /** Structured classifier layered on top of `type`: 'talk' | 'notify'. */
      kind?: 'talk' | 'notify';
      /** Explicit reply-expected flag (defaults to kind === 'talk' when omitted). */
      reply_expected?: boolean;
    },
  ): Promise<void>;

  /**
   * Poll news items for an agent since a given timestamp.
   * Ordered by timestamp descending. Supports optional limit and query_id filter.
   */
  poll(
    agentId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]>;

  /**
   * Poll news items for an agent strictly after a given monotonic id.
   * Ordered by id ascending so the caller can walk the cursor forward by
   * using `items[items.length - 1].id` as the next since_id.
   * Supports optional limit and query_id filter.
   */
  pollSinceId(
    agentId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]>;

  /**
   * Get recent news items across a team, filtered by type(s).
   * Ordered by timestamp descending, limited to `limit` rows.
   */
  getRecent(teamId: string, types: string[], limit: number): Promise<NewsItemRow[]>;

  /**
   * Fetch all news items older than the given timestamp for archiving.
   * Ordered by timestamp ascending.
   */
  fetchForArchive(teamId: string, before: number): Promise<NewsItemRow[]>;

  /** Delete all news items older than the given timestamp. */
  deleteArchived(teamId: string, before: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// SchedulesRepository
// ---------------------------------------------------------------------------

export interface SchedulesRepository {
  /** Insert or update a schedule definition by id. */
  upsertDefinition(def: ScheduleDefinitionRow): Promise<void>;

  /** Replace target agents for a schedule (delete existing, insert new). */
  replaceTargets(scheduleId: string, agentIds: string[]): Promise<void>;

  /** List all active schedule definitions. */
  listActiveDefinitions(): Promise<ScheduleDefinitionRow[]>;

  /** List all schedule definitions, active and inactive. */
  listAllDefinitions(): Promise<ScheduleDefinitionRow[]>;

  /** List target agent IDs for a schedule. */
  listTargets(scheduleId: string): Promise<string[]>;

  /**
   * Attempt to insert a run log entry.
   * Returns true if inserted, false if the (schedule_id, agent_id, scheduled_key)
   * already exists (dedupe).
   */
  insertRun(run: ScheduleRunRow): Promise<boolean>;

  /** Update status (and optional error) on an existing run log entry. */
  updateRunStatus(
    scheduleId: string,
    agentId: string,
    scheduledKey: string,
    status: 'pending' | 'sent' | 'failed' | 'skipped',
    error?: string | null,
  ): Promise<void>;

  /** List all active schedules targeting a given agent. */
  listSchedulesForAgent(agentId: string): Promise<ScheduleDefinitionRow[]>;

  /** Delete all schedule definitions matching a source_type (and optional source_key prefix). */
  deleteBySource(sourceType: string, sourceKeyPrefix?: string): Promise<void>;

  /** Get a single schedule definition by id. */
  getDefinition(scheduleId: string): Promise<ScheduleDefinitionRow | null>;

  /** List recent runs for a schedule, ordered by fired_at desc. */
  listRuns(scheduleId: string, limit?: number): Promise<ScheduleRunRow[]>;

  /** Count completed runs for a schedule+agent pair. */
  countRuns(scheduleId: string, agentId: string): Promise<number>;

  /** Set the active flag on a schedule definition. */
  setActive(scheduleId: string, active: boolean): Promise<void>;

  /** Delete a schedule definition by id (cascades to targets and runs). */
  deleteDefinition(scheduleId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// TasksRepository
// ---------------------------------------------------------------------------

export interface TasksRepository {
  /** Insert a new task, optionally linking it to calendar schedule ids. */
  create(task: TaskRow, eventScheduleIds?: string[]): Promise<void>;

  /** Look up a task by its unique name slug (global, ignores team). */
  getByName(name: string): Promise<TaskRow | null>;

  /**
   * Look up a task by (team_id, name) — the new (team_id, name) unique key.
   * This is the preferred method for all team-scoped lookups.
   */
  getByNameForTeam(name: string, teamId: string): Promise<TaskRow | null>;

  /**
   * Look up tasks whose `uuid` starts with the given prefix.
   * Used for short-id resolution (`#xxxxxxxx`). Caller decides
   * how to handle ambiguity (no match → not found; multiple →
   * ask the user to widen the prefix).
   */
  getByUuidPrefix(prefix: string): Promise<TaskRow[]>;

  /** List tasks with optional filters on status, owner, and team. */
  list(filters?: {
    status?: 'todo' | 'doing' | 'done';
    owner?: string;
    teamId?: string | null;
  }): Promise<TaskRow[]>;

  /** Update one or more mutable fields on a task. */
  updateFields(
    taskId: string,
    fields: {
      team_id?: string | null;
      owner?: string | null;
      status?: 'todo' | 'doing' | 'done';
      title?: string;
      description?: string | null;
      completed_at?: number | null;
      updated_at: number;
    },
  ): Promise<void>;

  /**
   * Atomically claim an unowned todo task.
   * Sets owner, status='doing', and updated_at.
   * Returns true if the claim succeeded, false if already owned or not todo.
   */
  claim(taskId: string, ownerId: string, updatedAt: number): Promise<boolean>;

  /** Delete a task by id (task_event_links cascade). */
  delete(taskId: string): Promise<void>;

  /** Replace all event links for a task (delete existing, insert new). */
  replaceEventLinks(taskId: string, scheduleIds: string[]): Promise<void>;

  /** List event link schedule_ids for a task. */
  listEventLinksForTask(taskId: string): Promise<Array<{ schedule_id: string }>>;

  /** List all tasks linked to a given schedule definition. */
  listTasksForSchedule(scheduleId: string): Promise<TaskRow[]>;
}

// ---------------------------------------------------------------------------
// Db — composite service
// ---------------------------------------------------------------------------

/**
 * The top-level database service exposed to application code.
 *
 * Usage:
 *   const db = await createDb();
 *   await migrateDb(db);
 *   const teamId = await db.teams.getOrCreateTeamId('default');
 *   const agents = await db.agents.list(teamId);
 */
export interface Db {
  /** The underlying adapter (for escape-hatch raw queries during migration). */
  adapter: DbAdapter;

  teams: TeamsRepository;
  agents: AgentsRepository;
  queries: QueriesRepository;
  news: NewsRepository;
  schedules: SchedulesRepository;
  tasks: TasksRepository;

  /** Close the database connection / file handle. */
  close(): Promise<void>;
}
