// Sqlite storage tests for RecurrenceTemplate substrate.

import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  getTemplate,
  listExceptions,
  listInstancesForTemplate,
  listInstancesInWindow,
  listTemplates,
  migrateRecurrenceTables,
  recordException,
  upsertInstance,
  upsertTemplate,
} from "../../src/recurrences/storage.js";
import {
  defaultMaterializePolicy,
  type RecurrenceInstance,
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

function instance(
  overrides: Partial<RecurrenceInstance> = {},
): RecurrenceInstance {
  return {
    instance_phid: "phid:inst-001",
    recurrence_phid: "phid:rec-001",
    scheduled_for: "2026-06-11T00:00:00Z",
    timezone: "UTC",
    status: "materialized",
    materialized_ref: {},
    predecessor_instance_phid: null,
    idempotency_key: "recurrence:phid:rec-001:2026-06-11T00:00:00Z",
    materialized_at: "2026-06-11T00:00:00Z",
    completed_at: null,
    failure_reason: null,
    source_exception_kind: null,
    source_exception_reason: null,
    ...overrides,
  };
}

describe("template storage", () => {
  it("round-trips a template", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    const fetched = await getTemplate(adapter, "phid:rec-001");
    expect(fetched?.title).toBe("test");
  });

  it("upsert is idempotent on recurrence_phid (updates in place)", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template({ title: "v1" }));
    await upsertTemplate(adapter, template({ title: "v2" }));
    const list = await listTemplates(adapter, {});
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("v2");
  });

  it("listTemplates filters by kind / owner_agent / status", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template({ recurrence_phid: "phid:rec-a", kind: "task" }));
    await upsertTemplate(adapter, template({ recurrence_phid: "phid:rec-b", kind: "report" }));
    await upsertTemplate(adapter, template({ recurrence_phid: "phid:rec-c", status: "paused" }));
    const tasks = await listTemplates(adapter, { kind: "task" });
    expect(tasks.map((t) => t.recurrence_phid).sort()).toEqual(
      ["phid:rec-a", "phid:rec-c"],
    );
    const active = await listTemplates(adapter, { status: "active" });
    expect(active.every((t) => t.status === "active")).toBe(true);
  });
});

describe("instance storage", () => {
  it("round-trips an instance", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance());
    const list = await listInstancesForTemplate(adapter, "phid:rec-001");
    expect(list).toHaveLength(1);
    expect(list[0].instance_phid).toBe("phid:inst-001");
  });

  it("UNIQUE on (recurrence_phid, idempotency_key) prevents double-materialization at the storage layer", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance());
    // A second insert with the same idempotency_key but a DIFFERENT
    // instance_phid must fail; the reducer's idempotency check is
    // backed up by this DB-level UNIQUE.
    await expect(
      upsertInstance(adapter, instance({ instance_phid: "phid:inst-002" })),
    ).rejects.toThrow();
  });

  it("upsert by instance_phid updates status/materialized_at in place", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance({ status: "planned", materialized_at: null }));
    await upsertInstance(
      adapter,
      instance({
        status: "completed",
        materialized_at: "2026-06-11T00:00:00Z",
        completed_at: "2026-06-11T01:00:00Z",
      }),
    );
    const list = await listInstancesForTemplate(adapter, "phid:rec-001");
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("completed");
    expect(list[0].completed_at).toBe("2026-06-11T01:00:00Z");
  });

  it("listInstancesInWindow returns instances whose scheduled_for is in [start, end)", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance({
      instance_phid: "phid:inst-a",
      scheduled_for: "2026-06-11T00:00:00Z",
      idempotency_key: "k-a",
    }));
    await upsertInstance(adapter, instance({
      instance_phid: "phid:inst-b",
      scheduled_for: "2026-06-15T00:00:00Z",
      idempotency_key: "k-b",
    }));
    const inWindow = await listInstancesInWindow(
      adapter,
      "2026-06-10T00:00:00Z",
      "2026-06-12T00:00:00Z",
    );
    expect(inWindow.map((i) => i.instance_phid)).toEqual(["phid:inst-a"]);
  });
});

describe("exceptions storage", () => {
  it("records and lists exceptions", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await recordException(adapter, {
      recurrence_phid: "phid:rec-001",
      exception_date: "2026-06-12",
      exception_kind: "skip",
      reason: "out of office",
      replacement_scheduled_for: null,
      recorded_at: "2026-06-11T12:00:00Z",
    });
    const exceptions = await listExceptions(adapter, "phid:rec-001");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].exception_kind).toBe("skip");
  });
});
