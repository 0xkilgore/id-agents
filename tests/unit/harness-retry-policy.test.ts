// Tests for the harness retry-policy module (Spec: 2026-05-29-harness-resilience-spec.md).
//
// Policy = defaults + env parsing + bounded backoff with jitter. The retry
// LOOP itself lives in src/claude-agent-server.ts; this module is the pure
// policy/config layer.

import { describe, it, expect } from 'vitest';
import {
  HARNESS_RETRY_DEFAULTS,
  loadHarnessRetryPolicy,
  computeBackoffMs,
  shouldRetry,
  shouldClearSessionOnRetry,
  evaluateRetry,
  looksLikeBuildDispatch,
  type HarnessRetryPolicy,
} from '../../src/harness/retry-policy.js';
import type { HarnessFailureClassification } from '../../src/harness/transient-errors.js';

function cls(
  overrides: Partial<HarnessFailureClassification> = {},
): HarnessFailureClassification {
  return {
    kind: 'thinking_block_400',
    retryable: true,
    terminalFailureKind: 'model_api_error_exhausted',
    confidence: 'high',
    reason: 'test',
    redactedMessage: 'test',
    ...overrides,
  };
}

describe('HARNESS_RETRY_DEFAULTS', () => {
  it('matches spec defaults', () => {
    expect(HARNESS_RETRY_DEFAULTS.maxAttempts).toBe(3);
    expect(HARNESS_RETRY_DEFAULTS.initialBackoffMs).toBe(5_000);
    expect(HARNESS_RETRY_DEFAULTS.maxBackoffMs).toBe(60_000);
    expect(HARNESS_RETRY_DEFAULTS.jitterPct).toBeCloseTo(0.2);
    expect(HARNESS_RETRY_DEFAULTS.retryEmptyResult).toBe(true);
    expect(HARNESS_RETRY_DEFAULTS.retryUnknownProcessExitOnce).toBe(false);
    expect(HARNESS_RETRY_DEFAULTS.clearSessionOnRetry).toBe(true);
  });
});

describe('loadHarnessRetryPolicy — defaults & env parsing', () => {
  it('returns defaults when env is empty', () => {
    const p = loadHarnessRetryPolicy({});
    expect(p).toEqual(HARNESS_RETRY_DEFAULTS);
  });

  it('parses HARNESS_TRANSIENT_MAX_ATTEMPTS', () => {
    const p = loadHarnessRetryPolicy({ HARNESS_TRANSIENT_MAX_ATTEMPTS: '5' });
    expect(p.maxAttempts).toBe(5);
  });

  it('parses backoff initial/max', () => {
    const p = loadHarnessRetryPolicy({
      HARNESS_TRANSIENT_BACKOFF_INITIAL_MS: '1000',
      HARNESS_TRANSIENT_BACKOFF_MAX_MS: '20000',
    });
    expect(p.initialBackoffMs).toBe(1000);
    expect(p.maxBackoffMs).toBe(20000);
  });

  it('parses jitter percentage', () => {
    const p = loadHarnessRetryPolicy({ HARNESS_TRANSIENT_JITTER_PCT: '0.5' });
    expect(p.jitterPct).toBeCloseTo(0.5);
  });

  it('parses boolean toggles', () => {
    const p = loadHarnessRetryPolicy({
      HARNESS_RETRY_EMPTY_RESULT: 'false',
      HARNESS_RETRY_UNKNOWN_PROCESS_EXIT_ONCE: 'true',
      HARNESS_CLEAR_SESSION_ON_TRANSIENT_RETRY: 'false',
    });
    expect(p.retryEmptyResult).toBe(false);
    expect(p.retryUnknownProcessExitOnce).toBe(true);
    expect(p.clearSessionOnRetry).toBe(false);
  });
});

