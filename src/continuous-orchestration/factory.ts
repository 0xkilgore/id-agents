// Continuous Orchestration — wiring factory.
//
// Builds a ContinuousOrchestrationDaemon from the manager's live handles: the
// dispatch scheduler (to FIRE work through the manager API), the usage-meter
// service (to read the token gate + today's burn), and the DB adapter (backlog +
// decision log). Structural types keep this decoupled from the manager internals.

import type { DbAdapter } from "../db/db-adapter.js";
import type { EnqueueInputV2 } from "../dispatch-scheduler/manager-integration.js";
import type { Provider, Runtime } from "../dispatch-scheduler/types.js";
import type { DaemonUsageReport, UsageReportV2 } from "../usage-meter/types.js";
import { ContinuousOrchestrationDaemon } from "./daemon.js";
import { loadContinuousOrchestrationConfig, type ContinuousOrchestrationConfig } from "./config.js";
import { getDispatchStatusesByPhid, getHealthyAgentNames, listBacklogByState } from "./storage.js";
import type { BacklogItem } from "./types.js";
import type { PoolRouting, ResolvedPool } from "./daemon.js";
import { BuildPoolRegistry } from "../build-pools/index.js";
import { leaseWorktreePath } from "../workspaces/allocator.js";
import { randomUUID } from "node:crypto";

interface SchedulerLike {
  enqueue(
    input: EnqueueInputV2,
    opts?: { wake?: boolean },
  ): Promise<{ dispatch_phid: string; query_id: string }>;
  reactor: { listInFlight(provider?: Provider, runtime?: Runtime): Promise<unknown[]> };
}

interface UsageServiceLike {
  buildReport(): Promise<UsageReportV2>;
  buildDaemonReport(opts?: { dailyBudget?: number; weeklyBudget?: number }): Promise<DaemonUsageReport>;
}

export interface BuildDaemonOptions {
  adapter: DbAdapter;
  scheduler: SchedulerLike;
  usageService: UsageServiceLike;
  emitNews?: (event: { type: string; message: string; data?: Record<string, unknown> }) => Promise<void>;
  config?: ContinuousOrchestrationConfig;
  env?: NodeJS.ProcessEnv;
  teamId?: string;
}

export function createContinuousOrchestrationDaemon(opts: BuildDaemonOptions): {
  daemon: ContinuousOrchestrationDaemon;
  config: ContinuousOrchestrationConfig;
} {
  const config = opts.config ?? loadContinuousOrchestrationConfig(opts.env);
  const teamId = opts.teamId ?? "default";

  const daemon = new ContinuousOrchestrationDaemon({
    adapter: opts.adapter,
    config,
    teamId,
    env: opts.env,

    enqueue: async (item: BacklogItem) => {
      const input: EnqueueInputV2 = {
        // NOTE: do NOT pin team_id here. CO storage is keyed by the team NAME
        // ("default"), but the dispatch SchedulerHandle is bound to that team's
        // UUID. Passing the CO storage `teamId` ("default") tripped the handle's
        // guard (`input.team_id ?? this.teamId; if (team_id !== this.teamId) throw`)
        // -> "team_id mismatch" on every tick (consecutive_zero_ticks climbed,
        // last_dispatch_at stayed null, backlog never drained). Omitting team_id
        // lets the handle apply its own bound team id, which is the correct one.
        to_agent: item.to_agent ?? "",
        from_actor: "continuous-orchestration",
        message: item.dispatch_body ?? "",
        subject: item.title.slice(0, 80),
        priority: item.priority,
        actor_ref: {
          kind: "system",
          id: "continuous-orchestration",
          label: "Continuous Orchestration",
          source: "manager",
        },
        dedup_key: item.logical_key ?? `orchestration-item:${item.item_id}`,
      };
      if (item.provider) input.provider = item.provider as Provider;
      if (item.runtime) input.runtime = item.runtime as Runtime;
      const enq = await opts.scheduler.enqueue(input, { wake: true });
      return { dispatch_phid: enq.dispatch_phid, query_id: enq.query_id };
    },

    readUsage: async () => {
      // Gap 2: the daemon cap now measures DAEMON-attributed spend, not the
      // fleet-global total. Budgets are passed from the CO config so the report
      // and the daemon's daily_token_ceiling check speak the same numbers.
      // The global emergency brake is folded into report.gate.hard_paused.
      const report = await opts.usageService.buildDaemonReport({
        dailyBudget: config.daily_token_ceiling,
        weeklyBudget: config.weekly_token_ceiling,
      });
      return {
        view: {
          hard_paused: report.gate.hard_paused,
          daily_percent: report.daily.percent_consumed,
          weekly_percent: report.weekly.percent_consumed,
          enforcement: report.gate.enforcement,
        },
        daily_tokens_used: report.daily.combined_weighted_tokens,
      };
    },

    readInFlight: async () => {
      // T-ORCH P0: `max_in_flight` caps the DAEMON's OWN concurrent lane, not
      // the whole fleet. Counting fleet-wide in-flight (reactor.listInFlight)
      // starved the daemon to zero whenever manual/other-agent dispatches
      // filled ≥ max_in_flight — every ready item was held "no in-flight slots
      // free" while backlog in_flight was 0. Count the daemon's own in-flight
      // backlog items (the same rows the write-scope locks come from). The
      // global brake stays the usage/rate-limit gate in readUsage().
      const inFlightItems = await listBacklogByState(opts.adapter, { team_id: teamId, state: "in_flight" });
      const scopes = new Set<string>();
      for (const it of inFlightItems) for (const s of it.write_scope) scopes.add(s);
      return { count: inFlightItems.length, active_write_scopes: scopes };
    },

    // P0 loop-strangle fix: resolve each in_flight item's dispatch status so the
    // reconciler can release the write-scope lock once the dispatch terminates.
    // Phid-only lookup (no team filter) — dispatch rows are team-UUID-keyed while
    // CO storage uses the team NAME, so a scoped read would never match.
    resolveDispatchStates: (phids: string[]) => getDispatchStatusesByPhid(opts.adapter, phids),
    // RD-014: live agent-health gate at admission — name-only lookup (no team
    // filter), same trap-avoidance reasoning as resolveDispatchStates above.
    resolveAgentHealth: (names: string[]) => getHealthyAgentNames(opts.adapter, names),
    emitNews: opts.emitNews,

    // Stage C build-pool routing: late-bind builder + a distinct worktree
    // write_scope per build so N pool members build the same repo concurrently.
    pools: buildPoolRouting(opts.env),
  });

  return { daemon, config };
}

