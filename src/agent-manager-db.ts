// SPDX-License-Identifier: MIT
/**
 * Agent Manager (DB-backed)
 *
 * Persistent manager that stores agents/metadata in Postgres with multi-network scoping.
 * Runtime (live HTTP servers) still live in-memory, but all durable state is in the DB.
 *
 * Wallet management: agents no longer have individual wallets stored in the DB.
 * Onchain operations use either an OWS wallet (OWS_REGISTRAR_WALLET) or raw key (PRIVATE_KEY).
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
import { AgentRestServer } from './agent-rest-server.js';
import { registerOnIdChain, createSubnameOnIdChain, setMultiChainAddresses } from './onchain/idchain-register.js';
import { defaultDeliverFn, redactSshTarget, type DeliverFn } from './lib/ssh-deliver.js';
import { probeRemoteAgent, defaultHealthProbeFn, type HealthProbeFn } from './lib/remote-heartbeat.js';
import { filterClaudeEnvVars } from './lib/env-hygiene.js';
import { sweepOrphanAgents, listMatchingProcesses } from './lib/orphan-sweep.js';
import {
  agentDoneAuthConfigFromEnv,
  authenticateAgentDone,
} from './lib/agent-done-auth.js';
import { type Db } from './db/db-service.js';
import type { AgentRow, ScheduleDefinitionRow, TaskRow } from './db/types.js';
import fetch from 'node-fetch';
import type { PluginConfig, DeployConfig, HeartbeatConfig, CalendarSpec, ScheduleDeliveryMode } from './config-parser.js';
import {
  processConfig,
  copyAgentDirOverlay,
  copyHeartbeatMd,
  copyLibraryAgentOverlay,
  appendLibraryPersonaToAgentsMd,
  writePersonalityFile,
} from './config-parser.js';
import {
  getLibraryAgent,
  getLibrarySkill,
  listLibraryAgents,
  listLibrarySkills,
  resolveDefaultLibraryRoot,
} from './lib/library-inventory.js';
import { PROTOCOL_DEFAULTS } from './protocol-defaults.js';
import { computeSyncPlan, formatSyncSummary, formatSyncVerbose } from './sync.js';
import { validateName } from './name-validation.js';
import { checkCursorFallbackHealth } from './harness/cursor-fallback-health.js';
import {
  emitQueryDelivered,
  emitQueryExpired,
  emitQueryFailed,
  emitTaskClaimed,
  emitTaskCompleted,
  recordCheckinCreated,
} from './wakeup-service/event-producer.js';
import { RetentionService } from './wakeup-service/retention.js';
import { CheckinService } from './checkins/checkin-service.js';
import {
  DEFAULT_CLOSE_WHEN,
  DEFAULT_INTERVAL_SECONDS,
  buildCheckinResponse,
  clampNote,
  generateCheckinId,
  isValidPriority,
  parseDurationSeconds,
  parseStatusFilter,
} from './checkins/checkin-api-helpers.js';
import { closeLinkedCheckinsForTerminalTask } from './checkins/checkin-autoclose.js';
import type { CheckinRow } from './db/types.js';
import { parseAgentRef, normalizeAlias, buildAmbiguityWarning, type AgentMatch } from './core/agent-identifier.js';
import { resolveNewsTrigger } from './core/messaging-service.js';
import type { HarnessType } from './harness/types.js';
import { SchedulerService } from './scheduling/scheduler-service.js';
import { SchedulerHandle, parseGatewayMode } from './dispatch-scheduler/manager-integration.js';
import {
  parseDispatchCanonicalMode,
  type DispatchCanonicalMode,
} from './dispatch-scheduler/policy.js';
import {
  parseDispatchReadStatus,
  parseReadLimit,
  readArtifacts,
  readDispatchById,
  readDispatchHealth,
  readDispatches,
  readReconciliation,
} from './dispatch-scheduler/read-model.js';
import {
  parsePromotionEnforcement,
  validatePromotionMetadata,
  type PromotionAgentDone,
  type FailureKind,
} from './dispatch-scheduler/types.js';
import type { SqliteAdapter } from './db/sqlite-adapter.js';
import { DispatchVerificationStorage } from './dispatch-verification/storage.js';
import { DispatchVerificationJob, jobConfigFromEnv } from './dispatch-verification/job.js';
import {
  DispatchRecoveryService,
  recoveryConfigFromEnv,
  type DispatchRecoveryReactor,
} from './dispatch-recovery/service.js';
import { DEFAULT_RECOVERY_CONFIG } from './dispatch-recovery/classifier.js';
import { makeGitCommitEvidenceProbe } from './dispatch-recovery/git-commit-evidence.js';
import {
  getAgentsEffectiveness,
  getAgentDispatches,
  type RosterEntry,
} from './dispatch-verification/routes.js';
import { heartbeatToSchedule, calendarToSchedule, validateIntervalSeconds, HEARTBEAT_GENERIC_MESSAGE } from './scheduling/schedule-config.js';
import {
  getAvailableRuntimes,
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimePaths,
  isRemoteEndpointRuntime,
  isRuntimeId,
  resolveRuntime,
  runtimeIssueHint,
  validateRuntimePreflight,
} from './runtime/registry.js';

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

/**
 * Spec 054 v2 (review fix): normalize a `dispatch_id` JSON input to a
 * non-empty string. The spec uses a numeric placeholder (`1234`) in its
 * example; the live scheduler key is a `phid:disp-...` string. We
 * accept both: finite numbers are coerced to their string form, then
 * resolved by the same phid/query_id paths the endpoint already uses.
 * Returns "" for everything else (booleans, objects, NaN, undefined),
 * which the endpoint handler treats as a 400.
 */
export function normalizeDispatchIdInput(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (typeof input === 'number' && Number.isFinite(input)) {
    return String(input);
  }
  return '';
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    tokens.push(value.replace(/\\(["'])/g, '$1'));
  }
  return tokens;
}

function normalizeConfigSkills(skills: unknown): string[] | undefined {
  if (!Array.isArray(skills)) return undefined;

  const normalized = Array.from(
    new Set(
      skills
        .filter((skill): skill is string => typeof skill === 'string')
        .map(skill => skill.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    ),
  );

  return normalized.length > 0 ? normalized : undefined;
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
    schedule?: string;
  } | Array<{
    path?: string;
    method?: string;
  }>;
  capabilities?: Array<{
    id: string;
    method: string;
    endpoint: string;
  }>;
}


/**
 * Wakeup-service topic aliases. The `GET /events` route accepts both
 * concrete topics (e.g. `query:delivered`) and the aliases below, which
 * expand server-side into their concrete topic set. Source of truth:
 * output/wakeup-service-design.md → "Topic set for v1" / "Alias expansions".
 */
const TOPIC_ALIASES: Record<string, readonly string[]> = {
  'query:terminal': ['query:delivered', 'query:failed', 'query:expired'],
  'task:status': ['task:created', 'task:claimed', 'task:completed'],
  'agent:lifecycle': ['agent:started', 'agent:stopped', 'agent:rebuild'],
};

function expandTopicAliases(topics: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of topics) {
    const expansion = TOPIC_ALIASES[t];
    if (expansion) {
      for (const concrete of expansion) out.add(concrete);
    } else {
      out.add(t);
    }
  }
  return Array.from(out);
}

/**
 * /talk-to auto-attach default cadence: 10 minutes. Tighter than the
 * generic checkin default (15m) because delegated work justifies more
 * frequent inspection on the dispatcher's side.
 */
const AUTO_ATTACH_DEFAULT_INTERVAL_SECONDS = 600;

interface AutoAttachFlagsResult {
  disabled: boolean;
  intervalSeconds: number | null;
  maxIterations: number | null;
  error?: string;
}

/**
 * Parse the three /talk-to auto-attach flags from the request body:
 *   - `no_checkin: true`           (--no-checkin)
 *   - `checkin: <duration|seconds>` (--checkin 30m / --checkin 1800)
 *   - `checkin_iters: <N>`          (--checkin-iters 5)
 *
 * Returns either a fully-resolved spec or an `error` code the route handler
 * can return as a 400 body. The returned `intervalSeconds` is null when
 * the caller did not override the default.
 */
function parseAutoAttachFlags(body: Record<string, unknown>): AutoAttachFlagsResult {
  const result: AutoAttachFlagsResult = {
    disabled: body.no_checkin === true,
    intervalSeconds: null,
    maxIterations: null,
  };

  if (body.checkin !== undefined && body.checkin !== null) {
    const parsed = parseDurationSeconds(body.checkin as unknown);
    if (parsed === null) {
      result.error = 'invalid_checkin_duration';
      return result;
    }
    result.intervalSeconds = parsed;
  }

  if (body.checkin_iters !== undefined && body.checkin_iters !== null) {
    const n = Number(body.checkin_iters);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      result.error = 'invalid_checkin_iters';
      return result;
    }
    result.maxIterations = n;
  }

  return result;
}

function makeAutoAttachError(status: number, code: string): Error & { status: number; code: string } {
  const err = new Error(code) as Error & { status: number; code: string };
  err.status = status;
  err.code = code;
  return err;
}

function getCatalogEndpoint(catalog: RestAPCatalog, key: 'talk' | 'news' | 'schedule'): string | null {
  if (catalog.endpoints && !Array.isArray(catalog.endpoints)) {
    return catalog.endpoints[key] || null;
  }
  if (Array.isArray(catalog.endpoints)) {
    const path = `/${key}`;
    const match = catalog.endpoints.find((entry) => entry.path === path);
    return match?.path || null;
  }
  return null;
}

// Cache for REST-AP catalogs (endpoint -> catalog)
const restapCatalogCache = new Map<string, { catalog: RestAPCatalog; fetchedAt: number }>();
const CATALOG_CACHE_TTL = 60000; // 1 minute cache

/**
 * Discover REST-AP endpoints from an agent's catalog
 * @param baseEndpoint The agent's base endpoint (e.g., http://localhost:4101)
 * @returns The discovered endpoints or defaults if catalog unavailable
 */
export async function discoverRestAPEndpoints(baseEndpoint: string): Promise<{ talk: string; news: string; schedule?: string | null }> {
  // After the manager-collapse refactor, "interactive" agents (e.g. manager-<team> rows)
  // have endpoint='' and port=0. A few caller paths fall back to `http://localhost:${port}`
  // which produces `http://localhost:0`, then catalog discovery fails noisily. Those rows
  // never had a per-agent HTTP server, so silently return defaults instead of fetching.
  if (!baseEndpoint || /:0(\/|$)/.test(baseEndpoint)) {
    return { talk: '/talk', news: '/news', schedule: null };
  }

  const now = Date.now();
  const cached = restapCatalogCache.get(baseEndpoint);

  // Return cached catalog if still valid
  if (cached && (now - cached.fetchedAt) < CATALOG_CACHE_TTL) {
    return {
      talk: getCatalogEndpoint(cached.catalog, 'talk') || '/talk',
      news: getCatalogEndpoint(cached.catalog, 'news') || '/news',
      schedule: getCatalogEndpoint(cached.catalog, 'schedule') || null
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
        talk: getCatalogEndpoint(catalog, 'talk') || '/talk',
        news: getCatalogEndpoint(catalog, 'news') || '/news',
        schedule: getCatalogEndpoint(catalog, 'schedule') || null
      };
    }
  } catch (err) {
    // Catalog fetch failed, use defaults
    console.log(`[REST-AP] Could not fetch catalog from ${baseEndpoint}: ${(err as Error).message}`);
  }

  // Default REST-AP endpoints
  return { talk: '/talk', news: '/news', schedule: null };
}

type AgentRegistryId = {
  chainId: number;
  registryAddress: string;
};

