// SPDX-License-Identifier: MIT
/**
 * Shared helpers for the `/checkins` HTTP surface — duration parsing,
 * payload validation, and response shaping. Kept out of agent-manager-db.ts
 * so the route handlers stay readable.
 *
 * Source-of-truth for shapes/defaults: output/checkin-primitive-design.md.
 */

import type { CheckinRow, CheckinPriority, CheckinStatus } from '../db/types.js';

export const DEFAULT_INTERVAL_SECONDS = 900; // 15m
export const DEFAULT_CLOSE_WHEN: Record<string, unknown> = { task_status: ['done'] };
const VALID_PRIORITIES: ReadonlyArray<CheckinPriority> = ['low', 'normal', 'high'];
const VALID_STATUSES: ReadonlyArray<CheckinStatus> = ['active', 'snoozed', 'closed', 'expired'];
const MAX_NOTE = 1024;

/**
 * Parse a duration value into seconds. Accepts:
 *   - a finite positive number (treated as seconds)
 *   - a string of `<digits><unit>` where unit ∈ {s, m, h, d}
 *   - a string of plain digits (treated as seconds)
 *
 * Returns `null` on any other shape so callers can return 400 with a clear
 * error code instead of a generic NaN propagation.
 */
export function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier =
    unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return n * multiplier;
}

export function isValidPriority(value: unknown): value is CheckinPriority {
  return typeof value === 'string' && (VALID_PRIORITIES as readonly string[]).includes(value);
}

export function isValidStatus(value: unknown): value is CheckinStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);
}

/**
 * Coerce a CSV / array of statuses into the array shape the repo expects.
 * Returns `null` on any value the caller cannot send (so the route handler
 * surfaces a 400). An empty result means "no filter" — callers should treat
 * `undefined` and `[]` as identical and skip the filter.
 */
export function parseStatusFilter(raw: unknown): CheckinStatus[] | null {
  if (raw === undefined || raw === null || raw === '') return [];
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [raw];
  const out: CheckinStatus[] = [];
  for (const item of items) {
    if (!isValidStatus(item)) return null;
    out.push(item);
  }
  return out;
}

export function clampNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') return null;
  return note.length > MAX_NOTE ? note.slice(0, MAX_NOTE) : note;
}

/**
 * Build the documented response envelope for a CheckinRow. The shape mirrors
 * the design doc's "POST /checkins" response and the `/checkins/:id` lookups
 * — callers can layer extra context (e.g. linkedTask details) on top.
 *
 * `owner` is the resolved human-readable name (alias or `agents.name`) when
 * available, or `null`. `ownerId` is the agent id. POST and GET callers must
 * pass the same `ownerName` extras so the shape is identical across both.
 */
export function buildCheckinResponse(
  row: CheckinRow,
  extras: { ownerName?: string | null; linkedTask?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  const ownerName = extras.ownerName ?? null;
  return {
    id: row.id,
    teamId: row.team_id,
    owner: ownerName,
    ownerId: row.owner_agent_id,
    ownerAgentId: row.owner_agent_id,
    createdByAgentId: row.created_by_agent_id,
    linkedTaskId: row.linked_task_id,
    ...(extras.linkedTask !== undefined ? { linkedTask: extras.linkedTask } : {}),
    intervalSeconds: row.interval_seconds,
    priority: row.priority,
    status: row.status,
    closeWhen: row.close_when,
    maxIterations: row.max_iterations,
    iterationCount: row.iteration_count,
    nextFireAt: row.next_fire_at,
    snoozeUntil: row.snooze_until,
    ttlExpiresAt: row.ttl_expires_at,
    lastFireAt: row.last_fire_at,
    lastEventSeq: row.last_event_seq,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
  };
}

/**
 * Generate a checkin id with the documented `chk_<unix>_<rand>` shape. The
 * unix prefix is human-sortable in admin tools without imposing a sort
 * contract on the database (`id` is the primary key, but row order on disk
 * follows insert order).
 */
export function generateCheckinId(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 9);
  return `chk_${Math.floor(now / 1000)}_${rand}`;
}
