// SPDX-License-Identifier: MIT

import type { Db } from '../db/db-service.js';
import type { ScheduleDefinitionRow, ScheduleRunRow } from '../db/types.js';
import type { DueRun, DispatchTarget } from './schedule-types.js';
import { evaluateIntervalSchedule, evaluateCalendarSchedule } from './schedule-evaluator.js';
import { ScheduleDispatcher } from './schedule-dispatcher.js';

export class SchedulerService {
  private lastTickAtSec = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatcher: ScheduleDispatcher;

  constructor(
    private readonly db: Db,
    private readonly resolveAgent: (agentId: string) => Promise<DispatchTarget | null>,
  ) {
    this.dispatcher = new ScheduleDispatcher();
  }

  start(): void {
    if (this.timer) return;
    console.log('[Scheduler] Starting (30s tick interval)');
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Scheduler] Stopped');
    }
  }

  async tick(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = this.lastTickAtSec;
    const windowEnd = nowSec;

    try {
      const defs = await this.db.schedules.listActiveDefinitions();
      const defsById = new Map(defs.map((def) => [def.id, def]));

      const allDueRuns: DueRun[] = [];
      for (const def of defs) {
        const runs = def.kind === 'interval'
          ? evaluateIntervalSchedule(def, windowStart, windowEnd)
          : evaluateCalendarSchedule(def, windowStart, windowEnd);
        allDueRuns.push(...runs);
      }

      for (const run of allDueRuns) {
        const def = defsById.get(run.scheduleId);
        if (!def) continue;

        const agentIds = await this.db.schedules.listTargets(run.scheduleId);

        for (const agentId of agentIds) {
          if (def.max_runs != null) {
            const sentCount = await this.db.schedules.countRuns(run.scheduleId, agentId);
            if (sentCount >= def.max_runs) {
              console.log(`[Scheduler] ${def.title}: agent ${agentId} reached max_runs (${def.max_runs}), skipping`);
              continue;
            }
          }

          const runRow: ScheduleRunRow = {
            schedule_id: run.scheduleId,
            agent_id: agentId,
            scheduled_key: run.scheduledKey,
            scheduled_at: run.scheduledAt,
            fired_at: nowSec,
            status: 'pending',
            error: null,
          };

          const inserted = await this.db.schedules.insertRun(runRow);
          if (!inserted) continue;

          const target = await this.resolveAgent(agentId);
          if (!target) {
            await this.db.schedules.updateRunStatus(run.scheduleId, agentId, run.scheduledKey, 'skipped', 'Agent not found');
            continue;
          }

          const result = await this.dispatcher.dispatch(def, target, run.scheduledKey);
          if (result.success) {
            await this.db.schedules.updateRunStatus(run.scheduleId, agentId, run.scheduledKey, 'sent');
            console.log(`[Scheduler] ${def.title} -> ${target.name} (${run.scheduledKey})`);
          } else {
            await this.db.schedules.updateRunStatus(run.scheduleId, agentId, run.scheduledKey, 'failed', result.error ?? null);
            console.log(`[Scheduler] ${def.title} -> ${target.name} FAILED: ${result.error}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`[Scheduler] Tick error: ${err.message}`);
    }

    this.lastTickAtSec = windowEnd;
  }

  async seedSchedule(def: ScheduleDefinitionRow, agentIds: string[]): Promise<void> {
    await this.db.schedules.upsertDefinition(def);
    await this.db.schedules.replaceTargets(def.id, agentIds);
    console.log(`[Scheduler] Seeded schedule "${def.title}" -> [${agentIds.join(', ')}]`);
  }

  async removeAgentSchedules(agentId: string): Promise<void> {
    await this.db.schedules.deleteBySource('yaml', `heartbeat:${agentId}`);
  }
}
