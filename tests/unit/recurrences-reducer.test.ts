// Reducer tests — pure state transitions for the 5 typed ops.
//
// CTO scope §"Typed Operations" + §"Failure Mode".

import { describe, expect, it } from "vitest";

import { applyOp } from "../../src/recurrences/reducer.js";
import {
  defaultMaterializePolicy,
  emptyState,
  type RecurrenceTemplate,
} from "../../src/recurrences/types.js";

function template(
  overrides: Partial<RecurrenceTemplate> = {},
): RecurrenceTemplate {
  return {
    recurrence_phid: "phid:rec-001",
    display_id: null,
    kind: "task",
    status: "active",
    title: "test",
    description: null,
    timezone: "UTC",
    rrule: "FREQ=DAILY",
    starts_on: "2026-06-10",
    ends_on: null,
    exception_dates: [],
    source_ref: null,
    owner_agent: null,
    project_phid: null,
    template_task_phid: null,
    template_event_phid: null,
    template_schedule_prompt_phid: null,
    template_artifact_kind: null,
    required_inputs: [],
    delivery_targets: [],
    predecessor_link: "none",
    materialize_policy: defaultMaterializePolicy("task", 2),
    created_at: "2026-06-10T00:00:00Z",
    updated_at: "2026-06-10T00:00:00Z",
    created_by: "roger",
    updated_by: "roger",
    failure_reason: null,
    ...overrides,
  };
}

describe("CREATE", () => {
  it("inserts a template into state when RRULE is valid", () => {
    const result = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    });
    expect(result.state.templates.get("phid:rec-001")).toBeDefined();
    expect(result.changedTemplate?.status).toBe("active");
    expect(result.effects).toEqual([]);
  });

  it("pauses the template with invalid_rrule when RRULE doesn't parse", () => {
    const result = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template({ rrule: "FREQ=HOURLY" }), // unsupported FREQ
    });
    expect(result.state.templates.get("phid:rec-001")?.status).toBe("paused");
    expect(result.state.templates.get("phid:rec-001")?.failure_reason).toBe(
      "invalid_rrule",
    );
    expect(result.effects).toContainEqual({
      kind: "template_paused",
      recurrence_phid: "phid:rec-001",
      reason: "invalid_rrule",
    });
  });

  it("rejects a CREATE with a duplicate recurrence_phid", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    expect(() =>
      applyOp(seeded, { type: "CREATE", recurrence: template() }),
    ).toThrow(/already exists/);
  });
});

describe("UPDATE", () => {
  it("patches fields and bumps updated_at", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    const result = applyOp(seeded, {
      type: "UPDATE",
      recurrence_phid: "phid:rec-001",
      patch: { title: "new title", updated_by: "chris" },
      reason: "rename",
    });
    const t = result.state.templates.get("phid:rec-001");
    expect(t?.title).toBe("new title");
    expect(t?.updated_by).toBe("chris");
  });

  it("re-validates RRULE when patched; invalid -> paused", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    const result = applyOp(seeded, {
      type: "UPDATE",
      recurrence_phid: "phid:rec-001",
      patch: { rrule: "FREQ=HOURLY" },
      reason: null,
    });
    expect(result.state.templates.get("phid:rec-001")?.status).toBe("paused");
    expect(result.state.templates.get("phid:rec-001")?.failure_reason).toBe(
      "invalid_rrule",
    );
  });

  it("rejects UPDATE on an unknown recurrence_phid", () => {
    expect(() =>
      applyOp(emptyState(), {
        type: "UPDATE",
        recurrence_phid: "phid:rec-ghost",
        patch: { title: "x" },
        reason: null,
      }),
    ).toThrow(/not found/);
  });
});

describe("CANCEL", () => {
  it("marks the template cancelled with the operator reason", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    const result = applyOp(seeded, {
      type: "CANCEL",
      recurrence_phid: "phid:rec-001",
      effective_at: "2026-06-12T00:00:00Z",
      reason: "operator stopped the series",
    });
    expect(result.state.templates.get("phid:rec-001")?.status).toBe("cancelled");
    expect(result.state.templates.get("phid:rec-001")?.failure_reason).toBe(
      "cancelled_by_operator",
    );
  });
});

