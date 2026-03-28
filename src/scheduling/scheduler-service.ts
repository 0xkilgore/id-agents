// SPDX-License-Identifier: MIT

import type { Db } from '../db/db-service.js';
import type { ScheduleDefinitionRow, ScheduleRunRow } from '../db/types.js';
import type { DueRun, DispatchTarget } from './schedule-types.js';
import { evaluateIntervalSchedule, evaluateCalendarSchedule } from './schedule-evaluator.js';
import { ScheduleDispatcher } from './schedule-dispatcher.js';

export class SchedulerService {
  private lastTickAtSec: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatcher: ScheduleDispatcher;

  constructor(
    private readonly db: Db,
    private readonly resolveAgent: (agentId: string) => Promise<DispatchTarget | null>,
  ) {
    this.lastTickAtSec = Math.floor(Date.now() / 1000);
    this.dispatcher = new ScheduleDispatcher();
  }

  /** Start the scheduler loop at 30-second intervals. */
  start(): void {
    if (this.timer) return;
    console.log('[Scheduler] Starting (30s tick interval)');
    this.timer = setInterval(() => this.tick(), 30_000);
  }

  /** Stop the scheduler loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Scheduler] Stopped');
    }
  }

  /** Run one scheduler tick. Exposed for testing. */
  async tick(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = this.lastTickAtSec;
    const windowEnd = nowSec;

    try {
      // 1. Load all active schedule definitions
      const defs = await this.db.schedules.listActiveDefinitions();

      // 2. Evaluate due runs for each definition
      const allDueRuns: DueRun[] = [];
      for (const def of defs) {
        let runs: DueRun[];
        if (def.kind === 'interval') {
          runs = evaluateIntervalSchedule(def, windowStart, windowEnd);
        } else {
          runs = evaluateCalendarSchedule(def, windowStart, windowEnd);
        }
        allDueRuns.push(...runs);
      }

      // 3. For each due run, expand to target agents and dispatch
      for (const run of allDueRuns) {
        const def = defs.find(d => d.id === run.scheduleId);
        if (!def) continue;

        const agentIds = await this.db.schedules.listTargets(run.scheduleId);

        for (const agentId of agentIds) {
          // Check max_runs per agent
          if (def.max_runs != null) {
            const count = await this.db.schedules.countRuns(run.scheduleId, agentId);
            if (count >= def.max_runs) {
              console.log(`[Scheduler] ${def.title}: agent ${agentId} reached max_runs (${def.max_runs}), skipping`);
              continue;
            }
          }

          // Try to insert run log entry (dedupe)
          const runRow: ScheduleRunRow = {
            schedule_id: run.scheduleId,
            agent_id: agentId,
            scheduled_key: run.scheduledKey,
            scheduled_at: run.scheduledAt,
            fired_at: nowSec,
            status: 'sent',
            error: null,
          };

          const inserted = await this.db.schedules.insertRun(runRow);
          if (!inserted) {
            // Already dispatched (dedupe)
            continue;
          }

          // Resolve agent info for dispatch
          const target = await this.resolveAgent(agentId);
          if (!target) {
            await this.db.schedules.updateRunStatus(
              run.scheduleId, agentId, run.scheduledKey,
              'skipped', 'Agent not found',
            );
            continue;
          }

          // Dispatch
          const result = await this.dispatcher.dispatch(def, target, run.scheduledKey);
          if (result.success) {
            console.log(`[Scheduler] ${def.title} -> ${target.name} (${run.scheduledKey})`);
          } else {
            await this.db.schedules.updateRunStatus(
              run.scheduleId, agentId, run.scheduledKey,
              'failed', result.error ?? null,
            );
            console.log(`[Scheduler] ${def.title} -> ${target.name} FAILED: ${result.error}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`[Scheduler] Tick error: ${err.message}`);
    }

    this.lastTickAtSec = windowEnd;
  }

  /**
   * Seed a schedule from a heartbeat config.
   * Upserts the definition and replaces targets.
   */
  async seedSchedule(def: ScheduleDefinitionRow, agentIds: string[]): Promise<void> {
    await this.db.schedules.upsertDefinition(def);
    await this.db.schedules.replaceTargets(def.id, agentIds);
    console.log(`[Scheduler] Seeded schedule "${def.title}" -> [${agentIds.join(', ')}]`);
  }

  /**
   * Remove all yaml-sourced schedules for a given agent.
   */
  async removeAgentSchedules(agentId: string): Promise<void> {
    await this.db.schedules.deleteBySource('yaml', `heartbeat:${agentId}`);
  }
}
