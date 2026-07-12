// Phase 4 glue: how the manager process bootstraps the scheduler and
// how manager-side enqueue + completion work without manager code
// touching SqliteDispatchReactor directly.
//
// Architecture:
//   - SchedulerHandle is created at manager startup and runs an
//     interval tick (default 2s).
//   - enqueueDispatch() is the manager-facing API. It validates,
//     mints a query_id, writes to the canonical store, and returns
//     { query_id, dispatch_phid, status }.
//   - waitForDispatch() polls the doc until terminal or until the
//     caller's timeout — preserves /talk-to long-poll semantics.
//   - handleAgentDone() routes terminal updates from /agent-done back
//     to the Dispatch doc.

import { DispatchDocClient } from "./dispatch-doc-client.js";
import { HttpAgentTransport } from "./http-agent-transport.js";
import { SchedulerService } from "./scheduler-service.js";
import { SqliteDispatchReactor } from "./sqlite-dispatch-reactor.js";
import {
  DispatchRecoveryService,
  recoveryConfigFromEnv,
  type RecoveryRunReport,
} from "../dispatch-recovery/service.js";
import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { makeRecoveryReactor } from "../dispatch-recovery/reactor-adapter.js";
import type {
  RoutingHealthReadModel,
  RuntimeLiveness,
} from "../routing-health/types.js";
import {
  type SchedulerPolicy,
  loadSchedulerPolicy,
  maxInFlightForProvider,
} from "./policy.js";
import type {
  DispatchDoc,
  EnqueueInput,
  FailureKind,
  PromotionAgentDone,
  PromotionInput,
  Provider,
  Runtime,
} from "./types.js";
import {
  canonicalizePromotionInput,
  normalizeRuntime,
  resolveProviderFromRuntime,
  validateEnqueueSkipReason,
} from "./types.js";
import type { SqliteAdapter } from "../db/sqlite-adapter.js";
import type { AgentsRepository, QueriesRepository } from "../db/db-service.js";
import type { AgentRow } from "../db/types.js";
import { QueriesEvidenceClient } from "./queries-evidence-client.js";
import {
  classifyAgentResponse,
  decideStrictModeOverride,
  parseStrictModeFlag,
} from "./strict-mode-classifier.js";
import type { ModelPolicyResolver, ResolvedModel } from "../model-policy/types.js";

export type GatewayMode = "off" | "shadow" | "enforce";

export interface SchedulerEnv {
  DISPATCH_GATEWAY_MODE?: string;
  DISPATCH_SCHEDULER_ENABLED?: string;
  DISPATCH_MAX_IN_FLIGHT_ANTHROPIC?: string;
  DISPATCH_STALE_IN_FLIGHT_TTL_MS?: string;
  DISPATCH_TICK_INTERVAL_MS?: string;
  // Auto-recovery (P0 disp-b329f522…). Default OFF during rollout.
  DISPATCH_RECOVERY_ENABLED?: string;
  DISPATCH_RECOVERY_INTERVAL_MS?: string;
  DISPATCH_RECOVERY_LOOKBACK_MS?: string;
  DISPATCH_RECOVERY_MAX_ATTEMPTS?: string;
  DISPATCH_RECOVERY_BUDGET?: string;
  DISPATCH_RECOVERY_BACKOFF_MS?: string;
}

export interface SchedulerHandleOptions {
  adapter: SqliteAdapter;
  teamId: string;
  resolveTargetUrl: (agent: string, doc?: DispatchDoc) => Promise<string | null> | string | null;
  env?: SchedulerEnv;
  /** Optional override for tests; default polls process.hrtime. */
  now?: () => string;
  /** N1.3: optional hook invoked after scheduler-owned status mutations. */
  onDispatchStatusChanged?: (phid: string, newStatus: string) => void;
  /**
   * B0 (2026-06-08): the manager's QueriesRepository, used to source
   * `queries.last_output_at` + `queries.status` evidence for the
   * scheduler's terminal-closeout + silence-detection passes. When
   * omitted the scheduler falls back to pre-B0 behavior — recommended
   * only for tests that don't exercise the evidence path.
   */
  queriesRepository?: QueriesRepository;
  /** Optional agents repo used by the fleet-health admission gate. */
  agentsRepository?: AgentsRepository;
  /**
   * D1 / T-MODEL.1 (2026-06-22): the per-agent model policy. When set, an
   * enqueue that does NOT explicitly pin `runtime` resolves the agent's
   * runtime/provider from the policy (primary → fallback). Omit to keep the
   * pre-D1 hardcoded `claude-code-cli` default.
   */
  modelPolicy?: ModelPolicyResolver;
}

// Exported for reuse by runtime-drift.ts (RD-014 drift-guard Ticket A), which
// derives its per-agent RuntimeDriftState from the SAME status vocabulary
// this admission gate already uses, rather than re-declaring a second set
// that could silently drift out of sync.
export const OFFLINE_AGENT_STATUSES = new Set(["stopped", "offline", "deleted", "unhealthy"]);
export const LIVE_AGENT_STATUSES = new Set(["running", "active", "online", "healthy"]);

export function computeFleetAdmissionExclusions(agents: AgentRow[]): string[] {
  const liveCodexOrCursor = agents.some((agent) => {
    if (!isLiveAgent(agent)) return false;
    const runtime = normalizeRuntime(agent.runtime);
    return runtime === "codex" || runtime === "cursor-cli";
  });
  if (!liveCodexOrCursor) return [];

  return agents
    .filter((agent) => isStoppedOrOffline(agent) && isLegacyClaudeBuilder(agent))
    .flatMap((agent) => agentClaimRefs(agent));
}

