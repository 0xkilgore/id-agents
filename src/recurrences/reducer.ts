// Pure reducer for the 5 typed RecurrenceTemplate operations.
//
// CTO scope §"Typed Operations" + §"Failure Mode" + §"Exception Semantics".
//
// The reducer is pure: it takes (state, op) and returns the new
// state + the rows that need persisting + a side-effects array the
// caller can use to drive downstream dispatch / metrics.
//
// Idempotency for MATERIALIZE_INSTANCE is enforced HERE (the storage
// layer also dedupes, but a pure-state idempotency check means the
// reducer can be replayed against an in-memory snapshot without
// double-creating instances).

import { parseRrule } from "./rrule.js";
import {
  type ApplyOpEffect,
  type ApplyOpResult,
  type RecurrenceInstance,
  type RecurrenceOp,
  type RecurrenceState,
  type RecurrenceTemplate,
} from "./types.js";

export function applyOp(
  state: RecurrenceState,
  op: RecurrenceOp,
): ApplyOpResult {
  switch (op.type) {
    case "CREATE":
      return applyCreate(state, op.recurrence);
    case "UPDATE":
      return applyUpdate(state, op.recurrence_phid, op.patch);
    case "CANCEL":
      return applyCancel(state, op.recurrence_phid, op.reason);
    case "MATERIALIZE_INSTANCE":
      return applyMaterializeInstance(state, op);
    case "RECORD_EXCEPTION":
      return applyRecordException(state, op);
  }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

function applyCreate(
  state: RecurrenceState,
  recurrence: RecurrenceTemplate,
): ApplyOpResult {
  if (state.templates.has(recurrence.recurrence_phid)) {
    throw new Error(
      `RecurrenceTemplate already exists: ${recurrence.recurrence_phid}`,
    );
  }

  const { template, effects } = pauseIfInvalidRrule(recurrence);
  const nextTemplates = new Map(state.templates);
  nextTemplates.set(template.recurrence_phid, template);
  return {
    state: {
      templates: nextTemplates,
      instancesByTemplate: state.instancesByTemplate,
    },
    changedTemplate: template,
    changedInstances: [],
    effects,
  };
}

function pauseIfInvalidRrule(
  template: RecurrenceTemplate,
): { template: RecurrenceTemplate; effects: ApplyOpEffect[] } {
  try {
    parseRrule(template.rrule);
    return { template, effects: [] };
  } catch {
    const paused: RecurrenceTemplate = {
      ...template,
      status: "paused",
      failure_reason: "invalid_rrule",
    };
    return {
      template: paused,
      effects: [
        {
          kind: "template_paused",
          recurrence_phid: template.recurrence_phid,
          reason: "invalid_rrule",
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

function applyUpdate(
  state: RecurrenceState,
  recurrencePhid: string,
  patch: Partial<RecurrenceTemplate>,
): ApplyOpResult {
  const existing = state.templates.get(recurrencePhid);
  if (!existing) {
    throw new Error(`RecurrenceTemplate not found: ${recurrencePhid}`);
  }
  const updated: RecurrenceTemplate = {
    ...existing,
    ...patch,
    updated_at: patch.updated_at ?? new Date().toISOString(),
    failure_reason: null, // clear; pauseIfInvalidRrule may re-set
  };
  const { template, effects } = pauseIfInvalidRrule(updated);
  const nextTemplates = new Map(state.templates);
  nextTemplates.set(template.recurrence_phid, template);
  return {
    state: {
      templates: nextTemplates,
      instancesByTemplate: state.instancesByTemplate,
    },
    changedTemplate: template,
    changedInstances: [],
    effects,
  };
}

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

function applyCancel(
  state: RecurrenceState,
  recurrencePhid: string,
  _reason: string,
): ApplyOpResult {
  const existing = state.templates.get(recurrencePhid);
  if (!existing) {
    throw new Error(`RecurrenceTemplate not found: ${recurrencePhid}`);
  }
  const cancelled: RecurrenceTemplate = {
    ...existing,
    status: "cancelled",
    failure_reason: "cancelled_by_operator",
    updated_at: new Date().toISOString(),
  };
  const nextTemplates = new Map(state.templates);
  nextTemplates.set(cancelled.recurrence_phid, cancelled);
  return {
    state: {
      templates: nextTemplates,
      instancesByTemplate: state.instancesByTemplate,
    },
    changedTemplate: cancelled,
    changedInstances: [],
    effects: [
      {
        kind: "template_paused",
        recurrence_phid: cancelled.recurrence_phid,
        reason: "cancelled_by_operator",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// MATERIALIZE_INSTANCE
// ---------------------------------------------------------------------------

function applyMaterializeInstance(
  state: RecurrenceState,
  op: Extract<RecurrenceOp, { type: "MATERIALIZE_INSTANCE" }>,
): ApplyOpResult {
  const template = state.templates.get(op.recurrence_phid);
  if (!template) {
    throw new Error(`RecurrenceTemplate not found: ${op.recurrence_phid}`);
  }
  const existing = state.instancesByTemplate.get(op.recurrence_phid) ?? [];
  const dup = existing.find(
    (i) => i.idempotency_key === op.idempotency_key,
  );
  if (dup) {
    // Idempotent — return current state unchanged, no new effects.
    return {
      state,
      changedTemplate: null,
      changedInstances: [],
      effects: [],
    };
  }
  const gated = op.gating_reason != null;
  const instance: RecurrenceInstance = {
    instance_phid: op.instance_phid,
    recurrence_phid: op.recurrence_phid,
    scheduled_for: op.scheduled_for,
    timezone: template.timezone,
    status: gated ? "planned" : "materialized",
    materialized_ref: op.materialized_ref,
    predecessor_instance_phid: null,
    idempotency_key: op.idempotency_key,
    materialized_at: gated ? null : new Date().toISOString(),
    completed_at: null,
    failure_reason: gated ? op.gating_reason! : null,
    source_exception_kind: null,
    source_exception_reason: null,
  };
  const nextInstances = new Map(state.instancesByTemplate);
  nextInstances.set(op.recurrence_phid, [...existing, instance]);
  return {
    state: { templates: state.templates, instancesByTemplate: nextInstances },
    changedTemplate: null,
    changedInstances: [instance],
    effects: [
      gated
        ? {
            kind: "instance_planned_pending_gating",
            instance_phid: instance.instance_phid,
            reason: op.gating_reason!,
          }
        : {
            kind: "instance_materialized",
            instance_phid: instance.instance_phid,
          },
    ],
  };
}

// ---------------------------------------------------------------------------
// RECORD_EXCEPTION
// ---------------------------------------------------------------------------

function applyRecordException(
  state: RecurrenceState,
  op: Extract<RecurrenceOp, { type: "RECORD_EXCEPTION" }>,
): ApplyOpResult {
  const template = state.templates.get(op.recurrence_phid);
  if (!template) {
    throw new Error(`RecurrenceTemplate not found: ${op.recurrence_phid}`);
  }

  if (op.exception_kind === "skip") {
    return recordSkip(state, template, op.exception_date, op.reason);
  }
  if (op.exception_kind === "snooze") {
    if (!op.replacement_scheduled_for) {
      throw new Error("replacement_scheduled_for required for snooze");
    }
    return recordSnooze(
      state,
      template,
      op.exception_date,
      op.reason,
      op.replacement_scheduled_for,
    );
  }
  if (op.exception_kind === "manual_fire") {
    if (!template.materialize_policy.allow_early_fire) {
      throw new Error(
        `template ${template.recurrence_phid} does not allow_early_fire`,
      );
    }
    if (!op.replacement_scheduled_for) {
      throw new Error(
        "replacement_scheduled_for required for manual_fire",
      );
    }
    return recordManualFire(
      state,
      template,
      op.exception_date,
      op.reason,
      op.replacement_scheduled_for,
    );
  }
  // cancel_instance
  return recordCancelInstance(state, template, op.exception_date);
}

function recordSkip(
  state: RecurrenceState,
  template: RecurrenceTemplate,
  exceptionDate: string,
  _reason: string,
): ApplyOpResult {
  const updated: RecurrenceTemplate = {
    ...template,
    exception_dates: dedupe([...template.exception_dates, exceptionDate]),
    updated_at: new Date().toISOString(),
  };
  const nextTemplates = new Map(state.templates);
  nextTemplates.set(updated.recurrence_phid, updated);
  return {
    state: {
      templates: nextTemplates,
      instancesByTemplate: state.instancesByTemplate,
    },
    changedTemplate: updated,
    changedInstances: [],
    effects: [
      {
        kind: "exception_recorded",
        recurrence_phid: template.recurrence_phid,
        exception_kind: "skip",
        exception_date: exceptionDate,
      },
    ],
  };
}

function recordSnooze(
  state: RecurrenceState,
  template: RecurrenceTemplate,
  exceptionDate: string,
  reason: string,
  replacementScheduledFor: string,
): ApplyOpResult {
  const updated: RecurrenceTemplate = {
    ...template,
    exception_dates: dedupe([...template.exception_dates, exceptionDate]),
    updated_at: new Date().toISOString(),
  };
  const nextTemplates = new Map(state.templates);
  nextTemplates.set(updated.recurrence_phid, updated);
  const instance = makeExceptionInstance(
    template,
    "snooze",
    reason,
    replacementScheduledFor,
  );
  const existing = state.instancesByTemplate.get(template.recurrence_phid) ?? [];
  const nextInstances = new Map(state.instancesByTemplate);
  nextInstances.set(template.recurrence_phid, [...existing, instance]);
  return {
    state: { templates: nextTemplates, instancesByTemplate: nextInstances },
    changedTemplate: updated,
    changedInstances: [instance],
    effects: [
      {
        kind: "exception_recorded",
        recurrence_phid: template.recurrence_phid,
        exception_kind: "snooze",
        exception_date: exceptionDate,
      },
    ],
  };
}

function recordManualFire(
  state: RecurrenceState,
  template: RecurrenceTemplate,
  exceptionDate: string,
  reason: string,
  replacementScheduledFor: string,
): ApplyOpResult {
  const instance = makeExceptionInstance(
    template,
    "manual_fire",
    reason,
    replacementScheduledFor,
  );
  const existing = state.instancesByTemplate.get(template.recurrence_phid) ?? [];
  const nextInstances = new Map(state.instancesByTemplate);
  nextInstances.set(template.recurrence_phid, [...existing, instance]);
  return {
    state: { templates: state.templates, instancesByTemplate: nextInstances },
    changedTemplate: null,
    changedInstances: [instance],
    effects: [
      {
        kind: "exception_recorded",
        recurrence_phid: template.recurrence_phid,
        exception_kind: "manual_fire",
        exception_date: exceptionDate,
      },
    ],
  };
}

function recordCancelInstance(
  state: RecurrenceState,
  template: RecurrenceTemplate,
  exceptionDate: string,
): ApplyOpResult {
  const existing = state.instancesByTemplate.get(template.recurrence_phid) ?? [];
  // Cancel the first non-terminal instance whose scheduled date matches.
  const targetIdx = existing.findIndex((i) =>
    i.scheduled_for.startsWith(exceptionDate) &&
    i.status !== "cancelled" &&
    i.status !== "completed" &&
    i.status !== "failed",
  );
  if (targetIdx < 0) {
    return {
      state,
      changedTemplate: null,
      changedInstances: [],
      effects: [],
    };
  }
  const target = existing[targetIdx];
  const cancelled: RecurrenceInstance = { ...target, status: "cancelled" };
  const updated = [...existing];
  updated[targetIdx] = cancelled;
  const nextInstances = new Map(state.instancesByTemplate);
  nextInstances.set(template.recurrence_phid, updated);
  return {
    state: { templates: state.templates, instancesByTemplate: nextInstances },
    changedTemplate: null,
    changedInstances: [cancelled],
    effects: [
      {
        kind: "instance_cancelled",
        instance_phid: cancelled.instance_phid,
      },
      {
        kind: "exception_recorded",
        recurrence_phid: template.recurrence_phid,
        exception_kind: "cancel_instance",
        exception_date: exceptionDate,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExceptionInstance(
  template: RecurrenceTemplate,
  exceptionKind: "snooze" | "manual_fire",
  reason: string,
  scheduledFor: string,
): RecurrenceInstance {
  return {
    instance_phid: mintInstancePhid(template.recurrence_phid, scheduledFor, exceptionKind),
    recurrence_phid: template.recurrence_phid,
    scheduled_for: scheduledFor,
    timezone: template.timezone,
    status: "materialized",
    materialized_ref: {},
    predecessor_instance_phid: null,
    idempotency_key: `recurrence:${template.recurrence_phid}:${scheduledFor}:${exceptionKind}`,
    materialized_at: new Date().toISOString(),
    completed_at: null,
    failure_reason: null,
    source_exception_kind: exceptionKind,
    source_exception_reason: reason,
  };
}

function mintInstancePhid(
  recurrencePhid: string,
  scheduledFor: string,
  exceptionKind: string,
): string {
  // Deterministic for the same (recurrence, scheduled_for, kind) so a
  // replay produces the same id. Tests and storage both rely on this.
  const hash = simpleHash(`${recurrencePhid}|${scheduledFor}|${exceptionKind}`);
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

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
