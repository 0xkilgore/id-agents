// SPDX-License-Identifier: MIT

/**
 * Auto-close hook for checkins linked to a task that just transitioned to a
 * terminal status (output/checkin-primitive-design.md → "Auto-Close Logic").
 *
 * The wakeup-service emits `task:completed` (and any future terminal task
 * topics) at the same call sites that flip the task row. This module is the
 * matching consumer: given a terminal task event, it closes every
 * active/snoozed checkin linked to that task and emits one `checkin:closed`
 * audit event per row, with `last_event_seq` stamped on each row.
 *
 * The DB mutation (set status='closed', closed_reason='linked_task_terminal',
 * closed_at, clear next_fire_at + snooze_until) is performed atomically by
 * `CheckinsRepository.closeForTerminalTask` so a racing dispatcher cannot
 * partially close. Event emission then runs row-by-row over the snapshot
 * we listed pre-close (so we capture owner / linked_task even for rows the
 * bulk close already touched).
 *
 * Producers and the consumer are wired via direct call (`emitTaskCompleted`
 * in the task-done route invokes this helper afterwards). When subscription
 * delivery lands, the hook can be re-bound to a topic listener with no
 * change to the closure logic here.
 */

import type { Db } from '../db/db-service.js';
import { recordCheckinClosed, TASK_COMPLETED } from '../wakeup-service/event-producer.js';

/**
 * Reason stamped on every auto-closed checkin row and on the emitted
 * `checkin:closed` event payload.
 */
export const LINKED_TASK_TERMINAL_REASON = 'linked_task_terminal';

export interface CloseLinkedCheckinsInput {
  teamId: string;
  taskId: string;
  /** Final task status (e.g. 'done'). Recorded on the event payload. */
  taskStatus: string;
  /**
   * The terminal task topic that triggered the close
   * (e.g. `task:completed`). Recorded on the event payload so consumers
   * can correlate the close with the originating task event.
   */
  terminalTopic?: string;
  /** Actor that drove the terminal transition. Defaults to the row owner. */
  actorAgentId?: string | null;
  /** ms since epoch — used as `closed_at` and `occurred_at` on emitted events. */
  occurredAt: number;
}

export interface CloseLinkedCheckinsResult {
  /** Number of checkin rows transitioned to `closed`. */
  closed: number;
  /** seq values of the emitted `checkin:closed` events, one per row. */
  eventSeqs: number[];
}

/**
 * Close every active/snoozed checkin linked to `taskId` and emit one
 * `checkin:closed` event per row. Idempotent: rows already in a terminal
 * state are skipped silently (no event, no double-stamp).
 *
 * Returns `{ closed: 0, eventSeqs: [] }` when no linked rows exist; callers
 * can ignore the return value.
 */
export async function closeLinkedCheckinsForTerminalTask(
  db: Pick<Db, 'checkins' | 'events'>,
  input: CloseLinkedCheckinsInput,
): Promise<CloseLinkedCheckinsResult> {
  const linked = await db.checkins.list({
    teamId: input.teamId,
    linkedTaskId: input.taskId,
    status: ['active', 'snoozed'],
  });

  if (linked.length === 0) {
    return { closed: 0, eventSeqs: [] };
  }

  const closed = await db.checkins.closeForTerminalTask(
    input.taskId,
    input.teamId,
    input.occurredAt,
    LINKED_TASK_TERMINAL_REASON,
  );

  const eventSeqs: number[] = [];
  for (const row of linked) {
    const { seq } = await recordCheckinClosed(db.events, db.checkins, {
      teamId: row.team_id,
      checkinId: row.id,
      ownerAgentId: row.owner_agent_id,
      linkedTaskId: row.linked_task_id,
      reason: LINKED_TASK_TERMINAL_REASON,
      terminalTopic: input.terminalTopic ?? TASK_COMPLETED,
      taskStatus: input.taskStatus,
      actorAgentId: input.actorAgentId ?? row.owner_agent_id,
      occurredAt: input.occurredAt,
    });
    eventSeqs.push(seq);
  }

  return { closed, eventSeqs };
}
