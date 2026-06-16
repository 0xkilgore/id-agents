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

// W1-1 (runtime-provider-lanes): `cursor` is a distinct provider lane — the
// Cursor CLI runtime is NOT Anthropic and must not share Anthropic's
// concurrency/admission slots.
export type Provider = "anthropic" | "openai" | "cursor" | "local" | "other";

// Runtimes are normalized to their exact harness identifiers. `cursor-cli`
// (not the legacy `cursor`) so it lines up with the HarnessType enum.
export type Runtime =
  | "claude-code-cli"
  | "claude-agent-sdk"
  | "claude-code-local"
  | "codex"
  | "cursor-cli"
  | "public-agent-remote"
  | "other";

/**
 * W1-1 canonical runtime → provider-lane resolver. The provider lane is
 * derived from the runtime so a dispatch lands in the right concurrency /
 * admission lane unless an explicit provider override is supplied at enqueue.
 *
 *   claude-* (cli / sdk / local) → anthropic
 *   codex                        → openai
 *   cursor-cli                   → cursor
 *   public-agent-remote          → other
 *   anything else                → other
 */
export function resolveProviderFromRuntime(runtime: string | undefined | null): Provider {
  const r = normalizeRuntime(runtime);
  switch (r) {
    case "claude-code-cli":
    case "claude-agent-sdk":
    case "claude-code-local":
      return "anthropic";
    case "codex":
      return "openai";
    case "cursor-cli":
      return "cursor";
    case "public-agent-remote":
      return "other";
    default:
      return "other";
  }
}

/**
 * Normalize a runtime string to the canonical Runtime enum. Tolerates the
 * legacy `cursor` alias and unknown values (→ "other"). Pure.
 */
export function normalizeRuntime(raw: string | undefined | null): Runtime {
  const v = (raw ?? "").trim().toLowerCase();
  switch (v) {
    case "claude-code-cli":
      return "claude-code-cli";
    case "claude-agent-sdk":
      return "claude-agent-sdk";
    case "claude-code-local":
      return "claude-code-local";
    case "codex":
      return "codex";
    case "cursor":
    case "cursor-cli":
      return "cursor-cli";
    case "public-agent-remote":
      return "public-agent-remote";
    default:
      return "other";
  }
}

export type FailureKind =
  | "agent_error"
  | "provider_rate_limit_exhausted"
  | "scheduler_wedged"
  | "cancelled"
  | "validation_failed"
  // Harness-resilience (Spec: 2026-05-29-harness-resilience-spec.md):
  // structured terminal failures from the in-process harness retry loop.
  | "model_api_error_exhausted"
  | "harness_empty_result_exhausted"
  | "harness_process_error_exhausted"
  // Dispatch-canonical strict-mode (CTO-4, 2026-06-10): the closeout
  // pipeline classified the agent response body as a known
  // provider/runtime error pattern BEFORE marking delivered. The
  // typed DispatchFailureReason is encoded into `detail` so existing
  // FailureKind consumers don't have to learn 12 new variants; the
  // strict-mode classifier owns the high-resolution reason.
  | "strict_mode_classified"
  // D1 / BUG-003 reason-aware retry policy: typed terminal states for
  // non-retryable failures. failed_auth_required → 401/403, needs re-auth
  // before any further fires; failed_contract_error → 409 dispatch_id_mismatch,
  // a hard dispatcher-contract error. Neither is ever auto-retried.
  | "failed_auth_required"
  | "failed_contract_error";

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
  // Spec 056 ─ first-class artifact path sourced from
  // /agent-done.result.artifact_path. Null until the agent reports an
  // artifact at done-time. Additive; absent on legacy rows.
  artifact_path: string | null;
  // Recovery-state fields. All additive with safe defaults so legacy
  // rows read as a clean "none" recovery posture. recovery_status tracks
  // where a dispatch sits in the crash/landing reconciliation flow;
  // recovery_attempts counts auto-recovery passes; recovery_reason
  // captures the last classification note. side_effect records whether a
  // partial side effect (e.g. a push) already landed. allow_auto_retry
  // gates whether the recovery loop may re-dispatch without an operator.
  recovery_status:
    | "none"
    | "recovering"
    | "landed_reconciled"
    | "needs_operator"
    | "exhausted"
    | "unsafe_side_effect";
  recovery_attempts: number;
  recovery_reason: string | null;
  side_effect: string;
  allow_auto_retry: boolean;
  // Spec 054 v2 Part 2 ─ enqueue-side promotion inputs (repo, branch,
  // base, remote, plus an optional skip-reason). Carried verbatim from
  // EnqueueInput so the agent receives canonical promotion context in
  // its prompt and `/agent-done` can validate that the agent promoted
  // exactly what was requested. Null on non-build dispatches.
  promotion_input: PromotionInput | null;
}

