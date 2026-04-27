// SPDX-License-Identifier: MIT

/**
 * Checkin due-service tick (output/checkin-primitive-design.md → "Dispatch
 * Loop"). Runs on its own 30s cadence, separate from the query sweeper and
 * scheduler so task-watch behavior can evolve independently.
 *
 * Per tick, for each team:
 *   1. Read due rows (status active|snoozed AND next_fire_at <= now).
 *   2. Hard-expire TTL rows first (no fire) — emit `checkin:expired`.
 *   3. For the remaining due rows: increment iteration_count, advance
 *      next_fire_at by interval_seconds, write a news_item to the owner's
 *      inbox, and emit `checkin:due`.
 *   4. If iteration_count >= max_iterations after the fire, transition to
 *      `expired` and emit `checkin:expired`.
 *
 * Snoozed rows are returned by `claimDue` once their `snooze_until` <= now;
 * we flip their status back to `active` and clear `snooze_until` as part of
 * the same `updateFields` call that records the fire.
 */

import type { Db } from '../db/db-service.js';
import type { CheckinRow, CheckinPriority, MutableCheckinFields, TaskRow, AgentRow } from '../db/types.js';
import {
  emitCheckinDue,
  emitCheckinExpired,
} from '../wakeup-service/event-producer.js';

export const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DUE_BATCH_LIMIT = 200;

export interface CheckinServiceOptions {
  /** Tick cadence in ms; defaults to 30s. */
  intervalMs?: number;
  /** Max checkins to process per team per tick. Hard cap on a misbehaving fleet. */
  batchLimit?: number;
  /** Logger hook. Defaults to console.error for failures only. */
  log?: (msg: string, err?: unknown) => void;
}

export interface TickResult {
  scanned: number;
  fired: number;
  expired: number;
  errors: number;
}

export class CheckinService {
  private interval: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly log: (msg: string, err?: unknown) => void;
  private running = false;

  constructor(private readonly db: Db, opts: CheckinServiceOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.batchLimit = Math.min(opts.batchLimit ?? DUE_BATCH_LIMIT, 1000);
    this.log = opts.log ?? ((msg, err) => err ? console.error(`[CheckinService] ${msg}`, err) : undefined);
  }