/**
 * RD-014 (Fable critique 2026-07-01) — routing admission consults runtime/lane
 * health. Fold the routing-health read-model's runtime-liveness verdict into the
 * set of "constrained" provider lanes so the model policy's existing primary→
 * fallback order steers work OFF a stalled lane. This is the production consumer
 * `computeRoutingHealth` never had: the read-model already surfaces which
 * runtimes are down (e.g. a cert-revoked Codex fallback → `codex` unavailable),
 * but nothing routed on it — the admission gate never asked. Now enqueue does.
 *
 * The partial-implementation ancestor (branch cto/codex-runtime-health-gate,
 * d9e7406) gated the codex lane at CLAIM time via a bespoke agent-exclusion list
 * and a live per-tick `codex --version` probe. That commit's other pieces
 * (codex-fallback-health probe C1, /status C2, /routing-health route C3, the
 * runtime_unavailable classifier C4) have since landed independently on main.
 * Its RESIDUAL intent — health-gate the codex lane at admission — is delivered
 * here through the read-model instead of a duplicate probe, and at ENQUEUE (so
 * the dispatch is routed to the fallback lane up front) rather than by excluding
 * agents from the claim query after the fact. This composes with model-policy —
 * it never reorders resolution; it only marks a down runtime's provider lane
 * constrained, exactly like the usage signal already does.
 *
 * Pure: maps a RuntimeLiveness[] to the Provider lanes to treat as constrained.
 * A runtime that is not live constrains its provider lane. Fail-safe by
 * construction — only ever ADDS a lane to the constrained set (never removes),
 * so it can steer AWAY from a broken lane but can never force work onto one.
 */
export function providersConstrainedByRuntimeHealth(
  runtimes: RuntimeLiveness[] | undefined,
): Provider[] {
  if (!runtimes || runtimes.length === 0) return [];
  const constrained = new Set<Provider>();
  for (const rt of runtimes) {
    if (rt.live) continue;
    // The RuntimeLiveness name is a runtime/provider label (e.g. 'codex',
    // 'claude', 'cursor'); normalize through the runtime→provider map so a
    // 'codex' outage constrains the 'openai' lane the way model-policy names it.
    const provider = resolveProviderFromRuntime(normalizeRuntime(rt.name));
    constrained.add(provider);
  }
  return [...constrained];
}

/**
 * RD-014 — derive the constrained provider lanes from a routing-health
 * read-model. A lane is treated as constrained when its runtime is down OR the
 * lane is stalled (queued work that cannot drain). Currently the runtime-down
 * axis is the load-bearing signal (a cert-revoked Codex); the stall axis is
 * folded in defensively so a lane with no live members also steers work away.
 */
export function providersConstrainedByRoutingHealth(
  model: RoutingHealthReadModel | null | undefined,
): Provider[] {
  if (!model) return [];
  return providersConstrainedByRuntimeHealth(
    // Reconstruct RuntimeLiveness rows from the summary's down list; the
    // read-model already computed liveness, we only need the down names here.
    model.summary.runtimes_down.map(
      (name): RuntimeLiveness => ({ name, role: "fallback", live: false }),
    ),
  );
}

/**
 * RD-014 Ticket B — claim-time counterpart to `providersConstrainedByRoutingHealth`.
 * `computeFleetAdmissionExclusions` only excludes stopped/offline legacy
 * builders when a live alternative exists — a fleet-COMPOSITION check, never
 * consulting live runtime health. So a dispatch already queued against a lane
 * whose runtime degrades AFTER enqueue (e.g. a Codex cert revocation) is not
 * protected at claim time: the agent's row can still say `running` while its
 * CLI runtime itself cannot execute anything. This closes that gap by
 * excluding any agent whose lane routing-health reports down, independent of
 * the agent row's `status`.
 *
 * Deliberately routes through `providersConstrainedByRoutingHealth` (the SAME
 * already-tested function the enqueue-time gate calls) rather than comparing
 * `RoutingHealthReadModel.summary.runtimes_down` entries against
 * `agent.runtime` directly: `runtimes_down` uses coarse CLI-tool labels
 * ("claude", "codex", "cursor" — see `runtimeLivenessFromFallbackHealth`),
 * a DIFFERENT vocabulary than the `Runtime` enum `agent.runtime` holds
 * ("claude-code-cli", "claude-agent-sdk", …) — a direct string comparison
 * would silently under-match. Going through the shared provider mapping
 * (`resolveProviderFromRuntime`) is also what guarantees this can never
 * disagree with `providersConstrainedByRoutingHealth`'s own verdict, which is
 * what `/routing-health` and `/dispatches/health` both surface.
 *
 * Reuses the ALREADY-COMPUTED `computeRoutingHealth()` read-model (passed in
 * by the caller, which reads it the same way `currentRoutingHealthConstrainedProviders`
 * does for enqueue) — no second health probe. Fail-safe by construction: a
 * `null`/absent model or no constrained providers excludes nothing, so this
 * can only ADD agents to the exclusion set the caller already computed via
 * `computeFleetAdmissionExclusions`, never remove any.
 */
export function computeRoutingHealthClaimExclusions(
  agents: AgentRow[],
  model: RoutingHealthReadModel | null | undefined,
): string[] {
  const constrained = new Set(providersConstrainedByRoutingHealth(model));
  if (constrained.size === 0) return [];
  return agents
    .filter((agent) => constrained.has(resolveProviderFromRuntime(agent.runtime)))
    .flatMap((agent) => agentClaimRefs(agent));
}

function isLiveAgent(agent: AgentRow): boolean {
  const status = (agent.status ?? "").toLowerCase();
  if (OFFLINE_AGENT_STATUSES.has(status)) return false;
  if (LIVE_AGENT_STATUSES.has(status)) return true;
  return !!agent.endpoint;
}

function isStoppedOrOffline(agent: AgentRow): boolean {
  return OFFLINE_AGENT_STATUSES.has((agent.status ?? "").toLowerCase());
}

function isLegacyClaudeBuilder(agent: AgentRow): boolean {
  const runtime = normalizeRuntime(agent.runtime);
  if (runtime === "claude-code-cli" || runtime === "claude-agent-sdk" || runtime === "claude-code-local") {
    return true;
  }
  const model = (agent.model ?? "").toLowerCase();
  return model.includes("claude");
}

