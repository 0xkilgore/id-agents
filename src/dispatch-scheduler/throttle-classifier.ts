// Phase 3.2: classify an agent-start error so the scheduler can decide
// markBounced (retryable, requeue with backoff) vs markFailed (terminal,
// no retry) vs a local pause that should not count as a provider bounce.

import type { Provider } from "./types.js";

export type ThrottleKind =
  | "provider_throttle"
  | "auth_or_plan"
  | "local_pause"
  | "transport"
  | "agent_error";

export interface ClassifyInput {
  provider: Provider;
  status: number;
  body: string;
  cause?: "transport" | "local_usage_pause" | "http";
  transportError?: string;
}

export interface Classification {
  kind: ThrottleKind;
  retryable: boolean;
  detail: string;
}

const PROVIDER_THROTTLE_PHRASES: RegExp[] = [
  /server is temporarily limiting requests/i,
  /rate[_ -]?limit/i,
  /overloaded/i,
  /temporarily unavailable due to capacity/i,
  /concurrent request limit/i,
  /try again later/i,
];

const PLAN_PHRASES: RegExp[] = [
  /plan does not (?:include|cover|allow)/i,
  /payment required/i,
  /quota exceeded/i,
  /subscription/i,
];

// Redact common secret shapes before stashing on the doc.
const SECRET_PATTERNS: RegExp[] = [
  /sk-(?:ant-)?[a-zA-Z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /api[_-]?key=[A-Za-z0-9._-]{8,}/gi,
];

function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[redacted]");
  }
  return out;
}

function bodyMatches(body: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(body));
}

export function classifyAgentStartError(input: ClassifyInput): Classification {
  const redacted = redactSecrets(input.body ?? "");

  if (input.cause === "local_usage_pause") {
    return {
      kind: "local_pause",
      retryable: true,
      detail: "local usage-meter pause",
    };
  }

  if (input.cause === "transport") {
    return {
      kind: "transport",
      retryable: true,
      detail: `transport: ${redactSecrets(input.transportError ?? "unknown")}`,
    };
  }

  const status = input.status;

  // Provider throttle: 429, 529, 503-with-capacity, or any body that
  // looks like rate-limit/overloaded/capacity language.
  if (status === 429 || status === 529) {
    return {
      kind: "provider_throttle",
      retryable: true,
      detail: `provider throttle (HTTP ${status}): ${redacted}`,
    };
  }
  if (status === 503 && bodyMatches(redacted, PROVIDER_THROTTLE_PHRASES)) {
    return {
      kind: "provider_throttle",
      retryable: true,
      detail: `provider throttle (HTTP ${status}): ${redacted}`,
    };
  }
  if (bodyMatches(redacted, PROVIDER_THROTTLE_PHRASES)) {
    return {
      kind: "provider_throttle",
      retryable: true,
      detail: `provider throttle: ${redacted}`,
    };
  }

  // Auth / plan hard stops — do not retry.
  if (status === 401 || status === 402) {
    return {
      kind: "auth_or_plan",
      retryable: false,
      detail: `auth/plan (HTTP ${status}): ${redacted}`,
    };
  }
  if (status === 403) {
    return {
      kind: "auth_or_plan",
      retryable: false,
      detail: `auth/plan (HTTP ${status}): ${redacted}`,
    };
  }
  if (bodyMatches(redacted, PLAN_PHRASES)) {
    return {
      kind: "auth_or_plan",
      retryable: false,
      detail: `auth/plan: ${redacted}`,
    };
  }

  // Anything else from the agent — non-throttle failure.
  return {
    kind: "agent_error",
    retryable: false,
    detail: `agent_error (HTTP ${status}): ${redacted}`,
  };
}
