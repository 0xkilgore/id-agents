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
  type SchedulerPolicy,
  loadSchedulerPolicy,
} from "./policy.js";
import type {
  DispatchDoc,
  EnqueueInput,
  FailureKind,
  Provider,
  Runtime,
} from "./types.js";
import { validateEnqueueSkipReason } from "./types.js";
import type { SqliteAdapter } from "../db/sqlite-adapter.js";

export type GatewayMode = "off" | "shadow" | "enforce";

export interface SchedulerEnv {
  DISPATCH_GATEWAY_MODE?: string;
  DISPATCH_SCHEDULER_ENABLED?: string;
  DISPATCH_MAX_IN_FLIGHT_ANTHROPIC?: string;
  DISPATCH_TICK_INTERVAL_MS?: string;
}

export interface SchedulerHandleOptions {
  adapter: SqliteAdapter;
  teamId: string;
  resolveTargetUrl: (agent: string) => Promise<string | null> | string | null;
  env?: SchedulerEnv;
  /** Optional override for tests; default polls process.hrtime. */
  now?: () => string;
  /** N1.3: optional hook invoked after scheduler-owned status mutations. */
  onDispatchStatusChanged?: (phid: string, newStatus: string) => void;
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
  promotion_skip_reason?: string;
}

export interface EnqueueResult {
  query_id: string;
  dispatch_phid: string;
  status: "queued";
}

const DEFAULT_TICK_INTERVAL_MS = 2_000;

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
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;
  private intervalMs: number;
  private teamId: string;
  private logger: ConsoleLogger;

  constructor(opts: SchedulerHandleOptions) {
    const env = opts.env ?? {};
    this.teamId = opts.teamId;
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
      resolveTargetUrl: async (doc) => opts.resolveTargetUrl(doc.to_agent),
    });
    this.scheduler = new SchedulerService({
      client: this.client,
      transport: this.transport,
      policy: this.policy,
      now,
      logger: this.logger,
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
      max_in_flight: this.policy.max_in_flight_anthropic,
      tick_interval_ms: this.intervalMs,
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Force a single tick — used by tests and for the manual /system-live ping. */
  async tick(): Promise<void> {
    await this.safeTick();
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) return; // no overlap
    this.ticking = true;
    try {
      await this.scheduler.tick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("scheduler_tick_threw", { detail: msg });
    } finally {
      this.ticking = false;
    }
  }

  /** Enqueue a Dispatch doc and return the canonical query_id. */
  async enqueue(input: EnqueueInputV2, opts?: { target_url?: string }): Promise<EnqueueResult> {
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
    const skipReasonError = validateEnqueueSkipReason({
      repo: input.repo,
      branch: input.branch,
      promote: input.promote,
      promotion_skip_reason: input.promotion_skip_reason,
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
    const promotion_input = input.repo && input.branch
      ? {
          repo: input.repo,
          branch: input.branch,
          base: input.base || "main",
          remote: input.remote || "origin",
          promotion_skip_reason: input.promotion_skip_reason ?? null,
        }
      : null;
    const payload: EnqueueInput = {
      query_id: queryId,
      to_agent: input.to_agent,
      from_actor: input.from_actor || "manager",
      channel: input.channel ?? "dispatch",
      subject: input.subject ?? input.message.slice(0, 80),
      body_markdown: input.message,
      provider: input.provider ?? "anthropic",
      runtime: input.runtime ?? "claude-code-cli",
      priority: input.priority ?? 5,
      not_before_at: input.not_before_at,
      promote: input.promote,
      promotion_strategy: input.promotion_strategy,
      promotion_required_reason: input.promotion_skip_reason ?? null,
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
      actor_ref,
      causation,
    });
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
    // Queued-dispatch closeout (Spec 2026-06-01): an out-of-band success
    // /agent-done can arrive for a doc the scheduler never claimed. Use
    // the narrow markQueuedDoneWithResult path so we don't fabricate an
    // in_flight transition just to satisfy markDoneWithResult's guard.
    // Every other non-in_flight state keeps the existing guard.
    if (doc.status === "queued") {
      this.logger.warn("agent_done_unexpected_status", {
        phid: doc.dispatch_phid,
        status: doc.status,
        accepted: true,
        closeout_path: "queued_out_of_band",
      });
      return this.reactor.markQueuedDoneWithResult(
        doc.dispatch_phid,
        args.result ?? null,
      );
    }
    return this.reactor.markDoneWithResult(doc.dispatch_phid, args.result ?? null);
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
      max_safe: this.policy.max_in_flight_anthropic,
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
