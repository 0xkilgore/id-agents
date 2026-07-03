// SPDX-License-Identifier: MIT
//
// Harness transient-error classifier (Spec: 2026-05-29-harness-resilience-spec.md).
//
// Pure module — no IO, no spawning, no retries here. Decides whether a
// failure observed during an in-flight harness run is a model/API/runtime
// transient (retryable) or a real semantic failure (terminal).
//
// Conservatism is the iron rule: when uncertain, classify TERMINAL. We
// must never retry real build/test failures, auth/billing, content-filter
// bounces, or promotion conflicts.

import { HANG_TIMEOUT_MARKER } from './process-timeout.js';

export type HarnessFailureKind =
  | 'thinking_block_400'
  | 'provider_overloaded'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'network_transport'
  | 'harness_process_exit'
  | 'harness_hang_timeout'
  | 'harness_empty_result'
  | 'auth_or_plan'
  | 'content_filter'
  | 'user_code_failure'
  | 'promotion_failure'
  | 'unknown';

export type HarnessTerminalFailureKind =
  | 'model_api_error_exhausted'
  | 'harness_empty_result_exhausted'
  | 'harness_process_error_exhausted'
  | 'harness_hang_timeout_exhausted'
  | 'agent_error';

export interface HarnessFailureClassification {
  kind: HarnessFailureKind;
  retryable: boolean;
  terminalFailureKind: HarnessTerminalFailureKind;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  redactedMessage: string;
}

export interface HarnessFailureInput {
  /** Primary error text (yielded `error.content`, thrown message, or empty-result string). */
  message: string;
  /** Optional stderr captured from the CLI process. */
  stderr?: string;
  /** Optional CLI exit code, if known. */
  exitCode?: number | null;
  /** Where the error came from. Drives a couple of special-cases. */
  source: 'harness_error_message' | 'empty_result' | 'thrown';
  /** Runtime identifier; useful for the redacted message only. */
  runtime?: string;
}

// ── Redaction ────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Anthropic-style API keys (any length after the prefix).
  /sk-ant-api\d{2}-[A-Za-z0-9_\-]+/g,
  // OpenAI-style keys.
  /sk-[A-Za-z0-9]{20,}/g,
  // Generic Bearer tokens.
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi,
  // Authorization headers with long opaque values.
  /Authorization:\s*[A-Za-z0-9\-_\.]{20,}/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

// ── Pattern matchers (order matters: terminal-first, then specific transients) ──

function containsAny(haystack: string, needles: ReadonlyArray<string>): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
}

function matchesAny(haystack: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((re) => re.test(haystack));
}

// Real user-code / build / test failures. ALWAYS terminal.
const USER_CODE_PHRASES: ReadonlyArray<string> = [
  'tests failed',
  'test failed',
  'npm test failed',
  'vitest failed',
  'jest failed',
  'pytest failed',
  'lint failed',
  'lint errors',
  'eslint errors',
  'type errors remain',
  'tsc errors',
  'typescript errors',
  'command failed',
  'compilation failed',
  'build failed',
];

// Promotion / merge problems. ALWAYS terminal.
const PROMOTION_PHRASES: ReadonlyArray<string> = [
  'promotion failed',
  'promotion conflict',
  'merge conflict',
  'merge commit failed',
  'fast-forward not possible',
  'push rejected',
  'remote rejected',
];

// Auth / billing / plan / quota. ALWAYS terminal.
const AUTH_PHRASES: ReadonlyArray<string> = [
  'invalid api key',
  'unauthorized',
  'payment required',
  'credit balance',
  'billing',
  'subscription',
  'plan does not include',
  'quota exceeded',
];
const AUTH_HTTP: ReadonlyArray<RegExp> = [
  /\b401\b/,
  /\b402\b/,
  /\b403\b/,
];

// Content-filter language. Terminal-for-the-dispatch.
const CONTENT_FILTER_PHRASES: ReadonlyArray<string> = [
  'content filter',
  'filtering policy',
  'output was blocked',
  'output blocked',
  'blocked by content',
];

