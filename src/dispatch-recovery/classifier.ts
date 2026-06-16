// P0 dispatch-recovery (disp-b329f522b1271e1b) — pure recovery classifier.
//
// Given a terminal-failed/expired dispatch, decide whether it can be safely
// auto-recovered. This is the load-bearing decision; the recovery service
// applies it. Pure + synchronous so it is trivially testable and reusable.

export type DispatchRecoveryDecision =
  | "landed"
  | "retryable"
  | "unsafe_side_effect"
  | "exhausted"
  | "needs_operator";

/**
 * Decoupled from DispatchDoc so the classifier stays pure. The recovery service
 * adapts a DispatchDoc + its message metadata into this shape.
 */
export interface RecoveryInput {
  status: string;
  failure_kind: string | null;
  failure_detail: string | null;
  attempt_count: number;
  /** How many times the recovery system has already auto-retried this dispatch. */
  recovery_attempts: number;
  /** Evidence the work actually landed despite the failed marker. */
  artifact_path: string | null;
  promotion_completed: boolean | null;
  /**
   * D3 commit evidence: the dispatch's promoted commit is present/verified on
   * the target base branch (resolved by the recovery service via a
   * CommitEvidenceProbe — git ground truth). `true` means the work landed even
   * when the /agent-done closeout was lost and the row is failed/expired (the
   * Roger Task substrate `8945b9e` false-expire pattern). Optional — absent on
   * callers that don't gather git evidence.
   */
  commit_verified_on_base?: boolean | null;
  channel: string;
  /** External-side-effect class declared on the dispatch message metadata. */
  side_effect: "none" | "external" | "email" | "payment" | "delete" | "user_visible";
  /** Explicit opt-in to auto-retry an external side effect. */
  allow_auto_retry: boolean;
}

export interface RecoveryConfig {
  max_attempts: number;
  /**
   * Substrings (lowercased) in failure_detail that mark a recoverable
   * transient. failure_kind === "scheduler_wedged" is always retryable.
   */
  retryable_detail_markers: string[];
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  max_attempts: 3,
  retryable_detail_markers: [
    "linked query terminated expired",
    "expired",
    "stale in_flight",
    "scheduler_wedged",
    "rate_limit",
    "provider_server_error",
    "provider_timeout",
    "overloaded",
  ],
};

/** Channels whose dispatches inherently carry external, irreversible effects. */
const EXTERNAL_CHANNELS = new Set(["email", "payment", "sms", "webhook", "outbound"]);

export interface RecoveryDecisionResult {
  decision: DispatchRecoveryDecision;
  reason: string;
}

function landed(input: RecoveryInput): boolean {
  return (
    (typeof input.artifact_path === "string" && input.artifact_path.length > 0) ||
    input.promotion_completed === true ||
    input.commit_verified_on_base === true
  );
}

/** True when the ONLY landed evidence is git commit verification (no artifact,
 *  no completed-promotion flag). Used to surface a distinct "verified-done"
 *  recovery state for the lost-closeout / false-expire case. */
export function landedByCommitEvidenceOnly(input: RecoveryInput): boolean {
  return (
    input.commit_verified_on_base === true &&
    input.promotion_completed !== true &&
    !(typeof input.artifact_path === "string" && input.artifact_path.length > 0)
  );
}

function hasExternalSideEffect(input: RecoveryInput): boolean {
  if (input.side_effect !== "none") return true;
  return EXTERNAL_CHANNELS.has(input.channel.toLowerCase());
}

function isRecoverableFailure(input: RecoveryInput, config: RecoveryConfig): boolean {
  if (input.failure_kind === "scheduler_wedged") return true;
  const detail = (input.failure_detail ?? "").toLowerCase();
  return config.retryable_detail_markers.some((m) => detail.includes(m.toLowerCase()));
}

/**
 * Decision order:
 *   1. landed       — the work actually completed (artifact / promotion); never retry.
 *   2. recovery only acts on terminal FAILED dispatches; otherwise needs_operator.
 *   3. unsafe_side_effect — external/irreversible action without explicit opt-in.
 *   4. exhausted    — recovery attempts already at the cap.
 *   5. retryable    — recoverable transient on internal work, under the cap.
 *   6. needs_operator — everything else (ambiguous / non-transient).
 */
export function classifyRecovery(
  input: RecoveryInput,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): RecoveryDecisionResult {
  // 1. Landed beats everything — don't panic (or retry) about work that landed.
  if (landed(input)) {
    return {
      decision: "landed",
      reason: landedByCommitEvidenceOnly(input)
        ? "commit verified on base — recovered despite failed/expired marker"
        : "artifact/promotion evidence present",
    };
  }

  // 2. Recovery only acts on terminal failures.
  if (input.status !== "failed") {
    return { decision: "needs_operator", reason: `not a terminal failure (status=${input.status})` };
  }

  // 3. Protect external side effects — never auto-resend without explicit opt-in.
  if (hasExternalSideEffect(input) && !input.allow_auto_retry) {
    return {
      decision: "unsafe_side_effect",
      reason: `external side effect (${input.side_effect}/${input.channel}) without allow_auto_retry`,
    };
  }

  // 4. Exhausted → operator.
  if (input.recovery_attempts >= config.max_attempts) {
    return {
      decision: "exhausted",
      reason: `recovery_attempts ${input.recovery_attempts} >= max ${config.max_attempts}`,
    };
  }

  // 5. Recoverable transient on (now-safe) internal work → retry.
  if (isRecoverableFailure(input, config)) {
    return {
      decision: "retryable",
      reason: `recoverable failure: ${input.failure_detail ?? input.failure_kind ?? "transient"}`,
    };
  }

  // 6. Default — surface to operator, don't blindly retry.
  return {
    decision: "needs_operator",
    reason: `non-transient failure (${input.failure_kind ?? "unknown"}): ${input.failure_detail ?? ""}`.trim(),
  };
}