function agentClaimRefs(agent: AgentRow): string[] {
  return Array.from(new Set([agent.name, agent.id].filter((v): v is string => typeof v === "string" && v.length > 0)));
}

// Spec 054 §3.1 — structured actor / causation on every dispatch.
// The scheduler stays the substrate dispatch queue; the actor_ref +
// causation propagate forward into any documentHistory dual-write the
// Reactor wires up.
export interface ActorRef {
  kind: "agent" | "user" | "system" | "service" | "unknown";
  id: string;
  label?: string;
  source?: string;
}

export interface Causation {
  query_id?: string;
  dispatch_id?: number | string;
  source_event_id?: string;
}

export const MANAGER_LIFECYCLE_ACTOR: ActorRef = {
  kind: "system",
  id: "manager",
  label: "Manager",
  source: "manager",
};

export const CHRIS_DASHBOARD_ACTOR: ActorRef = {
  kind: "user",
  id: "chris",
  label: "Chris",
  source: "manager",
};

export function actorRefForAgentCompletion(agent: string): ActorRef {
  return { kind: "agent", id: agent, label: agent, source: "manager" };
}

export interface EnqueueInputV2 {
  team_id?: string;
  to_agent: string;
  from_actor: string;
  message: string;
  subject?: string;
  channel?: string;
  provider?: Provider;
  runtime?: Runtime;
  priority?: number;
  not_before_at?: string;
  query_id?: string;
  actor_ref?: ActorRef;
  causation?: Causation;
  // P0 control-plane Slice 3 — optional dedup key. When set, a repeat enqueue
  // for the same logical work reuses the existing non-terminal dispatch instead
  // of creating a duplicate (collapses continuous-orchestration re-fires).
  dedup_key?: string;
  // Spec 054 v2 Part 2 - promotion metadata at enqueue time.
  // Supplying any of repo/branch promotes the dispatch to "build" status
  // (default promote=true). Use `promote: false` with a skip reason for
  // explicitly non-promoted work (WIP, follow-up dispatch, long-lived).
  repo?: string;
  branch?: string;
  base?: string;          // default "main"
  remote?: string;        // default "origin"
  promote?: boolean;
  promotion_strategy?: "auto" | "fast_forward" | "merge_commit" | "squash" | "follow_up_dispatch";
  promotion_required_reason?: string | null;
  promotion_input?: PromotionInput | null;
  promotion_skip_reason?: string;
}

export interface EnqueueResult {
  query_id: string;
  dispatch_phid: string;
  status: "queued";
}

const DEFAULT_TICK_INTERVAL_MS = 2_000;
// Recovery is a slow background reconciliation — run it far less often than the
// 2s scheduler tick so a stuck DB never amplifies load.
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;

export function parseGatewayMode(raw: string | undefined): GatewayMode {
  const v = (raw ?? "shadow").toLowerCase();
  if (v === "off" || v === "shadow" || v === "enforce") return v;
  return "shadow";
}