export interface PromotionInput {
  repo: string;
  branch: string;
  base: string;          // default "main"
  remote: string;        // default "origin"
  promotion_skip_reason?: string | null;
}

/** Per-repo result of a successful promotion, returned by the
 *  promote-to-main CLI helper and included on `/agent-done.promotion.repos[]`. */
export interface PromotionRepoResult {
  path: string;
  base: string;
  source_branch: string;
  strategy: "fast_forward" | "merge_commit" | "squash" | "follow_up_dispatch";
  promoted_sha: string;
  remote_main_sha: string;
  pushed: boolean;
  verified: boolean;
}

/** Canonical promotion-completion payload shipped on /agent-done when
 *  the dispatch had `promote: true`. */
export interface PromotionAgentDone {
  required: boolean;
  completed: boolean;
  repos: PromotionRepoResult[];
}

/** Spec 054 v2 Part 2 — validate /agent-done.promotion against the
 *  enqueued doc's `promote`/`promotion_input`. Pure; no side effects.
 *
 *  Modes:
 *    - "warn": missing/incomplete promotion is allowed; returns
 *      `{ ok: true, warning: "..." }` so the caller can log and continue.
 *    - "enforce": missing/incomplete promotion is a hard error; returns
 *      `{ ok: false, error: "..." }` so the caller can 4xx.
 *  Non-build dispatches (`promote: false`) always pass.
 */
export type PromotionEnforcement = "warn" | "enforce";
export type PromotionValidation =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

export function validatePromotionMetadata(
  doc: Pick<DispatchDoc, "promote" | "promotion_input" | "promotion_strategy">,
  promotion: PromotionAgentDone | null | undefined,
  mode: PromotionEnforcement,
): PromotionValidation {
  // Non-build dispatch: no validation required regardless of mode.
  if (!doc.promote) return { ok: true };

  // Build dispatch with no promotion payload at all.
  if (!promotion) {
    const msg = "promote=true but /agent-done is missing promotion metadata";
    return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
  }

  // Build dispatch with promotion.completed !== true.
  if (promotion.completed !== true) {
    const msg = "promote=true but promotion.completed is not true";
    return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
  }

  // Build dispatch but no repos[] entries.
  if (!Array.isArray(promotion.repos) || promotion.repos.length === 0) {
    const msg = "promote=true but promotion.repos[] is empty";
    return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
  }

  // Per-repo shape sanity.
  for (const [i, r] of promotion.repos.entries()) {
    if (!r.path || !r.base || !r.source_branch || !r.promoted_sha || !r.remote_main_sha) {
      const msg = `promotion.repos[${i}] missing required fields (path/base/source_branch/promoted_sha/remote_main_sha)`;
      return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
    }
    if (r.pushed !== true) {
      const msg = `promotion.repos[${i}] reports pushed=false`;
      return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
    }
    if (r.verified !== true) {
      const msg = `promotion.repos[${i}] reports verified=false`;
      return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
    }
  }

  // Optionally cross-check: if doc has promotion_input.repo set, the
  // promotion.repos[] should include that path.
  if (doc.promotion_input?.repo) {
    const expected = doc.promotion_input.repo;
    const found = promotion.repos.some((r) => r.path === expected);
    if (!found) {
      const msg = `promotion.repos[] does not include the enqueued repo "${expected}"`;
      return mode === "enforce" ? { ok: false, error: msg } : { ok: true, warning: msg };
    }
  }

  return { ok: true };
}

/** Parse the SPEC054_PROMOTION_ENFORCEMENT env var. Default `warn`. */
export function parsePromotionEnforcement(raw: string | undefined): PromotionEnforcement {
  const v = (raw ?? "warn").trim().toLowerCase();
  return v === "enforce" ? "enforce" : "warn";
}

/** Spec 054 v2 Part 2 (review-fix 2026-05-24): build dispatches that
 *  explicitly opt out of promotion (`promote: false`) MUST include a
 *  non-empty `promotion_skip_reason` so there is an auditable revisit
 *  trigger. Without one, dispatches can silently bypass promotion.
 *
 *  Pure validator, called at the enqueue boundary. Returns null when
 *  the input is acceptable; returns a human-readable error message
 *  when the skip-reason rule is violated.
 *
 *  Rules:
 *    - Non-build dispatch (no repo+branch): always ok (returns null).
 *    - Build dispatch + promote !== false: ok.
 *    - Build dispatch + promote === false + non-empty trimmed
 *      promotion_skip_reason: ok.
 *    - Build dispatch + promote === false + missing/empty/whitespace
 *      promotion_skip_reason: ERROR.
 */
