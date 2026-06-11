// Materialization planning tests.
//
// CTO scope §"Materialization Service Contract" + §"Failure Mode".
//
// The materialization service is a pure planner: given (state, now,
// gating), it returns the list of MATERIALIZE_INSTANCE ops to apply.
// Idempotency is enforced by the reducer; gating-blocked instances
// are planned with a typed reason (NOT marked delivered).

import { describe, expect, it } from "vitest";

import {
  planMaterializations,
  computeIdempotencyKey,
  type MaterializeNow,
} from "../../src/recurrences/materialization.js";
import { applyOp } from "../../src/recurrences/reducer.js";
import {
  ALWAYS_ALLOW_GATING,
  defaultMaterializePolicy,
  emptyState,
  type GatingProbe,
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

const now: MaterializeNow = "2026-06-11T00:00:00Z";

describe("planMaterializations", () => {
  it("emits one MATERIALIZE_INSTANCE per due RRULE fire in the horizon", async () => {
    const state = applyOp(emptyState(), { type: "CREATE", recurrence: template() }).state;
    const ops = await planMaterializations({ state, now, gating: ALWAYS_ALLOW_GATING });
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.type).toBe("MATERIALIZE_INSTANCE");
    }
  });

  it("respects the template's horizon_days (daily=2 -> at most 2 instances)", async () => {
    const state = applyOp(emptyState(), { type: "CREATE", recurrence: template() }).state;
    const ops = await planMaterializations({ state, now, gating: ALWAYS_ALLOW_GATING });
    expect(ops.length).toBeLessThanOrEqual(2);
  });

  it("does NOT re-create instances that already exist (idempotency)", async () => {
    let s = applyOp(emptyState(), { type: "CREATE", recurrence: template() }).state;
    const ops1 = await planMaterializations({ state: s, now, gating: ALWAYS_ALLOW_GATING });
    for (const op of ops1) s = applyOp(s, op).state;
    const ops2 = await planMaterializations({ state: s, now, gating: ALWAYS_ALLOW_GATING });
    expect(ops2).toEqual([]);
  });

  it("skips templates whose status is paused or cancelled", async () => {
    const state = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template({ status: "paused" }),
    }).state;
    const ops = await planMaterializations({ state, now, gating: ALWAYS_ALLOW_GATING });
    expect(ops).toEqual([]);
  });

  it("honors exception_dates from the template", async () => {
    const state = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template({ exception_dates: ["2026-06-11"] }),
    }).state;
    const ops = await planMaterializations({ state, now, gating: ALWAYS_ALLOW_GATING });
    for (const op of ops) {
      if (op.type === "MATERIALIZE_INSTANCE") {
        expect(op.scheduled_for.startsWith("2026-06-11")).toBe(false);
      }
    }
  });

  it("when OP-7 gating denies dispatch, ops carry gating_reason and the reducer creates `planned` instances (NOT marked delivered)", async () => {
    const state = applyOp(emptyState(), { type: "CREATE", recurrence: template() }).state;
    const denyAll: GatingProbe = {
      check: () => ({
        allowed: false,
        reason: "dispatch_blocked:usage_budget_exceeded",
      }),
    };
    const ops = await planMaterializations({ state, now, gating: denyAll });
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      if (op.type === "MATERIALIZE_INSTANCE") {
        expect(op.gating_reason).toBe(
          "dispatch_blocked:usage_budget_exceeded",
        );
      }
    }
    // Apply and check the resulting instance is planned + carries the reason.
    let s = state;
    for (const op of ops) s = applyOp(s, op).state;
    const insts = s.instancesByTemplate.get("phid:rec-001") ?? [];
    for (const inst of insts) {
      expect(inst.status).toBe("planned");
      expect(inst.failure_reason).toBe(
        "dispatch_blocked:usage_budget_exceeded",
      );
      expect(inst.materialized_at).toBe(null);
    }
  });

  it("uses default horizon when materialize_policy.horizon_days is unset", async () => {
    // Weekly template; default horizon for weekly is 7.
    const state = applyOp(emptyState(), {
      type: "CREATE",
      recurrence: template({
        rrule: "FREQ=WEEKLY;BYDAY=SU",
        starts_on: "2026-06-14",
        materialize_policy: { ...defaultMaterializePolicy("report", 7), horizon_days: 0 },
      }),
    }).state;
    // now: 2026-06-13 (day before the Sunday fire)
    const ops = await planMaterializations({
      state,
      now: "2026-06-13T00:00:00Z",
      gating: ALWAYS_ALLOW_GATING,
    });
    // Should plan exactly one fire: Sunday 06-14.
    expect(ops.length).toBe(1);
    if (ops[0].type === "MATERIALIZE_INSTANCE") {
      expect(ops[0].scheduled_for).toBe("2026-06-14T00:00:00Z");
    }
  });
});

describe("computeIdempotencyKey", () => {
  it("is stable on (recurrence_phid, scheduled_for)", () => {
    expect(
      computeIdempotencyKey("phid:rec-001", "2026-06-11T00:00:00Z"),
    ).toBe(computeIdempotencyKey("phid:rec-001", "2026-06-11T00:00:00Z"));
  });

  it("differs across recurrences or schedules", () => {
    const a = computeIdempotencyKey("phid:rec-001", "2026-06-11T00:00:00Z");
    const b = computeIdempotencyKey("phid:rec-001", "2026-06-12T00:00:00Z");
    const c = computeIdempotencyKey("phid:rec-002", "2026-06-11T00:00:00Z");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("follows the spec format: recurrence:{recurrence_phid}:{scheduled_for}", () => {
    expect(
      computeIdempotencyKey("phid:rec-001", "2026-06-11T00:00:00Z"),
    ).toBe("recurrence:phid:rec-001:2026-06-11T00:00:00Z");
  });
});
