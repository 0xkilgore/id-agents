// Dispatch-canonical strict-mode classifier.
//
// CTO scope: cto/output/2026-06-10-dispatch-canonical-strict-mode-spec.md
//
// Pure function. Given an agent response body + transport status,
// returns a typed classification. The dispatch closeout pipeline
// calls this BEFORE marking `delivered`; if `classification ===
// "failed"`, the dispatch is marked failed with the typed reason.
//
// Classification order (CTO §"Classification Rule"):
//   1. transport_status hints (5xx/401/429 with empty body)
//   2. dispatch identity mismatch
//   3. explicit structured error field
//   4. plain-text patterns
//   5. else: delivered
//
// False positives are minimized by requiring either structured fields
// or specific provider/runtime phrases — NEVER broad words like "error"
// alone (CTO scope explicit).

export type DispatchFailureReason =
  | "rate_limit_error"
  | "provider_server_error"
  | "provider_auth_error"
  | "provider_timeout"
  | "context_length_error"
  | "runtime_error"
  | "tool_error"
  | "agent_refusal"
  | "malformed_agent_response"
  | "dispatch_id_mismatch"
  | "dispatch_not_found"
  | "unknown_error";

export type ClassificationConfidence = "structured" | "pattern" | "transport";

export interface ClassifyArgs {
  /** Raw response body — either a parsed object or a string. */
  body: unknown;
  /** HTTP/transport status from the agent runtime. */
  transport_status: number;
  /** ISO timestamp to stamp on the classification row. */
  classified_at: string;
  /**
   * Hint that the body was supposed to be JSON. Used so unparseable
   * `body: "{not json"` strings classify as `malformed_agent_response`
   * instead of falling through to "delivered".
   */
  expected_json?: boolean;
}

export interface StrictModeClassification {
  classification: "delivered" | "failed";
  failure_reason: DispatchFailureReason | null;
  confidence: ClassificationConfidence | null;
  matched_pattern: string | null;
  response_excerpt: string | null;
  classified_at: string;
}

const EXCERPT_LIMIT = 500;

