// W2-1 DispatchVerification — typed projection that powers Kapelle's Agents
// tab (verified-landing-rate). See
// docs/superpowers/plans/2026-06-15-dispatch-verification.md.
//
// A dispatch is a "verified landing" only when /agent-done completed it with
// success, it has a first-class artifact_path, the artifact exists on disk,
// the artifact mtime is inside the delivery window, and (for build dispatches)
// the Spec 054 promotion block validates. The manager writes this into a
// durable projection on a 5-minute job; the Agents endpoints read the
// projection and never stat files on request.

import type { Provider } from "../dispatch-scheduler/types.js";

/** v0 public failure enum (do NOT add promotion_failed in W2-1). */
export type DispatchVerificationFailureType =
  | "expired"
  | "artifact_missing"
  | "artifact_stale"
  | "dispatch_not_found"
  | "dispatch_id_mismatch"
  | "rate_limited"
  | "provider_error";

/** Enum order — used for deterministic tie-breaking of top_failure_type. */
export const DISPATCH_VERIFICATION_FAILURE_TYPES: readonly DispatchVerificationFailureType[] = [
  "expired",
  "artifact_missing",
  "artifact_stale",
  "dispatch_not_found",
  "dispatch_id_mismatch",
  "rate_limited",
  "provider_error",
];

export type DispatchVerificationStatus = "verified" | "unverified" | "pending";

export type DispatchArtifactKind = "report" | "code" | "data" | "other";

export interface DispatchVerification {
  schema_version: "dispatch-verification.v1";
  team_id: string;
  dispatch_id: string;
  query_id: string | null;
  agent_name: string;
  provider: Provider;
  status: DispatchVerificationStatus;
  verified: boolean;
  failure_type: DispatchVerificationFailureType | null;
  failure_detail: string | null;
  artifact_path: string | null;
  artifact_exists: boolean | null;
  artifact_mtime: string | null;
  delivery_window_start: string | null;
  delivery_window_end: string | null;
  promotion_required: boolean;
  promotion_verified: boolean | null;
  promotion_failure_detail: string | null;
  dispatch_status: string;
  dispatch_created_at: string;
  dispatch_started_at: string | null;
  dispatch_completed_at: string | null;
  result_success: boolean | null;
  tl_dr: string | null;
  kind: DispatchArtifactKind;
  checked_at: string;
  source_metadata: {
    source: "dispatch_scheduler_queue";
    result_source: "artifact_path" | "result_json" | "none";
  };
}

/**
 * The raw dispatch row the verifier classifies. A scheduler-agnostic shape so
 * the verifier is a pure function — the job adapts DispatchDoc rows into this.
 */
export interface VerifierDispatchRow {
  team_id: string;
  dispatch_id: string;
  query_id: string | null;
  agent_name: string;
  provider: Provider;
  status: string;
  artifact_path: string | null;
  /** Parsed `/agent-done` result, if any. */
  result_success: boolean | null;
  tl_dr: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  created_at: string;
  started_at: string | null;
  not_before_at: string | null;
  completed_at: string | null;
  /** Whether this dispatch required Spec 054 promotion (build dispatch). */
  promotion_required: boolean;
  /** Result of validating the /agent-done promotion block. null = not applicable. */
  promotion_verified: boolean | null;
  promotion_failure_detail: string | null;
  /** Whether result_json carried artifact_path (vs the column being backfilled / absent). */
  artifact_path_source: "artifact_path" | "result_json" | "none";
}

export interface ArtifactStat {
  exists: boolean;
  is_file: boolean;
  mtime_iso: string | null;
}

export interface VerifyDeps {
  /** Inject filesystem stat so the verifier never touches disk in unit tests. */
  statArtifact: (path: string) => ArtifactStat;
  /** Current time (ISO). */
  now: string;
  /** Active dispatches older than this are `expired`. Default 5 minutes. */
  expiredAfterMs?: number;
  /** Clock-skew allowance for mtime <= completed_at. Default 60s. */
  clockSkewMs?: number;
}

export const DEFAULT_EXPIRED_AFTER_MS = 5 * 60_000;
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

/** Windows accepted by the effectiveness/dispatches endpoints. */
export type EffectivenessWindow = "24h" | "7d" | "30d";

export const WINDOW_DAYS: Readonly<Record<EffectivenessWindow, number>> = Object.freeze({
  "24h": 1,
  "7d": 7,
  "30d": 30,
});

export function isEffectivenessWindow(v: unknown): v is EffectivenessWindow {
  return v === "24h" || v === "7d" || v === "30d";
}