export function schedulerEnabled(env: SchedulerEnv | undefined): boolean {
  const raw = (env?.DISPATCH_SCHEDULER_ENABLED ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "no";
}

export class SchedulerHandle {
  readonly reactor: SqliteDispatchReactor;
  readonly client: DispatchDocClient;
  readonly transport: HttpAgentTransport;
  readonly scheduler: SchedulerService;
  readonly policy: SchedulerPolicy;
  readonly mode: GatewayMode;
  readonly enabled: boolean;
  readonly recovery: DispatchRecoveryService;
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;
  private wakePending = false;
  private intervalMs: number;
  private teamId: string;
  private logger: ConsoleLogger;
  private recoveryInterval: NodeJS.Timeout | null = null;
  private recoveryIntervalMs: number;
  private recoveryEnabled: boolean;
  private recovering = false;
  private agentsRepository?: AgentsRepository;
  // D1 / T-MODEL.1: per-agent model policy + live provider-availability source.
  private modelPolicy?: ModelPolicyResolver;
  private unavailableProvidersSource?: () => Promise<Provider[]> | Provider[];
  // RD-014: live routing-health read-model source. When set, enqueue folds the
  // read-model's down/stalled runtime lanes into the constrained-provider set so
  // the model policy steers work off a stalled lane onto its fallback. This is
  // the production consumer computeRoutingHealth previously lacked.
  private routingHealthSource?: () =>
    | Promise<RoutingHealthReadModel | null>
    | RoutingHealthReadModel
    | null;

  constructor(opts: SchedulerHandleOptions) {
    const env = opts.env ?? {};
    this.teamId = opts.teamId;
    this.modelPolicy = opts.modelPolicy;
    this.agentsRepository = opts.agentsRepository;
    this.mode = parseGatewayMode(env.DISPATCH_GATEWAY_MODE);
    this.enabled = schedulerEnabled(env);
    this.policy = loadSchedulerPolicy({}, env as Record<string, string | undefined>);
    this.intervalMs = parsePositiveInt(env.DISPATCH_TICK_INTERVAL_MS) ?? DEFAULT_TICK_INTERVAL_MS;
    this.logger = new ConsoleLogger("dispatch-scheduler");

    const now = opts.now ?? (() => new Date().toISOString());
    this.reactor = new SqliteDispatchReactor({
      adapter: opts.adapter,
      teamId: opts.teamId,
      now,
    });
    this.client = new DispatchDocClient({ reactor: this.reactor, now, onStatusChanged: opts.onDispatchStatusChanged });
    this.transport = new HttpAgentTransport({
      resolveTargetUrl: async (doc) => {
        const laneTarget = await this.resolveRuntimeLaneTargetUrl(doc);
        if (laneTarget) return laneTarget;
        return opts.resolveTargetUrl(doc.to_agent, doc);
      },
    });
    const queryEvidence = opts.queriesRepository
      ? new QueriesEvidenceClient({
          queries: opts.queriesRepository,
          teamId: opts.teamId,
        })
      : undefined;
    this.scheduler = new SchedulerService({
      client: this.client,
      transport: this.transport,
      policy: this.policy,
      now,
      logger: this.logger,
      queryEvidence,
      // W1-1: drain every provider lane each tick, each with its own cap and
      // its own in-flight count, so Anthropic / OpenAI(Codex) / Cursor queues
      // never consume each other's concurrency slots.
      providers: ["anthropic", "openai", "cursor", "other"],
      // BUG-003: same resolver the enqueue path uses, now also consulted when
      // a rate-limit bounce retries — prefers a fallback lane over hammering
      // the SAME already-throttled provider.
      modelPolicy: this.modelPolicy,
    });
    if (opts.agentsRepository) {
      this.scheduler.setAdmissionGateProvider({
        getExcludedAgentsForClaim: async () => {
          const agents = await opts.agentsRepository!.list(this.teamId, true);
          const fleetExcluded = computeFleetAdmissionExclusions(agents);
          // RD-014 Ticket B: OR in agents whose runtime routing-health
          // reports down, so a lane that degrades AFTER enqueue is excluded
          // from claim too — the enqueue-time RD-014 gate alone can't
          // protect a dispatch already sitting in the queue. Kill-switched
          // (default ON) since this changes live claim behavior fleet-wide;
          // fails open (excludes nothing extra) on any error or when the
          // health source itself is absent, same fail-safe posture as the
          // enqueue-time gate.
          let healthExcluded: string[] = [];
          if (process.env.ID_AGENTS_DISABLE_RD014_CLAIM_HEALTH_GATE !== "1") {
            try {
              const model = await this.routingHealthSource?.();
              healthExcluded = computeRoutingHealthClaimExclusions(agents, model ?? null);
            } catch {
              healthExcluded = [];
            }
          }
          return Array.from(new Set([...fleetExcluded, ...healthExcluded]));
        },
      });
    }

    // Auto-recovery (P0 disp-b329f522…). Reconciles terminal-failed dispatches
    // that actually landed and auto-requeues recoverable internal transients,
    // routing unsafe/exhausted/ambiguous cases to the /ops surface instead of
    // leaving them as dead failures. Flag-gated (default OFF); the service is
    // always constructed so /recover-once can drive a manual pass, but the
    // periodic job only starts when enabled.
    const recoveryCfg = recoveryConfigFromEnv(env as NodeJS.ProcessEnv);
    this.recoveryEnabled = recoveryCfg.enabled;
    this.recoveryIntervalMs =
      parsePositiveInt(env.DISPATCH_RECOVERY_INTERVAL_MS) ??
      DEFAULT_RECOVERY_INTERVAL_MS;
    this.recovery = new DispatchRecoveryService({
      reactor: makeRecoveryReactor(this.reactor, {
        lookbackMs: parsePositiveInt(env.DISPATCH_RECOVERY_LOOKBACK_MS) ?? undefined,
      }),
      config: {
        max_attempts: recoveryCfg.maxAttempts,
        max_linked_query_retries: DEFAULT_RECOVERY_CONFIG.max_linked_query_retries,
        retryable_detail_markers: DEFAULT_RECOVERY_CONFIG.retryable_detail_markers,
      },
      now,
      enabled: recoveryCfg.enabled,
      budget: recoveryCfg.budget,
      backoffMs: recoveryCfg.backoffMs,
      logger: {
        info: (event, payload) => this.logger.info(event, payload),
        warn: (event, payload) => this.logger.warn(event, payload),
      },
    });
  }

  /** Start the tick interval. Idempotent. */
  start(): void {
    if (!this.enabled) {
      this.logger.warn("scheduler_disabled", {});
      return;
    }
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    if (this.interval.unref) this.interval.unref();
    this.logger.info("scheduler_started", {
      mode: this.mode,
      max_in_flight: {
        anthropic: this.policy.max_in_flight_anthropic,
        openai: this.policy.max_in_flight_openai,
        cursor: this.policy.max_in_flight_cursor,
        other: this.policy.max_in_flight_other,
      },
      tick_interval_ms: this.intervalMs,
    });
    // Bounded recovery job — only when the flag is on. Reuses the scheduler's
    // enabled gate so a disabled scheduler never silently runs recovery.
    if (this.recoveryEnabled && !this.recoveryInterval) {
      this.recoveryInterval = setInterval(() => {
        void this.runRecoveryOnce();
      }, this.recoveryIntervalMs);
      if (this.recoveryInterval.unref) this.recoveryInterval.unref();
      this.logger.info("dispatch_recovery_started", {
        interval_ms: this.recoveryIntervalMs,
      });
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }
  }

  /**
   * D1 / T-MODEL.1: wire the live provider-availability signal (e.g. derived
   * from the usage gate). The function returns the providers currently treated
   * as unavailable for routing; the model policy uses it to apply fallback.
   */
  setUnavailableProvidersSource(fn: () => Promise<Provider[]> | Provider[]): void {
    this.unavailableProvidersSource = fn;
  }

  private async currentUnavailableProviders(): Promise<Provider[]> {
    if (!this.unavailableProvidersSource) return [];
    try {
      return await this.unavailableProvidersSource();
    } catch {
      return [];
    }
  }

  /** Public accessor for the live unavailable-providers signal (used by the
   *  /model-policy/resolve dry-run route). */
  async currentUnavailableProvidersPublic(): Promise<Provider[]> {
    return this.currentUnavailableProviders();
  }

  /**
   * RD-014: wire the live routing-health read-model source. The manager passes a
   * function that returns the current computeRoutingHealth() output (runtime
   * liveness + lane stall). Enqueue folds its verdict into the constrained-lane
   * set so a stalled lane is routed around via the model policy's fallback order.
   */
  setRoutingHealthSource(
    fn: () =>
      | Promise<RoutingHealthReadModel | null>
      | RoutingHealthReadModel
      | null,
  ): void {
    this.routingHealthSource = fn;
  }

  /**
   * RD-014: the provider lanes routing-health currently reports as unhealthy
   * (runtime down / lane stalled). Never throws — a failing/absent source yields
   * an empty set, so enqueue degrades to the pre-RD-014 usage-only signal rather
   * than blocking. Fail-open on the health source, fail-safe in the mapping.
   */
  private async currentRoutingHealthConstrainedProviders(): Promise<Provider[]> {
    if (!this.routingHealthSource) return [];
    try {
      const model = await this.routingHealthSource();
      return providersConstrainedByRoutingHealth(model);
    } catch {
      return [];
    }
  }

  /**
   * Multi-LLM Slice D: keep `to_agent` as the durable logical agent identity,
   * but deliver to a physical agent endpoint whose runtime matches the dispatch
   * lane. This is intentionally narrow: same-runtime dispatches keep routing to
   * the logical agent; fallback dispatches (for example finances/Claude →
   * Codex) use the first live same-runtime executor already registered in the
   * agents table.
   */
  private async resolveRuntimeLaneTargetUrl(doc: DispatchDoc): Promise<string | null> {
    if (!this.agentsRepository) return null;
    try {
      const target = await this.agentsRepository.getByName(this.teamId, doc.to_agent);
      if (target?.endpoint && normalizeRuntime(target.runtime) === doc.runtime) {
        return target.endpoint;
      }
      const agents = await this.agentsRepository.list(this.teamId, true);
      const lane = agents.find((agent) => {
        if (!agent.endpoint) return false;
        if (!isLiveAgent(agent)) return false;
        return normalizeRuntime(agent.runtime) === doc.runtime;
      });
      return lane?.endpoint ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Run a single recovery pass. Bounded: overlapping ticks are skipped so a
   * slow DB never stacks passes. Never throws — the service already swallows
   * its own errors, and this guard catches anything the scheduling layer adds.
   * Also exposed for the manual /recover-once operator probe.
   */
  async runRecoveryOnce(): Promise<RecoveryRunReport | null> {
    if (this.recovering) return null;
    this.recovering = true;
    try {
      const report = await this.recovery.runOnce();
      if (!report.skipped && report.scanned > 0) {
        this.logger.info("dispatch_recovery_pass", { ...report });
      }
      return report;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error("dispatch_recovery_threw", { detail });
      return null;
    } finally {
      this.recovering = false;
    }
  }

  /** Force a single tick — used by tests and for the manual /system-live ping. */
  async tick(): Promise<void> {
    await this.safeTick();
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) {
      this.wakePending = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.wakePending = false;
        await this.scheduler.tick();
      } while (this.wakePending);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("scheduler_tick_threw", { detail: msg });
    } finally {
      this.ticking = false;
    }
  }

  /** Enqueue a Dispatch doc and return the canonical query_id. */
  async enqueue(input: EnqueueInputV2, opts?: { target_url?: string; wake?: boolean }): Promise<EnqueueResult> {
    const teamId = input.team_id ?? this.teamId;
    if (teamId !== this.teamId) {
      throw new Error(
        `enqueue: team_id mismatch (handle is bound to ${this.teamId}, got ${teamId})`,
      );
    }
    if (!input.to_agent) throw new Error("enqueue: to_agent required");
    if (!input.message) throw new Error("enqueue: message required");
    // Spec 054 v2 Part 2 (review-fix 2026-05-24): explicit promote:false
    // on a build dispatch (repo + branch present) MUST carry a non-empty
    // promotion_skip_reason so the bypass is auditable.
    const repo = input.promotion_input?.repo ?? input.repo;
    const branch = input.promotion_input?.branch ?? input.branch;
    const promotionSkipReason =
      input.promotion_input?.promotion_skip_reason ??
      input.promotion_skip_reason ??
      input.promotion_required_reason ??
      null;
    const skipReasonError = validateEnqueueSkipReason({
      repo,
      branch,
      promote: input.promote,
      promotion_skip_reason: promotionSkipReason,
    });
    if (skipReasonError) {
      throw new Error(`enqueue: ${skipReasonError}`);
    }

    const queryId = input.query_id ?? mintQueryId();
    // Spec 054 §3.1 / §4.4: every enqueue carries a structured actor
    // and causation. Manager-routed dispatches default to system:manager
    // and {query_id}. Callers can override (e.g. dashboard human edit
    // sets user:chris, agent-completion echo sets agent:<name>).
    const actor_ref: ActorRef = input.actor_ref ?? MANAGER_LIFECYCLE_ACTOR;
    const causation: Causation = input.causation ?? { query_id: queryId };
    // Spec 054 v2 Part 2 - thread promotion metadata into the enqueue
    // payload. PromotionInput is only built when repo+branch are present
    // (= build dispatch); otherwise null and `promote` defaults to false.
    let promotion_input: PromotionInput | null = null;
    try {
      promotion_input = input.promotion_input
        ? canonicalizePromotionInput({
            repo: input.promotion_input.repo,
            branch: input.promotion_input.branch,
            base: input.promotion_input.base || "main",
            remote: input.promotion_input.remote || "origin",
            promotion_skip_reason: promotionSkipReason,
          })
        : input.repo && input.branch
        ? canonicalizePromotionInput({
            repo: input.repo,
            branch: input.branch,
            base: input.base || "main",
            remote: input.remote || "origin",
            promotion_skip_reason: promotionSkipReason,
          })
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`enqueue: ${msg}`);
    }
    // W1-1: normalize the runtime to its canonical identifier, then derive
    // the provider lane FROM the runtime unless the caller explicitly pins a
    // provider. This is what keeps a cursor-cli dispatch out of the Anthropic
    // lane without every caller having to set `provider` by hand.
    //
    // D1 / T-MODEL.1: when the caller did NOT pin a runtime, the model policy
    // (if configured) decides the agent's runtime — applying the primary→
    // fallback order against the currently-constrained provider lanes. This is
    // "Codex Light": codex primary, claude fallback when the openai lane is
    // over its usage limit. An explicit input.runtime always wins.
    let runtime: Runtime;
    let modelPolicyTrace: ResolvedModel | undefined;
    if (input.runtime) {
      runtime = normalizeRuntime(input.runtime);
    } else if (this.modelPolicy) {
      // Usage-constrain signal (model-policy fallback off provider budget/limits).
      const usageUnavailable = await this.currentUnavailableProviders();
      // RD-014: liveness signal — fold the routing-health read-model's down/
      // stalled lanes into the constrained set so a lane that is UNAVAILABLE
      // (not merely usage-limited) is also routed around. Union of the two: a
      // lane is constrained if EITHER over budget OR unhealthy. This is what
      // gives computeRoutingHealth a production consumer at the admission path.
      const healthUnavailable = await this.currentRoutingHealthConstrainedProviders();
      const unavailableProviders = [
        ...new Set<Provider>([...usageUnavailable, ...healthUnavailable]),
      ];
      modelPolicyTrace = this.modelPolicy.resolveModelChoice({
        agent: input.to_agent,
        unavailableProviders,
      });
      runtime = modelPolicyTrace.choice.runtime;
    } else {
      runtime = normalizeRuntime("claude-code-cli");
    }
    const targetAgent = await this.agentsRepository
      ?.getByName(this.teamId, input.to_agent)
      .catch(() => null);
    if (targetAgent?.runtime && (input.runtime || input.provider)) {
      runtime = normalizeRuntime(targetAgent.runtime);
    }
    const provider: Provider = resolveProviderFromRuntime(runtime);
    const payload: EnqueueInput = {
      query_id: queryId,
      to_agent: input.to_agent,
      from_actor: input.from_actor || "manager",
      channel: input.channel ?? "dispatch",
      subject: input.subject ?? input.message.slice(0, 80),
      body_markdown: input.message,
      provider,
      runtime,
      priority: input.priority ?? 5,
      not_before_at: input.not_before_at,
      dedup_key: input.dedup_key,
      promote: input.promote,
      promotion_strategy: input.promotion_strategy,
      promotion_required_reason: input.promotion_required_reason !== undefined
        ? input.promotion_required_reason
        : input.promotion_skip_reason ?? input.promotion_input?.promotion_skip_reason ?? null,
      promotion_input,
    };
    const doc = await this.reactor.enqueue({
      ...payload,
      target_url: opts?.target_url,
    });
    this.logger.info("scheduler_enqueued", {
      phid: doc.dispatch_phid,
      query_id: doc.query_id,
      to_agent: doc.to_agent,
      priority: doc.priority,
      runtime: doc.runtime,
      provider: doc.provider,
      model_policy: modelPolicyTrace
        ? {
            source: modelPolicyTrace.source,
            fallback_applied: modelPolicyTrace.fallback_applied,
            policy_agent: modelPolicyTrace.policy_agent,
            reason: modelPolicyTrace.reason,
          }
        : undefined,
      actor_ref,
      causation,
    });
    if (this.enabled && this.interval && opts?.wake) {
      void this.safeTick();
    }
    return {
      query_id: doc.query_id,
      dispatch_phid: doc.dispatch_phid,
      status: "queued",
    };
  }

  /**
   * Long-poll wait for a terminal status on this Dispatch doc.
   * Returns the final DispatchDoc, or the doc as-is if timeout fires.
   */
  async waitForTerminal(
    queryId: string,
    opts: { timeoutMs: number; pollMs?: number },
  ): Promise<DispatchDoc | null> {
    const pollMs = opts.pollMs ?? 250;
    const deadline = Date.now() + Math.max(0, opts.timeoutMs);
    let current: DispatchDoc | null = null;
    while (Date.now() < deadline) {
      const r = await this.client.getByQueryId(queryId);
      if (r.ok) {
        current = r.value;
        if (
          current.status === "done" ||
          current.status === "failed" ||
          current.status === "cancelled"
        ) {
          return current;
        }
      }
      await sleep(pollMs);
    }
    return current;
  }

  /**
   * Phase 5.1: route /agent-done back to the Dispatch doc. Maps either
   * the manager-side query_id (the canonical one returned at enqueue
   * time) OR the target agent's agent_query_id.
   */
  async handleAgentDone(args: {
    query_id?: string;
    agent_query_id?: string;
    result?: Record<string, unknown> | null;
    success?: boolean;
    error?: string;
    // Harness-resilience (Spec 2026-05-29): structured failure kind from
    // the agent's terminal closeout. When omitted, /agent-done success:false
    // falls back to "agent_error" for backwards compatibility.
    failure_kind?: FailureKind;
    // Spec 054 §4.4: the manager attributes the completion to the
    // target agent + carries the causation chain forward. The scheduler
    // doesn't currently write doc-model ops, but it records the actor
    // on the audit log so dual-writers can pick it up later.
    actor_ref?: ActorRef;
    causation?: Causation;
  }): Promise<DispatchDoc | null> {
    let doc: DispatchDoc | null = null;
    if (args.query_id) {
      const r = await this.client.getByQueryId(args.query_id);
      if (r.ok) doc = r.value;
    }
    if (!doc && args.agent_query_id) {
      doc = await this.reactor.getByAgentQueryId(args.agent_query_id);
    }
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
      return doc; // already terminal, no-op
    }
    if (doc.status !== "in_flight") {
      // The doc is queued/bounced — agent-done arriving for a non-in-flight
      // doc is anomalous but we accept it: mark done.
      this.logger.warn("agent_done_unexpected_status", {
        phid: doc.dispatch_phid,
        status: doc.status,
      });
    }
    // Derive structured actor + causation for downstream documentHistory
    // writers. Default the actor to agent:<to_agent> when /agent-done
    // routed back without an explicit override. Causation defaults to
    // {query_id, dispatch_id=numeric_id_if_available}.
    const resolvedActor: ActorRef = args.actor_ref ?? actorRefForAgentCompletion(doc.to_agent);
    const resolvedCausation: Causation = args.causation ?? {
      query_id: doc.query_id,
    };
    this.logger.info("scheduler_agent_done", {
      phid: doc.dispatch_phid,
      query_id: doc.query_id,
      actor_ref: resolvedActor,
      causation: resolvedCausation,
      success: args.success !== false,
    });
    if (args.success === false) {
      // markFailed already accepts queued rows; this branch is unchanged.
      const r = await this.client.markFailed(doc.dispatch_phid, {
        failure_kind: args.failure_kind ?? "agent_error",
        detail: args.error ?? "agent reported failure",
      });
      return r.ok ? r.value : doc;
    }
    // Dispatch-canonical strict-mode (CTO-4): even with success=true,
    // inspect the response body for known provider/runtime error
    // patterns BEFORE marking delivered. The classifier is pure; the
    // feature flag DISPATCH_CANONICAL_STRICT_MODE gates whether we
    // override the closeout in `enforce` or just log it in `shadow`.
    const classifiedAt = new Date().toISOString();
    const closeoutClassification = classifyAgentResponse({
      body: args.result ?? null,
      transport_status: 200, // agent-done implies a delivered transport
      classified_at: classifiedAt,
    });
    if (
      closeoutClassification.classification === "failed" &&
      closeoutClassification.failure_reason === "rate_limit_error" &&
      closeoutClassification.matched_pattern === "text:claude-session-limit"
    ) {
      const nextAttemptAt =
        closeoutClassification.provider_reset_at ??
        new Date(Date.parse(classifiedAt) + 30 * 60_000).toISOString();
      const fallback = this.resolveFallbackLaneForProviderLimit(doc);
      const resetLabel = closeoutClassification.provider_reset_label ?? "the provider reset time";
      const detail = `Claude limited until ${resetLabel}; dispatch will retry${fallback ? " / routed to fallback" : ""}`;
      this.logger.warn("provider_limit_closeout_bounced", {
        phid: doc.dispatch_phid,
        query_id: doc.query_id,
        provider: doc.provider,
        runtime: doc.runtime,
        next_attempt_at: nextAttemptAt,
        reset_label: closeoutClassification.provider_reset_label,
        reset_at: closeoutClassification.provider_reset_at,
        message: detail,
        ...(fallback ? { fallback_provider: fallback.provider, fallback_runtime: fallback.runtime } : {}),
      });
      const bounced = await this.client.markBounced(doc.dispatch_phid, {
        kind: "provider_limit",
        message: detail,
        next_attempt_at: nextAttemptAt,
        allow_auto_retry: true,
        ...(fallback ? { provider: fallback.provider, runtime: fallback.runtime } : {}),
      });
      return bounced.ok ? bounced.value : doc;
    }
    const strictModeFlag = parseStrictModeFlag(
      process.env.DISPATCH_CANONICAL_STRICT_MODE,
    );
    if (strictModeFlag !== "off") {
      const decision = decideStrictModeOverride(strictModeFlag, closeoutClassification);
      if (decision) {
        this.logger.warn("strict_mode_classified", {
          phid: doc.dispatch_phid,
          ...decision.log_payload,
        });
        if (decision.override) {
          const r = await this.client.markFailed(doc.dispatch_phid, {
            failure_kind: decision.failure_kind,
            detail: decision.detail,
          });
          return r.ok ? r.value : doc;
        }
      }
    }
    // Queued-dispatch closeout (Spec 2026-06-01): an out-of-band success
    // /agent-done can arrive for a doc the scheduler never claimed. Use
    // the narrow markQueuedDoneWithResult path so we don't fabricate an
    // in_flight transition just to satisfy markDoneWithResult's guard.
    // Every other non-in_flight state keeps the existing guard.
    if (doc.status === "queued") {
      const emptyProductiveCloseout = classifyQueuedProductiveCloseout(doc, args.result ?? null);
      if (emptyProductiveCloseout.action === "fail") {
        this.logger.warn("queued_productive_empty_success_guardrail", {
          phid: doc.dispatch_phid,
          query_id: doc.query_id,
          reason: emptyProductiveCloseout.reason,
        });
        const r = await this.client.markFailed(doc.dispatch_phid, {
          failure_kind: "validation_failed",
          detail: emptyProductiveCloseout.reason,
        });
        return r.ok ? r.value : doc;
      }
      this.logger.warn("agent_done_unexpected_status", {
        phid: doc.dispatch_phid,
        status: doc.status,
        accepted: true,
        closeout_path: "queued_out_of_band",
        ...(emptyProductiveCloseout.action === "explicit_noop"
          ? { classified_as: "explicit_noop", reason: emptyProductiveCloseout.reason }
          : {}),
      });
      return this.reactor.markQueuedDoneWithResult(
        doc.dispatch_phid,
        args.result ?? null,
      );
    }
    return this.reactor.markDoneWithResult(doc.dispatch_phid, args.result ?? null);
  }

  private resolveFallbackLaneForProviderLimit(doc: DispatchDoc): { provider: Provider; runtime: Runtime } | null {
    if (!this.modelPolicy) return null;
    const resolved = this.modelPolicy.resolveModelChoice({
      agent: doc.to_agent,
      unavailableProviders: [doc.provider],
    });
    const { provider, runtime } = resolved.choice;
    if (provider === doc.provider && runtime === doc.runtime) return null;
    return { provider, runtime };
  }

  async acceptDispatchStart(args: {
    dispatch_id: string;
    agent_query_id: string;
  }): Promise<DispatchDoc | null> {
    const doc = args.dispatch_id.startsWith("phid:")
      ? await this.reactor.getByPhid(args.dispatch_id)
      : await this.reactor.getByQueryId(args.dispatch_id);
    if (!doc) return null;
    const r = await this.client.acceptDispatchStart(doc.dispatch_phid, {
      agent_query_id: args.agent_query_id,
    });
    if (!r.ok) throw new Error(r.detail);
    return r.value;
  }

  /** Live snapshot for /system-live and operator probes. */
  async snapshot(provider: Provider = "anthropic"): Promise<{
    in_flight: number;
    queued: number;
    bounced: number;
    max_safe: number;
    available_slots: number;
    oldest_queued_age_ms: number;
    last_bounce_kind: string | null;
    mode: GatewayMode;
    policy_version: string;
  }> {
    const snap = await this.reactor.snapshot({
      max_safe: maxInFlightForProvider(this.policy, provider),
      provider,
    });
    return {
      in_flight: snap.in_flight,
      queued: snap.queued,
      bounced: snap.bounced,
      max_safe: snap.max_safe,
      available_slots: snap.available_slots,
      oldest_queued_age_ms: snap.oldest_queued_age_ms,
      last_bounce_kind: snap.last_bounce_kind,
      mode: this.mode,
      policy_version: this.policy.policy_version,
    };
  }
}

