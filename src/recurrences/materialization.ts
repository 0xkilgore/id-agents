// Materialization planner — pure.
//
// Given (state, now, gating), returns the MATERIALIZE_INSTANCE ops
// the manager should apply this tick. The reducer is the writer;
// this module is the planner. Idempotency is enforced both here
// (don't propose a duplicate when an instance already exists with
// the same idempotency_key) and in the reducer (defense in depth).
//
// CTO scope §"Materialization Service Contract" + §"Failure Mode".

import { defaultHorizonForRrule, expandRrule } from "./rrule.js";
import {
  type GatingProbe,
  type RecurrenceOp,
  type RecurrenceState,
  type RecurrenceTemplate,
} from "./types.js";

export type MaterializeNow = string; // ISO datetime

export interface PlanMaterializationsArgs {
  state: RecurrenceState;
  now: MaterializeNow;
  gating: GatingProbe;
}

/** Stable idempotency key per CTO scope §"Algorithm" step 4. */
export function computeIdempotencyKey(
  recurrencePhid: string,
  scheduledFor: string,
): string {
  return `recurrence:${recurrencePhid}:${scheduledFor}`;
}

export async function planMaterializations(
  args: PlanMaterializationsArgs,
): Promise<RecurrenceOp[]> {
  const ops: RecurrenceOp[] = [];
  const now = args.now;
  const nowMs = Date.parse(now);

  for (const template of args.state.templates.values()) {
    if (template.status !== "active") continue;
    const horizonDays = effectiveHorizonDays(template);
    const windowEndMs = nowMs + horizonDays * 24 * 60 * 60 * 1000;
    let fires: string[];
    try {
      fires = expandRrule({
        rrule: template.rrule,
        starts_on: template.starts_on,
        timezone: template.timezone,
        exception_dates: template.exception_dates,
        window_start: now,
        window_end: new Date(windowEndMs).toISOString(),
      });
    } catch {
      // Invalid RRULE — the reducer's pauseIfInvalidRrule should
      // already have caught this on CREATE/UPDATE; defensive skip.
      continue;
    }
    const existingInstances =
      args.state.instancesByTemplate.get(template.recurrence_phid) ?? [];
    const existingKeys = new Set(
      existingInstances.map((i) => i.idempotency_key),
    );

    for (const scheduledFor of fires) {
      const idempotencyKey = computeIdempotencyKey(
        template.recurrence_phid,
        scheduledFor,
      );
      if (existingKeys.has(idempotencyKey)) continue;
      const decision = await args.gating.check(template);
      const instancePhid = mintInstancePhid(
        template.recurrence_phid,
        scheduledFor,
      );
      const materializedRef = templateRefForKind(template);
      if (decision.allowed) {
        ops.push({
          type: "MATERIALIZE_INSTANCE",
          recurrence_phid: template.recurrence_phid,
          instance_phid: instancePhid,
          scheduled_for: scheduledFor,
          materialized_ref: materializedRef,
          idempotency_key: idempotencyKey,
        });
      } else {
        ops.push({
          type: "MATERIALIZE_INSTANCE",
          recurrence_phid: template.recurrence_phid,
          instance_phid: instancePhid,
          scheduled_for: scheduledFor,
          materialized_ref: materializedRef,
          idempotency_key: idempotencyKey,
          gating_reason: decision.reason,
        });
      }
    }
  }
  return ops;
}

function effectiveHorizonDays(template: RecurrenceTemplate): number {
  const explicit = template.materialize_policy.horizon_days;
  if (explicit && explicit > 0) return explicit;
  return defaultHorizonForRrule(template.rrule);
}

/**
 * For each kind, populate `materialized_ref` with the canonical
 * template reference so downstream consumers (Task / Event /
 * Dispatch) can find the source artifact without re-querying the
 * template.
 */
function templateRefForKind(
  template: RecurrenceTemplate,
): import("./types.js").RecurrenceInstanceMaterializedRef {
  if (template.kind === "task" && template.template_task_phid) {
    return { task_phid: template.template_task_phid };
  }
  if (template.kind === "calendar_event" && template.template_event_phid) {
    return { event_phid: template.template_event_phid };
  }
  // schedule_prompt and report do not have a pre-existing template
  // artifact — the materialized_ref is populated by the dispatch
  // result (downstream).
  return {};
}

function mintInstancePhid(
  recurrencePhid: string,
  scheduledFor: string,
): string {
  const hash = simpleHash(`${recurrencePhid}|${scheduledFor}`);
  return `phid:inst-${hash}`;
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