describe('loadHarnessRetryPolicy — clamping invalid values', () => {
  it('clamps maxAttempts to >=1', () => {
    const p = loadHarnessRetryPolicy({ HARNESS_TRANSIENT_MAX_ATTEMPTS: '0' });
    expect(p.maxAttempts).toBe(1);
  });

  it('clamps maxAttempts to a sane ceiling (<=10)', () => {
    const p = loadHarnessRetryPolicy({ HARNESS_TRANSIENT_MAX_ATTEMPTS: '99999' });
    expect(p.maxAttempts).toBeLessThanOrEqual(10);
  });

  it('falls back to default on non-numeric input', () => {
    const p = loadHarnessRetryPolicy({ HARNESS_TRANSIENT_MAX_ATTEMPTS: 'abc' });
    expect(p.maxAttempts).toBe(HARNESS_RETRY_DEFAULTS.maxAttempts);
  });

  it('clamps initialBackoffMs to >=0', () => {
    const p = loadHarnessRetryPolicy({ HARNESS_TRANSIENT_BACKOFF_INITIAL_MS: '-500' });
    expect(p.initialBackoffMs).toBeGreaterThanOrEqual(0);
  });

  it('clamps initialBackoffMs <= maxBackoffMs after clamping', () => {
    const p = loadHarnessRetryPolicy({
      HARNESS_TRANSIENT_BACKOFF_INITIAL_MS: '120000',
      HARNESS_TRANSIENT_BACKOFF_MAX_MS: '60000',
    });
    expect(p.initialBackoffMs).toBeLessThanOrEqual(p.maxBackoffMs);
  });

  it('clamps jitter to [0, 1]', () => {
    expect(loadHarnessRetryPolicy({ HARNESS_TRANSIENT_JITTER_PCT: '-1' }).jitterPct).toBe(0);
    expect(loadHarnessRetryPolicy({ HARNESS_TRANSIENT_JITTER_PCT: '5' }).jitterPct).toBe(1);
  });
});

describe('computeBackoffMs — exponential backoff with jitter', () => {
  // Deterministic test by passing rng=()=>0 and rng=()=>1.
  const policy: HarnessRetryPolicy = {
    ...HARNESS_RETRY_DEFAULTS,
    initialBackoffMs: 1000,
    maxBackoffMs: 60000,
    jitterPct: 0.2,
  };

  it('attempt 1 backoff equals initial * 1 (with zero jitter)', () => {
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(800); // 1000 * (1 - 0.2)
  });

  it('attempt 2 backoff doubles (exponential growth)', () => {
    expect(computeBackoffMs(policy, 2, () => 0)).toBe(1600); // 2000 * (1 - 0.2)
  });

  it('attempt 3 backoff quadruples', () => {
    expect(computeBackoffMs(policy, 3, () => 0)).toBe(3200); // 4000 * (1 - 0.2)
  });

  it('caps at maxBackoffMs', () => {
    const big: HarnessRetryPolicy = { ...policy, initialBackoffMs: 30_000, maxBackoffMs: 60_000 };
    // attempt 5 would be 30k * 16 = 480k, must cap.
    const v = computeBackoffMs(big, 5, () => 0.5);
    expect(v).toBeLessThanOrEqual(big.maxBackoffMs);
  });

  it('jitter widens the window: rng=1 yields max-side, rng=0 yields min-side', () => {
    const low = computeBackoffMs(policy, 1, () => 0);
    const high = computeBackoffMs(policy, 1, () => 1);
    expect(high).toBeGreaterThan(low);
    // Range = [base*(1-jit), base*(1+jit)] = [800, 1200]
    expect(low).toBe(800);
    expect(high).toBe(1200);
  });

  it('returns 0 when initial backoff is 0', () => {
    const zero: HarnessRetryPolicy = { ...policy, initialBackoffMs: 0 };
    expect(computeBackoffMs(zero, 1, () => 0.5)).toBe(0);
    expect(computeBackoffMs(zero, 3, () => 0.5)).toBe(0);
  });
});

