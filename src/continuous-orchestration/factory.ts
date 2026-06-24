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
import { listBacklogByState } from "./storage.js";
import type { BacklogItem } from "./types.js";

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
  });

  return { daemon, config };
}
