// Read API DTO shape tests.

import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  fetchTemplateResponse,
  listActiveTemplatesResponse,
  listInstancesResponse,
} from "../../src/recurrences/read-api.js";
import {
  migrateRecurrenceTables,
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
    idempotency_key: "k1",
    materialized_at: "2026-06-11T00:00:00Z",
    completed_at: null,
    failure_reason: null,
    source_exception_kind: null,
    source_exception_reason: null,
    ...overrides,
  };
}

describe("listActiveTemplatesResponse", () => {
  it("returns the OP-1-shaped DTO with source/freshness/provenance", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertTemplate(
      adapter,
      template({ recurrence_phid: "phid:rec-paused", status: "paused" }),
    );
    const r = await listActiveTemplatesResponse(adapter, {}, "2026-06-11T00:00:00Z");
    expect(r.schema_version).toBe("recurrences.templates.v1");
    expect(r.source).toBe("manager_recurrence_table");
    expect(r.freshness).toBe("fresh");
    expect(r.provenance.generated_by).toBe("recurrences.read_api.v1");
    expect(r.counts).toEqual({ active: 1, paused: 1 });
    expect(r.templates).toHaveLength(2);
  });
});

describe("listInstancesResponse", () => {
  it("returns today's instances when window=today", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance({
      instance_phid: "phid:inst-today",
      scheduled_for: "2026-06-11T15:00:00Z",
      idempotency_key: "today",
    }));
    await upsertInstance(adapter, instance({
      instance_phid: "phid:inst-next-week",
      scheduled_for: "2026-06-20T00:00:00Z",
      idempotency_key: "next-week",
    }));
    const r = await listInstancesResponse(
      adapter,
      { window: "today", timezone: "UTC" },
      "2026-06-11T12:00:00Z",
    );
    expect(r.schema_version).toBe("recurrences.instances.v1");
    expect(r.instances.map((i) => i.instance_phid)).toEqual([
      "phid:inst-today",
    ]);
  });

  it("returns this-week's instances when window=this_week", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance({
      instance_phid: "phid:inst-mid-week",
      scheduled_for: "2026-06-13T00:00:00Z",
      idempotency_key: "mid-week",
    }));
    await upsertInstance(adapter, instance({
      instance_phid: "phid:inst-far",
      scheduled_for: "2026-06-25T00:00:00Z",
      idempotency_key: "far",
    }));
    const r = await listInstancesResponse(
      adapter,
      { window: "this_week", timezone: "UTC" },
      "2026-06-11T00:00:00Z",
    );
    expect(r.instances.map((i) => i.instance_phid)).toEqual([
      "phid:inst-mid-week",
    ]);
  });
});

describe("fetchTemplateResponse", () => {
  it("returns the template + recent instances + exceptions", async () => {
    const adapter = await setup();
    await upsertTemplate(adapter, template());
    await upsertInstance(adapter, instance());
    const r = await fetchTemplateResponse(
      adapter,
      "phid:rec-001",
      "2026-06-11T00:00:00Z",
    );
    expect(r).not.toBeNull();
    expect(r!.template.recurrence_phid).toBe("phid:rec-001");
    expect(r!.recent_instances).toHaveLength(1);
  });

  it("returns null when the template doesn't exist", async () => {
    const adapter = await setup();
    const r = await fetchTemplateResponse(
      adapter,
      "phid:rec-ghost",
      "2026-06-11T00:00:00Z",
    );
    expect(r).toBeNull();
  });
});
