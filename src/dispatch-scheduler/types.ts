// Typed contract for the dispatch-scheduler module.
//
// Status values follow the plan's deterministic lifecycle. They are a
// scheduler-visible projection over the Reactor's DispatchStatus enum
// (which already provides QUEUED, IN_FLIGHT, DONE, FAILED, CANCELLED but
// not yet BOUNCED). BOUNCED is added here as an additive scheduler
// status so a provider throttle is a visible bounced attempt with
// backoff metadata, not a silent failure or a stuck IN_FLIGHT.

export type SchedulerStatus =
  | "queued"
  | "in_flight"
  | "done"
  | "failed"
  | "bounced"
  | "cancelled";

export type Provider = "anthropic" | "openai" | "local" | "other";

export type Runtime = "claude-code-cli" | "codex" | "cursor" | "other";

export type FailureKind =
  | "agent_error"
  | "provider_rate_limit_exhausted"
  | "scheduler_wedged"
  | "cancelled"
  | "validation_failed";

export interface BounceRecord {
  ts: string;
  kind: string;
  message: string;
  next_attempt_at: string;
  attempt: number;
}

export interface UsagePolicySnapshot {
  max_safe: number;
  source: string;
  policy_version: string;
}

export interface DispatchDoc {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  from_actor: string;
  channel: string;
  subject: string;
  body_markdown: string;
  provider: Provider;
  runtime: Runtime;
  priority: number;
  status: SchedulerStatus;
  not_before_at: string;
  attempt_count: number;
  bounce_count: number;
  last_bounce: BounceRecord | null;
  bounce_history: BounceRecord[];
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_query_id: string | null;
  usage_policy_snapshot: UsagePolicySnapshot | null;
  failure_kind: FailureKind | null;
  failure_detail: string | null;
}

export interface EnqueueInput {
  query_id: string;
  to_agent: string;
  from_actor: string;
  channel: string;
  subject: string;
  body_markdown: string;
  provider: Provider;
  runtime: Runtime;
  priority?: number;
  not_before_at?: string;
  usage_policy_snapshot?: UsagePolicySnapshot;
}

export interface ConcurrencySnapshot {
  in_flight: number;
  queued: number;
  bounced: number;
  max_safe: number;
  available_slots: number;
  oldest_queued_age_ms: number;
  last_bounce_kind: string | null;
}

export interface QueueEligibleFilter {
  provider?: Provider;
  runtime?: Runtime;
  limit?: number;
  now?: string;
}

export type DegradedReason =
  | "reactor_unavailable"
  | "reactor_error"
  | "not_found"
  | "conflict"
  | "validation_failed";

export interface Degraded {
  ok: false;
  reason: DegradedReason;
  detail: string;
}

export interface Ok<T> {
  ok: true;
  value: T;
}

export type Result<T> = Ok<T> | Degraded;

export const RESERVED_TERMINAL: ReadonlySet<SchedulerStatus> = new Set<SchedulerStatus>([
  "done",
  "failed",
  "cancelled",
]);

export function isTerminal(s: SchedulerStatus): boolean {
  return RESERVED_TERMINAL.has(s);
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function degraded(reason: DegradedReason, detail: string): Degraded {
  return { ok: false, reason, detail };
}
