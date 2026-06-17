// Continuous Orchestration — wiring factory.
//
// Builds a ContinuousOrchestrationDaemon from the manager's live handles: the
// dispatch scheduler (to FIRE work through the manager API), the usage-meter
// service (to read the token gate + today's burn), and the DB adapter (backlog +
// decision log). Structural types keep this decoupled from the manager internals.

import type { DbAdapter } from "../db/db-adapter.js";
import type { EnqueueInputV2 } from "../dispatch-scheduler/manager-integration.js";
import type { Provider, Runtime } from "../dispatch-scheduler/types.js";
import type { UsageReportV2 } from "../usage-meter/types.js";
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
        team_id: teamId,
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
      const report = await opts.usageService.buildReport();
      return {
        view: {
          hard_paused: report.gate.should_pause_new_dispatches,
          daily_percent: report.gate.daily_percent,
          weekly_percent: report.gate.weekly_percent,
          enforcement: report.gate.enforcement,
        },
        daily_tokens_used: report.usage.daily.weighted_tokens,
      };
    },

    readInFlight: async () => {
      const docs = await opts.scheduler.reactor.listInFlight();
      // Write-scope locks come from the orchestration's own in-flight items.
      const inFlightItems = await listBacklogByState(opts.adapter, { team_id: teamId, state: "in_flight" });
      const scopes = new Set<string>();
      for (const it of inFlightItems) for (const s of it.write_scope) scopes.add(s);
      return { count: docs.length, active_write_scopes: scopes };
    },
  });

  return { daemon, config };
}