class ConsoleLogger {
  constructor(private prefix: string) {}
  info(event: string, payload: Record<string, unknown>): void {
    console.log(`[${this.prefix}] ${event}`, payload);
  }
  warn(event: string, payload: Record<string, unknown>): void {
    console.warn(`[${this.prefix}] ${event}`, payload);
  }
  error(event: string, payload: Record<string, unknown>): void {
    console.error(`[${this.prefix}] ${event}`, payload);
  }
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mintQueryId(): string {
  return `query_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type QueuedProductiveCloseout =
  | { action: "allow"; reason: null }
  | { action: "explicit_noop"; reason: string }
  | { action: "fail"; reason: string };

const PRODUCTIVE_ORCHESTRATION_RE = /\b(load[- ]?loop|refuel|re[- ]?fuel|auto[- ]?flesh|self[- ]?refuel|seed(?:ed|ing)? rows?|orchestration fuel)\b/i;

function classifyQueuedProductiveCloseout(
  doc: DispatchDoc,
  result: Record<string, unknown> | null,
): QueuedProductiveCloseout {
  if (!isProductiveOrchestrationDispatch(doc)) return { action: "allow", reason: null };
  if (hasArtifactEvidence(result)) {
    if (hasRefuelCloseoutEvidence(doc, result)) return { action: "allow", reason: null };
    return {
      action: "fail",
      reason:
        "productive orchestration closeout artifact is missing sources scanned, rows created, verified promotion, or post-refuel /orchestration/status counts",
    };
  }
  if (hasQueuedWorkEvidence(result)) return { action: "allow", reason: null };
  const noopReason = explicitNoopReason(result);
  if (noopReason) return { action: "explicit_noop", reason: noopReason };
  return {
    action: "fail",
    reason:
      "productive orchestration closeout produced no complete refuel artifact evidence, queued work evidence, or explicit no-op reason",
  };
}

function isProductiveOrchestrationDispatch(doc: DispatchDoc): boolean {
  return PRODUCTIVE_ORCHESTRATION_RE.test(
    [doc.subject, doc.body_markdown, doc.from_actor, doc.channel].filter(Boolean).join("\n"),
  );
}

function hasArtifactEvidence(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  return ["artifact_path", "artifact_id", "output_path", "output"].some((key) => nonEmptyString(result[key]));
}

function hasRefuelCloseoutEvidence(doc: DispatchDoc, result: Record<string, unknown> | null): boolean {
  if (!hasArtifactEvidence(result)) return false;
  const promotion = parsePromotionAgentDone(result?.promotion) ?? parsePromotionAgentDone(doc.promotion_result);
  return (
    hasSourcesScannedEvidence(result) &&
    hasRowsCreatedEvidence(result) &&
    hasVerifiedPromotionEvidence(promotion) &&
    hasPostRefuelStatusCounts(result)
  );
}

function hasSourcesScannedEvidence(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  if (positiveNumber(result.sources_scanned) || positiveNumber(result.sourcesScanned)) return true;
  const sources = result.sources ?? result.scanned_sources ?? result.scannedSources;
  return Array.isArray(sources) && sources.length > 0;
}

function hasRowsCreatedEvidence(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  if (positiveNumber(result.rows_created) || positiveNumber(result.rowsCreated)) return true;
  return ["seeded_rows", "inserted", "created", "created_rows"].some((key) => positiveNumber(result[key]));
}

function hasVerifiedPromotionEvidence(promotion: PromotionAgentDone | null): boolean {
  if (!promotion || promotion.completed !== true) return false;
  if (!Array.isArray(promotion.repos) || promotion.repos.length === 0) return false;
  return promotion.repos.every((repo) =>
    nonEmptyString(repo.promoted_sha) &&
    nonEmptyString(repo.remote_main_sha) &&
    repo.promoted_sha === repo.remote_main_sha &&
    repo.pushed === true &&
    repo.verified === true
  );
}

function hasPostRefuelStatusCounts(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  const counts = objectValue(result.post_refuel_status_counts) ?? objectValue(result.postRefuelStatusCounts);
  if (!counts) return false;
  return ["ready", "queued", "in_flight", "needs_review", "blocked"].some((key) => nonNegativeNumber(counts[key]));
}

function hasQueuedWorkEvidence(result: Record<string, unknown> | null): boolean {
  if (!result) return false;
  const numericKeys = ["queued", "queued_count", "queued_work", "dispatches_queued", "seeded_rows", "inserted", "created"];
  if (numericKeys.some((key) => positiveNumber(result[key]))) return true;
  if (Array.isArray(result.dispatches) && result.dispatches.length > 0) return true;
  if (Array.isArray(result.queued_dispatches) && result.queued_dispatches.length > 0) return true;
  if (Array.isArray(result.items) && result.items.length > 0) return true;
  if (nonEmptyString(result.dispatch_phid) || nonEmptyString(result.query_id)) return true;
  return result.status === "queued";
}

function explicitNoopReason(result: Record<string, unknown> | null): string | null {
  if (!result) return null;
  const reason =
    stringValue(result.noop_reason) ??
    stringValue(result.no_op_reason) ??
    stringValue(result.explicit_noop_reason) ??
    stringValue(result.reason);
  const noopFlag = result.noop === true || result.no_op === true || result.status === "no_op" || result.status === "noop";
  if (!noopFlag || !reason || reason.trim().length === 0) return null;
  return `explicit no-op: ${reason.trim()}`;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePromotionAgentDone(value: unknown): PromotionAgentDone | null {
  const promotion = objectValue(value);
  if (!promotion) return null;
  return promotion as unknown as PromotionAgentDone;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
