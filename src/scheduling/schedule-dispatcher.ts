// SPDX-License-Identifier: MIT

import type { SchedulePayload, DispatchResult, DispatchTarget, LinkedTaskSummary } from './schedule-types.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

export interface ScheduleDispatcherOptions {
  managerUrl?: string;
}

/**
 * Delivers scheduled payloads to agent /talk or /schedule endpoints.
 */
export class ScheduleDispatcher {
  private readonly managerUrl: string | null;

  constructor(opts: ScheduleDispatcherOptions = {}) {
    this.managerUrl =
      opts.managerUrl ?? process.env.MANAGER_URL ?? 'http://127.0.0.1:4100';
  }

  private async registerDispatch(
    def: ScheduleDefinitionRow,
    target: DispatchTarget,
    scheduledKey: string,
    channel: string,
  ): Promise<number | null> {
    if (!this.managerUrl) return null;
    try {
      const resp = await fetch(`${this.managerUrl}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_actor: 'scheduler',
          to_agent: target.name,
          channel,
          message: def.message,
          query_id: scheduledKey,
          verify_signal: null,
        }),
      });
      if (!resp.ok) return null;
      const body = (await resp.json()) as { dispatch_id?: number };
      return typeof body.dispatch_id === 'number' ? body.dispatch_id : null;
    } catch {
      return null;
    }
  }

  private async flipInFlight(dispatchId: number): Promise<void> {
    if (!this.managerUrl) return;
    try {
      await fetch(`${this.managerUrl}/dispatches/${dispatchId}/in-flight`, {
        method: 'POST',
      });
    } catch {
      // Non-fatal; status flip is best-effort.
    }
  }

  /**
   * Send a schedule payload to a single agent.
   * Returns a DispatchResult indicating success or failure.
   */
  async dispatch(
    def: ScheduleDefinitionRow,
    target: DispatchTarget,
    scheduledKey: string,
    linkedTasks?: LinkedTaskSummary[],
  ): Promise<DispatchResult> {
    const result: DispatchResult = {
      scheduleId: def.id,
      agentId: target.id,
      scheduledKey,
      success: false,
    };

    if (target.status !== 'running') {
      result.error = `Agent ${target.name} not running (status: ${target.status})`;
      return result;
    }

    if (!target.endpoint) {
      result.error = `Agent ${target.name} has no endpoint`;
      return result;
    }

    const payload: SchedulePayload = {
      from: def.sender || 'schedule',
      mode: def.delivery_mode,
      schedule: {
        id: def.id,
        kind: def.kind,
        title: def.title,
        scheduledKey,
      },
      message: def.message,
    };

    if (linkedTasks && linkedTasks.length > 0) {
      payload.linkedTasks = linkedTasks;
    }

    const path = def.delivery_mode === 'internal' ? target.schedulePath : target.talkPath;
    if (def.delivery_mode === 'internal' && !path) {
      result.error = `Agent ${target.name} does not advertise /schedule`;
      return result;
    }

    const dispatchId = await this.registerDispatch(
      def,
      target,
      scheduledKey,
      def.delivery_mode === 'internal' ? 'schedule' : 'talk',
    );

    try {
      const response = await fetch(`${target.endpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, dispatch_id: dispatchId }),
      });

      if (response.ok) {
        result.success = true;
        if (dispatchId !== null) {
          await this.flipInFlight(dispatchId);
        }
      } else {
        result.error = `HTTP ${response.status}`;
      }
    } catch (err: any) {
      result.error = err.message || String(err);
    }

    return result;
  }
}