// Thinking-block 400 signature: must match an HTTP 400 / "invalid request"
// language AND mention thinking / redacted_thinking AND say it can't be modified
// (the "latest assistant message" phrasing).
const THINKING_BLOCK_LATEST_PHRASES: ReadonlyArray<string> = [
  'latest assistant message cannot be modified',
  'blocks in the latest assistant message',
  'blocks cannot be modified',
];

function isThinkingBlock400(message: string): boolean {
  const m = message.toLowerCase();
  const has400 = /\b400\b/.test(message) || m.includes('invalid request');
  const mentionsThinking = m.includes('thinking') || m.includes('redacted_thinking');
  const cannotBeModified = THINKING_BLOCK_LATEST_PHRASES.some((p) => m.includes(p));
  return has400 && mentionsThinking && cannotBeModified;
}

// Provider rate-limit.
const RATE_LIMIT_PHRASES: ReadonlyArray<string> = [
  'rate limit',
  'too many requests',
  'concurrent request limit',
];
const RATE_LIMIT_HTTP: ReadonlyArray<RegExp> = [/\b429\b/];

// Provider overload / capacity.
//
// Code-review hardening (2026-05-31, MEDIUM-1): only the SPECIFIC
// provider-shaped phrases below are accepted without an HTTP code.
// The bare words 'capacity' and 'try again later' were dropped because
// they over-match free-form agent text (e.g. "I'll try again later").
const OVERLOAD_PHRASES: ReadonlyArray<string> = [
  'overloaded',
  'temporarily unavailable due to capacity',
  'server is temporarily limiting requests',
];
const OVERLOAD_HTTP: ReadonlyArray<RegExp> = [/\b529\b/, /\b503\b/];

// Timeouts.
const TIMEOUT_PHRASES: ReadonlyArray<string> = [
  'request timed out',
  'timed out after',
  'timeout exceeded',
  'etimedout',
];
const TIMEOUT_TOKENS: ReadonlyArray<RegExp> = [/\bETIMEDOUT\b/];

// Network transport.
const NETWORK_TOKENS: ReadonlyArray<RegExp> = [
  /\bECONNRESET\b/,
  /\bEPIPE\b/,
  /\bECONNREFUSED\b/,
  /\bENETUNREACH\b/,
];
const NETWORK_PHRASES: ReadonlyArray<string> = [
  'socket hang up',
  'network disconnected',
];

// Empty-result canonical text — server-side message in claude-agent-server.
const EMPTY_RESULT_RE = /\bproduced an empty result\b/i;

// ── Main classifier ─────────────────────────────────────────────────────────

