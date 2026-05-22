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
  | "cancelled"
  // Spec 054 v2: agent intentionally paused on a clarification question.
  // Non-terminal. Releases the active scheduler slot. Resumed via
  // POST /agent-resume which moves the dispatch back to "queued".
  | "needs_clarification"
  // Spec 054 v2: /agent-resume answered the question but the resume
  // payload could not be delivered to the target agent. Non-terminal
  // but blocked; should NOT re-enter normal queue claiming until
  // operator intervention.
  | "resume_delivery_failed";

// Spec 054 v2 ─ clarification events appended to clarification_history.
export type ClarificationEventType =
  | "NEEDS_CLARIFICATION"
  | "RESUME"
  | "RESUME_DELIVERED"
  | "RESUME_DELIVERY_FAILED"
  | "CLARIFICATION_STALE";

export interface ClarificationEvent {
  type: ClarificationEventType;
  clarification_id: string;
  ts: string;
  // For NEEDS_CLARIFICATION:
  agent_id?: string;
  query_id?: string | null;
  question?: string;
  context?: unknown;
  urgency?: "normal" | "time_sensitive";
  stale_at?: string;
  // For RESUME:
  actor?: string;
  answer?: string;
  instructions?: string[] | string | null;
  // For RESUME_DELIVERED:
  transport?: "session_injection" | "talk_followup" | string;
  delivered_at?: string;
  agent_query_id?: string | null;
  // For RESUME_DELIVERY_FAILED:
  failure_detail?: string;
  // For CLARIFICATION_STALE:
  age_seconds?: number;
  surfaced_at?: string;
}

// Active clarification blocker (one per dispatch at a time; serialized
// into active_clarification_json on the queue row).
export interface ClarificationBlocker {
  clarification_id: string;
  agent_id: string;
  query_id: string | null;
  question: string;
  context: unknown;
  urgency: "normal" | "time_sensitive";
  created_at: string;
  stale_at: string;
}

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
  // Spec 054 v2 ─ clarification fields. All additive; absent on legacy
  // rows. clarification_id is the currently-active blocker's id (null
  // when no clarification is open). active_clarification carries the
  // full blocker payload for read surfaces. clarification_history is
  // the append-only log of every NEEDS_CLARIFICATION / RESUME / etc.
  clarification_id: string | null;
  active_clarification: ClarificationBlocker | null;
  clarification_history: ClarificationEvent[];
  resume_delivery_status: "none" | "pending" | "delivered" | "failed";
  // Spec 054 v2 ─ promotion metadata. Build dispatches default to
  // promote=true; non-build dispatches typically false. promotion_result
  // captures the canonical post-promotion record from /agent-done.
  promote: boolean;
  promotion_strategy:
    | "auto"
    | "fast_forward"
    | "merge_commit"
    | "squash"
    | "follow_up_dispatch";
  promotion_required_reason: string | null;
  promotion_result: unknown | null;
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
  // Spec 054 v2 ─ promotion metadata at enqueue time. promote defaults
  // to true for build dispatches (those that include repo metadata) and
  // false otherwise. Detection lives at the call site of enqueue().
  promote?: boolean;
  promotion_strategy?: DispatchDoc["promotion_strategy"];
  promotion_required_reason?: string | null;
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
  /**
   * If set, the claim layer will not move more docs to in_flight than
   * needed to reach this cap (counting docs already in_flight under the
   * same provider/runtime filter). This is what enforces single-writer
   * concurrency across multiple scheduler instances.
   */
  max_in_flight?: number;
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

// Spec 054 v2: statuses that are non-terminal but should NOT be eligible
// for normal queue claiming. Both block the dispatch until operator
// intervention (resume or cancel).
export const BLOCKED_NON_CLAIMABLE: ReadonlySet<SchedulerStatus> = new Set<SchedulerStatus>([
  "needs_clarification",
  "resume_delivery_failed",
]);

export function isBlocked(s: SchedulerStatus): boolean {
  return BLOCKED_NON_CLAIMABLE.has(s);
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function degraded(reason: DegradedReason, detail: string): Degraded {
  return { ok: false, reason, detail };
}

// Spec 054 v2 ─ default values for the additive clarification + promotion
// fields. Used by enqueue paths so all writers produce a fully-shaped
// DispatchDoc without sprinkling literals.
export interface ClarificationDefaults {
  clarification_id: null;
  active_clarification: null;
  clarification_history: ClarificationEvent[];
  resume_delivery_status: "none";
}
export function defaultClarificationFields(): ClarificationDefaults {
  return {
    clarification_id: null,
    active_clarification: null,
    clarification_history: [],
    resume_delivery_status: "none",
  };
}

export interface PromotionDefaults {
  promote: boolean;
  promotion_strategy: DispatchDoc["promotion_strategy"];
  promotion_required_reason: string | null;
  promotion_result: null;
}
export function defaultPromotionFields(input: {
  promote?: boolean;
  promotion_strategy?: DispatchDoc["promotion_strategy"];
  promotion_required_reason?: string | null;
}): PromotionDefaults {
  return {
    promote: input.promote ?? true,
    promotion_strategy: input.promotion_strategy ?? "auto",
    promotion_required_reason: input.promotion_required_reason ?? null,
    promotion_result: null,
  };
}
