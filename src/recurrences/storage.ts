// RecurrenceTemplate + RecurrenceInstance storage layer.
//
// Two tables — `recurrence_templates` and `recurrence_instances` —
// mirroring the document-model + operations-log split used by the
// dispatch reactor and decisions queue. Identifiers are stable
// PHIDs (RD-001); display_id is read-only metadata.
//
// Idempotency is enforced at the storage layer via UNIQUE
// (recurrence_phid, idempotency_key) on instances, as the spec
// requires (`MATERIALIZE_INSTANCE` is idempotent on the key).

import type { DbAdapter } from "../db/db-adapter.js";
import type {
  ExceptionKind,
  RecurrenceException,
  RecurrenceInstance,
  RecurrenceInstanceFailureReason,
  RecurrenceInstanceMaterializedRef,
  RecurrenceInstanceStatus,
  RecurrenceTemplate,
  RecurrenceTemplateFailureReason,
  RecurrenceTemplateKind,
  RecurrenceTemplateStatus,
} from "./types.js";

export async function migrateRecurrenceTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS recurrence_templates (
      recurrence_phid               TEXT PRIMARY KEY,
      display_id                    TEXT,
      kind                          TEXT NOT NULL CHECK (kind IN ('task','calendar_event','schedule_prompt','report')),
      status                        TEXT NOT NULL CHECK (status IN ('active','paused','cancelled')),
      title                         TEXT NOT NULL,
      description                   TEXT,
      timezone                      TEXT NOT NULL,
      rrule                         TEXT NOT NULL,
      starts_on                     TEXT NOT NULL,
      ends_on                       TEXT,
      exception_dates_json          TEXT NOT NULL,
      source_ref                    TEXT,
      owner_agent                   TEXT,
      project_phid                  TEXT,
      template_task_phid            TEXT,
      template_event_phid           TEXT,
      template_schedule_prompt_phid TEXT,
      template_artifact_kind        TEXT,
      required_inputs_json          TEXT NOT NULL,
      delivery_targets_json         TEXT NOT NULL,
      predecessor_link              TEXT NOT NULL CHECK (predecessor_link IN ('previous_instance','first_in_series','none')),
      materialize_policy_json       TEXT NOT NULL,
      created_at                    TEXT NOT NULL,
      updated_at                    TEXT NOT NULL,
      created_by                    TEXT NOT NULL,
      updated_by                    TEXT NOT NULL,
      failure_reason                TEXT
    )
    `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS recurrence_templates_status_kind_idx ON recurrence_templates(status, kind)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS recurrence_templates_owner_idx ON recurrence_templates(owner_agent, status)`,
    [],
  );

  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS recurrence_instances (
      instance_phid                 TEXT PRIMARY KEY,
      recurrence_phid               TEXT NOT NULL,
      scheduled_for                 TEXT NOT NULL,
      timezone                      TEXT NOT NULL,
      status                        TEXT NOT NULL CHECK (status IN ('planned','materialized','dispatched','completed','skipped','cancelled','failed')),
      materialized_ref_json         TEXT NOT NULL,
      predecessor_instance_phid     TEXT,
      idempotency_key               TEXT NOT NULL,
      materialized_at               TEXT,
      completed_at                  TEXT,
      failure_reason                TEXT,
      source_exception_kind         TEXT,
      source_exception_reason       TEXT
    )
    `,
    [],
  );
  await adapter.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS recurrence_instances_idem_idx ON recurrence_instances(recurrence_phid, idempotency_key)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS recurrence_instances_template_status_idx ON recurrence_instances(recurrence_phid, status)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS recurrence_instances_scheduled_idx ON recurrence_instances(scheduled_for, status)`,
    [],
  );

  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS recurrence_exceptions (
      recurrence_phid             TEXT NOT NULL,
      exception_date              TEXT NOT NULL,
      exception_kind              TEXT NOT NULL CHECK (exception_kind IN ('skip','snooze','manual_fire','cancel_instance')),
      reason                      TEXT NOT NULL,
      replacement_scheduled_for   TEXT,
      recorded_at                 TEXT NOT NULL,
      PRIMARY KEY (recurrence_phid, exception_date, exception_kind)
    )
    `,
    [],
  );
}

// ---------------------------------------------------------------------------
// Template CRUD
// ---------------------------------------------------------------------------

export async function upsertTemplate(
  adapter: DbAdapter,
  template: RecurrenceTemplate,
): Promise<void> {
  await adapter.query(
    `INSERT INTO recurrence_templates (
       recurrence_phid, display_id, kind, status, title, description,
       timezone, rrule, starts_on, ends_on, exception_dates_json,
       source_ref, owner_agent, project_phid,
       template_task_phid, template_event_phid, template_schedule_prompt_phid,
       template_artifact_kind, required_inputs_json, delivery_targets_json,
       predecessor_link, materialize_policy_json,
       created_at, updated_at, created_by, updated_by, failure_reason
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(recurrence_phid) DO UPDATE SET
       display_id                    = excluded.display_id,
       kind                          = excluded.kind,
       status                        = excluded.status,
       title                         = excluded.title,
       description                   = excluded.description,
       timezone                      = excluded.timezone,
       rrule                         = excluded.rrule,
       starts_on                     = excluded.starts_on,
       ends_on                       = excluded.ends_on,
       exception_dates_json          = excluded.exception_dates_json,
       source_ref                    = excluded.source_ref,
       owner_agent                   = excluded.owner_agent,
       project_phid                  = excluded.project_phid,
       template_task_phid            = excluded.template_task_phid,
       template_event_phid           = excluded.template_event_phid,
       template_schedule_prompt_phid = excluded.template_schedule_prompt_phid,
       template_artifact_kind        = excluded.template_artifact_kind,
       required_inputs_json          = excluded.required_inputs_json,
       delivery_targets_json         = excluded.delivery_targets_json,
       predecessor_link              = excluded.predecessor_link,
       materialize_policy_json       = excluded.materialize_policy_json,
       updated_at                    = excluded.updated_at,
       updated_by                    = excluded.updated_by,
       failure_reason                = excluded.failure_reason`,
    [
      template.recurrence_phid,
      template.display_id,
      template.kind,
      template.status,
      template.title,
      template.description,
      template.timezone,
      template.rrule,
      template.starts_on,
      template.ends_on,
      JSON.stringify(template.exception_dates),
      template.source_ref,
      template.owner_agent,
      template.project_phid,
      template.template_task_phid,
      template.template_event_phid,
      template.template_schedule_prompt_phid,
      template.template_artifact_kind,
      JSON.stringify(template.required_inputs),
      JSON.stringify(template.delivery_targets),
      template.predecessor_link,
      JSON.stringify(template.materialize_policy),
      template.created_at,
      template.updated_at,
      template.created_by,
      template.updated_by,
      template.failure_reason,
    ],
  );
}

interface TemplateRow {
  recurrence_phid: string;
  display_id: string | null;
  kind: RecurrenceTemplateKind;
  status: RecurrenceTemplateStatus;
  title: string;
  description: string | null;
  timezone: string;
  rrule: string;
  starts_on: string;
  ends_on: string | null;
  exception_dates_json: string;
  source_ref: string | null;
  owner_agent: string | null;
  project_phid: string | null;
  template_task_phid: string | null;
  template_event_phid: string | null;
  template_schedule_prompt_phid: string | null;
  template_artifact_kind: string | null;
  required_inputs_json: string;
  delivery_targets_json: string;
  predecessor_link: RecurrenceTemplate["predecessor_link"];
  materialize_policy_json: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  failure_reason: RecurrenceTemplateFailureReason | null;
}

function rowToTemplate(row: TemplateRow): RecurrenceTemplate {
  return {
    recurrence_phid: row.recurrence_phid,
    display_id: row.display_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    description: row.description,
    timezone: row.timezone,
    rrule: row.rrule,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    exception_dates: JSON.parse(row.exception_dates_json),
    source_ref: row.source_ref,
    owner_agent: row.owner_agent,
    project_phid: row.project_phid,
    template_task_phid: row.template_task_phid,
    template_event_phid: row.template_event_phid,
    template_schedule_prompt_phid: row.template_schedule_prompt_phid,
    template_artifact_kind: row.template_artifact_kind,
    required_inputs: JSON.parse(row.required_inputs_json),
    delivery_targets: JSON.parse(row.delivery_targets_json),
    predecessor_link: row.predecessor_link,
    materialize_policy: JSON.parse(row.materialize_policy_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    failure_reason: row.failure_reason,
  };
}

export async function getTemplate(
  adapter: DbAdapter,
  recurrencePhid: string,
): Promise<RecurrenceTemplate | null> {
  const { rows } = await adapter.query<TemplateRow>(
    `SELECT * FROM recurrence_templates WHERE recurrence_phid = ?`,
    [recurrencePhid],
  );
  return rows[0] ? rowToTemplate(rows[0]) : null;
}

export interface ListTemplatesFilter {
  kind?: RecurrenceTemplateKind;
  owner_agent?: string;
  project_phid?: string;
  status?: RecurrenceTemplateStatus;
}

export async function listTemplates(
  adapter: DbAdapter,
  filter: ListTemplatesFilter = {},
): Promise<RecurrenceTemplate[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.owner_agent) {
    clauses.push("owner_agent = ?");
    params.push(filter.owner_agent);
  }
  if (filter.project_phid) {
    clauses.push("project_phid = ?");
    params.push(filter.project_phid);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await adapter.query<TemplateRow>(
    `SELECT * FROM recurrence_templates ${where} ORDER BY created_at DESC`,
    params,
  );
  return rows.map(rowToTemplate);
}

// ---------------------------------------------------------------------------
// Instance CRUD
// ---------------------------------------------------------------------------

interface InstanceRow {
  instance_phid: string;
  recurrence_phid: string;
  scheduled_for: string;
  timezone: string;
  status: RecurrenceInstanceStatus;
  materialized_ref_json: string;
  predecessor_instance_phid: string | null;
  idempotency_key: string;
  materialized_at: string | null;
  completed_at: string | null;
  failure_reason: RecurrenceInstanceFailureReason | null;
  source_exception_kind: ExceptionKind | null;
  source_exception_reason: string | null;
}

function rowToInstance(row: InstanceRow): RecurrenceInstance {
  return {
    instance_phid: row.instance_phid,
    recurrence_phid: row.recurrence_phid,
    scheduled_for: row.scheduled_for,
    timezone: row.timezone,
    status: row.status,
    materialized_ref: JSON.parse(
      row.materialized_ref_json,
    ) as RecurrenceInstanceMaterializedRef,
    predecessor_instance_phid: row.predecessor_instance_phid,
    idempotency_key: row.idempotency_key,
    materialized_at: row.materialized_at,
    completed_at: row.completed_at,
    failure_reason: row.failure_reason,
    source_exception_kind: row.source_exception_kind,
    source_exception_reason: row.source_exception_reason,
  };
}

export async function upsertInstance(
  adapter: DbAdapter,
  instance: RecurrenceInstance,
): Promise<void> {
  await adapter.query(
    `INSERT INTO recurrence_instances (
       instance_phid, recurrence_phid, scheduled_for, timezone, status,
       materialized_ref_json, predecessor_instance_phid, idempotency_key,
       materialized_at, completed_at, failure_reason,
       source_exception_kind, source_exception_reason
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(instance_phid) DO UPDATE SET
       status                = excluded.status,
       materialized_ref_json = excluded.materialized_ref_json,
       materialized_at       = excluded.materialized_at,
       completed_at          = excluded.completed_at,
       failure_reason        = excluded.failure_reason`,
    [
      instance.instance_phid,
      instance.recurrence_phid,
      instance.scheduled_for,
      instance.timezone,
      instance.status,
      JSON.stringify(instance.materialized_ref),
      instance.predecessor_instance_phid,
      instance.idempotency_key,
      instance.materialized_at,
      instance.completed_at,
      instance.failure_reason,
      instance.source_exception_kind,
      instance.source_exception_reason,
    ],
  );
}

export async function listInstancesForTemplate(
  adapter: DbAdapter,
  recurrencePhid: string,
  limit = 50,
): Promise<RecurrenceInstance[]> {
  const { rows } = await adapter.query<InstanceRow>(
    `SELECT * FROM recurrence_instances
       WHERE recurrence_phid = ?
       ORDER BY scheduled_for DESC
       LIMIT ?`,
    [recurrencePhid, limit],
  );
  return rows.map(rowToInstance);
}

export async function listInstancesInWindow(
  adapter: DbAdapter,
  startsAtInclusive: string,
  endsAtExclusive: string,
): Promise<RecurrenceInstance[]> {
  const { rows } = await adapter.query<InstanceRow>(
    `SELECT * FROM recurrence_instances
       WHERE scheduled_for >= ? AND scheduled_for < ?
       ORDER BY scheduled_for ASC`,
    [startsAtInclusive, endsAtExclusive],
  );
  return rows.map(rowToInstance);
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export interface ExceptionRow {
  recurrence_phid: string;
  exception_date: string;
  exception_kind: ExceptionKind;
  reason: string;
  replacement_scheduled_for: string | null;
  recorded_at: string;
}

export async function recordException(
  adapter: DbAdapter,
  row: ExceptionRow,
): Promise<void> {
  await adapter.query(
    `INSERT OR REPLACE INTO recurrence_exceptions
       (recurrence_phid, exception_date, exception_kind, reason,
        replacement_scheduled_for, recorded_at)
     VALUES (?,?,?,?,?,?)`,
    [
      row.recurrence_phid,
      row.exception_date,
      row.exception_kind,
      row.reason,
      row.replacement_scheduled_for,
      row.recorded_at,
    ],
  );
}

export async function listExceptions(
  adapter: DbAdapter,
  recurrencePhid: string,
): Promise<RecurrenceException[]> {
  const { rows } = await adapter.query<ExceptionRow>(
    `SELECT * FROM recurrence_exceptions
       WHERE recurrence_phid = ?
       ORDER BY exception_date DESC`,
    [recurrencePhid],
  );
  return rows.map((r) => ({
    recurrence_phid: r.recurrence_phid,
    exception_date: r.exception_date,
    exception_kind: r.exception_kind,
    reason: r.reason,
    replacement_scheduled_for: r.replacement_scheduled_for,
    recorded_at: r.recorded_at,
  }));
}
