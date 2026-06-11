// RecurrenceTemplate substrate — types.
//
// CTO scope: cto/output/2026-06-10-recurrence-template-architecture-scope.md
// Build brief: agent-platform/output/2026-06-11-recurrence-template-build-dispatch-brief.md
//
// Identifiers are stable PHIDs per RD-001. Display IDs may appear in
// read DTOs but are NEVER operation targets.

// ---------------------------------------------------------------------------
// Template kinds + status enums
// ---------------------------------------------------------------------------

export type RecurrenceTemplateKind =
  | "task"
  | "calendar_event"
  | "schedule_prompt"
  | "report";

export type RecurrenceTemplateStatus = "active" | "paused" | "cancelled";

export type RecurrencePredecessorLink =
  | "previous_instance"
  | "first_in_series"
  | "none";

export interface MaterializePolicy {
  // Server-side expansion window in days. Defaults are kind-aware
  // (see `defaultHorizonForRrule` in `./rrule.ts`); reports may
  // override with their own value here.
  horizon_days: number;
  // When true, RECORD_EXCEPTION with kind=manual_fire can create an
  // instance whose `scheduled_for` is earlier than the next RRULE
  // fire. Useful for ad-hoc "run this report now" buttons.
  allow_early_fire: boolean;
  // When true, materialization stops at `planned` and waits for an
  // explicit operator action before flipping to `materialized`.
  requires_operator_confirmation: boolean;
}

export interface RecurrenceTemplate {
  recurrence_phid: string;
  display_id: string | null;

  kind: RecurrenceTemplateKind;
  status: RecurrenceTemplateStatus;

  title: string;
  description: string | null;

  timezone: string; // default: America/Chicago
  rrule: string; // RFC 5545 RRULE string (FREQ + INTERVAL + BYDAY + UNTIL/COUNT subset for v0)
  starts_on: string; // ISO date or datetime
  ends_on: string | null; // ISO date/datetime, null for open-ended
  exception_dates: string[]; // local dates skipped for this recurrence (YYYY-MM-DD)

  source_ref: string | null;
  owner_agent: string | null;
  project_phid: string | null;

  template_task_phid: string | null;
  template_event_phid: string | null;
  template_schedule_prompt_phid: string | null;

  template_artifact_kind: string | null;
  required_inputs: string[];
  delivery_targets: string[];
  predecessor_link: RecurrencePredecessorLink;

  materialize_policy: MaterializePolicy;

  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;

  // Set by the reducer when CANCEL or invalid_rrule paused the template.
  failure_reason: RecurrenceTemplateFailureReason | null;
}

export type RecurrenceTemplateFailureReason =
  | "invalid_rrule"
  | "cancelled_by_operator";

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export type RecurrenceInstanceStatus =
  | "planned"
  | "materialized"
  | "dispatched"
  | "completed"
  | "skipped"
  | "cancelled"
  | "failed";

export interface RecurrenceInstanceMaterializedRef {
  task_phid?: string;
  event_phid?: string;
  dispatch_id?: string;
  artifact_phid?: string;
}

export type RecurrenceInstanceFailureReason =
  | "missing_template_ref"
  | "dispatch_blocked:usage_budget_exceeded"
  | "queued_for_capacity"
  | "downstream_dispatch_failed"
  | "rrule_no_longer_matches";

export interface RecurrenceInstance {
  instance_phid: string;
  recurrence_phid: string;
  scheduled_for: string; // ISO datetime
  timezone: string;
  status: RecurrenceInstanceStatus;

  materialized_ref: RecurrenceInstanceMaterializedRef;

  predecessor_instance_phid: string | null;
  idempotency_key: string;

  materialized_at: string | null;
  completed_at: string | null;
  failure_reason: RecurrenceInstanceFailureReason | null;

  // Exception bookkeeping — populated when an instance was created
  // via RECORD_EXCEPTION with manual_fire / snooze.
  source_exception_kind: ExceptionKind | null;
  source_exception_reason: string | null;
}

// ---------------------------------------------------------------------------
// Operations — the typed vocabulary
// ---------------------------------------------------------------------------

export type ExceptionKind =
  | "skip"
  | "snooze"
  | "manual_fire"
  | "cancel_instance";

export type RecurrenceOp =
  | { type: "CREATE"; recurrence: RecurrenceTemplate }
  | {
      type: "UPDATE";
      recurrence_phid: string;
      patch: Partial<RecurrenceTemplate>;
      reason: string | null;
    }
  | {
      type: "CANCEL";
      recurrence_phid: string;
      effective_at: string;
      reason: string;
    }
  | {
      type: "MATERIALIZE_INSTANCE";
      recurrence_phid: string;
      instance_phid: string;
      scheduled_for: string;
      materialized_ref: RecurrenceInstanceMaterializedRef;
      idempotency_key: string;
      // When set, the materialization service determined this fire
      // is OP-7-gated and should land as `planned` + this typed
      // reason — NOT marked delivered. CTO scope §"Failure Mode":
      // "If gated, create or update the instance as planned … do
      // not fake success."
      gating_reason?:
        | "dispatch_blocked:usage_budget_exceeded"
        | "queued_for_capacity";
    }
  | {
      type: "RECORD_EXCEPTION";
      recurrence_phid: string;
      exception_date: string;
      exception_kind: ExceptionKind;
      reason: string;
      // Required for snooze + manual_fire; the replacement instance
      // gets this scheduled_for and a predecessor link to the original.
      replacement_scheduled_for?: string;
    };