export function classifyHarnessFailure(input: HarnessFailureInput): HarnessFailureClassification {
  const message = input.message ?? '';
  const stderr = input.stderr ?? '';
  const combined = `${message}\n${stderr}`;
  const redacted = redactSecrets(message);

  // Order matters: terminal-first. If text could be read both ways, terminal wins.

  // Real test/build/lint failures (terminal).
  if (containsAny(combined, USER_CODE_PHRASES)) {
    return {
      kind: 'user_code_failure',
      retryable: false,
      terminalFailureKind: 'agent_error',
      confidence: 'high',
      reason: 'matches user-code/test/build/lint failure phrase',
      redactedMessage: redacted,
    };
  }

  // Promotion / merge conflict (terminal).
  if (containsAny(combined, PROMOTION_PHRASES)) {
    return {
      kind: 'promotion_failure',
      retryable: false,
      terminalFailureKind: 'agent_error',
      confidence: 'high',
      reason: 'matches promotion/merge conflict phrase',
      redactedMessage: redacted,
    };
  }

  // Auth / billing / plan (terminal).
  if (containsAny(combined, AUTH_PHRASES) || matchesAny(combined, AUTH_HTTP)) {
    return {
      kind: 'auth_or_plan',
      retryable: false,
      terminalFailureKind: 'agent_error',
      confidence: 'high',
      reason: 'matches auth/billing/plan/quota signal',
      redactedMessage: redacted,
    };
  }

  // Content filter (terminal for the dispatch).
  if (containsAny(combined, CONTENT_FILTER_PHRASES)) {
    return {
      kind: 'content_filter',
      retryable: false,
      terminalFailureKind: 'agent_error',
      confidence: 'high',
      reason: 'matches content-filter signal',
      redactedMessage: redacted,
    };
  }

  // Thinking-block 400 — extremely specific signature.
  if (isThinkingBlock400(combined)) {
    return {
      kind: 'thinking_block_400',
      retryable: true,
      terminalFailureKind: 'model_api_error_exhausted',
      confidence: 'high',
      reason: 'matches Anthropic latest-turn thinking-block 400 signature',
      redactedMessage: redacted,
    };
  }

  // Provider rate-limit (transient).
  if (containsAny(combined, RATE_LIMIT_PHRASES) || matchesAny(combined, RATE_LIMIT_HTTP)) {
    return {
      kind: 'provider_rate_limited',
      retryable: true,
      terminalFailureKind: 'model_api_error_exhausted',
      confidence: 'high',
      reason: 'matches provider rate-limit signal',
      redactedMessage: redacted,
    };
  }

  // Provider overload (transient).
  if (containsAny(combined, OVERLOAD_PHRASES) || matchesAny(combined, OVERLOAD_HTTP)) {
    return {
      kind: 'provider_overloaded',
      retryable: true,
      terminalFailureKind: 'model_api_error_exhausted',
      confidence: 'high',
      reason: 'matches provider overload/capacity signal',
      redactedMessage: redacted,
    };
  }

  // Harness watchdog hang-timeout kill (2026-07-03) — our own SIGTERM/SIGKILL
  // fired because the child wedged, not a provider-reported timeout. More
  // specific than the generic TIMEOUT_PHRASES check below, so it runs first.
  if (combined.includes(HANG_TIMEOUT_MARKER)) {
    return {
      kind: 'harness_hang_timeout',
      retryable: true,
      terminalFailureKind: 'harness_hang_timeout_exhausted',
      confidence: 'high',
      reason: 'harness watchdog killed a hung child process',
      redactedMessage: redacted,
    };
  }

  // Timeouts (transient).
  if (
    containsAny(combined, TIMEOUT_PHRASES) ||
    matchesAny(combined, TIMEOUT_TOKENS)
  ) {
    return {
      kind: 'provider_timeout',
      retryable: true,
      terminalFailureKind: 'model_api_error_exhausted',
      confidence: 'high',
      reason: 'matches timeout signal',
      redactedMessage: redacted,
    };
  }

  // Network transport (transient).
  if (containsAny(combined, NETWORK_PHRASES) || matchesAny(combined, NETWORK_TOKENS)) {
    return {
      kind: 'network_transport',
      retryable: true,
      terminalFailureKind: 'model_api_error_exhausted',
      confidence: 'high',
      reason: 'matches network transport error',
      redactedMessage: redacted,
    };
  }

  // Empty result (transient up to a cap).
  if (input.source === 'empty_result' || EMPTY_RESULT_RE.test(combined)) {
    return {
      kind: 'harness_empty_result',
      retryable: true,
      terminalFailureKind: 'harness_empty_result_exhausted',
      confidence: 'medium',
      reason: 'harness produced an empty result',
      redactedMessage: redacted,
    };
  }

  // Non-zero CLI exit with no retryable signal in stderr — terminal harness_process_exit.
  // (We only get here if no specific signal matched above.)
  if (typeof input.exitCode === 'number' && input.exitCode !== 0) {
    return {
      kind: 'harness_process_exit',
      retryable: false,
      terminalFailureKind: 'harness_process_error_exhausted',
      confidence: 'low',
      reason: `CLI exited non-zero (${input.exitCode}) with no retryable signal in stderr`,
      redactedMessage: redacted,
    };
  }

  // Unknown — conservative default is TERMINAL.
  return {
    kind: 'unknown',
    retryable: false,
    terminalFailureKind: 'agent_error',
    confidence: 'low',
    reason: 'no known transient or terminal signal matched; defaulting to terminal',
    redactedMessage: redacted,
  };
}
