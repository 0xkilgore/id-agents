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
import type { AgentRow, TeamRow, QueryRow, NewsItemRow } from './types.js';

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

  /** Set the sepolia_registrar_address in the team config. */
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

  /** Close the database connection / file handle. */
  close(): Promise<void>;
}
