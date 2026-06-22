// Loops runtime substrate types (B1, 2026-06-22) — the persisted side of the
// loop registry. registry.ts keeps the read-model DTOs (LoopSummary etc.) that
// GET /loops serves; this module adds the durable records B1 introduces:
//
//   Loop        = durable process identity (definition + schedule binding)
//   LoopRun     = execution envelope + audit/evidence parent
//   LoopTrigger = why a run fired (manual | scheduled | …)
//
// Per cto/output/2026-06-16-loops-runtime-scope.md §3. B1 implements the
// substrate (recurrence link + manual trigger + LoopRun evidence contract);
// the project-load collector runtime + child-dispatch envelope are later slices.

import type { LoopKind } from "./registry.js";

export type { LoopKind } from "./registry.js";

/** Who triggered/created a run. Structurally compatible with the scheduler's
 *  ActorRef; kept local so the loops substrate doesn't depend on the scheduler. */
export interface ActorRef {
  kind: "agent" | "user" | "system" | "service" | "unknown";
  id: string;
  label?: string;
}

/**
 * The schedule binding — how a Loop binds to a cadence. `recurrence_phid`
 * points at a row in `recurrence_templates` (the RRULE truth lives there; this
 * is the "recurrence link"). null = not bound to any schedule (manual-only).
 */
export interface LoopScheduleRef {
  recurrence_phid: string | null;
  timezone: string;
  enabled: boolean;
  dedup_policy: "scheduled_instant" | "manual_idempotency_key";
}

/** Durable Loop definition (persisted projection of the registry seed). */
export interface LoopRecord {
  loop_phid: string;
  schema_version: 1;
  slug: string;
  name: string;
  description: string | null;
  kind: LoopKind;
  owner_agent: string;
  project_phid: string | null;
  enabled: boolean;
  allow_scheduled_run: boolean;
  allow_manual_run: boolean;
  schedule: LoopScheduleRef;
  created_at: string;
  updated_at: string;
}

export type LoopRunStatus =
  | "queued"
  | "admitted"
  | "collecting"
  | "reasoning"
  | "postprocessing"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

/** Active = occupying the per-loop active-run cap. */
export const ACTIVE_LOOP_RUN_STATUSES: readonly LoopRunStatus[] = [
  "queued",
  "admitted",
  "collecting",
  "reasoning",
  "postprocessing",
];

export type LoopTrigger =
  | {
      kind: "manual";
      actor: ActorRef;
      surface: "dashboard" | "cli" | "telegram" | "api";
      idempotency_key: string;
      reason: string | null;
    }
  | {
      kind: "scheduled";
      recurrence_phid: string;
      recurrence_instance_phid: string | null;
      scheduled_for: string;
      dedup_key: string;
    };

/** Loop-run failure taxonomy (cto scope §3.8, B1 subset). */
export type LoopFailureReason =
  | "manual_run_not_allowed"
  | "loop_disabled"
  | "admission_throttled"
  | "input_packet_invalid"
  | "collector_failed"
  | "llm_step_failed"
  | "postprocess_failed"
  | "artifact_missing"
  | "child_dispatch_failed";

/** One evidence step in a run's audit log. The "evidence contract": every
 *  meaningful phase appends a step with status + evidence refs. */
export interface LoopStepLog {
  step_id: string;
  phase: "admission" | "collector" | "llm_step" | "postprocess" | "dispatch_spawn" | "rollup";
  name: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  started_at: string | null;
  finished_at: string | null;
  failure_reason: LoopFailureReason | null;
  detail: string | null;
  evidence_refs: Array<{ kind: string; ref: string }>;
}

export type LoopOutputKind =
  | "markdown_report"
  | "dispatch_bundle"
  | "telegram_message"
  | "structured_json";

export interface LoopOutputRef {
  kind: LoopOutputKind;
  artifact_phid: string | null;
  path: string | null;
  href: string | null;
  dispatch_phids: string[];
  delivery_status: "not_applicable" | "queued" | "sent" | "failed";
  required: boolean;
}

/** The execution envelope + evidence parent. Created at trigger time; the
 *  step_log / output_refs / spawned dispatches accumulate the run's evidence. */
export interface LoopRunRecord {
  loop_run_phid: string;
  loop_phid: string;
  trigger: LoopTrigger;
  status: LoopRunStatus;
  failure_reason: LoopFailureReason | null;
  failure_detail: string | null;
  step_log: LoopStepLog[];
  output_refs: LoopOutputRef[];
  spawned_dispatch_phids: string[];
  idempotency_key: string;
  retry_of_phid: string | null;
  fired_at: string;
  queued_at: string;
  admitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: ActorRef;
  updated_at: string;
}
