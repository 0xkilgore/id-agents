// T-REMOTE P1c — dispatch recovery ADVISOR.
//
// The recovery service's classifier (./classifier.ts) answers "can I safely
// auto-recover?" in its own vocabulary. The remote-doctor / ops panel needs the
// OPERATOR-facing advisory class instead:
//   landed-recoverable · verify-first · refire · moot · needs-human
// so a laptop operator (or the doctor's dispatches_needing_action) never blind-
// refires an expired-linked-query whose work already landed (the exact
// post-usage-limit trap this productizes). Pure adapter over classifyRecovery.

import {
  classifyRecovery,
  isLinkedQueryTerminalFailure,
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryConfig,
  type RecoveryInput,
} from "./classifier.js";
import type { DispatchActionClass } from "../remote-doctor/types.js";

export interface DispatchAdvisorResult {
  advisor_class: DispatchActionClass;
  reason: string;
}

/**
 * Map a failed/expired dispatch to its operator advisory class. Priority:
 *   1. LANDED evidence (artifact / promotion / commit-on-base) → landed-recoverable
 *      — recover the work, NEVER refire (acceptance: recoverables not refired).
 *   2. operator-cancelled / superseded, no landed work → moot (nothing to do).
 *   3. a recoverable transient that is an EXPIRED LINKED QUERY → verify-first
 *      (the work may have landed with no artifact proof — verify before refiring).
 *   4. other recoverable transient → refire.
 *   5. external side effect / exhausted / ambiguous → needs-human.
 */
export function classifyDispatchRecoveryAdvisor(
  input: RecoveryInput,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): DispatchAdvisorResult {
  const rec = classifyRecovery(input, config);

  if (rec.decision === "landed") {
    return { advisor_class: "landed-recoverable", reason: rec.reason };
  }

  // Operator-cancelled / superseded (state-cleanup terminalization) with no landed
  // work is moot — dismissed, not a recovery candidate.
  if (input.failure_kind === "cancelled") {
    return { advisor_class: "moot", reason: input.failure_detail?.trim() || "operator-cancelled / superseded" };
  }

  switch (rec.decision) {
    case "retryable":
      if (isLinkedQueryTerminalFailure(input)) {
        return {
          advisor_class: "verify-first",
          reason: `expired linked query ${input.agent_query_id} — verify landed work before refire`,
        };
      }
      return { advisor_class: "refire", reason: rec.reason };
    case "unsafe_side_effect":
    case "exhausted":
    case "needs_operator":
    default:
      return { advisor_class: "needs-human", reason: rec.reason };
  }
}
