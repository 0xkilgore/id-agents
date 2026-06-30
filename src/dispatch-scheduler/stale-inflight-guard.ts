import type { DispatchDoc, SchedulerStatus } from "./types.js";

export type InFlightStalenessDecision =
  | {
      kind: "active";
      inactivity_ms: number;
      ttl_ms: number;
      last_activity_source: "last_output_at" | "started_at" | "updated_at";
    }
  | {
      kind: "stale";
      inactivity_ms: number;
      ttl_ms: number;
      last_activity_source: "last_output_at" | "started_at" | "updated_at";
      reason: "no_progress_evidence" | "progress_too_old";
    }
  | {
      kind: "terminal";
      reason: "dispatch_terminal" | "linked_query_terminal";
    }
  | {
      kind: "not_in_flight";
      reason: "status_not_in_flight" | "missing_agent_query_id" | "invalid_clock";
    };

export interface InFlightStalenessEvidence {
  status: string;
  last_output_at: number | null;
}

export interface InFlightStalenessInput {
  doc: Pick<
    DispatchDoc,
    "status" | "started_at" | "updated_at" | "agent_query_id" | "runtime" | "promote" | "promotion_input"
  >;
  evidence?: InFlightStalenessEvidence | null;
  now_ms: number;
  ttl_ms: number;
}

const TERMINAL_DISPATCH_STATUSES = new Set<SchedulerStatus>([
  "done",
  "failed",
  "cancelled",
]);

const TERMINAL_QUERY_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Pure stale-in-flight classifier for scheduler and promotion guardrails.
 *
 * This intentionally returns a decision only. It does not close, requeue,
 * fail, or promote anything; callers must route any mutation through an
 * explicit operator/scheduler path with its own race checks.
 */
export function classifyInFlightStaleness(input: InFlightStalenessInput): InFlightStalenessDecision {
  const { doc, evidence } = input;

  if (TERMINAL_DISPATCH_STATUSES.has(doc.status)) {
    return { kind: "terminal", reason: "dispatch_terminal" };
  }

  if (evidence && TERMINAL_QUERY_STATUSES.has(evidence.status)) {
    return { kind: "terminal", reason: "linked_query_terminal" };
  }

  if (doc.status !== "in_flight") {
    return { kind: "not_in_flight", reason: "status_not_in_flight" };
  }

  if (!doc.agent_query_id) {
    return { kind: "not_in_flight", reason: "missing_agent_query_id" };
  }

  const startedMs = Date.parse(doc.started_at ?? doc.updated_at);
  if (
    !Number.isFinite(input.now_ms) ||
    !Number.isFinite(startedMs) ||
    !Number.isFinite(input.ttl_ms) ||
    input.ttl_ms <= 0
  ) {
    return { kind: "not_in_flight", reason: "invalid_clock" };
  }

  let lastActivityMs = startedMs;
  let lastActivitySource: "last_output_at" | "started_at" | "updated_at" =
    doc.started_at ? "started_at" : "updated_at";
  if (evidence?.last_output_at != null && Number.isFinite(evidence.last_output_at)) {
    lastActivityMs = Math.max(lastActivityMs, evidence.last_output_at);
    if (lastActivityMs === evidence.last_output_at) {
      lastActivitySource = "last_output_at";
    }
  }

  const inactivity = input.now_ms - lastActivityMs;
  if (inactivity < input.ttl_ms) {
    return {
      kind: "active",
      inactivity_ms: inactivity,
      ttl_ms: input.ttl_ms,
      last_activity_source: lastActivitySource,
    };
  }

  return {
    kind: "stale",
    inactivity_ms: inactivity,
    ttl_ms: input.ttl_ms,
    last_activity_source: lastActivitySource,
    reason: lastActivitySource === "last_output_at" ? "progress_too_old" : "no_progress_evidence",
  };
}

export function isBuildPromotionInFlight(
  doc: Pick<DispatchDoc, "status" | "promote" | "promotion_input">,
): boolean {
  return doc.status === "in_flight" && doc.promote === true && !!doc.promotion_input;
}
