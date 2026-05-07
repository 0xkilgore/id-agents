import type { VerifyFailure, VerifySignal } from "../verify/types.js";

export type VetraOpKind =
  | "CREATE_DISPATCH"
  | "START_PROCESSING"
  | "REGISTER_ARTIFACT"
  | "MARK_DONE"
  | "VERIFY_SIGNAL";

export interface PendingVetraOp {
  op_id: string;
  dispatch_id: number;
  kind: VetraOpKind;
  document_id: string;
  action: { id: string; type: VetraOpKind; input: Record<string, unknown>; scope: "global"; timestampUtcMs: string };
  attempt_count: number;
  first_failed_at: string;
  last_failed_at: string;
}

export interface VerifySnapshot {
  verify_signal: VerifySignal | null;
  verify_status: "PASS" | "FAIL";
  verify_failures: VerifyFailure[];
  verify_last_checked: string;
}