export function classifyAgentResponse(
  args: ClassifyArgs,
): StrictModeClassification {
  const excerpt = redactExcerpt(args.body);

  // (1) Transport hints — only when the body is empty / non-informative.
  const transportFailure = classifyTransport(args.transport_status, args.body);
  if (transportFailure) {
    return {
      classification: "failed",
      failure_reason: transportFailure.reason,
      confidence: "transport",
      matched_pattern: transportFailure.matched_pattern,
      response_excerpt: excerpt,
      classified_at: args.classified_at,
    };
  }

  // Normalize: try to coerce the body into a structured object for the
  // structured marker pass.
  const parsed = tryParseObject(args.body);
  const bodyText = bodyToText(args.body);

  // (2) Dispatch identity mismatch — recognized structured payload from
  // the manager itself when an agent posts the wrong dispatch_id.
  if (parsed) {
    const mismatch = matchDispatchIdMismatch(parsed);
    if (mismatch) {
      return {
        classification: "failed",
        failure_reason: "dispatch_id_mismatch",
        confidence: "structured",
        matched_pattern: mismatch,
        response_excerpt: excerpt,
        classified_at: args.classified_at,
      };
    }
  }

  // (3) Structured error markers.
  if (parsed) {
    const structured = matchStructured(parsed);
    if (structured) {
      return {
        classification: "failed",
        failure_reason: structured.reason,
        confidence: "structured",
        matched_pattern: structured.matched_pattern,
        response_excerpt: excerpt,
        classified_at: args.classified_at,
      };
    }
  }

  // (3b) Malformed body — caller said it should be JSON, but it isn't.
  if (args.expected_json && !parsed && typeof args.body === "string") {
    return {
      classification: "failed",
      failure_reason: "malformed_agent_response",
      confidence: "structured",
      matched_pattern: "expected_json_but_not_parseable",
      response_excerpt: excerpt,
      classified_at: args.classified_at,
    };
  }

  // (4) Plain-text patterns — conservative; only applied when the
  // transport status suggests something might be wrong. A 200 OK with
  // the word "rate limit" in a valid agent answer is delivered.
  if (isLikelyErrorByTransport(args.transport_status) || hasStrongInlineMarker(bodyText)) {
    const text = matchPlainText(bodyText);
    if (text) {
      return {
        classification: "failed",
        failure_reason: text.reason,
        confidence: "pattern",
        matched_pattern: text.matched_pattern,
        response_excerpt: excerpt,
        classified_at: args.classified_at,
      };
    }
  }

  // (5) No markers — delivered.
  return {
    classification: "delivered",
    failure_reason: null,
    confidence: null,
    matched_pattern: null,
    response_excerpt: excerpt,
    classified_at: args.classified_at,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyTransport(
  status: number,
  body: unknown,
): { reason: DispatchFailureReason; matched_pattern: string } | null {
  // Only apply transport-only classification when the body is empty
  // or whitespace. A body with content gets the structured / pattern
  // passes a chance to produce a more specific reason.
  const text = bodyToText(body).trim();
  if (text.length > 0) return null;
  if (status === 429) {
    return { reason: "rate_limit_error", matched_pattern: "transport_status=429" };
  }
  if (status === 401 || status === 403) {
    return { reason: "provider_auth_error", matched_pattern: `transport_status=${status}` };
  }
  if (status === 408) {
    return { reason: "provider_timeout", matched_pattern: "transport_status=408" };
  }
  if (status >= 500 && status <= 599) {
    return { reason: "provider_server_error", matched_pattern: `transport_status=${status}` };
  }
  return null;
}

function matchDispatchIdMismatch(parsed: Record<string, unknown>): string | null {
  const err = parsed.error;
  if (typeof err === "string" && err === "dispatch_id_mismatch") {
    return "error=dispatch_id_mismatch";
  }
  if (isPlainObject(err)) {
    if ((err as Record<string, unknown>).type === "dispatch_id_mismatch") {
      return "error.type=dispatch_id_mismatch";
    }
  }
  if (
    parsed.failure_reason === "dispatch_id_mismatch" ||
    parsed.status === "dispatch_id_mismatch"
  ) {
    return "failure_reason=dispatch_id_mismatch";
  }
  return null;
}

function matchStructured(parsed: Record<string, unknown>): {
  reason: DispatchFailureReason;
  matched_pattern: string;
} | null {
  const err = parsed.error;
  if (isPlainObject(err)) {
    const errObj = err as Record<string, unknown>;
    const type = typeof errObj.type === "string" ? errObj.type : null;
    const message =
      typeof errObj.message === "string" ? errObj.message.toLowerCase() : "";
    if (type === "rate_limit_error") {
      return { reason: "rate_limit_error", matched_pattern: "error.type=rate_limit_error" };
    }
    if (type === "provider_server_error") {
      return {
        reason: "provider_server_error",
        matched_pattern: "error.type=provider_server_error",
      };
    }
    if (type === "authentication_error") {
      return {
        reason: "provider_auth_error",
        matched_pattern: "error.type=authentication_error",
      };
    }
    if (type === "overloaded_error") {
      return {
        reason: "provider_server_error",
        matched_pattern: "error.type=overloaded_error",
      };
    }
    if (type === "invalid_request_error") {
      if (
        message.includes("context") ||
        message.includes("maximum") ||
        message.includes("too long") ||
        message.includes("token")
      ) {
        return {
          reason: "context_length_error",
          matched_pattern: "error.type=invalid_request_error+context-hint",
        };
      }
      return { reason: "unknown_error", matched_pattern: "error.type=invalid_request_error" };
    }
    if (type === "tool_error" || type === "tool_execution_failed") {
      return { reason: "tool_error", matched_pattern: `error.type=${type}` };
    }
    if (type === "agent_refusal") {
      return { reason: "agent_refusal", matched_pattern: "error.type=agent_refusal" };
    }
  }

  // success=false + error_type
  if (parsed.success === false) {
    const errorType = parsed.error_type;
    if (typeof errorType === "string") {
      if (errorType === "tool_execution_failed") {
        return { reason: "tool_error", matched_pattern: "success=false+error_type=tool_execution_failed" };
      }
      if (errorType === "rate_limit_error") {
        return { reason: "rate_limit_error", matched_pattern: "success=false+error_type=rate_limit_error" };
      }
      return { reason: "runtime_error", matched_pattern: `success=false+error_type=${errorType}` };
    }
    return { reason: "runtime_error", matched_pattern: "success=false" };
  }

  // status=failed in a tool/manager response
  if (parsed.status === "failed" || parsed.state === "failed") {
    const failureReason = parsed.failure_reason;
    if (typeof failureReason === "string" && isKnownReason(failureReason)) {
      return {
        reason: failureReason as DispatchFailureReason,
        matched_pattern: `status=failed+failure_reason=${failureReason}`,
      };
    }
    return { reason: "runtime_error", matched_pattern: "status=failed" };
  }

  return null;
}

function matchPlainText(text: string): {
  reason: DispatchFailureReason;
  matched_pattern: string;
} | null {
  const lower = text.toLowerCase();
  if (lower.includes("rate_limit_error")) {
    return { reason: "rate_limit_error", matched_pattern: "text:rate_limit_error" };
  }
  if (lower.includes("rate limit") && (lower.includes("429") || lower.includes("exceeded") || lower.includes("too many"))) {
    return { reason: "rate_limit_error", matched_pattern: "text:rate-limit-phrase" };
  }
  if (lower.includes("overloaded")) {
    return { reason: "provider_server_error", matched_pattern: "text:overloaded" };
  }
  if (lower.includes("provider_server_error") || lower.includes("internal server error")) {
    return { reason: "provider_server_error", matched_pattern: "text:server-error" };
  }
  if (lower.includes("authentication_error") || lower.includes("invalid api key")) {
    return { reason: "provider_auth_error", matched_pattern: "text:auth-error" };
  }
  if (lower.includes("maximum context") || lower.includes("context length")) {
    return { reason: "context_length_error", matched_pattern: "text:context-length" };
  }
  if (lower.includes("tool execution failed")) {
    return { reason: "tool_error", matched_pattern: "text:tool-execution-failed" };
  }
  if (lower.includes("runtime error")) {
    return { reason: "runtime_error", matched_pattern: "text:runtime-error" };
  }
  return null;
}

function isLikelyErrorByTransport(status: number): boolean {
  return status >= 400 || status === 0;
}

/**
 * Strong inline markers that are unambiguous error indicators
 * regardless of transport status — e.g. "tool execution failed".
 * Used as a narrow allow-list so a 200-OK body containing one of
 * these still classifies as failed (CTO §"Classification Rule" #4).
 */
function hasStrongInlineMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("tool execution failed") ||
    lower.includes("rate_limit_error") ||
    lower.includes("provider_server_error") ||
    lower.includes("authentication_error")
  );
}

