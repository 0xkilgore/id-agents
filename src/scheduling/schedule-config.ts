// SPDX-License-Identifier: MIT

/**
 * Normalize heartbeat configs into schedule definitions.
 *
 * Bridges the existing HeartbeatConfig format (used by deployment YAML)
 * to the new scheduling system's ScheduleDefinitionRow.
 */

import type { HeartbeatConfig } from '../config-parser.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

/**
 * Validate that an interval value is within the allowed range.
 * Throws a descriptive error if seconds < 60 or > 86400.
 */
export function validateIntervalSeconds(seconds: number): void {
  if (seconds < 60) {
    throw new Error(
      `Interval too short: ${seconds}s. Minimum interval is 60 seconds (1 minute).`
    );
  }
  if (seconds > 86400) {
    throw new Error(
      `Interval too long: ${seconds}s. Maximum interval is 86400 seconds (24 hours).`
    );
  }
}

/**
 * Convert a HeartbeatConfig into an interval schedule definition.
 *
 * Produces a deterministic schedule ID based on the agent ID so that
 * redeploying the same agent yields the same schedule row (upsert-friendly).
 *
 * @param agentId   - Unique agent identifier (used to build schedule ID)
 * @param agentName - Human-readable agent name (used in title)
 * @param config    - Heartbeat configuration from deployment YAML
 * @param nowSec    - Optional unix-seconds override (defaults to Date.now()/1000)
 * @returns The schedule definition row and list of target agent IDs
 */
export function heartbeatToSchedule(
  agentId: string,
  agentName: string,
  config: HeartbeatConfig,
  nowSec?: number,
): { definition: ScheduleDefinitionRow; agentIds: string[] } {
  validateIntervalSeconds(config.interval);

  const now = nowSec ?? Math.floor(Date.now() / 1000);

  const definition: ScheduleDefinitionRow = {
    id: `hb_${agentId}`,
    kind: 'interval',
    title: `Heartbeat: ${agentName}`,
    description: null,
    active: true,
    message: config.message,
    timezone: null,
    catch_up_policy: 'fire_once',
    dedupe_window_seconds: 90,
    interval_seconds: config.interval,
    anchor_at: now,
    max_runs: config.maxBeats ?? 20,
    expires_at: now + (config.expiresAfter ?? 7200),
    local_time_seconds: null,
    local_date: null,
    days_of_week: null,
    source_type: 'yaml',
    source_key: `heartbeat:${agentId}`,
    created_at: now,
    updated_at: now,
  };

  return { definition, agentIds: [agentId] };
}