// ---------------------------------------------------------------------------
// Reducer state + result
// ---------------------------------------------------------------------------

export interface RecurrenceState {
  templates: Map<string, RecurrenceTemplate>;
  instancesByTemplate: Map<string, RecurrenceInstance[]>;
}

export interface ApplyOpResult {
  state: RecurrenceState;
  // Newly created or mutated rows the storage layer should persist.
  changedTemplate: RecurrenceTemplate | null;
  changedInstances: RecurrenceInstance[];
  // Side effects the manager/scheduler should execute (e.g. dispatch
  // a downstream task). Typed so consumers don't have to inspect the
  // op itself.
  effects: ApplyOpEffect[];
}

export type ApplyOpEffect =
  | { kind: "template_paused"; recurrence_phid: string; reason: RecurrenceTemplateFailureReason }
  | { kind: "instance_planned_pending_gating"; instance_phid: string; reason: RecurrenceInstanceFailureReason }
  | { kind: "instance_materialized"; instance_phid: string }
  | { kind: "instance_cancelled"; instance_phid: string }
  | { kind: "instance_skipped"; instance_phid: string }
  | { kind: "exception_recorded"; recurrence_phid: string; exception_kind: ExceptionKind; exception_date: string };

// ---------------------------------------------------------------------------
// Materialization gating — OP-7 stub interface
// ---------------------------------------------------------------------------

export type GatingDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "dispatch_blocked:usage_budget_exceeded"
        | "queued_for_capacity";
    };

// CTO-2 says materialization service must call OP-7 gating BEFORE
// dispatch-producing materializations. OP-7 hasn't shipped yet, so
// v0 uses a stub that always allows; the interface stays so we can
// swap in the real check without touching reducer/materialization
// code paths.
export interface GatingProbe {
  check(template: RecurrenceTemplate): Promise<GatingDecision> | GatingDecision;
}

export const ALWAYS_ALLOW_GATING: GatingProbe = {
  check: () => ({ allowed: true }),
};

// ---------------------------------------------------------------------------
// Read API DTO shape — mirrors OP-1 decisions queue contract
// ---------------------------------------------------------------------------

export type ReadFreshness = "fresh" | "stale" | "missing";
export type ReadSource = "manager_recurrence_table" | "fallback";

export interface ReadProvenance {
  generated_by: "recurrences.read_api.v1";
  query_args: Record<string, unknown>;
}

export interface ListActiveTemplatesResponse {
  schema_version: "recurrences.templates.v1";
  generated_at: string;
  source: ReadSource;
  freshness: ReadFreshness;
  provenance: ReadProvenance;
  filters: {
    kind?: RecurrenceTemplateKind;
    owner_agent?: string;
    project_phid?: string;
    window_days?: number;
  };
  counts: { active: number; paused: number };
  templates: RecurrenceTemplate[];
  warnings: string[];
}

export interface ListInstancesResponse {
  schema_version: "recurrences.instances.v1";
  generated_at: string;
  source: ReadSource;
  freshness: ReadFreshness;
  provenance: ReadProvenance;
  filters: {
    window: "today" | "this_week" | "custom";
    starts_at?: string;
    ends_at?: string;
  };
  counts: Record<RecurrenceInstanceStatus, number>;
  instances: RecurrenceInstance[];
  warnings: string[];
}

export interface FetchTemplateResponse {
  schema_version: "recurrences.template_detail.v1";
  generated_at: string;
  source: ReadSource;
  freshness: ReadFreshness;
  provenance: ReadProvenance;
  template: RecurrenceTemplate;
  recent_instances: RecurrenceInstance[];
  exceptions: RecurrenceException[];
}

export interface RecurrenceException {
  recurrence_phid: string;
  exception_date: string;
  exception_kind: ExceptionKind;
  reason: string;
  replacement_scheduled_for: string | null;
  recorded_at: string;
}

// ---------------------------------------------------------------------------
// Constructors / defaults
// ---------------------------------------------------------------------------

export function emptyState(): RecurrenceState {
  return {
    templates: new Map(),
    instancesByTemplate: new Map(),
  };
}

export function defaultMaterializePolicy(
  kind: RecurrenceTemplateKind,
  horizonDays: number,
): MaterializePolicy {
  return {
    horizon_days: horizonDays,
    allow_early_fire: kind === "report",
    requires_operator_confirmation: false,
  };
}
