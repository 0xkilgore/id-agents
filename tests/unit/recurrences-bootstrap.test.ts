// Integration test for the manager-side materialization tick:
// startup state load -> plan -> apply -> persist.
//
// Verifies the contract that an operator's `cane skip`-style edit
// (CTO scope §"Materialization Service Contract") survives across
// ticks AND that a re-tick is idempotent (no duplicate instances).

import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  runMaterializationTickOnce,
} from "../../src/recurrences/bootstrap.js";
import {
  migrateRecurrenceTables,
  upsertTemplate,
  listInstancesForTemplate,
} from "../../src/recurrences/storage.js";
import {
  ALWAYS_ALLOW_GATING,
  defaultMaterializePolicy,
  type RecurrenceTemplate,
} from "../../src/recurrences/types.js";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateRecurrenceTables(adapter);
  return adapter;
}

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

describe("runMaterializationTickOnce", () => {
  it("materializes due fires and persists instances", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    const result = await runMaterializationTickOnce({
      adapter,
      now: "2026-06-11T00:00:00Z",
      gating: ALWAYS_ALLOW_GATING,
    });
    expect(result.templates_considered).toBe(1);
    expect(result.instances_created).toBeGreaterThan(0);
    const insts = await listInstancesForTemplate(adapter, "phid:rec-001");
    expect(insts.length).toBeGreaterThan(0);
    for (const inst of insts) {
      expect(inst.status).toBe("materialized");
    }
  });

  it("is idempotent — a second tick with no schedule advance produces no new instances", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await runMaterializationTickOnce({
      adapter,
      now: "2026-06-11T00:00:00Z",
      gating: ALWAYS_ALLOW_GATING,
    });
    const after1 = await listInstancesForTemplate(adapter, "phid:rec-001");
    const result2 = await runMaterializationTickOnce({
      adapter,
      now: "2026-06-11T00:00:00Z",
      gating: ALWAYS_ALLOW_GATING,
    });
    const after2 = await listInstancesForTemplate(adapter, "phid:rec-001");
    expect(after2.length).toBe(after1.length);
    expect(result2.instances_created).toBe(0);
  });

  it("planned-pending-gating instances are persisted with the typed reason", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    const result = await runMaterializationTickOnce({
      adapter,
      now: "2026-06-11T00:00:00Z",
      gating: {
        check: () => ({
          allowed: false,
          reason: "queued_for_capacity",
        }),
      },
    });
    expect(result.instances_created).toBe(0);
    expect(result.instances_planned_gated).toBeGreaterThan(0);
    const insts = await listInstancesForTemplate(adapter, "phid:rec-001");
    for (const inst of insts) {
      expect(inst.status).toBe("planned");
      expect(inst.failure_reason).toBe("queued_for_capacity");
      expect(inst.materialized_at).toBe(null);
    }
  });

  it("the Sunday weekly product log shadow template materializes ONE instance for 2026-06-14", async () => {
    // Acceptance per CTO scope: at least two existing recurring jobs
    // representable in shadow mode; Sunday weekly product log is the
    // first consumer per dispatch brief.
    const adapter = await setup();
    await upsertTemplate(
      adapter,
      template({
        recurrence_phid: "phid:rec-sunday-weekly-product-log",
        kind: "report",
        title: "Sunday weekly product log",
        timezone: "America/Chicago",
        rrule: "FREQ=WEEKLY;BYDAY=SU",
        starts_on: "2026-06-14",
        owner_agent: "maestra",
        template_artifact_kind: "weekly_product_log",
        required_inputs: ["roadmap.md", "delivery-log.md"],
        delivery_targets: ["agent-platform/output/weekly-product-log"],
        predecessor_link: "previous_instance",
        materialize_policy: { horizon_days: 7, allow_early_fire: false, requires_operator_confirmation: false },
      }),
    );
    // Fri 2026-06-12 12:00 CDT (17:00 UTC).
    const result = await runMaterializationTickOnce({
      adapter,
      now: "2026-06-12T17:00:00Z",
      gating: ALWAYS_ALLOW_GATING,
    });
    expect(result.instances_created).toBe(1);
    const insts = await listInstancesForTemplate(
      adapter,
      "phid:rec-sunday-weekly-product-log",
    );
    expect(insts).toHaveLength(1);
    // Sunday 2026-06-14 00:00 America/Chicago = 05:00 UTC.
    expect(insts[0].scheduled_for).toBe("2026-06-14T05:00:00Z");
  });
});
