// SPDX-License-Identifier: MIT
//
// Harness retry policy (Spec: 2026-05-29-harness-resilience-spec.md).
//
// Pure module: defaults + env parsing + backoff math + retry predicate.
// The retry LOOP itself lives in src/claude-agent-server.ts. This file
// is intentionally kept separate from `scheduler-service.ts` start-throttling
// policy — the two layers serve different purposes:
//   - scheduler retry: provider-throttle at /talk start time.
//   - this policy:     in-flight harness-run failure inside the agent process.

import type { HarnessFailureClassification } from './transient-errors.js';

export interface HarnessRetryPolicy {
  /** Total attempts (initial + retries). 1 disables retries. */
  maxAttempts: number;
  /** Initial backoff in ms; doubles each attempt. */
  initialBackoffMs: number;
  /** Cap on backoff in ms. */
  maxBackoffMs: number;
  /** ± fraction added/subtracted to the backoff (e.g. 0.2 = ±20%). */
  jitterPct: number;
  /** Retry harness_empty_result (capped by maxAttempts). */
  retryEmptyResult: boolean;
  /** Allow one-shot retry on bare non-zero CLI exit with no signal. */
  retryUnknownProcessExitOnce: boolean;
  /** Suppress session resume on retry (recommended; thinking-block 400 is session-corruption). */
  clearSessionOnRetry: boolean;
}

export const HARNESS_RETRY_DEFAULTS: HarnessRetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialBackoffMs: 5_000,
  maxBackoffMs: 60_000,
  jitterPct: 0.2,
  retryEmptyResult: true,
  retryUnknownProcessExitOnce: false,
  clearSessionOnRetry: true,
}) as HarnessRetryPolicy;

const MAX_ATTEMPTS_CEILING = 10;

export interface HarnessRetryEnv {
  HARNESS_TRANSIENT_MAX_ATTEMPTS?: string;
  HARNESS_TRANSIENT_BACKOFF_INITIAL_MS?: string;
  HARNESS_TRANSIENT_BACKOFF_MAX_MS?: string;
  HARNESS_TRANSIENT_JITTER_PCT?: string;
  HARNESS_RETRY_EMPTY_RESULT?: string;
  HARNESS_RETRY_UNKNOWN_PROCESS_EXIT_ONCE?: string;
  HARNESS_CLEAR_SESSION_ON_TRANSIENT_RETRY?: string;
}

