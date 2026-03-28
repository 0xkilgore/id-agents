// SPDX-License-Identifier: MIT

import type { SchedulePayload, DispatchResult, DispatchTarget } from './schedule-types.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

/**
 * Delivers scheduled payloads to agent /talk or /schedule endpoints.
 */
export class ScheduleDispatcher {
  /**
   * Send a schedule payload to a single agent.
   * Returns a DispatchResult indicating success or failure.
   */
  async dispatch(
    def: ScheduleDefinitionRow,
    target: DispatchTarget,
    scheduledKey: string,
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
      from: 'manager',
      mode: def.delivery_mode,
      schedule: {
        id: def.id,
        kind: def.kind,
        title: def.title,
        scheduledKey,
      },
      message: def.message,
    };

    const path = def.delivery_mode === 'internal' ? target.schedulePath : target.talkPath;
    if (def.delivery_mode === 'internal' && !path) {
      result.error = `Agent ${target.name} does not advertise /schedule`;
      return result;
    }

    try {
      const response = await fetch(`${target.endpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        result.success = true;
      } else {
        result.error = `HTTP ${response.status}`;
      }
    } catch (err: any) {
      result.error = err.message || String(err);
    }

    return result;
  }
}