describe('shouldRetry — combines classification + policy', () => {
  const baseAttempts = HARNESS_RETRY_DEFAULTS.maxAttempts;

  it('retries a transient thinking-block-400 while attempts remain', () => {
    expect(shouldRetry(cls(), 1, HARNESS_RETRY_DEFAULTS)).toBe(true);
    expect(shouldRetry(cls(), 2, HARNESS_RETRY_DEFAULTS)).toBe(true);
    // At attempt = maxAttempts, no further retries.
    expect(shouldRetry(cls(), baseAttempts, HARNESS_RETRY_DEFAULTS)).toBe(false);
  });

  it('does NOT retry terminal classifications (auth_or_plan)', () => {
    expect(
      shouldRetry(cls({ kind: 'auth_or_plan', retryable: false, terminalFailureKind: 'agent_error' }), 1, HARNESS_RETRY_DEFAULTS),
    ).toBe(false);
  });

  it('does NOT retry user_code_failure', () => {
    expect(
      shouldRetry(cls({ kind: 'user_code_failure', retryable: false, terminalFailureKind: 'agent_error' }), 1, HARNESS_RETRY_DEFAULTS),
    ).toBe(false);
  });

  it('respects retryEmptyResult toggle', () => {
    const c = cls({ kind: 'harness_empty_result', terminalFailureKind: 'harness_empty_result_exhausted' });
    expect(shouldRetry(c, 1, { ...HARNESS_RETRY_DEFAULTS, retryEmptyResult: true })).toBe(true);
    expect(shouldRetry(c, 1, { ...HARNESS_RETRY_DEFAULTS, retryEmptyResult: false })).toBe(false);
  });

  it('allows one-shot harness_process_exit retry only when retryUnknownProcessExitOnce=true', () => {
    const c = cls({ kind: 'harness_process_exit', retryable: false, terminalFailureKind: 'harness_process_error_exhausted' });
    // default policy: never retry
    expect(shouldRetry(c, 1, HARNESS_RETRY_DEFAULTS)).toBe(false);
    // opted-in policy: retry at attempt 1 only
    const p = { ...HARNESS_RETRY_DEFAULTS, retryUnknownProcessExitOnce: true };
    expect(shouldRetry(c, 1, p)).toBe(true);
    expect(shouldRetry(c, 2, p)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Code-review hardening (2026-05-31)
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldClearSessionOnRetry — thinking_block_400 footgun guard (MEDIUM-2)', () => {
  it('returns policy.clearSessionOnRetry for normal transients', () => {
    const overload = cls({ kind: 'provider_overloaded', terminalFailureKind: 'model_api_error_exhausted' });
    expect(shouldClearSessionOnRetry(overload, { ...HARNESS_RETRY_DEFAULTS, clearSessionOnRetry: true })).toBe(true);
    expect(shouldClearSessionOnRetry(overload, { ...HARNESS_RETRY_DEFAULTS, clearSessionOnRetry: false })).toBe(false);
  });

  it('FORCES session-clear for thinking_block_400 even when policy says false', () => {
    const tb = cls({ kind: 'thinking_block_400', terminalFailureKind: 'model_api_error_exhausted' });
    // The session itself is corrupted; reusing the resume guarantees the
    // next attempt hits the same 400. The operator's
    // HARNESS_CLEAR_SESSION_ON_TRANSIENT_RETRY=false override must NOT
    // disable this safety.
    expect(shouldClearSessionOnRetry(tb, { ...HARNESS_RETRY_DEFAULTS, clearSessionOnRetry: false })).toBe(true);
    expect(shouldClearSessionOnRetry(tb, { ...HARNESS_RETRY_DEFAULTS, clearSessionOnRetry: true })).toBe(true);
  });

  it('null classification (no prior attempt) falls back to policy', () => {
    expect(shouldClearSessionOnRetry(null, { ...HARNESS_RETRY_DEFAULTS, clearSessionOnRetry: false })).toBe(false);
    expect(shouldClearSessionOnRetry(null, { ...HARNESS_RETRY_DEFAULTS, clearSessionOnRetry: true })).toBe(true);
  });
});

describe('looksLikeBuildDispatch — HIGH-1 build-dispatch prompt heuristic', () => {
  it('detects build-dispatch markers (REPO + BRANCH lines + promote-to-main)', () => {
    const prompt = `BUILD DISPATCH — fix bug.

REPO: /Users/x/foo
BRANCH: feat-bar

PROMOTION (Spec 054 v2, required): id-agents promote-to-main --repo ...
`;
    expect(looksLikeBuildDispatch(prompt)).toBe(true);
  });

  it('detects build dispatch when REPO+BRANCH appear but no promote-to-main mention', () => {
    const prompt = `Please look at REPO: /tmp/foo and BRANCH: main and tell me about it.`;
    // Conservative: REPO + BRANCH co-occurrence alone is enough to suppress retries.
    expect(looksLikeBuildDispatch(prompt)).toBe(true);
  });

  it('does NOT match a generic spec-only dispatch (no REPO/BRANCH)', () => {
    const prompt = `Read this spec and produce a markdown analysis. Save to ./output/foo.md.`;
    expect(looksLikeBuildDispatch(prompt)).toBe(false);
  });

  it('does NOT match casual mentions of "repo" or "branch" without the metadata shape', () => {
    const prompt = `I want to talk about your favorite git branch and your repo of choice.`;
    expect(looksLikeBuildDispatch(prompt)).toBe(false);
  });

  it('matches a prompt that mentions promote-to-main even without explicit REPO line', () => {
    const prompt = `Once verified, run id-agents promote-to-main with strategy auto.`;
    expect(looksLikeBuildDispatch(prompt)).toBe(true);
  });
});

describe('evaluateRetry — mutation-aware retry gate (HIGH-1)', () => {
  const transient = cls({ kind: 'provider_overloaded', terminalFailureKind: 'model_api_error_exhausted' });

  it('allows retry on a clean retryable transient with no mutating side effects + non-build', () => {
    const dec = evaluateRetry(transient, 1, HARNESS_RETRY_DEFAULTS, {
      mutatingToolUseObserved: false,
      isBuildDispatch: false,
    });
    expect(dec.retry).toBe(true);
    expect(dec.reason).toBe('allowed');
  });

  it('blocks retry when a mutating tool already ran this attempt', () => {
    const dec = evaluateRetry(transient, 1, HARNESS_RETRY_DEFAULTS, {
      mutatingToolUseObserved: true,
      isBuildDispatch: false,
    });
    expect(dec.retry).toBe(false);
    expect(dec.reason).toBe('mutating_tool_observed');
  });

  it('blocks retry for build dispatches even with no observed mutation', () => {
    const dec = evaluateRetry(transient, 1, HARNESS_RETRY_DEFAULTS, {
      mutatingToolUseObserved: false,
      isBuildDispatch: true,
    });
    expect(dec.retry).toBe(false);
    expect(dec.reason).toBe('build_dispatch');
  });

  it('reports attempts_exhausted at the maxAttempts ceiling', () => {
    const dec = evaluateRetry(transient, HARNESS_RETRY_DEFAULTS.maxAttempts, HARNESS_RETRY_DEFAULTS, {
      mutatingToolUseObserved: false,
      isBuildDispatch: false,
    });
    expect(dec.retry).toBe(false);
    expect(dec.reason).toBe('attempts_exhausted');
  });

  it('reports not_retryable for terminal classifications', () => {
    const terminal = cls({ kind: 'user_code_failure', retryable: false, terminalFailureKind: 'agent_error' });
    const dec = evaluateRetry(terminal, 1, HARNESS_RETRY_DEFAULTS, {
      mutatingToolUseObserved: false,
      isBuildDispatch: false,
    });
    expect(dec.retry).toBe(false);
    expect(dec.reason).toBe('not_retryable');
  });

  it('build_dispatch + mutating_tool prefer build_dispatch in the reason (more specific)', () => {
    const dec = evaluateRetry(transient, 1, HARNESS_RETRY_DEFAULTS, {
      mutatingToolUseObserved: true,
      isBuildDispatch: true,
    });
    expect(dec.retry).toBe(false);
    expect(dec.reason).toBe('build_dispatch');
  });
});