function parseInt0(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function parseFloat0(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

export function loadHarnessRetryPolicy(env: HarnessRetryEnv): HarnessRetryPolicy {
  const maxAttempts = parseInt0(
    env.HARNESS_TRANSIENT_MAX_ATTEMPTS,
    HARNESS_RETRY_DEFAULTS.maxAttempts,
    1,
    MAX_ATTEMPTS_CEILING,
  );
  const maxBackoffMs = parseInt0(
    env.HARNESS_TRANSIENT_BACKOFF_MAX_MS,
    HARNESS_RETRY_DEFAULTS.maxBackoffMs,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  let initialBackoffMs = parseInt0(
    env.HARNESS_TRANSIENT_BACKOFF_INITIAL_MS,
    HARNESS_RETRY_DEFAULTS.initialBackoffMs,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (initialBackoffMs > maxBackoffMs) initialBackoffMs = maxBackoffMs;
  const jitterPct = parseFloat0(
    env.HARNESS_TRANSIENT_JITTER_PCT,
    HARNESS_RETRY_DEFAULTS.jitterPct,
    0,
    1,
  );
  const retryEmptyResult = parseBool(
    env.HARNESS_RETRY_EMPTY_RESULT,
    HARNESS_RETRY_DEFAULTS.retryEmptyResult,
  );
  const retryUnknownProcessExitOnce = parseBool(
    env.HARNESS_RETRY_UNKNOWN_PROCESS_EXIT_ONCE,
    HARNESS_RETRY_DEFAULTS.retryUnknownProcessExitOnce,
  );
  const clearSessionOnRetry = parseBool(
    env.HARNESS_CLEAR_SESSION_ON_TRANSIENT_RETRY,
    HARNESS_RETRY_DEFAULTS.clearSessionOnRetry,
  );
  return {
    maxAttempts,
    initialBackoffMs,
    maxBackoffMs,
    jitterPct,
    retryEmptyResult,
    retryUnknownProcessExitOnce,
    clearSessionOnRetry,
  };
}

/**
 * Compute next backoff in ms.
 *  - Exponential: base * 2^(attemptNumber-1)
 *  - Capped at maxBackoffMs
 *  - Jittered by ±jitterPct using rng() in [0,1)
 *
 * attemptNumber is the *next* attempt number (1-based). The sleep happens
 * *before* attempt N+1 with attemptNumber == N+1 conceptually, but the
 * spec phrases it as "exponential backoff after attempt n"; either
 * interpretation works since the test passes attemptNumber explicitly.
 */
export function computeBackoffMs(
  policy: HarnessRetryPolicy,
  attemptNumber: number,
  rng: () => number = Math.random,
): number {
  if (policy.initialBackoffMs === 0) return 0;
  const exp = Math.min(
    policy.initialBackoffMs * Math.pow(2, Math.max(0, attemptNumber - 1)),
    policy.maxBackoffMs,
  );
  if (policy.jitterPct === 0) return Math.round(exp);
  const r = Math.min(Math.max(rng(), 0), 1);
  // r in [0,1] → multiplier in [1 - jitter, 1 + jitter]
  const multiplier = 1 + policy.jitterPct * (2 * r - 1);
  return Math.round(Math.min(exp * multiplier, policy.maxBackoffMs));
}

/**
 * Decide whether to retry given a classification result and the count of
 * attempts already completed (1-based: a value of 1 means attempt #1 just
 * finished and we may try attempt #2).
 */
export function shouldRetry(
  classification: HarnessFailureClassification,
  attemptsCompleted: number,
  policy: HarnessRetryPolicy,
): boolean {
  if (attemptsCompleted >= policy.maxAttempts) return false;

  // Empty-result: gated by retryEmptyResult toggle.
  if (classification.kind === 'harness_empty_result') {
    return policy.retryEmptyResult === true && classification.retryable === true;
  }

  // Bare non-zero exit: only allowed once, when explicitly enabled.
  if (classification.kind === 'harness_process_exit') {
    if (!policy.retryUnknownProcessExitOnce) return false;
    return attemptsCompleted === 1;
  }

  return classification.retryable === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code-review hardening (2026-05-31)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MEDIUM-2 (2026-05-31): thinking_block_400 is a corrupted-latest-turn
 * session error. Reusing the same session resume guarantees the next
 * attempt hits the same 400. This override fires regardless of the
 * operator's `clearSessionOnRetry` config so the knob cannot disable
 * the single most important transient-recovery path.
 *
 * Pass `prevClassification = null` to mean "no prior attempt" (the
 * first attempt of a query); in that case the policy is consulted.
 */
export function shouldClearSessionOnRetry(
  prevClassification: HarnessFailureClassification | null,
  policy: HarnessRetryPolicy,
): boolean {
  if (prevClassification?.kind === 'thinking_block_400') return true;
  return policy.clearSessionOnRetry === true;
}

/**
 * HIGH-1 (2026-05-31): conservative heuristic for whether the incoming
 * prompt is a build dispatch carrying repo+branch metadata. False
 * positives mean "no retry" (safe direction); false negatives are
 * caught by the per-attempt mutating-tool-use gate.
 *
 * Build dispatches must NOT be auto-retried because a transient on a
 * continuation turn (thinking_block_400 in particular) can fire after
 * the agent has already run git push / promote-to-main / /agent-done,
 * which would then re-execute on retry → double merge/push, duplicate
 * promotion, duplicate /agent-done.
 */
export function looksLikeBuildDispatch(prompt: string): boolean {
  if (!prompt) return false;
  // The dispatch metadata block in build prompts is consistently shaped
  // as `REPO: <path>` and `BRANCH: <name>` lines. Match against the
  // word-boundary + colon shape rather than the bare words to avoid
  // catching casual mentions of "repo" or "branch".
  const hasRepoLine = /(^|\s|\b)REPO:\s+\S+/.test(prompt);
  const hasBranchLine = /(^|\s|\b)BRANCH:\s+\S+/.test(prompt);
  if (hasRepoLine && hasBranchLine) return true;
  // Even without explicit REPO/BRANCH lines, an explicit mention of the
  // canonical promotion helper marks this as a build dispatch.
  if (/promote-to-main/i.test(prompt)) return true;
  return false;
}

export interface RetryGateContext {
  /** Whether any mutating tool (Bash/Edit/Write/NotebookEdit) ran during the just-completed attempt. */
  mutatingToolUseObserved: boolean;
  /** Whether this dispatch is a build dispatch (carries repo+branch metadata). */
  isBuildDispatch: boolean;
}

export type RetryDecisionReason =
  | 'allowed'
  | 'attempts_exhausted'
  | 'not_retryable'
  | 'mutating_tool_observed'
  | 'build_dispatch';

export interface RetryDecision {
  retry: boolean;
  reason: RetryDecisionReason;
}

/**
 * HIGH-1 retry gate combining the existing `shouldRetry` predicate with
 * the post-side-effect safety check. Caller is the agent server's retry
 * loop; pure function.
 *
 * Precedence (most specific first):
 *   1. build_dispatch     → never retry (spec-required conservative target)
 *   2. mutating_tool_observed → don't retry; the agent may have already
 *      committed/pushed/promoted/agent-done'd and a fresh-session re-run
 *      would double-execute
 *   3. attempts_exhausted / not_retryable → existing shouldRetry gate
 *   4. allowed → proceed with retry
 */
export function evaluateRetry(
  classification: HarnessFailureClassification,
  attemptsCompleted: number,
  policy: HarnessRetryPolicy,
  context: RetryGateContext = { mutatingToolUseObserved: false, isBuildDispatch: false },
): RetryDecision {
  if (context.isBuildDispatch) return { retry: false, reason: 'build_dispatch' };
  if (context.mutatingToolUseObserved) return { retry: false, reason: 'mutating_tool_observed' };
  if (attemptsCompleted >= policy.maxAttempts) return { retry: false, reason: 'attempts_exhausted' };
  if (!shouldRetry(classification, attemptsCompleted, policy)) {
    return { retry: false, reason: 'not_retryable' };
  }
  return { retry: true, reason: 'allowed' };
}

/**
 * Tools considered mutating for the retry-safety gate. Bash is included
 * even for read-only invocations (`ls`, `pwd`) because we cannot
 * introspect its input without parsing — we trade off auto-recovery on
 * benign Bash uses for safety against duplicate side effects.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
]);

export function isMutatingTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  return MUTATING_TOOL_NAMES.has(toolName);
}