/**
 * Build the Stage-C PoolRouting from the seed BuildPoolRegistry. Resolves a
 * pool by the item's track, spills across members not currently building, and
 * computes a distinct worktree write_scope per build (the real worktree is
 * created by the existing spawn/allocator path keyed on the dispatch; here we
 * only need the distinct, observable path so the lane no longer serializes).
 *
 * NOTE (follow-up): `availableBuilders` treats every non-building member as
 * available. Persisted builder state (idle/building/offline + abi_healthy +
 * heartbeat, build-pools/select.ts `selectBuilder`) is the hardening that adds
 * online/health filtering; until then a member is assumed online.
 */
export function buildPoolRouting(env: NodeJS.ProcessEnv = process.env): PoolRouting {
  const registry = BuildPoolRegistry.load(env);
  const legacyPoolOptInAgents = new Set(["frontend-ui-codex", "frontend-qa-cursor"]);
  const explicitPoolRequest = (raw: string | undefined): ResolvedPool | null => {
    const normalized = raw?.trim().toLowerCase();
    if (!normalized?.startsWith("pool:")) return null;
    const requestedPoolId = normalized.slice("pool:".length);
    const pool = registry.list().find((candidate) => candidate.pool_id === requestedPoolId);
    return pool
      ? { pool_id: pool.pool_id, repo_root: pool.repo_root, max_parallel: pool.max_parallel, members: [...pool.members] }
      : null;
  };
  const looksLikeKapelleFrontendWork = (item: BacklogItem): boolean => {
    const haystack = `${item.title}\n${item.dispatch_body ?? ""}\n${item.write_scope.join("\n")}`.toLowerCase();
    return (
      haystack.includes("kapelle-site") ||
      haystack.includes("/ops") ||
      haystack.includes("artifact") ||
      haystack.includes("inbox") ||
      haystack.includes("dashboard") ||
      haystack.includes("projects page") ||
      haystack.includes("agents page") ||
      haystack.startsWith("ui ")
    );
  };
  return {
    poolForItem: (item: BacklogItem): ResolvedPool | null => {
      const trackPool = item.track ? registry.resolvePool(item.track) : undefined;
      const requestedAgent = item.to_agent?.trim();
      const requestedPool = explicitPoolRequest(requestedAgent);
      if (requestedPool) return requestedPool;
      if (requestedAgent && !legacyPoolOptInAgents.has(requestedAgent)) return null;
      const p = looksLikeKapelleFrontendWork(item) ? registry.byId("frontend") : trackPool;
      if (!p) return null;
      return { pool_id: p.pool_id, repo_root: p.repo_root, max_parallel: p.max_parallel, members: [...p.members] };
    },
    availableBuilders: (pool: ResolvedPool, building: Set<string>): string[] =>
      pool.members.filter((m) => !building.has(m)),
    allocateWorktree: async ({ agent, item, pool }) => {
      const token = randomUUID().slice(0, 8);
      const slug = (item.track ?? "build").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "build";
      const branch = `build/${agent}-${token}-${slug}`;
      const path = leaseWorktreePath(pool.repo_root, agent, token, branch);
      return { path, branch, lease_id: null };
    },
  };
}