describe("MATERIALIZE_INSTANCE", () => {
  it("creates a new instance and links it to the template", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    const result = applyOp(seeded, {
      type: "MATERIALIZE_INSTANCE",
      recurrence_phid: "phid:rec-001",
      instance_phid: "phid:inst-001",
      scheduled_for: "2026-06-11T00:00:00Z",
      materialized_ref: { task_phid: "phid:task-aaa" },
      idempotency_key: "recurrence:phid:rec-001:2026-06-11T00:00:00Z",
    });
    const insts = result.state.instancesByTemplate.get("phid:rec-001") ?? [];
    expect(insts).toHaveLength(1);
    expect(insts[0].status).toBe("materialized");
    expect(insts[0].materialized_ref.task_phid).toBe("phid:task-aaa");
    expect(result.effects).toContainEqual({
      kind: "instance_materialized",
      instance_phid: "phid:inst-001",
    });
  });

  it("is idempotent on idempotency_key — a second call returns the existing instance and emits nothing new", () => {
    let s = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    s = applyOp(s, {
      type: "MATERIALIZE_INSTANCE",
      recurrence_phid: "phid:rec-001",
      instance_phid: "phid:inst-001",
      scheduled_for: "2026-06-11T00:00:00Z",
      materialized_ref: {},
      idempotency_key: "K1",
    }).state;
    const second = applyOp(s, {
      type: "MATERIALIZE_INSTANCE",
      recurrence_phid: "phid:rec-001",
      instance_phid: "phid:inst-002", // different new phid
      scheduled_for: "2026-06-11T00:00:00Z",
      materialized_ref: {},
      idempotency_key: "K1", // same key
    });
    const insts = second.state.instancesByTemplate.get("phid:rec-001") ?? [];
    expect(insts).toHaveLength(1);
    expect(insts[0].instance_phid).toBe("phid:inst-001");
    expect(second.changedInstances).toHaveLength(0);
    expect(second.effects).toHaveLength(0);
  });
});

describe("RECORD_EXCEPTION", () => {
  it("skip — adds the date to exception_dates and emits exception_recorded", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    const result = applyOp(seeded, {
      type: "RECORD_EXCEPTION",
      recurrence_phid: "phid:rec-001",
      exception_date: "2026-06-12",
      exception_kind: "skip",
      reason: "out of office",
    });
    expect(
      result.state.templates.get("phid:rec-001")?.exception_dates,
    ).toContain("2026-06-12");
    expect(result.effects).toContainEqual({
      kind: "exception_recorded",
      recurrence_phid: "phid:rec-001",
      exception_kind: "skip",
      exception_date: "2026-06-12",
    });
  });

  it("snooze — adds the date to exception_dates AND creates a replacement instance", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    const result = applyOp(seeded, {
      type: "RECORD_EXCEPTION",
      recurrence_phid: "phid:rec-001",
      exception_date: "2026-06-12",
      exception_kind: "snooze",
      reason: "operator deferred",
      replacement_scheduled_for: "2026-06-13T12:00:00Z",
    });
    const t = result.state.templates.get("phid:rec-001");
    expect(t?.exception_dates).toContain("2026-06-12");
    const insts = result.state.instancesByTemplate.get("phid:rec-001") ?? [];
    expect(insts).toHaveLength(1);
    expect(insts[0].scheduled_for).toBe("2026-06-13T12:00:00Z");
    expect(insts[0].source_exception_kind).toBe("snooze");
  });

  it("snooze without replacement_scheduled_for is rejected", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    expect(() =>
      applyOp(seeded, {
        type: "RECORD_EXCEPTION",
        recurrence_phid: "phid:rec-001",
        exception_date: "2026-06-12",
        exception_kind: "snooze",
        reason: "missing replacement",
      }),
    ).toThrow(/replacement_scheduled_for required/);
  });

  it("manual_fire — creates an early instance linked to the source exception", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template({
        materialize_policy: { ...defaultMaterializePolicy("report", 7), allow_early_fire: true },
        kind: "report",
      }),
    }).state;
    const result = applyOp(seeded, {
      type: "RECORD_EXCEPTION",
      recurrence_phid: "phid:rec-001",
      exception_date: "2026-06-10",
      exception_kind: "manual_fire",
      reason: "operator clicked run-now",
      replacement_scheduled_for: "2026-06-10T15:00:00Z",
    });
    const insts = result.state.instancesByTemplate.get("phid:rec-001") ?? [];
    expect(insts[0].scheduled_for).toBe("2026-06-10T15:00:00Z");
    expect(insts[0].source_exception_kind).toBe("manual_fire");
  });

  it("manual_fire rejects when allow_early_fire is false on the template", () => {
    const seeded = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(), // default task policy has allow_early_fire:false
    }).state;
    expect(() =>
      applyOp(seeded, {
        type: "RECORD_EXCEPTION",
        recurrence_phid: "phid:rec-001",
        exception_date: "2026-06-10",
        exception_kind: "manual_fire",
        reason: "x",
        replacement_scheduled_for: "2026-06-10T15:00:00Z",
      }),
    ).toThrow(/allow_early_fire/);
  });

  it("cancel_instance — cancels a previously-materialized instance", () => {
    let s = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template(),
    }).state;
    s = applyOp(s, {
      type: "MATERIALIZE_INSTANCE",
      recurrence_phid: "phid:rec-001",
      instance_phid: "phid:inst-001",
      scheduled_for: "2026-06-11T00:00:00Z",
      materialized_ref: {},
      idempotency_key: "K1",
    }).state;
    const result = applyOp(s, {
      type: "RECORD_EXCEPTION",
      recurrence_phid: "phid:rec-001",
      exception_date: "2026-06-11",
      exception_kind: "cancel_instance",
      reason: "operator cancelled this one fire",
    });
    const insts = result.state.instancesByTemplate.get("phid:rec-001") ?? [];
    expect(insts).toHaveLength(1);
    expect(insts[0].status).toBe("cancelled");
    expect(result.effects).toContainEqual({
      kind: "instance_cancelled",
      instance_phid: "phid:inst-001",
    });
  });
});