export function validateEnqueueSkipReason(input: {
  repo?: string;
  branch?: string;
  promote?: boolean;
  promotion_skip_reason?: string | null;
}): string | null {
  const isBuild = !!(input.repo && input.branch);
  if (!isBuild) return null;
  if (input.promote !== false) return null;
  const reason = typeof input.promotion_skip_reason === "string"
    ? input.promotion_skip_reason.trim()
    : "";
  if (reason === "") {
    return "promote=false on a build dispatch requires a non-empty promotion_skip_reason (Spec 054 v2 Part 2: explicit opt-out from promotion must record a revisit trigger)";
  }
  return null;
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
  // to true when promotion_input is supplied (build dispatch) and false
  // otherwise. Detection helper: isBuildDispatch(input) below.
  promote?: boolean;
  promotion_strategy?: DispatchDoc["promotion_strategy"];
  promotion_required_reason?: string | null;
  // Spec 054 v2 Part 2 — promotion inputs at enqueue time.
  promotion_input?: PromotionInput | null;
}

/** A dispatch is a build dispatch when it carries repo/branch metadata.
 *  Used to set the default promote=true and to drive the prompt's
 *  promotion-closeout block. */
export function isBuildDispatch(input: { promotion_input?: PromotionInput | null }): boolean {
  return !!(input.promotion_input?.repo && input.promotion_input?.branch);
}

/** Apply Part 2 defaults to an EnqueueInput. Pure; tested directly. */
export function applyPromotionDefaults(input: EnqueueInput): EnqueueInput {
  const out: EnqueueInput = { ...input };
  const buildLike = isBuildDispatch(out);
  if (buildLike) {
    if (out.promotion_input) {
      out.promotion_input = {
        ...out.promotion_input,
        base: out.promotion_input.base || "main",
        remote: out.promotion_input.remote || "origin",
      };
    }
    if (out.promote === undefined) out.promote = true;
  } else {
    if (out.promote === undefined) out.promote = false;
  }
  if (!out.promotion_strategy) out.promotion_strategy = "auto";
  return out;
}

/**
 * Task 4 (DispatchVerification job) — minimal projection of a queue row
 * the verification job adapts into a VerifierDispatchRow. Sourced from
 * `SELECT * FROM dispatch_scheduler_queue`; there is NO created_at column,
 * so `not_before_at` doubles as the created timestamp.
 */
export interface DispatchVerificationSourceRow {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  subject: string;
  status: SchedulerStatus;
  artifact_path: string | null;
  /** Raw /agent-done result JSON, unparsed. */
  result_json: string | null;
  failure_kind: FailureKind | null;
  failure_detail: string | null;
  not_before_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  promote: boolean;
  /** Parsed promotion_result_json, or null. */
  promotion_result: unknown | null;
  // Recovery-state evidence — additive, safe defaults on legacy rows.
  recovery_status: string;
  recovery_attempts: number;
  recovery_reason: string | null;
  side_effect: string;
  allow_auto_retry: boolean;
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
  /**
   * Usage Meter (Spec 2026-05-31): when set, claim will SKIP queued docs
   * whose `to_agent` is in this list. The scheduler computes this list
   * from the usage gate, but ONLY in enforce mode — in warn mode the
   * list is always empty. Docs for excluded agents remain `queued`;
   * the gate does not mutate their state or `not_before_at`.
   */
  exclude_agents?: string[];
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
  promotion_input: PromotionInput | null;
}
export function defaultPromotionFields(input: {
  promote?: boolean;
  promotion_strategy?: DispatchDoc["promotion_strategy"];
  promotion_required_reason?: string | null;
  promotion_input?: PromotionInput | null;
}): PromotionDefaults {
  // Build-like inputs default promote=true; everything else false.
  const buildLike = !!(input.promotion_input?.repo && input.promotion_input?.branch);
  return {
    promote: input.promote ?? buildLike,
    promotion_strategy: input.promotion_strategy ?? "auto",
    promotion_required_reason: input.promotion_required_reason ?? null,
    promotion_result: null,
    promotion_input: input.promotion_input
      ? {
          repo: input.promotion_input.repo,
          branch: input.promotion_input.branch,
          base: input.promotion_input.base || "main",
          remote: input.promotion_input.remote || "origin",
          promotion_skip_reason: input.promotion_input.promotion_skip_reason ?? null,
        }
      : null,
  };
}