  /** Start the tick loop. Idempotent. */
  start(): void {
    if (this.interval) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.tick(Date.now())
        .catch((err) => this.log('tick failed', err))
        .finally(() => { this.running = false; });
    };
    this.interval = setInterval(run, this.intervalMs);
    // unref so the interval doesn't keep node alive in tests / short scripts.
    this.interval.unref?.();
  }

  /** Stop the tick loop. Safe to call multiple times. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Single pass over all teams. Exposed for tests; production callers should
   * normally use `start()` to install the interval.
   */
  async tick(now: number): Promise<TickResult> {
    const result: TickResult = { scanned: 0, fired: 0, expired: 0, errors: 0 };
    const teams = await this.db.teams.listTeams();
    for (const team of teams) {
      try {
        const teamResult = await this.tickTeam(team.id, now);
        result.scanned += teamResult.scanned;
        result.fired += teamResult.fired;
        result.expired += teamResult.expired;
        result.errors += teamResult.errors;
      } catch (err) {
        result.errors += 1;
        this.log(`team ${team.id} tick failed`, err);
      }
    }
    return result;
  }

  /** One team's slice of a tick. Public for focused tests. */
  async tickTeam(teamId: string, now: number): Promise<TickResult> {
    const result: TickResult = { scanned: 0, fired: 0, expired: 0, errors: 0 };
    const due = await this.db.checkins.claimDue(teamId, now, this.batchLimit);
    result.scanned = due.length;
    for (const row of due) {
      try {
        if (this.isTtlExpired(row, now)) {
          await this.expireRow(row, now, 'ttl');
          result.expired += 1;
          continue;
        }
        await this.fireRow(row, now);
        result.fired += 1;
        // Re-fetch so we can decide whether to expire on max_iterations after
        // the fire incremented iteration_count.
        const updated = await this.db.checkins.get(row.id, teamId);
        if (updated && this.shouldExpireForMaxIterations(updated)) {
          await this.expireRow(updated, now, 'max_iterations');
          result.expired += 1;
        }
      } catch (err) {
        result.errors += 1;
        this.log(`checkin ${row.id} tick failed`, err);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private isTtlExpired(row: CheckinRow, now: number): boolean {
    return row.ttl_expires_at !== null && row.ttl_expires_at <= now;
  }

  private shouldExpireForMaxIterations(row: CheckinRow): boolean {
    return row.max_iterations !== null && row.iteration_count >= row.max_iterations;
  }

  /**
   * Fire one due row: bump iteration_count, advance next_fire_at, flip a
   * snoozed row back to active, write news for the owner, emit `checkin:due`.
   */
  private async fireRow(row: CheckinRow, now: number): Promise<void> {
    const nextFireAt = now + row.interval_seconds * 1000;
    const newIterationCount = row.iteration_count + 1;
    const linkedTask = row.linked_task_id
      ? await this.fetchTaskById(row.linked_task_id)
      : null;
    const linkedTaskRef = linkedTask ? this.taskRef(linkedTask) : null;
    const taskOwnerName = linkedTask?.owner
      ? await this.resolveAgentName(linkedTask.owner)
      : null;

    const dueResult = await emitCheckinDue(this.db.events, {
      teamId: row.team_id,
      checkinId: row.id,
      ownerAgentId: row.owner_agent_id,
      linkedTaskId: row.linked_task_id,
      priority: row.priority as CheckinPriority,
      intervalSeconds: row.interval_seconds,
      iterationCount: newIterationCount,
      maxIterations: row.max_iterations,
      nextFireAt,
      snoozeUntil: null,
      ttlExpiresAt: row.ttl_expires_at,
      lastFireAt: now,
      occurredAt: now,
      linkedTask: linkedTaskRef
        ? { ...linkedTaskRef, assignee: taskOwnerName }
        : null,
      actions: this.buildActions(row.id),
    });

    const fields: MutableCheckinFields = {
      status: 'active',
      iteration_count: newIterationCount,
      next_fire_at: nextFireAt,
      snooze_until: null,
      last_fire_at: now,
      last_event_seq: dueResult.seq,
      updated_at: now,
    };
    await this.db.checkins.updateFields(row.id, row.team_id, fields);

    if (row.owner_agent_id) {
      await this.writeOwnerNews(row, {
        now,
        nextFireAt,
        iterationCount: newIterationCount,
        linkedTask,
        taskOwnerName,
      });
    }
  }

  private async expireRow(
    row: CheckinRow,
    now: number,
    reason: 'max_iterations' | 'ttl',
  ): Promise<void> {
    const expiredResult = await emitCheckinExpired(this.db.events, {
      teamId: row.team_id,
      checkinId: row.id,
      ownerAgentId: row.owner_agent_id,
      linkedTaskId: row.linked_task_id,
      reason,
      iterationCount: row.iteration_count,
      maxIterations: row.max_iterations,
      ttlExpiresAt: row.ttl_expires_at,
      occurredAt: now,
    });

    await this.db.checkins.updateFields(row.id, row.team_id, {
      status: 'expired',
      next_fire_at: null,
      snooze_until: null,
      closed_at: now,
      closed_reason: reason,
      last_event_seq: expiredResult.seq,
      updated_at: now,
    });
  }

  private async writeOwnerNews(
    row: CheckinRow,
    ctx: {
      now: number;
      nextFireAt: number;
      iterationCount: number;
      linkedTask: TaskRow | null;
      taskOwnerName: string | null;
    },
  ): Promise<void> {
    const idleMs = ctx.linkedTask
      ? Math.max(0, ctx.now - ctx.linkedTask.updated_at * 1000)
      : null;

    const data: Record<string, unknown> = {
      kind: 'checkin:due',
      checkin_id: row.id,
      priority: row.priority,
      iteration_count: ctx.iterationCount,
      max_iterations: row.max_iterations,
      interval_seconds: row.interval_seconds,
      next_fire_at: ctx.nextFireAt,
      ttl_expires_at: row.ttl_expires_at,
      actions: this.buildActions(row.id),
    };
    if (ctx.linkedTask) {
      data.linked_task = {
        id: ctx.linkedTask.id,
        name: ctx.linkedTask.name,
        title: ctx.linkedTask.title,
        status: ctx.linkedTask.status,
        assignee: ctx.taskOwnerName,
        last_activity_at: ctx.linkedTask.updated_at,
        idle_ms: idleMs,
      };
    }

    const taskNameHint = ctx.linkedTask?.name ?? row.linked_task_id ?? row.id;
    const message = `Checkin due (${row.priority}) — ${taskNameHint} · iter ${ctx.iterationCount}${
      row.max_iterations !== null ? `/${row.max_iterations}` : ''
    }`;

    await this.db.news.add(row.team_id, row.owner_agent_id!, {
      timestamp: ctx.now,
      type: 'checkin_due',
      message,
      data,
      kind: 'notify',
      reply_expected: false,
    });
  }

  private buildActions(checkinId: string): Record<string, string> {
    return {
      inspect: `/checkins/${checkinId}/inspect`,
      nudge: `/checkins/${checkinId}/nudge`,
      snooze: `/checkins/${checkinId}/snooze`,
      close: `/checkins/${checkinId}/close`,
    };
  }

  private taskRef(task: TaskRow): {
    id: string;
    name: string;
    title: string;
    status: string;
  } {
    return { id: task.id, name: task.name, title: task.title, status: task.status };
  }

  private async fetchTaskById(taskId: string): Promise<TaskRow | null> {
    const placeholder = this.db.adapter.dialect === 'postgres' ? '$1' : '?';
    const { rows } = await this.db.adapter.query<TaskRow>(
      `SELECT id, name, uuid, team_id, title, description, status, created_by, owner,
              created_at, updated_at, completed_at
       FROM tasks WHERE id = ${placeholder}`,
      [taskId],
    );
    return rows[0] ?? null;
  }

  private async resolveAgentName(agentId: string): Promise<string | null> {
    const agent: AgentRow | null = await this.db.agents.getById(agentId).catch(() => null);
    if (!agent) return null;
    return (agent.metadata as any)?.alias || agent.name;
  }
}