type AgentMetadata = Record<string, any> & {
  name?: string;
  service_type?: string;  // e.g., "REST-AP", "MCP", "A2A"
  service?: string;       // The service URL (e.g., https://idbot.live/{id})
  agent_account?: string;
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

interface ProcessInspection {
  pid: number;
  ppid: number | null;
  argv0: string;
  commandLine: string;
}

export class AgentManagerDb {
  private managementApp: express.Application;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private wsClients: Set<WSClient> = new Set();
  private baseWorkDir: string;
  private db: Db;
  private runningServers: Map<string, AgentRestServer> = new Map(); // key: `${teamId}:${agentId}`
  private agentRole: 'manager' | 'worker' = 'manager';
  private defaultConfig: DeployConfig['defaults'] | null = null;
  private schedulerService: SchedulerService | null = null;
  /**
   * Concurrency-aware Dispatch scheduler (separate from the cron/schedule
   * SchedulerService above). Bound to the `default` team in Phase A.
   * DISPATCH_GATEWAY_MODE=off bypasses; shadow logs but legacy path runs;
   * enforce makes the scheduler the only /talk caller for `default` team
   * inter-agent messages.
   */
  private dispatchScheduler: SchedulerHandle | null = null;
  // W2-1 DispatchVerification — durable projection + periodic verification job.
  // Both are constructed alongside the dispatch scheduler in start() (they share
  // the scheduler's SqliteAdapter + default team) and stay null until then.
  private dispatchVerificationStorage: DispatchVerificationStorage | null = null;
  private dispatchVerificationJob: DispatchVerificationJob | null = null;
  private dispatchRecoveryService: DispatchRecoveryService | null = null;
  // Task 10: cached canonical-mode flag, parsed once at startup. Exposed for
  // gateway code paths (legacy direct /talk) that need to emit observation
  // warnings under enforce, and for /system-live / tests to inspect.
  dispatchCanonicalMode: DispatchCanonicalMode = parseDispatchCanonicalMode(process.env);
  private queryWaiters: Map<string, QueryWaiter> = new Map(); // key: query_id
  // Long-poll waiters for GET /query/:id?wait=<seconds>. Wakes when a daemon-side
  // query write (news.in_reply_to completion, agent-stop cancel) transitions
  // the row. Sweeper-expired rows rely on the request's wait-timeout re-read.
  private queryStatusWaiters: Map<string, Set<() => void>> = new Map(); // key: `${teamId}:${queryId}`
  private healthStatus: Map<string, { status: 'online' | 'offline' | 'unknown'; lastCheck: number }> = new Map(); // key: `${teamId}:${agentId}`
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private remoteProbeInterval: NodeJS.Timeout | null = null;
  private querySweeperInterval: NodeJS.Timeout | null = null;
  private retentionService: RetentionService | null = null;
  private checkinService: CheckinService | null = null;
  private supervisorWatcher: { stop(): void } | null = null;
  /**
   * Stuck-query sweeper timeout, in minutes. Queries whose status is still
   * pending/processing this long after their `created` timestamp are assumed
   * to belong to a crashed agent and are marked 'expired'.
   * Starting conservatively at 15 minutes — if an agent is legitimately
   * working on something longer than this, the polling caller should be
   * treating it as abandoned anyway.
   */
  private readonly QUERY_EXPIRY_MINUTES = 15;
  private logBuffer: Array<{ ts: number; msg: string }> = [];
  private readonly LOG_BUFFER_SIZE = 500;
  private managementPort: number = 4100;
  /** Injectable SSH delivery function — override in tests. */
  private deliverFn: DeliverFn = defaultDeliverFn;
  /** Injectable onchain registration function — override in tests. */
  private registerOnIdChainFn: typeof registerOnIdChain = registerOnIdChain;
  /** Injectable HTTP probe function — override in tests to mock remote health checks. */
  private healthProbeFn: HealthProbeFn = defaultHealthProbeFn;
  /**
   * Library root used by the read-only `/library/*` endpoints. Captured at
   * construction so tests can override without touching process.env. Null
   * means "no library configured" — listings return empty, detail returns 404.
   */
  private libraryRoot: string | null;

  /** Log a manager activity message to the ring buffer (not stdout) */
  private managerLog(msg: string) {
    this.logBuffer.push({ ts: Date.now(), msg });
    if (this.logBuffer.length > this.LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
  }

  /**
   * N1.3: best-effort, non-blocking graph re-evaluation after a dispatch
   * lifecycle mutation. Fires and forgets — errors are logged, never thrown.
   */
  private evaluateGraphsForDispatchBestEffort(
    dispatchId: string,
    trigger: string,
  ): void {
    import('./graph/lifecycle-bridge.js').then(({ evaluateGraphsForDispatch }) => {
      const logger = {
        warn: (event: string, data: Record<string, unknown>) =>
          this.managerLog(`[graph-bridge] WARN ${event}: ${JSON.stringify(data)}`),
        info: (event: string, data: Record<string, unknown>) =>
          this.managerLog(`[graph-bridge] ${event}: ${JSON.stringify(data)}`),
      };
      evaluateGraphsForDispatch(this.db.adapter, dispatchId, trigger as any, { logger })
        .catch((err: unknown) => {
          this.managerLog(
            `[graph-bridge] unhandled error for ${dispatchId}/${trigger}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }).catch((err: unknown) => {
      this.managerLog(
        `[graph-bridge] import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * N1.4: best-effort, non-blocking graph re-evaluation after a task
   * lifecycle mutation (currently only `task_done`). Same safety bar as
   * the N1.3 dispatch bridge — errors are logged, never thrown, and
   * MUST NOT change the HTTP status of /tasks/:ref/done.
   */
  /**
   * Closes a task into status:done and runs the full cascade required
   * for downstream read-models to reflect the close immediately:
   *   1. Update the row (status + completed_at + updated_at) in one
   *      SQL UPDATE.
   *   2. Re-read the row so callers and emitted events always see the
   *      committed state, not the stale in-memory copy.
   *   3. Emit `task:completed` so any subscriber (checkin auto-close,
   *      news fan-out, downstream projections) flips at the same tick.
   *   4. Auto-close linked checkins.
   *   5. Best-effort graph re-evaluation (fire-and-forget; bridge
   *      errors never change the close outcome).
   *
   * Used by BOTH `POST /tasks/:ref/done` and the CLI `/task done`
   * (`POST /remote` body command) so the two close paths can never
   * diverge — every close emits the same events, every consumer's
   * projection sees the same terminal-state transition. Eliminates the
   * "task closed but checkin still firing / GET /tasks lagging because
   * /remote was used instead of /tasks/:ref/done" failure mode that
   * confused operator handoffs.
   *
   * @returns the freshly-read TaskRow in `status: 'done'`.
   */
  private async closeTaskAndCascade(opts: {
    task: TaskRow;
    teamId: string;
    actorAgentId: string | null;
  }): Promise<TaskRow> {
    const { task, teamId, actorAgentId } = opts;
    const nowSec = Math.floor(Date.now() / 1000);
    await this.db.tasks.updateFields(task.id, {
      status: 'done',
      completed_at: nowSec,
      updated_at: nowSec,
    });
    const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
    if (!updated) {
      // updateFields succeeded against `task.id` but the re-read missed
      // the row — only possible under a concurrent DELETE. Surface to
      // the caller as the pre-update row so the response still echoes
      // the user-supplied close.
      return { ...task, status: 'done', completed_at: nowSec, updated_at: nowSec };
    }
    const occurredAtMs = Date.now();
    await emitTaskCompleted(this.db.events, {
      teamId,
      taskUuid: updated.uuid,
      taskName: updated.name,
      title: updated.title,
      ownerAgentId: updated.owner ?? null,
      actorAgentId: actorAgentId ?? updated.owner ?? null,
      occurredAt: occurredAtMs,
    });
    await closeLinkedCheckinsForTerminalTask(this.db, {
      teamId,
      taskId: updated.id,
      taskStatus: updated.status,
      actorAgentId: actorAgentId ?? updated.owner ?? null,
      occurredAt: occurredAtMs,
    });
    this.evaluateGraphsForTaskBestEffort(updated.id, 'task_done');
    return updated;
  }

  private evaluateGraphsForTaskBestEffort(
    taskId: string,
    trigger: 'task_done',
  ): void {
    import('./graph/lifecycle-bridge.js').then(({ evaluateGraphsForTask }) => {
      const logger = {
        warn: (event: string, data: Record<string, unknown>) =>
          this.managerLog(`[graph-bridge] WARN ${event}: ${JSON.stringify(data)}`),
        info: (event: string, data: Record<string, unknown>) =>
          this.managerLog(`[graph-bridge] ${event}: ${JSON.stringify(data)}`),
      };
      evaluateGraphsForTask(this.db.adapter, taskId, trigger, { logger })
        .catch((err: unknown) => {
          this.managerLog(
            `[graph-bridge] unhandled error for task ${taskId}/${trigger}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }).catch((err: unknown) => {
      this.managerLog(
        `[graph-bridge] import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  constructor(
    baseWorkDir: string = '/workspace',
    db: Db,
    opts?: {
      /** Override SSH delivery function (for tests). */
      deliverFn?: DeliverFn;
      /** Override onchain registration function (for tests). */
      registerOnIdChainFn?: typeof registerOnIdChain;
      /** Override remote health probe function (for tests). */
      healthProbeFn?: HealthProbeFn;
      /**
       * Override library root for the `/library/*` endpoints. Pass an
       * absolute path to serve a specific library, or `null` to force
       * empty-library behavior. When undefined, resolution falls back to
       * the default (`ID_LIBRARY_ROOT` env, else `<cwd>/configs`, else null).
       */
      libraryRoot?: string | null;
    },
  ) {
    this.baseWorkDir = baseWorkDir;
    this.db = db;
    if (opts?.deliverFn) this.deliverFn = opts.deliverFn;
    if (opts?.registerOnIdChainFn) this.registerOnIdChainFn = opts.registerOnIdChainFn;
    if (opts?.healthProbeFn) this.healthProbeFn = opts.healthProbeFn;
    this.libraryRoot =
      opts && Object.prototype.hasOwnProperty.call(opts, 'libraryRoot')
        ? (opts.libraryRoot ?? null)
        : resolveDefaultLibraryRoot();
    this.agentRole = (process.env.AGENT_ROLE as 'manager' | 'worker') || 'manager';

    // Load default deployment config
    this.loadDefaultConfig();

    this.managementApp = express();
    this.managementApp.use(express.json());

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
    return getDefaultModelForRuntime(getDefaultRuntime(), this.defaultConfig?.model);
  }

  private ensureRuntimeReady(runtime: HarnessType | string | undefined, model?: string): void {
    const issues = validateRuntimePreflight(runtime, model);
    if (issues.length > 0) {
      throw new Error(issues.map(issue => runtimeIssueHint(issue.code) || issue.message).join('; '));
    }
  }

  private async buildDeployPreflightSummary(
    teamId: string,
    teamName: string,
    absolutePath: string,
    deployArgs: string[]
  ): Promise<{
    agents: Array<{
      name: string;
      type: string;
      runtime: string;
      model: string;
      local: boolean;
      workingDirectory: string;
    }>;
    configPath: string;
    teamName: string;
    calendarCount: number;
  }> {
    const { agents, calendar, errors, teamName: configTeam } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

    let effectiveTeamId = teamId;
    let effectiveTeamName = teamName;
    if (configTeam && configTeam !== teamName) {
      effectiveTeamId = await this.db.teams.getOrCreateTeamId(configTeam);
      effectiveTeamName = configTeam;
    }

    if (errors.length > 0) {
      throw new Error(`Config errors: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
    }

    if (agents.length === 0) {
      throw new Error('No agents defined in config');
    }

    const summarizedAgents = agents.map((agentConfig, index) => {
      const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
      const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
      this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

      const previewId = `preview_${Date.now()}_${index}`;
      const workingDirectory = agentConfig.workingDirectory && path.isAbsolute(agentConfig.workingDirectory)
        ? agentConfig.workingDirectory
        : `${this.baseWorkDir}/agents/${previewId}`;

      return {
        name: agentConfig.name,
        type: agentConfig.type || 'claude',
        runtime: effectiveRuntime,
        model: effectiveModel,
        local: agentConfig.local === true,
        workingDirectory,
      };
    });

    return {
      agents: summarizedAgents,
      configPath: absolutePath,
      teamName: effectiveTeamName,
      calendarCount: calendar.length,
    };
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
      ID_AGENT_PORT: String(agent.port || ''),
      ID_TEAM: teamName,
      ID_PROJECT: teamName, // deprecated, use ID_TEAM
      ID_SHARED_DIR: `${this.baseWorkDir}/teams/${teamName}`,
      ID_DB_TEAM_ID: teamId,
      ID_DB_AGENT_ID: agent.id,
      ID_HARNESS: resolveRuntime((agent.runtime || agent.metadata?.runtime) as string | undefined),
      ID_PLUGINS: JSON.stringify(plugins)
    };

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
    const resolved = (
      headerName ||
      queryName ||
      oldProjectHeaderName ||
      oldProjectQueryName ||
      process.env.ID_TEAM ||
      process.env.ID_PROJECT ||
      'default'
    ).toString();
    // Validate team name to prevent path traversal
    if (!/^[a-zA-Z0-9_.-]+$/.test(resolved)) {
      throw new Error(`Invalid team name: "${resolved}". Only letters, numbers, hyphens, dots, and underscores allowed.`);
    }
    return resolved;
  }

  /**
   * Whether the request explicitly specified a team via header or query.
   * Used by task endpoints to decide if it's safe to fall back to the
   * caller's own team when the caller isn't found in the default team —
   * a team header always wins, so cross-team guards still hold.
   */
  private isTeamExplicit(req: express.Request): boolean {
    return !!(
      req.headers['x-id-team'] ||
      req.headers['x-id-project'] ||
      (typeof req.query.team === 'string' && req.query.team) ||
      (typeof req.query.project === 'string' && req.query.project)
    );
  }

  /**
   * Resolve a caller agent globally when the request omitted the team
   * header. Returns the matching agent row and its team only when the
   * lookup is unambiguous across teams.
   */
  private async resolveCallerAcrossTeams(ref: string): Promise<{ agent: AgentRow; teamId: string } | undefined> {
    const matches = await this.db.agents.resolveAcrossTeams(ref);
    if (matches.length !== 1) return undefined;
    return { agent: matches[0], teamId: matches[0].team_id };
  }

  private async getTeam(req: express.Request): Promise<{ name: string; id: string }> {
    // If the middleware has already resolved the context, use it directly
    const ctx = (req as any).ctx;
    if (ctx?.teamId && ctx?.teamName) {
      return { name: ctx.teamName, id: ctx.teamId };
    }
    // Fallback: resolve inline (used for paths that bypass middleware)
    const name = this.getTeamName(req);
    const id = await this.db.teams.getOrCreateTeamId(name);
    // Ensure per-team directory exists (no cross-team shared files).
    const teamDir = `${this.baseWorkDir}/teams/${name}`;
    if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
    return { name, id };
  }

  private key(teamId: string, agentId: string) {
    return `${teamId}:${agentId}`;
  }

  /**
   * Resolve the logical manager inbox owner for a team.
   * Writes persist only `owner_kind` / `owner_id`; `inboxApiId` is the stable
   * external handle (`manager-<team>`) returned on HTTP surfaces.
   */
  private getManagerInboxRef(teamId: string, teamName: string): {
    inboxApiId: string;
    ownerKind: 'manager';
    ownerId: string;
  } {
    return {
      inboxApiId: `manager-${teamName}`,
      ownerKind: 'manager',
      ownerId: teamId,
    };
  }

  /**
   * Canonical "deliver this query" lifecycle. Single source of truth for the
   * success path of a manager-side query completion: writes the completed
   * status to the queries table, emits `query:delivered` to the wakeup-service
   * event log, wakes any long-poll `GET /query/:id?wait=` blockers, and
   * resolves any in-memory `/talk-to` waiter still parked on the query id.
   *
   * Both POST /news (in_reply_to success branch) and POST /manager/inbox/respond
   * route through this helper so the lifecycle has exactly one implementation
   * — adding a second path would let the two drift on event emission, waiter
   * wakeup, or status semantics. Failure (`reply.error`) uses
   * `queries.markFailed` + `emitQueryFailed` and shares only the waiter
   * wakeup primitives below (which apply to any terminal transition).
   *
   * Idempotent at the DB level: `queries.complete` is gated on `status =
   * 'pending'`, so repeated calls for the same query are no-ops on the row.
   * The event/waiter side effects still fire, mirroring the existing POST
   * /news behavior (see audit finding context above).
   */
  private async completeQueryDelivery(params: {
    teamId: string;
    queryId: string;
    occurredAt: number;
    resultPayload: Record<string, unknown>;
    waiterReply: { from: string; message: string };
    messagePreview: string | null;
  }): Promise<void> {
    const { teamId, queryId, occurredAt, resultPayload, waiterReply, messagePreview } = params;

    await this.db.queries.complete(teamId, queryId, occurredAt, resultPayload);

    const completedRow = await this.db.queries
      .getByQueryIdForTeam(teamId, queryId)
      .catch(() => null);
    if (completedRow && completedRow.status === 'completed') {
      await emitQueryDelivered(this.db.events, {
        teamId,
        queryId,
        agentId:
          completedRow.owner_kind === 'manager'
            ? null
            : completedRow.agent_id,
        occurredAt,
        messagePreview,
      });
    }

    this.wakeQueryWaiters(teamId, queryId, waiterReply);

    // Phase 5.1: also close the matching Dispatch doc if this query was
    // enqueued through the scheduler. handleAgentDone is a no-op when no
    // doc exists, so this is safe to call on every completion.
    if (this.dispatchScheduler) {
      try {
        await this.dispatchScheduler.handleAgentDone({
          query_id: queryId,
          result: { reply: waiterReply.message, from: waiterReply.from },
          success: true,
        });
      } catch (err) {
        // Non-fatal: scheduler bookkeeping is shadow state in shadow mode.
        // The query has already been marked complete in the legacy path.
        console.warn(
          '[Manager] dispatchScheduler.handleAgentDone failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Wake the long-poll `GET /query/:id?wait=` blockers and resolve any
   * `/talk-to` waiter parked on this query id. Shared between
   * `completeQueryDelivery` (success) and the failure branch in POST /news so
   * neither path duplicates waiter logic.
   */
  private wakeQueryWaiters(
    teamId: string,
    queryId: string,
    waiterReply: { from: string; message: string },
  ): void {
    this.notifyQueryStatusWaiters(teamId, queryId);

    const waiter = this.queryWaiters.get(queryId);
    if (waiter) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      this.queryWaiters.delete(queryId);
      waiter.resolve(waiterReply);
      this.managerLog(`Resolved waiter for query ${queryId}`);
    }
  }

  /**
   * Redact sensitive fields from an agentToResponse result for non-admin callers.
   *
   * Top-level fields removed: ssh_target, internal_endpoint_url.
   * metadata keys removed: any key in SENSITIVE_META_KEYS list, plus any key
   * matching /private_?key/i or /secret/i as a safety net.
   */
  private static readonly SENSITIVE_META_KEYS = new Set([
    'auth_key_ref',
    'ows_wallet_seed',
    'ssh_private_key',
    'ssh_target',
    'internal_endpoint_url',
  ]);

  private static readonly SENSITIVE_META_REGEX = /private_?key|secret/i;

  private redactForNonAdmin<T extends Record<string, any>>(resp: T): T {
    // Remove top-level sensitive fields
    const out: any = { ...resp };
    delete out.ssh_target;
    delete out.internal_endpoint_url;

    // Deep-copy and strip sensitive metadata keys
    if (out.metadata && typeof out.metadata === 'object') {
      const meta: any = { ...out.metadata };
      for (const key of Object.keys(meta)) {
        if (
          AgentManagerDb.SENSITIVE_META_KEYS.has(key) ||
          AgentManagerDb.SENSITIVE_META_REGEX.test(key)
        ) {
          delete meta[key];
        }
      }
      out.metadata = meta;
    }

    return out as T;
  }

  /**
   * Convert an AgentRow to an API response object with identifier fields.
   * Pass opts.isAdmin = true for admin callers to receive the full unredacted record.
   */
  private agentToResponse(a: AgentRow, opts?: { isAdmin?: boolean }) {
    // Interactive CLI agents are reachable via the daemon's management port —
    // the daemon owns /talk and /news for them (see e3b30b9). The CLI's own
    // port (stored in a.endpoint) may not be listening, so wrapper lookups
    // that hit a.endpoint would silently fail. The daemon URL always works:
    // POST /news lands under the manager-inbox agent_id and GET /news reads
    // from the same row. Virtual agents keep their declared endpoint.
    const isRemote = isRemoteEndpointRuntime(a.runtime);
    const url = isRemote
      ? null
      : a.type === 'interactive'
        ? `http://localhost:${this.managementPort}`
        : a.type === 'virtual'
          ? a.endpoint
          : `http://localhost:${a.port}`;

    // After registration, a.name IS the ENS domain and the original local alias
    // is preserved in metadata.alias.
    const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
    const domain = a.domain || (a.metadata as any)?.idchain_domain;
    const displayId = domain || alias;

    // Lift metadata.pid to the top level so clients (TUI, health probes)
    // don't have to reach into metadata to batch per-agent RSS lookups.
    const metaPid = (a.metadata as { pid?: unknown } | undefined)?.pid;
    const pid = typeof metaPid === 'number' && Number.isFinite(metaPid) && metaPid > 0 ? metaPid : null;

    // Remote-endpoint agents have no local port or pid; health is derived from probe columns.
    const remoteFields = isRemote ? {
      port: null,
      pid: null,
      deploymentShape: 'remote-endpoint' as const,
      health: this.deriveRemoteHealth(a),
      customer_domain: a.customer_domain,
      public_endpoint_url: a.public_endpoint_url,
      internal_endpoint_url: a.internal_endpoint_url,
      ssh_target: a.ssh_target,
      last_seen: a.last_seen ?? null,
      last_probed_at: a.last_probed_at ?? null,
      last_error: a.last_error ?? null,
      consecutive_failures: a.consecutive_failures ?? 0,
    } : {
      deploymentShape: 'local-process' as const,
    };

    const full = {
      id: a.id,
      // name is the displayId (e.g., "agent-5.xid.eth") for inter-agent communication
      // alias is the base name (e.g., "agent") for backwards compatibility
      name: displayId,
      alias,
      model: a.model,
      port: a.port,
      pid,
      status: a.status,
      workingDirectory: a.working_directory,
      createdAt: a.created_at,
      type: a.type,
      runtime: a.runtime,
      url,
      metadata: a.metadata,
      // Identity fields
      tokenId: a.token_id,
      domain,
      displayId,
      // Health monitoring (overridden for remote agents above)
      ...this.getHealthForAgent(a),
      // Runtime shape — remote-endpoint agents override port/pid/health
      ...remoteFields,
    };

    return opts?.isAdmin === true ? full : this.redactForNonAdmin(full);
  }

  private async dbQueryAgentById(teamId: string, id: string): Promise<AgentRow | null> {
    const a = await this.db.agents.getById(id);
    if (!a) return null;
    if (a.team_id !== teamId) return null; // cross-team lookups invisible
    return a;
  }

  private async dbQueryAgentByNameMostRecent(teamId: string, name: string): Promise<AgentRow | null> {
    return this.db.agents.getByName(teamId, name);
  }

  private async dbListAgents(teamId: string, includeAutomator: boolean = false): Promise<AgentRow[]> {
    return this.db.agents.list(teamId, includeAutomator);
  }

  /**
   * W2-1 DispatchVerification — build the roster the effectiveness endpoint
   * needs: each team agent's name, a cheap status, and the dispatch_phid of any
   * dispatch currently in-flight to that agent. Defensive: any failure yields
   * an empty roster so the read endpoints degrade gracefully rather than 500.
   */
  private async buildVerificationRoster(teamId: string): Promise<RosterEntry[]> {
    try {
      const agents = await this.dbListAgents(teamId);
      // Map to_agent → first in-flight dispatch_phid. listInFlight is team-local
      // (the scheduler is bound to the default team), ordered by started_at ASC,
      // so the first match per agent is the oldest in-flight dispatch.
      const inFlightByAgent = new Map<string, string>();
      try {
        const inFlight = (await this.dispatchScheduler?.reactor.listInFlight()) ?? [];
        for (const doc of inFlight) {
          if (!inFlightByAgent.has(doc.to_agent)) {
            inFlightByAgent.set(doc.to_agent, doc.dispatch_phid);
          }
        }
      } catch {
        /* in-flight lookup is best-effort; roster still returns statuses */
      }
      return agents.map((a) => ({
        name: a.name,
        status: a.status || 'unknown',
        in_flight_dispatch_id: inFlightByAgent.get(a.name) ?? null,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Resolve agents matching an identifier pattern
   * Returns all matches for ambiguity detection
   */
  private async dbResolveAgents(teamId: string, ref: string): Promise<AgentRow[]> {
    return this.db.agents.resolve(teamId, ref);
  }

  private async dbNextPort(_teamId?: string): Promise<number> {
    return this.db.agents.nextPort();
  }

  /**
   * Get the shared deployer address.
   * Uses OWS wallet if OWS_REGISTRAR_WALLET is set, otherwise derives from PRIVATE_KEY.
   */
  private getDeployerAddress(): string | null {
    const owsWallet = process.env.OWS_REGISTRAR_WALLET;
    if (owsWallet) {
      try {
        const output = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
        let inWallet = false;
        for (const line of output.split('\n')) {
          if (line.includes('Name:') && line.includes(owsWallet)) { inWallet = true; continue; }
          if (inWallet && line.includes('Name:')) break;
          if (inWallet) {
            const match = line.trim().match(/^eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
            if (match) return match[1];
          }
        }
        return null;
      } catch {
        return null;
      }
    }
    const pk = process.env.AGENT_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!pk) return null;
    const account = privateKeyToAccount(pk as Hex);
    return account.address;
  }

  private async getDefaultRegistry(teamId: string): Promise<AgentRegistryId> {
    const cfg = await this.db.teams.getConfig(teamId);
    const chainId = parseInt(String(cfg.default_chain_id || process.env.ID_DEFAULT_CHAIN_ID || '8453'));
    const registryAddress =
      (cfg.default_registry_address ||
        process.env.AGENT_REGISTRY_ADDRESS ||
        process.env.ID_DEFAULT_REGISTRY_ADDRESS ||
        '0x2b39585cc5004712c938480cd7ff5b97d2bbf433') as string;
    return { chainId, registryAddress };
  }

  private async getRegistrarAddress(teamId: string): Promise<Address> {
    const cfg = await this.db.teams.getConfig(teamId);
    const registrarAddressEnv = process.env.AGENT_REGISTRAR_ADDRESS || process.env.ID_REGISTRAR_ADDRESS;
    const addr = (cfg.registrar_address || cfg.sepolia_registrar_address || registrarAddressEnv) as string | undefined;
    if (!addr) throw new Error('Missing registrar address (set config.registrar_address or env AGENT_REGISTRAR_ADDRESS)');
    return addr as Address;
  }

  private async setRegistrarAddress(teamId: string, registrarAddress: string): Promise<void> {
    await this.db.teams.setRegistrarAddress(teamId, String(registrarAddress));
  }

  private async setDefaultRegistry(teamId: string, chainId: number, registryAddress: string): Promise<void> {
    await this.db.teams.setDefaultRegistry(teamId, String(chainId), String(registryAddress));
  }

  private async registerOnchainAndUpdateAgent(teamId: string, agent: AgentRow): Promise<{ txHash: string; tokenId: string; domain: string }> {
    const isRemote = isRemoteEndpointRuntime(agent.runtime);

    // ── Phase 4: wallet provisioning for remote agents ──────────────────────
    // For public-agent-remote, provision an OWS wallet before registration so
    // multi-chain address records can be set.  For local agents the wallet is
    // already attached via the normal deploy path.
    //
    if (isRemote && !(agent.metadata as any)?.ows_wallet && this.isWalletProvisioningEnabled(agent.metadata)) {
      const refreshed = await this.provisionAgentWalletForRow(teamId, 'public', agent);
      if (refreshed) {
        agent = refreshed;
      } else {
        console.warn(`[Register] OWS not installed or wallet creation failed for remote agent "${agent.name}". Proceeding without wallet.`);
      }
    }

    // Support OWS wallet or raw private key for signing
    const owsRegistrarWallet = process.env.OWS_REGISTRAR_WALLET;
    const pk = !owsRegistrarWallet ? (process.env.ID_REGISTRAR_PRIVATE_KEY || process.env.PRIVATE_KEY) : undefined;
    if (!owsRegistrarWallet && !pk) throw new Error('Missing signer. Set OWS_REGISTRAR_WALLET or PRIVATE_KEY.');
    const signerOpts = owsRegistrarWallet ? { wallet: owsRegistrarWallet } : { privateKey: pk! };

    const defaultReg = await this.getDefaultRegistry(teamId);
    const chainId = defaultReg.chainId;
    const registryAddress = defaultReg.registryAddress as Address;

    // Build text records for registration
    const textRecords: Record<string, string> = {};
    textRecords['description'] = `${agent.name} agent`;

    // Determine the agent's endpoint for the ENSIP-26 records.
    // Remote agents advertise their public HTTPS endpoint; local agents use the
    // manager-local URL or the PUBLIC_BASE_URL override.
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    const agentEndpoint = isRemote
      ? (agent.public_endpoint_url || `https://${agent.customer_domain}`)
      : (publicBaseUrl
          ? `${publicBaseUrl.replace(/\/+$/, '')}`
          : (agent.type === 'virtual'
              ? (agent.endpoint as string)
              : ((agent.metadata as any)?.service || `http://localhost:${agent.port}`)));

    console.log(`[Register] Registering "${agent.name}" on ID Chain (Base)...`);

    // Register via id-cli with sublabel (Base only)
    // e.g., --sublabel x → x.agent-8.xid.eth in one transaction
    const originalAlias = ((agent.metadata as any)?.alias || agent.name);
    const result = await this.registerOnIdChainFn({
      sublabel: originalAlias,
      textRecords,
      ...signerOpts,
    });

    // ENSIP-26 agent endpoints can be set later via:
    //   id-cli set-agent-endpoints <domain> --a2a <url>
    // Skipped by default for private/local systems.

    // Use the label as tokenId for backward compat; domain is the primary identifier
    const tokenId = result.label;

    // Update metadata – preserve the original local alias so the agent
    // can still be found by its pre-registration name after `name` is
    // changed to the full ENS domain.
    let metadata = (agent.metadata || {}) as AgentMetadata;
    const newName = result.domain; // Already includes sublabel (e.g., x.agent-8.xid.eth)
    metadata = {
      ...metadata,
      idchain_domain: newName,
      service_type: 'REST-AP',
      alias: originalAlias,
    };

    // ── Phase 4: security metadata flags for remote agents ───────────────────
    if (isRemote) {
      metadata = {
        ...metadata,
        mesh_member: false,
        mesh_reachable: false,
        public_endpoint: true,
        dmz: true,
        allowed_inbound: ['public_http'],
        allowed_outbound: ['openrouter'],
      };
    }

    // Keep the agent's internal endpoint for manager-to-agent communication
    const isLocalAgent = (metadata as any).local === true;
    const dbEndpoint = isRemote
      ? (agent.endpoint || agentEndpoint)
      : (isLocalAgent ? (agent.endpoint || `http://localhost:${agent.port}`) : agentEndpoint);

    // Set multi-chain address records if agent has an OWS wallet
    const owsWalletName = (metadata as any).ows_wallet;
    if (owsWalletName) {
      try {
        const addrResult = await setMultiChainAddresses({
          name: newName,
          walletName: owsWalletName,
          ...signerOpts,
        });
        if (addrResult.set.length > 0) {
          console.log(`[Register] Set ${addrResult.set.length} address records: ${addrResult.set.join(', ')}`);
        }
      } catch (addrErr: any) {
        console.warn(`[Register] Multi-chain address setting failed: ${addrErr.message}`);
      }
    }

    await this.db.agents.updateIdentity(agent.id, {
      name: newName,
      token_id: tokenId,
      domain: newName,
      endpoint: dbEndpoint,
      metadata,
    });

    if (isRemote) {
      // ── Phase 4: push identity.json to the remote VPS ─────────────────────
      // Write to staging dir first, then attempt SCP delivery.
      await this.stageAndDeliverRemoteIdentity(agent, newName, tokenId, metadata);
    } else {
      // ── Local agent identity push ──────────────────────────────────────────
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
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
    }

    console.log(`✅ Registered ${originalAlias} as ${newName} (tx: ${result.txHash})`);
    return { txHash: result.txHash, tokenId, domain: newName };
  }

  /**
   * Write identity.json to the local staging directory and (if ssh_target is
   * set) deliver it to the remote VPS over SCP.
   *
   * On SSH delivery failure the on-chain state is still authoritative; the
   * manager logs a warning and returns successfully.
   */
  private async stageAndDeliverRemoteIdentity(
    agent: AgentRow,
    idchainDomain: string,
    tokenId: string,
    metadata: AgentMetadata,
  ): Promise<void> {
    // Build the identity object per § 8 schema
    const identity = {
      name: idchainDomain,
      ows_address: (metadata as any).ows_address || '',
      idchain_domain: idchainDomain,
      token_id: tokenId,
      service_endpoint: agent.public_endpoint_url || `https://${agent.customer_domain}` || '',
      registered_at: new Date().toISOString(),
    };

    // Staging path: <baseWorkDir>/public-agents/<agent.id>/staging/identity.json
    const stagingDir = path.join(this.baseWorkDir, 'public-agents', agent.id, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    const localPath = path.join(stagingDir, 'identity.json');
    writeFileSync(localPath, JSON.stringify(identity, null, 2), 'utf8');
    console.log(`[Register] Staged identity file at ${localPath}`);

    // Deliver over SSH if ssh_target is configured
    if (agent.ssh_target) {
      const remotePath = (agent.metadata as any)?.identity_remote_path || '/opt/public-agent/identity.json';
      const deliverResult = await this.deliverFn(agent.ssh_target, localPath, remotePath);
      // Never log the full ssh_target (raw `user@host`); the user portion is
      // operator PII. Full target is still available via admin API responses.
      const redactedTarget = redactSshTarget(agent.ssh_target);
      if (deliverResult.ok) {
        console.log(`[Register] Delivered identity.json to ${redactedTarget}:${remotePath}`);
      } else {
        console.warn(
          `[Register] SSH delivery failed for agent ${agent.id} (${redactedTarget}): ` +
          `error=${deliverResult.error} stderr=${deliverResult.stderr ?? ''}`,
        );
        // Do NOT throw — on-chain state is authoritative regardless.
      }
    }
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
    const targetAgent = await this.db.agents.getForRouting(teamId, agent, tokenId ?? undefined);

    if (!targetAgent) {
      return { error: `Agent "${agent}" not found`, status: 404 };
    }

    const isLocalAgent = targetAgent.metadata?.local === true;
    const targetUrl = isLocalAgent
      ? (targetAgent.endpoint || `http://localhost:${targetAgent.port}`)
      : targetAgent.type === 'claude'
        ? `http://id-agent-${targetAgent.id}:4100`
        : ((targetAgent.metadata?.internal_url as string | undefined) || targetAgent.endpoint);

    if (!targetUrl) {
      return { error: `Agent "${agent}" has no endpoint`, status: 400 };
    }

    // Prefer ENS domain as display ID, fall back to local name
    const targetDomain = targetAgent.metadata?.idchain_domain as string | undefined;
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

      if (String(agent).toLowerCase() === 'manager') {
        const { name: teamName } = await this.getTeam(req);
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const ts = Date.now();

        if (!shouldWait) {
          await this.db.news.add(teamId, null, {
            timestamp: ts,
            type: 'message',
            message: message,
            data: { from: from || 'manager', message },
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
          return res.json({
            success: true,
            delivered_to: 'manager',
            status: 'delivered',
          });
        }

        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        await this.db.queries.create(
          teamId,
          queryId,
          null,
          `[From: ${from || 'manager'}] ${message}`,
          ts,
          session_id || undefined,
          { owner_kind: managerInbox.ownerKind, owner_id: managerInbox.ownerId },
        );
        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.received',
          message: `Query from ${from || 'manager'}: ${String(message).slice(0, 100)}${String(message).length > 100 ? '...' : ''}`,
          data: { from: from || 'manager', message, session_id, query_id: queryId },
          query_id: queryId,
          kind: 'talk',
          reply_expected: true,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Queued reserved-route message to manager, query_id: ${queryId}`);

        let timeoutHandle: NodeJS.Timeout | null = null;
        let httpTimedOut = false;
        const replyPromise = new Promise<{ from: string; message: string }>((resolve) => {
          this.queryWaiters.set(queryId, {
            resolve,
            reject: () => {},
            timeout: null as any,
          });
          if (timeout < 24 * 60 * 60 * 1000) {
            timeoutHandle = setTimeout(() => {
              httpTimedOut = true;
              resolve({ from: '', message: '' });
            }, timeout);
          }
        });
        const replyResult = await replyPromise;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (httpTimedOut) {
          return res.json({
            success: false,
            from: 'manager',
            query_id: queryId,
            message: `Request timed out after ${timeout}ms - reply will be delivered when it arrives`,
            status: 'pending',
          });
        }
        return res.json({
          success: true,
          from: replyResult.from || 'manager',
          reply: replyResult.message,
          query_id: queryId,
        });
      }

      // Resolve the target agent
      const resolved = await this.resolveTargetAgent(teamId, agent);
      if ('error' in resolved) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { targetAgent, targetUrl, targetDisplayId } = resolved;

      // Mesh-membership gate: only mesh members can receive inter-agent messages.
      // mesh_member defaults to true for backward compat (pre-Phase-4 agents have no flag).
      // Admin callers may bypass via ?admin=true for diagnostic purposes — EXCEPT
      // when the target is a public-agent-remote runtime. Public remote agents
      // live in the DMZ; routing manager-proxied traffic to them through an admin
      // escape hatch would rebuild the proxy path the DMZ design explicitly
      // forbids. Public conversations must use direct HTTPS; operator plane must
      // use SSH. No admin override here.
      const meshMember = (targetAgent.metadata as any)?.mesh_member !== false;
      const isPublicRemote = targetAgent.runtime === 'public-agent-remote';
      const adminBypass = this.isAdminRequest(req) && req.query.admin === 'true' && !isPublicRemote;
      if (!meshMember && !adminBypass) {
        return res.status(403).json({
          error: 'not_mesh_reachable',
          message: isPublicRemote
            ? 'Target is a public-agent-remote runtime. Reach it via direct HTTPS (/talk) or SSH (operator plane); no manager-proxied admin bypass.'
            : 'Target agent is not part of the inter-agent mesh.'
        });
      }

      this.managerLog(`${shouldWait ? 'Forwarding' : 'Sending async'} message to ${targetDisplayId} at ${targetUrl}`);

      // Gateway path: under DISPATCH_GATEWAY_MODE=shadow|enforce, enqueue a
      // Dispatch doc and let the scheduler drain the queue at safe
      // concurrency. Shadow runs both paths (legacy + enqueue) for parity
      // observation; enforce makes the scheduler the sole /talk caller.
      if (
        this.dispatchScheduler &&
        this.dispatchScheduler.enabled &&
        this.dispatchScheduler.mode !== 'off'
      ) {
        try {
          const enq = await this.dispatchScheduler.enqueue(
            {
              to_agent: targetAgent.name,
              from_actor: from || 'manager',
              message,
              subject: typeof message === 'string' ? message.slice(0, 80) : 'manager dispatch',
            },
            { target_url: targetUrl, wake: true },
          );

          if (this.dispatchScheduler.mode === 'enforce') {
            // Persist a manager-side queries row so /query/:id?wait= keeps
            // working through the scheduler-driven path. The Dispatch doc is
            // the canonical state; this row is the legacy mirror waiters poll.
            await this.db.queries.create(teamId, enq.query_id, targetAgent.id, message, Date.now());

            if (!shouldWait) {
              this.managerLog(`Enqueued via dispatch scheduler (enforce); query_id=${enq.query_id}`);
              return res.json({
                success: true,
                query_id: enq.query_id,
                delivered_to: targetDisplayId,
                status: 'queued',
              });
            }

            // /talk-to wait path under enforce: long-poll the Dispatch doc.
            const final = await this.dispatchScheduler.waitForTerminal(enq.query_id, {
              timeoutMs: timeout,
              pollMs: 250,
            });
            if (!final) {
              return res.json({
                success: false,
                query_id: enq.query_id,
                delivered_to: targetDisplayId,
                status: 'pending',
                message: `Request timed out after ${timeout}ms — reply will arrive via /news when ready`,
              });
            }
            if (final.status === 'done') {
              const result = await this.dispatchScheduler.reactor.getResult(final.dispatch_phid);
              return res.json({
                success: true,
                query_id: enq.query_id,
                delivered_to: targetDisplayId,
                status: 'completed',
                reply: result?.reply ?? null,
              });
            }
            return res.status(502).json({
              success: false,
              query_id: enq.query_id,
              delivered_to: targetDisplayId,
              status: final.status,
              error: final.failure_detail ?? `dispatch ended in ${final.status}`,
            });
          }
          // shadow mode: legacy direct call also runs, so just log + fall through.
          this.managerLog(`Shadow enqueue created Dispatch ${enq.dispatch_phid} alongside legacy /talk`);
        } catch (err) {
          console.warn(
            '[Manager] Dispatch scheduler enqueue failed; falling back to legacy /talk:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Task 10: under enforce mode, surface that this legacy path is still in use so operators can migrate the caller.
      if (this.dispatchCanonicalMode === 'enforce') {
        console.warn(
          `[Manager] dispatch_canonical_skip_accept route=/talk-to to=${targetDisplayId} from=${from || 'manager'} — legacy direct /talk dispatch bypassed acceptDispatchStart under enforce mode`,
        );
      }

      // Forward the message to the agent's /talk endpoint
      const result = await this.forwardToAgent(targetUrl, message, from || 'manager', session_id);
      if (!result.ok) {
        console.error(`[Manager] Failed to deliver message to ${targetDisplayId}: ${result.status}`);
        return res.status(result.status).json({ error: result.error });
      }

      const queryId = result.data.query_id;

      // Store the query so replies can be routed correctly
      if (queryId) {
        await this.db.queries.create(teamId, queryId, targetAgent.id, message, Date.now());
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

  /**
   * /talk-to auto-attach hook. Inspects the request body and, if a task
   * delegation is requested, creates the task + (unless opted out) an
   * active checkin watched by the dispatcher. Throws an Error with
   * `status` and `code` properties on validation failures so the caller
   * can return a 4xx response with a stable error code.
   *
   * Returns null when the body has no `task` field (legacy /talk-to path).
   */
  private async maybeAutoAttachForTalkTo(
    req: express.Request,
  ): Promise<{ task: TaskRow; checkin: CheckinRow | null } | null> {
    const body = req.body || {};
    if (!body.task || typeof body.task !== 'object') return null;

    const { id: teamId } = await this.getTeam(req);
    const taskSpec = body.task as { title?: unknown; name?: unknown; description?: unknown };
    if (!taskSpec.title || typeof taskSpec.title !== 'string') {
      throw makeAutoAttachError(400, 'invalid_task_title');
    }

    const targetRef = body.to ?? body.agent;
    if (!targetRef || typeof targetRef !== 'string') {
      throw makeAutoAttachError(400, 'invalid_target_agent');
    }
    const targetResolved = await this.resolveSingleAgentForCommand(teamId, targetRef);
    if (!targetResolved.agent) {
      throw makeAutoAttachError(404, 'target_agent_not_found');
    }
    const targetAgent = targetResolved.agent;

    const fromRef = body.from;
    let fromAgent: AgentRow | undefined;
    if (fromRef && typeof fromRef === 'string') {
      const r = await this.resolveSingleAgentForCommand(teamId, fromRef);
      fromAgent = r.agent;
    }

    const flagsResult = parseAutoAttachFlags(body);
    if (flagsResult.error) {
      throw makeAutoAttachError(400, flagsResult.error);
    }

    const requestedName = typeof taskSpec.name === 'string' && taskSpec.name.length > 0
      ? normalizeAlias(taskSpec.name)
      : null;
    const baseName = requestedName || normalizeAlias(taskSpec.title);
    let name = baseName;
    if (requestedName) {
      if (await this.db.tasks.getByNameForTeam(name, teamId)) {
        throw makeAutoAttachError(409, 'task_name_conflict');
      }
    } else {
      let suffix = 1;
      while (await this.db.tasks.getByNameForTeam(name, teamId)) {
        name = `${baseName}-${suffix++}`;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const taskRow: TaskRow = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      uuid: crypto.randomUUID(),
      team_id: teamId,
      title: taskSpec.title,
      description: typeof taskSpec.description === 'string' ? taskSpec.description : null,
      status: 'doing',
      created_by: fromAgent?.id ?? null,
      owner: targetAgent.id,
      created_at: nowSec,
      updated_at: nowSec,
      completed_at: null,
    };
    await this.db.tasks.create(taskRow);

    if (flagsResult.disabled) {
      return { task: taskRow, checkin: null };
    }

    const nowMs = Date.now();
    const intervalSeconds = flagsResult.intervalSeconds ?? AUTO_ATTACH_DEFAULT_INTERVAL_SECONDS;
    const maxIterations = flagsResult.maxIterations ?? null;

    const checkinRow: CheckinRow = {
      id: generateCheckinId(nowMs),
      team_id: teamId,
      owner_agent_id: fromAgent?.id ?? null,
      created_by_agent_id: fromAgent?.id ?? null,
      linked_task_id: taskRow.id,
      interval_seconds: intervalSeconds,
      priority: 'normal',
      status: 'active',
      close_when: DEFAULT_CLOSE_WHEN,
      max_iterations: maxIterations,
      iteration_count: 0,
      next_fire_at: nowMs + intervalSeconds * 1000,
      snooze_until: null,
      ttl_expires_at: null,
      last_fire_at: null,
      last_event_seq: null,
      note: null,
      created_at: nowMs,
      updated_at: nowMs,
      closed_at: null,
      closed_reason: null,
    };
    await this.db.checkins.create(checkinRow);

    try {
      await recordCheckinCreated(this.db.events, this.db.checkins, {
        teamId,
        checkinId: checkinRow.id,
        ownerAgentId: checkinRow.owner_agent_id,
        createdByAgentId: checkinRow.created_by_agent_id,
        linkedTaskId: checkinRow.linked_task_id,
        priority: checkinRow.priority,
        intervalSeconds: checkinRow.interval_seconds,
        maxIterations: checkinRow.max_iterations,
        nextFireAt: checkinRow.next_fire_at,
        ttlExpiresAt: checkinRow.ttl_expires_at,
        occurredAt: nowMs,
      });
    } catch (err) {
      console.error('[Manager] Failed to emit checkin:created on auto-attach:', err);
    }

    return { task: taskRow, checkin: checkinRow };
  }

  /**
   * Resolve whether a request is from an admin principal.
   * Admin = loopback IP + X-Id-Admin: 1 header.
   */
  private isAdminRequest(req: express.Request): boolean {
    const ip = req.ip || '';
    const isLoopback =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const hasAdminHeader = req.headers['x-id-admin'] === '1';
    return isLoopback && hasAdminHeader;
  }

  /**
   * Team/principal context middleware.
   * Resolves once per request and attaches:
   *   (req as any).ctx = { principal, teamName, teamId }
   *
   * principal:
   *   'admin'  — loopback IP + X-Id-Admin: 1
   *   'agent'  — X-Id-Agent: <id> present and the agent belongs to the resolved team
   *   'anon'   — all other callers
   *
   * teamId resolution:
   *   - admin principals: getOrCreate (same as legacy behaviour)
   *   - non-admin: getTeamByName only; 404 if team does not exist
   */
  private teamContextMiddleware(): express.RequestHandler {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const teamName = this.getTeamName(req);
        const principal = this.isAdminRequest(req) ? 'admin' : 'anon';

        let teamId: string;
        if (principal === 'admin') {
          // Admin principals may create teams on the fly (legacy behaviour)
          teamId = await this.db.teams.getOrCreateTeamId(teamName);
          // Ensure per-team directory exists
          const teamDir = `${this.baseWorkDir}/teams/${teamName}`;
          if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        } else {
          // Non-admin: team must already exist
          const teamRow = await this.db.teams.getTeamByName(teamName);
          if (!teamRow) {
            res.status(404).json({ error: 'team_not_found' });
            return;
          }
          teamId = teamRow.id;
          // Ensure per-team directory exists
          const teamDir = `${this.baseWorkDir}/teams/${teamName}`;
          if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        }

        // Check agent principal claim
        let resolvedPrincipal: 'admin' | 'agent' | 'anon' = principal === 'admin' ? 'admin' : 'anon';
        const agentHeader = req.headers['x-id-agent'];
        if (agentHeader && typeof agentHeader === 'string' && resolvedPrincipal !== 'admin') {
          const agentRow = await this.db.agents.getById(agentHeader);
          if (agentRow && agentRow.team_id === teamId) {
            resolvedPrincipal = 'agent';
          } else if (agentRow && agentRow.team_id !== teamId) {
            // Agent exists but belongs to a different team — reject
            res.status(403).json({ error: 'agent_team_mismatch' });
            return;
          }
          // If agent doesn't exist at all, fall through as 'anon'
        }

        (req as any).ctx = { principal: resolvedPrincipal, teamName, teamId };
        next();
      } catch (err: any) {
        // Invalid team name or other error
        res.status(400).json({ error: err?.message || 'Invalid request context' });
      }
    };
  }

  private setupRoutes() {
    // Phase 6.1: deterministic concurrency snapshot for /system-live and
    // operator probes. Returns in_flight, queued, bounced, available_slots,
    // oldest_queued_age_ms, last_bounce_kind, mode, policy_version.
    this.managementApp.get('/system-live/dispatch', async (_req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
          mode: 'off',
        });
      }
      try {
        const snap = await this.dispatchScheduler.snapshot('anthropic');
        return res.json({ ok: true, dispatch: snap });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Phase 4.1c: explicit operator enqueue route. The /message and /talk-to
    // routes auto-enqueue under DISPATCH_GATEWAY_MODE; this is the named
    // surface for callers that specifically want a queued dispatch
    // (e.g. burst tools, schedule wake helpers).
    this.managementApp.post('/dispatch/enqueue', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const body = (req.body || {}) as {
          to_agent?: unknown;
          from_actor?: unknown;
          message?: unknown;
          subject?: unknown;
          priority?: unknown;
          wake?: unknown;
        };
        if (typeof body.to_agent !== 'string' || typeof body.message !== 'string') {
          return res.status(400).json({
            ok: false,
            error: 'to_agent (string) and message (string) required',
          });
        }
        const teamId = await this.db.teams.getOrCreateTeamId('default');
        const agent = await this.db.agents.getByName(teamId, body.to_agent).catch(() => null);
        if (!agent || !agent.endpoint) {
          return res.status(404).json({
            ok: false,
            error: `agent "${body.to_agent}" not resolvable to an endpoint`,
          });
        }
        const enq = await this.dispatchScheduler.enqueue(
          {
            to_agent: body.to_agent,
            from_actor: typeof body.from_actor === 'string' ? body.from_actor : 'operator',
            message: body.message,
            subject: typeof body.subject === 'string' ? body.subject : undefined,
            priority: typeof body.priority === 'number' ? body.priority : undefined,
          },
          { target_url: agent.endpoint, wake: body.wake === true },
        );
        return res.json({ ok: true, ...enq });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const acceptDispatchRoute = async (req: any, res: any) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const dispatchIdRaw = normalizeDispatchIdInput(req.params.dispatch_id);
        const body = (req.body || {}) as { agent_query_id?: unknown };
        const agentQueryId =
          typeof body.agent_query_id === 'string' ? body.agent_query_id.trim() : '';
        if (!dispatchIdRaw || !agentQueryId) {
          return res.status(400).json({
            ok: false,
            error: 'dispatch_id and non-empty agent_query_id required',
          });
        }
        const doc = await this.dispatchScheduler.acceptDispatchStart({
          dispatch_id: dispatchIdRaw,
          agent_query_id: agentQueryId,
        });
        if (!doc) {
          return res.status(404).json({
            ok: false,
            error: `dispatch not found: ${dispatchIdRaw}`,
          });
        }
        return res.json({
          ok: true,
          dispatch_id: doc.dispatch_phid,
          query_id: doc.query_id,
          agent_query_id: doc.agent_query_id,
          state: doc.status,
          started_at: doc.started_at,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = /conflict|terminal|requires/i.test(msg) ? 409 : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    };
    this.managementApp.post('/dispatches/:dispatch_id/accept', acceptDispatchRoute);
    this.managementApp.post('/dispatches/:dispatch_id/in-flight', acceptDispatchRoute);

    // ────────────────────────────────────────────────────────────────
    // Dispatch-canonical plan Task 12 — off-process delivery-failure
    // closeout. Cane (and any other off-process /talk caller) needs an
    // HTTP surface to flip the Dispatch doc on delivery failure so the
    // manager queue doesn't stay queued forever.
    //   POST /dispatches/:id/markFailed   — hard 4xx, agent rejected
    //   POST /dispatches/:id/markBounced  — transient (ConnErr / 5xx)
    // Both wrap SchedulerHandle.client.markFailed / markBounced and
    // accept either a `phid:disp-...` or a `query_id` in the path.
    // ────────────────────────────────────────────────────────────────
    const resolveDispatchDocForMark = async (dispatchIdRaw: string) => {
      const reactor = this.dispatchScheduler!.reactor;
      let doc = dispatchIdRaw.startsWith('phid:')
        ? await reactor.getByPhid(dispatchIdRaw)
        : null;
      if (!doc) {
        doc = await reactor.getByQueryId(dispatchIdRaw);
      }
      return doc;
    };

    this.managementApp.post('/dispatches/:dispatch_id/markFailed', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const dispatchIdRaw = normalizeDispatchIdInput(req.params.dispatch_id);
        const body = (req.body || {}) as { failure_kind?: unknown; detail?: unknown };
        const failureKind =
          typeof body.failure_kind === 'string' ? body.failure_kind.trim() : '';
        const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
        if (!dispatchIdRaw || !failureKind || !detail) {
          return res.status(400).json({
            ok: false,
            error: 'dispatch_id, non-empty failure_kind, and non-empty detail required',
          });
        }
        const doc = await resolveDispatchDocForMark(dispatchIdRaw);
        if (!doc) {
          return res.status(404).json({
            ok: false,
            error: `dispatch not found: ${dispatchIdRaw}`,
          });
        }
        const r = await this.dispatchScheduler.client.markFailed(doc.dispatch_phid, {
          failure_kind: failureKind as FailureKind,
          detail,
        });
        if (!r.ok) throw new Error(r.detail);
        return res.json({ ok: true, dispatch: r.value });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = /conflict|terminal|requires/i.test(msg) ? 409 : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    });

    this.managementApp.post('/dispatches/:dispatch_id/markBounced', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const dispatchIdRaw = normalizeDispatchIdInput(req.params.dispatch_id);
        const body = (req.body || {}) as {
          kind?: unknown;
          message?: unknown;
          next_attempt_at?: unknown;
        };
        const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!dispatchIdRaw || !kind || !message) {
          return res.status(400).json({
            ok: false,
            error: 'dispatch_id, non-empty kind, and non-empty message required',
          });
        }
        const nextAttemptMs =
          typeof body.next_attempt_at === 'number' && Number.isFinite(body.next_attempt_at)
            ? body.next_attempt_at
            : Date.now() + 60_000;
        const doc = await resolveDispatchDocForMark(dispatchIdRaw);
        if (!doc) {
          return res.status(404).json({
            ok: false,
            error: `dispatch not found: ${dispatchIdRaw}`,
          });
        }
        const r = await this.dispatchScheduler.client.markBounced(doc.dispatch_phid, {
          kind,
          message,
          next_attempt_at: new Date(nextAttemptMs).toISOString(),
        });
        if (!r.ok) throw new Error(r.detail);
        return res.json({ ok: true, dispatch: r.value });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = /conflict|terminal|requires/i.test(msg) ? 409 : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    });

    // ────────────────────────────────────────────────────────────────
    // Spec 054 v2 — agent clarification protocol.
    //   POST /agent-needs-input  : agent pauses on a question
    //   POST /agent-resume       : manager answers, agent resumes
    //   GET  /dispatches/clarifications : open blockers (read surface)
    // ────────────────────────────────────────────────────────────────
    this.managementApp.post('/agent-needs-input', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const body = (req.body || {}) as {
          dispatch_id?: unknown;
          agent_id?: unknown;
          question?: unknown;
          context?: unknown;
          urgency?: unknown;
          query_id?: unknown;
          resume_hint?: unknown;
        };
        // Spec 054 v2 review fix: accept dispatch_id as string OR
        // number. The spec example uses a numeric placeholder; the
        // live scheduler key is a `phid:disp-...` string. Convert
        // numeric input to its string form before resolution. NaN /
        // booleans / objects → empty (caught by the 400 check below).
        const dispatchIdRaw = normalizeDispatchIdInput(body.dispatch_id);
        const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!dispatchIdRaw || !agentId || !question) {
          return res.status(400).json({
            ok: false,
            error: 'dispatch_id, agent_id, and non-empty question required',
          });
        }
        const urgency =
          body.urgency === 'time_sensitive' ? 'time_sensitive' : 'normal';
        const queryId = typeof body.query_id === 'string' ? body.query_id : null;
        const teamId = await this.db.teams.getOrCreateTeamId('default');

        // Resolve dispatch_id: phid form, query_id form, or numeric
        // form (treated as query_id since the live store has no
        // numeric column).
        const reactor = this.dispatchScheduler.reactor;
        let dispatchDoc = null;
        if (dispatchIdRaw.startsWith('phid:')) {
          dispatchDoc = await reactor.getByPhid(dispatchIdRaw);
        }
        if (!dispatchDoc) {
          dispatchDoc = await reactor.getByQueryId(dispatchIdRaw);
        }
        if (!dispatchDoc && queryId) {
          dispatchDoc = await reactor.getByQueryId(queryId);
        }
        if (!dispatchDoc) {
          return res.status(404).json({
            ok: false,
            error: `dispatch not found: ${dispatchIdRaw}`,
          });
        }

        const result = await reactor.markNeedsClarification(dispatchDoc.dispatch_phid, {
          agent_id: agentId,
          query_id: queryId,
          question,
          context: body.context ?? null,
          urgency,
        });

        // Emit a manager-inbox news item so /news + dashboard surface the
        // blocker alongside terminal items.
        try {
          const teamName = 'default';
          const managerInbox = this.getManagerInboxRef(teamId, teamName);
          await this.db.news.add(teamId, null, {
            timestamp: Date.now(),
            type: 'dispatch.needs_clarification',
            message: `Dispatch needs clarification: ${agentId} - ${question.slice(0, 80)}${question.length > 80 ? '...' : ''}`,
            data: {
              dispatch_id: result.doc.dispatch_phid,
              clarification_id: result.clarification_id,
              agent_id: agentId,
              subject: result.doc.subject,
              question,
              context: body.context ?? null,
              urgency,
              stale_at: result.doc.active_clarification?.stale_at ?? null,
              query_id: queryId,
            },
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
        } catch (newsErr) {
          this.managerLog(
            `[agent-needs-input] news.add failed (continuing): ${newsErr instanceof Error ? newsErr.message : String(newsErr)}`,
          );
        }

        // N1.3: best-effort graph re-evaluation after needs_clarification.
        this.evaluateGraphsForDispatchBestEffort(
          result.doc.dispatch_phid,
          'dispatch_needs_clarification',
        );

        return res.json({
          ok: true,
          dispatch_id: result.doc.dispatch_phid,
          state: 'needs_clarification',
          clarification_id: result.clarification_id,
          stale_at: result.doc.active_clarification?.stale_at ?? null,
          idempotent: result.idempotent,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = /terminal|conflict/i.test(msg) ? 409 : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    });

    this.managementApp.post('/agent-resume', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const body = (req.body || {}) as {
          dispatch_id?: unknown;
          clarification_id?: unknown;
          answer?: unknown;
          instructions?: unknown;
          from?: unknown;
        };
        // Spec 054 v2 review fix: accept dispatch_id as string OR number.
        const dispatchIdRaw = normalizeDispatchIdInput(body.dispatch_id);
        const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
        const actor = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : 'manager';
        if (!dispatchIdRaw || !answer) {
          return res.status(400).json({
            ok: false,
            error: 'dispatch_id and non-empty answer required',
          });
        }
        const reactor = this.dispatchScheduler.reactor;
        let dispatchDoc = null;
        if (dispatchIdRaw.startsWith('phid:')) {
          dispatchDoc = await reactor.getByPhid(dispatchIdRaw);
        }
        if (!dispatchDoc) {
          dispatchDoc = await reactor.getByQueryId(dispatchIdRaw);
        }
        if (!dispatchDoc) {
          return res.status(404).json({
            ok: false,
            error: `dispatch not found: ${dispatchIdRaw}`,
          });
        }
        if (dispatchDoc.status !== 'needs_clarification') {
          return res.status(409).json({
            ok: false,
            error: `dispatch ${dispatchDoc.dispatch_phid} is ${dispatchDoc.status}, not needs_clarification`,
          });
        }
        const clarification_id =
          typeof body.clarification_id === 'string' ? body.clarification_id : undefined;
        const instructions =
          Array.isArray(body.instructions)
            ? (body.instructions as unknown[]).map((v) => String(v))
            : typeof body.instructions === 'string'
              ? body.instructions
              : null;

        const resumed = await reactor.resumeAfterClarification(dispatchDoc.dispatch_phid, {
          clarification_id,
          actor,
          answer,
          instructions,
        });

        // v2 transport: /talk follow-up to the same target agent with the
        // resume payload. Best-effort; failure flips to resume_delivery_failed.
        let delivered = false;
        let agent_query_id: string | null = null;
        let transport: 'session_injection' | 'talk_followup' = 'talk_followup';
        let failureDetail: string | null = null;
        try {
          const teamId = await this.db.teams.getOrCreateTeamId('default');
          const agent = await this.db.agents.getByName(teamId, resumed.to_agent).catch(() => null);
          if (!agent || !agent.endpoint) {
            failureDetail = `agent "${resumed.to_agent}" not resolvable to endpoint`;
          } else {
            const resumeMessage = [
              `[RESUME for dispatch ${resumed.dispatch_phid}]`,
              `Original subject: ${resumed.subject}`,
              `Your question was answered. Continue the dispatch (do not create new work).`,
              ``,
              `Manager answer: ${answer}`,
              instructions
                ? `Follow-up instructions: ${Array.isArray(instructions) ? instructions.map((s) => `- ${s}`).join('\n') : instructions}`
                : '',
            ]
              .filter(Boolean)
              .join('\n');
            const r = await fetch(`${agent.endpoint}/talk`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                message: resumeMessage,
                from: actor,
                dispatch_id: resumed.dispatch_phid,
                clarification_id: clarification_id ?? null,
              }),
            });
            if (!r.ok) {
              failureDetail = `talk delivery returned HTTP ${r.status}`;
            } else {
              try {
                const json = (await r.json()) as { query_id?: string };
                agent_query_id = typeof json?.query_id === 'string' ? json.query_id : null;
              } catch {
                agent_query_id = null;
              }
              delivered = true;
            }
          }
        } catch (deliveryErr) {
          failureDetail = deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr);
        }

        if (delivered) {
          await reactor.markResumeDelivered(resumed.dispatch_phid, {
            clarification_id: resumed.clarification_history
              .slice()
              .reverse()
              .find((e) => e.type === 'RESUME')?.clarification_id ?? clarification_id ?? '',
            transport,
            agent_query_id,
          });
          // N1.3: best-effort graph re-evaluation after resume.
          this.evaluateGraphsForDispatchBestEffort(
            resumed.dispatch_phid,
            'dispatch_resumed',
          );
          return res.json({
            ok: true,
            dispatch_id: resumed.dispatch_phid,
            state: 'queued',
            delivered_to_agent: true,
            agent_query_id,
          });
        }

        const failed = await reactor.markResumeDeliveryFailed(resumed.dispatch_phid, {
          clarification_id: clarification_id ?? resumed.clarification_history
            .slice()
            .reverse()
            .find((e) => e.type === 'RESUME')?.clarification_id ?? '',
          failure_detail: failureDetail ?? 'unknown delivery failure',
        });

        // News event for delivery failure.
        try {
          const teamId2 = await this.db.teams.getOrCreateTeamId('default');
          const managerInbox = this.getManagerInboxRef(teamId2, 'default');
          await this.db.news.add(teamId2, null, {
            timestamp: Date.now(),
            type: 'dispatch.resume_delivery_failed',
            message: `Resume delivery failed: ${failed.to_agent} - ${failureDetail ?? 'unknown'}`,
            data: {
              dispatch_id: failed.dispatch_phid,
              agent_id: failed.to_agent,
              failure_detail: failureDetail,
            },
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
        } catch {
          // best-effort
        }

        // N1.3: best-effort graph re-evaluation after resume delivery failed.
        this.evaluateGraphsForDispatchBestEffort(
          failed.dispatch_phid,
          'dispatch_resume_delivery_failed',
        );

        return res.json({
          ok: true,
          dispatch_id: failed.dispatch_phid,
          state: 'resume_delivery_failed',
          delivered_to_agent: false,
          failure_detail: failureDetail,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ ok: false, error: msg });
      }
    });

    this.managementApp.get('/dispatches/clarifications', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      try {
        const staleOnly = req.query.stale === 'true' || req.query.stale === '1';
        const docs = await this.dispatchScheduler.reactor.listOpenClarifications({ staleOnly });
        const now = Date.now();
        const items = docs.map((d) => {
          const blocker = d.active_clarification;
          const createdMs = blocker ? Date.parse(blocker.created_at) : 0;
          return {
            dispatch_id: d.dispatch_phid,
            clarification_id: d.clarification_id,
            agent_id: blocker?.agent_id ?? d.to_agent,
            subject: d.subject,
            question: blocker?.question ?? '',
            context: blocker?.context ?? null,
            urgency: blocker?.urgency ?? 'normal',
            created_at: blocker?.created_at ?? d.updated_at,
            stale_at: blocker?.stale_at ?? null,
            age_seconds: createdMs ? Math.max(0, Math.floor((now - createdMs) / 1000)) : 0,
          };
        });
        return res.json({ ok: true, items });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // ────────────────────────────────────────────────────────────────
    // Spec 054 v2 Part 2 — manager-side /agent-done with promotion
    // enforcement.
    //
    // Mode is controlled by env SPEC054_PROMOTION_ENFORCEMENT:
    //   warn    (default) — log a warning if promote=true but promotion
    //                       metadata is missing/incomplete; still mark
    //                       the dispatch done.
    //   enforce          — reject (400) when promote=true but promotion
    //                       metadata is missing/incomplete.
    //
    // Non-build dispatches (promote=false) pass validation regardless.
    // ────────────────────────────────────────────────────────────────
    this.managementApp.post('/agent-done', async (req, res) => {
      if (!this.dispatchScheduler) {
        return res.status(503).json({
          ok: false,
          error: 'dispatch_scheduler_not_initialised',
        });
      }
      // R.2: authenticate the closeout BEFORE any reactor read or mutation, so a
      // spoofed/unauthorised caller can never complete a dispatch. Default config
      // trusts loopback callers (the local fleet); setting DISPATCH_DONE_TOKEN
      // upgrades this to mandatory shared-token auth without a framework rewrite.
      const auth = authenticateAgentDone(
        {
          remoteIp: req.ip,
          headerToken:
            typeof req.headers['x-id-dispatch-token'] === 'string'
              ? (req.headers['x-id-dispatch-token'] as string)
              : null,
        },
        agentDoneAuthConfigFromEnv(process.env),
      );
      if (!auth.ok) {
        return res.status(auth.status).json({ ok: false, error: auth.error });
      }
      try {
        const body = (req.body || {}) as {
          dispatch_id?: unknown;
          query_id?: unknown;
          success?: unknown;
          result?: unknown;
          promotion?: unknown;
          mode?: unknown;
          agent?: unknown;
          // Harness-resilience (Spec 2026-05-29): structured terminal
          // failure on success:false. failure_kind must be one of the
          // canonical FailureKind values; error is a short prose detail.
          failure_kind?: unknown;
          error?: unknown;
          harness_error?: unknown;
        };

        const dispatchIdRaw =
          typeof body.dispatch_id === 'string'
            ? body.dispatch_id.trim()
            : typeof body.dispatch_id === 'number' && Number.isFinite(body.dispatch_id)
              ? String(body.dispatch_id)
              : '';
        const queryId = typeof body.query_id === 'string' ? body.query_id : null;
        if (!dispatchIdRaw && !queryId) {
          return res.status(400).json({
            ok: false,
            error: 'dispatch_id or query_id required',
          });
        }

        const reactor = this.dispatchScheduler.reactor;

        // Task 9: strict id match (open Q7 resolution). When BOTH
        // dispatch_id and query_id are supplied, they must resolve to the
        // same Dispatch doc. A mismatched pair almost always means a buggy
        // closeout against the wrong dispatch — silently picking one side
        // is what produced the partial-truth tracking problems the spec
        // calls out. One-sided unresolved (e.g. stale query_id, missing
        // dispatch_id) falls through to the standard resolution loop so
        // the manager stays resilient to legacy/orphaned refs.
        if (dispatchIdRaw && queryId) {
          const docByDispatch = dispatchIdRaw.startsWith('phid:')
            ? await reactor.getByPhid(dispatchIdRaw)
            : await reactor.getByQueryId(dispatchIdRaw);
          const docByQueryId = await reactor.getByQueryId(queryId);
          if (
            docByDispatch &&
            docByQueryId &&
            docByDispatch.dispatch_phid !== docByQueryId.dispatch_phid
          ) {
            return res.status(409).json({
              ok: false,
              error: `agent-done: dispatch_id and query_id mismatch (dispatch=${docByDispatch.dispatch_phid}, query=${docByQueryId.dispatch_phid})`,
            });
          }
        }

        let doc = null as Awaited<ReturnType<typeof reactor.getByPhid>> | null;
        if (dispatchIdRaw && dispatchIdRaw.startsWith('phid:')) {
          doc = await reactor.getByPhid(dispatchIdRaw);
        }
        if (!doc && dispatchIdRaw) {
          doc = await reactor.getByQueryId(dispatchIdRaw);
        }
        if (!doc && queryId) {
          doc = await reactor.getByQueryId(queryId);
        }
        if (!doc) {
          this.managerLog(
            `[agent-done] no scheduler dispatch found for ${dispatchIdRaw || queryId}; treating as non-scheduler closeout`,
          );
          return res.json({
            ok: true,
            dispatch_id: dispatchIdRaw || null,
            query_id: queryId,
            state: 'ignored_non_scheduler',
            ignored: true,
            reason: 'dispatch_not_found',
          });
        }

        const overrideMode =
          body.mode === 'warn' || body.mode === 'enforce' ? body.mode : null;
        const envMode = parsePromotionEnforcement(process.env.SPEC054_PROMOTION_ENFORCEMENT);
        const mode = overrideMode ?? envMode;
        const promotion =
          body.promotion && typeof body.promotion === 'object'
            ? (body.promotion as PromotionAgentDone)
            : null;

        const success = body.success !== false;

        // Harness-resilience (Spec 2026-05-29): failed dispatches do NOT
        // need promotion metadata — promotion only applies to successful
        // build completions. Validate only on success.
        const validation = success
          ? validatePromotionMetadata(doc, promotion, mode)
          : ({ ok: true } as const);

        if (!validation.ok) {
          // enforce mode rejection.
          return res.status(400).json({
            ok: false,
            error: validation.error,
            mode,
          });
        }

        // Persist promotion result if supplied.
        if (promotion) {
          try {
            await reactor.recordPromotionResult(doc.dispatch_phid, {
              result: promotion,
            });
          } catch (err) {
            this.managerLog(
              `[agent-done] recordPromotionResult failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Map structured failure metadata when success === false. Whitelist
        // the failure_kind so callers can't inject arbitrary strings.
        const ALLOWED_FAILURE_KINDS = new Set([
          'agent_error',
          'provider_rate_limit_exhausted',
          'scheduler_wedged',
          'cancelled',
          'validation_failed',
          'model_api_error_exhausted',
          'harness_empty_result_exhausted',
          'harness_process_error_exhausted',
        ] as const);
        const failureKind = typeof body.failure_kind === 'string' && ALLOWED_FAILURE_KINDS.has(body.failure_kind as any)
          ? (body.failure_kind as FailureKind)
          : undefined;
        const errorDetail = (() => {
          if (typeof body.error === 'string' && body.error.trim()) return body.error;
          if (body.harness_error && typeof body.harness_error === 'object') {
            try { return JSON.stringify(body.harness_error); } catch { return undefined; }
          }
          return undefined;
        })();

        // Mark the dispatch done.
        try {
          await this.dispatchScheduler.handleAgentDone({
            query_id: doc.query_id,
            result:
              body.result && typeof body.result === 'object'
                ? (body.result as Record<string, unknown>)
                : null,
            success,
            failure_kind: failureKind,
            error: errorDetail,
          });
        } catch (err) {
          this.managerLog(
            `[agent-done] handleAgentDone failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return res.status(500).json({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Read-model back-write (2026-06-13): the scheduler closes
        // dispatch_scheduler_queue above, but historically nothing
        // back-wrote the corresponding queries row. Result: /query/<id>
        // stayed "pending" forever after a dispatch completed (CTO
        // dispatch query_1781370010051_n1hjeqq + Maestra
        // query_1781370010083_9v4sj6q on 2026-06-13 are the reference
        // reproduction). Same manager-side query_id lives in both
        // dispatch_scheduler_queue.query_id and queries.query_id, so the
        // back-write is a single .complete() / .markFailed() call.
        //
        // Best-effort: a missing/stale queries row should not fail the
        // dispatch closeout that the scheduler already committed.
        // See: cane/output/2026-06-13-query-row-not-resolved-after-dispatch-done.md
        try {
          const resultProjection: Record<string, unknown> | null =
            body.result && typeof body.result === 'object'
              ? (body.result as Record<string, unknown>)
              : null;
          // DispatchDoc doesn't carry team_id, so look it up from the
          // queries table directly. If no matching queries row exists
          // (e.g. dispatch issued via a path that didn't pre-create the
          // legacy mirror), findTeam returns null and the back-write
          // becomes a no-op — correct best-effort behavior.
          const backWriteTeamId = await this.db.queries.findTeam(doc.query_id);
          if (backWriteTeamId) {
            if (success) {
              await this.db.queries.complete(
                backWriteTeamId,
                doc.query_id,
                Date.now(),
                resultProjection,
              );
            } else {
              await this.db.queries.markFailed(
                backWriteTeamId,
                doc.query_id,
                Date.now(),
                errorDetail ?? null,
              );
            }
          }
        } catch (err) {
          this.managerLog(
            `[agent-done] queries back-write failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // N1.3: best-effort graph re-evaluation after dispatch state change.
        this.evaluateGraphsForDispatchBestEffort(
          doc.dispatch_phid,
          success ? 'dispatch_done' : 'dispatch_failed',
        );

        return res.json({
          ok: true,
          dispatch_id: doc.dispatch_phid,
          state: success ? 'done' : 'failed',
          mode,
          promotion_warning: ('warning' in validation ? validation.warning : null) ?? null,
        });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // REST-AP discovery — daemon root advertises itself as the manager so
    // peers can locate the team orchestration and inbox surface directly.
    // Shape mirrors the per-agent catalogs published by claude-agent-server /
    // interactive-agent-server (restap_version + agent + endpoints + capabilities).
    // This route must stay outside team scoping: discovery at the daemon root
    // should not depend on a team already existing or a caller sending a team header.
    this.managementApp.get('/.well-known/restap.json', (_req, res) => {
      res.json({
        restap_version: '1.0',
        agent: {
          name: 'manager',
          description:
            'Manager daemon — team orchestration, inbox, scheduling, registry, and event fan-out for the id-agents control plane.',
        },
        provider: {
          name: 'id-agents',
          version: '1.0',
        },
        endpoints: {
          talk: '/talk',
          schedule: '/schedule',
          news: '/news',
          news_post: '/news',
        },
        capabilities: [
          {
            id: 'talk',
            title: 'Send a message or question to the manager',
            method: 'POST',
            endpoint: '/talk',
            description:
              'Post a message or question to the manager inbox. Persists to the manager DB; replies arrive via /news.',
            input_schema: {
              message: 'string (required)',
              from: 'string (optional) - sender agent name or id',
              session_id: 'string (optional) - prior session id for context continuity',
            },
          },
          {
            id: 'schedule',
            title: 'Enqueue scheduled work for the manager',
            method: 'POST',
            endpoint: '/schedule',
            description:
              'Submit a manager-owned scheduled event. Internal mode enqueues work without auto-reply.',
            input_schema: {
              message: 'string (required)',
              schedule:
                'object (required) - schedule metadata including id, kind, title, scheduledKey',
              mode: 'string (optional) - "internal" for autonomous wake-ups',
            },
          },
          {
            id: 'news',
            title: 'Poll manager news feed',
            method: 'GET',
            endpoint: '/news',
            description:
              'Poll for manager inbox updates and replies. Supports since (timestamp), limit, query_id, chars_start/chars_end.',
            input_schema: {
              since: 'number (optional) - timestamp to filter items after',
              limit: 'number (optional) - maximum number of items to return',
              query_id: 'string (optional) - filter items by specific query_id',
              chars_start: 'number (optional) - start position in character range (0 = newest)',
              chars_end: 'number (optional) - end position in character range (must be > chars_start)',
            },
          },
          {
            id: 'news_receive',
            title: 'Deliver a message or reply to the manager',
            method: 'POST',
            endpoint: '/news',
            description:
              'Receive messages or replies addressed to the manager inbox. Does not trigger LLM processing.',
            input_schema: {
              type: 'string (optional) - message type, e.g. "reply" or "message"',
              from: 'string (optional) - sender agent name',
              message: 'string (required) - the message content',
              in_reply_to: 'string (optional) - query_id this is replying to',
            },
          },
        ],
        extensions: {
          remote: '/remote',
          query: '/query/:id',
          tasks: '/tasks',
          agents: '/agents',
          events: '/events',
          ws: '/ws',
        },
      });
    });

    // Install team/principal context middleware for all remaining routes
    this.managementApp.use(this.teamContextMiddleware());

    this.managementApp.get('/health', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const count = await this.db.agents.count(teamId);
      res.json({ status: 'ok', team: teamName, agents: parseInt(count || '0'), timestamp: Date.now() });
    });

    this.managementApp.get('/dispatches/health', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const health = await readDispatchHealth(this.db.adapter, teamId);
        return res.json({ ok: true, team: teamName, ...health });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Task 11 (dispatch-canonical): diagnostic surface listing dispatches
    // whose canonical lifecycle drifted from the agent-side queries
    // projection. Mounted before /dispatches/:dispatch_id so Express routes
    // the literal path correctly.
    this.managementApp.get('/dispatches/reconcile', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const reconcile = await readReconciliation(this.db.adapter, teamId);
        return res.json({ ok: true, team: teamName, ...reconcile });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.managementApp.get('/dispatches', async (req, res) => {
      try {
        const status = parseDispatchReadStatus(req.query.status);
        if (!status) {
          return res.status(400).json({
            ok: false,
            error: 'status must be active, terminal, or all',
          });
        }
        const limit = parseReadLimit(req.query.limit);
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const dispatches = await readDispatches(this.db.adapter, teamId, status, limit);
        return res.json({
          ok: true,
          team: teamName,
          status,
          limit,
          count: dispatches.length,
          dispatches,
          items: dispatches,
        });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.managementApp.get('/dispatches/:dispatch_id', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const dispatch = await readDispatchById(this.db.adapter, teamId, req.params.dispatch_id);
        if (!dispatch) {
          return res.status(404).json({ ok: false, error: 'dispatch_not_found' });
        }
        return res.json({ ok: true, team: teamName, dispatch });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.managementApp.get('/artifacts', async (req, res) => {
      try {
        const limit = parseReadLimit(req.query.limit);
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const artifacts = await readArtifacts(this.db.adapter, teamId, limit);
        return res.json({ ok: true, team: teamName, limit, ...artifacts });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Slice 7: read-only library inventory. Library root is captured at
    // manager construction from `opts.libraryRoot` (tests) or from
    // resolveDefaultLibraryRoot() (prod: ID_LIBRARY_ROOT env, else
    // <cwd>/configs, else null). When null, listings return an empty
    // collection and detail routes return 404 — "no library configured"
    // is a first-class state, not an error.
    this.managementApp.get('/library/agents', (_req, res) => {
      res.json(listLibraryAgents(this.libraryRoot));
    });

    this.managementApp.get('/library/agents/:name', (req, res) => {
      const detail = getLibraryAgent(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-agent', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    this.managementApp.get('/library/skills', (_req, res) => {
      res.json(listLibrarySkills(this.libraryRoot));
    });

    this.managementApp.get('/library/skills/:name', (req, res) => {
      const detail = getLibrarySkill(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-skill', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    // GET /agents/status - check health of all agents (server-side ping)
    this.managementApp.get('/agents/status', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);
      const isAdmin = this.isAdminRequest(req);

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
                signal: AbortSignal.timeout(2000)
              });
              if (newsResp.ok) {
                const newsData: any = await newsResp.json();
                newsItems = newsData.items || [];
              }
            } catch { /* news fetch failed */ }
          }

          // Check for active heartbeat schedules
          let hasActiveHeartbeat = false;
          if (this.schedulerService) {
            const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
            hasActiveHeartbeat = schedules.some(s => s.kind === 'heartbeat' && s.active);
          }

          return {
            ...this.agentToResponse(agent, { isAdmin }),
            isResponding,
            newsItems,
            hasActiveHeartbeat
          };
        })
      );

      const agentStatuses = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { ...this.agentToResponse(agents[i], { isAdmin }), isResponding: false, newsItems: [], hasActiveHeartbeat: false };
      });

      res.json({ agents: agentStatuses });
    });

    // W2-1 DispatchVerification — Agents-tab read endpoints. These MUST be
    // registered before the dynamic `/agents/:name/...` and `/agents/:id`
    // routes below so `/agents/effectiveness` and `/agents/:name/dispatches`
    // resolve to these handlers and are NOT captured by the `:name`/`:id`
    // params. The verification storage is constructed in start() (alongside the
    // dispatch scheduler), so at request time it may be null — guard with 503.
    // The handlers read the durable projection only; they never stat files.
    // Registered inline (rather than via mountDispatchVerificationRoutes) so the
    // null-storage 503 guard can run per request — storage does not exist yet
    // when setupRoutes runs from the constructor.
    this.managementApp.get('/agents/effectiveness', async (req, res) => {
      try {
        const storage = this.dispatchVerificationStorage;
        if (!storage) {
          return res.status(503).json({ error: 'verification_disabled' });
        }
        const { id: teamId } = await this.getTeam(req);
        const r = await getAgentsEffectiveness(
          {
            storage,
            listRoster: (tid) => this.buildVerificationRoster(tid),
            now: () => new Date().toISOString(),
          },
          teamId,
          { window: req.query.window },
        );
        res.status(r.status).json(r.body);
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'effectiveness failed' });
      }
    });

    this.managementApp.get('/agents/:name/dispatches', async (req, res) => {
      try {
        const storage = this.dispatchVerificationStorage;
        if (!storage) {
          return res.status(503).json({ error: 'verification_disabled' });
        }
        const { id: teamId } = await this.getTeam(req);
        const r = await getAgentDispatches(
          {
            storage,
            listRoster: (tid) => this.buildVerificationRoster(tid),
            now: () => new Date().toISOString(),
          },
          teamId,
          req.params.name,
          { window: req.query.window, limit: req.query.limit },
        );
        res.status(r.status).json(r.body);
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'dispatches failed' });
      }
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
          signal: AbortSignal.timeout(5000)
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

    // REST-AP /talk endpoint - receive queries for the manager inbox
    this.managementApp.post('/talk', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, session_id, from } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const senderName = from || 'external';

        // Store the query in the queries table. Dual-write window: every
        // manager-inbox row carries both legacy agent_id (= manager-<team>)
        // and the new owner_kind/owner_id columns explicitly so a downstream
        // backfill/cutover never has to infer ownership from the agent_id
        // prefix heuristic.
        await this.db.queries.create(
          teamId,
          queryId,
          null,
          `[From: ${senderName}] ${message}`,
          ts,
          session_id || undefined,
          { owner_kind: managerInbox.ownerKind, owner_id: managerInbox.ownerId },
        );

        // Also store as a news item so the CLI can see incoming queries
        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.received',
          message: `Query from ${senderName}: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
          data: { from: senderName, message, session_id, query_id: queryId },
          query_id: queryId,
          kind: 'talk',
          reply_expected: true,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

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

    // POST /schedule - enqueue manager-owned internal scheduled work
    this.managementApp.post('/schedule', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, schedule, mode, linkedTasks } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }
        if (!schedule || typeof schedule !== 'object') {
          return res.status(400).json({ error: 'Schedule metadata is required' });
        }
        if (mode && mode !== 'internal') {
          return res.status(400).json({ error: 'Invalid schedule mode' });
        }

        const messageStr = typeof message === 'string' ? message : String(message);
        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;

        const managerInbox = this.getManagerInboxRef(teamId, teamName);

        const queryResult: Record<string, unknown> = { schedule, message: messageStr, mode: 'internal' };
        if (Array.isArray(linkedTasks) && linkedTasks.length > 0) {
          queryResult.linkedTasks = linkedTasks;
        }

        await this.db.queries.upsert(teamId, null, {
          query_id: queryId,
          status: 'pending',
          prompt: messageStr,
          created: ts,
          completed: null,
          result: queryResult,
          error: null,
          session_id: null,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        const newsData: Record<string, unknown> = {
          query_id: queryId,
          message: messageStr,
          schedule,
          status: 'awaiting_response',
        };
        if (Array.isArray(linkedTasks) && linkedTasks.length > 0) {
          newsData.linkedTasks = linkedTasks;
        }

        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'schedule.received',
          message: `Scheduled query ${queryId} received`,
          data: newsData,
          query_id: queryId,
          reply_expected: false,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Received scheduled query ${queryId}: ${messageStr.slice(0, 50)}...`);

        res.status(202).json({
          query_id: queryId,
          status: 'pending',
          message: `Scheduled work has been queued for the manager inbox.`,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /schedule:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /message - DEPRECATED unified endpoint for sending messages to agents.
    // Prefer POST /talk-to (synchronous reply) or POST /news-to (fire-and-forget).
    // Emits an X-Deprecated response header and a manager log line; still
    // functionally equivalent to /talk-to with fire-and-forget defaults.
    this.managementApp.post('/message', (req, res, next) => {
      res.setHeader(
        'X-Deprecated',
        '/message is deprecated; use /talk-to for synchronous replies or /news-to for fire-and-forget notifications',
      );
      const fromHint = (req.body && typeof req.body.from === 'string') ? req.body.from : 'unknown';
      this.managerLog(`[DEPRECATED] /message called (from=${fromHint}); prefer /talk-to or /news-to`);
      this.handleMessage(req, res).catch(next);
    });

    // /talk-to - backwards-compatible alias for /message with wait:true.
    // When the body carries a `task` object the dispatch is treated as a
    // task delegation: the manager creates the task (owner = target agent,
    // status = 'doing') and auto-attaches an active checkin owned by the
    // dispatcher. The auto-attach is governed by these flags on the body:
    //   - no_checkin: true            disables auto-attach for this dispatch
    //   - checkin: <duration|seconds> overrides interval (default 10m)
    //   - checkin_iters: <N>          sets max_iterations (default null)
    // If no `task` object is supplied, /talk-to behaves exactly as before.
    this.managementApp.post('/talk-to', async (req, res, next) => {
      // Inject wait:true if not explicitly set
      if (req.body && req.body.wait === undefined && req.body.timeout === undefined) {
        req.body.wait = true;
      }
      try {
        const result = await this.maybeAutoAttachForTalkTo(req);
        if (result) (req as any)._autoAttach = result;
      } catch (err: any) {
        return res.status(err?.status || 400).json({ error: err?.code || err?.message || 'auto_attach_failed' });
      }
      this.handleMessage(req, res).catch(next);
    });

    // /news-to - fire-and-forget notification to another agent (no reply wait).
    // Mesh-membership gate applies identically to /talk-to (handled inside handleMessage).
    this.managementApp.post('/news-to', (req, res, next) => {
      // Ensure wait is explicitly false (fire-and-forget)
      if (req.body) {
        req.body.wait = false;
      }
      this.handleMessage(req, res).catch(next);
    });

    // REST-AP /news endpoint - receive replies from agents
    this.managementApp.post('/news', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const { type, from, message, data } = req.body || {};
        // `in_reply_to` is the query_id this row is replying to. Some clients
        // put it at the top level; agent-server `broadcastToManager` started
        // doing so deliberately, but older paths (and the original message
        // shape) only carried it inside `data`. Fall back so either works.
        const in_reply_to: string | undefined = req.body?.in_reply_to ?? data?.in_reply_to ?? undefined;
        // Replies (in_reply_to present) default to trigger=true so the
        // forwarded receiver wakes up when its /talk-to wait has already
        // timed out. Caller can opt out with trigger:false explicitly.
        const trigger = resolveNewsTrigger({ in_reply_to, trigger: req.body?.trigger });
        // skip_persist:true: caller already persisted the canonical row
        // under the actual receiver's inbox (e.g. `broadcastToManager` from
        // the originating agent's /news handler). Skip the manager-inbox
        // insert to avoid duplicate visible rows; still run waiter
        // resolution + queries.complete + emitQueryDelivered below so the
        // synchronous /talk-to caller actually unblocks.
        const skipPersist = req.body?.skip_persist === true;

        if (!message && !data) {
          return res.status(400).json({ error: 'Missing message or data' });
        }

        // If this is a reply to a query, look up the original query's team.
        // Design-doc delta (Phase 1): the queries table does not track which agent
        // endpoint received the original query, so we cannot verify the reply path
        // fully. Instead we apply a lighter constraint: only admin principals are
        // allowed to swing teams via in_reply_to. Non-admin callers (agents, anon)
        // may reply to queries within their own team only. If the query belongs to
        // a different team and the caller is not admin, we still deliver the news
        // to the caller's own team (the reply will be visible there) but we do NOT
        // follow the query across the team boundary.
        if (in_reply_to) {
          const queryTeamId = await this.db.queries.findTeam(in_reply_to);
          const principal = (req as any).ctx?.principal || 'anon';
          if (queryTeamId && queryTeamId !== teamId) {
            if (principal === 'admin') {
              // Admin may cross teams
              teamId = queryTeamId;
              this.managerLog(`Reply to ${in_reply_to} - admin team override to ${teamId}`);
            } else {
              // Non-admin: stay in own team; log that we skipped the cross-team swing
              this.managerLog(`Reply to ${in_reply_to} - non-admin caller; keeping team ${teamId} (query team ${queryTeamId})`);
            }
          } else if (queryTeamId && queryTeamId === teamId) {
            this.managerLog(`Reply to ${in_reply_to} - using query's team ${teamId}`);
          }
        }

        const newsType = type || (in_reply_to ? 'reply' : 'message');
        const newsMessage = message || data?.message || `${newsType} from ${from || 'unknown'}`;
        const ts = Date.now();

        // Store in news_items under the logical manager owner. The legacy
        // agent_id column is still populated for rollback compatibility, but
        // reads no longer depend on an agents-row stub existing.
        const teamRow = teamId
          ? await this.db.teams.getTeam(teamId).catch(() => null)
          : null;
        const resolvedTeamName = teamRow?.name ?? teamName ?? 'unknown';
        const managerInbox = this.getManagerInboxRef(teamId, resolvedTeamName);

        // Replies carry notify semantics (no further reply expected);
        // unsolicited inbound messages default to notify too. Dual-write
        // window: tag the row with owner_kind='manager'/owner_id=teamId so
        // the new ownership columns stay populated alongside the legacy
        // agent_id (= manager-<team>) without depending on the agent-id
        // prefix heuristic in the repo helper.
        if (!skipPersist) {
          await this.db.news.add(teamId, null, {
            timestamp: ts,
            type: newsType,
            message: newsMessage,
            data: { from, in_reply_to, message, ...data },
            query_id: in_reply_to || undefined,
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
        }

        // If this is a reply to a query, update the query status and resolve any waiting /talk-to.
        // Distinguish success ('reply') from agent-side failure ('reply.error') —
        // the latter is what claude-agent-server.ts sends from its /talk catch
        // block (see src/claude-agent-server.ts → sendReplyToSender, success=false).
        // We mark the row 'failed' instead of 'completed' and emit `query:failed`
        // instead of `query:delivered` so the wakeup-service event log carries
        // the real lifecycle transition. Audit finding #9
        // (output/security-review-wakeup-service.md).
        const isQueryFailure = newsType === 'reply.error' || type === 'reply.error';
        if (in_reply_to) {
          if (isQueryFailure) {
            const errorText =
              typeof message === 'string' && message.length > 0
                ? message
                : typeof data?.error === 'string'
                  ? data.error
                  : null;
            const transitioned = await this.db.queries.markFailed(teamId, in_reply_to, ts, errorText);
            if (transitioned) {
              const failedRow = await this.db.queries.getByQueryIdForTeam(teamId, in_reply_to).catch(() => null);
              await emitQueryFailed(this.db.events, {
                teamId,
                queryId: in_reply_to,
                agentId:
                  failedRow?.owner_kind === 'manager'
                    ? null
                    : failedRow?.agent_id ?? null,
                occurredAt: ts,
                reason: errorText,
              });
            }
            // Failure path still needs to wake long-poll and /talk-to waiters
            // so blocked callers don't hang waiting for a transition that
            // already happened.
            this.wakeQueryWaiters(teamId, in_reply_to, {
              from: from || 'unknown',
              message: message || '',
            });
          } else {
            // Single canonical completion lifecycle (queries.complete +
            // delivered event + waiter wakeups). Shared with POST
            // /manager/inbox/respond so both paths cannot drift.
            await this.completeQueryDelivery({
              teamId,
              queryId: in_reply_to,
              occurredAt: ts,
              resultPayload: { from, message, ...data },
              waiterReply: { from: from || 'unknown', message: message || '' },
              messagePreview: typeof message === 'string' ? message : null,
            });
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
        const recipientAgent = await this.db.agents.findInteractive(teamId);

        if (recipientAgent) {
          const recipient = recipientAgent;
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
                  trigger,
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
    // Preferred cursor: since_id=<monotonic id>&limit=N (server-side, ascending id).
    // Deprecated cursor: since=<ms-timestamp> — still accepted for one release,
    // with an X-Deprecated response header.
    this.managementApp.get('/news', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const hasSinceId = typeof req.query.since_id === 'string' && req.query.since_id !== '';
        const sinceId = hasSinceId ? parseInt(req.query.since_id as string) || 0 : 0;
        const since = parseInt(req.query.since as string) || 0;
        const limit = parseInt(req.query.limit as string) || 100;
        const query_id = req.query.query_id as string | undefined;

        if (!hasSinceId && typeof req.query.since === 'string') {
          res.setHeader(
            'X-Deprecated',
            'since=<ms> is deprecated; use since_id=<int> with the id field on each news item',
          );
        }

        const managerInbox = this.getManagerInboxRef(teamId, teamName);

        const newsRows = hasSinceId
          ? await this.db.news.pollSinceIdByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, sinceId, { limit, queryId: query_id })
          : await this.db.news.pollByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, since, { limit, queryId: query_id });

        const items = newsRows.map((r: any) => ({
          id: Number(r.id),
          type: r.type,
          timestamp: Number(r.timestamp),
          message: r.message || undefined,
          data: r.data || undefined
        }));

        const nextSinceId = hasSinceId && items.length > 0
          ? items[items.length - 1].id
          : undefined;

        res.json({
          items,
          timestamp: Date.now(),
          total: items.length,
          ...(nextSinceId !== undefined ? { next_since_id: nextSinceId } : {}),
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
        const items = await this.db.news.fetchForArchive(teamId, cutoffTimestamp);
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
        await this.db.news.deleteArchived(teamId, cutoffTimestamp);

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

    // Step 2 of the manager-collapse migration (docs/design/manager-collapse.md):
    // daemon-owned manager inbox APIs. Lets a CLI (or any team-scoped client)
    // read pending manager queries and post the manager's reply without
    // running its own InteractiveAgentServer process. Reuses the existing
    // queries.complete + emitQueryDelivered + waiter wakeup pipeline used
    // by POST /news so completion semantics stay identical.

    // GET /manager/inbox/pending — returns pending manager queries and
    // scheduled work for the active team. Source of truth is the daemon DB
    // (queries table under the resolved manager-inbox identity), not CLI
    // memory.
    this.managementApp.get('/manager/inbox/pending', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const rows = await this.db.queries.getPendingByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId);
        const pending = rows
          .map((row: any) => {
            const result = (row.result || {}) as Record<string, unknown>;
            return {
              query_id: row.query_id,
              prompt: row.prompt ?? null,
              message: row.prompt || (result.message as string | undefined) || '',
              timestamp: Number(row.created),
              status: row.status,
              session_id: row.session_id ?? null,
              from: (result.from as string | undefined) ?? null,
              reply_endpoint: (result.reply_endpoint as string | undefined) ?? null,
              schedule: (result.schedule as Record<string, unknown> | undefined) ?? null,
              mode: (result.mode as string | undefined) ?? null,
            };
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        res.json({
          ok: true,
          team: teamName,
          inbox_id: managerInbox.inboxApiId,
          count: pending.length,
          pending,
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /manager/inbox/pending:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /manager/inbox/respond — body: { query_id, message, session_id? }.
    // Preserves the visible response semantics that InteractiveAgentServer.respond
    // emits today: a news row of type `query.completed` with
    // `data: { query_id, result: { result: message } }`, and a queries-table
    // result of `{ result: message }`. The actual completion lifecycle
    // (queries.complete + query:delivered + waiter wakeups) routes through
    // `completeQueryDelivery` so it is the single shared implementation with
    // the POST /news in-reply-to path.
    this.managementApp.post('/manager/inbox/respond', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const body = (req.body || {}) as {
          query_id?: unknown;
          message?: unknown;
          session_id?: unknown;
        };

        const queryId = typeof body.query_id === 'string' ? body.query_id : '';
        const message = typeof body.message === 'string' ? body.message : '';
        const sessionId =
          typeof body.session_id === 'string' && body.session_id.length > 0
            ? body.session_id
            : null;

        if (!queryId) {
          return res.status(400).json({ error: 'Missing query_id' });
        }
        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
        if (!row) {
          return res.status(404).json({ error: 'query_not_found', query_id: queryId });
        }
        if (row.status !== 'pending' && row.status !== 'processing') {
          return res.status(409).json({
            error: 'query_not_pending',
            query_id: queryId,
            status: row.status,
          });
        }

        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        if (row.owner_kind !== managerInbox.ownerKind || row.owner_id !== managerInbox.ownerId) {
          // Pending row exists but isn't owned by the manager inbox — refuse
          // rather than silently completing some other agent's query.
          return res.status(403).json({
            error: 'not_manager_inbox_query',
            query_id: queryId,
          });
        }

        const ts = Date.now();
        // Same shape InteractiveAgentServer.respond writes: queries row stores
        // `{ result: <response text> }`, news row carries
        // `data: { query_id, result: { result: <response text> } }`, type
        // `query.completed`. session_id is folded into both when supplied so
        // resumed CLI sessions continue to work.
        const innerResult: Record<string, unknown> = { result: message };
        if (sessionId) innerResult.session_id = sessionId;
        const newsData: Record<string, unknown> = {
          query_id: queryId,
          result: { result: message },
        };
        if (sessionId) newsData.session_id = sessionId;

        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.completed',
          data: newsData,
          query_id: queryId,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        // Canonical completion lifecycle. Drives queries.complete +
        // query:delivered emission + long-poll/talk-to waiter wakeups so the
        // wakeup-service event log and any blocked callers see the same
        // transition the POST /news reply path produces.
        await this.completeQueryDelivery({
          teamId,
          queryId,
          occurredAt: ts,
          resultPayload: innerResult,
          waiterReply: { from: 'manager', message },
          messagePreview: message,
        });

        // Fan out to WebSocket subscribers using the same `query.completed`
        // shape the persisted news row carries.
        this.broadcastNews(teamId, {
          type: 'query.completed',
          message,
          in_reply_to: queryId,
          data: newsData,
          timestamp: ts,
        });

        this.managerLog(`/manager/inbox/respond completed query ${queryId}`);

        res.status(200).json({
          ok: true,
          query_id: queryId,
          status: 'completed',
          timestamp: ts,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /manager/inbox/respond:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // GET /query/:id - one-row lookup for a query's status/result
    // Team-scoped via the team header. Status is mapped to the external
    // vocabulary: { pending, processing, delivered, failed, expired }.
    //
    // Optional `?wait=<seconds>` (0–30, default 0) enables long-poll: if the
    // row is still pending/processing, the handler blocks until a waiter is
    // fired (daemon-side terminal transition) or the wait timeout elapses,
    // then re-reads and returns whatever the DB says.
    this.managementApp.get('/query/:id', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const queryId = req.params.id;

        const waitRaw = req.query.wait;
        let waitSec = 0;
        if (typeof waitRaw === 'string' && waitRaw.length > 0) {
          const parsed = Number.parseInt(waitRaw, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            waitSec = Math.min(parsed, 30);
          }
        }

        const statusMap: Record<string, string> = {
          pending: 'pending',
          processing: 'processing',
          completed: 'delivered',
          cancelled: 'failed',
          failed: 'failed',
          expired: 'expired',
        };
        const isTerminal = (s: string) =>
          s === 'completed' || s === 'delivered' || s === 'failed' || s === 'cancelled' || s === 'expired';

        let row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
        if (!row) return res.status(404).json({ error: `Query "${queryId}" not found` });

        if (waitSec > 0 && !isTerminal(row.status)) {
          const deadline = Date.now() + waitSec * 1000;
          // Register a single-shot waker and race it against the wait-deadline.
          let wake: () => void = () => {};
          const woke: Promise<void> = new Promise((resolve) => {
            wake = () => resolve();
            this.addQueryStatusWaiter(teamId, queryId, wake);
          });
          try {
            const remaining = deadline - Date.now();
            if (remaining > 0) {
              let timer: NodeJS.Timeout | null = null;
              const timeoutPromise = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, remaining);
              });
              await Promise.race([woke, timeoutPromise]);
              if (timer) clearTimeout(timer);
            }
          } finally {
            this.removeQueryStatusWaiter(teamId, queryId, wake);
          }
          row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
          if (!row) return res.status(404).json({ error: `Query "${queryId}" not found` });
        }

        const status = statusMap[row.status] || row.status;

        let agentName = 'manager';
        if (row.owner_kind !== 'manager' && row.agent_id) {
          agentName = row.agent_id;
          try {
            const agent = await this.db.agents.getById(row.agent_id);
            if (agent) {
              agentName = (agent.metadata as any)?.alias || agent.name || row.agent_id;
            }
          } catch { /* best-effort */ }
        }

        const response: Record<string, unknown> = {
          query_id: row.query_id,
          status,
          agent: agentName,
          created_at: Number(row.created),
        };
        if (row.completed !== null && row.completed !== undefined) {
          response.completed_at = Number(row.completed);
        }
        if (row.result !== null && row.result !== undefined) {
          response.result = row.result;
        }
        if (row.error) {
          response.error = row.error;
        }

        // Task 8: dispatch projection. When the queries row was written via
        // dispatch-routed /talk (carries a manager_dispatch_id from the
        // scheduler/cane path), sidecar-look-up the live dispatch doc so the
        // caller sees the canonical dispatch_status / agent_query_id without a
        // second round-trip.
        if (row.manager_dispatch_id && this.dispatchScheduler) {
          try {
            const doc = await this.dispatchScheduler.reactor.getByPhid(row.manager_dispatch_id);
            if (doc) {
              response.dispatch_id = doc.dispatch_phid;
              response.dispatch_status = doc.status;
              response.agent_query_id = doc.agent_query_id;
              response.manager_query_id = row.manager_query_id;
            }
          } catch (lookupErr) {
            // best-effort projection — log and fall through with the legacy shape
            console.warn(
              '[Manager] /query/:id dispatch projection lookup failed:',
              lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
            );
          }
        }

        res.json(response);
      } catch (err: any) {
        console.error('[Manager] Error in GET /query/:id:', err);
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
      const isAdmin = this.isAdminRequest(req);
      res.json({
        agents: agents.map(a => this.agentToResponse(a, { isAdmin }))
      });
    });

    // Resolve agent by identifier pattern (alias, ENS domain, tokenId@registry, etc.)
    // Returns warning if multiple agents match
    // NOTE: Must be defined BEFORE /agents/:id to avoid "resolve" matching as an id
    this.managementApp.get('/agents/resolve/:ref', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const ref = decodeURIComponent(req.params.ref);
      const isAdmin = this.isAdminRequest(req);

      if (ref.toLowerCase() === 'manager') {
        return res.status(404).json({ error: `No agent matches "${ref}"` });
      }

      try {
        const matches = await this.dbResolveAgents(teamId, ref);

        if (matches.length === 0) {
          return res.status(404).json({ error: `No agent matches "${ref}"` });
        }

        if (matches.length === 1) {
          return res.json({
            agent: this.agentToResponse(matches[0], { isAdmin }),
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
          agents: matches.map(a => this.agentToResponse(a, { isAdmin })),
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
      if (req.params.name.toLowerCase() === 'manager') {
        return res.status(404).json({ error: 'Agent not found' });
      }
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }));
    });

    this.managementApp.get('/agents/:id', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }));
    });

    // List all teams from database
    this.managementApp.get('/teams', async (req, res) => {
      const teams = await this.db.teams.listTeams();

      const teamList = await Promise.all(
        teams.map(async (team) => {
          const agentCount = await this.db.agents.count(team.id);
          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0'),
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
      const nameCheck = validateName(name, 'team');
      if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });
      try {
        const teamId = await this.db.teams.getOrCreateTeamId(name);

        // Create team directory
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) {
          mkdirSync(teamDir, { recursive: true });
        }

        const team = await this.db.teams.getTeam(teamId);
        if (!team) {
          return res.status(500).json({ error: 'Failed to create team' });
        }
        res.json({
          id: team.id,
          name: team.name,
          createdAt: team.created_at
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
        const team = await this.db.teams.getTeamByName(name);
        if (!team) {
          return res.status(404).json({ error: `Team "${name}" not found` });
        }

        res.json({ name: team.name, message: 'Port ranges are no longer used. Ports are allocated globally.' });
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

      if (name === 'default') {
        return res.status(400).json({ error: 'Cannot delete the "default" team — it is the fallback for all unscoped requests' });
      }

      try {
        // Find the team
        const team = await this.db.teams.getTeamByName(name);

        if (!team) {
          return res.status(404).json({ error: `Team "${name}" not found` });
        }

        const teamId = team.id;

        // NB: no `::text` cast — that's Postgres-only and breaks on SQLite.
        // COUNT(*) returns a number on both backends; parseInt tolerates both.
        const countResult = await this.db.adapter.query<{ count: string | number }>(
          'SELECT COUNT(*) as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
          [teamId]
        );
        const agentCount = parseInt(String(countResult.rows[0]?.count ?? '0'));

        if (agentCount > 0) {
          return res.status(400).json({
            error: `Team "${name}" still has ${agentCount} agent(s). Run /delete --team ${name} first to remove agents, then /team delete ${name} to remove the team.`
          });
        }

        // Delete the team
        await this.db.teams.deleteTeam(teamId);

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
      const teams = await this.db.teams.listTeamsWithConfig();

      const projectList = await Promise.all(
        teams.map(async (team) => {
          // Count agents in this team
          const agentCount = await this.db.agents.count(team.id);

          // Get registry info from config
          const config = team.config || {};
          const registryInfo = {
            chainId: (config as any).default_chain_id,
            registryAddress: (config as any).default_registry_address,
            registrarAddress: (config as any).registrar_address || (config as any).sepolia_registrar_address
          };

          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0'),
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
      const projNameCheck = validateName(name, 'team');
      if (!projNameCheck.valid) return res.status(400).json({ error: projNameCheck.error });

      try {
        // Create team in database (will auto-assign port range)
        const teamId = await this.db.teams.getOrCreateTeamId(name);

        // Get the created team details
        const team = await this.db.teams.getTeam(teamId);

        if (!team) {
          return res.status(500).json({ error: 'Failed to create project' });
        }

        res.json({
          id: team.id,
          name: team.name,
          createdAt: team.created_at
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

        const { name, type: agentType, model, runtime, allowedTools, pluginPath, plugins, skills, metadata: reqMetadata, local, agent, roleBody, heartbeat, openMode, workingDirectory: configWorkDir, verbose, dangerouslySkipPermissions, domain, tokenId, address } = req.body || {};
        const agentOverlay = agent;
        if (!name) return res.status(400).json({ error: 'Missing name' });
        const agentNameCheck = validateName(name, 'agent');
        if (!agentNameCheck.valid) return res.status(400).json({ error: agentNameCheck.error });

        // Local agent: runs locally using the selected runtime's auth flow
        const isLocalAgent = local === true || local === 'true';
        if (local !== undefined) {
          console.log(`[AgentManager] Spawn request: name=${name}, local=${local} (type: ${typeof local}), isLocalAgent=${isLocalAgent}`);
        }

        // Note: Duplicate names are allowed - agents are uniquely identified by their token ID (e.g., agent.42)

        // Runtime defaults to the shared runtime registry default
        if (runtime !== undefined && !isRuntimeId(runtime)) {
          return res.status(400).json({
            error: `Unknown runtime "${runtime}". Expected one of: ${getAvailableRuntimes().join(', ')}`
          });
        }

        // Remote-endpoint runtimes are registry-only — they are never spawned locally.
        if (runtime !== undefined && isRemoteEndpointRuntime(runtime)) {
          return res.status(400).json({
            error: 'runtime_not_spawnable',
            message: 'public-agent-remote is a remote endpoint runtime. Use POST /agents/register with customer_domain to register an externally-deployed agent.',
          });
        }

        const effectiveRuntime = resolveRuntime(runtime);

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
        const effectiveModel = model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
        this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

        // Create workspace directory first (needed for plugin copy)
        mkdirSync(workingDirectory, { recursive: true });

        // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
        if (agentOverlay) {
          copyLibraryAgentOverlay(workingDirectory, agentOverlay, effectiveRuntime);
        }

        // 2. Deploy team-level skills (runtime-aware: .claude/skills/ or .agents/skills/)
        if (skills && Array.isArray(skills) && skills.length > 0) {
          this.deploySkillsToAgent(workingDirectory, skills, {
            DISPLAY_NAME: domain || name,
            TEAM: teamName,
            ONCHAIN_IDENTITY: domain
              ? `Your onchain identity is your ENS domain: **${domain}**`
              : '',
            ORG_CONTEXT: '',
          }, { hasWallet: false, runtime: effectiveRuntime });
        }

        // 3. Overlay working-directory template files (runtime-aware)
        copyAgentDirOverlay(workingDirectory, name, effectiveRuntime);
        // Copy HEARTBEAT.md from template to working directory root
        copyHeartbeatMd(workingDirectory, name, effectiveRuntime);

        // 4. Write personality file: protocol defaults + agent role body.
        // For Codex/Cursor this is a marker-fenced framework block inside
        // workspace-root AGENTS.md so user edits and the agent persona block
        // (step 5) survive deploy/sync/rebuild refreshes.
        {
          const parts = [PROTOCOL_DEFAULTS];
          if (roleBody) parts.push(roleBody);
          writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
        }

        // 5. For Codex/Cursor, append the library persona to AGENTS.md
        // between marker fences (no-op for Claude; persona lives in
        // .claude/rules/ sidecar). Runs AFTER the framework write so the
        // marker block sits below the framework section.
        if (agentOverlay) {
          appendLibraryPersonaToAgentsMd(workingDirectory, agentOverlay, effectiveRuntime);
        }

        // Copy plugins to agent's working directory (agent owns its plugins)
        const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

        // Determine effective agent type (default to 'claude')
        const effectiveAgentType = agentType || 'claude';
        const isAutomator = effectiveAgentType === 'automator';
        const normalizedSkills = normalizeConfigSkills(skills);

        const metadata: AgentMetadata = {
          name,
          // Automators don't have REST-AP endpoints
          ...(isAutomator ? {} : { service_type: 'REST-AP', endpoint: '' }),
          runtime: effectiveRuntime,  // Store runtime for display/querying
          // Store config in metadata for later reference
          ...(reqMetadata?.description && { description: reqMetadata.description }),
          plugins: localPlugins, // Use local paths (agent owns its plugins)
          ...(agentOverlay && { agent: agentOverlay }),
          ...(normalizedSkills && { skills: normalizedSkills }),
          ...(allowedTools && { allowed_tools: allowedTools }),
          ...(isAutomator && { isAutomator: true }),
          // Flag that heartbeat is enabled (actual config read from HEARTBEAT.yaml)
          ...(heartbeat && { heartbeat: true }),
          ...(openMode !== undefined && { openMode: openMode === true || openMode === 'true' }),
          ...(dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: dangerouslySkipPermissions === true || dangerouslySkipPermissions === 'true' })
        };

        await this.db.agents.create({
          team_id: teamId,
          id,
          name,
          type: effectiveAgentType,
          model: effectiveModel,
          port: 0,
          endpoint: null,
          working_directory: workingDirectory,
          status: 'starting',
          created_at: Date.now(),
          metadata,
          api_key: null,
          token_id: tokenId || null,
          domain: domain || null,
          runtime: effectiveRuntime,
        });

        // Derive agent_account from request address, or fall back to shared deployer key
        const deployerAddress = this.getDeployerAddress();
        const agentAccount = address || deployerAddress;
        const updatedMeta = { ...metadata, ...(agentAccount && { agent_account: agentAccount }) };
        await this.db.agents.updateMetadata(id, updatedMeta);

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
        await this.db.agents.updateStatus(id, 'pending', {
          port: allocatedPort,
          endpoint: url,
          metadata: finalMeta,
        });

        // Use host paths for local agents
        // If configWorkDir is an absolute path, use it directly (project repo)
        const hostWorkspaceDir = process.env.ID_WORKSPACE_DIR || this.baseWorkDir;
        const hostWorkingDirectory = configWorkDir && path.isAbsolute(configWorkDir) ? configWorkDir : `${hostWorkspaceDir}/agents/${id}`;
        const hostSharedDirectory = `${hostWorkspaceDir}/teams/${teamName}`;

        // Seed heartbeat schedule if enabled
        if (heartbeat && this.schedulerService) {
          const { definition, agentIds } = heartbeatToSchedule(id, name, heartbeat);
          await this.schedulerService.seedSchedule(definition, agentIds);
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
        this.broadcastAgentsChanged(teamId, { reason: 'spawn', added: [name] });
      } catch (error: any) {
        // Ensure we never return Express's default HTML error page (CLI expects JSON).
        try {
          if (teamId && id) {
            await this.db.agents.updateStatus(id, 'error');
          }
        } catch {
          // ignore
        }

        res.status(500).json({ error: error?.message || String(error) });
      }
    });

    this.managementApp.post('/agents/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);

      // Branch: public-agent-remote registration (Phase 2)
      // A request with runtime==='public-agent-remote' registers an externally-deployed
      // agent as a registry entry. No port allocation, no process spawn, no well-known
      // fetch, no on-chain registration (those are Phase 3–5).
      if ((req.body as any)?.runtime === 'public-agent-remote') {
        const {
          name: remoteName,
          customer_domain,
          public_endpoint_url,
          internal_endpoint_url,
          ssh_target,
          wallet,
        } = req.body as any;

        // Required fields
        if (!remoteName) return res.status(400).json({ error: 'missing_field', message: 'name is required' });
        if (!customer_domain) return res.status(400).json({ error: 'missing_field', message: 'customer_domain is required' });
        if (!public_endpoint_url) return res.status(400).json({ error: 'missing_field', message: 'public_endpoint_url is required' });

        // Name validation
        const remoteNameCheck = validateName(remoteName, 'agent');
        if (!remoteNameCheck.valid) return res.status(400).json({ error: 'invalid_name', message: remoteNameCheck.error });

        // URL validation
        try { new URL(public_endpoint_url); } catch {
          return res.status(400).json({ error: 'invalid_url', message: 'public_endpoint_url must be a valid URL' });
        }
        if (internal_endpoint_url) {
          try { new URL(internal_endpoint_url); } catch {
            return res.status(400).json({ error: 'invalid_url', message: 'internal_endpoint_url must be a valid URL' });
          }
        }

        // Reject if name already exists in team
        const existing = await this.dbQueryAgentByNameMostRecent(teamId, remoteName);
        if (existing) {
          return res.status(409).json({ error: 'name_conflict', message: `Agent "${remoteName}" already exists in this team` });
        }

        const remoteId = `remote_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const now = Date.now();

        const remoteWalletOptIn = wallet === true;

        await this.db.agents.create({
          team_id: teamId,
          id: remoteId,
          name: remoteName,
          type: 'virtual',
          model: 'unknown',
          port: 0,
          endpoint: null,
          working_directory: null,
          status: 'registered',
          created_at: now,
          runtime: 'public-agent-remote',
          customer_domain: customer_domain,
          public_endpoint_url: public_endpoint_url,
          internal_endpoint_url: internal_endpoint_url ?? null,
          ssh_target: ssh_target ?? null,
          metadata: { wallet: remoteWalletOptIn },
        });

        return res.status(201).json({
          id: remoteId,
          name: remoteName,
          runtime: 'public-agent-remote',
          deploymentShape: 'remote-endpoint',
          status: 'registered',
          port: null,
          url: null,
          customer_domain,
          public_endpoint_url,
          internal_endpoint_url: internal_endpoint_url ?? null,
          ssh_target: ssh_target ?? null,
          metadata: { wallet: remoteWalletOptIn },
          health: 'unknown',
        });
      }

      const { id: requestedIdRaw, name, endpoint, metadata, type: requestedTypeRaw } = req.body || {};
      if (!name || !endpoint) return res.status(400).json({ error: 'Missing name or endpoint' });
      const regNameCheck = validateName(name, 'agent');
      if (!regNameCheck.valid) return res.status(400).json({ error: regNameCheck.error });

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
        await this.db.agents.softDelete(teamId, name, id, Date.now());
      }

      // Self-registration lands after spawnLocalAgentProcess already persisted
      // `pid` onto the row's metadata. Merge over the existing row so the pid
      // (and anything else a spawn-time path set) survives registration.
      const priorRow = await this.db.agents.getById(id).catch(() => null);
      const priorMeta = (priorRow?.metadata as Record<string, unknown>) || {};
      const meta: AgentMetadata = {
        ...priorMeta,
        name,
        service_type: (metadata && metadata.service_type) || 'REST-AP',
        endpoint,
        ...(metadata || {}),
        ...(typeof (priorMeta as { pid?: unknown }).pid === 'number'
          ? { pid: (priorMeta as { pid: number }).pid }
          : {}),
      };

      // Extract domain from request body if provided
      const reqDomain = (req.body as any).domain || null;

      await this.db.agents.upsert({
        team_id: teamId,
        id,
        name,
        type,
        model: 'external',
        port: 0,
        endpoint,
        working_directory: '',
        status: 'running',
        created_at: Date.now(),
        metadata: meta,
        domain: reqDomain,
      });

      // Set agent_account from shared deployer key for display/identity purposes
      let nextMeta = meta;
      if (!nextMeta.agent_account) {
        const deployerAddress = this.getDeployerAddress();
        if (deployerAddress) {
          nextMeta = { ...nextMeta, agent_account: deployerAddress };
          await this.db.agents.updateMetadata(id, nextMeta);
        }
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

      await this.db.agents.updateMetadata(agent.id, nextMetadata);

      // Agent self-publishing a pid is proof of life — flip status to running.
      // Without this, SQLite-mode deploys leave agents stuck on 'pending'
      // (the db-direct updateStatus path only runs when DATABASE_URL is set).
      const incomingPid = (metadata as { pid?: unknown } | undefined)?.pid;
      if (typeof incomingPid === 'number' && agent.status !== 'running') {
        await this.db.agents.updateStatus(agent.id, 'running');
      }

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

      await this.db.agents.updateMetadata(agent.id, nextMetadata);

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

      // ?redeliver=1 — re-push identity.json to remote VPS without re-running
      // the on-chain registration step (only meaningful for remote agents that
      // are already registered).
      const redeliver = req.query.redeliver === '1' || req.body?.redeliver === true;
      if (redeliver && isRemoteEndpointRuntime(agent.runtime)) {
        const idchainDomain = (agent.metadata as any)?.idchain_domain || agent.domain;
        if (!idchainDomain) {
          return res.status(400).json({ error: 'Agent is not yet registered on-chain. Cannot redeliver.' });
        }
        try {
          await this.stageAndDeliverRemoteIdentity(agent, idchainDomain, agent.token_id || '', agent.metadata as AgentMetadata || {});
          return res.json({ ok: true, redelivered: true, domain: idchainDomain, agent: { id: agent.id } });
        } catch (e: any) {
          return res.status(500).json({ error: e?.message || String(e) });
        }
      }

      try {
        const result = await this.registerOnchainAndUpdateAgent(teamId, agent);

        // Update CLAUDE.md with agent's full identity (local agents only)
        if (result.tokenId && agent.working_directory && !isRemoteEndpointRuntime(agent.runtime)) {
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

    // Redeliver identity file to remote VPS without re-running on-chain registration.
    this.managementApp.post('/agents/:id/onchain/redeliver-identity', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!isRemoteEndpointRuntime(agent.runtime)) {
        return res.status(400).json({ error: 'redeliver_not_supported', message: 'Only public-agent-remote agents support identity redelivery.' });
      }
      const idchainDomain = (agent.metadata as any)?.idchain_domain || agent.domain;
      if (!idchainDomain) {
        return res.status(400).json({ error: 'Agent is not yet registered on-chain. Cannot redeliver.' });
      }
      try {
        await this.stageAndDeliverRemoteIdentity(agent, idchainDomain, agent.token_id || '', agent.metadata as AgentMetadata || {});
        return res.json({ ok: true, redelivered: true, domain: idchainDomain, agent: { id: agent.id } });
      } catch (e: any) {
        return res.status(500).json({ error: e?.message || String(e) });
      }
    });

    this.managementApp.post('/agents/by-name/:name/onchain/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      try {
        const result = await this.registerOnchainAndUpdateAgent(teamId, agent);

        // Update CLAUDE.md with agent's full identity (local agents only)
        if (result.tokenId && agent.working_directory && !isRemoteEndpointRuntime(agent.runtime)) {
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
        return res.status(400).json({ error: 'Only local runtime-backed agents have models' });
      }

      try {
        // Update model in database - agent needs restart to pick up new model
        await this.db.agents.updateStatus(agent.id, 'pending', { model });

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

    // POST /agents/:id/probe — ad-hoc heartbeat probe for remote-endpoint agents
    this.managementApp.post('/agents/:id/probe', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        if (!isRemoteEndpointRuntime(agent.runtime)) {
          return res.status(400).json({ error: 'probe_only_supported_for_remote' });
        }

        await this.probeOneRemoteAgent(teamId, agent);
        // Re-fetch to get the updated values
        const updated = await this.dbQueryAgentById(teamId, agent.id);
        if (!updated) return res.status(404).json({ error: 'Agent not found after probe' });

        const health = this.deriveRemoteHealth(updated);
        res.json({
          ok: updated.consecutive_failures === 0,
          source: updated.last_error === 'health probe failed, well-known succeeded'
            ? 'well-known'
            : updated.consecutive_failures === 0 ? 'health' : 'none',
          last_seen: updated.last_seen ?? null,
          last_error: updated.last_error ?? null,
          consecutive_failures: updated.consecutive_failures ?? 0,
          health,
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? String(err) });
      }
    });

    // PATCH /agents/:id/metadata — update agent properties (wallet, name, etc.)
    this.managementApp.patch('/agents/:id/metadata', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const { wallet, name: newName } = req.body;
        const hasUpdates = wallet || newName;

        if (!hasUpdates) return res.status(400).json({ error: 'No updates provided' });

        if (wallet) {
          const metadata = { ...(agent.metadata as any || {}), wallet_address: wallet };
          await this.db.agents.updateMetadata(agent.id, metadata);
        }
        if (newName) {
          const nameCheck = validateName(newName, 'agent');
          if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });
          await this.db.agents.updateIdentity(agent.id, { name: newName });
        }

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
      await this.db.agents.deleteAgent(agent.id);
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
      this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [agent.name] });
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
      await this.db.agents.deleteAgent(agent.id);
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
      this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [agent.name] });
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

      // Optional: also spawn local runtime-backed agents (with HTTP servers) for onchain agents we discover.
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

            const isPublicAgentType = (ra.endpointType || '').toLowerCase() === 'public-agent';

            const metadata: any = {
              name: nameHint,
              service_type: ra.endpointType || 'REST-AP',
              endpoint: ra.endpoint,
              agent_account: ra.agentAccount,
              // Discovery-only semantics (Option A): public-agent identities are imported
              // as discovery records — visible in /agents but not routable via inter-agent
              // mesh. mesh_member:false + discovery_only:true signal this to operators.
              // The mesh-membership gate in handleMessage blocks routing without needing
              // a separate DB column (metadata flags are sufficient for Phase 6A).
              // TODO (Phase 6B): add --promote flag to the /registry/pull CLI command
              // so operators can opt a discovered public-agent into the mesh explicitly.
              // See design doc §6A.3 for discovery-only vs full-member semantics.
              ...(isPublicAgentType ? { mesh_member: false, discovery_only: true } : {}),
            };

            // If we already have this onchain agent locally (e.g., a spawned claude agent with the same tokenId),
            // merge into that record instead of creating a separate virtual duplicate.
            // TODO: move to repository — token_id-only lookup across types
            const existing = await this.db.adapter.query<{ id: string; type: string }>(
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
              const currentAgent = await this.db.agents.getById(existingId);
              const currentMeta = (currentAgent?.metadata || {}) as any;
              // When merging a public-agent type, preserve discovery-only flags.
              const mergedMeta = { ...currentMeta, ...metadata, name: currentMeta.name || metadata.name };
              if (isPublicAgentType) {
                mergedMeta.mesh_member = false;
                mergedMeta.discovery_only = true;
              }

              // TODO: move to repository — conditional endpoint update
              await this.db.adapter.query(
                `UPDATE agents
                 SET token_id = $3,
                     metadata = $4,
                     endpoint = CASE WHEN $5 = 'virtual' THEN $6 ELSE endpoint END,
                     deleted_at = NULL
                 WHERE team_id = $1 AND id = $2`,
                [teamId, existingId, tokenId, mergedMeta, existingType, ra.endpoint || null]
              );

              // TODO: move to repository — delete virtual agent by id with type guard
              const onchainId = `onchain_${chainId}_${regAddr}_${tokenId}`;
              await this.db.adapter.query(`DELETE FROM agents WHERE team_id = $1 AND id = $2 AND type = 'virtual'`, [
                teamId,
                onchainId
              ]);

              discovery.upserted += 1;
              continue;
            }

            // Otherwise upsert as a stable virtual id
            const id = `onchain_${chainId}_${regAddr}_${tokenId}`;
            await this.db.agents.upsert({
              team_id: teamId,
              id,
              name: nameHint,
              type: 'virtual',
              model: 'external',
              port: 0,
              endpoint: ra.endpoint || null,
              working_directory: '',
              status: 'running',
              created_at: Date.now(),
              metadata,
              token_id: tokenId,
              runtime: isPublicAgentType ? 'public-agent-remote' : 'claude-agent-sdk',
            });
            discovery.upserted += 1;
          } catch (e: any) {
            discovery.errors.push(`agent ${agentId}: ${e?.message || String(e)}`);
          }
        }
      } catch (e: any) {
        discovery.errors.push(`discovery: ${e?.message || String(e)}`);
      }

      // Optional: spawn local runtime-backed agents for the onchain entries (so they have HTTP servers).
      // NOTE: This does NOT try to contact the remote endpoint; it creates local agents that represent the onchain identities.
      if (spawnServers && discoveredOnchain.length > 0) {
        try {
          const defaultModel = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
          const sharedDirectory = `${this.baseWorkDir}/teams/${teamName}`;
          let spawned = 0;

          // Spawn local runtime-backed agents for the agents we just pulled

          for (const agent of discoveredOnchain) {
            const tokenId = agent.tokenId;

            // Never spawn a local runtime-backed copy for an interactive agent already linked to this token.
            const interactiveAgent = await this.db.agents.findByRegistry(
              teamId, String(agent.chainId), String(agent.registryAddress), tokenId
            );
            if (interactiveAgent && interactiveAgent.type === 'interactive') continue;

            // If a local runtime-backed agent already exists for this token, ensure its server is running.
            const existingClaudeAgent = await this.db.agents.findByRegistry(
              teamId, String(agent.chainId), String(agent.registryAddress), tokenId
            );
            if (existingClaudeAgent && existingClaudeAgent.type === 'claude') {
              const a = existingClaudeAgent;
              const key = this.key(teamId, a.id);
              if (!this.runningServers.get(key)) {
                try {
                  const workingDirectory = a.working_directory || `${this.baseWorkDir}/agents/${a.id}`;
                  if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });
                  const server = new AgentRestServer({
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

            // Create and start a new local runtime-backed agent representing this onchain identity.
            const claudeId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const port = await this.dbNextPort(teamId);
            const workingDirectory = `${this.baseWorkDir}/agents/${claudeId}`;
            if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

            const nameHint = agent.nameHint;

            // Ensure handle uniqueness (keep handles stable and unique even if onchain display names collide)
            let handle = nameHint;
            const existingByName = await this.db.agents.getByName(teamId, handle);
            if (existingByName) {
              handle = `${nameHint}_${tokenId}`;
            }

            let metadata: AgentMetadata = {
              name: handle,
              service_type: 'REST-AP',
              endpoint: `http://localhost:${port}`
            };

            await this.db.agents.create({
              team_id: teamId,
              id: claudeId,
              name: handle,
              type: 'claude',
              model: defaultModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              token_id: tokenId,
            });

            const deployerAddress = this.getDeployerAddress();
            let finalMeta = metadata;
            if (deployerAddress) {
              finalMeta = { ...metadata, agent_account: deployerAddress };
              await this.db.agents.updateMetadata(claudeId, finalMeta);
            }

            const server = new AgentRestServer({
              model: defaultModel,
              workingDirectory,
              sharedDirectory,
              agentName: handle,
              agentIdentity: { name: handle, network: teamName, tokenId, metadata: finalMeta },
              db: { db: this.db, teamId: teamId, agentId: claudeId }
            });
            await server.start(port);
            this.runningServers.set(this.key(teamId, claudeId), server);
            await this.db.agents.updateStatus(claudeId, 'running');

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

          await this.db.agents.updateMetadata(agent.id, nextMetadata);

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

      const { command, from } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'Missing command in request body' });
      }

      const { id: teamId, name: teamName } = await this.getTeam(req);

      try {
        const result = await this.executeRemoteCommand(command.trim(), teamId, teamName, typeof from === 'string' ? from : undefined);
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Command execution failed' });
      }
    });

    // Handle /:tokenId without trailing path - returns agent info
    // NOTE: Must be defined BEFORE the wildcard route to take precedence.
    // Non-numeric paths pass through to allow downstream routes (tasks, etc.) to match.
    this.managementApp.get('/:tokenId', async (req, res, next) => {
      const tokenIdParam = req.params.tokenId;

      // Only handle numeric tokenIds; pass all others to downstream routes
      if (!/^\d+$/.test(tokenIdParam)) {
        return next();
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
        agent: this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }),
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
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Accept': req.headers['accept'] || 'application/json'
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

    // ==================== TASK REST ENDPOINTS ====================
    // Dedicated task API so agents don't need /remote for task ops

    this.managementApp.post('/tasks', async (req, res) => {
      try {
        let { id: teamId } = await this.getTeam(req);
        const principal = (req as any).ctx?.principal || 'anon';
        const { title, name: rawName, description, team: teamRef, from } = req.body || {};

        if (!title || typeof title !== 'string') {
          return res.status(400).json({ error: 'Missing required field: title' });
        }

        // Resolve created_by from `from` field first so we can recover the
        // caller's team when no explicit team header was supplied. This lets
        // a deployed agent in a non-default team create a task under its own
        // name using the documented protocol (no team header, just `from`).
        let createdBy: string | null = null;
        let callerAgent: AgentRow | undefined;
        if (from && typeof from === 'string') {
          const first = await this.resolveSingleAgentForCommand(teamId, from);
          callerAgent = first.agent;
          if (!callerAgent && !this.isTeamExplicit(req) && !teamRef) {
            const fallback = await this.resolveCallerAcrossTeams(from);
            if (fallback) {
              callerAgent = fallback.agent;
              teamId = fallback.teamId;
            }
          }
          if (callerAgent) createdBy = callerAgent.id;
        }

        // Resolve team — non-admin principals cannot create tasks in another team
        let taskTeamId: string = teamId;
        if (teamRef) {
          const teamRow = await this.db.teams.getTeamByName(teamRef);
          if (!teamRow) return res.status(404).json({ error: `Team "${teamRef}" not found` });
          if (teamRow.id !== teamId && principal !== 'admin') {
            return res.status(403).json({ error: 'Cannot create task in another team without admin principal' });
          }
          taskTeamId = teamRow.id;
        }

        // Generate or validate name slug, scoped to (team_id, name) uniqueness
        let name = rawName ? normalizeAlias(rawName) : normalizeAlias(title);
        if (rawName) {
          if (await this.db.tasks.getByNameForTeam(name, taskTeamId)) {
            return res.status(409).json({ error: `Task name "${name}" already exists in this team` });
          }
        } else {
          let candidate = name;
          let suffix = 1;
          while (await this.db.tasks.getByNameForTeam(candidate, taskTeamId)) {
            candidate = `${name}-${suffix++}`;
          }
          name = candidate;
        }

        const now = Math.floor(Date.now() / 1000);
        const taskRow: TaskRow = {
          id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name,
          uuid: crypto.randomUUID(),
          team_id: taskTeamId,
          title,
          description: description || null,
          status: 'todo',
          created_by: createdBy,
          owner: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        };

        await this.db.tasks.create(taskRow);
        res.status(201).json({ ok: true, task: await this.buildTaskResult(taskRow, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/tasks', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { status, owner, team: teamRef } = req.query as Record<string, string>;

        // Resolve owner
        let ownerIdFilter: string | undefined;
        if (owner) {
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${owner}" not found` });
          ownerIdFilter = agent.id;
        }

        // Resolve team — default to current team for scoped resolution
        let teamIdFilter: string = teamId;
        if (teamRef) {
          const teamRow = await this.db.teams.getTeamByName(teamRef);
          if (!teamRow) return res.status(404).json({ error: `Team "${teamRef}" not found` });
          teamIdFilter = teamRow.id;
        }

        const validStatuses = ['todo', 'doing', 'done'];
        const tasks = await this.db.tasks.list({
          status: status && validStatuses.includes(status) ? status as 'todo' | 'doing' | 'done' : undefined,
          owner: ownerIdFilter,
          teamId: teamIdFilter,
        });

        const results = [];
        for (const t of tasks) {
          results.push(await this.buildTaskResult(t, teamId));
        }
        res.json({ ok: true, tasks: results });
      } catch (err: any) {
        console.error('[Manager] Error in GET /tasks:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/tasks/:ref', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { task, error } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: error || `Task "${req.params.ref}" not found` });
        res.json({ ok: true, task: await this.buildTaskResult(task, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in GET /tasks/:ref:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/tasks/:ref/claim', async (req, res) => {
      try {
        let { id: teamId } = await this.getTeam(req);
        const { agent_id, from } = req.body || {};
        const callerRef = agent_id || from;

        if (!callerRef || typeof callerRef !== 'string') {
          return res.status(400).json({ error: 'Missing required field: agent_id (or from)' });
        }

        // Resolve the caller first so we can recover the caller's team when
        // the request omitted the X-Id-Team header. A deployed agent whose
        // CLAUDE.md follows `POST $MANAGER_URL/tasks/<name>/claim` with just
        // `{ agent_id }` would otherwise hit the manager's default team and
        // get "agent not found" even though the agent is registered in its
        // own team. The fallback only runs when the caller didn't specify a
        // team explicitly, so cross-team guards still hold for explicit
        // requests.
        let { agent, error } = await this.resolveSingleAgentForCommand(teamId, callerRef);
        if (!agent && !this.isTeamExplicit(req)) {
          const fallback = await this.resolveCallerAcrossTeams(callerRef);
          if (fallback) {
            agent = fallback.agent;
            teamId = fallback.teamId;
          }
        }
        if (!agent) return res.status(404).json({ error: error || `Agent "${callerRef}" not found` });

        const { task, error: taskError } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: taskError || `Task "${req.params.ref}" not found` });

        // Guard against cross-team claim
        if (task.team_id && task.team_id !== teamId) {
          return res.status(404).json({ error: `Task "${req.params.ref}" not found` });
        }

        const now = Math.floor(Date.now() / 1000);
        const claimed = await this.db.tasks.claim(task.id, agent.id, now);
        if (!claimed) {
          return res.status(409).json({ error: `Cannot claim "${task.name}" — already owned or not in todo status` });
        }

        const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
        await emitTaskClaimed(this.db.events, {
          teamId,
          taskUuid: updated!.uuid,
          taskName: updated!.name,
          title: updated!.title,
          ownerAgentId: agent.id,
          occurredAt: Date.now(),
        });
        res.json({ ok: true, task: await this.buildTaskResult(updated!, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks/:ref/claim:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/tasks/:ref/done', async (req, res) => {
      try {
        let { id: teamId } = await this.getTeam(req);
        const { agent_id, from } = req.body || {};
        const callerRef = agent_id || from;

        // Mirror the claim endpoint: when a caller is supplied without an
        // explicit team header, recover the caller's team so agents in
        // non-default teams can mark their own tasks done via the default
        // protocol (`POST $MANAGER_URL/tasks/<name>/done { agent_id }`).
        let callerAgent: AgentRow | undefined;
        if (callerRef && typeof callerRef === 'string') {
          const first = await this.resolveSingleAgentForCommand(teamId, callerRef);
          callerAgent = first.agent;
          if (!callerAgent && !this.isTeamExplicit(req)) {
            const fallback = await this.resolveCallerAcrossTeams(callerRef);
            if (fallback) {
              callerAgent = fallback.agent;
              teamId = fallback.teamId;
            }
          }
        }

        const { task, error: taskError } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: taskError || `Task "${req.params.ref}" not found` });

        // Guard against cross-team done
        if (task.team_id && task.team_id !== teamId) {
          return res.status(404).json({ error: `Task "${req.params.ref}" not found` });
        }

        // If caller identifies themselves, enforce ownership
        if (callerAgent && task.owner !== callerAgent.id) {
          return res.status(403).json({ error: `Agent "${callerRef}" is not the owner of task "${task.name}"` });
        }

        const updated = await this.closeTaskAndCascade({
          task,
          teamId,
          actorAgentId: callerAgent?.id ?? null,
        });
        res.json({ ok: true, task: await this.buildTaskResult(updated, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks/:ref/done:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.delete('/tasks/:ref', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { task, error } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: error || `Task "${req.params.ref}" not found` });
        await this.db.tasks.delete(task.id);
        res.json({ ok: true, removed: task.name });
      } catch (err: any) {
        console.error('[Manager] Error in DELETE /tasks/:ref:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // ==================== WAKEUP SERVICE: GET /events ====================
    // Catch-up read over the team-scoped event log. Wire-format and
    // semantics are defined in output/wakeup-service-design.md
    // ("`GET /events`" section). Auth/team gating is the same as /remote
    // (handled by teamContextMiddleware → getTeam(req)). Producers and
    // SSE/webhook delivery land in separate slices.
    this.managementApp.get('/events', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);

        // since: default 0, must be a non-negative integer.
        const sinceRaw = req.query.since;
        let since = 0;
        if (sinceRaw !== undefined) {
          const parsed = Number(sinceRaw);
          if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
            return res.status(400).json({
              error: 'invalid_since',
              message: '`since` must be a non-negative integer',
            });
          }
          since = parsed;
        }

        // limit: default 100, hard cap 1000, must be a positive integer.
        const limitRaw = req.query.limit;
        let limit = 100;
        if (limitRaw !== undefined) {
          const parsed = Number(limitRaw);
          if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
            return res.status(400).json({
              error: 'invalid_limit',
              message: '`limit` must be a positive integer',
            });
          }
          limit = Math.min(parsed, 1000);
        }

        // topics: optional CSV; alias expansion happens server-side so
        // callers can request `query:terminal` instead of the three
        // concrete topics it covers.
        let topics: string[] | undefined;
        const topicsRaw = req.query.topics;
        if (typeof topicsRaw === 'string' && topicsRaw.length > 0) {
          const requested = topicsRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (requested.length > 0) {
            topics = expandTopicAliases(requested);
          }
        }

        const rows = await this.db.events.query({
          teamId,
          sinceSeq: since,
          topics,
          limit,
        });
        const earliestAvailableSeq = await this.db.events.earliestSeq(teamId);

        const events = rows.map((row) => ({
          seq: row.seq,
          team: teamName,
          topic: row.topic,
          occurred_at: row.occurred_at,
          actor: row.actor_agent_id,
          subject:
            row.subject_kind === null && row.subject_id === null
              ? null
              : { kind: row.subject_kind, id: row.subject_id },
          data: row.data,
        }));

        const nextSeq = events.length > 0
          ? events[events.length - 1].seq
          : since;

        // replay_truncated: the consumer's cursor predates retained
        // history. `since` is an exclusive cursor, so the consumer next
        // expects `since + 1`; truncation is true only when that next
        // expected seq is strictly less than the earliest retained seq.
        // An empty log (earliestAvailableSeq === null) is never truncated.
        const replayTruncated =
          earliestAvailableSeq !== null && since + 1 < earliestAvailableSeq;

        res.json({
          events,
          next_seq: nextSeq,
          replay_truncated: replayTruncated,
          earliest_available_seq: earliestAvailableSeq,
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /events:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // ==================== CHECKINS API ====================
    // Wire-format and semantics: output/checkin-primitive-design.md.
    // Auth/team gating matches /remote and /events: teamContextMiddleware
    // resolves the team from X-Id-Team and the principal (admin/agent/anon).
    // Event emission (checkin:created/closed/snoozed) is owned by the
    // separate `checkin-events` slice and is not wired here.

    this.managementApp.post('/checkins', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const body = req.body || {};

        // owner: optional. When provided, must resolve to an agent in this team.
        let ownerAgentId: string | null = null;
        let ownerName: string | null = null;
        if (body.owner !== undefined && body.owner !== null) {
          if (typeof body.owner !== 'string') {
            return res.status(400).json({ error: 'invalid_owner' });
          }
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, body.owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${body.owner}" not found` });
          ownerAgentId = agent.id;
          ownerName = (agent.metadata as any)?.alias || agent.name;
        }

        // linked_task: optional but enforces same-team via resolveTaskRef.
        // Reject creation when the linked task is already in a terminal status
        // ('done' is the only terminal status today). Without this guard the
        // row would be created with a future next_fire_at and then immediately
        // auto-closed by closeLinkedCheckinsForTerminalTask on the next task
        // event, leaving a confusing closed-with-no-fires audit trail.
        let linkedTaskId: string | null = null;
        let linkedTaskRow: TaskRow | undefined;
        if (body.linked_task !== undefined && body.linked_task !== null) {
          if (typeof body.linked_task !== 'string') {
            return res.status(400).json({ error: 'invalid_linked_task' });
          }
          const { task, error } = await this.resolveTaskRef(body.linked_task, teamId);
          if (!task) return res.status(404).json({ error: error || `Task "${body.linked_task}" not found` });
          if (task.status === 'done') {
            return res.status(409).json({ error: 'linked_task_terminal', task_status: task.status });
          }
          linkedTaskId = task.id;
          linkedTaskRow = task;
        }

        // interval: default 15m
        let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
        if (body.interval !== undefined) {
          const parsed = parseDurationSeconds(body.interval);
          if (parsed === null) {
            return res.status(400).json({ error: 'invalid_interval' });
          }
          intervalSeconds = parsed;
        }

        // priority: default normal
        let priority: 'low' | 'normal' | 'high' = 'normal';
        if (body.priority !== undefined) {
          if (!isValidPriority(body.priority)) {
            return res.status(400).json({ error: 'invalid_priority' });
          }
          priority = body.priority;
        }

        // close_when: default { task_status: ['done'] }
        let closeWhen = DEFAULT_CLOSE_WHEN;
        if (body.close_when !== undefined) {
          if (!body.close_when || typeof body.close_when !== 'object' || Array.isArray(body.close_when)) {
            return res.status(400).json({ error: 'invalid_close_when' });
          }
          closeWhen = body.close_when as Record<string, unknown>;
        }

        // max_iterations: optional positive int
        let maxIterations: number | null = null;
        if (body.max_iterations !== undefined && body.max_iterations !== null) {
          const n = Number(body.max_iterations);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_max_iterations' });
          }
          maxIterations = n;
        }

        // ttl: optional duration → ttl_expires_at = now + ttl
        let ttlExpiresAt: number | null = null;
        const nowMs = Date.now();
        if (body.ttl !== undefined && body.ttl !== null) {
          const ttl = parseDurationSeconds(body.ttl);
          if (ttl === null) {
            return res.status(400).json({ error: 'invalid_ttl' });
          }
          ttlExpiresAt = nowMs + ttl * 1000;
        }

        // snooze_until: explicit unix-ms cursor. Mutually exclusive with the
        // computed initial next_fire_at.
        let snoozeUntil: number | null = null;
        let initialStatus: 'active' | 'snoozed' = 'active';
        let nextFireAt: number | null = nowMs + intervalSeconds * 1000;
        if (body.snooze_until !== undefined && body.snooze_until !== null) {
          const n = Number(body.snooze_until);
          if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_snooze_until' });
          }
          snoozeUntil = n;
          nextFireAt = n;
          initialStatus = 'snoozed';
        }

        const note = clampNote(body.note);

        const row: CheckinRow = {
          id: generateCheckinId(nowMs),
          team_id: teamId,
          owner_agent_id: ownerAgentId,
          created_by_agent_id: ownerAgentId,
          linked_task_id: linkedTaskId,
          interval_seconds: intervalSeconds,
          priority,
          status: initialStatus,
          close_when: closeWhen,
          max_iterations: maxIterations,
          iteration_count: 0,
          next_fire_at: nextFireAt,
          snooze_until: snoozeUntil,
          ttl_expires_at: ttlExpiresAt,
          last_fire_at: null,
          last_event_seq: null,
          note,
          created_at: nowMs,
          updated_at: nowMs,
          closed_at: null,
          closed_reason: null,
        };

        try {
          await this.db.checkins.create(row);
        } catch (err: any) {
          if (typeof err?.message === 'string' && err.message.includes('different team')) {
            return res.status(409).json({ error: 'cross_team_linked_task' });
          }
          throw err;
        }

        const linkedTask = linkedTaskRow
          ? await this.buildTaskResult(linkedTaskRow, teamId)
          : null;
        res.status(201).json({
          ok: true,
          checkin: buildCheckinResponse(row, { ownerName, linkedTask }),
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/checkins', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const q = req.query as Record<string, string | undefined>;

        let ownerAgentId: string | undefined;
        if (q.owner) {
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, q.owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${q.owner}" not found` });
          ownerAgentId = agent.id;
        }

        let linkedTaskId: string | undefined;
        if (q.linked_task) {
          const { task, error } = await this.resolveTaskRef(q.linked_task, teamId);
          if (!task) return res.status(404).json({ error: error || `Task "${q.linked_task}" not found` });
          linkedTaskId = task.id;
        }

        const statusFilter = parseStatusFilter(q.status);
        if (statusFilter === null) {
          return res.status(400).json({ error: 'invalid_status' });
        }

        let dueBefore: number | undefined;
        if (q.due_before !== undefined) {
          const n = Number(q.due_before);
          if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'invalid_due_before' });
          }
          dueBefore = n;
        }

        let limit: number | undefined;
        if (q.limit !== undefined) {
          const n = Number(q.limit);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_limit' });
          }
          limit = n;
        }

        const rows = await this.db.checkins.list({
          teamId,
          owner: ownerAgentId,
          linkedTaskId,
          status: statusFilter.length > 0 ? statusFilter : undefined,
          dueBefore,
          limit,
        });

        // Resolve owner names so GET returns the same `owner` shape as POST.
        // Cache lookups across rows since the same owner often recurs.
        const ownerNameCache = new Map<string, string | null>();
        const resolveOwnerName = async (agentId: string | null): Promise<string | null> => {
          if (!agentId) return null;
          if (ownerNameCache.has(agentId)) return ownerNameCache.get(agentId)!;
          const agent = await this.db.agents.getById(agentId).catch(() => null);
          const name = agent ? ((agent.metadata as any)?.alias || agent.name) : null;
          ownerNameCache.set(agentId, name);
          return name;
        };
        const checkins = await Promise.all(
          rows.map(async (row) => buildCheckinResponse(row, {
            ownerName: await resolveOwnerName(row.owner_agent_id),
          })),
        );
        res.json({ ok: true, checkins });
      } catch (err: any) {
        console.error('[Manager] Error in GET /checkins:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.delete('/checkins/:id', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const principal = (req as any).ctx?.principal || 'anon';
        if (principal !== 'admin') {
          return res.status(403).json({ error: 'admin_required' });
        }
        const removed = await this.db.checkins.delete(req.params.id, teamId);
        if (!removed) return res.status(404).json({ error: 'checkin_not_found' });
        res.json({ ok: true, removed: req.params.id });
      } catch (err: any) {
        console.error('[Manager] Error in DELETE /checkins/:id:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/checkins/:id/close', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const reason =
          typeof req.body?.reason === 'string' && req.body.reason.length > 0
            ? req.body.reason
            : 'manual';
        const closedAt = Date.now();

        const transitioned = await this.db.checkins.close(req.params.id, teamId, closedAt, reason);
        const row = await this.db.checkins.get(req.params.id, teamId);
        if (!row) return res.status(404).json({ error: 'checkin_not_found' });

        const ownerName = await this.resolveAgentNameById(row.owner_agent_id);
        res.json({
          ok: true,
          alreadyClosed: !transitioned,
          checkin: buildCheckinResponse(row, { ownerName }),
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins/:id/close:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/checkins/:id/snooze', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const body = req.body || {};
        if (body.duration === undefined || body.duration === null) {
          return res.status(400).json({ error: 'missing_duration' });
        }
        const seconds = parseDurationSeconds(body.duration);
        if (seconds === null) {
          return res.status(400).json({ error: 'invalid_duration' });
        }

        const existing = await this.db.checkins.get(req.params.id, teamId);
        if (!existing) return res.status(404).json({ error: 'checkin_not_found' });
        if (existing.status === 'closed' || existing.status === 'expired') {
          return res.status(409).json({ error: 'checkin_terminal' });
        }

        const nowMs = Date.now();
        const snoozeUntil = nowMs + seconds * 1000;
        await this.db.checkins.updateFields(req.params.id, teamId, {
          status: 'snoozed',
          snooze_until: snoozeUntil,
          next_fire_at: snoozeUntil,
          updated_at: nowMs,
        });
        const row = await this.db.checkins.get(req.params.id, teamId);
        const ownerName = await this.resolveAgentNameById(row!.owner_agent_id);
        res.json({ ok: true, checkin: buildCheckinResponse(row!, { ownerName }) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins/:id/snooze:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

  }

  /**
   * Resolve an agent's display name (alias or `agents.name`) from its id, or
   * `null` if the row is missing. Swallows errors so a transient lookup
   * failure does not break the response envelope.
   */
  private async resolveAgentNameById(agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const agent = await this.db.agents.getById(agentId).catch(() => null);
    if (!agent) return null;
    return (agent.metadata as any)?.alias || agent.name;
  }

  /**
   * Probe a list of agents by enqueueing a tiny `/talk` query and then
   * waiting for that query to reach a terminal state on `/query/:id`.
   * This is intentionally end-to-end: a 202 Accepted from `/talk` alone
   * is not enough because the harness can still fail later (for example,
   * when the underlying CLI returns an auth error on every dispatch).
   */
  private async probeAgentsViaTalk(
    teamName: string,
    agents: AgentRow[],
  ): Promise<{
    ok: true;
    result: {
      team: string;
      probed: number;
      passed: number;
      failed: number;
      results: Array<
        { name: string; status: 'ok'; duration_ms: number }
        | { name: string; status: 'failed'; error: string; duration_ms: number }
      >;
    };
  }> {
    const PER_AGENT_TIMEOUT_MS = 30_000;
    const CONCURRENCY = 8;
    const POLL_INTERVAL_MS = 200;

    type ProbeResult =
      | { name: string; status: 'ok'; duration_ms: number }
      | { name: string; status: 'failed'; error: string; duration_ms: number };

    const toErrorString = (status: number, bodyText: string): string => (
      bodyText ? `${status}: ${bodyText}` : `${status}`
    );
    const parseJson = (raw: string): any | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const probeOne = async (agent: AgentRow): Promise<ProbeResult> => {
      const start = Date.now();
      const base = (agent.endpoint || (agent.port ? `http://localhost:${agent.port}` : '')).replace(/\/+$/, '');
      const displayName = (agent.metadata as any)?.alias || agent.name;
      if (!base) {
        return { name: displayName, status: 'failed', error: 'no_endpoint', duration_ms: Date.now() - start };
      }

      const deadline = start + PER_AGENT_TIMEOUT_MS;
      const remainingMs = () => Math.max(0, deadline - Date.now());
      const talkUrl = `${base}/talk`;

      try {
        const talkResp = await fetch(talkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'reply with OK', from: 'probe' }),
          signal: AbortSignal.timeout(Math.max(1, remainingMs())),
        });

        // Parse the full body so /query/:id responses (which can exceed 200
        // chars once result.messages[] / sessionId / timestamps are included)
        // round-trip cleanly. Only truncate when surfacing the body in an
        // error string.
        const talkText = await talkResp.text().catch(() => '');
        const talkBody = parseJson(talkText);

        if (!talkResp.ok) {
          let bodyText = '';
          if (talkBody && typeof talkBody === 'object' && typeof talkBody.error === 'string') {
            bodyText = talkBody.error;
          } else {
            bodyText = talkText.slice(0, 200);
          }
          return {
            name: displayName,
            status: 'failed',
            error: toErrorString(talkResp.status, bodyText),
            duration_ms: Date.now() - start,
          };
        }

        const queryId = talkBody?.query_id || talkBody?.queryId;
        if (!queryId) {
          const bodyText = typeof talkBody?.message === 'string'
            ? talkBody.message
            : talkText.slice(0, 200);
          if (bodyText) {
            return { name: displayName, status: 'ok', duration_ms: Date.now() - start };
          }
          return {
            name: displayName,
            status: 'failed',
            error: 'missing query_id from /talk response',
            duration_ms: Date.now() - start,
          };
        }

        const queryUrl = `${base}/query/${encodeURIComponent(String(queryId))}`;
        while (remainingMs() > 0) {
          const queryResp = await fetch(queryUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs(), 1_000))),
          });

          const queryText = await queryResp.text().catch(() => '');
          const queryBody = parseJson(queryText);

          if (!queryResp.ok) {
            const bodyText = typeof queryBody?.error === 'string'
              ? queryBody.error
              : queryText.slice(0, 200);
            return {
              name: displayName,
              status: 'failed',
              error: toErrorString(queryResp.status, bodyText),
              duration_ms: Date.now() - start,
            };
          }

          const queryStatus = queryBody?.status;
          if (queryStatus === 'completed') {
            return { name: displayName, status: 'ok', duration_ms: Date.now() - start };
          }
          if (queryStatus === 'failed') {
            const error = typeof queryBody?.error === 'string' && queryBody.error.trim()
              ? queryBody.error
              : 'query failed';
            return { name: displayName, status: 'failed', error, duration_ms: Date.now() - start };
          }

          await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs())));
        }

        return { name: displayName, status: 'failed', error: 'timeout', duration_ms: Date.now() - start };
      } catch (err: any) {
        const duration_ms = Date.now() - start;
        const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
        const error = isTimeout ? 'timeout' : (err?.message ? String(err.message) : String(err));
        return { name: displayName, status: 'failed', error, duration_ms };
      }
    };

    const results: ProbeResult[] = new Array(agents.length);
    let next = 0;
    const workerCount = Math.min(CONCURRENCY, agents.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= agents.length) return;
        results[idx] = await probeOne(agents[idx]);
      }
    });
    await Promise.all(workers);

    const passed = results.filter((r) => r.status === 'ok').length;
    return {
      ok: true,
      result: {
        team: teamName,
        probed: results.length,
        passed,
        failed: results.length - passed,
        results,
      },
    };
  }

  private async resolveSingleAgentForCommand(teamId: string, agentName: string): Promise<{ agent?: AgentRow; error?: string }> {
    const matches = await this.dbResolveAgents(teamId, agentName);
    if (matches.length === 0) {
      return { error: `Agent "${agentName}" not found` };
    }
    if (matches.length > 1) {
      return { error: `Multiple agents match "${agentName}". Be more specific.` };
    }
    return { agent: matches[0] };
  }

  private async buildTaskResult(task: TaskRow, teamId: string): Promise<Record<string, unknown>> {
    let ownerName: string | null = null;
    if (task.owner) {
      const ownerAgent = await this.db.agents.getById(task.owner);
      if (ownerAgent) {
        ownerName = (ownerAgent.metadata as any)?.alias || ownerAgent.name;
      }
    }

    let teamName: string | null = null;
    if (task.team_id) {
      const teamRow = await this.db.teams.getTeam(task.team_id);
      if (teamRow) teamName = teamRow.name;
    }

    const links = await this.db.tasks.listEventLinksForTask(task.id);
    const shortId = task.uuid ? `#${task.uuid.replace(/-/g, '').slice(0, 8)}` : null;

    return {
      name: task.name,
      uuid: task.uuid,
      shortId,
      title: task.title,
      description: task.description,
      status: task.status,
      ownerName,
      teamName,
      linkedEvents: links.map(l => l.schedule_id),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
    };
  }

  /**
   * Resolve a task reference scoped to a team. Accepts either:
   *   - the kebab-case `name` slug (existing behavior), or
   *   - a short-uuid handle `#xxxxxxxx` (8+ hex chars after the `#`).
   *
   * Short refs match on the dash-stripped uuid prefix. If multiple rows
   * share the prefix (within the team), returns an `error` asking the caller
   * to widen it.
   *
   * @param ref   The task reference string.
   * @param teamId  The team scope. Required for name-based resolution.
   */
  private async resolveTaskRef(ref: string, teamId?: string): Promise<{ task?: TaskRow; error?: string }> {
    if (!ref || typeof ref !== 'string') {
      return { error: 'Task reference is required' };
    }
    if (ref.startsWith('#')) {
      const raw = ref.slice(1).toLowerCase();
      if (!/^[0-9a-f]+$/.test(raw) || raw.length < 4) {
        return { error: `Invalid short id "${ref}". Expected #<hex prefix>` };
      }
      // uuids are stored with dashes; the short form strips dashes for
      // display, so match on either form by trying the first 8 hex chars
      // against the leading hex chunk (uuid v4: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
      const matches = await this.db.tasks.getByUuidPrefix(raw.slice(0, 8));
      const filtered = matches.filter(t => {
        if (!(t.uuid || '').replace(/-/g, '').toLowerCase().startsWith(raw)) return false;
        // When teamId is provided, scope to that team
        if (teamId && t.team_id !== teamId) return false;
        return true;
      });
      if (filtered.length === 0) return { error: `Task ${ref} not found` };
      if (filtered.length > 1) {
        const widened = filtered
          .map(t => `#${(t.uuid || '').replace(/-/g, '').slice(0, raw.length + 2)} (${t.name})`)
          .join(', ');
        return { error: `Short id ${ref} is ambiguous (matches ${filtered.length}): ${widened}. Widen the prefix.` };
      }
      return { task: filtered[0] };
    }
    // Name-based resolution: scope to the team when teamId is provided
    if (teamId) {
      const task = await this.db.tasks.getByNameForTeam(ref, teamId);
      if (!task) return { error: `Task "${ref}" not found` };
      return { task };
    }
    const task = await this.db.tasks.getByName(ref);
    if (!task) return { error: `Task "${ref}" not found` };
    return { task };
  }

  private async listTeamSchedules(teamId: string): Promise<Array<{ definition: ScheduleDefinitionRow; targets: AgentRow[] }>> {
    const teamAgents = await this.dbListAgents(teamId, true);
    const agentsById = new Map(teamAgents.map((agent) => [agent.id, agent]));
    const definitions = await this.db.schedules.listAllDefinitions();
    const schedules: Array<{ definition: ScheduleDefinitionRow; targets: AgentRow[] }> = [];

    for (const definition of definitions) {
      const targetIds = await this.db.schedules.listTargets(definition.id);
      const targets = targetIds
        .map((targetId) => agentsById.get(targetId))
        .filter((target): target is AgentRow => Boolean(target));

      if (targets.length > 0) {
        schedules.push({ definition, targets });
      }
    }

    return schedules;
  }

  private async getTeamScheduleById(teamId: string, scheduleId: string): Promise<{ definition: ScheduleDefinitionRow; targets: AgentRow[] } | null> {
    const definition = await this.db.schedules.getDefinition(scheduleId);
    if (!definition) return null;

    const teamAgents = await this.dbListAgents(teamId, true);
    const agentsById = new Map(teamAgents.map((agent) => [agent.id, agent]));
    const targets = (await this.db.schedules.listTargets(scheduleId))
      .map((targetId) => agentsById.get(targetId))
      .filter((target): target is AgentRow => Boolean(target));

    if (targets.length === 0) return null;
    return { definition, targets };
  }

  /**
   * Execute a CLI-style command and return the result
   */
  private async executeRemoteCommand(
    command: string,
    teamId: string,
    teamName: string,
    callerFrom?: string,
  ): Promise<{ ok: boolean; result?: any; error?: string }> {
    // Remove leading slash if present
    const cmd = command.startsWith('/') ? command.slice(1) : command;
    const parts = tokenizeCommand(cmd);
    const action = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (action) {
      case 'agents': {
        const sub = args[0]?.toLowerCase();
        if (sub === 'probe') {
          // Probe every running agent's /talk dispatch path. Non-running
          // rows are skipped (an offline/stopped agent is expected to
          // fail; including it would skew passed/failed counts toward
          // noise the operator already knows about). For a deliberately
          // selected single agent, see `/agent <name> probe` which does
          // not skip.
          const all = await this.dbListAgents(teamId);
          const running = all.filter((a) => a.status === 'running');
          return this.probeAgentsViaTalk(teamName, running);
        }
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
        const liveCursorFallback = args.includes('--live') || args.includes('--cursor-live');
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
            cursorFallback: await checkCursorFallbackHealth({ live: liveCursorFallback }),
            status: 'ok'
          }
        };
      }

      case 'schedule': {
        if (!this.schedulerService) {
          return { ok: false, error: 'Scheduler service is not running' };
        }

        const subCmd = args[0]?.toLowerCase() || 'list';

        if (subCmd === 'list') {
          const schedules = await this.listTeamSchedules(teamId);
          return {
            ok: true,
            result: {
              schedules: schedules.map(({ definition, targets }) => ({
                id: definition.id,
                title: definition.title,
                kind: definition.kind,
                active: definition.active,
                deliveryMode: definition.delivery_mode,
                sourceType: definition.source_type,
                targets: targets.map((target) => target.name),
                intervalSeconds: definition.interval_seconds,
                timezone: definition.timezone,
                localTimeSeconds: definition.local_time_seconds,
                localDate: definition.local_date,
                daysOfWeek: definition.days_of_week,
                message: definition.message,
                createdAt: definition.created_at,
              })),
            },
          };
        }

        if (subCmd === 'show') {
          const scheduleId = args[1];
          if (!scheduleId) {
            return { ok: false, error: 'Usage: /schedule show <id>' };
          }

          const schedule = await this.getTeamScheduleById(teamId, scheduleId);
          if (!schedule) {
            return { ok: false, error: `Schedule "${scheduleId}" not found` };
          }

          const runs = await this.db.schedules.listRuns(scheduleId, 10);
          return {
            ok: true,
            result: {
              schedule: {
                ...schedule.definition,
                targets: schedule.targets.map((target) => ({
                  id: target.id,
                  name: target.name,
                  status: target.status,
                })),
                recentRuns: runs,
              },
            },
          };
        }

        if (subCmd === 'pause' || subCmd === 'resume' || subCmd === 'remove') {
          const scheduleId = args[1];
          if (!scheduleId) {
            return { ok: false, error: `Usage: /schedule ${subCmd} <id>` };
          }

          const schedule = await this.getTeamScheduleById(teamId, scheduleId);
          if (!schedule) {
            return { ok: false, error: `Schedule "${scheduleId}" not found` };
          }

          if (subCmd === 'remove') {
            await this.db.schedules.deleteDefinition(scheduleId);
            return { ok: true, result: { removed: scheduleId } };
          }

          const active = subCmd === 'resume';
          await this.db.schedules.setActive(scheduleId, active);
          return { ok: true, result: { id: scheduleId, active } };
        }

        if (subCmd === 'add') {
          const kind = args[1]?.toLowerCase();
          if (kind !== 'heartbeat' && kind !== 'calendar') {
            return { ok: false, error: 'Usage: /schedule add <heartbeat|calendar> ...' };
          }

          const rawArgs = args.slice(2);
          let delivery: ScheduleDeliveryMode = kind === 'heartbeat' ? 'internal' : 'talk';
          let timezone: string | undefined;
          let sender: string | undefined;
          const positionals: string[] = [];

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--delivery') {
              const value = rawArgs[i + 1];
              if (value !== 'talk' && value !== 'internal') {
                return { ok: false, error: 'Invalid --delivery value. Use talk or internal.' };
              }
              delivery = value;
              i++;
              continue;
            }
            if (token === '--timezone') {
              timezone = rawArgs[i + 1];
              if (!timezone) {
                return { ok: false, error: 'Missing value for --timezone' };
              }
              i++;
              continue;
            }
            if (token === '--sender') {
              sender = rawArgs[i + 1];
              if (!sender) {
                return { ok: false, error: 'Missing value for --sender' };
              }
              i++;
              continue;
            }
            positionals.push(token);
          }

          if (kind === 'heartbeat') {
            const [agentName, secondsRaw, ...messageParts] = positionals;
            const message = messageParts.join(' ').trim();

            if (!agentName || !secondsRaw || !message) {
              return {
                ok: false,
                error: 'Usage: /schedule add heartbeat <agent> <seconds> <message> [--delivery internal|talk]',
              };
            }

            const { agent, error } = await this.resolveSingleAgentForCommand(teamId, agentName);
            if (!agent) return { ok: false, error };

            const seconds = Number(secondsRaw);
            if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
              return { ok: false, error: `Invalid interval: ${secondsRaw}` };
            }
            try {
              validateIntervalSeconds(seconds);
            } catch (err: any) {
              return { ok: false, error: err.message };
            }

            const nowSec = Math.floor(Date.now() / 1000);
            const scheduleId = `sch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const definition: ScheduleDefinitionRow = {
              id: scheduleId,
              kind: 'heartbeat',
              title: `Interval: ${agent.name}`,
              description: null,
              active: true,
              message,
              delivery_mode: delivery,
              timezone: null,
              catch_up_policy: 'fire_once',
              dedupe_window_seconds: 90,
              interval_seconds: seconds,
              anchor_at: nowSec,
              max_runs: null,
              expires_at: null,
              local_time_seconds: null,
              local_date: null,
              days_of_week: null,
              source_type: 'cli',
              source_key: `cli:${teamId}:${scheduleId}`,
              sender: sender ?? 'schedule',
              created_at: nowSec,
              updated_at: nowSec,
            };

            await this.schedulerService.seedSchedule(definition, [agent.id]);
            return {
              ok: true,
              result: {
                schedule: {
                  id: definition.id,
                  kind: definition.kind,
                  target: agent.name,
                  intervalSeconds: seconds,
                  deliveryMode: delivery,
                },
              },
            };
          }

          const [agentName, time, recurrence, ...messageParts] = positionals;
          const message = messageParts.join(' ').trim();
          if (!agentName || !time || !recurrence || !message) {
            return {
              ok: false,
              error: 'Usage: /schedule add calendar <agent> <time> <days|date> <message> [--timezone TZ] [--delivery internal|talk]',
            };
          }

          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, agentName);
          if (!agent) return { ok: false, error };

          const scheduleKey = `cli:${teamId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
          const isDate = /^\d{4}-\d{2}-\d{2}$/.test(recurrence);
          const spec: CalendarSpec = {
            title: `Calendar: ${agent.name}`,
            time,
            timezone,
            agents: [agent.name],
            message,
            delivery,
            ...(isDate ? { date: recurrence } : { days: recurrence.split(',').map((day) => day.trim()).filter(Boolean) }),
          };

          let definition: ScheduleDefinitionRow;
          try {
            ({ definition } = calendarToSchedule(spec, scheduleKey, [agent.id]));
          } catch (err: any) {
            return { ok: false, error: err.message };
          }
          definition.source_type = 'cli';
          definition.source_key = scheduleKey;
          definition.sender = sender ?? 'schedule';
          await this.schedulerService.seedSchedule(definition, [agent.id]);

          return {
            ok: true,
            result: {
              schedule: {
                id: definition.id,
                kind: definition.kind,
                target: agent.name,
                time,
                recurrence,
                timezone: definition.timezone,
                deliveryMode: delivery,
              },
            },
          };
        }

        return {
          ok: false,
          error: 'Usage: /schedule <list|show|add|pause|resume|remove> ...'
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
            const config = this.readHeartbeatConfig(agent.working_directory);
            if (!config) {
              return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml or HEARTBEAT.md in working directory` };
            }
            const newMetadata = { ...agent.metadata, heartbeat: true };
            await this.db.agents.updateMetadata(agent.id, newMetadata);
            if (this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agent.id, agent.name, config);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }
            return { ok: true, result: { message: `Heartbeat enabled for ${agent.name} (interval: ${config.interval}s)` } };
          } else {
            // Disable heartbeat
            const newMetadata = { ...agent.metadata };
            delete newMetadata.heartbeat;
            await this.db.agents.updateMetadata(agent.id, newMetadata);
            if (this.schedulerService) {
              await this.schedulerService.removeAgentSchedules(agent.id);
            }
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
          const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
          const hbSchedule = schedules.find(s => s.source_key === `heartbeat:${agent.id}`);
          const runCount = hbSchedule ? await this.db.schedules.countRuns(hbSchedule.id, agent.id) : 0;
          return {
            ok: true,
            result: {
              agent: {
                name: agent.name,
                id: agent.id,
                status: agent.status,
                scheduleActive: hbSchedule?.active ?? false,
                intervalSeconds: hbSchedule?.interval_seconds || config?.interval || 'no file',
                runsSent: runCount,
                maxRuns: hbSchedule?.max_runs ?? config?.maxBeats ?? 20,
                expiresAt: hbSchedule?.expires_at ?? null
              }
            }
          };
        }

        // No argument - show usage
        return { ok: false, error: 'Usage: /heartbeat <agent> or /heartbeats (to show all)' };
      }

      case 'heartbeats': {
        // /heartbeats - show all agents with heartbeat enabled
        const heartbeatAgents = await this.db.agents.findHeartbeat(teamId);
        const agentResults = [];
        for (const a of heartbeatAgents) {
          const schedules = await this.db.schedules.listSchedulesForAgent(a.id);
          const hbSchedule = schedules.find(s => s.source_key === `heartbeat:${a.id}`);
          const runCount = hbSchedule ? await this.db.schedules.countRuns(hbSchedule.id, a.id) : 0;
          const config = a.working_directory ? this.readHeartbeatConfig(a.working_directory) : null;
          agentResults.push({
            name: a.name,
            id: a.id,
            status: a.status,
            scheduleActive: hbSchedule?.active ?? false,
            intervalSeconds: hbSchedule?.interval_seconds || config?.interval || 'no file',
            runsSent: runCount,
            maxRuns: hbSchedule?.max_runs ?? config?.maxBeats ?? 20,
            expiresAt: hbSchedule?.expires_at ?? null
          });
        }
        return {
          ok: true,
          result: {
            agents: agentResults
          }
        };
      }

      case 'delete': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /delete <agent-name|agent-id> | /delete * | /delete --team <name>' };
        }

        // Bulk delete: /delete * (current team) or /delete --team <name>
        if (agentName === '*' || agentName === '--team') {
          let bulkTeamId = teamId;
          let bulkTeamName = 'current';
          if (agentName === '--team') {
            const targetTeam = args[1];
            if (!targetTeam) {
              return { ok: false, error: 'Usage: /delete --team <team-name>' };
            }
            if (!/^[a-zA-Z0-9_.-]+$/.test(targetTeam)) {
              return { ok: false, error: `Invalid team name: "${targetTeam}"` };
            }
            bulkTeamId = await this.db.teams.getOrCreateTeamId(targetTeam);
            bulkTeamName = targetTeam;
          }

          const agents = await this.dbListAgents(bulkTeamId, true);
          if (agents.length === 0) {
            return { ok: true, result: { deleted: [], count: 0, team: bulkTeamName, message: 'No agents to delete' } };
          }

          const deletedNames: string[] = [];
          for (const agent of agents) {
            const serverKey = this.key(bulkTeamId, agent.id);
            const server = this.runningServers.get(serverKey);
            if (server) {
              await server.stop();
              this.runningServers.delete(serverKey);
            }
            if (agent.port) {
              await this.killAgentProcess(agent.port);
            }
            if (this.schedulerService) {
              await this.schedulerService.removeAgentSchedules(agent.id);
            }
            await this.cancelPendingQueriesForAgent(bulkTeamId, agent.id);
            await this.db.adapter.query(
              `UPDATE agents SET deleted_at = $3, status = 'stopped' WHERE team_id = $1 AND id = $2`,
              [bulkTeamId, agent.id, Date.now()]
            );
            deletedNames.push(agent.name || agent.id);
          }

          if (deletedNames.length) {
            this.broadcastAgentsChanged(bulkTeamId, { reason: 'remove', removed: deletedNames });
          }

          return {
            ok: true,
            result: {
              deleted: deletedNames,
              count: deletedNames.length,
              team: bulkTeamName,
              message: `Deleted ${deletedNames.length} agents: ${deletedNames.join(', ')}`
            }
          };
        }

        // Single agent delete
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

        if (a.port) {
          await this.killAgentProcess(a.port);
        }

        // Remove any schedules for this agent
        if (this.schedulerService) {
          await this.schedulerService.removeAgentSchedules(a.id);
        }

        // Cancel any pending queries so they don't show as orphaned
        await this.cancelPendingQueriesForAgent(teamId, a.id);

        // Soft-delete by setting deleted_at and status
        await this.db.adapter.query(
          `UPDATE agents SET deleted_at = $3, status = 'stopped' WHERE team_id = $1 AND id = $2`,
          [teamId, a.id, Date.now()]
        );

        this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [a.name || a.id] });

        return { ok: true, result: { deleted: agentName } };
      }

      case 'output': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /output <agent-name>' };
        }
        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        const agent = matches[0];
        const outputDir = path.join(agent.working_directory || '', 'output');
        if (!existsSync(outputDir)) {
          return { ok: true, result: { agent: agent.name, files: [] } };
        }
        try {
          const entries = readdirSync(outputDir, { withFileTypes: true });
          const files = entries
            .filter(e => e.isFile())
            .map(e => {
              const st = statSync(path.join(outputDir, e.name));
              return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
            });
          return { ok: true, result: { agent: agent.name, files } };
        } catch {
          return { ok: true, result: { agent: agent.name, files: [] } };
        }
      }

      case 'artifact': {
        const agentName = args[0];
        const filePath = args.slice(1).join(' ');
        if (!agentName || !filePath) {
          return { ok: false, error: 'Usage: /artifact <agent-name> <path>' };
        }
        if (filePath.includes('..') || filePath.startsWith('/')) {
          return { ok: false, error: 'Invalid path: directory traversal not allowed' };
        }
        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        const agent = matches[0];
        const fullPath = path.join(agent.working_directory || '', 'output', filePath);
        if (!existsSync(fullPath)) {
          return { ok: false, error: `File not found: ${filePath}` };
        }
        try {
          const st = statSync(fullPath);
          if (st.size > 1_048_576) {
            return { ok: false, error: `File too large (${(st.size / 1024 / 1024).toFixed(1)}MB). Max: 1MB` };
          }
          const content = readFileSync(fullPath, 'utf-8');
          return { ok: true, result: { agent: agent.name, path: filePath, content, size: st.size } };
        } catch (err: any) {
          return { ok: false, error: `Failed to read file: ${err.message}` };
        }
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

        const a = await this.db.agents.getByName(teamId, agentName);

        if (!a) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Interactive (manager-inbox) agents have no /news HTTP server of
        // their own — the daemon owns the inbox. Read directly from
        // news_items using the same id resolution as GET /news so reads
        // and writes converge on the same row.
        if (a.type === 'interactive') {
          const teamRow = await this.db.teams.getTeam(teamId).catch(() => null);
          const teamName = teamRow?.name ?? 'unknown';
          const managerInbox = this.getManagerInboxRef(teamId, teamName);
          const rows = await this.db.news.pollByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, 0, { limit: 100 });
          const items = rows.map((r: any) => ({
            id: Number(r.id),
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
          }));
          return { ok: true, result: { items, total: items.length, timestamp: Date.now() } };
        }

        // Agents without a usable local network endpoint (virtual stubs,
        // remote-only rows that have no `port`/`endpoint` filled in) cannot
        // serve `/news` directly; skipping here avoids a catalog fetch
        // against `http://localhost:0` from the CLI's per-agent news poll.
        if (!a.port || !a.endpoint) {
          return { ok: true, result: { items: [], total: 0, timestamp: Date.now() } };
        }

        const baseEndpoint = a.endpoint;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const newsUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.news}`;

        const newsResp = await fetch(newsUrl);
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

        const a = await this.db.agents.getByName(teamId, agentName);

        if (!a) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

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
        const owsRegWallet = process.env.OWS_REGISTRAR_WALLET;
        const syncPk = !owsRegWallet ? (process.env.ID_REGISTRAR_PRIVATE_KEY || process.env.PRIVATE_KEY) : undefined;
        if (!owsRegWallet && !syncPk) {
          return { ok: false, error: 'Missing signer. Set OWS_REGISTRAR_WALLET or PRIVATE_KEY.' };
        }
        const syncSignerOpts = owsRegWallet ? { wallet: owsRegWallet } : { privateKey: syncPk! };

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
              ...syncSignerOpts,
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

      case 'sync': {
        // Sync running team with a config file — reconcile the diff
        // Usage: /sync <config> [param=value ...] [--dry-run] [--verbose]
        const syncDryRun = args.includes('--dry-run');
        const syncVerbose = args.includes('--verbose');
        const syncFilteredArgs = args.filter(arg => arg !== '--dry-run' && arg !== '--verbose');
        const syncConfigPath = syncFilteredArgs[0];
        if (!syncConfigPath) {
          return { ok: false, error: 'Usage: /sync <config> [param=value ...] [--dry-run] [--verbose]' };
        }

        // Resolve config path (same shorthand as /deploy)
        let syncFilePath = syncConfigPath;
        if (!syncFilePath.includes('/') && !syncFilePath.includes('\\')) {
          if (!syncFilePath.endsWith('.yaml') && !syncFilePath.endsWith('.yml')) {
            syncFilePath = `configs/${syncFilePath}.yaml`;
          } else {
            syncFilePath = `configs/${syncFilePath}`;
          }
        } else if (!syncFilePath.endsWith('.yaml') && !syncFilePath.endsWith('.yml')) {
          syncFilePath = `${syncFilePath}.yaml`;
        }

        const syncAbsolutePath = path.resolve(process.cwd(), syncFilePath);
        if (!existsSync(syncAbsolutePath)) {
          return { ok: false, error: `Config file not found: ${syncFilePath}` };
        }

        const syncDeployArgs = syncFilteredArgs.slice(1);
        const { agents: syncAgents, errors: syncErrors, teamName: syncConfigTeam, org: syncOrg, calendar: syncCalendar } =
          processConfig(syncAbsolutePath, this.baseWorkDir, syncDeployArgs);

        let syncTeamId = teamId;
        let syncTeamName = teamName;
        if (syncConfigTeam && syncConfigTeam !== teamName) {
          syncTeamId = await this.db.teams.getOrCreateTeamId(syncConfigTeam);
          syncTeamName = syncConfigTeam;
          const syncTeamDir = `${this.baseWorkDir}/teams/${syncConfigTeam}`;
          if (!existsSync(syncTeamDir)) mkdirSync(syncTeamDir, { recursive: true });
        }

        if (syncErrors.length > 0) {
          return { ok: false, error: `Config errors: ${syncErrors.map(e => `${e.path}: ${e.message}`).join('; ')}` };
        }
        if (syncAgents.length === 0) {
          return { ok: false, error: 'No agents defined in config' };
        }

        // Get running agents for this team (include automators)
        const runningAgents = await this.db.agents.list(syncTeamId, true);
        // Filter to claude/automator types only — skip interactive agents
        const syncableRunning = runningAgents.filter(a => a.type === 'claude' || a.type === 'automator');

        const plan = computeSyncPlan(syncAgents, syncableRunning, this.defaultConfig?.model);

        if (syncDryRun) {
          return {
            ok: true,
            result: {
              dryRun: true,
              summary: formatSyncSummary(plan),
              verbose: formatSyncVerbose(plan),
              plan: {
                added: plan.added.map(i => i.name),
                updated: plan.changed.map(i => ({ name: i.name, changes: i.changes })),
                removed: plan.removed.map(i => i.name),
                unchanged: plan.unchanged.map(i => i.name),
              }
            }
          };
        }

        const syncResult: {
          added: string[];
          updated: string[];
          removed: string[];
          unchanged: string[];
          personalityErrors?: { agent: string; error: string }[];
        } = { added: [], updated: [], removed: [], unchanged: [] };

        // --- REMOVED agents: kill process, hard-delete DB row ---
        for (const item of plan.removed) {
          const row = syncableRunning.find(r => r.name === item.name);
          if (row) {
            if (row.port) {
              await this.killAgentProcess(row.port);
              await new Promise(r => setTimeout(r, 500));
            }
            await this.db.agents.deleteAgent(row.id);
            console.log(`[Sync] Removed agent: ${item.name}`);
          }
          syncResult.removed.push(item.name);
        }

        // --- UNCHANGED agents: skip ---
        for (const item of plan.unchanged) {
          syncResult.unchanged.push(item.name);
        }

        // --- CHANGED agents: in-place rebuild with same ID/port ---
        for (const item of plan.changed) {
          const row = syncableRunning.find(r => r.name === item.name)!;
          const spec = syncAgents.find(a => (a.domain || a.name) === item.name)!;

          // If workingDirectory changed, treat as destroy + recreate
          const wdChanged = item.changes?.includes('workingDirectory');
          if (wdChanged) {
            if (row.port) {
              await this.killAgentProcess(row.port);
              await new Promise(r => setTimeout(r, 500));
            }
            await this.db.agents.deleteAgent(row.id);
            plan.added.push({ name: item.name, category: 'new' });
            syncResult.updated.push(item.name);
            continue;
          }

          // Kill old process on existing port
          if (row.port) {
            await this.killAgentProcess(row.port);
            await new Promise(r => setTimeout(r, 500));
          }

          // Update config on disk (skills, plugins, heartbeat)
          const workingDirectory = row.working_directory || `${this.baseWorkDir}/agents/${row.id}`;
          if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

          const effectiveRuntime = resolveRuntime(spec.runtime) as HarnessType;
          const effectiveModel = spec.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
          this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

          const mergedPlugins = spec.plugins || [];
          const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

          const agentSkills: string[] = spec.skills || [];
          let orgContext = '';
          if (syncOrg?.groups) {
            try {
              const { generateAgentOrgContext } = await import('./org-chart.js');
              orgContext = generateAgentOrgContext(spec.name, syncOrg);
            } catch { /* ignore */ }
          }

          const configDomain = spec.domain;
          const normalizedSkills = normalizeConfigSkills(agentSkills);

          // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
          if (spec.agent) {
            copyLibraryAgentOverlay(workingDirectory, spec.agent, effectiveRuntime);
          }

          // 2. Deploy team-level skills (runtime-aware)
          const isAutomator = spec.type === 'automator';
          const walletMeta = this.resolveWalletMetadata(syncTeamName, spec.name, {
            ...(row.metadata as AgentMetadata || {}),
            name: spec.name,
            service_type: isAutomator ? undefined : 'REST-AP',
            endpoint: isAutomator ? undefined : `http://localhost:${row.port}`,
            runtime: effectiveRuntime,
            plugins: localPlugins,
            agent: spec.agent,
            skills: normalizedSkills,
            allowed_tools: spec.allowedTools,
            description: spec.description,
            ...(isAutomator && { isAutomator: true }),
            ...(spec.heartbeat && { heartbeat: true }),
            ...(spec.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: spec.dangerouslySkipPermissions }),
            // Catalog seed from YAML — overwrites any runtime PATCH on redeploy.
            // This is intentional: YAML is the redeploy floor.
            ...(spec.catalog && { catalog: spec.catalog }),
          }, spec.wallet);

          this.deploySkillsToAgent(workingDirectory, agentSkills, {
            DISPLAY_NAME: configDomain || spec.name,
            TEAM: syncTeamName,
            ONCHAIN_IDENTITY: configDomain ? `Your onchain identity is your ENS domain: **${configDomain}**` : '',
            ORG_CONTEXT: orgContext
              ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
              : '',
          }, { hasWallet: !!walletMeta.wallet, runtime: effectiveRuntime });

          // 3. Overlay working-directory template files (runtime-aware)
          copyAgentDirOverlay(workingDirectory, spec.name, effectiveRuntime);
          copyHeartbeatMd(workingDirectory, spec.name, effectiveRuntime);

          // 4. Write personality file: framework block (marker-fenced for
          // Codex/Cursor; full overwrite for Claude). Preserves user edits
          // outside the markers on Codex/Cursor refresh paths.
          try {
            {
              const parts = [PROTOCOL_DEFAULTS];
              if (spec.roleBody) parts.push(spec.roleBody);
              writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
            }

            // 5. Codex/Cursor: append library persona to AGENTS.md inside
            // marker fences (no-op for Claude).
            if (spec.agent) {
              appendLibraryPersonaToAgentsMd(workingDirectory, spec.agent, effectiveRuntime);
            }
          } catch (writeErr: any) {
            if (writeErr?.code === 'PERSONALITY_BODY_EMPTY') {
              console.error(`[Sync] Personality write guard rejected ${item.name}: ${writeErr.message}`);
              syncResult.personalityErrors = syncResult.personalityErrors || [];
              syncResult.personalityErrors.push({ agent: item.name, error: writeErr.message });
              continue;
            }
            throw writeErr;
          }

          const updatedMeta: AgentMetadata = walletMeta.metadata;

          await this.db.agents.updateStatus(row.id, 'starting', {
            model: effectiveModel,
            metadata: updatedMeta,
          });

          // Respawn on same port
          const spawnResult = await this.spawnLocalAgentProcess(syncTeamId, syncTeamName, {
            name: spec.name,
            id: row.id,
            port: row.port,
            model: effectiveModel,
            workingDirectory,
            tokenId: spec.tokenId || row.token_id || undefined,
          });

          if (spawnResult.success) {
            await this.db.agents.updateStatus(row.id, 'running');
            console.log(`[Sync] Updated agent: ${item.name} (changes: ${item.changes?.join(', ')})`);
          } else {
            await this.db.agents.updateStatus(row.id, 'error');
            console.error(`[Sync] Failed to restart ${item.name}: ${spawnResult.error}`);
          }

          // Re-seed heartbeat if needed
          if (spec.heartbeat && this.schedulerService) {
            const { definition, agentIds } = heartbeatToSchedule(row.id, spec.name, spec.heartbeat);
            await this.schedulerService.seedSchedule(definition, agentIds);
          }

          syncResult.updated.push(item.name);
        }

        // --- NEW agents: spawn fresh (reuse deploy logic) ---
        for (const item of plan.added) {
          const spec = syncAgents.find(a => (a.domain || a.name) === item.name)!;
          const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          try {
            const port = await this.dbNextPort(syncTeamId);
            const workingDirectory = spec.workingDirectory && path.isAbsolute(spec.workingDirectory)
              ? spec.workingDirectory
              : `${this.baseWorkDir}/agents/${agentId}`;
            if (!existsSync(workingDirectory)) mkdirSync(workingDirectory, { recursive: true });

            const effectiveRuntime = resolveRuntime(spec.runtime) as HarnessType;
            const effectiveModel = spec.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
            this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

            const localPlugins = this.copyPluginsToAgent(spec.plugins || [], workingDirectory);
            const isAutomator = spec.type === 'automator';
            const agentType = spec.type || 'claude';
            const configDomain = spec.domain;
            const configTokenId = spec.tokenId;
            const agentName = configDomain || spec.name;

            const agentSkills: string[] = spec.skills || [];
            const normalizedSkills = normalizeConfigSkills(agentSkills);
            let orgContext = '';
            if (syncOrg?.groups) {
              try {
                const { generateAgentOrgContext } = await import('./org-chart.js');
                orgContext = generateAgentOrgContext(spec.name, syncOrg);
              } catch { /* ignore */ }
            }
            const walletMeta = this.resolveWalletMetadata(syncTeamName, spec.name, {
              name: spec.name,
              service_type: isAutomator ? undefined : 'REST-AP',
              endpoint: isAutomator ? undefined : `http://localhost:${port}`,
              runtime: effectiveRuntime,
              plugins: localPlugins,
              ...(spec.agent && { agent: spec.agent }),
              skills: normalizedSkills,
              allowed_tools: spec.allowedTools,
              description: spec.description,
              ...(isAutomator && { isAutomator: true }),
              ...(spec.heartbeat && { heartbeat: true }),
              ...(spec.openMode !== undefined && { openMode: spec.openMode }),
              ...(spec.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: spec.dangerouslySkipPermissions }),
              // Catalog seed from YAML — see notes on the sync-update site above.
              ...(spec.catalog && { catalog: spec.catalog }),
            }, spec.wallet);

            // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
            if (spec.agent) {
              copyLibraryAgentOverlay(workingDirectory, spec.agent, effectiveRuntime);
            }

            // 2. Deploy team-level skills (runtime-aware)
            this.deploySkillsToAgent(workingDirectory, agentSkills, {
              DISPLAY_NAME: configDomain || spec.name,
              TEAM: syncTeamName,
              ONCHAIN_IDENTITY: configDomain ? `Your onchain identity is your ENS domain: **${configDomain}**` : '',
              ORG_CONTEXT: orgContext
                ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
                : '',
            }, { hasWallet: !!walletMeta.wallet, runtime: effectiveRuntime });

            // 3. Overlay working-directory template files (runtime-aware)
            copyAgentDirOverlay(workingDirectory, spec.name, effectiveRuntime);
            copyHeartbeatMd(workingDirectory, spec.name, effectiveRuntime);

            // 4. Write personality file: framework block (marker-fenced for
            // Codex/Cursor; full overwrite for Claude).
            {
              const parts = [PROTOCOL_DEFAULTS];
              if (spec.roleBody) parts.push(spec.roleBody);
              writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
            }

            // 5. Codex/Cursor: append library persona to AGENTS.md inside
            // marker fences (no-op for Claude).
            if (spec.agent) {
              appendLibraryPersonaToAgentsMd(workingDirectory, spec.agent, effectiveRuntime);
            }

            const metadata: AgentMetadata = walletMeta.metadata;

            if (configDomain) {
              metadata.idchain_domain = configDomain;
              metadata.alias = spec.name;
            }

            await this.db.agents.create({
              team_id: syncTeamId,
              id: agentId,
              name: agentName,
              type: agentType,
              model: effectiveModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              runtime: effectiveRuntime,
              token_id: configTokenId || null,
              domain: configDomain || null,
            });

            const url = `http://localhost:${port}`;
            await this.db.agents.updateStatus(agentId, 'pending', {
              port, endpoint: url, metadata: { ...metadata, endpoint: url, local: true },
            });

            const spawnResult = await this.spawnLocalAgentProcess(syncTeamId, syncTeamName, {
              name: spec.name, id: agentId, port, model: effectiveModel,
              workingDirectory, tokenId: configTokenId || undefined,
            });

            if (spawnResult.success) {
              await this.db.agents.updateStatus(agentId, 'running');
              console.log(`[Sync] Added agent: ${item.name} (port ${port})`);
            } else {
              await this.db.agents.updateStatus(agentId, 'error');
              console.error(`[Sync] Failed to spawn ${item.name}: ${spawnResult.error}`);
            }

            if (spec.heartbeat && this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agentId, spec.name, spec.heartbeat);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }

            syncResult.added.push(item.name);
          } catch (err: any) {
            console.error(`[Sync] Error adding ${item.name}: ${err.message}`);
          }
        }

        // Re-seed calendar schedules
        if (syncCalendar && syncCalendar.length > 0 && this.schedulerService) {
          await this.db.schedules.deleteBySource('yaml', `calendar:${syncAbsolutePath}:`);
          for (let index = 0; index < syncCalendar.length; index++) {
            const spec = syncCalendar[index] as CalendarSpec;
            const targetIds: string[] = [];
            for (const ref of spec.agents) {
              const target = await this.db.agents.getByName(syncTeamId, ref);
              if (target) targetIds.push(target.id);
            }
            if (targetIds.length > 0) {
              const { definition, agentIds } = calendarToSchedule(spec, `calendar:${syncAbsolutePath}:${index}`, targetIds);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }
          }
        }

        // Generate org chart if defined
        if (syncOrg?.groups) {
          try {
            const { generateOrgChart } = await import('./org-chart.js');
            const orgMd = generateOrgChart(syncTeamName, syncOrg, syncAgents.map(a => ({
              name: a.name, description: a.description, domain: a.domain,
            })));
            const teamDir = `${this.baseWorkDir}/teams/${syncTeamName}`;
            if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
            writeFileSync(`${teamDir}/ORG_CHART.md`, orgMd);
          } catch { /* ignore */ }
        }

        if (syncResult.added.length || syncResult.updated.length || syncResult.removed.length) {
          this.broadcastAgentsChanged(syncTeamId, {
            reason: 'sync',
            added: syncResult.added,
            updated: syncResult.updated,
            removed: syncResult.removed,
          });
        }

        const syncHasPersonalityErrors = (syncResult.personalityErrors?.length ?? 0) > 0;
        return {
          ok: !syncHasPersonalityErrors,
          ...(syncHasPersonalityErrors && {
            error: `Personality write guard rejected ${syncResult.personalityErrors!.length} agent(s): ${syncResult.personalityErrors!.map(e => e.agent).join(', ')}`,
          }),
          result: {
            // Echo the effective team back so the CLI can retarget its
            // daemon connection when /sync re-targets a team different
            // from activeTeam.
            team: syncTeamName,
            teamId: syncTeamId,
            summary: formatSyncSummary(plan),
            verbose: formatSyncVerbose(plan),
            ...syncResult,
          }
        };
      }

      case 'deploy': {
        // Deploy agents from a config file
        // Usage: /deploy <config> [param1=value1] [param2=value2] ...
        const dryRun = args.includes('--dry-run');
        const filteredArgs = args.filter(arg => arg !== '--dry-run');
        const configPath = filteredArgs[0];
        if (!configPath) {
          return { ok: false, error: 'Usage: /deploy <config> [param=value ...] [--dry-run]' };
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
        let deployArgs = filteredArgs.slice(1);

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
        const preflight = await this.buildDeployPreflightSummary(teamId, teamName, absolutePath, deployArgs);

        if (dryRun) {
          return {
            ok: true,
            result: {
              dryRun: true,
              configPath: preflight.configPath,
              teamName: preflight.teamName,
              calendarCount: preflight.calendarCount,
              agents: preflight.agents,
            }
          };
        }

        const { agents, calendar, errors, onchain, teamName: configTeam, org } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

        // If config specifies a team, use that instead of the request's team
        let effectiveTeamId = teamId;
        let effectiveTeamName = teamName;
        if (configTeam && configTeam !== teamName) {
          effectiveTeamId = await this.db.teams.getOrCreateTeamId(configTeam);
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

        for (const agentConfig of agents) {
          const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
          const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
          this.ensureRuntimeReady(effectiveRuntime, effectiveModel);
        }

        // Generate org chart if defined in config
        if (org?.groups) {
          try {
            const { generateOrgChart } = await import('./org-chart.js');
            const orgMd = generateOrgChart(effectiveTeamName, org, agents.map(a => ({
              name: a.name,
              description: a.description,
              domain: a.domain,
            })));
            const teamDir = `${this.baseWorkDir}/teams/${effectiveTeamName}`;
            if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
            writeFileSync(`${teamDir}/ORG_CHART.md`, orgMd);
            console.log(`[Deploy] Org chart written to teams/${effectiveTeamName}/ORG_CHART.md`);
          } catch (err: any) {
            console.warn(`[Deploy] Could not generate org chart: ${err.message}`);
          }
        }

        // Validate automator naming: first automator must be named "lead-automator"
        const automatorAgents = agents.filter(a => a.type === 'automator');
        if (automatorAgents.length > 0) {
          const existingLeadAutomator = await this.db.agents.getByName(effectiveTeamId, 'lead-automator');
          const hasLeadAutomator = existingLeadAutomator !== null && existingLeadAutomator.type === 'automator';

          if (!hasLeadAutomator) {
            const hasLeadAutomatorInConfig = automatorAgents.some(a => a.name === 'lead-automator');
            if (!hasLeadAutomatorInConfig) {
              return {
                ok: false,
                error: 'First automator must be named "lead-automator". Rename the team-local automator and re-deploy.'
              };
            }
          }
        }

        // Deploy each agent
        const results: { name: string; id?: string; port?: number; success: boolean; error?: string; tokenId?: string }[] = [];

        // Re-seed calendar schedules idempotently for this config source.
        if (this.schedulerService) {
          await this.db.schedules.deleteBySource('yaml', `calendar:${absolutePath}:`);
        }

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

            // Merge plugins from config
            const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
            const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
            this.ensureRuntimeReady(effectiveRuntime, effectiveModel);
            const mergedPlugins = agentConfig.plugins || [];

            // Copy plugins to agent's working directory
            const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

            // Automator agents are team-local planning workers; they don't have REST-AP endpoints
            console.log(`[Deploy] Agent ${agentConfig.name}: type=${agentConfig.type}, isAutomator=${agentConfig.type === 'automator'}`);
            const isAutomator = agentConfig.type === 'automator';
            const agentType = agentConfig.type || 'claude';
            const normalizedSkills = normalizeConfigSkills(agentConfig.skills);

            // Get heartbeat config
            const heartbeatConfig = agentConfig.heartbeat;

            const metadata: AgentMetadata = {
              name: agentConfig.name,
              service_type: isAutomator ? undefined : 'REST-AP',
              endpoint: isAutomator ? undefined : `http://localhost:${port}`,
              runtime: effectiveRuntime,
              plugins: localPlugins,
              ...(agentConfig.agent && { agent: agentConfig.agent }),
              ...(normalizedSkills && { skills: normalizedSkills }),
              allowed_tools: agentConfig.allowedTools,
              description: agentConfig.description,
              ...(isAutomator && { isAutomator: true }),
              // Flag that heartbeat is enabled
              ...(heartbeatConfig && { heartbeat: true }),
              ...(agentConfig.openMode !== undefined && { openMode: agentConfig.openMode }),
              ...(agentConfig.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: agentConfig.dangerouslySkipPermissions }),
              // Catalog seed from YAML — lands in metadata.catalog and surfaces
              // via the agent's /catalog endpoint. Runtime PATCH /catalog still
              // works; the next /deploy or /sync re-applies this YAML floor.
              ...(agentConfig.catalog && { catalog: agentConfig.catalog })
            };

            // Use ENS domain from config if available (preserves registration across redeploys)
            const configDomain = agentConfig.domain;
            const configTokenId = agentConfig.tokenId;
            const agentName = configDomain || agentConfig.name;
            if (configDomain) {
              metadata.idchain_domain = configDomain;
              metadata.alias = agentConfig.name;
            }

            // Wallet opt-in (default off). Record the explicit choice in
            // metadata so the on-demand provisioning command and the
            // onchain auto-provision gate can read it. Only call the `ows`
            // CLI when `wallet: true`.
            if (agentConfig.wallet !== undefined) {
              metadata.wallet = agentConfig.wallet;
            }
            const owsWallet = agentConfig.wallet === true
              ? this.getOrCreateAgentWallet(effectiveTeamName, agentConfig.name)
              : null;
            if (owsWallet) {
              metadata.ows_wallet = owsWallet.walletName;
              metadata.ows_address = owsWallet.address;
            }

            // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
            if (agentConfig.agent) {
              copyLibraryAgentOverlay(workingDirectory, agentConfig.agent, effectiveRuntime);
            }

            // 2. Deploy skills (runtime-aware)
            const agentSkills: string[] = agentConfig.skills || [];
            let orgContext = '';
            if (org?.groups) {
              try {
                const { generateAgentOrgContext } = await import('./org-chart.js');
                orgContext = generateAgentOrgContext(agentConfig.name, org);
              } catch { /* ignore */ }
            }
            this.deploySkillsToAgent(workingDirectory, agentSkills, {
              DISPLAY_NAME: configDomain || agentConfig.name,
              TEAM: effectiveTeamName,
              ONCHAIN_IDENTITY: configDomain
                ? `Your onchain identity is your ENS domain: **${configDomain}**`
                : '',
              ORG_CONTEXT: orgContext
                ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
                : '',
            }, { hasWallet: !!owsWallet, runtime: effectiveRuntime });

            // 3. Overlay working-directory template files (runtime-aware)
            copyAgentDirOverlay(workingDirectory, agentConfig.name, effectiveRuntime);
            copyHeartbeatMd(workingDirectory, agentConfig.name, effectiveRuntime);

            // 4. Write personality file: protocol defaults + agent role body (runtime-aware)
            {
              const parts = [PROTOCOL_DEFAULTS];
              if (agentConfig.roleBody) parts.push(agentConfig.roleBody);
              writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
            }

            // 5. Codex/Cursor: append library persona to AGENTS.md inside
            // marker fences (no-op for Claude).
            if (agentConfig.agent) {
              appendLibraryPersonaToAgentsMd(workingDirectory, agentConfig.agent, effectiveRuntime);
            }

            // Remove any existing agent with this name to avoid duplicates on redeploy
            const existing = await this.db.agents.getByName(effectiveTeamId, agentName);
            if (existing) {
              // Kill the old process before deleting the DB row to prevent orphans
              if (existing.port) {
                await this.killAgentProcess(existing.port);
                await new Promise(r => setTimeout(r, 500));
              }
              await this.db.agents.deleteAgent(existing.id);
            }

            // Insert into database
            console.log(`[Deploy] Storing agent: name=${agentName}, type=${agentType}, configType=${agentConfig.type}`);
            await this.db.agents.create({
              team_id: effectiveTeamId,
              id: agentId,
              name: agentName,
              type: agentType,
              model: effectiveModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              runtime: effectiveRuntime,
              token_id: configTokenId || null,
              domain: configDomain || null,
            });

            // All agents run locally - set up database and let CLI spawn the process
            const url = `http://localhost:${port}`;
            const finalMeta = { ...metadata, endpoint: url, local: true };
            await this.db.agents.updateStatus(agentId, 'pending', {
              port,
              endpoint: url,
              metadata: finalMeta,
            });

            // Spawn the agent process
            const spawnResult = await this.spawnLocalAgentProcess(effectiveTeamId, effectiveTeamName, {
              name: agentConfig.name,
              id: agentId,
              port,
              model: effectiveModel,
              workingDirectory,
              tokenId: configTokenId || undefined,
              address: (agentConfig as any).address || undefined
            });

            // Seed heartbeat schedule if config specified
            if (heartbeatConfig && this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agentId, agentConfig.name, heartbeatConfig);
              await this.schedulerService.seedSchedule(definition, agentIds);
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
              await this.db.agents.updateStatus(agentId, 'running');
            }

            // Auto-register onchain if enabled (automators never register)
            const shouldRegister = !isAutomator && (agentConfig.register !== undefined ? agentConfig.register : onchain?.register);
            if (shouldRegister) {
              try {
                // Fetch the agent row for registration
                const agentRow = await this.db.agents.getById(agentId);
                if (agentRow) {
                  const regResult = await this.registerOnchainAndUpdateAgent(effectiveTeamId, agentRow);
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
                await this.db.agents.deleteAgent(agentId);
                console.log(`[Deploy] Cleaned up failed agent record: ${agentId}`);
              } catch (cleanupErr) {
                console.warn(`[Deploy] Failed to clean up agent record: ${cleanupErr}`);
              }
            }
            results.push({ name: agentConfig.name, success: false, error: err.message });
          }
        }

        if (calendar.length > 0 && this.schedulerService) {
          for (let index = 0; index < calendar.length; index++) {
            const spec = calendar[index] as CalendarSpec;
            const targetIds: string[] = [];

            for (const ref of spec.agents) {
              const target = await this.db.agents.getByName(effectiveTeamId, ref);
              if (!target) {
                console.warn(`[Scheduler] Calendar event "${spec.title}" target not found: ${ref}`);
                continue;
              }
              targetIds.push(target.id);
            }

            if (targetIds.length === 0) {
              console.warn(`[Scheduler] Skipping calendar event "${spec.title}" with no resolved targets`);
              continue;
            }

            const { definition, agentIds } = calendarToSchedule(
              spec,
              `calendar:${absolutePath}:${index}`,
              targetIds,
            );
            await this.schedulerService.seedSchedule(definition, agentIds);
          }
        }

        const deployedNames = results.filter(r => r.success).map(r => r.name);
        if (deployedNames.length) {
          this.broadcastAgentsChanged(effectiveTeamId, { reason: 'deploy', added: deployedNames });
        }

        const failedResults = results.filter(r => !r.success);
        const personalityGuardFailures = failedResults.filter(r =>
          r.error?.includes('PERSONALITY_BODY_EMPTY') || r.error?.includes('personality body'),
        );
        const deployOk = personalityGuardFailures.length === 0;
        return {
          ok: deployOk,
          ...((!deployOk) && {
            error: `Personality write guard rejected ${personalityGuardFailures.length} agent(s): ${personalityGuardFailures.map(r => r.name).join(', ')}`,
          }),
          result: {
            // Echo the effective team back so the CLI can retarget its
            // daemon connection when /deploy targets a team different
            // from activeTeam.
            team: effectiveTeamName,
            teamId: effectiveTeamId,
            deployed: results.filter(r => r.success).length,
            failed: failedResults.length,
            agents: results
          }
        };
      }

      case 'agent': {
        // Control individual agent: /agent <name> <start|stop|rebuild|logs|heartbeat|wallet provision>
        const agentName = args[0];
        const subAction = args[1]?.toLowerCase();

        if (!agentName || !subAction) {
          return { ok: false, error: 'Usage: /agent <name> <start|stop|rebuild|logs|heartbeat|probe|wallet provision>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (subAction === 'probe') {
          // Single named agent — do NOT filter on status. The operator
          // explicitly asked to probe this agent; a downed agent should
          // surface as `failed` (with the timeout/network error string),
          // not be silently skipped.
          return this.probeAgentsViaTalk(teamName, [agent]);
        }

        if (subAction === 'wallet') {
          const walletAction = args[2]?.toLowerCase();
          if (walletAction !== 'provision') {
            return { ok: false, error: 'Usage: /agent <name> wallet provision' };
          }
          const meta = (agent.metadata || {}) as Record<string, any>;
          if (meta.ows_wallet) {
            return {
              ok: true,
              result: {
                action: 'wallet-provision',
                name: agent.name,
                status: 'already-provisioned',
                ows_wallet: meta.ows_wallet,
                ows_address: meta.ows_address || null,
              },
            };
          }
          if (!this.checkOwsInstalled()) {
            return { ok: false, error: 'OWS CLI not installed; cannot provision wallet on demand' };
          }
          const refreshed = await this.provisionAgentWalletForRow(teamId, teamName, agent);
          if (!refreshed) {
            return { ok: false, error: `Failed to provision OWS wallet for ${agent.name}` };
          }
          const provisionedMeta = (refreshed.metadata || {}) as Record<string, any>;
          return {
            ok: true,
            result: {
              action: 'wallet-provision',
              name: refreshed.name,
              status: 'provisioned',
              ows_wallet: provisionedMeta.ows_wallet,
              ows_address: provisionedMeta.ows_address || null,
            },
          };
        }

        // Remote-endpoint runtimes are lifecycled by the operator, not the manager.
        if (isRemoteEndpointRuntime(agent.runtime)) {
          return { ok: false, error: 'lifecycle_not_supported_for_remote' };
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
                await this.db.agents.updateStatus(agent.id, 'running');
                return { ok: true, result: { action: 'started', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to start ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'stop': {
              const killResult = await this.killAgentProcess(agent.port);
              const cancelled = await this.cancelPendingQueriesForAgent(teamId, agent.id);
              await this.db.agents.updateStatus(agent.id, 'stopped');
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
                await this.db.agents.updateStatus(agent.id, 'running');
                return { ok: true, result: { action: 'rebuilt', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to rebuild ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'logs': {
              return { ok: false, error: 'Logs not available for local agents' };
            }
            case 'heartbeat': {
              // Send heartbeat and reset timer
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
                return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml or HEARTBEAT.md file` };
              }
              // Send one immediate message and reseed the schedule
              if (agent.endpoint) {
                try {
                  await fetch(`${agent.endpoint}/talk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from: 'schedule', message: config.message }),
                  });
                } catch { /* ignore */ }
              }
              if (this.schedulerService) {
                const { definition, agentIds } = heartbeatToSchedule(agent.id, agent.name, config);
                await this.schedulerService.seedSchedule(definition, agentIds);
              }
              return { ok: true, result: { action: 'heartbeat', name: agent.name, intervalSeconds: config.interval, message: 'Heartbeat sent and schedule reseeded' } };
            }
            default:
              return { ok: false, error: `Unknown agent action: ${subAction}. Available: start, stop, rebuild, logs, heartbeat, probe, wallet provision` };
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
        await this.db.agents.updateStatus(agent.id, newStatus, { model: resolvedModel });

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
          const chainId = process.env.REGISTRY_CHAIN_ID || '8453';
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
        const teams = await this.db.teams.listTeams();
        const teamList = await Promise.all(
          teams.map(async (team) => {
            const agentCount = await this.db.agents.count(team.id);
            return {
              id: team.id,
              name: team.name,
              agentCount: parseInt(agentCount || '0')
            };
          })
        );
        return { ok: true, result: { teams: teamList } };
      }

      case 'team': {
        // /team - show current team (from header)
        const team = await this.db.teams.getTeam(teamId);
        if (!team) {
          return { ok: false, error: 'Team not found' };
        }
        const agentCount = await this.db.agents.count(teamId);
        return {
          ok: true,
          result: {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0')
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
            await this.db.agents.updateIdentity(agent.id, {
              endpoint: value || undefined,
              metadata: newMetadata,
            });
          } else {
            await this.db.agents.updateMetadata(agent.id, newMetadata);
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
          await this.db.agents.updateIdentity(agent.id, {
            domain: domainArg,
            token_id: tokenIdArg || undefined,
          });
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
        const newsItems = await this.db.news.getRecent(teamId, ['query', 'query.pending', 'pending_question'], 50);

        return {
          ok: true,
          result: {
            queries: newsItems.map((r: any) => ({
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
            const nameCheck = validateName(newName, 'agent');
            if (!nameCheck.valid) return { ok: false, error: nameCheck.error };
            await this.db.agents.updateIdentity(agent.id, { name: newName });
            newMetadata.alias = newMetadata.alias || agent.name;
            updates.push(`name → ${newName}`);
            i++;
          }
        }

        if (updates.length === 0) {
          return { ok: false, error: 'Nothing to update. Use --wallet <address> or --name <newname>' };
        }

        await this.db.agents.updateMetadata(agent.id, newMetadata);

        return { ok: true, result: { message: `Updated ${agent.name}: ${updates.join(', ')}` } };
      }

      case 'task': {
        const subCmd = args[0]?.toLowerCase() || 'list';

        if (subCmd === 'create') {
          // /task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...
          const rawArgs = args.slice(1);
          let title: string | undefined;
          let name: string | undefined;
          let description: string | undefined;
          let teamRef: string | undefined;
          let ownerRef: string | undefined;
          const eventIds: string[] = [];

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--name') { name = rawArgs[++i]; continue; }
            if (token === '--description') { description = rawArgs[++i]; continue; }
            if (token === '--team') { teamRef = rawArgs[++i]; continue; }
            if (token === '--owner') { ownerRef = rawArgs[++i]; continue; }
            if (token === '--event') { eventIds.push(rawArgs[++i]); continue; }
            if (!title) { title = token; continue; }
          }

          if (!title) {
            return { ok: false, error: 'Usage: /task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...' };
          }

          // Resolve optional team first (needed for name uniqueness check)
          let taskTeamId: string = teamId;
          if (teamRef) {
            const teamRow = await this.db.teams.getTeamByName(teamRef);
            if (!teamRow) return { ok: false, error: `Team "${teamRef}" not found` };
            taskTeamId = teamRow.id;
          }

          // Generate name from title if not provided
          if (!name) {
            name = normalizeAlias(title);
            // Ensure uniqueness by appending numeric suffix on conflict (scoped to team)
            let candidate = name;
            let suffix = 1;
            while (await this.db.tasks.getByNameForTeam(candidate, taskTeamId)) {
              candidate = `${name}-${suffix++}`;
            }
            name = candidate;
          } else {
            name = normalizeAlias(name);
            if (await this.db.tasks.getByNameForTeam(name, taskTeamId)) {
              return { ok: false, error: `Task name "${name}" already exists in this team` };
            }
          }

          // Resolve optional owner
          let ownerId: string | null = null;
          if (ownerRef) {
            const resolveTeam = taskTeamId || teamId;
            const { agent, error } = await this.resolveSingleAgentForCommand(resolveTeam, ownerRef);
            if (!agent) return { ok: false, error: error || `Agent "${ownerRef}" not found` };
            ownerId = agent.id;
          }

          // Validate event links
          for (const eid of eventIds) {
            const sDef = await this.db.schedules.getDefinition(eid);
            if (!sDef) return { ok: false, error: `Schedule "${eid}" not found` };
            if (sDef.kind !== 'calendar') return { ok: false, error: `Schedule "${eid}" is not a calendar event (kind: ${sDef.kind})` };
          }

          const now = Math.floor(Date.now() / 1000);
          const status = ownerId ? 'doing' : 'todo';
          // Resolve created_by from callerFrom if present
          let createdBy: string | null = null;
          if (callerFrom) {
            const { agent: callerAgent } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
            if (callerAgent) createdBy = callerAgent.id;
          }

          const taskRow: TaskRow = {
            id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            name,
            uuid: crypto.randomUUID(),
            team_id: taskTeamId,
            title,
            description: description || null,
            status,
            created_by: createdBy,
            owner: ownerId,
            created_at: now,
            updated_at: now,
            completed_at: null,
          };

          await this.db.tasks.create(taskRow, eventIds.length > 0 ? eventIds : undefined);

          return {
            ok: true,
            result: {
              task: await this.buildTaskResult(taskRow, teamId),
            },
          };
        }

        if (subCmd === 'list') {
          // /task list [--status todo|doing|done] [--owner <agent>] [--team <team>]
          const rawArgs = args.slice(1);
          let statusFilter: 'todo' | 'doing' | 'done' | undefined;
          let ownerFilter: string | undefined;
          let teamFilter: string | undefined;

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--status') { statusFilter = rawArgs[++i] as any; continue; }
            if (token === '--owner') { ownerFilter = rawArgs[++i]; continue; }
            if (token === '--team') { teamFilter = rawArgs[++i]; continue; }
          }

          // Resolve owner id
          let ownerIdFilter: string | undefined;
          if (ownerFilter) {
            const { agent, error } = await this.resolveSingleAgentForCommand(teamId, ownerFilter);
            if (!agent) return { ok: false, error: error || `Agent "${ownerFilter}" not found` };
            ownerIdFilter = agent.id;
          }

          // Resolve team id — default to current team for scoped resolution
          let teamIdFilter: string = teamId;
          if (teamFilter) {
            const teamRow = await this.db.teams.getTeamByName(teamFilter);
            if (!teamRow) return { ok: false, error: `Team "${teamFilter}" not found` };
            teamIdFilter = teamRow.id;
          }

          const tasks = await this.db.tasks.list({
            status: statusFilter,
            owner: ownerIdFilter,
            teamId: teamIdFilter,
          });

          const results = [];
          for (const t of tasks) {
            results.push(await this.buildTaskResult(t, teamId));
          }

          return { ok: true, result: { tasks: results } };
        }

        if (subCmd === 'assign') {
          // /task assign <task-name> <agent> [--team <team>]
          const taskName = args[1];
          const agentRef = args[2];
          if (!taskName || !agentRef) {
            return { ok: false, error: 'Usage: /task assign <task-name|#shortid> <agent> [--team <team>]' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskName, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskName}" not found` };

          // Check for --team flag
          let resolveTeam = teamId;
          for (let i = 3; i < args.length; i++) {
            if (args[i] === '--team' && args[i + 1]) {
              const teamRow = await this.db.teams.getTeamByName(args[i + 1]);
              if (!teamRow) return { ok: false, error: `Team "${args[i + 1]}" not found` };
              resolveTeam = teamRow.id;
              break;
            }
          }

          const { agent, error } = await this.resolveSingleAgentForCommand(resolveTeam, agentRef);
          if (!agent) return { ok: false, error: error || `Agent "${agentRef}" not found` };

          const now = Math.floor(Date.now() / 1000);
          await this.db.tasks.updateFields(task.id, {
            owner: agent.id,
            status: 'doing',
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'claim') {
          // /task claim <task-name|#shortid> (agent API via /remote with from field)
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task claim <task-name|#shortid>' };
          }

          if (!callerFrom) {
            return { ok: false, error: 'Claim requires agent identity. Use /remote with a "from" field.' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          // Cross-team claim guard
          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          // Resolve caller agent
          const { agent: callerAgent, error: callerError } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
          if (!callerAgent) return { ok: false, error: callerError || `Caller agent "${callerFrom}" not found` };

          const now = Math.floor(Date.now() / 1000);
          const claimed = await this.db.tasks.claim(task.id, callerAgent.id, now);
          if (!claimed) {
            return { ok: false, error: `Cannot claim "${task.name}" — task is already owned or not in todo status` };
          }

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'done') {
          // /task done <task-name|#shortid>
          // Manager can mark any task done; agent can only mark its own task done.
          //
          // This path is what the TUI and any `POST /remote {command:'/task done …'}`
          // caller hits. It MUST run the same close cascade as the
          // REST endpoint so checkin auto-close, task:completed events,
          // and graph re-evaluation all fire on either close path.
          // Before this consolidation the CLI path silently skipped the
          // event emit + checkin close, producing the "task closed but
          // downstream projection still says doing" failure mode.
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task done <task-name|#shortid>' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          // Cross-team done guard
          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          // If called by an agent (callerFrom set), enforce ownership
          let actorAgentId: string | null = null;
          if (callerFrom) {
            const { agent: callerAgent } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
            if (callerAgent && task.owner !== callerAgent.id) {
              return { ok: false, error: `Agent "${callerFrom}" is not the owner of task "${task.name}"` };
            }
            actorAgentId = callerAgent?.id ?? null;
          }

          const updated = await this.closeTaskAndCascade({
            task,
            teamId,
            actorAgentId,
          });
          return { ok: true, result: { task: await this.buildTaskResult(updated, teamId) } };
        }

        if (subCmd === 'remove') {
          // /task remove <task-name|#shortid>
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task remove <task-name|#shortid>' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          await this.db.tasks.delete(task.id);
          return { ok: true, result: { removed: task.name } };
        }

        return {
          ok: false,
          error: 'Usage: /task <create|list|assign|claim|done|remove> ...',
        };
      }

      default:
        return { ok: false, error: `Unknown command: ${action}. Available: agents, status, schedule, delete, ask, hey, news, register, deploy, agent, model, tasks, task, configs, registry, teams, team, keys, meta, pay, heartbeat, heartbeats, cancel, clear, list, update, sync-wallets` };
    }
  }

  /**
   * Derive a health status string for a remote-endpoint agent from its DB probe columns.
   */
  private deriveRemoteHealth(a: AgentRow): 'online' | 'unstable' | 'offline' | 'unknown' {
    if (a.last_probed_at == null) return 'unknown';
    if (a.consecutive_failures === 0) return 'online';
    if (a.consecutive_failures <= 2) return 'unstable';
    return 'offline';
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
   * Also starts the remote heartbeat loop in parallel.
   */
  private startHealthMonitor(): void {
    // Run immediately, then every 30 seconds
    this.runHealthChecks();
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30_000);

    // Remote probe loop — same cadence, parallel to local loop
    this.runRemoteHeartbeat();
    this.remoteProbeInterval = setInterval(() => this.runRemoteHeartbeat(), 30_000);
  }

  /**
   * Start the stuck-query sweeper.
   *
   * Agents that crash mid-query never transition their queries out of
   * 'pending'/'processing' (the agent process is the thing that would have
   * written 'completed' or 'failed'). Without this sweeper the queries table
   * accumulates ghosts and callers polling /query/:id see 'pending' forever.
   *
   * We run every 5 minutes and mark any pending/processing query older than
   * QUERY_EXPIRY_MINUTES as 'expired'. See expireStale() for the actual SQL.
   */
  private startQuerySweeper(): void {
    const intervalMs = 5 * 60 * 1000;
    const runSweep = () => {
      this.sweepStaleQueries().catch((err) => {
        console.error('[Manager] Query sweeper failed:', err);
      });
    };
    runSweep();
    this.querySweeperInterval = setInterval(runSweep, intervalMs);
  }

  /**
   * Start the event_log retention sweep.
   *
   * Audit #6 (output/security-review-wakeup-service.md): the design promises
   * a 7-day age cap and 100k-events-per-team count cap on `event_log`.
   * This loop enforces both, default every 5 minutes. Constants and env
   * overrides live in src/wakeup-service/retention.ts.
   */
  private startEventLogRetentionSweep(): void {
    this.retentionService = new RetentionService({ events: this.db.events, teams: this.db.teams });
    this.retentionService.start();
  }

  private async sweepStaleQueries(): Promise<void> {
    const cutoff = Date.now() - this.QUERY_EXPIRY_MINUTES * 60 * 1000;
    const expired = await this.db.queries.expireStale(cutoff, ['pending', 'processing']);
    const count = expired.length;
    if (count > 0) {
      const occurredAt = Date.now();
      for (const row of expired) {
        await emitQueryExpired(this.db.events, {
          teamId: row.team_id,
          queryId: row.query_id,
          agentId: row.agent_id,
          occurredAt,
        }).catch((err) => {
          console.error('[Manager] Failed to emit query:expired event:', err);
        });
      }
      this.managerLog(
        `Expired ${count} stale queries older than ${this.QUERY_EXPIRY_MINUTES} minutes`,
      );
      console.log(
        `[Manager] Query sweeper expired ${count} stale queries (>${this.QUERY_EXPIRY_MINUTES} min old)`,
      );
    }
  }

  /**
   * Local-agent health check loop.
   *
   * IMPORTANT: NEVER probe remote-endpoint agents here.  Remote agents
   * (public-agent-remote runtime) are handled exclusively by runRemoteHeartbeat().
   * Attempting to probe them from this path would hit their public internet
   * endpoint from the wrong loop, double-count failures, and bypass the
   * concurrency cap enforced by runRemoteHeartbeat.
   *
   * The isRemoteEndpointRuntime() guard below is the canonical firewall.
   * It MUST remain the first runtime check inside the per-agent loop body.
   */
  private async runHealthChecks(): Promise<void> {
    try {
      const teams = await this.db.teams.listTeams();
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          // Skip virtual agents — they don't have a local /health endpoint
          if (agent.type === 'virtual') continue;
          // GUARD: Skip remote-endpoint agents — handled exclusively by runRemoteHeartbeat().
          // This check must come before any network I/O so remote agents can never
          // be reached from this local-heartbeat path.
          if (isRemoteEndpointRuntime(agent.runtime)) continue;

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
              await this.db.agents.updateStatus(agent.id, 'running');
            } else if (!isOnline && agent.status === 'running') {
              await this.db.agents.updateStatus(agent.id, 'offline');
            }
          } catch {
            this.healthStatus.set(key, { status: 'offline', lastCheck: Date.now() });
            if (agent.status === 'running') {
              await this.db.agents.updateStatus(agent.id, 'offline').catch(() => {});
            }
          }
        }
      }
    } catch (err: any) {
      // Don't crash the interval on transient DB errors
    }
  }

  /**
   * Run a single heartbeat probe tick for all remote-endpoint agents.
   * Probes are bounded to 8 concurrent in-flight requests.
   */
  private async runRemoteHeartbeat(): Promise<void> {
    try {
      const teams = await this.db.teams.listTeams();
      const remoteAgents: Array<{ team: { id: string }; agent: AgentRow }> = [];
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          if (isRemoteEndpointRuntime(agent.runtime)) {
            remoteAgents.push({ team, agent });
          }
        }
      }

      // Bounded concurrency: chunks of 8
      const CONCURRENCY = 8;
      for (let i = 0; i < remoteAgents.length; i += CONCURRENCY) {
        const chunk = remoteAgents.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(({ team, agent }) =>
          this.probeOneRemoteAgent(team.id, agent).catch(() => {
            // Swallow errors — don't let one failure kill the loop
          }),
        ));
      }
    } catch {
      // Don't crash the interval on transient DB errors
    }
  }

  /**
   * Probe a single remote agent, persist the result, and update healthStatus.
   */
  private async probeOneRemoteAgent(teamId: string, agent: AgentRow): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await probeRemoteAgent(agent, { fetch: this.healthProbeFn });

    if (result.ok) {
      await this.db.agents.updateProbeResult(agent.id, {
        last_seen: result.last_seen,
        last_probed_at: now,
        last_error: result.last_error,
        consecutive_failures: 0,
      });
      const updated = { ...agent, last_seen: result.last_seen, last_probed_at: now, last_error: result.last_error, consecutive_failures: 0 };
      const health = this.deriveRemoteHealth(updated);
      this.healthStatus.set(this.key(teamId, agent.id), { status: health as any, lastCheck: Date.now() });
    } else {
      const newFailures = (agent.consecutive_failures ?? 0) + 1;
      await this.db.agents.updateProbeResult(agent.id, {
        last_probed_at: now,
        last_error: result.last_error,
        consecutive_failures: newFailures,
      });
      const updated = { ...agent, last_probed_at: now, consecutive_failures: newFailures };
      const health = this.deriveRemoteHealth(updated);
      this.healthStatus.set(this.key(teamId, agent.id), { status: health as any, lastCheck: Date.now() });
    }
  }

  async start(port: number = 4100): Promise<void> {
    this.managementPort = port;
    return new Promise((resolve) => {
      // Create HTTP server from Express app
      this.httpServer = createHttpServer(this.managementApp);

      // Create WebSocket server attached to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

      this.wss.on('connection', (ws, req) => {
        this.handleWebSocketConnection(ws, req);
      });

      this.httpServer.listen(port, '127.0.0.1', async () => {
        console.log(`\n🚀 ID Agent Manager (DB-backed)`);
        console.log(`===============================`);
        console.log(`Management API: http://localhost:${port}`);
        console.log(`WebSocket: ws://localhost:${port}/ws`);
        console.log(`\n`);

        // Initialize and start the scheduler service
        this.schedulerService = new SchedulerService(this.db, async (agentId: string) => {
          const agent = await this.db.agents.getById(agentId);
          if (!agent || !agent.endpoint) return null;
          const endpoints = await discoverRestAPEndpoints(agent.endpoint);
          return {
            id: agent.id,
            name: agent.name,
            endpoint: agent.endpoint.replace(/\/+$/, ''),
            talkPath: endpoints.talk || '/talk',
            schedulePath: endpoints.schedule || null,
            status: agent.status,
          };
        });
        this.schedulerService.start();

        // Seed well-known teams (idempotent — getOrCreateTeamId is safe to call repeatedly)
        await this.seedWellKnownTeams();

        // Bootstrap the concurrency-aware Dispatch scheduler. Bound to the
        // `default` team in Phase A. Other teams continue on legacy direct-
        // /talk paths until per-team handles land. Gateway flag controls
        // whether handleMessage routes through enqueue (shadow logs but legacy
        // runs; enforce removes legacy direct call for default-team paths).
        if (this.db.adapter.dialect === 'sqlite') {
          try {
            const defaultTeamId = await this.db.teams.getOrCreateTeamId('default');
            this.dispatchScheduler = new SchedulerHandle({
              adapter: this.db.adapter as SqliteAdapter,
              teamId: defaultTeamId,
              // B0 (2026-06-08): plumb the queries repo into the scheduler so
              // its terminal-closeout + silence-detection passes can read
              // queries.status / last_output_at evidence from B1.
              queriesRepository: this.db.queries,
              resolveTargetUrl: async (agentName: string) => {
                // Resolve the worker agent's REST endpoint by name (lookup is
                // team-local; default team in Phase A).
                const agent = await this.db.agents
                  .getByName(defaultTeamId, agentName)
                  .catch(() => null);
                if (!agent || !agent.endpoint) return null;
                return agent.endpoint;
              },
              env: process.env,
              // N1.3: scheduler-owned status mutations trigger graph re-evaluation.
              onDispatchStatusChanged: (phid, newStatus) => {
                const triggerMap: Record<string, string> = {
                  done: 'dispatch_done',
                  failed: 'dispatch_failed',
                  cancelled: 'dispatch_cancelled',
                };
                const trigger = triggerMap[newStatus];
                if (trigger) {
                  this.evaluateGraphsForDispatchBestEffort(phid, trigger);
                }
              },
            });
            this.dispatchScheduler.start();
            // W2-1 DispatchVerification — stand up the durable projection on the
            // SAME SqliteAdapter + default team the reactor uses, then start the
            // periodic verification job. The Agents endpoints (mounted in
            // setupRoutes) read this projection; they never stat files per
            // request. Best-effort: any failure here logs but leaves the
            // scheduler running and the routes returning 503.
            try {
              const dvCfg = jobConfigFromEnv(process.env);
              this.dispatchVerificationStorage = new DispatchVerificationStorage(
                this.db.adapter as SqliteAdapter,
              );
              await this.dispatchVerificationStorage.migrate();
              const dvStat = (p: string) => {
                try {
                  const s = statSync(p);
                  return { exists: true, is_file: s.isFile(), mtime_iso: new Date(s.mtimeMs).toISOString() };
                } catch {
                  return { exists: false, is_file: false, mtime_iso: null };
                }
              };
              this.dispatchVerificationJob = new DispatchVerificationJob({
                teamId: defaultTeamId,
                reactor: this.dispatchScheduler.reactor,
                storage: this.dispatchVerificationStorage,
                statArtifact: dvStat,
                now: () => new Date().toISOString(),
                enabled: dvCfg.enabled,
                intervalMs: dvCfg.intervalMs,
                lookbackDays: dvCfg.lookbackDays,
              });
              this.dispatchVerificationJob.start();
              console.log(
                `[Manager] DispatchVerification job started (enabled=${dvCfg.enabled} intervalMs=${dvCfg.intervalMs} lookbackDays=${dvCfg.lookbackDays})`,
              );
            } catch (dvErr) {
              console.warn(
                '[Manager] DispatchVerification job failed to start:',
                dvErr instanceof Error ? dvErr.message : String(dvErr),
              );
              this.dispatchVerificationStorage = null;
              this.dispatchVerificationJob = null;
            }
            // P0 dispatch recovery — stand up the auto-recovery loop over the
            // scheduler reactor (which is the live DispatchRecoveryReactor
            // adapter). It runs one backfill pass immediately (reconciles the
            // already-stuck landed/expired rows) then on an interval. Env-gated
            // (DISPATCH_RECOVERY_ENABLED, default off); runOnce never throws.
            try {
              const recCfg = recoveryConfigFromEnv(process.env);
              this.dispatchRecoveryService = new DispatchRecoveryService({
                reactor: this.dispatchScheduler.reactor as unknown as DispatchRecoveryReactor,
                config: {
                  max_attempts: recCfg.maxAttempts,
                  retryable_detail_markers: DEFAULT_RECOVERY_CONFIG.retryable_detail_markers,
                },
                now: () => new Date().toISOString(),
                enabled: recCfg.enabled,
                budget: recCfg.budget,
                backoffMs: recCfg.backoffMs,
                // D3: git ground-truth probe — a failed/expired dispatch whose
                // promoted commit is actually on the target base is reconciled
                // (verified_done), not retried (the lost-closeout false-expire).
                commitEvidence: makeGitCommitEvidenceProbe(),
              });
              this.dispatchRecoveryService.start(recCfg.intervalMs);
              console.log(
                `[Manager] DispatchRecovery service started (enabled=${recCfg.enabled} intervalMs=${recCfg.intervalMs} budget=${recCfg.budget} maxAttempts=${recCfg.maxAttempts})`,
              );
            } catch (recErr) {
              console.warn(
                '[Manager] DispatchRecovery service failed to start:',
                recErr instanceof Error ? recErr.message : String(recErr),
              );
              this.dispatchRecoveryService = null;
            }
            // R.1 orphan-process sweep — detached agent-server children from a
            // previous (crashed) manager run survive as orphans (spawn is
            // detached+unref). Detect them on startup and report typed; kill
            // only when DISPATCH_ORPHAN_SWEEP_KILL is set (safe default: mark +
            // log, operator opts into killing). minAgeSec protects any child
            // started in the last 2 minutes. Never throws.
            try {
              const killEnabled = ['true', '1', 'yes'].includes(
                (process.env.DISPATCH_ORPHAN_SWEEP_KILL ?? '').trim().toLowerCase(),
              );
              const sweep = await sweepOrphanAgents({
                listProcesses: () => listMatchingProcesses('local-agent-server'),
                keepPids: new Set<number>([process.pid]),
                minAgeSec: 120,
                signal: 'SIGTERM',
                kill: killEnabled
                  ? (pid, signal) => process.kill(pid, signal)
                  : () => undefined, // detect-only by default
              });
              if (sweep.orphan_pids.length > 0) {
                console.warn(
                  `[Manager] orphan agent-server sweep: ${sweep.orphan_pids.length} orphan(s) ` +
                    `${killEnabled ? `killed=${sweep.killed} errors=${sweep.errors}` : '(detect-only; set DISPATCH_ORPHAN_SWEEP_KILL=true to reap)'} ` +
                    `pids=[${sweep.orphan_pids.join(',')}]`,
                );
              } else if (sweep.list_error) {
                console.warn('[Manager] orphan agent-server sweep skipped:', sweep.list_error);
              }
            } catch (sweepErr) {
              console.warn(
                '[Manager] orphan agent-server sweep failed:',
                sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
              );
            }
            // Task 10: surface the canonical-mode flag on startup so operators
            // can confirm the rollout phase from the manager log without
            // shelling into the process. The mode is captured once at boot
            // (see field initializer) — re-parsing on every log line would
            // mask process-restart drift.
            console.log(
              `[Manager] dispatch_canonical_mode=${this.dispatchCanonicalMode}`,
            );
          } catch (err) {
            console.warn(
              '[Manager] Failed to bootstrap dispatch scheduler:',
              err instanceof Error ? err.message : String(err),
            );
            this.dispatchScheduler = null;
          }
        }

        // Start periodic health monitoring (every 30s)
        this.startHealthMonitor();

        // Start stuck-query sweeper (every 5 min, expires >15 min old)
        this.startQuerySweeper();

        // Start event_log retention sweep (every 5 min, 7d / 100k-per-team caps)
        this.startEventLogRetentionSweep();

        // P6 Agent Performance Telemetry — mount /metrics/* routes.
        try {
          const { mountMetricsRoutes } = await import('./telemetry/routes.js');
          mountMetricsRoutes(this.managementApp, this.db.adapter);
          console.log('[Manager] P6 telemetry /metrics/* routes mounted');
        } catch (err) {
          console.warn('[Manager] P6 telemetry routes failed to mount:', err instanceof Error ? err.message : String(err));
        }

        // Monitor — read-only fleet health and completions endpoints.
        try {
          const { mountMonitorRoutes } = await import('./monitor/routes.js');
          mountMonitorRoutes(this.managementApp, this.db.adapter);
          console.log('[Manager] Monitor /monitor/* routes mounted');
        } catch (err) {
          console.warn('[Manager] Monitor routes failed to mount:', err instanceof Error ? err.message : String(err));
        }

        // Usage Meter (Spec 2026-05-31) — GET /usage + /usage/gate +
        // scheduler gate provider. WARN-ONLY by default; operators set
        // USAGE_GATE_ENFORCEMENT=enforce to opt into hard-gating.
        // Initialization is best-effort: failure logs but never wedges
        // the manager startup or the dispatch lifecycle.
        try {
          const [{ createUsageMeterService }, { mountUsageMeterRoutes }] = await Promise.all([
            import('./usage-meter/service.js'),
            import('./usage-meter/routes.js'),
          ]);
          const cwd = process.cwd();
          const configsPath = `${cwd}/configs/usage-budget-policy.json`;
          const { service, loaded, enforcement } = createUsageMeterService({
            adapter: this.db.adapter,
            env: process.env,
            configsPath,
          });
          mountUsageMeterRoutes(this.managementApp, { service });
          if (this.dispatchScheduler) {
            this.dispatchScheduler.scheduler.setUsageGateProvider({
              getSnapshotForScheduler: () => service.getSnapshotForScheduler(),
              getExcludedAgentsForClaim: () => service.getExcludedAgentsForClaim(),
            });
          }
          console.log(
            `[Manager] Usage Meter /usage mounted (policy=${loaded.source}` +
              `${loaded.degraded ? ` DEGRADED:${loaded.degraded_reason ?? "?"}` : ""}, ` +
              `enforcement=${enforcement})`,
          );
        } catch (err) {
          console.warn(
            '[Manager] Usage Meter routes failed to mount (continuing):',
            err instanceof Error ? err.message : String(err),
          );
        }

        // P2 Inbox 2.0 — mount /inbox/* routes.
        try {
          const { mountInboxRoutes } = await import('./inbox/routes.js');
          mountInboxRoutes(this.managementApp, this.db.adapter);
          console.log('[Manager] P2 inbox /inbox/* routes mounted');
        } catch (err) {
          console.warn('[Manager] P2 inbox routes failed to mount:', err instanceof Error ? err.message : String(err));
        }

        // Kapelle B11 — manager-owned artifact review surface
        // (/outputs/inbox, /artifacts/:id/{review,view,operations,approve,ship}).
        try {
          const [{ mountOutputsRoutes }, { migrateOutputsTables }] = await Promise.all([
            import('./outputs/routes.js'),
            import('./outputs/storage.js'),
          ]);
          await migrateOutputsTables(this.db.adapter);
          // Kapelle P3 (2026-06-09): inject the tasks repo + team
          // resolver so POST /artifacts/:id/approve becomes the
          // canonical manager-side emit target for reviewed-artifact
          // approvals. Without these, the approve endpoint still
          // records the operation but skips the downstream task emit.
          mountOutputsRoutes(this.managementApp, this.db.adapter, {
            tasks: this.db.tasks,
            resolveTeamId: async (req) => (await this.getTeam(req)).id,
          });
          console.log('[Manager] Kapelle B11 outputs routes mounted (/outputs/inbox, /artifacts/:id/*) with P3 emit target');
        } catch (err) {
          console.warn('[Manager] B11 outputs routes failed to mount:', err instanceof Error ? err.message : String(err));
        }

        // Kapelle OP-1 decisions queue (2026-06-09): structured-status
        // backed decision store + queryable read surface. Replaces the
        // prose-inferred decisions queue that produced the false-open
        // calendar-incident; GET /decisions/queue?status=open filters on
        // a CHECK-constrained `status` column, never on prose.
        try {
          const [{ mountDecisionsRoutes }, { migrateDecisionsTables }] = await Promise.all([
            import('./decisions/routes.js'),
            import('./decisions/storage.js'),
          ]);
          await migrateDecisionsTables(this.db.adapter);
          mountDecisionsRoutes(this.managementApp, this.db.adapter);
          console.log('[Manager] Kapelle decisions routes mounted (/decisions/queue, /decisions/:id/decide)');
        } catch (err) {
          console.warn('[Manager] Decisions routes failed to mount:', err instanceof Error ? err.message : String(err));
        }

        // P1 Dependency-Graph Orchestrator — mount /graphs/* routes.
        try {
          const { mountGraphRoutes } = await import('./graph/routes.js');
          const graphOpts = this.dispatchScheduler
            ? { enqueueDispatch: this.dispatchScheduler.enqueue.bind(this.dispatchScheduler) }
            : undefined;
          mountGraphRoutes(this.managementApp, this.db.adapter, graphOpts);
          console.log('[Manager] P1 graph /graphs/* routes mounted');
        } catch (err) {
          console.warn('[Manager] P1 graph routes failed to mount:', err instanceof Error ? err.message : String(err));
        }

        // Supervisor v0 — watch-and-alert loop behind SUPERVISOR_WATCH_ENABLED.
        if (process.env.SUPERVISOR_WATCH_ENABLED === 'true') {
          try {
            const { SupervisorWatcher, parseSupervisorConfig, ManagerSourceReader } = await import('./supervisor/index.js');
            const supervisorConfig = parseSupervisorConfig(process.env);
            const defaultTeamId = await this.db.teams.getOrCreateTeamId('default');
            const sourceReader = new ManagerSourceReader({
              adapter: this.db.adapter,
              teamId: defaultTeamId,
            });
            const watcher = new SupervisorWatcher({
              config: supervisorConfig,
              sourceReader,
            });
            watcher.start();
            this.supervisorWatcher = watcher;
            console.log('[Manager] Supervisor v0 watcher started');
          } catch (err) {
            console.warn('[Manager] Supervisor v0 watcher failed to start:', err instanceof Error ? err.message : String(err));
          }
        }

        // Start checkin due-service tick (default 30s) so active checkins
        // actually fire instead of accumulating with `next_fire_at <= now`.
        // Wake on every fire: every priority POSTs to the owner's /news
        // with trigger:true so the dispatcher's LLM is actually woken.
        // Priority is preserved on the payload as metadata (the LLM reads
        // it to decide urgency); it does NOT gate whether the wake fires —
        // an un-woken check-in is operationally identical to no check-in.
        // Loop safety lives in the receiver's /news handler (noAutoReply on
        // triggered queries).
        this.checkinService = new CheckinService(this.db, {
          dispatchWake: async (input) => {
            const owner = await this.db.agents.getById(input.ownerAgentId).catch(() => null);
            if (!owner || !owner.endpoint) return;
            const url = `${owner.endpoint.replace(/\/+$/, '')}/news`;
            // skip_persist:true: CheckinService.writeOwnerNews already wrote
            // the canonical inbox row before this dispatch ran. The wake POST
            // must trigger startQuery on the receiver but must NOT persist a
            // second news_item — otherwise high-priority fires would create
            // duplicate visible inbox entries.
            //
            // Bounded timeout: fireRow awaits dispatchWake and CheckinService
            // serializes ticks, so a hung owner endpoint would stall the
            // entire due-service loop. 5s matches the /news-to forward path.
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'checkin-service',
                trigger: true,
                skip_persist: true,
                type: 'checkin_due',
                message: input.message,
                data: input.data,
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              throw new Error(`wake POST ${url} returned ${res.status}`);
            }
          },
        });
        this.checkinService.start();
        console.log('[Manager] CheckinService started (wake on every fire)');

        resolve();
      });
    });
  }

  /**
   * Stop background services and close the HTTP/WS server. Safe to call
   * multiple times. Wired into SIGTERM/SIGINT in start-agent-manager.ts so
   * the manager shuts down cleanly without leaking timers or sockets.
   */
  async shutdown(): Promise<void> {
    if (this.supervisorWatcher) {
      this.supervisorWatcher.stop();
      this.supervisorWatcher = null;
    }
    if (this.checkinService) {
      this.checkinService.stop();
      this.checkinService = null;
    }
    if (this.schedulerService) {
      this.schedulerService.stop();
      this.schedulerService = null;
    }
    if (this.dispatchVerificationJob) {
      this.dispatchVerificationJob.stop();
      this.dispatchVerificationJob = null;
    }
    if (this.dispatchRecoveryService) {
      this.dispatchRecoveryService.stop();
      this.dispatchRecoveryService = null;
    }
    if (this.dispatchScheduler) {
      this.dispatchScheduler.stop();
      this.dispatchScheduler = null;
    }
    if (this.retentionService) {
      this.retentionService.stop();
      this.retentionService = null;
    }
    if (this.querySweeperInterval) {
      clearInterval(this.querySweeperInterval);
      this.querySweeperInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.remoteProbeInterval) {
      clearInterval(this.remoteProbeInterval);
      this.remoteProbeInterval = null;
    }
    if (this.wss) {
      try { this.wss.close(); } catch { /* swallow */ }
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((res) => this.httpServer!.close(() => res()));
      this.httpServer = null;
    }
  }

  private async initSchedules(): Promise<void> {
    // Intentionally left unused. Schedules persist in the DB and should not be reseeded on boot,
    // because reseeding interval schedules would reset their anchor and expiry.
  }

  /**
   * Ensure well-known teams exist: `default` (fallback for unscoped requests)
   * and `public` (public-agent registrations). Created idempotently on every
   * manager start. User-specific project teams are NOT seeded here — deploy
   * them with `/deploy <config>` instead.
   */
  private async seedWellKnownTeams(): Promise<void> {
    try {
      const seeded: string[] = [];
      for (const name of ['default', 'public']) {
        await this.db.teams.getOrCreateTeamId(name);
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        seeded.push(name);
      }
      console.log(`[Manager] Well-known teams seeded: ${seeded.join(', ')}`);
    } catch (err: any) {
      // Non-fatal: log and continue
      console.warn('[Manager] Failed to seed well-known teams:', err?.message);
    }
  }


  /**
   * Handle a new WebSocket connection
   */
  private async handleWebSocketConnection(ws: WebSocket, req: any) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const teamHeader = req.headers['x-id-team'] || req.headers['x-id-project'] || url.searchParams.get('team');

    // Resolve team — look up only; do NOT auto-create. A stale client
    // reconnecting with a team name that was deleted must not resurrect it.
    const teamName = teamHeader ? String(teamHeader) : (process.env.ID_TEAM || 'default');
    const teamRow = await this.db.teams.getTeamByName(teamName);
    if (!teamRow) {
      console.log(`[WS] Rejecting connection for unknown team "${teamName}"`);
      try {
        ws.send(JSON.stringify({ type: 'error', error: 'team_not_found', team: teamName }));
      } catch { /* swallow */ }
      ws.close(1008, 'team_not_found');
      return;
    }
    const teamId = teamRow.id;

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

  /**
   * Notify connected CLIs that the agent registry for a team changed.
   * Lets the CLI clear stale per-name session state and surface a one-line
   * "registry updated" hint without forcing the operator to restart.
   */
  broadcastAgentsChanged(
    teamId: string,
    change: {
      reason: 'sync' | 'deploy' | 'spawn' | 'remove' | 'update';
      added?: string[];
      updated?: string[];
      removed?: string[];
    }
  ) {
    const payload = JSON.stringify({
      type: 'agents_changed',
      teamId,
      change: {
        reason: change.reason,
        added: change.added || [],
        updated: change.updated || [],
        removed: change.removed || [],
      },
      timestamp: Date.now(),
    });
    for (const client of this.wsClients) {
      if (client.teamId === teamId && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(payload);
        } catch {
          /* drop send errors — closing handler will clean up */
        }
      }
    }
  }

  // ==================== Heartbeat System ====================

  /**
   * Read heartbeat config from agent's working directory.
   * Checks HEARTBEAT.yaml (legacy) first, then HEARTBEAT.md (new model).
   */
  private readHeartbeatConfig(workingDirectory: string): HeartbeatConfig | null {
    // Legacy: HEARTBEAT.yaml with interval + message
    const yamlPath = path.join(workingDirectory, 'HEARTBEAT.yaml');
    if (existsSync(yamlPath)) {
      try {
        const content = readFileSync(yamlPath, 'utf-8');
        const config = yaml.load(content) as { interval?: number; message?: string; maxBeats?: number; expiresAfter?: number };
        if (typeof config?.interval === 'number' && typeof config?.message === 'string') {
          return {
            interval: config.interval,
            message: config.message.trim(),
            ...(typeof config.maxBeats === 'number' && { maxBeats: config.maxBeats }),
            ...(typeof config.expiresAfter === 'number' && { expiresAfter: config.expiresAfter })
          };
        }
      } catch (error: any) {
        console.log(`[Heartbeat] Error reading ${yamlPath}: ${error.message}`);
      }
    }

    // New model: HEARTBEAT.md exists → agent-driven, use generic message
    const mdPath = path.join(workingDirectory, 'HEARTBEAT.md');
    if (existsSync(mdPath)) {
      return {
        interval: 86400,  // default interval for manual enable; overridden by config
        message: HEARTBEAT_GENERIC_MESSAGE,
      };
    }

    return null;
  }


  /**
   * Cancel all pending/processing queries for an agent when it stops.
   * This prevents orphaned queries from showing up in status.
   */
  async cancelPendingQueriesForAgent(teamId: string, agentId: string): Promise<number> {
    try {
      const ts = Date.now();

      // Cancel all pending/processing queries and get their IDs
      const queryIds = await this.db.queries.cancel(agentId, ts);

      if (queryIds.length === 0) {
        return 0;
      }

      // Add query.cancelled news items for each, and wake any long-poll waiters.
      for (const queryId of queryIds) {
        await this.db.news.add(teamId, agentId, {
          timestamp: ts,
          type: 'query.cancelled',
          message: 'Query cancelled (agent stopped)',
          data: { reason: 'agent_stopped', query_id: queryId },
          query_id: queryId,
        });
        this.notifyQueryStatusWaiters(teamId, queryId);
      }

      console.log(`[Manager] Cancelled ${queryIds.length} pending queries for agent ${agentId}`);
      return queryIds.length;
    } catch (err) {
      console.error(`[Manager] Error cancelling queries for agent ${agentId}:`, err);
      return 0;
    }
  }

  // -- long-poll helpers for GET /query/:id?wait= ---------------------------

  private addQueryStatusWaiter(teamId: string, queryId: string, fn: () => void): void {
    const key = `${teamId}:${queryId}`;
    let set = this.queryStatusWaiters.get(key);
    if (!set) {
      set = new Set();
      this.queryStatusWaiters.set(key, set);
    }
    set.add(fn);
  }

  private removeQueryStatusWaiter(teamId: string, queryId: string, fn: () => void): void {
    const key = `${teamId}:${queryId}`;
    const set = this.queryStatusWaiters.get(key);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.queryStatusWaiters.delete(key);
  }

  private notifyQueryStatusWaiters(teamId: string, queryId: string): void {
    const key = `${teamId}:${queryId}`;
    const set = this.queryStatusWaiters.get(key);
    if (!set) return;
    const waiters = Array.from(set);
    this.queryStatusWaiters.delete(key);
    for (const fn of waiters) {
      try { fn(); } catch { /* non-fatal */ }
    }
  }

  /**
   * Wallet opt-in: produce the metadata that should be persisted for an
   * agent based on its config. Honors `walletOptIn === true` by calling
   * `getOrCreateAgentWallet` once and merging the resulting wallet name
   * and address into the metadata. Honors `walletOptIn === false` by
   * recording the explicit opt-out flag without calling the OWS CLI.
   * `walletOptIn === undefined` leaves the metadata untouched, preserving
   * legacy behaviour for configs that pre-date the flag.
   *
   * Returns the (possibly updated) metadata and the provisioned wallet
   * descriptor (or null) so callers that need to know about the wallet
   * (e.g. `deploySkillsToAgent`'s `hasWallet` flag) can branch on it.
   */
  private resolveWalletMetadata(
    teamName: string,
    agentName: string,
    metadata: AgentMetadata,
    walletOptIn: boolean | undefined,
  ): { metadata: AgentMetadata; wallet: { walletName: string; address: string } | null } {
    const nextMetadata = this.withWalletConfigMetadata(metadata, walletOptIn);
    if (walletOptIn !== true) {
      return { metadata: nextMetadata, wallet: null };
    }

    const wallet = this.getOrCreateAgentWallet(teamName, agentName);
    if (!wallet) {
      return { metadata: nextMetadata, wallet: null };
    }

    return {
      metadata: {
        ...nextMetadata,
        ows_wallet: wallet.walletName,
        ows_address: wallet.address,
      },
      wallet,
    };
  }

  private isWalletProvisioningEnabled(metadata: unknown): boolean {
    return (metadata as Record<string, unknown> | null | undefined)?.wallet === true;
  }

  private withoutProvisionedWalletMetadata(metadata: AgentMetadata): AgentMetadata {
    const next = { ...metadata };
    delete next.ows_wallet;
    delete next.ows_address;
    return next;
  }

  private withWalletConfigMetadata(metadata: AgentMetadata, walletOptIn: boolean | undefined): AgentMetadata {
    const next = this.withoutProvisionedWalletMetadata(metadata);
    if (walletOptIn !== undefined) {
      next.wallet = walletOptIn;
    } else {
      delete next.wallet;
    }
    return next;
  }

  /**
   * Wallet opt-in: provision (or reuse) an OWS wallet for an existing
   * agent row, persist `wallet: true` plus the wallet identifiers on the
   * row's metadata, and return the refreshed row. Returns `null` if OWS
   * is not installed or wallet creation fails. Used by both the on-demand
   * `/agent <name> wallet provision` command and the onchain registration
   * auto-provision path.
   */
  private async provisionAgentWalletForRow(
    teamId: string,
    walletTeam: string,
    agent: AgentRow,
  ): Promise<AgentRow | null> {
    const meta = (agent.metadata || {}) as Record<string, any>;
    if (meta.ows_wallet) return agent;
    const walletAlias = meta.alias || agent.name;
    const provisioned = this.getOrCreateAgentWallet(walletTeam, walletAlias);
    if (!provisioned) return null;

    const mergedMeta: AgentMetadata = {
      ...((agent.metadata || {}) as AgentMetadata),
      wallet: true,
      ows_wallet: provisioned.walletName,
      ows_address: provisioned.address,
    };
    await this.db.agents.updateMetadata(agent.id, mergedMeta);
    return this.dbQueryAgentById(teamId, agent.id);
  }

  /**
   * Check if the OWS (Open Wallet Standard) CLI is installed and on PATH.
   */
  private checkOwsInstalled(): boolean {
    try {
      execFileSync('ows', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' });
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
      const listOutput = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' });
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
      const output = execFileSync('ows', ['wallet', 'create', '--name', walletName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' }).trim();
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

  private buildLocalAgentEnv(
    teamName: string,
    port: number,
    agentRow: AgentRow | null,
    model?: string,
    tokenId?: string,
  ): Record<string, string> {
    const owsWallet = (agentRow?.metadata as any)?.ows_wallet || null;
    const skipPermsRaw = (agentRow?.metadata as any)?.dangerouslySkipPermissions;
    const skipPermissions = skipPermsRaw === false ? false : true;
    const catalogSeed = (agentRow?.metadata as any)?.catalog;
    const catalogEnv = catalogSeed && typeof catalogSeed === 'object'
      ? Buffer.from(JSON.stringify(catalogSeed), 'utf8').toString('base64')
      : undefined;

    return {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      SHELL: process.env.SHELL || '',
      TMPDIR: process.env.TMPDIR || '',
      USER: process.env.USER || '',
      LANG: process.env.LANG || '',
      TERM: process.env.TERM || 'xterm-256color',
      ...(process.env.NVM_DIR && { NVM_DIR: process.env.NVM_DIR }),
      ...(process.env.XDG_CONFIG_HOME && { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
      ...filterClaudeEnvVars(process.env),
      ...(agentRow?.runtime && { ID_HARNESS: resolveRuntime(agentRow.runtime) }),
      ID_TEAM: teamName,
      ID_AGENT_PORT: String(port),
      MANAGER_URL: `http://127.0.0.1:4100`,
      ID_AGENT_SKIP_PERMISSIONS: skipPermissions ? 'true' : 'false',
      ...(model && { CLAUDE_MODEL: model }),
      ...(tokenId && { ID_AGENT_TOKEN_ID: tokenId }),
      ...(owsWallet && { OWS_WALLET: owsWallet }),
      ...(catalogEnv && { ID_AGENT_CATALOG: catalogEnv }),
      ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
      ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
    };
  }

  /**
   * Deploy skill files from skills/ templates to an agent's .claude/skills/ folder.
   * Reads skill.md from each skill directory, substitutes {{VAR}} placeholders,
   * and writes to the agent's working directory.
   */
  /**
   * Deploy skill files from skills/ templates to an agent's .claude/skills/ folder.
   * Uses standard Claude Code skill format: .claude/skills/<name>/SKILL.md
   *
   * Skills are specified in the YAML config (defaults.skills + per-agent skills).
   * Plugins can also bundle skills in their own skills/ subdirectory.
   * Substitutes {{VAR}} placeholders with deploy-time values.
   */
  private deploySkillsToAgent(
    workDir: string,
    skillNames: string[],
    vars: Record<string, string>,
    opts: { hasWallet?: boolean; runtime?: HarnessType | string } = {}
  ): void {
    if (skillNames.length === 0) return;
    try {
      const skillsSource = path.resolve(__dirname, '..', 'skills');
      if (!existsSync(skillsSource)) return;

      const rp = getRuntimePaths(opts.runtime);
      let deployed = 0;

      for (const skillName of skillNames) {
        const skillFile = path.join(skillsSource, skillName, 'SKILL.md');
        if (!existsSync(skillFile)) {
          console.warn(`[Deploy] Skill "${skillName}" not found at ${skillFile}`);
          continue;
        }

        // Skip wallet skill if agent has no wallet
        if (skillName === 'wallet' && !opts.hasWallet) continue;

        let content = readFileSync(skillFile, 'utf8');

        // Substitute {{VAR}} placeholders
        for (const [key, value] of Object.entries(vars)) {
          content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }

        // Write to runtime-aware skills directory
        const targetSkillDir = path.join(workDir, rp.skillsDir, skillName);
        if (!existsSync(targetSkillDir)) mkdirSync(targetSkillDir, { recursive: true });
        writeFileSync(path.join(targetSkillDir, 'SKILL.md'), content);
        deployed++;
      }

      if (deployed > 0) {
        console.log(`[Deploy] Copied ${deployed} skills to ${path.basename(workDir)}/${rp.skillsDir}/`);
      }
    } catch (err: any) {
      console.warn(`[Deploy] Could not deploy skills: ${err.message}`);
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
      // Look up OWS wallet name and permissions flag from agent metadata
      const agentRow = await this.dbQueryAgentById(teamId, id);
      const localEnv = this.buildLocalAgentEnv(teamName, port, agentRow, model, tokenId);

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

      // Persist pid into agent metadata so /agents responses can carry it.
      // The TUI uses this to resolve per-agent RSS via a batched `ps` call.
      if (proc.pid) {
        try {
          const cur = (agentRow?.metadata as Record<string, unknown>) || {};
          await this.db.agents.updateMetadata(id, { ...cur, pid: proc.pid });
        } catch (metaErr: any) {
          console.warn(`[Manager] Failed to persist pid for ${name}: ${metaErr?.message || metaErr}`);
        }
      }

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

  private listPidsListeningOnPort(port: number): number[] {
    try {
      const lsofOutput = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' }).trim();
      if (!lsofOutput) return [];
      return lsofOutput
        .split('\n')
        .filter(Boolean)
        .map(value => parseInt(value, 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  private inspectProcess(pid: number): ProcessInspection | null {
    try {
      const output = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        killSignal: 'SIGKILL',
      }).trim();
      if (!output) return null;

      const match = output.match(/^\s*(\d+)\s+(.*)$/s);
      if (!match) return null;

      const ppid = parseInt(match[1], 10);
      const commandLine = match[2].trim();
      const argv0 = tokenizeCommand(commandLine)[0] || '';
      return {
        pid,
        ppid: Number.isInteger(ppid) ? ppid : null,
        argv0,
        commandLine,
      };
    } catch {
      return null;
    }
  }

  private getManagerProcessSignatures(): string[] {
    const signatures = new Set<string>(['start-agent-manager.js', 'start-agent-manager.ts']);
    const currentEntry = process.argv[1] ? path.basename(process.argv[1]).toLowerCase() : '';
    if (currentEntry && currentEntry !== 'node' && currentEntry !== 'tsx') {
      signatures.add(currentEntry);
    }
    return [...signatures];
  }

  private matchesManagerProcessSignature(info: ProcessInspection | null): boolean {
    if (!info) return false;
    const argv0 = path.basename(info.argv0 || '').toLowerCase();
    const commandLine = info.commandLine.toLowerCase();
    return this.getManagerProcessSignatures().some(signature =>
      argv0 === signature || commandLine.includes(signature)
    );
  }

  private isManagerProcess(pid: number): boolean {
    if (pid === process.pid) return true;
    return this.matchesManagerProcessSignature(this.inspectProcess(pid));
  }

  /**
   * Kill the agent process running on a given port.
   */
  private async killAgentProcess(port: number): Promise<{ killed: boolean; pids: number[] }> {
    if (!port) return { killed: false, pids: [] };
    const candidatePids = this.listPidsListeningOnPort(port);
    if (candidatePids.length === 0) return { killed: false, pids: [] };

    const killedPids: number[] = [];
    for (const pid of candidatePids) {
      if (this.isManagerProcess(pid)) {
        console.warn(`[Manager] Skipping manager PID ${pid} on port ${port}`);
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        killedPids.push(pid);
        console.log(`[Manager] Killed process PID ${pid} on port ${port}`);
      } catch {
        // Process may have already exited
      }
    }
    return { killed: killedPids.length > 0, pids: killedPids };
  }

}
