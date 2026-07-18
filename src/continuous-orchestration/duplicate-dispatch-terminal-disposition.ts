import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import type { DispatchOutcome } from "./storage.js";

const TERMINAL_CLOSE_STATUSES = new Set(["done"]);
const TERMINAL_SUPERSEDE_STATUSES = new Set(["cancelled", "moot", "superseded"]);
const LANDED_RECOVERY_STATUSES = new Set(["landed_reconciled", "verified_done", "retry_done"]);

export interface DuplicateDispatchTerminalDisposition {
  terminal: boolean;
  status: string | null;
  promotion_verified: boolean;
}

export function duplicateDispatchTerminalDisposition(
  outcome: DispatchOutcome | undefined,
): DuplicateDispatchTerminalDisposition {
  if (!outcome) {
    return { terminal: false, status: null, promotion_verified: false };
  }

  const promotionVerified = promotionCompletedAndVerified(outcome.promotion_result_json);
  if (promotionVerified || LANDED_RECOVERY_STATUSES.has(outcome.recovery_status ?? "")) {
    return { terminal: true, status: "done", promotion_verified: promotionVerified };
  }
  if (outcome.reliability_classification === "superseded") {
    return { terminal: true, status: "superseded", promotion_verified: false };
  }
  if (outcome.recovery_status === "moot" || outcome.status === "moot") {
    return { terminal: true, status: "moot", promotion_verified: false };
  }
  if (TERMINAL_CLOSE_STATUSES.has(outcome.status)) {
    return { terminal: true, status: outcome.status, promotion_verified: promotionVerified };
  }
  if (TERMINAL_SUPERSEDE_STATUSES.has(outcome.status)) {
    return { terminal: true, status: outcome.status, promotion_verified: false };
  }

  return { terminal: false, status: null, promotion_verified: false };
}
