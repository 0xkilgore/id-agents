// SPDX-License-Identifier: MIT
/**
 * Agent Manager (DB-backed)
 *
 * Persistent manager that stores agents/metadata in Postgres with multi-network scoping.
 * Runtime (live HTTP servers) still live in-memory, but all durable state is in the DB.
 *
 * Wallet management: agents no longer have individual wallets stored in the DB.
 * A shared deployer key (AGENT_PRIVATE_KEY from .env) is used for onchain operations.
 * Per-agent keys can be provided via .env.<agent_id> files in the repo root.
 */

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, openSync, closeSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import yaml from 'js-yaml';
import { ClaudeAgentServer } from './claude-agent-server.js';
import { registerOnIdChain, createSubnameOnIdChain, setMultiChainAddresses } from './onchain/idchain-register.js';
import { type Db, getOrCreateTeamId } from './db.js';
import fetch from 'node-fetch';
import type { PluginConfig, DeployConfig, HeartbeatConfig } from './config-parser.js';
import { processConfig } from './config-parser.js';
import { parseAgentRef, normalizeAlias, buildAmbiguityWarning, type AgentMatch } from './core/agent-identifier.js';
import { safeCompare } from './core/safe-compare.js';
import type { HarnessType } from './harness/types.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model alias resolution
const MODEL_ALIASES: Record<string, string> = {
  'haiku': 'claude-haiku-4-5-20251001',
  'sonnet': 'claude-sonnet-4-5-20250514',
  'opus': 'claude-opus-4-5-20250514'
};

function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model.toLowerCase()] || model;
}

// REST-AP catalog types
interface RestAPCatalog {
  restap_version?: string;
  agent?: {
    name?: string;
    description?: string;
  };
  endpoints?: {
    talk?: string;
    news?: string;
    news_post?: string;
  };
  capabilities?: Array<{
    id: string;
    method: string;
    endpoint: string;
  }>;
}

// Cache for REST-AP catalogs (endpoint -> catalog)
const restapCatalogCache = new Map<string, { catalog: RestAPCatalog; fetchedAt: number }>();
const CATALOG_CACHE_TTL = 60000; // 1 minute cache

/**
 * Discover REST-AP endpoints from an agent's catalog
 * @param baseEndpoint The agent's base endpoint (e.g., http://localhost:4101)
 * @returns The discovered endpoints or defaults if catalog unavailable
 */