function tryParseObject(body: unknown): Record<string, unknown> | null {
  if (isPlainObject(body)) return body as Record<string, unknown>;
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    if (isPlainObject(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bodyToText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body == null) return "";
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function redactExcerpt(body: unknown): string | null {
  const text = bodyToText(body);
  if (!text) return null;
  // Cap + redact common secret-shaped substrings.
  const trimmed = text.length > EXCERPT_LIMIT ? text.slice(0, EXCERPT_LIMIT) + "…" : text;
  return trimmed
    .replace(/sk-ant-api03-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) =>
      m.length > 40 ? "[REDACTED_LONG]" : m,
    );
}

const KNOWN_REASONS: ReadonlySet<DispatchFailureReason> = new Set<DispatchFailureReason>([
  "rate_limit_error",
  "provider_server_error",
  "provider_auth_error",
  "provider_timeout",
  "context_length_error",
  "runtime_error",
  "tool_error",
  "agent_refusal",
  "malformed_agent_response",
  "dispatch_id_mismatch",
  "dispatch_not_found",
  "unknown_error",
]);

function isKnownReason(v: string): boolean {
  return KNOWN_REASONS.has(v as DispatchFailureReason);
}

// ---------------------------------------------------------------------------
// Retryable mapping
// ---------------------------------------------------------------------------

/**
 * Per CTO §"Closeout State Mapping" — which failure reasons are
 * automatically retryable. Operator overrides can change this at the
 * dispatch row level; this is just the default.
 */
export function isRetryable(reason: DispatchFailureReason | null): boolean {
  switch (reason) {
    case "rate_limit_error":
    case "provider_server_error":
    case "provider_timeout":
      return true;
    case "provider_auth_error":
    case "context_length_error":
    case "malformed_agent_response":
    case "dispatch_id_mismatch":
    case "dispatch_not_found":
    case "agent_refusal":
      return false;
    case "tool_error":
    case "runtime_error":
    case "unknown_error":
    case null:
      return false; // conservative default; operator can flip
  }
}

// ---------------------------------------------------------------------------
// Feature flag — shadow vs enforce
// ---------------------------------------------------------------------------

export type StrictModeFlag = "off" | "shadow" | "enforce";

export function parseStrictModeFlag(raw: string | undefined): StrictModeFlag {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "enforce") return "enforce";
  if (v === "shadow") return "shadow";
  return "off";
}

// ---------------------------------------------------------------------------
// Closeout override decision — pure
// ---------------------------------------------------------------------------

/**
 * Given the strict-mode flag and a classification, decide what
 * SchedulerHandle.handleAgentDone should do at the closeout boundary.
 *
 * Returns:
 *   - null if the closeout should proceed to `delivered` unchanged
 *     (flag=off, flag=shadow, or classification=delivered)
 *   - { override: true, failure_kind, detail, log_payload } when the
 *     dispatch should be marked failed instead
 *
 * The `log_payload` field is what handleAgentDone should write to its
 * structured logger regardless of override (even in shadow mode the
 * classification should be observable).
 */
export interface OverrideDecision {
  override: boolean;
  failure_kind: "strict_mode_classified";
  detail: string;
  log_payload: {
    mode: StrictModeFlag;
    failure_reason: DispatchFailureReason | null;
    confidence: ClassificationConfidence | null;
    matched_pattern: string | null;
    response_excerpt: string | null;
  };
}

export function decideStrictModeOverride(
  flag: StrictModeFlag,
  classification: StrictModeClassification,
): OverrideDecision | null {
  if (classification.classification !== "failed") return null;
  const log_payload = {
    mode: flag,
    failure_reason: classification.failure_reason,
    confidence: classification.confidence,
    matched_pattern: classification.matched_pattern,
    response_excerpt: classification.response_excerpt,
  };
  if (flag === "enforce") {
    const detail = [
      "strict_mode",
      classification.failure_reason,
      classification.confidence,
      classification.matched_pattern,
    ]
      .filter(Boolean)
      .join(":");
    return {
      override: true,
      failure_kind: "strict_mode_classified",
      detail,
      log_payload,
    };
  }
  // shadow / off → log but don't override.
  return {
    override: false,
    failure_kind: "strict_mode_classified",
    detail: "",
    log_payload,
  };
}