async function discoverRestAPEndpoints(baseEndpoint: string): Promise<{ talk: string; news: string }> {
  const now = Date.now();
  const cached = restapCatalogCache.get(baseEndpoint);

  // Return cached catalog if still valid
  if (cached && (now - cached.fetchedAt) < CATALOG_CACHE_TTL) {
    return {
      talk: cached.catalog.endpoints?.talk || '/talk',
      news: cached.catalog.endpoints?.news || '/news'
    };
  }

  try {
    const catalogUrl = `${baseEndpoint.replace(/\/+$/, '')}/.well-known/restap.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(catalogUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const catalog = await response.json() as RestAPCatalog;
      restapCatalogCache.set(baseEndpoint, { catalog, fetchedAt: now });

      return {
        talk: catalog.endpoints?.talk || '/talk',
        news: catalog.endpoints?.news || '/news'
      };
    }
  } catch (err) {
    // Catalog fetch failed, use defaults
    console.log(`[REST-AP] Could not fetch catalog from ${baseEndpoint}: ${(err as Error).message}`);
  }

  // Default REST-AP endpoints
  return { talk: '/talk', news: '/news' };
}

type AgentType = 'claude' | 'virtual' | 'interactive' | 'automator';
type AgentStatus = 'starting' | 'running' | 'stopped' | 'error' | 'offline';

type AgentRegistryId = {
  chainId: number;
  registryAddress: string;
};

type AgentMetadata = Record<string, any> & {
  name?: string;
  service_type?: string;  // e.g., "REST-AP", "MCP", "A2A"
  service?: string;       // The service URL (e.g., https://idbot.live/{id})
  agent_account?: string;
  requireAuth?: boolean;
};

type AgentRow = {
  team_id: string;
  id: string;
  name: string;
  type: AgentType;
  model: string;
  port: number;
  endpoint: string | null;
  working_directory: string | null;
  status: AgentStatus;
  created_at: number;
  registry: any;
  metadata: any;
  deleted_at: number | null;
  token_id: string | null;
  domain: string | null;
};

// WebSocket client tracking
interface WSClient {
  ws: WebSocket;
  teamId: string;
  teamName: string;
  authenticated: boolean;
}

// Pending waiter for /talk-to replies - persists until reply arrives
interface QueryWaiter {
  resolve: (result: { from: string; message: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

export class AgentManagerDb {
  private managementApp: express.Application;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private wsClients: Set<WSClient> = new Set();
  private baseWorkDir: string;
  private db: Db;
  private runningServers: Map<string, ClaudeAgentServer> = new Map(); // key: `${teamId}:${agentId}`
  private agentRole: 'manager' | 'worker' = 'manager';
  private defaultConfig: DeployConfig['defaults'] | null = null;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map(); // key: agentId
  private heartbeatLastSent: Map<string, number> = new Map(); // key: agentId, value: timestamp (ms)
  private heartbeatIntervals: Map<string, number> = new Map(); // key: agentId, value: interval (ms)
  private heartbeatIntervalMs: number = 5 * 60 * 1000; // 5 minutes default
  private heartbeatCounts: Map<string, number> = new Map(); // key: agentId, value: beats sent
  private heartbeatStartTimes: Map<string, number> = new Map(); // key: agentId, value: start timestamp
  private queryWaiters: Map<string, QueryWaiter> = new Map(); // key: query_id
  private healthStatus: Map<string, { status: 'online' | 'offline' | 'unknown'; lastCheck: number }> = new Map(); // key: `${teamId}:${agentId}`
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private logBuffer: Array<{ ts: number; msg: string }> = [];
  private readonly LOG_BUFFER_SIZE = 500;

  /** Log a manager activity message to the ring buffer (not stdout) */
  private managerLog(msg: string) {
    this.logBuffer.push({ ts: Date.now(), msg });
    if (this.logBuffer.length > this.LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
  }

  constructor(baseWorkDir: string = '/workspace', db: Db) {
    this.baseWorkDir = baseWorkDir;
    this.db = db;
    this.agentRole = (process.env.AGENT_ROLE as 'manager' | 'worker') || 'manager';

    // Load default deployment config
    this.loadDefaultConfig();

    this.managementApp = express();
    this.managementApp.use(express.json());

    // Auth removed — local-only system, no API keys needed
    this.managementApp.use((_req, _res, next) => next());

    // Ensure teams + manager dirs exist in the mounted workspace
    const teamsDir = `${baseWorkDir}/teams`;
    if (!existsSync(teamsDir)) mkdirSync(teamsDir, { recursive: true });
    const managerDir = `${baseWorkDir}/manager`;
    if (!existsSync(managerDir)) mkdirSync(managerDir, { recursive: true });

    this.setupRoutes();
  }

  /**
   * Load default deployment configuration from configs/default.yaml
   */
  private loadDefaultConfig(): void {
    // Try multiple possible locations for the default config
    const configPaths = [
      path.join(process.cwd(), 'configs/default.yaml'),  // Local development
      path.join(__dirname, '../configs/default.yaml')    // Relative to dist
    ];

    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          const config = yaml.load(content) as DeployConfig;
          this.defaultConfig = config?.defaults || null;
          console.log(`[AgentManager] Loaded default config from ${configPath}`);
          if (this.defaultConfig?.plugins) {
            console.log(`[AgentManager] Default plugins: ${this.defaultConfig.plugins.map(p => p.name).join(', ')}`);
          }
          return;
        } catch (error) {
          console.warn(`[AgentManager] Failed to load config from ${configPath}:`, error);
        }
      }
    }

    console.warn('[AgentManager] No default config found, agents will have no default plugins');
  }

  /**
   * Get default plugins from config (or empty array if none)
   */
  private getDefaultPlugins(): PluginConfig[] {
    return this.defaultConfig?.plugins || [];
  }

  /**
   * Get default model from config (or fallback)
   */
  private getDefaultModel(): string {
    return this.defaultConfig?.model || 'claude-haiku-4-5-20251001';
  }

  /**
   * Build environment variables for worker agent
   */
  private buildWorkerEnv(teamId: string, teamName: string, agent: AgentRow): Record<string, string> {
    const plugins = agent.metadata?.plugins || [];
    // After registration, agent.name is the ENS domain; the original local
    // alias is stored in metadata.alias.  Use that for ID_AGENT_ALIAS so
    // normalizeAlias() doesn't mangle the ENS domain.
    const agentAlias = (agent.metadata as any)?.alias || agent.name;
    const domain = (agent.metadata as any)?.idchain_domain;
    // After registration, name is the ENS domain; before registration, just the local alias
    const fullName = domain || agentAlias;
    const env: Record<string, string> = {
      ID_AGENT_NAME: fullName,
      ID_AGENT_ALIAS: agentAlias,
      ID_AGENT_TOKEN_ID: agent.token_id || '',
      ID_TEAM: teamName,
      ID_PROJECT: teamName, // deprecated, use ID_TEAM
      ID_SHARED_DIR: `${this.baseWorkDir}/teams/${teamName}`,
      ID_DB_TEAM_ID: teamId,
      ID_DB_AGENT_ID: agent.id,
      ID_HARNESS: agent.metadata?.runtime || 'claude-agent-sdk',
      ID_PLUGINS: JSON.stringify(plugins)
    };

    // Add requireAuth setting from metadata (set during deploy)
    if (agent.metadata?.requireAuth) {
      env.ID_REQUIRE_CLIENT_AUTH = 'true';
    }

    // Add talkTimeout setting from metadata (default timeout for /talk-to requests)
    if (agent.metadata?.talkTimeout) {
      env.ID_TALK_TIMEOUT = String(agent.metadata.talkTimeout);
    }

    return env;
  }

  /**
   * Copy a plugin to an agent's working directory
   * Returns the new local path for the plugin
   */
  private copyPluginToAgent(plugin: PluginConfig, agentWorkDir: string): string {
    const pluginsDir = path.join(agentWorkDir, 'plugins');
    const targetDir = path.join(pluginsDir, plugin.name);

    // Create plugins directory if it doesn't exist
    if (!existsSync(pluginsDir)) {
      mkdirSync(pluginsDir, { recursive: true });
    }

    // Resolve source path (handle both absolute and relative paths)
    let sourcePath = plugin.path;
    if (!path.isAbsolute(sourcePath)) {
      // Try multiple possible locations
      const possiblePaths = [
        path.join('/app', sourcePath),
        path.join(process.cwd(), sourcePath),
        path.join(__dirname, '..', sourcePath)
      ];
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          sourcePath = p;
          break;
        }
      }
    }

    if (!existsSync(sourcePath)) {
      console.warn(`[AgentManager] Plugin source not found: ${plugin.path}`);
      return plugin.path; // Return original path if source not found
    }

    // Copy plugin directory recursively
    this.copyDirRecursive(sourcePath, targetDir);
    console.log(`[AgentManager] Copied plugin ${plugin.name} to ${targetDir}`);

    return targetDir;
  }

  /**
   * Recursively copy a directory
   */
  private copyDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);

      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Copy plugins to agent's working directory and return updated plugin configs with local paths
   */
  private copyPluginsToAgent(plugins: PluginConfig[], agentWorkDir: string): PluginConfig[] {
    return plugins.map(plugin => ({
      name: plugin.name,
      path: this.copyPluginToAgent(plugin, agentWorkDir)
    }));
  }

  private getTeamName(req: express.Request): string {
    // New headers/params (preferred)
    const header = req.headers['x-id-team'];
    const headerName = Array.isArray(header) ? header[0] : header;
    const queryName = typeof req.query.team === 'string' ? req.query.team : undefined;
    // Backwards compatibility: also accept the previous "project" naming.
    const oldProjectHeader = req.headers['x-id-project'];
    const oldProjectHeaderName = Array.isArray(oldProjectHeader) ? oldProjectHeader[0] : oldProjectHeader;
    const oldProjectQueryName = typeof req.query.project === 'string' ? req.query.project : undefined;
    return (
      headerName ||
      queryName ||
      oldProjectHeaderName ||
      oldProjectQueryName ||
      process.env.ID_TEAM ||
      process.env.ID_PROJECT ||
      'default'
    ).toString();
  }

  private async getTeam(req: express.Request): Promise<{ name: string; id: string }> {
    const name = this.getTeamName(req);
    const id = await getOrCreateTeamId(this.db, name);
    // Ensure per-team directory exists (no cross-team shared files).
    const teamDir = `${this.baseWorkDir}/teams/${name}`;
    if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
    return { name, id };
  }

  private key(teamId: string, agentId: string) {
    return `${teamId}:${agentId}`;
  }

  /**
   * Convert an AgentRow to an API response object with identifier fields
   */
  private agentToResponse(a: AgentRow) {
    const isExternal = a.type === 'virtual' || a.type === 'interactive';
    const url = isExternal ? a.endpoint : `http://localhost:${a.port}`;

    // After registration, a.name IS the ENS domain and the original local alias
    // is preserved in metadata.alias.
    const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
    const domain = a.domain || (a.metadata as any)?.idchain_domain;
    const displayId = domain || alias;

    return {
      id: a.id,
      // name is the displayId (e.g., "agent-5.base.xid.eth") for inter-agent communication
      // alias is the base name (e.g., "agent") for backwards compatibility
      name: displayId,
      alias,
      model: a.model,
      port: a.port,
      status: a.status,
      workingDirectory: a.working_directory,
      createdAt: a.created_at,
      type: a.type,
      url,
      metadata: a.metadata,
      // Identity fields
      tokenId: a.token_id,
      domain,
      displayId,
      // Health monitoring
      ...this.getHealthForAgent(a)
    };
  }

  private async dbQueryAgentById(teamId: string, id: string): Promise<AgentRow | null> {
    const r = await this.db.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE team_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [teamId, id]
    );
    return r.rows[0] || null;
  }

  private async dbQueryAgentByNameMostRecent(teamId: string, name: string): Promise<AgentRow | null> {
    // First try exact name match (also check metadata->>'alias' for pre-registration local names)
    const r = await this.db.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE team_id = $1 AND (name = $2 OR metadata->>'alias' = $2) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [teamId, name]
    );
    if (r.rows[0]) return r.rows[0];

    // If not found, try flexible resolution (handles displayId like "agent.20")
    try {
      const matches = await this.dbResolveAgents(teamId, name);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        // Return the most recent if ambiguous
        return matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
      }
    } catch {
      // parseAgentRef may throw on invalid format - fall through to return null
    }
    return null;
  }

  private async dbListAgents(teamId: string, includeAutomator: boolean = false): Promise<AgentRow[]> {
    // By default, hide automator agents from the list (they're the manager's brain, not regular agents)
    const typeFilter = includeAutomator ? '' : `AND type != 'automator'`;
    const r = await this.db.pool.query<AgentRow>(
      `SELECT *
       FROM agents
       WHERE team_id = $1 AND deleted_at IS NULL ${typeFilter}
       ORDER BY created_at DESC`,
      [teamId]
    );
    return r.rows;
  }

  /**
   * Resolve agents matching an identifier pattern
   * Returns all matches for ambiguity detection
   */
  private async dbResolveAgents(teamId: string, ref: string): Promise<AgentRow[]> {
    try {
      const parsed = parseAgentRef(ref);
      console.log(`[Resolve] Parsed "${ref}" -> alias="${parsed.alias}", tokenId="${parsed.tokenId}", domain="${parsed.domain}"`);

      // Build query based on what was provided
      // Build query based on what was provided
      let query: string;
      let params: any[];

      if (parsed.isFullySpecified && parsed.domain) {
        // ENS domain - exact match
        query = `SELECT * FROM agents WHERE team_id = $1 AND (LOWER(name) = $2 OR LOWER(domain) = $2 OR metadata->>'idchain_domain' = $2) AND deleted_at IS NULL`;
        params = [teamId, parsed.domain];
      } else if (parsed.tokenId && parsed.alias) {
        // alias + tokenId - must match both (name OR metadata alias) AND tokenId exactly
        // Do NOT fall back to tokenId-only, as that could return a wrong agent
        query = `SELECT * FROM agents WHERE team_id = $1 AND token_id = $2 AND (LOWER(name) = $3 OR LOWER(metadata->>'alias') = $3) AND deleted_at IS NULL`;
        params = [teamId, parsed.tokenId, parsed.alias];
        console.log(`[Resolve] Query: tokenId=${parsed.tokenId}, alias=${parsed.alias}`);
      } else if (parsed.tokenId) {
        // Just tokenId - match by token
        query = `SELECT * FROM agents WHERE team_id = $1 AND token_id = $2 AND deleted_at IS NULL`;
        params = [teamId, parsed.tokenId];
      } else if (parsed.alias) {
        // Just alias - match by name or original alias (could be ambiguous)
        query = `SELECT * FROM agents WHERE team_id = $1 AND (LOWER(name) = $2 OR LOWER(metadata->>'alias') = $2) AND deleted_at IS NULL ORDER BY created_at DESC`;
        params = [teamId, parsed.alias];
      } else {
        return [];
      }

      const r = await this.db.pool.query<AgentRow>(query, params);
      console.log(`[Resolve] Found ${r.rows.length} matches`);
      return r.rows;
    } catch (e: any) {
      // Log the error for debugging
      console.error(`[Resolve] Error resolving "${ref}":`, e?.message || e);
      return [];
    }
  }

  private async dbNextPort(_teamId?: string): Promise<number> {
    // Global sequential port allocation: find max port across ALL agents in all teams
    const r = await this.db.pool.query<{ max_port: number | null }>(
      `SELECT MAX(port) as max_port FROM agents
       WHERE deleted_at IS NULL AND type = 'claude' AND port > 0`
    );
    const maxPort = r.rows[0]?.max_port ?? null;
    return maxPort ? maxPort + 1 : 4101;
  }

  /**
   * Get the shared deployer address derived from the AGENT_PRIVATE_KEY env var.
   * All agents share a single deployer key for onchain operations.
   * Per-agent keys are provided via .env.<agent_id> files at spawn time, not stored in DB.
   */
  private getDeployerAddress(): string {
    const pk = process.env.AGENT_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!pk) throw new Error('Missing env var AGENT_PRIVATE_KEY (or PRIVATE_KEY)');
    const account = privateKeyToAccount(pk as Hex);
    return account.address;
  }

  private async getDefaultRegistry(teamId: string): Promise<AgentRegistryId> {
    const r = await this.db.pool.query<{ config: any }>('SELECT config FROM teams WHERE id = $1', [teamId]);
    const cfg = (r.rows[0]?.config || {}) as any;
    const chainId = parseInt(String(cfg.default_chain_id || process.env.ID_DEFAULT_CHAIN_ID || '11155111'));
    const registryAddress =
      (cfg.default_registry_address ||
        process.env.AGENT_REGISTRY_ADDRESS ||
        process.env.ID_DEFAULT_REGISTRY_ADDRESS ||
        '0x2b39585cc5004712c938480cd7ff5b97d2bbf433') as string;
    return { chainId, registryAddress };
  }

  private async getRegistrarAddress(teamId: string): Promise<Address> {
    const r = await this.db.pool.query<{ config: any }>('SELECT config FROM teams WHERE id = $1', [teamId]);
    const cfg = (r.rows[0]?.config || {}) as any;
    const registrarAddressEnv = process.env.AGENT_REGISTRAR_ADDRESS || process.env.SEPOLIA_REGISTRAR_ADDRESS || process.env.ID_REGISTRAR_ADDRESS;
    const addr = (cfg.sepolia_registrar_address || registrarAddressEnv) as string | undefined;
    if (!addr) throw new Error('Missing registrar address (set config.sepolia_registrar_address or env AGENT_REGISTRAR_ADDRESS)');
    return addr as Address;
  }

  private async setRegistrarAddress(teamId: string, registrarAddress: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE teams
       SET config = jsonb_set(config, '{sepolia_registrar_address}', to_jsonb($2::text), true)
       WHERE id = $1`,
      [teamId, String(registrarAddress)]
    );
  }

  private async setDefaultRegistry(teamId: string, chainId: number, registryAddress: string): Promise<void> {
    // Merge into config JSON
    await this.db.pool.query(
      `UPDATE teams
       SET config = jsonb_set(jsonb_set(config, '{default_chain_id}', to_jsonb($2::text), true),
                              '{default_registry_address}', to_jsonb($3::text), true)
       WHERE id = $1`,
      [teamId, String(chainId), String(registryAddress)]
    );
  }

  private async registerOnchainAndUpdateAgent(teamId: string, agent: AgentRow): Promise<{ txHash: string; tokenId: string; domain: string }> {
    const pk = process.env.ID_REGISTRAR_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!pk) throw new Error('Missing env var PRIVATE_KEY or ID_REGISTRAR_PRIVATE_KEY');

    const defaultReg = await this.getDefaultRegistry(teamId);
    const chainId = defaultReg.chainId;
    const registryAddress = defaultReg.registryAddress as Address;

    // Map chainId to id-cli chain name
    const chainNames: Record<number, string> = { 8453: 'base', 1: 'eth', 10: 'op', 42161: 'arb', 11155111: 'sepolia' };
    const chain = chainNames[chainId] || 'base';

    // Build text records for registration
    const textRecords: Record<string, string> = {};
    textRecords['description'] = `${agent.name} agent`;

    // Determine the agent's endpoint for the ENSIP-26 records
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    const agentEndpoint = publicBaseUrl
      ? `${publicBaseUrl.replace(/\/+$/, '')}`
      : (agent.type === 'virtual'
          ? (agent.endpoint as string)
          : ((agent.metadata as any)?.service || `http://localhost:${agent.port}`));

    console.log(`[Register] Registering "${agent.name}" on ID Chain (${chain})...`);

    // Register via id-cli
    const result = await registerOnIdChain({
      chain,
      textRecords,
      privateKey: pk,
    });

    // ENSIP-26 agent endpoints can be set later via:
    //   id-cli set-agent-endpoints <domain> --a2a <url> --chain <chain>
    // Skipped by default for private/local systems.

    // Use the label as tokenId for backward compat; domain is the primary identifier
    const tokenId = result.label;

    // Update metadata – preserve the original local alias so the agent
    // can still be found by its pre-registration name after `name` is
    // changed to the full ENS domain.
    let metadata = (agent.metadata || {}) as AgentMetadata;
    const originalAlias = (metadata as any).alias || agent.name;
    metadata = {
      ...metadata,
      idchain_domain: result.domain,
      service_type: 'REST-AP',
      alias: originalAlias,
    };

    // Keep the agent's internal endpoint for manager-to-agent communication
    const isLocalAgent = (metadata as any).local === true;
    const dbEndpoint = isLocalAgent ? (agent.endpoint || `http://localhost:${agent.port}`) : agentEndpoint;

    // Create a subname using the agent's local alias under the registered domain
    // e.g. register gets agent-10.sep.xid.eth, then create x.agent-10.sep.xid.eth
    let newName = result.domain;
    try {
      const sublabel = originalAlias;
      console.log(`[Register] Creating subname ${sublabel}.${result.domain}...`);
      const subResult = await createSubnameOnIdChain({
        sublabel,
        parent: result.label,
        chain,
        privateKey: pk,
      });
      newName = subResult.domain;
      metadata.idchain_domain = newName;
      console.log(`[Register] Subname created: ${newName} (tx: ${subResult.txHash})`);
    } catch (subErr: any) {
      console.warn(`[Register] Subname creation failed: ${subErr.message}. Using base domain: ${result.domain}`);
    }

    // Set multi-chain address records if agent has an OWS wallet
    const owsWalletName = (metadata as any).ows_wallet;
    if (owsWalletName) {
      try {
        const addrResult = await setMultiChainAddresses({
          name: newName,
          walletName: owsWalletName,
          chain,
          privateKey: pk,
        });
        if (addrResult.set.length > 0) {
          console.log(`[Register] Set ${addrResult.set.length} address records: ${addrResult.set.join(', ')}`);
        }
      } catch (addrErr: any) {
        console.warn(`[Register] Multi-chain address setting failed: ${addrErr.message}`);
      }
    }

    await this.db.pool.query(
      `UPDATE agents SET name = $3, token_id = $4, domain = $5, endpoint = $6, metadata = $7 WHERE team_id = $1 AND id = $2`,
      [teamId, agent.id, newName, tokenId, newName, dbEndpoint, metadata]
    );

    // Update running server identity
    const server = this.runningServers.get(this.key(teamId, agent.id));
    if (server) {
      server.setIdentity({ name: newName, metadata, tokenId, domain: newName });
    }

    // Push identity to running agent process
    if (agent.type === 'claude' && agent.port && !server) {
      try {
        const agentUrl = isLocalAgent
          ? (agent.endpoint || `http://localhost:${agent.port}`)
          : `http://id-agent-${agent.id}:4100`;
        const agentApiKey = process.env.ID_AGENT_API_KEY;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (agentApiKey) {
          headers['X-API-Key'] = agentApiKey;
        }
        const identityRes = await fetch(`${agentUrl}/identity`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ tokenId, domain: newName })
        });
        if (identityRes.ok) {
          console.log(`✅ Updated identity for ${originalAlias}: ${newName}`);
        } else {
          console.warn(`⚠️ Failed to update identity for ${originalAlias}: ${identityRes.status}`);
        }
      } catch (err: any) {
        console.warn(`⚠️ Could not update identity for ${originalAlias}: ${err.message}`);
      }
    }

    console.log(`✅ Registered ${originalAlias} as ${newName} (tx: ${result.txHash})`);
    return { txHash: result.txHash, tokenId, domain: newName };
  }

  /**
   * Resolve a target agent by name/id, return its info and endpoint URL.
   * Shared by /talk-to and /message endpoints.
   */
  private async resolveTargetAgent(teamId: string, agent: string): Promise<{
    targetAgent: any;
    targetUrl: string;
    targetDisplayId: string;
  } | { error: string; status: number }> {
    // Handle name lookup - supports ENS domains and local names
    let baseName = agent;
    let tokenId: string | null = null;

    const dotIndex = agent.lastIndexOf('.');
    if (dotIndex !== -1) {
      const afterDot = agent.slice(dotIndex + 1);
      if (/^\d+$/.test(afterDot)) {
        baseName = agent.slice(0, dotIndex);
        tokenId = afterDot;
      }
    }

    // After registration, agent.name becomes the ENS domain and the original
    // local alias is in metadata->>'alias'.  Queries must check both.
    const agentRows = tokenId
      ? await this.db.pool.query<any>(
          `SELECT id, name, type, endpoint, metadata, token_id FROM agents
           WHERE team_id = $1 AND (name = $2 OR metadata->>'alias' = $2) AND token_id = $3
           AND deleted_at IS NULL
           LIMIT 1`,
          [teamId, baseName, tokenId]
        )
      : await this.db.pool.query<any>(
          `SELECT id, name, type, endpoint, metadata, token_id FROM agents
           WHERE team_id = $1 AND (
             name = $2 OR id = $2 OR
             (metadata->>'alias' = $2)
           )
           AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [teamId, agent]
        );

    if (agentRows.rows.length === 0) {
      return { error: `Agent "${agent}" not found`, status: 404 };
    }

    const targetAgent = agentRows.rows[0];

    const isLocalAgent = targetAgent.metadata?.local === true;
    const targetUrl = isLocalAgent
      ? (targetAgent.endpoint || `http://localhost:${targetAgent.port}`)
      : targetAgent.type === 'claude'
        ? `http://id-agent-${targetAgent.id}:4100`
        : (targetAgent.metadata?.internal_url || targetAgent.endpoint);

    if (!targetUrl) {
      return { error: `Agent "${agent}" has no endpoint`, status: 400 };
    }

    // Prefer ENS domain as display ID, fall back to local name
    const targetDomain = targetAgent.metadata?.idchain_domain;
    const targetDisplayId = targetDomain || targetAgent.name;

    return { targetAgent, targetUrl, targetDisplayId };
  }

  /**
   * Forward a message to an agent's /talk endpoint.
   * Returns the parsed response or an error.
   */
  private async forwardToAgent(targetUrl: string, message: string, from: string, session_id?: string): Promise<{
    ok: true;
    data: any;
  } | { ok: false; status: number; error: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const agentApiKey = process.env.ID_AGENT_API_KEY;
    if (agentApiKey) {
      headers['X-API-Key'] = agentApiKey;
    }

    const talkRes = await fetch(`${targetUrl}/talk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, from, session_id }),
      signal: AbortSignal.timeout(30000)
    });

    if (!talkRes.ok) {
      const errorText = await talkRes.text().catch(() => talkRes.statusText);
      return { ok: false, status: talkRes.status, error: errorText };
    }

    const data: any = await talkRes.json();
    return { ok: true, data };
  }

  /**
   * Unified message handler for both /message and /talk-to.
   * Default: fire-and-forget. With wait:true or timeout: waits for reply.
   */
  private async handleMessage(req: express.Request, res: express.Response) {
    try {
      const { id: teamId } = await this.getTeam(req);
      const { agent: agentField, to: toField, message, from, session_id, wait, timeout: requestTimeout } = req.body || {};
      const agent = toField || agentField;

      if (!agent || !message) {
        return res.status(400).json({ error: 'Missing "to" (agent name) or "message"' });
      }

      // Determine if we should wait for a reply
      const shouldWait = wait === true || requestTimeout !== undefined;

      // Parse timeout (only relevant when waiting)
      const DEFAULT_TIMEOUT = 24 * 60 * 60 * 1000;
      const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
      const timeout = shouldWait
        ? Math.min(Math.max(parseInt(requestTimeout) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT)
        : 0;

      // Resolve the target agent
      const resolved = await this.resolveTargetAgent(teamId, agent);
      if ('error' in resolved) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { targetAgent, targetUrl, targetDisplayId } = resolved;
      this.managerLog(`${shouldWait ? 'Forwarding' : 'Sending async'} message to ${targetDisplayId} at ${targetUrl}`);

      // Forward the message to the agent's /talk endpoint
      const result = await this.forwardToAgent(targetUrl, message, from || 'manager', session_id);
      if (!result.ok) {
        console.error(`[Manager] Failed to deliver message to ${targetDisplayId}: ${result.status}`);
        return res.status(result.status).json({ error: result.error });
      }

      const queryId = result.data.query_id;

      // Store the query so replies can be routed correctly
      if (queryId) {
        await this.db.pool.query(
          `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created)
           VALUES ($1, $2, $3, $4, 'pending', $5)
           ON CONFLICT (team_id, agent_id, query_id) DO NOTHING`,
          [teamId, queryId, targetAgent.id, message, Date.now()]
        );
      }

      // Fire-and-forget: return immediately
      if (!shouldWait) {
        this.managerLog(`Message delivered to ${targetDisplayId}, query_id: ${queryId} (fire-and-forget)`);
        return res.json({
          success: true,
          query_id: queryId,
          delivered_to: targetDisplayId,
          status: 'delivered'
        });
      }

      // Wait mode: block until reply arrives or timeout
      this.managerLog(`Waiting up to ${timeout}ms for reply from ${targetDisplayId}, query_id: ${queryId}`);

      if (!queryId) {
        return res.json(result.data);
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      let httpTimedOut = false;

      const replyPromise = new Promise<{ from: string; message: string }>((resolve) => {
        this.queryWaiters.set(queryId, {
          resolve,
          reject: () => {},
          timeout: null as any
        });

        if (timeout < 24 * 60 * 60 * 1000) {
          timeoutHandle = setTimeout(() => {
            httpTimedOut = true;
            resolve({ from: '', message: '' });
          }, timeout);
        }
      });

      const replyResult = await replyPromise;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (httpTimedOut) {
        this.managerLog(`HTTP timeout waiting for ${targetDisplayId} (${timeout}ms) - waiter persists`);
        return res.json({
          success: false,
          from: targetDisplayId,
          query_id: queryId,
          message: `Request timed out after ${timeout}ms - reply will be delivered when it arrives`,
          status: 'pending'
        });
      }

      this.managerLog(`Received reply from ${targetDisplayId} for query ${queryId}`);
      return res.json({
        success: true,
        from: replyResult.from || targetDisplayId,
        reply: replyResult.message,
        query_id: queryId
      });
    } catch (err: any) {
      console.error('[Manager] Error in POST /message:', err);
      res.status(500).json({ error: err?.message || 'Internal server error' });
    }
  }

  private setupRoutes() {
    this.managementApp.get('/health', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const count = await this.db.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text as c FROM agents WHERE team_id = $1 AND deleted_at IS NULL`,
        [teamId]
      );
      res.json({ status: 'ok', team: teamName, agents: parseInt(count.rows[0]?.c || '0'), timestamp: Date.now() });
    });

    // GET /agents/status - check health of all agents (server-side ping)
    this.managementApp.get('/agents/status', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);

      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
          const isInteractive = agent.type === 'interactive';
          let isResponding = false;
          let newsItems: any[] = [];

          if (isInteractive) {
            isResponding = true;
          } else {
            try {
              const catalogResp = await fetch(`${agentUrl}/.well-known/restap.json`, {
                signal: AbortSignal.timeout(3000)
              });
              isResponding = catalogResp.ok;
            } catch { /* not responding */ }
          }

          if (isResponding && !isInteractive) {
            try {
              const newsResp = await fetch(`${agentUrl}/news?since=0&limit=50`, {
                signal: AbortSignal.timeout(2000),
                headers: {
                  ...(process.env.ID_AGENT_API_KEY && { 'X-API-Key': process.env.ID_AGENT_API_KEY })
                }
              });
              if (newsResp.ok) {
                const newsData: any = await newsResp.json();
                newsItems = newsData.items || [];
              }
            } catch { /* news fetch failed */ }
          }

          return {
            ...this.agentToResponse(agent),
            isResponding,
            newsItems
          };
        })
      );

      const agentStatuses = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { ...this.agentToResponse(agents[i]), isResponding: false, newsItems: [] };
      });

      res.json({ agents: agentStatuses });
    });

    // GET /agents/:name/news - proxy news feed from a specific agent (for remote CLI)
    this.managementApp.get('/agents/:name/news', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agentName = req.params.name;
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);

        if (!agent) {
          return res.status(404).json({ error: `Agent "${agentName}" not found` });
        }

        const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
        const since = req.query.since || '0';
        const limit = req.query.limit || '50';

        const newsResp = await fetch(`${agentUrl}/news?since=${since}&limit=${limit}`, {
          signal: AbortSignal.timeout(5000),
          headers: {
            ...(process.env.ID_AGENT_API_KEY && { 'X-API-Key': process.env.ID_AGENT_API_KEY })
          }
        });

        if (!newsResp.ok) {
          return res.status(newsResp.status).json({ error: `Agent news fetch failed: ${newsResp.statusText}` });
        }

        const newsData = await newsResp.json();
        res.json(newsData);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to fetch agent news' });
      }
    });

    // POST /agents/:name/cancel - proxy cancel request to a specific agent (for remote CLI)
    this.managementApp.post('/agents/:name/cancel', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agentName = req.params.name;
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);

        if (!agent) {
          return res.status(404).json({ error: `Agent "${agentName}" not found` });
        }

        const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
        const cancelResp = await fetch(`${agentUrl}/cancel`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' }
        });

        if (!cancelResp.ok) {
          const errData = await cancelResp.json().catch(() => ({ error: cancelResp.statusText }));
          return res.status(cancelResp.status).json(errData);
        }

        const result = await cancelResp.json();
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to cancel agent query' });
      }
    });

    // GET /logs - retrieve recent manager activity logs
    this.managementApp.get('/logs', async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, this.LOG_BUFFER_SIZE);
      const logs = this.logBuffer.slice(-limit);
      res.json({ logs, total: this.logBuffer.length });
    });

    // REST-AP /talk endpoint - receive queries for the manager (interactive agent)
    this.managementApp.post('/talk', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, session_id, from } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        const managerId = `manager-${teamName}`;
        const senderName = from || 'external';

        // Store the query in the queries table
        await this.db.pool.query(
          `INSERT INTO queries (team_id, query_id, agent_id, created, prompt, status, session_id)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
          [teamId, queryId, managerId, ts, `[From: ${senderName}] ${message}`, session_id || null]
        );

        // Also store as a news item so the CLI can see incoming queries
        await this.db.pool.query(
          `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [teamId, managerId, ts, 'query.received', `Query from ${senderName}: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
           { from: senderName, message, session_id, query_id: queryId }, queryId]
        );

        this.managerLog(`Received query ${queryId} from ${senderName}: ${message.slice(0, 50)}...`);

        res.status(202).json({
          query_id: queryId,
          status: 'pending',
          message: 'Query received. Poll /news?query_id=' + queryId + ' for response.'
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /talk:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /message - unified endpoint for sending messages to agents
    // Default: fire-and-forget (returns immediately after delivery)
    // With wait:true or timeout: waits for the agent's reply (like old /talk-to)
    this.managementApp.post('/message', (req, res, next) => {
      this.handleMessage(req, res).catch(next);
    });

    // /talk-to - backwards-compatible alias for /message with wait:true
    this.managementApp.post('/talk-to', (req, res, next) => {
      // Inject wait:true if not explicitly set
      if (req.body && req.body.wait === undefined && req.body.timeout === undefined) {
        req.body.wait = true;
      }
      this.handleMessage(req, res).catch(next);
    });

    // REST-AP /news endpoint - receive replies from agents
    this.managementApp.post('/news', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const { type, from, message, in_reply_to, data } = req.body || {};

        if (!message && !data) {
          return res.status(400).json({ error: 'Missing message or data' });
        }

        // If this is a reply to a query, look up the original query's team
        // This ensures replies go to the correct team even if sender doesn't specify
        if (in_reply_to) {
          const queryResult = await this.db.pool.query<{ team_id: string }>(
            `SELECT team_id FROM queries WHERE query_id = $1 LIMIT 1`,
            [in_reply_to]
          );
          if (queryResult.rows.length > 0) {
            teamId = queryResult.rows[0].team_id;
            this.managerLog(`Reply to ${in_reply_to} - using query's team ${teamId}`);
          }
        }

        const newsType = type || (in_reply_to ? 'reply' : 'message');
        const newsMessage = message || data?.message || `${newsType} from ${from || 'unknown'}`;
        const ts = Date.now();

        // Store in news_items table for the CLI (interactive agent)
        // Look up the actual interactive agent for this team
        const cliAgent = await this.db.pool.query<any>(
          `SELECT id FROM agents WHERE team_id = $1 AND type = 'interactive' AND deleted_at IS NULL LIMIT 1`,
          [teamId]
        );

        if (cliAgent.rows.length > 0) {
          const cliId = cliAgent.rows[0].id;
          await this.db.pool.query(
            `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [teamId, cliId, ts, newsType, newsMessage, { from, in_reply_to, message, ...data }, in_reply_to || null]
          );
        } else {
          this.managerLog(`Warning: No interactive agent found for team ${teamId}, cannot store news`);
        }

        // If this is a reply to a query, update the query status and resolve any waiting /talk-to
        if (in_reply_to) {
          await this.db.pool.query(
            `UPDATE queries SET status = 'completed', completed = $3, result = $4
             WHERE team_id = $1 AND query_id = $2 AND status = 'pending'`,
            [teamId, in_reply_to, ts, { from, message, ...data }]
          );

          // Resolve any waiting /talk-to request (waiter may still exist even if HTTP timed out)
          const waiter = this.queryWaiters.get(in_reply_to);
          if (waiter) {
            if (waiter.timeout) clearTimeout(waiter.timeout);
            this.queryWaiters.delete(in_reply_to);
            waiter.resolve({ from: from || 'unknown', message: message || '' });
            this.managerLog(`Resolved waiter for query ${in_reply_to}`);
          }

        }

        this.managerLog(`Received ${newsType}${from ? ` from ${from}` : ''}${in_reply_to ? ` (reply to ${in_reply_to})` : ''}`);

        // Broadcast to WebSocket clients (real-time delivery)
        this.broadcastNews(teamId, {
          type: newsType,
          from,
          message,
          in_reply_to,
          data: { ...data, sessionId: data?.sessionId },
          timestamp: ts
        });

        // Try to forward to CLI if it can receive direct messages
        // Look up the CLI (interactive agent) to check if it's reachable
        const recipientRows = await this.db.pool.query<any>(
          `SELECT endpoint, metadata FROM agents
           WHERE team_id = $1 AND type = 'interactive' AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [teamId]
        );

        if (recipientRows.rows.length > 0) {
          const recipient = recipientRows.rows[0];
          const canReceive = recipient.metadata?.canReceiveDirectMessages === true;

          if (canReceive && recipient.endpoint) {
            // Forward message to CLI's /news endpoint
            try {
              const forwardRes = await fetch(`${recipient.endpoint}/news`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: newsType,
                  from,
                  message,
                  in_reply_to,
                  session_id: data?.sessionId,
                  ...data
                }),
                signal: AbortSignal.timeout(5000)
              });
              if (forwardRes.ok) {
                this.managerLog(`Forwarded ${newsType} to CLI at ${recipient.endpoint}`);
              } else {
                this.managerLog(`Failed to forward to CLI: ${forwardRes.status}`);
              }
            } catch (fwdErr: any) {
              this.managerLog(`Could not forward to CLI: ${fwdErr.message}`);
            }
          }
        }

        res.status(201).json({
          success: true,
          type: newsType,
          timestamp: ts
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /news:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // REST-AP /news endpoint - poll for updates
    this.managementApp.get('/news', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const since = parseInt(req.query.since as string) || 0;
        const limit = parseInt(req.query.limit as string) || 100;
        const query_id = req.query.query_id as string | undefined;

        // Look up the actual interactive agent (CLI) for this team
        const cliAgent = await this.db.pool.query<any>(
          `SELECT id FROM agents WHERE team_id = $1 AND type = 'interactive' AND deleted_at IS NULL LIMIT 1`,
          [teamId]
        );

        if (cliAgent.rows.length === 0) {
          return res.json({ items: [] });
        }

        const cliId = cliAgent.rows[0].id;

        let whereClause = `team_id = $1 AND agent_id = $2 AND timestamp > $3`;
        const params: any[] = [teamId, cliId, since];

        if (query_id) {
          params.push(query_id);
          whereClause += ` AND query_id = $${params.length}`;
        }

        const rows = await this.db.pool.query<any>(
          `SELECT type, timestamp, message, data
           FROM news_items
           WHERE ${whereClause}
           ORDER BY timestamp DESC
           LIMIT $${params.length + 1}`,
          [...params, limit]
        );

        const items = rows.rows.map((r: any) => ({
          type: r.type,
          timestamp: Number(r.timestamp),
          message: r.message || undefined,
          data: r.data || undefined
        }));

        res.json({
          items,
          timestamp: Date.now(),
          total: items.length
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /news:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Archive old news items to files and delete from database
    this.managementApp.post('/news/archive', async (req, res) => {
      try {
        const { name: teamName, id: teamId } = await this.getTeam(req);
        const days = parseInt(req.body?.days) || 30;
        const cutoffTimestamp = Date.now() - (days * 24 * 60 * 60 * 1000);

        // Get all news items older than cutoff
        const result = await this.db.pool.query<any>(
          `SELECT type, timestamp, message, data, agent_id, query_id
           FROM news_items
           WHERE team_id = $1 AND timestamp < $2
           ORDER BY timestamp ASC`,
          [teamId, cutoffTimestamp]
        );

        const items = result.rows;
        if (items.length === 0) {
          return res.json({ archived: 0, message: 'No items to archive' });
        }

        // Create archives directory
        const archiveDir = `${this.baseWorkDir}/teams/${teamName}/archives`;
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

        // Write to file with timestamp
        const filename = `news-archive-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`;
        const filepath = `${archiveDir}/${filename}`;
        const archiveData = {
          archivedAt: new Date().toISOString(),
          teamName,
          cutoffDays: days,
          cutoffTimestamp,
          itemCount: items.length,
          items: items.map((r: any) => ({
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
            agentId: r.agent_id || undefined,
            queryId: r.query_id || undefined
          }))
        };
        writeFileSync(filepath, JSON.stringify(archiveData, null, 2));

        // Delete archived items from database
        await this.db.pool.query(
          `DELETE FROM news_items WHERE team_id = $1 AND timestamp < $2`,
          [teamId, cutoffTimestamp]
        );

        console.log(`[Manager] Archived ${items.length} news items to ${filepath}`);
        res.json({
          archived: items.length,
          file: filepath,
          cutoffDays: days,
          cutoffDate: new Date(cutoffTimestamp).toISOString()
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /news/archive:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/registry/default', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      res.json({ registry: await this.getDefaultRegistry(teamId) });
    });

    this.managementApp.post('/registry/default', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const { chainId, registryAddress } = req.body || {};
      const parsedChainId = parseInt(String(chainId));
      if (!parsedChainId || !registryAddress) {
        return res.status(400).json({ error: 'Missing chainId or registryAddress' });
      }
      await this.setDefaultRegistry(teamId, parsedChainId, registryAddress);
      res.json({ registry: await this.getDefaultRegistry(teamId) });
    });

    this.managementApp.get('/registry/registrar', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      try {
        const registrarAddress = await this.getRegistrarAddress(teamId);
        res.json({ registrarAddress });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/registry/registrar', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const { registrarAddress } = req.body || {};
      if (!registrarAddress) return res.status(400).json({ error: 'Missing registrarAddress' });
      await this.setRegistrarAddress(teamId, String(registrarAddress));
      res.json({ registrarAddress: String(registrarAddress) });
    });

    this.managementApp.get('/agents', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      // ?all=true includes automator agents (normally hidden)
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);
      res.json({
        agents: agents.map(a => this.agentToResponse(a))
      });
    });

    // Resolve agent by identifier pattern (alias, ENS domain, tokenId@registry, etc.)
    // Returns warning if multiple agents match
    // NOTE: Must be defined BEFORE /agents/:id to avoid "resolve" matching as an id
    this.managementApp.get('/agents/resolve/:ref', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const ref = decodeURIComponent(req.params.ref);

      try {
        const matches = await this.dbResolveAgents(teamId, ref);

        if (matches.length === 0) {
          return res.status(404).json({ error: `No agent matches "${ref}"` });
        }

        if (matches.length === 1) {
          return res.json({
            agent: this.agentToResponse(matches[0]),
            ambiguous: false
          });
        }

        // Multiple matches - build ambiguity warning
        const agentMatches: AgentMatch[] = matches.map(a => ({
          id: a.id,
          alias: normalizeAlias(a.name),
          tokenId: a.token_id || undefined,
          domain: a.domain || undefined,
          port: a.port,
          status: a.status
        }));

        const warning = buildAmbiguityWarning(ref, agentMatches);

        return res.json({
          agents: matches.map(a => this.agentToResponse(a)),
          ambiguous: true,
          warning
        });
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'Invalid identifier format' });
      }
    });

    // Get agent by name (most recent)
    // NOTE: Must be defined BEFORE /agents/:id to avoid "by-name" matching as an id
    this.managementApp.get('/agents/by-name/:name', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(this.agentToResponse(agent));
    });

    this.managementApp.get('/agents/:id', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(this.agentToResponse(agent));
    });

    // List all teams from database
    this.managementApp.get('/teams', async (req, res) => {
      const teams = await this.db.pool.query(
        `SELECT id, name, created_at FROM teams ORDER BY created_at DESC`
      );

      const teamList = await Promise.all(
        teams.rows.map(async (team: any) => {
          const agentCount = await this.db.pool.query<{ count: string }>(
            'SELECT COUNT(*)::text as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
            [team.id]
          );
          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount.rows[0]?.count || '0'),
            createdAt: team.created_at
          };
        })
      );

      res.json({ teams: teamList });
    });

    // Create a new team
    this.managementApp.post('/teams', async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing team name' });
      try {
        const teamId = await getOrCreateTeamId(this.db, name);

        // Create team directory
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) {
          mkdirSync(teamDir, { recursive: true });
        }

        const team = await this.db.pool.query(
          'SELECT id, name, created_at FROM teams WHERE id = $1',
          [teamId]
        );
        if (team.rows.length === 0) {
          return res.status(500).json({ error: 'Failed to create team' });
        }
        const row = team.rows[0];
        res.json({
          id: row.id,
          name: row.name,
          createdAt: row.created_at
        });
      } catch (error: any) {
        console.error('Error creating team:', error);
        res.status(500).json({ error: error.message || 'Failed to create team' });
      }
    });

    // Update team settings (port ranges removed — ports are now globally sequential)
    this.managementApp.patch('/teams/:name', async (req, res) => {
      const { name } = req.params;

      try {
        const team = await this.db.pool.query(
          'SELECT id, name FROM teams WHERE name = $1',
          [name]
        );
        if (!team.rows.length) {
          return res.status(404).json({ error: `Team "${name}" not found` });
        }

        res.json({ name: team.rows[0].name, message: 'Port ranges are no longer used. Ports are allocated globally.' });
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Failed to update team' });
      }
    });

    // Delete a team
    this.managementApp.delete('/teams/:name', async (req, res) => {
      const { name } = req.params;
      if (!name) {
        return res.status(400).json({ error: 'Missing team name' });
      }

      try {
        // Find the team
        const team = await this.db.pool.query(
          'SELECT id, name FROM teams WHERE name = $1',
          [name]
        );

        if (team.rows.length === 0) {
          return res.status(404).json({ error: `Team "${name}" not found` });
        }

        const teamId = team.rows[0].id;

        // Check if team has ANY agents (including soft-deleted)
        const agents = await this.db.pool.query(
          'SELECT COUNT(*)::text as count FROM agents WHERE team_id = $1',
          [teamId]
        );
        const agentCount = parseInt(agents.rows[0]?.count || '0');

        if (agentCount > 0) {
          return res.status(400).json({
            error: `Team "${name}" has ${agentCount} agent(s) (including archived). Delete all agents first.`
          });
        }

        // Delete the team
        await this.db.pool.query('DELETE FROM teams WHERE id = $1', [teamId]);

        // Optionally remove the team directory (but keep files as backup)
        // const teamDir = `${this.baseWorkDir}/teams/${name}`;
        // We don't delete the folder to preserve any files

        res.json({ success: true, message: `Team "${name}" deleted` });
      } catch (error: any) {
        console.error('Error deleting team:', error);
        res.status(500).json({ error: error.message || 'Failed to delete team' });
      }
    });

    // Backwards compatibility: /projects endpoints
    this.managementApp.get('/projects', async (req, res) => {
      const teams = await this.db.pool.query(
        `SELECT id, name, config, created_at FROM teams ORDER BY created_at DESC`
      );

      const projectList = await Promise.all(
        teams.rows.map(async (team: any) => {
          // Count agents in this team
          const agentCount = await this.db.pool.query<{ count: string }>(
            'SELECT COUNT(*)::text as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
            [team.id]
          );

          // Get registry info from config
          const config = team.config || {};
          const registryInfo = {
            chainId: config.default_chain_id,
            registryAddress: config.default_registry_address,
            registrarAddress: config.sepolia_registrar_address
          };

          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount.rows[0]?.count || '0'),
            registry: registryInfo,
            createdAt: team.created_at
          };
        })
      );

      res.json({ projects: projectList });
    });

    // Backwards compatibility: create project
    this.managementApp.post('/projects', async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing project name' });

      try {
        // Create team in database (will auto-assign port range)
        const teamId = await getOrCreateTeamId(this.db, name);

        // Get the created team details
        const team = await this.db.pool.query(
          'SELECT id, name, created_at FROM teams WHERE id = $1',
          [teamId]
        );

        if (team.rows.length === 0) {
          return res.status(500).json({ error: 'Failed to create project' });
        }

        const row = team.rows[0];
        res.json({
          id: row.id,
          name: row.name,
          createdAt: row.created_at
        });
      } catch (error: any) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: error.message || 'Failed to create project' });
      }
    });

    this.managementApp.post('/agents/spawn', async (req, res) => {
      let teamId = '';
      let teamName = '';
      let id = '';
      try {
        const team = await this.getTeam(req);
        teamId = team.id;
        teamName = team.name;

        const { name, type: agentType, model, runtime, allowedTools, pluginPath, plugins, skills, apiKey, requireAuth, metadata: reqMetadata, local, claudeMd, heartbeat, workingDirectory: configWorkDir, verbose, domain, tokenId, address } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Missing name' });

        // Local agent: runs locally, uses user's Claude Code auth
        const isLocalAgent = local === true || local === 'true';
        if (local !== undefined) {
          console.log(`[AgentManager] Spawn request: name=${name}, local=${local} (type: ${typeof local}), isLocalAgent=${isLocalAgent}`);
        }

        // Note: Duplicate names are allowed - agents are uniquely identified by their token ID (e.g., agent.42)

        // Runtime defaults to 'claude-agent-sdk'
        const effectiveRuntime = runtime || 'claude-agent-sdk';

        id = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        // Use config-specified working directory if provided, otherwise use workspace
        const workingDirectory = configWorkDir || `${this.baseWorkDir}/agents/${id}`;

        // Get default plugins from config
        const defaultPlugins = this.getDefaultPlugins();

        // Merge user plugins with defaults (user plugins take precedence for same name)
        const userPlugins = plugins || [];
        const userPluginNames = new Set(userPlugins.map((p: any) => p.name));
        const mergedPlugins = [
          ...userPlugins,
          ...defaultPlugins.filter(p => !userPluginNames.has(p.name))
        ];

        // Use default model from config if not specified
        const effectiveModel = model || this.getDefaultModel();

        // Create workspace directory first (needed for plugin copy)
        mkdirSync(workingDirectory, { recursive: true });

        // Write CLAUDE.md if specified
        if (claudeMd && typeof claudeMd === 'string') {
          const claudeDir = path.join(workingDirectory, '.claude');
          if (!existsSync(claudeDir)) {
            mkdirSync(claudeDir, { recursive: true });
          }
          const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
          writeFileSync(claudeMdPath, claudeMd);
        }

        // Write HEARTBEAT.yaml if specified
        if (heartbeat && typeof heartbeat === 'object' && heartbeat.interval && heartbeat.message) {
          const heartbeatPath = path.join(workingDirectory, 'HEARTBEAT.yaml');
          const heartbeatContent = `# Heartbeat config for ${name}\n# Edit this file to customize heartbeat behavior\n\ninterval: ${heartbeat.interval}  # seconds\n\nmessage: |\n${heartbeat.message.split('\n').map((line: string) => '  ' + line).join('\n')}\n`;
          writeFileSync(heartbeatPath, heartbeatContent);
          console.log(`[Spawn] Wrote heartbeat config to ${heartbeatPath}`);
        }

        // Copy plugins to agent's working directory (agent owns its plugins)
        const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

        // Determine effective agent type (default to 'claude')
        const effectiveAgentType = agentType || 'claude';
        const isAutomator = effectiveAgentType === 'automator';

        const metadata: AgentMetadata = {
          name,
          // Automators don't have REST-AP endpoints
          ...(isAutomator ? {} : { service_type: 'REST-AP', endpoint: '' }),
          runtime: effectiveRuntime,  // Store runtime for display/querying
          // Store config in metadata for later reference
          ...(reqMetadata?.description && { description: reqMetadata.description }),
          plugins: localPlugins, // Use local paths (agent owns its plugins)
          ...(allowedTools && { allowed_tools: allowedTools }),
          ...(requireAuth !== undefined && { requireAuth }),
          ...(isAutomator && { isAutomator: true }),
          // Flag that heartbeat is enabled (actual config read from HEARTBEAT.yaml)
          ...(heartbeat && { heartbeat: true })
        };

        await this.db.pool.query(
          `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, api_key, token_id, domain)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [teamId, id, name, effectiveAgentType, effectiveModel, 0, null, workingDirectory, 'starting', Date.now(), metadata, apiKey || null, tokenId || null, domain || null]
        );

        // Derive agent_account from request address, or fall back to shared deployer key
        const deployerAddress = this.getDeployerAddress();
        const updatedMeta = { ...metadata, agent_account: address || deployerAddress };
        await this.db.pool.query(`UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`, [teamId, id, updatedMeta]);

        // All agents run locally
        const allocatedPort = await this.dbNextPort(teamId);
        const url = `http://localhost:${allocatedPort}`;
        const finalMeta: AgentMetadata = {
          ...updatedMeta,
          service_type: 'REST-AP',
          endpoint: url,
          local: true,
          runtime: effectiveRuntime
        };
        await this.db.pool.query(
          `UPDATE agents SET status = 'pending', port = $3, endpoint = $4, metadata = $5 WHERE team_id = $1 AND id = $2`,
          [teamId, id, allocatedPort, url, finalMeta]
        );

        // Use host paths for local agents
        // If configWorkDir is an absolute path, use it directly (project repo)
        const hostWorkspaceDir = process.env.ID_WORKSPACE_DIR || this.baseWorkDir;
        const hostWorkingDirectory = configWorkDir && path.isAbsolute(configWorkDir) ? configWorkDir : `${hostWorkspaceDir}/agents/${id}`;
        const hostSharedDirectory = `${hostWorkspaceDir}/teams/${teamName}`;

        // Start heartbeat timer if enabled
        if (heartbeat && heartbeat.interval) {
          this.startHeartbeatForAgent(teamId, id, name, workingDirectory, heartbeat.interval);
        }

        res.status(201).json({
          id,
          name,
          model: effectiveModel,
          runtime: effectiveRuntime,
          port: allocatedPort,
          status: 'pending',  // Will become 'running' when local process starts
          type: 'claude',
          local: true,
          url,
          restap: `${url}/.well-known/restap.json`,
          metadata: finalMeta,
          // Info for CLI to spawn local agent process
          teamId,
          teamName,
          workingDirectory: hostWorkingDirectory,
          sharedDirectory: hostSharedDirectory
        });
      } catch (error: any) {
        // Ensure we never return Express's default HTML error page (CLI expects JSON).
        try {
          if (teamId && id) {
            await this.db.pool.query(
              `UPDATE agents SET status = 'error' WHERE team_id = $1 AND id = $2`,
              [teamId, id]
            );
          }
        } catch {
          // ignore
        }

        res.status(500).json({ error: error?.message || String(error) });
      }
    });

    this.managementApp.post('/agents/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const { id: requestedIdRaw, name, endpoint, metadata, type: requestedTypeRaw } = req.body || {};
      if (!name || !endpoint) return res.status(400).json({ error: 'Missing name or endpoint' });

      const requestedId = typeof requestedIdRaw === 'string' ? requestedIdRaw.trim() : undefined;
      if (requestedId && !/^[a-zA-Z0-9_:-]{1,200}$/.test(requestedId)) {
        return res.status(400).json({ error: 'Invalid id format' });
      }

      const requestedType =
        typeof requestedTypeRaw === 'string' ? requestedTypeRaw.trim().toLowerCase() : undefined;
      // Allow 'claude' type for local agents, 'interactive' for CLI users, 'virtual' for external
      const type = requestedType === 'interactive' ? 'interactive'
        : requestedType === 'claude' ? 'claude'
        : 'virtual';

      // Generate stable ID based on agent type
      const idPrefix = type === 'claude' ? 'local_' : 'virtual_';
      const stableId =
        idPrefix +
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 60);

      const id = requestedId || stableId;

      // Backwards-compat: if client didn't provide an id, keep the old "dedupe by name" behavior.
      // If client provides an id, treat id as canonical and do not delete other agents that happen to share the same name.
      if (!requestedId) {
        await this.db.pool.query(
          `UPDATE agents SET deleted_at = $3
           WHERE team_id = $1 AND name = $2 AND type IN ('virtual','interactive') AND id <> $4 AND deleted_at IS NULL`,
          [teamId, name, Date.now(), id]
        );
      }

      const meta: AgentMetadata = {
        name,
        service_type: (metadata && metadata.service_type) || 'REST-AP',
        endpoint,
        ...(metadata || {})
      };

      // Extract domain from request body if provided
      const reqDomain = (req.body as any).domain || null;

      await this.db.pool.query(
        `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, domain)
         VALUES ($1,$2,$3,$7,'external',0,$4,'','running',$5,$6,$8)
         ON CONFLICT (team_id, id)
         DO UPDATE SET name = EXCLUDED.name,
                       type = EXCLUDED.type,
                       endpoint = EXCLUDED.endpoint,
                       status = EXCLUDED.status,
                       metadata = EXCLUDED.metadata,
                       created_at = EXCLUDED.created_at,
                       domain = COALESCE(EXCLUDED.domain, agents.domain),
                       deleted_at = NULL`,
        [teamId, id, name, endpoint, Date.now(), meta, type, reqDomain]
      );

      // Set agent_account from shared deployer key for display/identity purposes
      let nextMeta = meta;
      if (!nextMeta.agent_account) {
        const deployerAddress = this.getDeployerAddress();
        nextMeta = { ...nextMeta, agent_account: deployerAddress };
        await this.db.pool.query(`UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`, [teamId, id, nextMeta]);
      }

      res.status(201).json({
        id,
        name,
        type,
        status: 'running',
        url: endpoint,
        restap: `${endpoint}/.well-known/restap.json`,
        domain: reqDomain,
        metadata: nextMeta
      });
    });

    this.managementApp.post('/agents/:id/metadata', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const { metadata } = req.body || {};
      const nextMetadata = metadata ? { ...(agent.metadata || {}), ...(metadata || {}) } : agent.metadata;

      await this.db.pool.query(`UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`, [
        teamId,
        agent.id,
        nextMetadata
      ]);

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined
        });
      }

      res.json({ id: agent.id, name: agent.name, metadata: nextMetadata });
    });

    this.managementApp.post('/agents/by-name/:name/metadata', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const { metadata } = req.body || {};
      const nextMetadata = metadata ? { ...(agent.metadata || {}), ...(metadata || {}) } : agent.metadata;

      await this.db.pool.query(`UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`, [
        teamId,
        agent.id,
        nextMetadata
      ]);

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined
        });
      }

      res.json({ id: agent.id, name: agent.name, metadata: nextMetadata });
    });

    // Note: Agent catalogs are managed by agents themselves via their /catalog endpoint
    // This follows REST-AP where each agent owns its own /.well-known/restap.json
    // To view an agent's catalog, fetch their restap.json: GET {agent.url}/.well-known/restap.json

    this.managementApp.post('/agents/:id/onchain/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      try {
        const result = await this.registerOnchainAndUpdateAgent(teamId, agent);

        // Update CLAUDE.md with agent's full identity
        if (result.tokenId && agent.working_directory) {
          try {
            const claudeDir = path.join(agent.working_directory, '.claude');
            if (!existsSync(claudeDir)) {
              mkdirSync(claudeDir, { recursive: true });
            }
            this.updateClaudeMdIdentity(path.join(claudeDir, 'CLAUDE.md'), result.domain || result.tokenId || agent.name);
            console.log(`[Register] Updated CLAUDE.md with identity: ${result.domain || result.tokenId || agent.name}`);
          } catch (identityErr: any) {
            console.warn(`[Register] Failed to update CLAUDE.md: ${identityErr.message}`);
          }
        }

        const fresh = await this.dbQueryAgentById(teamId, agent.id);
        res.json({ ok: true, ...result, agent: { id: agent.id, name: agent.name, domain: fresh?.domain, tokenId: fresh?.token_id } });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/agents/by-name/:name/onchain/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      try {
        const result = await this.registerOnchainAndUpdateAgent(teamId, agent);

        // Update CLAUDE.md with agent's full identity
        if (result.tokenId && agent.working_directory) {
          try {
            const claudeDir = path.join(agent.working_directory, '.claude');
            if (!existsSync(claudeDir)) {
              mkdirSync(claudeDir, { recursive: true });
            }
            this.updateClaudeMdIdentity(path.join(claudeDir, 'CLAUDE.md'), result.domain || result.tokenId || agent.name);
            console.log(`[Register] Updated CLAUDE.md with identity: ${result.domain || result.tokenId || agent.name}`);
          } catch (identityErr: any) {
            console.warn(`[Register] Failed to update CLAUDE.md: ${identityErr.message}`);
          }
        }

        const fresh = await this.dbQueryAgentById(teamId, agent.id);
        res.json({ ok: true, ...result, agent: { id: agent.id, name: agent.name, domain: fresh?.domain, tokenId: fresh?.token_id } });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/agents/:id/model', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const { model } = req.body;

      if (!model) {
        return res.status(400).json({ error: 'Missing model in request body' });
      }

      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      if (agent.type !== 'claude') {
        return res.status(400).json({ error: 'Only Claude agents have models' });
      }

      try {
        // Update model in database - agent needs restart to pick up new model
        await this.db.pool.query(
          'UPDATE agents SET model = $1, status = $2 WHERE team_id = $3 AND id = $4',
          [model, 'pending', teamId, agent.id]
        );

        console.log(`[Manager] Updated model for ${agent.name} to ${model} - restart required`);

        res.json({
          id: agent.id,
          name: agent.name,
          model: model,
          status: 'pending',
          message: 'Model updated. Restart the agent to apply the new model.'
        });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // PATCH /agents/:id/metadata — update agent properties (wallet, name, etc.)
    this.managementApp.patch('/agents/:id/metadata', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const { wallet, name: newName } = req.body;
        const updates: string[] = [];
        const params: any[] = [teamId, agent.id];
        let paramIdx = 3;

        if (wallet) {
          const metadata = { ...(agent.metadata as any || {}), wallet_address: wallet };
          updates.push(`metadata = $${paramIdx++}`);
          params.push(metadata);
        }
        if (newName) {
          updates.push(`name = $${paramIdx++}`);
          params.push(newName);
        }

        if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });

        await this.db.pool.query(
          `UPDATE agents SET ${updates.join(', ')} WHERE team_id = $1 AND id = $2`,
          params
        );

        res.json({ ok: true, updated: Object.keys(req.body) });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.managementApp.delete('/agents/:id', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Stop runtime server if running
      const serverKey = this.key(teamId, agent.id);
      const server = this.runningServers.get(serverKey);
      if (server) {
        try {
          await server.stop();
        } catch (e) {
          console.error(`⚠️ Failed to stop agent server ${agent.name} (${agent.id}):`, e);
        }
        this.runningServers.delete(serverKey);
      }

      // Best-effort delete workspace for claude agents
      if (agent.type === 'claude' && agent.working_directory) {
        try {
          const expectedDir = `${this.baseWorkDir}/agents/${agent.id}`;
          if (agent.working_directory === expectedDir) {
            rmSync(agent.working_directory, { recursive: true, force: true });
          }
        } catch (e) {
          console.error(`⚠️ Failed to delete workspace for ${agent.name} (${agent.id}):`, e);
        }
      }

      // Delete record (cascades wallets/news/queries)
      await this.db.pool.query(`DELETE FROM agents WHERE team_id = $1 AND id = $2`, [teamId, agent.id]);
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
    });

    this.managementApp.delete('/agents/by-name/:name', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const serverKey = this.key(teamId, agent.id);
      const server = this.runningServers.get(serverKey);
      if (server) {
        try {
          await server.stop();
        } catch {}
        this.runningServers.delete(serverKey);
      }
      if (agent.type === 'claude' && agent.working_directory) {
        try {
          const expectedDir = `${this.baseWorkDir}/agents/${agent.id}`;
          if (agent.working_directory === expectedDir) rmSync(agent.working_directory, { recursive: true, force: true });
        } catch {}
      }
      await this.db.pool.query(`DELETE FROM agents WHERE team_id = $1 AND id = $2`, [teamId, agent.id]);
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
    });

    this.managementApp.post('/registry/push', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const includeVirtual = Boolean(req.body?.includeVirtual);
      const agents = await this.dbListAgents(teamId);
      const targets = includeVirtual ? agents : agents.filter(a => a.type === 'claude');

      const results: any[] = [];
      let registered = 0;
      let skipped = 0;
      let failed = 0;

      for (const agent of targets) {
        if (agent.token_id || agent.domain) {
          skipped++;
          results.push({ name: agent.name, id: agent.id, status: 'skipped', reason: 'already-registered', tokenId: agent.token_id, domain: agent.domain });
          continue;
        }
        if (agent.type === 'virtual' && !agent.metadata?.agent_account) {
          skipped++;
          results.push({ name: agent.name, id: agent.id, status: 'skipped', reason: 'virtual-missing-agent_account' });
          continue;
        }

        try {
          const out = await this.registerOnchainAndUpdateAgent(teamId, agent);
          registered++;
          results.push({ name: agent.name, id: agent.id, status: 'registered', ...out });
        } catch (e: any) {
          failed++;
          results.push({ name: agent.name, id: agent.id, status: 'failed', error: e?.message || String(e) });
        }
      }

      res.json({ ok: true, includeVirtual, summary: { registered, skipped, failed }, results });
    });

    this.managementApp.post('/registry/pull', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const baseUrl = String(req.body?.baseUrl || process.env.ID_INDEXER_BASE_URL || 'https://id-indexer.onrender.com');
      const indexerApiKey = process.env.ID_INDEXER_API_KEY;
      const requestedChainId = req.body?.chainId ? parseInt(String(req.body.chainId)) : undefined;
      const requestedRegistryAddress = req.body?.registryAddress ? String(req.body.registryAddress) : undefined;

      // Require specific agent IDs to prevent pulling too many agents
      const agentIds = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String).filter(Boolean) : [];
      if (agentIds.length === 0) {
        return res.status(400).json({
          error: 'Missing agent IDs. Use /registry pull <agent-ids> (space or comma separated)'
        });
      }

      // Optional: also spawn local Claude agents (with HTTP servers) for onchain agents we discover.
      // This "materializes" the registry into a runnable local network.
      const spawnServers = req.body?.spawn === undefined ? false : Boolean(req.body?.spawn);

      const discovery: {
        baseUrl: string;
        chainId?: number;
        registryAddress?: string;
        agentIds: string[];
        fetched: number;
        upserted: number;
        spawned?: number;
        total?: number;
        errors: string[];
      } = {
        baseUrl,
        agentIds,
        fetched: 0,
        upserted: 0,
        errors: []
      };

      const discoveredOnchain: Array<{
        chainId: number;
        registryAddress: string;
        tokenId: string;
        nameHint: string;
      }> = [];

      // Also discover agents from the indexer (registry-wide) and upsert them into the local DB.
      // This makes "pull" behave more like "git pull": you can populate your local network from the registry.
      try {
        const defaultReg = await this.getDefaultRegistry(teamId);
        const chainId = requestedChainId || defaultReg.chainId;
        const registryAddress = requestedRegistryAddress || defaultReg.registryAddress;

        discovery.chainId = chainId;
        discovery.registryAddress = registryAddress;

        // Fetch specific agent IDs from the indexer
        for (const agentId of agentIds) {
          try {
            const params = new URLSearchParams();
            params.set('agentId', agentId);
            params.set('chainId', String(chainId));
            if (requestedRegistryAddress) params.set('registry', String(requestedRegistryAddress));

            const agentUrl = `${baseUrl}/api/agents/${agentId}?${params.toString()}`;
            const agentResp = await fetch(agentUrl, {
              headers: indexerApiKey ? { Authorization: `Bearer ${indexerApiKey}` } : undefined
            });

            if (!agentResp.ok) {
              discovery.errors.push(`agent ${agentId}: HTTP ${agentResp.status} ${agentResp.statusText}`);
              continue;
            }

            const ra = await agentResp.json() as any;
            discovery.fetched += 1;

            const tokenId = String(ra.agentId || ra.mintNumber || agentId).trim();
            const regAddr = String(ra.registryAddress || registryAddress).trim();
            if (!tokenId || !regAddr) {
              discovery.errors.push(`agent ${agentId}: missing tokenId or registryAddress`);
              continue;
            }

            const reg = {
              chainId: ra.chainId || chainId,
              registryAddress: regAddr,
              tokenId
            };

            const shortReg = regAddr.slice(0, 6) + '…' + regAddr.slice(-4);
            const nameHint =
              typeof ra.endpointType === 'string' && ra.endpointType.trim()
                ? `${ra.endpointType}:${shortReg}:${tokenId}`
                : `agent:${shortReg}:${tokenId}`;

            discoveredOnchain.push({
              chainId: ra.chainId || chainId,
              registryAddress: regAddr,
              tokenId,
              nameHint
            });

            const metadata: any = {
              name: nameHint,
              service_type: ra.endpointType || 'REST-AP',
              endpoint: ra.endpoint,
              agent_account: ra.agentAccount
            };

            // If we already have this onchain agent locally (e.g., a spawned claude agent with the same tokenId),
            // merge into that record instead of creating a separate virtual duplicate.
            const existing = await this.db.pool.query<{ id: string; type: string }>(
              `SELECT id, type
               FROM agents
               WHERE team_id = $1
                 AND deleted_at IS NULL
                 AND token_id = $2
               ORDER BY created_at DESC
               LIMIT 1`,
              [teamId, tokenId]
            );

            if (existing.rowCount && existing.rows[0]?.id) {
              const existingId = existing.rows[0].id;
              const existingType = existing.rows[0].type;
              // Merge metadata; don't stomp local endpoint/port for claude agents.
              const current = await this.db.pool.query<any>(
                `SELECT metadata, endpoint FROM agents WHERE team_id = $1 AND id = $2`,
                [teamId, existingId]
              );
              const currentMeta = (current.rows[0]?.metadata || {}) as any;
              const mergedMeta = { ...currentMeta, ...metadata, name: currentMeta.name || metadata.name };

              await this.db.pool.query(
                `UPDATE agents
                 SET token_id = $3,
                     metadata = $4,
                     endpoint = CASE WHEN $5 = 'virtual' THEN $6 ELSE endpoint END,
                     deleted_at = NULL
                 WHERE team_id = $1 AND id = $2`,
                [teamId, existingId, tokenId, mergedMeta, existingType, ra.endpoint || null]
              );

              // Clean up any previously-created onchain_* virtual row for the same token (from older pulls).
              const onchainId = `onchain_${chainId}_${regAddr}_${tokenId}`;
              await this.db.pool.query(`DELETE FROM agents WHERE team_id = $1 AND id = $2 AND type = 'virtual'`, [
                teamId,
                onchainId
              ]);

              discovery.upserted += 1;
              continue;
            }

            // Otherwise upsert as a stable virtual id
            const id = `onchain_${chainId}_${regAddr}_${tokenId}`;
            await this.db.pool.query(
              `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, token_id)
               VALUES ($1,$2,$3,'virtual','external',0,$4,'','running',$5,$6,$7)
               ON CONFLICT (team_id, id)
               DO UPDATE SET name = EXCLUDED.name,
                             endpoint = EXCLUDED.endpoint,
                             status = EXCLUDED.status,
                             metadata = EXCLUDED.metadata,
                             token_id = EXCLUDED.token_id,
                             deleted_at = NULL`,
              [teamId, id, nameHint, ra.endpoint || null, Date.now(), metadata, tokenId]
            );
            discovery.upserted += 1;
          } catch (e: any) {
            discovery.errors.push(`agent ${agentId}: ${e?.message || String(e)}`);
          }
        }
      } catch (e: any) {
        discovery.errors.push(`discovery: ${e?.message || String(e)}`);
      }

      // Optional: spawn local Claude agents for the onchain entries (so they have HTTP servers).
      // NOTE: This does NOT try to contact the remote endpoint; it creates local agents that represent the onchain identities.
      if (spawnServers && discoveredOnchain.length > 0) {
        try {
          const defaultModel = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
          const sharedDirectory = `${this.baseWorkDir}/teams/${teamName}`;
          let spawned = 0;

          // Spawn Claude agents for the agents we just pulled

          for (const agent of discoveredOnchain) {
            const tokenId = agent.tokenId;

            // Never spawn a Claude copy for an interactive agent already linked to this token.
            const hasInteractive = await this.db.pool.query(
              `SELECT 1
               FROM agents
               WHERE team_id = $1
                 AND deleted_at IS NULL
                 AND type = 'interactive'
                 AND (registry->>'chainId') = $2
                 AND LOWER(registry->>'registryAddress') = LOWER($3)
                 AND (registry->>'tokenId') = $4
               LIMIT 1`,
              [teamId, String(agent.chainId), String(agent.registryAddress), tokenId]
            );
            if (hasInteractive.rowCount) continue;

            // If a Claude agent already exists for this token, ensure server is running.
            const existingClaude = await this.db.pool.query<AgentRow>(
              `SELECT *
               FROM agents
               WHERE team_id = $1
                 AND deleted_at IS NULL
                 AND type = 'claude'
                 AND (registry->>'chainId') = $2
                 AND LOWER(registry->>'registryAddress') = LOWER($3)
                 AND (registry->>'tokenId') = $4
               ORDER BY created_at DESC
               LIMIT 1`,
              [teamId, String(agent.chainId), String(agent.registryAddress), tokenId]
            );
            if (existingClaude.rowCount && existingClaude.rows[0]) {
              const a = existingClaude.rows[0];
              const key = this.key(teamId, a.id);
              if (!this.runningServers.get(key)) {
                try {
                  const workingDirectory = a.working_directory || `${this.baseWorkDir}/agents/${a.id}`;
                  if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });
                  const server = new ClaudeAgentServer({
                    model: a.model || defaultModel,
                    workingDirectory,
                    sharedDirectory,
                    agentName: a.name,
                    agentIdentity: { name: a.name, network: teamName, tokenId, metadata: (a.metadata || {}) as any },
                    db: { db: this.db, teamId: teamId, agentId: a.id }
                  });
                  await server.start(a.port);
                  this.runningServers.set(key, server);
                } catch (e: any) {
                  discovery.errors.push(`start-${tokenId}: ${e?.message || String(e)}`);
                }
              }
              continue;
            }

            // Create and start a new local Claude agent representing this onchain identity.
            const claudeId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const port = await this.dbNextPort(teamId);
            const workingDirectory = `${this.baseWorkDir}/agents/${claudeId}`;
            if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

            const nameHint = agent.nameHint;

            // Ensure handle uniqueness (keep handles stable and unique even if onchain display names collide)
            let handle = nameHint;
            const handleExists = await this.db.pool.query(
              `SELECT 1 FROM agents WHERE team_id = $1 AND deleted_at IS NULL AND name = $2 LIMIT 1`,
              [teamId, handle]
            );
            if (handleExists.rowCount) {
              handle = `${nameHint}_${tokenId}`;
            }

            const metadata: AgentMetadata = {
              name: handle,
              service_type: 'REST-AP',
              endpoint: `http://localhost:${port}`
            };

            await this.db.pool.query(
              `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, token_id)
               VALUES ($1,$2,$3,'claude',$4,$5,$6,$7,'starting',$8,$9,$10)`,
              [teamId, claudeId, handle, defaultModel, port, null, workingDirectory, Date.now(), metadata, tokenId]
            );

            const deployerAddress = this.getDeployerAddress();
            const updatedMeta = { ...metadata, agent_account: deployerAddress };
            await this.db.pool.query(`UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`, [
              teamId,
              claudeId,
              updatedMeta
            ]);

            const server = new ClaudeAgentServer({
              model: defaultModel,
              workingDirectory,
              sharedDirectory,
              agentName: handle,
              agentIdentity: { name: handle, network: teamName, tokenId, metadata: updatedMeta },
              db: { db: this.db, teamId: teamId, agentId: claudeId }
            });
            await server.start(port);
            this.runningServers.set(this.key(teamId, claudeId), server);
            await this.db.pool.query(`UPDATE agents SET status = 'running' WHERE team_id = $1 AND id = $2`, [
              teamId,
              claudeId
            ]);

            spawned++;
          }

          discovery.spawned = spawned;
        } catch (e: any) {
          discovery.errors.push(`spawn: ${e?.message || String(e)}`);
        }
      }

      // Refresh local list after best-effort discovery upsert
      const agents = await this.dbListAgents(teamId);

      const results: any[] = [];
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      const defaultReg = await this.getDefaultRegistry(teamId);
      for (const agent of agents) {
        const tokenId = agent.token_id;
        if (!tokenId) {
          skipped++;
          results.push({ name: agent.name, id: agent.id, status: 'skipped', reason: 'missing-tokenId' });
          continue;
        }

        try {
          const url = `${baseUrl}/api/agents/${defaultReg.chainId}/${defaultReg.registryAddress}/${tokenId}/metadata`;
          const resp = await fetch(url, {
            headers: indexerApiKey ? { Authorization: `Bearer ${indexerApiKey}` } : undefined
          });
          if (!resp.ok) {
            failed++;
            results.push({ name: agent.name, id: agent.id, status: 'failed', error: `HTTP ${resp.status} ${resp.statusText}` });
            continue;
          }

          const meta = (await resp.json()) as any;
          const endpoints: any[] = Array.isArray(meta?.endpoints) ? meta.endpoints : [];

          const agentWalletEndpoint = endpoints.find(
            e => String(e?.name).toLowerCase() === 'agentwallet' || String(e?.name).toLowerCase() === 'agent_wallet'
          );
          const agentWalletStr = agentWalletEndpoint?.endpoint as string | undefined;
          const agentAccount =
            typeof agentWalletStr === 'string' && agentWalletStr.includes(':')
              ? agentWalletStr.split(':').slice(-1)[0]
              : undefined;

          const primaryEndpoint = endpoints.find(e => String(e?.name).toLowerCase() !== 'agentwallet' && typeof e?.endpoint === 'string');

          const isManager = agent.id === 'virtual_manager' || agent.name === 'manager';
          const isReservedManagerName = typeof meta?.name === 'string' && meta.name.trim().toLowerCase() === 'manager';
          const nextMetadata = {
            ...(agent.metadata || {}),
            // The local manager agent is special: never let onchain name changes overwrite it.
            // Also treat "manager" as a reserved display name: don't allow other agents to take it via onchain metadata,
            // since it creates confusing duplicates in the CLI.
            name: isManager
              ? agent.metadata?.name || 'manager'
              : isReservedManagerName
                ? agent.name
                : typeof meta?.name === 'string'
                  ? meta.name
                  : agent.metadata?.name,
            description: typeof meta?.description === 'string' ? meta.description : agent.metadata?.description,
            image: typeof meta?.image === 'string' ? meta.image : agent.metadata?.image,
            service_type: typeof primaryEndpoint?.name === 'string' ? primaryEndpoint.name : agent.metadata?.service_type,
            endpoint: typeof primaryEndpoint?.endpoint === 'string' ? primaryEndpoint.endpoint : agent.metadata?.service,
            agent_account: agentAccount || agent.metadata?.agent_account
          };

          await this.db.pool.query(`UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`, [teamId, agent.id, nextMetadata]);

          // Update running server identity
          const server = this.runningServers.get(this.key(teamId, agent.id));
          if (server && agent.type === 'claude') {
            server.setIdentity({
              name: agent.name,
              metadata: nextMetadata,
              tokenId: agent.token_id || undefined,
              domain: agent.domain || undefined
            });
          }

          updated++;
          results.push({ name: agent.name, id: agent.id, status: 'updated', tokenId });
        } catch (e: any) {
          failed++;
          results.push({ name: agent.name, id: agent.id, status: 'failed', error: e?.message || String(e) });
        }
      }

      res.json({ ok: true, baseUrl, discovery, summary: { updated, skipped, failed }, results });
    });




    // ==================== REMOTE CLI ENDPOINT ====================
    // Allows external tools to execute CLI-style commands

    this.managementApp.post('/remote', async (req, res) => {

      const { command } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'Missing command in request body' });
      }

      const { id: teamId, name: teamName } = await this.getTeam(req);

      try {
        const result = await this.executeRemoteCommand(command.trim(), teamId, teamName);
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Command execution failed' });
      }
    });

    // Handle /:tokenId without trailing path - returns agent info
    // NOTE: Must be defined BEFORE the wildcard route to take precedence
    this.managementApp.get('/:tokenId', async (req, res) => {
      const tokenIdParam = req.params.tokenId;

      // Only handle numeric tokenIds
      if (!/^\d+$/.test(tokenIdParam)) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { id: teamId } = await this.getTeam(req);

      // Find agent by tokenId
      const agents = await this.dbListAgents(teamId, true);
      const agent = agents.find(a => a.token_id === tokenIdParam);

      if (!agent) {
        return res.status(404).json({ error: `Agent with tokenId ${tokenIdParam} not found` });
      }

      // Return agent info with links
      const baseUrl = `${req.protocol}://${req.get('host')}/${tokenIdParam}`;
      res.json({
        agent: this.agentToResponse(agent),
        links: {
          catalog: `${baseUrl}/.well-known/restap.json`,
          talk: `${baseUrl}/talk`,
          news: `${baseUrl}/news`
        }
      });
    });

    // TokenId-based agent proxy route: /:tokenId/* -> proxy to agent
    // This allows accessing agents via https://idbot.live/23/talk etc.
    // Express 5 uses {*path} syntax for wildcards
    // Use regex for wildcard path matching in Express 5
    // Matches /85/talk, /85/.well-known/restap.json, etc.
    this.managementApp.all(/^\/(\d+)\/(.+)$/, async (req, res) => {
      const tokenIdParam = req.params[0]; // First capture group is tokenId

      const { id: teamId } = await this.getTeam(req);

      // Find agent by tokenId
      const agents = await this.dbListAgents(teamId, true);
      const agent = agents.find(a => a.token_id === tokenIdParam);

      if (!agent) {
        return res.status(404).json({ error: `Agent with tokenId ${tokenIdParam} not found` });
      }

      // Get the agent's internal URL
      const isExternal = agent.type === 'virtual' || agent.type === 'interactive';
      const internalUrl = agent.type === 'claude'
        ? (agent.endpoint || `http://localhost:${agent.port}`)
        : (isExternal ? agent.endpoint : null);
      if (!internalUrl) {
        return res.status(503).json({ error: 'Agent endpoint not available' });
      }

      // Build the proxied path (everything after /:tokenId)
      // Extract path from URL: /23/talk -> talk
      const urlPath = req.path;
      const pathAfterTokenId = urlPath.replace(new RegExp(`^/${tokenIdParam}/?`), '');
      const targetUrl = `${internalUrl.replace(/\/+$/, '')}/${pathAfterTokenId}`;

      try {
        // Proxy the request - use ID_CONTROL_API_KEY which is shared between manager and agents
        const controlApiKey = process.env.ID_CONTROL_API_KEY;
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Accept': req.headers['accept'] || 'application/json',
            // Use control API key for internal proxying
            ...(controlApiKey ? { 'X-Api-Key': controlApiKey } : {})
          },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body)
        });

        const contentType = proxyRes.headers.get('content-type') || 'application/json';
        res.status(proxyRes.status).type(contentType);

        const body = await proxyRes.text();
        res.send(body);
      } catch (error: any) {
        res.status(502).json({ error: `Proxy error: ${error.message}` });
      }
    });

  }

  /**
   * Execute a CLI-style command and return the result
   */
  private async executeRemoteCommand(
    command: string,
    teamId: string,
    teamName: string
  ): Promise<{ ok: boolean; result?: any; error?: string }> {
    // Remove leading slash if present
    const cmd = command.startsWith('/') ? command.slice(1) : command;
    const parts = cmd.split(/\s+/);
    const action = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (action) {
      case 'agents': {
        const agents = await this.dbListAgents(teamId);
        return {
          ok: true,
          result: {
            agents: agents.map(a => ({
              name: a.name,
              id: a.id,
              type: a.type,
              status: a.status,
              model: a.model,
              port: a.port,
              url: a.endpoint || (a.port ? `http://localhost:${a.port}` : null)
            }))
          }
        };
      }

      case 'status': {
        const agents = await this.dbListAgents(teamId);
        const running = agents.filter(a => a.status === 'running').length;
        const offline = agents.filter(a => a.status === 'offline').length;
        const agentHealth = agents.map(a => {
          const h = this.getHealthForAgent(a);
          const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
          return { name: alias, status: a.status, health: h.health, lastHealthCheck: h.lastHealthCheck };
        });
        return {
          ok: true,
          result: {
            team: teamName,
            totalAgents: agents.length,
            runningAgents: running,
            offlineAgents: offline,
            agents: agentHealth,
            status: 'ok'
          }
        };
      }

      case 'heartbeat': {
        // /heartbeat <agent> - show heartbeat status for specific agent
        // /heartbeat enable <agent> - enable heartbeat for agent
        // /heartbeat disable <agent> - disable heartbeat for agent
        const subCmd = args[0];

        // Handle enable/disable subcommands
        if (subCmd === 'enable' || subCmd === 'disable') {
          const agentName = args[1];
          if (!agentName) {
            return { ok: false, error: `Usage: /heartbeat ${subCmd} <agent>` };
          }
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];

          if (subCmd === 'enable') {
            if (!agent.working_directory) {
              return { ok: false, error: `Agent "${agent.name}" has no working directory` };
            }
            // Check for HEARTBEAT.yaml in working directory
            const config = this.readHeartbeatConfig(agent.working_directory);
            if (!config) {
              return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml in working directory` };
            }
            // Update metadata to enable heartbeat
            const newMetadata = { ...agent.metadata, heartbeat: true };
            await this.db.pool.query(
              `UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`,
              [teamId, agent.id, newMetadata]
            );
            // Start heartbeat timer if agent is running
            if (agent.status === 'running') {
              this.startHeartbeatForAgent(teamId, agent.id, agent.name, agent.working_directory, config.interval);
            }
            return { ok: true, result: { message: `Heartbeat enabled for ${agent.name} (interval: ${config.interval}s)` } };
          } else {
            // Disable heartbeat
            const newMetadata = { ...agent.metadata };
            delete newMetadata.heartbeat;
            await this.db.pool.query(
              `UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`,
              [teamId, agent.id, newMetadata]
            );
            this.stopHeartbeatForAgent(agent.id);
            return { ok: true, result: { message: `Heartbeat disabled for ${agent.name}` } };
          }
        }

        const agentName = subCmd; // First arg is the agent name for status query

        if (agentName) {
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];
          if (agent.metadata?.heartbeat !== true) {
            return { ok: false, error: `Agent "${agent.name}" does not have heartbeat enabled. Use /heartbeat enable ${agent.name}` };
          }
          if (!agent.working_directory) {
            return { ok: false, error: `Agent "${agent.name}" has no working directory` };
          }
          const config = this.readHeartbeatConfig(agent.working_directory);
          const lastSent = this.heartbeatLastSent.get(agent.id);
          const intervalMs = this.heartbeatIntervals.get(agent.id);
          let nextIn: string | null = null;
          if (lastSent && intervalMs) {
            const nextTime = lastSent + intervalMs;
            const remainingMs = nextTime - Date.now();
            if (remainingMs > 0) {
              const remainingSec = Math.round(remainingMs / 1000);
              if (remainingSec >= 60) {
                const mins = Math.floor(remainingSec / 60);
                const secs = remainingSec % 60;
                nextIn = secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
              } else {
                nextIn = `${remainingSec}s`;
              }
            } else {
              nextIn = 'imminent';
            }
          }
          return {
            ok: true,
            result: {
              agent: {
                name: agent.name,
                id: agent.id,
                status: agent.status,
                heartbeatActive: this.heartbeatTimers.has(agent.id),
                intervalSeconds: config?.interval || 'no file',
                nextIn,
                beatsSent: this.heartbeatCounts.get(agent.id) || 0,
                maxBeats: config?.maxBeats ?? 20,
                expiresAfter: config?.expiresAfter ?? 7200
              }
            }
          };
        }

        // No argument - show usage
        return { ok: false, error: 'Usage: /heartbeat <agent> or /heartbeats (to show all)' };
      }

      case 'heartbeats': {
        // /heartbeats - show all agents with heartbeat enabled
        const agents = await this.db.pool.query(
          `SELECT id, name, status, working_directory FROM agents WHERE team_id = $1 AND metadata->>'heartbeat' = 'true'`,
          [teamId]
        );
        const activeTimers = Array.from(this.heartbeatTimers.keys());
        const now = Date.now();
        return {
          ok: true,
          result: {
            agents: agents.rows.map(a => {
              const config = this.readHeartbeatConfig(a.working_directory);
              const lastSent = this.heartbeatLastSent.get(a.id);
              const intervalMs = this.heartbeatIntervals.get(a.id);
              let nextIn: string | null = null;
              if (lastSent && intervalMs) {
                const nextTime = lastSent + intervalMs;
                const remainingMs = nextTime - now;
                if (remainingMs > 0) {
                  const remainingSec = Math.round(remainingMs / 1000);
                  if (remainingSec >= 60) {
                    const mins = Math.floor(remainingSec / 60);
                    const secs = remainingSec % 60;
                    nextIn = secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
                  } else {
                    nextIn = `${remainingSec}s`;
                  }
                } else {
                  nextIn = 'imminent';
                }
              }
              return {
                name: a.name,
                id: a.id,
                status: a.status,
                heartbeatActive: activeTimers.includes(a.id),
                intervalSeconds: config?.interval || 'no file',
                nextIn,
                beatsSent: this.heartbeatCounts.get(a.id) || 0,
                maxBeats: config?.maxBeats ?? 20,
                expiresAfter: config?.expiresAfter ?? 7200
              };
            })
          }
        };
      }

      case 'delete': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /delete <agent-name|agent-id>' };
        }

        // Try to resolve by various identifiers
        const matches = await this.dbResolveAgents(teamId, agentName);

        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (matches.length > 1) {
          const matchList = matches.map(a => {
            const domain = a.domain || (a.metadata as any)?.idchain_domain;
            const displayId = domain || a.name || a.id;
            return `  - ${displayId} (${a.status})`;
          }).join('\n');
          return {
            ok: false,
            error: `Multiple agents match "${agentName}":\n${matchList}\nUse a specific identifier (e.g., ENS domain or agent_id)`
          };
        }

        const a = matches[0];
        const serverKey = this.key(teamId, a.id);
        const server = this.runningServers.get(serverKey);

        if (server) {
          await server.stop();
          this.runningServers.delete(serverKey);
        }

        // Stop heartbeat if this agent had one
        this.stopHeartbeatForAgent(a.id);

        // Cancel any pending queries so they don't show as orphaned
        await this.cancelPendingQueriesForAgent(teamId, a.id);

        await this.db.pool.query(
          `UPDATE agents SET deleted_at = $3, status = 'stopped' WHERE team_id = $1 AND id = $2`,
          [teamId, a.id, Date.now()]
        );

        return { ok: true, result: { deleted: agentName } };
      }

      case 'ask':
      case 'hey': {
        const agentName = args[0];
        const message = args.slice(1).join(' ');

        if (!agentName || !message) {
          return { ok: false, error: `Usage: /${action} <agent-name|agent-id> <message>` };
        }

        // Try to resolve by various identifiers
        const matches = await this.dbResolveAgents(teamId, agentName);

        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (matches.length > 1) {
          const matchList = matches.map(a => {
            const domain = a.domain || (a.metadata as any)?.idchain_domain;
            const displayId = domain || a.name || a.id;
            return `  - ${displayId} (${a.status})`;
          }).join('\n');
          return {
            ok: false,
            error: `Multiple agents match "${agentName}":\n${matchList}\nUse a specific identifier (e.g., ENS domain or agent_id)`
          };
        }

        const a = matches[0];
        // Use endpoint if set, otherwise construct from port using localhost
        const baseEndpoint = a.endpoint || `http://localhost:${a.port}`;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const talkUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.talk}`;

        // Send message to agent's /talk endpoint
        const talkHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.ID_AGENT_API_KEY) {
          talkHeaders['X-API-Key'] = process.env.ID_AGENT_API_KEY;
        }
        const talkResp = await fetch(talkUrl, {
          method: 'POST',
          headers: talkHeaders,
          body: JSON.stringify({ message, from: 'remote' })
        });

        if (!talkResp.ok) {
          const err = await talkResp.text();
          return { ok: false, error: `Failed to send message: ${err}` };
        }

        const talkResult = await talkResp.json() as any;
        return {
          ok: true,
          result: {
            queryId: talkResult.query_id || talkResult.queryId,
            status: 'processing',
            agent: agentName
          }
        };
      }

      case 'news': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /news <agent-name>' };
        }

        const agent = await this.db.pool.query<AgentRow>(
          `SELECT * FROM agents WHERE team_id = $1 AND name = $2 AND deleted_at IS NULL`,
          [teamId, agentName]
        );

        if (!agent.rows[0]) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        const a = agent.rows[0];
        // Use endpoint if set, otherwise construct from port using localhost
        const baseEndpoint = a.endpoint || `http://localhost:${a.port}`;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const newsUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.news}`;

        const newsHeaders: Record<string, string> = {};
        if (process.env.ID_AGENT_API_KEY) {
          newsHeaders['X-API-Key'] = process.env.ID_AGENT_API_KEY;
        }
        const newsResp = await fetch(newsUrl, { headers: newsHeaders });
        if (!newsResp.ok) {
          return { ok: false, error: 'Failed to fetch news' };
        }

        const news = await newsResp.json();
        return { ok: true, result: news };
      }

      case 'register': {
        // Register an agent onchain
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /register <agent-name>' };
        }

        const agent = await this.db.pool.query<AgentRow>(
          `SELECT * FROM agents WHERE team_id = $1 AND name = $2 AND deleted_at IS NULL`,
          [teamId, agentName]
        );

        if (!agent.rows[0]) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        const a = agent.rows[0];

        // Call the existing onchain register endpoint
        try {
          const regResult = await this.registerOnchainAndUpdateAgent(teamId, a);
          return {
            ok: true,
            result: {
              agent: agentName,
              tokenId: regResult.tokenId,
              domain: regResult.domain,
              txHash: regResult.txHash
            }
          };
        } catch (err: any) {
          return { ok: false, error: `Registration failed: ${err.message}` };
        }
      }

      case 'sync-wallets': {
        // Set multi-chain wallet addresses for all registered agents
        const pk = process.env.ID_REGISTRAR_PRIVATE_KEY || process.env.PRIVATE_KEY;
        if (!pk) {
          return { ok: false, error: 'Missing env var PRIVATE_KEY or ID_REGISTRAR_PRIVATE_KEY' };
        }

        const defaultReg = await this.getDefaultRegistry(teamId);
        const chainNames: Record<number, string> = { 8453: 'base', 1: 'eth', 10: 'op', 42161: 'arb', 11155111: 'sepolia' };
        const chain = chainNames[defaultReg.chainId] || 'base';

        const agents = await this.dbListAgents(teamId);
        const results: any[] = [];
        let synced = 0;
        let skipped = 0;
        let failed = 0;

        for (const agent of agents) {
          const domain = agent.domain || (agent.metadata as any)?.idchain_domain;
          const owsWallet = (agent.metadata as any)?.ows_wallet;

          if (!domain) {
            skipped++;
            results.push({ name: agent.name, status: 'skipped', reason: 'no domain' });
            continue;
          }
          if (!owsWallet) {
            skipped++;
            results.push({ name: agent.name, status: 'skipped', reason: 'no OWS wallet' });
            continue;
          }

          try {
            const addrResult = await setMultiChainAddresses({
              name: domain,
              walletName: owsWallet,
              chain,
              privateKey: pk,
            });
            synced++;
            results.push({ name: agent.name, domain, status: 'synced', set: addrResult.set, skipped: addrResult.skipped });
          } catch (err: any) {
            failed++;
            results.push({ name: agent.name, status: 'failed', error: err.message });
          }
        }

        return { ok: true, result: { synced, skipped, failed, results } };
      }

      case 'deploy': {
        // Deploy agents from a config file
        // Usage: /deploy <config> [param1=value1] [param2=value2] ...
        const configPath = args[0];
        if (!configPath) {
          return { ok: false, error: 'Usage: /deploy <config> [param=value ...]' };
        }

        // Resolve config path (support shorthand like "designer" -> "configs/designer.yaml")
        let filePath = configPath;
        const originalArg = configPath;
        if (!filePath.includes('/') && !filePath.includes('\\')) {
          if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
            filePath = `configs/${filePath}.yaml`;
          } else {
            filePath = `configs/${filePath}`;
          }
        } else if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
          filePath = `${filePath}.yaml`;
        }

        // Resolve to absolute path
        let absolutePath = path.resolve(process.cwd(), filePath);

        // Parse config with provided parameters
        let deployArgs = args.slice(1);

        // If config doesn't exist, fall back to default.yaml with the arg as the name
        if (!existsSync(absolutePath)) {
          const defaultPath = path.resolve(process.cwd(), 'configs/default.yaml');
          if (existsSync(defaultPath)) {
            console.log(`[Deploy] Config not found: ${filePath}, using default.yaml with name=${originalArg}`);
            absolutePath = defaultPath;
            // Prepend the original arg as name parameter if not already specified
            if (!deployArgs.some(a => a.startsWith('name='))) {
              deployArgs = [originalArg, ...deployArgs];
            }
          } else {
            return { ok: false, error: `Config file not found: ${filePath}` };
          }
        }
        const { agents, errors, onchain, teamName: configTeam } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

        // If config specifies a team, use that instead of the request's team
        let effectiveTeamId = teamId;
        let effectiveTeamName = teamName;
        if (configTeam && configTeam !== teamName) {
          effectiveTeamId = await getOrCreateTeamId(this.db, configTeam);
          effectiveTeamName = configTeam;
          // Ensure team directory exists
          const configTeamDir = `${this.baseWorkDir}/teams/${configTeam}`;
          if (!existsSync(configTeamDir)) mkdirSync(configTeamDir, { recursive: true });
          console.log(`[Deploy] Using team from config: ${configTeam}`);
        }

        if (errors.length > 0) {
          return {
            ok: false,
            error: `Config errors: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`
          };
        }

        if (agents.length === 0) {
          return { ok: false, error: 'No agents defined in config' };
        }

        // Validate automator naming: first automator must be named "manager"
        const automatorAgents = agents.filter(a => a.type === 'automator');
        if (automatorAgents.length > 0) {
          // Check if "manager" automator already exists in database
          const existingManagerResult = await this.db.pool.query(
            `SELECT id FROM agents WHERE team_id = $1 AND type = 'automator' AND name = 'manager'`,
            [effectiveTeamId]
          );
          const hasManagerAutomator = existingManagerResult.rows.length > 0;

          // If no manager automator exists, the first one being deployed must be named "manager"
          if (!hasManagerAutomator) {
            const hasManagerInConfig = automatorAgents.some(a => a.name === 'manager');
            if (!hasManagerInConfig) {
              return {
                ok: false,
                error: 'First automator must be named "manager". Use: /deploy automator'
              };
            }
          }
        }

        // Deploy each agent
        const results: { name: string; id?: string; port?: number; success: boolean; error?: string; tokenId?: string }[] = [];

        for (const agentConfig of agents) {
          // Generate unique agent ID outside try so it's available for cleanup
          const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          try {
            const port = await this.dbNextPort(effectiveTeamId);
            const workingDirectory = agentConfig.workingDirectory && path.isAbsolute(agentConfig.workingDirectory)
              ? agentConfig.workingDirectory
              : `${this.baseWorkDir}/agents/${agentId}`;

            if (!existsSync(workingDirectory)) {
              mkdirSync(workingDirectory, { recursive: true });
            }

            // Write CLAUDE.md if specified in config (prepend to any existing content)
            if (agentConfig.claudeMd) {
              const claudeDir = path.join(workingDirectory, '.claude');
              if (!existsSync(claudeDir)) {
                mkdirSync(claudeDir, { recursive: true });
              }
              const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
              // Prepend config claudeMd to existing content (config takes priority)
              const existingContent = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : '';
              const newContent = existingContent
                ? `${agentConfig.claudeMd}\n\n${existingContent}`
                : agentConfig.claudeMd;
              writeFileSync(claudeMdPath, newContent);
            }

            // Merge plugins from config
            const effectiveRuntime = (agentConfig.runtime || 'claude-agent-sdk') as HarnessType;
            const mergedPlugins = agentConfig.plugins || [];

            // Copy plugins to agent's working directory
            const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

            // Automator agents are the manager's brain - they don't have REST-AP endpoints
            console.log(`[Deploy] Agent ${agentConfig.name}: type=${agentConfig.type}, isAutomator=${agentConfig.type === 'automator'}`);
            const isAutomator = agentConfig.type === 'automator';
            const agentType = agentConfig.type || 'claude';

            // Get heartbeat config (already resolved by processConfig from heartbeatFile)
            const heartbeatConfig = agentConfig.heartbeat as HeartbeatConfig | undefined;

            // Copy heartbeat config to agent's working directory if specified
            if (heartbeatConfig) {
              const heartbeatPath = path.join(workingDirectory, 'HEARTBEAT.yaml');
              const heartbeatContent = `# Heartbeat config for ${agentConfig.name}\n# Edit this file to customize heartbeat behavior\n\ninterval: ${heartbeatConfig.interval}  # seconds\n\nmessage: |\n${heartbeatConfig.message.split('\n').map(line => '  ' + line).join('\n')}\n`;
              writeFileSync(heartbeatPath, heartbeatContent);
              console.log(`[Deploy] Wrote heartbeat config to ${heartbeatPath}`);
            }

            const metadata: AgentMetadata = {
              name: agentConfig.name,
              service_type: isAutomator ? undefined : 'REST-AP',
              endpoint: isAutomator ? undefined : `http://localhost:${port}`,
              runtime: effectiveRuntime,
              plugins: localPlugins,
              allowed_tools: agentConfig.allowedTools,
              description: agentConfig.description,
              requireAuth: agentConfig.requireAuth,
              ...(isAutomator && { isAutomator: true }),
              // Flag that heartbeat is enabled (actual config read from HEARTBEAT.yaml in working dir)
              ...(heartbeatConfig && { heartbeat: true })
            };

            // Use ENS domain from config if available (preserves registration across redeploys)
            const configDomain = agentConfig.domain;
            const configTokenId = agentConfig.tokenId;
            const agentName = configDomain || agentConfig.name;
            if (configDomain) {
              metadata.idchain_domain = configDomain;
              metadata.alias = agentConfig.name;
            }

            // Auto-create OWS wallet if ows CLI is available
            const owsWallet = this.getOrCreateAgentWallet(effectiveTeamName, agentConfig.name);
            if (owsWallet) {
              metadata.ows_wallet = owsWallet.walletName;
              metadata.ows_address = owsWallet.address;

              // Write wallet skill into the agent's .claude/skills/ folder
              try {
                const skillDir = path.join(workingDirectory, '.claude', 'skills');
                if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
                const walletSkill = `# Wallet Skill

You have an OWS (Open Wallet Standard) wallet named **"${owsWallet.walletName}"**.

It holds addresses for multiple blockchains derived from a single mnemonic.

## View your addresses

\`\`\`bash
ows wallet list 2>/dev/null | awk '/Name:.*${owsWallet.walletName}/{found=1} found && /Name:/ && !/Name:.*${owsWallet.walletName}/{exit} found'
\`\`\`

## Chains supported

| Chain | Example format |
|-------|---------------|
| Ethereum/EVM | 0x... (works on Base, Optimism, Arbitrum, etc.) |
| Bitcoin | bc1... |
| Cosmos | cosmos1... |
| Tron | T... |
| TON | UQ... |
| Filecoin | f1... |
| Sui | 0x... (64 bytes) |

When asked for your wallet address, run the command above and report the relevant chain address.
`;
                writeFileSync(path.join(skillDir, 'wallet.md'), walletSkill);
              } catch (err: any) {
                console.warn(`[Deploy] Could not write wallet skill: ${err.message}`);
              }
            }

            // Insert into database
            console.log(`[Deploy] Storing agent: name=${agentName}, type=${agentType}, configType=${agentConfig.type}`);
            await this.db.pool.query(
              `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, runtime, token_id, domain)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'starting', $9, $10, $11, $12, $13)`,
              [effectiveTeamId, agentId, agentName, agentType, agentConfig.model || 'haiku', port, null, workingDirectory, Date.now(), metadata, effectiveRuntime,
               configTokenId || null, configDomain || null]
            );

            // All agents run locally - set up database and let CLI spawn the process
            const url = `http://localhost:${port}`;
            const finalMeta = { ...metadata, endpoint: url, local: true };
            await this.db.pool.query(
              `UPDATE agents SET status = 'pending', port = $3, endpoint = $4, metadata = $5 WHERE team_id = $1 AND id = $2`,
              [effectiveTeamId, agentId, port, url, finalMeta]
            );

            // Spawn the agent process
            const spawnResult = await this.spawnLocalAgentProcess(effectiveTeamId, effectiveTeamName, {
              name: agentConfig.name,
              id: agentId,
              port,
              model: agentConfig.model || this.defaultConfig?.model,
              workingDirectory,
              tokenId: configTokenId || undefined,
              address: (agentConfig as any).address || undefined
            });

            // Start heartbeat timer if config file was specified
            if (heartbeatConfig) {
              this.startHeartbeatForAgent(effectiveTeamId, agentId, agentConfig.name, workingDirectory, heartbeatConfig.interval);
            }

            const result: { name: string; id: string; port: number; success: boolean; tokenId?: string; domain?: string; txHash?: string; local: boolean; workingDirectory: string; pid?: number; logFile?: string } = {
              name: agentConfig.name,
              id: agentId,
              port,
              success: true,
              local: true,
              workingDirectory
            };

            if (spawnResult.success) {
              result.pid = spawnResult.pid;
              result.logFile = spawnResult.logFile;
              // Update status to running
              await this.db.pool.query(
                `UPDATE agents SET status = 'running' WHERE team_id = $1 AND id = $2`,
                [effectiveTeamId, agentId]
              );
            }

            // Auto-register onchain if enabled (automators never register)
            const shouldRegister = !isAutomator && (agentConfig.register !== undefined ? agentConfig.register : onchain?.register);
            if (shouldRegister) {
              try {
                // Fetch the agent row for registration
                const agentRow = await this.db.pool.query<AgentRow>(
                  `SELECT * FROM agents WHERE team_id = $1 AND id = $2`,
                  [effectiveTeamId, agentId]
                );
                if (agentRow.rows[0]) {
                  const regResult = await this.registerOnchainAndUpdateAgent(effectiveTeamId, agentRow.rows[0]);
                  console.log(`[Deploy] Registration result: domain=${regResult.domain}, tokenId=${regResult.tokenId}, txHash=${regResult.txHash}`);
                  result.tokenId = regResult.tokenId;
                  result.domain = regResult.domain;
                  result.txHash = regResult.txHash;

                  // Update CLAUDE.md with agent's full identity after registration
                  if (regResult.tokenId) {
                    console.log(`[Deploy] Writing identity to CLAUDE.md at ${workingDirectory}`);
                    try {
                      const claudeDir = path.join(workingDirectory, '.claude');
                      if (!existsSync(claudeDir)) {
                        console.log(`[Deploy] Creating .claude directory: ${claudeDir}`);
                        mkdirSync(claudeDir, { recursive: true });
                      }
                      this.updateClaudeMdIdentity(path.join(claudeDir, 'CLAUDE.md'), regResult.domain || agentConfig.name);
                      console.log(`[Deploy] Updated CLAUDE.md with identity: ${regResult.domain || agentConfig.name}`);
                    } catch (identityErr: any) {
                      console.warn(`[Deploy] Failed to update identity in CLAUDE.md: ${identityErr.message}`);
                    }
                  }
                }
              } catch (regErr: any) {
                // Registration failure is non-fatal
                console.warn(`[Deploy] Auto-register failed for ${agentConfig.name}: ${regErr.message}`);
              }
            }

            results.push(result);
          } catch (err: any) {
            // Clean up the database record if deployment failed
            if (agentId) {
              try {
                await this.db.pool.query(
                  `DELETE FROM agents WHERE team_id = $1 AND id = $2`,
                  [effectiveTeamId, agentId]
                );
                console.log(`[Deploy] Cleaned up failed agent record: ${agentId}`);
              } catch (cleanupErr) {
                console.warn(`[Deploy] Failed to clean up agent record: ${cleanupErr}`);
              }
            }
            results.push({ name: agentConfig.name, success: false, error: err.message });
          }
        }

        return {
          ok: true,
          result: {
            deployed: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            agents: results
          }
        };
      }

      case 'agent': {
        // Control individual agent: /agent <name> <start|stop|rebuild|logs>
        const agentName = args[0];
        const subAction = args[1]?.toLowerCase();

        if (!agentName || !subAction) {
          return { ok: false, error: 'Usage: /agent <name> <start|stop|rebuild|logs|heartbeat>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (agent.type !== 'claude') {
          return { ok: false, error: 'Only claude agents can be controlled' };
        }

        try {
          switch (subAction) {
            case 'start': {
              const spawnResult = await this.spawnLocalAgentProcess(teamId, teamName, {
                name: agent.name, id: agent.id, port: agent.port,
                model: agent.model, workingDirectory: agent.working_directory ?? undefined,
                tokenId: agent.token_id ?? undefined
              });
              if (spawnResult.success) {
                await this.db.pool.query(
                  `UPDATE agents SET status = 'running' WHERE team_id = $1 AND id = $2`,
                  [teamId, agent.id]
                );
                return { ok: true, result: { action: 'started', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to start ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'stop': {
              const killResult = await this.killAgentProcess(agent.port);
              const cancelled = await this.cancelPendingQueriesForAgent(teamId, agent.id);
              await this.db.pool.query(
                `UPDATE agents SET status = 'stopped' WHERE team_id = $1 AND id = $2`,
                [teamId, agent.id]
              );
              return { ok: true, result: { action: 'stopped', name: agent.name, ...killResult, queriesCancelled: cancelled } };
            }
            case 'rebuild': {
              await this.killAgentProcess(agent.port);
              await new Promise(r => setTimeout(r, 1000));
              const spawnResult = await this.spawnLocalAgentProcess(teamId, teamName, {
                name: agent.name, id: agent.id, port: agent.port,
                model: agent.model, workingDirectory: agent.working_directory ?? undefined,
                tokenId: agent.token_id ?? undefined
              });
              if (spawnResult.success) {
                await this.db.pool.query(
                  `UPDATE agents SET status = 'running' WHERE team_id = $1 AND id = $2`,
                  [teamId, agent.id]
                );
                return { ok: true, result: { action: 'rebuilt', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to rebuild ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'logs': {
              return { ok: false, error: 'Logs not available for local agents' };
            }
            case 'heartbeat': {
              // Send heartbeat and reset timer (reads from agent's HEARTBEAT.yaml)
              if (agent.metadata?.heartbeat !== true) {
                return { ok: false, error: `Agent "${agent.name}" does not have heartbeat enabled` };
              }
              if (agent.status !== 'running') {
                return { ok: false, error: `Agent "${agent.name}" is not running` };
              }
              if (!agent.working_directory) {
                return { ok: false, error: `Agent "${agent.name}" has no working directory` };
              }
              // Read config from file
              const config = this.readHeartbeatConfig(agent.working_directory);
              if (!config) {
                return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml file` };
              }
              // Send immediate heartbeat
              await this.sendHeartbeat(teamId, agent.id, agent.name, agent.working_directory);
              // Restart timer with interval from file (resets back to 0)
              this.startHeartbeatForAgent(teamId, agent.id, agent.name, agent.working_directory, config.interval);
              return { ok: true, result: { action: 'heartbeat', name: agent.name, intervalSeconds: config.interval, message: 'Heartbeat sent and timer reset' } };
            }
            default:
              return { ok: false, error: `Unknown agent action: ${subAction}. Available: start, stop, rebuild, logs, heartbeat` };
          }
        } catch (err: any) {
          return { ok: false, error: `Agent ${subAction} failed: ${err.message}` };
        }
      }

      case 'model': {
        // Change agent model: /model <agent> <model>
        const agentName = args[0];
        const newModel = args[1];

        if (!agentName || !newModel) {
          return { ok: false, error: 'Usage: /model <agent-name> <model>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Resolve model alias
        const resolvedModel = resolveModelAlias(newModel);

        // Update model and mark for restart if running
        const newStatus = agent.status === 'running' ? 'pending' : agent.status;
        await this.db.pool.query(
          `UPDATE agents SET model = $3, status = $4 WHERE team_id = $1 AND id = $2`,
          [teamId, agent.id, resolvedModel, newStatus]
        );

        return {
          ok: true,
          result: {
            name: agent.name,
            model: resolvedModel,
            ...(agent.status === 'running' && { message: 'Model updated. Agent marked for restart.' })
          }
        };
      }

      case 'configs': {
        // List available deployment configs
        const configsDir = path.resolve(process.cwd(), 'configs');
        if (!existsSync(configsDir)) {
          return { ok: true, result: { configs: [] } };
        }
        const files = readdirSync(configsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const configs = files.map(f => {
          const name = f.replace(/\.(yaml|yml)$/, '');
          const filePath = path.join(configsDir, f);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = yaml.load(content) as any;
            return {
              name,
              description: parsed?.description || null,
              agents: parsed?.agents?.length || 0
            };
          } catch {
            return { name, description: null, agents: 0 };
          }
        });
        return { ok: true, result: { configs } };
      }

      case 'registry': {
        // /registry - show default registry
        // /registry push - push agents to registry
        // /registry pull <ids> - pull agents from registry
        // /registry set <chainId> <address> - set default registry
        // /registry set-registrar <address> - set registrar
        const subCmd = args[0];

        if (!subCmd) {
          // Show default registry
          const chainId = process.env.REGISTRY_CHAIN_ID || '11155111';
          const registryAddress = process.env.REGISTRY_ADDRESS || '';
          const registrarAddress = process.env.REGISTRAR_ADDRESS || '';
          return {
            ok: true,
            result: {
              chainId,
              registryAddress: registryAddress || '(not set)',
              registrarAddress: registrarAddress || '(not set)'
            }
          };
        }

        if (subCmd === 'push') {
          // Push all unregistered agents to registry
          const agents = await this.dbListAgents(teamId);
          const unregistered = agents.filter(a => !a.token_id && a.type === 'claude');
          const results: { name: string; tokenId?: string; domain?: string; error?: string }[] = [];

          for (const agent of unregistered) {
            try {
              const regResult = await this.registerOnchainAndUpdateAgent(teamId, agent);
              results.push({ name: agent.name, tokenId: regResult.tokenId, domain: regResult.domain });
            } catch (err: any) {
              results.push({ name: agent.name, error: err.message });
            }
          }

          return { ok: true, result: { registered: results } };
        }

        if (subCmd === 'pull') {
          const agentIds = args.slice(1).join(' ').split(/[\s,]+/).filter(Boolean);
          if (agentIds.length === 0) {
            return { ok: false, error: 'Usage: /registry pull <agent-ids>' };
          }
          // This would need the actual registry pull implementation
          return { ok: false, error: 'Registry pull not yet implemented in remote endpoint' };
        }

        if (subCmd === 'set') {
          return { ok: false, error: 'Registry set requires environment variable changes (REGISTRY_CHAIN_ID, REGISTRY_ADDRESS)' };
        }

        if (subCmd === 'set-registrar') {
          return { ok: false, error: 'Registry set-registrar requires environment variable changes (REGISTRAR_ADDRESS)' };
        }

        return { ok: false, error: 'Usage: /registry [push|pull <ids>]' };
      }

      case 'teams': {
        // List all teams
        const teams = await this.db.pool.query(
          `SELECT id, name, created_at FROM teams ORDER BY created_at DESC`
        );
        const teamList = await Promise.all(
          teams.rows.map(async (team: any) => {
            const agentCount = await this.db.pool.query<{ count: string }>(
              'SELECT COUNT(*)::text as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
              [team.id]
            );
            return {
              id: team.id,
              name: team.name,
              agentCount: parseInt(agentCount.rows[0]?.count || '0')
            };
          })
        );
        return { ok: true, result: { teams: teamList } };
      }

      case 'team': {
        // /team - show current team (from header)
        const team = await this.db.pool.query(
          `SELECT id, name FROM teams WHERE id = $1`,
          [teamId]
        );
        if (team.rows.length === 0) {
          return { ok: false, error: 'Team not found' };
        }
        const t = team.rows[0];
        const agentCount = await this.db.pool.query<{ count: string }>(
          'SELECT COUNT(*)::text as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
          [teamId]
        );
        return {
          ok: true,
          result: {
            id: t.id,
            name: t.name,
            agentCount: parseInt(agentCount.rows[0]?.count || '0')
          }
        };
      }

      case 'meta': {
        // /meta <agent> - show metadata
        // /meta set <agent> <key> <value> - set metadata key
        // /meta setid <agent> <domain> [tokenId] - set agent identity
        const subCmd = args[0];

        if (subCmd === 'set') {
          const agentName = args[1];
          const key = args[2];
          const value = args.slice(3).join(' ');
          if (!agentName || !key) {
            return { ok: false, error: 'Usage: /meta set <agent> <key> <value>' };
          }
          const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
          if (!agent) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          const newMetadata = { ...(agent.metadata || {}), [key]: value || null };
          // When setting 'endpoint', also update the endpoint column (used for routing)
          if (key === 'endpoint') {
            await this.db.pool.query(
              `UPDATE agents SET metadata = $3, endpoint = $4 WHERE team_id = $1 AND id = $2`,
              [teamId, agent.id, newMetadata, value || null]
            );
          } else {
            await this.db.pool.query(
              `UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`,
              [teamId, agent.id, newMetadata]
            );
          }
          return { ok: true, result: { name: agent.name, metadata: newMetadata } };
        }

        if (subCmd === 'setid') {
          const agentName = args[1];
          const domainArg = args[2];
          const tokenIdArg = args[3];
          if (!agentName || !domainArg) {
            return { ok: false, error: 'Usage: /meta setid <agent> <domain> [tokenId]' };
          }
          const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
          if (!agent) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          await this.db.pool.query(
            `UPDATE agents SET domain = $3, token_id = $4 WHERE team_id = $1 AND id = $2`,
            [teamId, agent.id, domainArg, tokenIdArg || null]
          );
          return { ok: true, result: { name: agent.name, domain: domainArg, tokenId: tokenIdArg || null } };
        }

        // /meta <agent> - show metadata
        const agentName = subCmd;
        if (!agentName) {
          return { ok: false, error: 'Usage: /meta <agent> or /meta set <agent> <key> <value>' };
        }
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        return {
          ok: true,
          result: {
            name: agent.name,
            id: agent.id,
            tokenId: agent.token_id,
            domain: agent.domain,
            metadata: agent.metadata
          }
        };
      }

      case 'cancel': {
        // /cancel <agent> - Cancel running query
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /cancel <agent-name>' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }

        const agent = matches[0];
        const baseEndpoint = agent.endpoint || `http://localhost:${agent.port}`;

        try {
          const cancelResp = await fetch(`${baseEndpoint}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!cancelResp.ok) {
            const err = await cancelResp.text();
            return { ok: false, error: `Cancel failed: ${err}` };
          }

          const result = await cancelResp.json() as any;
          return { ok: true, result: { agent: agent.name, ...result } };
        } catch (err: any) {
          return { ok: false, error: `Failed to cancel: ${err.message}` };
        }
      }

      case 'clear': {
        // /clear <agent> - Clear agent session
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /clear <agent-name>' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }

        const agent = matches[0];
        const baseEndpoint = agent.endpoint || `http://localhost:${agent.port}`;

        try {
          const clearResp = await fetch(`${baseEndpoint}/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!clearResp.ok) {
            const err = await clearResp.text();
            return { ok: false, error: `Clear failed: ${err}` };
          }

          return { ok: true, result: { agent: agent.name, message: 'Session cleared' } };
        } catch (err: any) {
          return { ok: false, error: `Failed to clear session: ${err.message}` };
        }
      }

      case 'list': {
        // /list - Show all pending queries
        const result = await this.db.pool.query(
          `SELECT id, query_id, type, message, timestamp, data
           FROM news_items
           WHERE team_id = $1 AND type IN ('query', 'query.pending', 'pending_question')
           ORDER BY timestamp DESC
           LIMIT 50`,
          [teamId]
        );

        return {
          ok: true,
          result: {
            queries: result.rows.map((r: any) => ({
              id: r.query_id || r.id,
              type: r.type,
              message: r.message,
              timestamp: Number(r.timestamp),
              from: r.data?.from
            }))
          }
        };
      }

      case 'update': {
        // /update <agent> --wallet <address> --name <newname>
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /update <agent> [--wallet <address>] [--name <newname>]' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }
        const agent = matches[0];
        const updates: string[] = [];
        const newMetadata = { ...agent.metadata };

        // Parse --wallet and --name flags
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--wallet' && args[i + 1]) {
            const walletAddr = args[i + 1];
            newMetadata.ows_address = walletAddr;
            updates.push(`wallet → ${walletAddr}`);
            i++;
          } else if (args[i] === '--name' && args[i + 1]) {
            const newName = args[i + 1];
            await this.db.pool.query(
              `UPDATE agents SET name = $3 WHERE team_id = $1 AND id = $2`,
              [teamId, agent.id, newName]
            );
            newMetadata.alias = newMetadata.alias || agent.name;
            updates.push(`name → ${newName}`);
            i++;
          }
        }

        if (updates.length === 0) {
          return { ok: false, error: 'Nothing to update. Use --wallet <address> or --name <newname>' };
        }

        await this.db.pool.query(
          `UPDATE agents SET metadata = $3 WHERE team_id = $1 AND id = $2`,
          [teamId, agent.id, newMetadata]
        );

        return { ok: true, result: { message: `Updated ${agent.name}: ${updates.join(', ')}` } };
      }

      default:
        return { ok: false, error: `Unknown command: ${action}. Available: agents, status, delete, ask, hey, news, register, deploy, agent, model, tasks, task, configs, registry, teams, team, keys, meta, pay, heartbeat, heartbeats, cancel, clear, list, update, sync-wallets` };
    }
  }

  /**
   * Get health info for an agent to include in API responses.
   */
  private getHealthForAgent(a: AgentRow): { health: string; lastHealthCheck: number | null } {
    const key = `${a.team_id}:${a.id}`;
    const h = this.healthStatus.get(key);
    if (!h) return { health: 'unknown', lastHealthCheck: null };
    return { health: h.status, lastHealthCheck: h.lastCheck };
  }

  /**
   * Start periodic health monitoring of all running agents (every 30s).
   */
  private startHealthMonitor(): void {
    // Run immediately, then every 30 seconds
    this.runHealthChecks();
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30_000);
  }

  private async runHealthChecks(): Promise<void> {
    try {
      const teams = await this.db.pool.query(`SELECT id FROM teams`);
      for (const team of teams.rows) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          // Skip virtual agents — they don't have a local /health endpoint
          if (agent.type === 'virtual') continue;

          const key = this.key(team.id, agent.id);
          const agentUrl = agent.type === 'interactive' ? agent.endpoint : `http://localhost:${agent.port}`;

          if (!agentUrl) {
            this.healthStatus.set(key, { status: 'unknown', lastCheck: Date.now() });
            continue;
          }

          try {
            const resp = await fetch(`${agentUrl}/health`, {
              signal: AbortSignal.timeout(3000)
            });
            const isOnline = resp.ok;
            this.healthStatus.set(key, { status: isOnline ? 'online' : 'offline', lastCheck: Date.now() });

            // Update DB status if it changed
            if (isOnline && agent.status === 'offline') {
              await this.db.pool.query(
                `UPDATE agents SET status = 'running' WHERE team_id = $1 AND id = $2`,
                [team.id, agent.id]
              );
            } else if (!isOnline && agent.status === 'running') {
              await this.db.pool.query(
                `UPDATE agents SET status = 'offline' WHERE team_id = $1 AND id = $2`,
                [team.id, agent.id]
              );
            }
          } catch {
            this.healthStatus.set(key, { status: 'offline', lastCheck: Date.now() });
            if (agent.status === 'running') {
              await this.db.pool.query(
                `UPDATE agents SET status = 'offline' WHERE team_id = $1 AND id = $2`,
                [team.id, agent.id]
              ).catch(() => {});
            }
          }
        }
      }
    } catch (err: any) {
      // Don't crash the interval on transient DB errors
    }
  }

  async start(port: number = 4100): Promise<void> {
    return new Promise((resolve) => {
      // Create HTTP server from Express app
      this.httpServer = createHttpServer(this.managementApp);

      // Create WebSocket server attached to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

      this.wss.on('connection', (ws, req) => {
        this.handleWebSocketConnection(ws, req);
      });

      this.httpServer.listen(port, async () => {
        console.log(`\n🚀 ID Agent Manager (DB-backed)`);
        console.log(`===============================`);
        console.log(`Management API: http://localhost:${port}`);
        console.log(`WebSocket: ws://localhost:${port}/ws`);
        console.log(`\n`);

        // Start heartbeats for all running agents with heartbeat enabled across all teams
        this.initAllHeartbeats();

        // Start periodic health monitoring (every 30s)
        this.startHealthMonitor();

        resolve();
      });
    });
  }

  /**
   * Initialize heartbeats for all running agents with heartbeat enabled across all teams
   */
  private async initAllHeartbeats(): Promise<void> {
    try {
      const teams = await this.db.pool.query(`SELECT id FROM teams`);
      for (const team of teams.rows) {
        await this.startAgentHeartbeats(team.id);
      }
    } catch (error: any) {
      console.log(`[Heartbeat] Error initializing: ${error.message}`);
    }
  }

  /**
   * Handle a new WebSocket connection
   */
  private async handleWebSocketConnection(ws: WebSocket, req: any) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const apiKey = url.searchParams.get('apiKey') || req.headers['x-api-key'];
    const teamHeader = req.headers['x-id-team'] || req.headers['x-id-project'] || url.searchParams.get('team');

    // Authenticate
    const controlApiKey = process.env.ID_CONTROL_API_KEY;
    const agentApiKey = process.env.ID_AGENT_API_KEY;

    if (controlApiKey && !safeCompare(apiKey, controlApiKey) && !safeCompare(apiKey, agentApiKey)) {
      ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
      ws.close(1008, 'Unauthorized');
      return;
    }

    // Resolve team
    let teamId: string;
    let teamName: string;
    if (teamHeader) {
      teamName = String(teamHeader);
      teamId = await getOrCreateTeamId(this.db, teamName);
    } else {
      teamName = process.env.ID_TEAM || 'default';
      teamId = await getOrCreateTeamId(this.db, teamName);
    }

    const client: WSClient = { ws, teamId, teamName, authenticated: true };
    this.wsClients.add(client);

    console.log(`[WS] Client connected (team: ${teamName})`);

    ws.send(JSON.stringify({
      type: 'connected',
      team: teamName,
      timestamp: Date.now()
    }));

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleWebSocketMessage(client, message);
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    });

    ws.on('close', () => {
      this.wsClients.delete(client);
      console.log(`[WS] Client disconnected (team: ${teamName})`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error for client (team: ${teamName}):`, err.message);
      this.wsClients.delete(client);
    });
  }

  /**
   * Handle an incoming WebSocket message
   */
  private async handleWebSocketMessage(client: WSClient, message: any) {
    const { type, command, ...rest } = message;

    switch (type) {
      case 'command': {
        // Execute a CLI-style command (reuse /remote logic)
        if (!command || typeof command !== 'string') {
          client.ws.send(JSON.stringify({ type: 'error', error: 'Missing command' }));
          return;
        }
        const result = await this.executeRemoteCommand(command.trim(), client.teamId, client.teamName);
        client.ws.send(JSON.stringify({ type: 'result', command, ...result }));
        break;
      }

      case 'ping': {
        client.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      }

      default: {
        client.ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${type}` }));
      }
    }
  }

  /**
   * Broadcast a news item to all connected WebSocket clients for a team
   */
  broadcastNews(teamId: string, newsItem: { type: string; from?: string; message?: string; in_reply_to?: string; data?: any; timestamp: number }) {
    for (const client of this.wsClients) {
      if (client.teamId === teamId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'news',
          newsType: newsItem.type,
          from: newsItem.from,
          message: newsItem.message,
          in_reply_to: newsItem.in_reply_to,
          data: newsItem.data,
          timestamp: newsItem.timestamp
        }));
      }
    }
  }

  // ==================== Heartbeat System ====================

  /**
   * Read heartbeat config from agent's working directory HEARTBEAT.yaml file
   */
  private readHeartbeatConfig(workingDirectory: string): HeartbeatConfig | null {
    const heartbeatPath = path.join(workingDirectory, 'HEARTBEAT.yaml');
    if (!existsSync(heartbeatPath)) {
      return null;
    }
    try {
      const content = readFileSync(heartbeatPath, 'utf-8');
      const config = yaml.load(content) as { interval?: number; message?: string; maxBeats?: number; expiresAfter?: number };
      if (typeof config?.interval === 'number' && typeof config?.message === 'string') {
        return {
          interval: config.interval,
          message: config.message.trim(),
          ...(typeof config.maxBeats === 'number' && { maxBeats: config.maxBeats }),
          ...(typeof config.expiresAfter === 'number' && { expiresAfter: config.expiresAfter })
        };
      }
      return null;
    } catch (error: any) {
      console.log(`[Heartbeat] Error reading ${heartbeatPath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Start heartbeat timers for all agents with heartbeat enabled in a team
   */
  async startAgentHeartbeats(teamId: string): Promise<void> {
    // Query for agents with heartbeat enabled (metadata.heartbeat = true)
    const result = await this.db.pool.query(
      `SELECT id, name, working_directory FROM agents WHERE team_id = $1 AND status = 'running' AND metadata->>'heartbeat' = 'true'`,
      [teamId]
    );

    for (const row of result.rows) {
      const config = this.readHeartbeatConfig(row.working_directory);
      if (config) {
        this.startHeartbeatForAgent(teamId, row.id, row.name, row.working_directory, config.interval);
      }
    }

    if (result.rows.length > 0) {
      console.log(`[Heartbeat] Started heartbeats for ${result.rows.length} agent(s)`);
    }
  }

  /**
   * Start heartbeat timer for an agent
   * @param intervalSeconds Interval in seconds between heartbeats
   */
  private startHeartbeatForAgent(teamId: string, agentId: string, agentName: string, workingDirectory: string, intervalSeconds: number): void {
    const intervalMs = intervalSeconds * 1000;

    // Clear existing timer if any
    const existingTimer = this.heartbeatTimers.get(agentId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    // Send initial heartbeat after a short delay (give agent time to initialize)
    setTimeout(() => {
      this.sendHeartbeat(teamId, agentId, agentName, workingDirectory);
    }, 30 * 1000); // 30 seconds after start

    // Set up recurring heartbeat
    const timer = setInterval(() => {
      this.sendHeartbeat(teamId, agentId, agentName, workingDirectory);
    }, intervalMs);

    this.heartbeatTimers.set(agentId, timer);
    this.heartbeatIntervals.set(agentId, intervalMs);
    this.heartbeatLastSent.set(agentId, Date.now()); // Track start time
    this.heartbeatCounts.set(agentId, 0);
    this.heartbeatStartTimes.set(agentId, Date.now());
    console.log(`[Heartbeat] Timer started for ${agentName} (${agentId}), interval: ${intervalSeconds}s`);
  }

  /**
   * Stop heartbeat timer for an agent
   */
  stopHeartbeatForAgent(agentId: string): void {
    const timer = this.heartbeatTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(agentId);
      this.heartbeatLastSent.delete(agentId);
      this.heartbeatIntervals.delete(agentId);
      this.heartbeatCounts.delete(agentId);
      this.heartbeatStartTimes.delete(agentId);
      console.log(`[Heartbeat] Timer stopped for ${agentId}`);
    }
  }

  /**
   * Cancel all pending/processing queries for an agent when it stops.
   * This prevents orphaned queries from showing up in status.
   */
  async cancelPendingQueriesForAgent(teamId: string, agentId: string): Promise<number> {
    try {
      const ts = Date.now();

      // Find all pending/processing queries for this agent
      const pendingQueries = await this.db.pool.query<{ query_id: string }>(
        `SELECT query_id FROM queries
         WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')`,
        [teamId, agentId]
      );

      if (pendingQueries.rows.length === 0) {
        return 0;
      }

      const queryIds = pendingQueries.rows.map(r => r.query_id);

      // Update queries to cancelled status
      await this.db.pool.query(
        `UPDATE queries SET status = 'cancelled', completed = $3
         WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')`,
        [teamId, agentId, ts]
      );

      // Add query.cancelled news items for each
      for (const queryId of queryIds) {
        await this.db.pool.query(
          `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id)
           VALUES ($1, $2, $3, 'query.cancelled', 'Query cancelled (agent stopped)', $4, $5)`,
          [teamId, agentId, ts, { reason: 'agent_stopped', query_id: queryId }, queryId]
        );
      }

      console.log(`[Manager] Cancelled ${queryIds.length} pending queries for agent ${agentId}`);
      return queryIds.length;
    } catch (err) {
      console.error(`[Manager] Error cancelling queries for agent ${agentId}:`, err);
      return 0;
    }
  }

  /**
   * Check if the OWS (Open Wallet Standard) CLI is installed and on PATH.
   */
  private checkOwsInstalled(): boolean {
    try {
      execFileSync('ows', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get or create an OWS wallet for an agent.
   * Returns { walletName, address } or null if OWS is not installed or creation fails.
   */
  private getOrCreateAgentWallet(team: string, agentName: string): { walletName: string; address: string } | null {
    if (!this.checkOwsInstalled()) return null;
    const walletName = `${team}-${agentName}`;
    try {
      // Check if wallet exists by parsing `ows wallet list` output
      const listOutput = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      let found = false;
      let ethAddress = '';
      let inWallet = false;
      for (const line of listOutput.split('\n')) {
        if (line.includes('Name:') && line.includes(walletName)) {
          inWallet = true;
          found = true;
          continue;
        }
        if (inWallet && line.includes('Name:')) break;
        if (inWallet) {
          const match = line.trim().match(/^eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
          if (match) ethAddress = match[1];
        }
      }
      if (found && ethAddress) {
        console.log(`[OWS] Found existing wallet "${walletName}": ${ethAddress}`);
        return { walletName, address: ethAddress };
      }
    } catch {
      // ows wallet list failed, try creating
    }
    try {
      const output = execFileSync('ows', ['wallet', 'create', '--name', walletName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      // Parse EVM address from create output
      for (const line of output.split('\n')) {
        const match = line.trim().match(/eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
        if (match) {
          console.log(`[OWS] Created wallet "${walletName}": ${match[1]}`);
          return { walletName, address: match[1] };
        }
      }
      console.log(`[OWS] Created wallet "${walletName}" (no EVM address found in output)`);
      return { walletName, address: '' };
    } catch (err: any) {
      console.warn(`[OWS] Failed to create wallet "${walletName}": ${err.message}`);
      return null;
    }
  }

  /**
   * Spawn a local agent process on the server.
   * Used by executeRemoteCommand to start agents server-side.
   */
  private async spawnLocalAgentProcess(
    teamId: string,
    teamName: string,
    agentData: { name: string; id: string; port: number; model?: string; workingDirectory?: string; tokenId?: string; address?: string }
  ): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
    try {
      const scriptPath = path.resolve(__dirname, 'local-agent-server.js');
      const { name, id, port, model, workingDirectory, tokenId, address } = agentData;

      // Kill any existing process on this port
      await this.killAgentProcess(port);
      await new Promise(r => setTimeout(r, 500));

      // Build command arguments
      const spawnArgs = [
        scriptPath,
        name,
        '--team', teamName,
        '--port', String(port),
        '--id', id
      ];
      if (workingDirectory) {
        spawnArgs.push('--dir', workingDirectory);
      }

      // Set environment
      // Look up OWS wallet name from agent metadata
      const agentRow = await this.dbQueryAgentById(teamId, id);
      const owsWallet = (agentRow?.metadata as any)?.ows_wallet || null;

      const localEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        ID_TEAM: teamName,
        MANAGER_URL: `http://localhost:4100`,
        ...(process.env.ID_AGENT_API_KEY && { ID_AGENT_API_KEY: process.env.ID_AGENT_API_KEY }),
        ...(process.env.ID_CONTROL_API_KEY && { ID_AGENT_API_KEY: process.env.ID_CONTROL_API_KEY }),
        ...(model && { CLAUDE_MODEL: model }),
        ...(tokenId && { ID_AGENT_TOKEN_ID: tokenId }),
        ...(owsWallet && { OWS_WALLET: owsWallet })
      };

      // Create log file
      const logFile = `/tmp/${name}.log`;
      const logFd = openSync(logFile, 'a');

      console.log(`[Manager] Spawning agent process: ${name} (port ${port}, id ${id})`);

      const proc = spawn('node', spawnArgs, {
        env: localEnv,
        stdio: ['ignore', logFd, logFd],
        detached: true
      });

      proc.unref();
      closeSync(logFd);

      console.log(`[Manager] Agent ${name} spawned with PID ${proc.pid}`);
      return { success: true, pid: proc.pid, logFile };
    } catch (err: any) {
      console.error(`[Manager] Failed to spawn agent ${agentData.name}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Update or create a CLAUDE.md file with the agent's identity.
   * Replaces any existing identity section to prevent duplicates.
   */
  private updateClaudeMdIdentity(claudeMdPath: string, identityName: string): void {
    const identitySection = `# Your Identity\n\nYou are **${identityName}** - always use this full name when introducing yourself or signing messages.\n`;
    let existingContent = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : '';
    // Strip any existing identity sections to prevent duplicates
    existingContent = existingContent.replace(/# Your Identity\n\nYou are \*\*[^*]+\*\*[^\n]*\n+/g, '').replace(/^\n+/, '');
    writeFileSync(claudeMdPath, identitySection + (existingContent ? '\n' + existingContent : ''));
  }

  /**
   * Kill the agent process running on a given port.
   */
  private async killAgentProcess(port: number): Promise<{ killed: boolean; pids: number[] }> {
    if (!port) return { killed: false, pids: [] };
    try {
      const lsofOutput = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (lsofOutput) {
        const pids = lsofOutput.split('\n').filter(Boolean).map(p => parseInt(p));
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            console.log(`[Manager] Killed process PID ${pid} on port ${port}`);
          } catch {
            // Process may have already exited
          }
        }
        return { killed: true, pids };
      }
    } catch {
      // No process on port
    }
    return { killed: false, pids: [] };
  }

  /**
   * Send a heartbeat message to an agent
   * Message is read from agent's HEARTBEAT.yaml file (allows runtime editing)
   */
  private async sendHeartbeat(teamId: string, agentId: string, agentName: string, workingDirectory: string): Promise<void> {
    try {
      // Get agent status and endpoint
      const agent = await this.db.pool.query(
        `SELECT status, endpoint FROM agents WHERE team_id = $1 AND id = $2`,
        [teamId, agentId]
      );

      if (agent.rows.length === 0 || agent.rows[0].status !== 'running') {
        console.log(`[Heartbeat] Agent ${agentName} not running, stopping heartbeat`);
        this.stopHeartbeatForAgent(agentId);
        return;
      }

      const endpoint = agent.rows[0].endpoint;
      if (!endpoint) {
        console.log(`[Heartbeat] Agent ${agentName} has no endpoint`);
        return;
      }

      // Read message from HEARTBEAT.yaml file (allows runtime editing)
      const config = this.readHeartbeatConfig(workingDirectory);
      if (!config?.message) {
        console.log(`[Heartbeat] Agent ${agentName} has no HEARTBEAT.yaml or invalid config`);
        return;
      }

      // Check heartbeat limits
      const beatCount = (this.heartbeatCounts.get(agentId) || 0);
      const startTime = this.heartbeatStartTimes.get(agentId) || Date.now();
      const maxBeats = config.maxBeats ?? 20; // Default: 20 beats
      const expiresAfter = config.expiresAfter ?? 7200; // Default: 2 hours (in seconds)

      if (beatCount >= maxBeats) {
        console.log(`[Heartbeat] Agent ${agentName} reached max beats (${maxBeats}), stopping`);
        this.stopHeartbeatForAgent(agentId);
        return;
      }

      const elapsedSeconds = (Date.now() - startTime) / 1000;
      if (elapsedSeconds >= expiresAfter) {
        console.log(`[Heartbeat] Agent ${agentName} heartbeat expired after ${Math.round(elapsedSeconds / 60)}m, stopping`);
        this.stopHeartbeatForAgent(agentId);
        return;
      }

      // Send message via /talk endpoint
      const response = await fetch(`${endpoint}/talk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.ID_AGENT_API_KEY && { 'X-Api-Key': process.env.ID_AGENT_API_KEY })
        },
        body: JSON.stringify({
          from: 'manager',
          message: config.message
        })
      });

      if (response.ok) {
        this.heartbeatLastSent.set(agentId, Date.now());
        this.heartbeatCounts.set(agentId, beatCount + 1);
        console.log(`[Heartbeat] Sent to ${agentName} (beat ${beatCount + 1}/${maxBeats})`);
      } else {
        console.log(`[Heartbeat] Failed to send to ${agentName}: ${response.status}`);
      }
    } catch (error: any) {
      console.log(`[Heartbeat] Error sending to ${agentName}: ${error.message}`);
    }
  }

  /**
   * Stop all heartbeat timers
   */
  stopAllHeartbeats(): void {
    for (const [agentId, timer] of this.heartbeatTimers) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    console.log(`[Heartbeat] All timers stopped`);
  }
}

