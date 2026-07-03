// Tests for the harness transient-error classifier (Spec: 2026-05-29-harness-resilience-spec.md).
//
// The classifier is the conservative gate that decides whether a failure
// inside an in-flight harness run is a model/API/runtime transient (retryable)
// or a real semantic failure (terminal). When uncertain, classify TERMINAL.
//
// Do not retry: auth/billing/plan, content-filter, real build/test failures,
// promotion conflicts, /agent-needs-input, and unknown errors by default.

import { describe, it, expect } from 'vitest';
import {
  classifyHarnessFailure,
  redactSecrets,
} from '../../src/harness/transient-errors.js';
import { HANG_TIMEOUT_MARKER } from '../../src/harness/process-timeout.js';

describe('classifyHarnessFailure — thinking-block 400 (Anthropic latest-turn corruption)', () => {
  it('matches the canonical 400 message with thinking blocks', () => {
    const message =
      "API Error: 400 messages.45.content.9: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('thinking_block_400');
    expect(c.retryable).toBe(true);
    expect(c.terminalFailureKind).toBe('model_api_error_exhausted');
    expect(c.confidence).toBe('high');
  });

  it('matches an alternate thinking-block phrasing referencing redacted_thinking', () => {
    const message =
      'Invalid request: redacted_thinking blocks cannot be modified in the latest assistant message';
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('thinking_block_400');
    expect(c.retryable).toBe(true);
  });

  it('does NOT match an unrelated 400 ("Invalid request") without thinking-block language', () => {
    const message = 'API Error: 400 Invalid request: malformed payload field foo';
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    // Must NOT be thinking_block_400 because the thinking signature is absent.
    expect(c.kind).not.toBe('thinking_block_400');
    expect(c.retryable).toBe(false);
  });
});

describe('classifyHarnessFailure — provider rate-limit (429)', () => {
  it('matches HTTP 429', () => {
    const message = 'API Error: 429 Too Many Requests';
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('provider_rate_limited');
    expect(c.retryable).toBe(true);
    expect(c.terminalFailureKind).toBe('model_api_error_exhausted');
  });

  it('matches "rate limit" prose without an HTTP code', () => {
    const message = 'Anthropic returned rate limit exceeded, please retry shortly';
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('provider_rate_limited');
    expect(c.retryable).toBe(true);
  });

  it('matches "concurrent request limit"', () => {
    const message = 'concurrent request limit reached for organization';
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('provider_rate_limited');
    expect(c.retryable).toBe(true);
  });
});

describe('classifyHarnessFailure — provider overload (529/503/capacity)', () => {
  it('matches HTTP 529', () => {
    const c = classifyHarnessFailure({ message: 'API Error: 529 overloaded', source: 'harness_error_message' });
    expect(c.kind).toBe('provider_overloaded');
    expect(c.retryable).toBe(true);
  });

  it('matches HTTP 503 with capacity-style text', () => {
    const c = classifyHarnessFailure({
      message: 'API Error: 503 server is temporarily limiting requests',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_overloaded');
    expect(c.retryable).toBe(true);
  });

  it('matches "temporarily unavailable due to capacity"', () => {
    const c = classifyHarnessFailure({
      message: 'service is temporarily unavailable due to capacity',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_overloaded');
    expect(c.retryable).toBe(true);
  });

  // Code-review MEDIUM-1 (2026-05-31): tighten over-broad phrases so an
  // agent's free-form final text cannot mis-classify a TERMINAL failure as
  // retryable.
  it('does NOT match the bare word "capacity" without provider/HTTP context', () => {
    const c = classifyHarnessFailure({
      message: 'this build needs more disk capacity to compile',
      source: 'harness_error_message',
    });
    expect(c.kind).not.toBe('provider_overloaded');
    expect(c.retryable).toBe(false);
  });

  it('does NOT match the bare phrase "try again later" without provider/HTTP context', () => {
    const c = classifyHarnessFailure({
      message: "I couldn't finish that — will need to try again later",
      source: 'harness_error_message',
    });
    expect(c.kind).not.toBe('provider_overloaded');
    expect(c.retryable).toBe(false);
  });

  it('still matches an HTTP 5xx with provider-shaped overload language', () => {
    const c = classifyHarnessFailure({
      message: 'API Error: 503 server temporarily unavailable — try again later',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_overloaded');
    expect(c.retryable).toBe(true);
  });
});

describe('classifyHarnessFailure — timeouts & network transport', () => {
  it('classifies ETIMEDOUT as provider_timeout', () => {
    const c = classifyHarnessFailure({
      message: 'connect ETIMEDOUT 1.2.3.4:443',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_timeout');
    expect(c.retryable).toBe(true);
  });

  it('classifies "request timed out" as provider_timeout', () => {
    const c = classifyHarnessFailure({
      message: 'fetch failed: request timed out after 60s',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_timeout');
    expect(c.retryable).toBe(true);
  });

  it('classifies ECONNRESET / EPIPE / socket hang up as network_transport', () => {
    for (const message of ['ECONNRESET', 'write EPIPE', 'socket hang up']) {
      const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
      expect(c.kind).toBe('network_transport');
      expect(c.retryable).toBe(true);
    }
  });
});

describe('classifyHarnessFailure — harness hang-timeout watchdog (2026-07-03)', () => {
  it('classifies a claude-code-cli watchdog kill distinctly from a generic provider timeout', () => {
    const message = `Claude CLI timed out after 1800000ms (${HANG_TIMEOUT_MARKER})`;
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('harness_hang_timeout');
    expect(c.retryable).toBe(true);
    expect(c.terminalFailureKind).toBe('harness_hang_timeout_exhausted');
    expect(c.confidence).toBe('high');
  });

  it('classifies a codex hang-timeout kill', () => {
    const message = `Codex CLI timed out after 1800000ms (${HANG_TIMEOUT_MARKER})`;
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('harness_hang_timeout');
    expect(c.retryable).toBe(true);
  });

  it('classifies a cursor-cli hang-timeout kill', () => {
    const message = `Cursor CLI timed out after 1800000ms (${HANG_TIMEOUT_MARKER})`;
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('harness_hang_timeout');
    expect(c.retryable).toBe(true);
  });

  it('a generic provider timeout WITHOUT the hang-timeout marker still falls into provider_timeout', () => {
    const message = 'API Error: request timed out after 60s';
    const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
    expect(c.kind).toBe('provider_timeout');
    expect(c.kind).not.toBe('harness_hang_timeout');
  });
});

describe('classifyHarnessFailure — empty result', () => {
  it('matches the exact server-side empty-result string', () => {
    const c = classifyHarnessFailure({
      message: 'Claude Code produced an empty result',
      source: 'empty_result',
      runtime: 'claude-code-cli',
    });
    expect(c.kind).toBe('harness_empty_result');
    expect(c.retryable).toBe(true);
    expect(c.terminalFailureKind).toBe('harness_empty_result_exhausted');
  });

  it('matches Codex empty result string', () => {
    const c = classifyHarnessFailure({
      message: 'Codex produced an empty result',
      source: 'empty_result',
      runtime: 'codex',
    });
    expect(c.kind).toBe('harness_empty_result');
    expect(c.retryable).toBe(true);
  });
});

describe('classifyHarnessFailure — non-zero process exit', () => {
  it('classifies non-zero exit with overload stderr as retryable provider_overloaded', () => {
    const c = classifyHarnessFailure({
      message: 'Claude CLI exited with code 1',
      stderr: 'API Error: 529 overloaded',
      exitCode: 1,
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_overloaded');
    expect(c.retryable).toBe(true);
  });

  it('does NOT retry bare non-zero exit without a retryable signal', () => {
    const c = classifyHarnessFailure({
      message: 'Claude CLI exited with code 1',
      stderr: '',
      exitCode: 1,
      source: 'harness_error_message',
    });
    // Default policy: harness_process_exit is NOT retried unless explicitly enabled.
    expect(c.kind).toBe('harness_process_exit');
    expect(c.retryable).toBe(false);
    expect(c.terminalFailureKind).toBe('harness_process_error_exhausted');
  });

  it('does NOT retry non-zero exit caused by user-code failure (npm test failed)', () => {
    const c = classifyHarnessFailure({
      message: 'Claude CLI exited with code 1',
      stderr: 'npm test failed: 3 of 42 tests failing',
      exitCode: 1,
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('user_code_failure');
    expect(c.retryable).toBe(false);
    expect(c.terminalFailureKind).toBe('agent_error');
  });
});

describe('classifyHarnessFailure — terminal-always failures', () => {
  it('classifies 401 / invalid api key as auth_or_plan (TERMINAL)', () => {
    for (const message of [
      'API Error: 401 invalid api key',
      'Error: unauthorized — please sign in',
      '402 Payment Required: credit balance exhausted',
      '403 plan does not include the requested model',
      'quota exceeded for this organization',
    ]) {
      const c = classifyHarnessFailure({ message, source: 'harness_error_message' });
      expect(c.kind).toBe('auth_or_plan');
      expect(c.retryable).toBe(false);
      expect(c.terminalFailureKind).toBe('agent_error');
    }
  });

  it('classifies content-filter language as content_filter (TERMINAL for the dispatch)', () => {
    const c = classifyHarnessFailure({
      message: 'Output was blocked by content filtering policy',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('content_filter');
    expect(c.retryable).toBe(false);
  });

  it('classifies "tests failed" prose as user_code_failure (TERMINAL)', () => {
    const c = classifyHarnessFailure({
      message: 'tests failed: 5 of 17 vitest cases red',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('user_code_failure');
    expect(c.retryable).toBe(false);
  });

  it('classifies promotion / merge conflict prose as promotion_failure (TERMINAL)', () => {
    const c = classifyHarnessFailure({
      message: 'promotion failed: merge conflict in src/foo.ts',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('promotion_failure');
    expect(c.retryable).toBe(false);
  });

  it('classifies completely unknown text as unknown / TERMINAL by default (conservative)', () => {
    const c = classifyHarnessFailure({
      message: 'something weird happened that we have never seen before xyzzy',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('unknown');
    expect(c.retryable).toBe(false);
    expect(c.terminalFailureKind).toBe('agent_error');
  });
});

describe('classifyHarnessFailure — conservatism rules', () => {
  it('when text looks like BOTH transient and terminal, prefers terminal', () => {
    // Real test failure text plus an overload-ish phrase — must stay terminal.
    const c = classifyHarnessFailure({
      message: 'tests failed (3/17) — also the server was briefly overloaded',
      source: 'harness_error_message',
    });
    // user_code_failure wins.
    expect(c.kind).toBe('user_code_failure');
    expect(c.retryable).toBe(false);
  });

  it('empty message is unknown / terminal', () => {
    const c = classifyHarnessFailure({ message: '', source: 'harness_error_message' });
    expect(c.kind).toBe('unknown');
    expect(c.retryable).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('redacts Anthropic-style api keys', () => {
    const out = redactSecrets('Authorization: Bearer sk-ant-api03-AAABBBCCCDDDEEE-_xyz');
    expect(out).not.toContain('sk-ant-api03-AAABBBCCCDDDEEE-_xyz');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts generic Bearer tokens', () => {
    const out = redactSecrets('header: Authorization: Bearer abcdef1234567890ABCDEFGHIJK');
    expect(out).not.toContain('abcdef1234567890ABCDEFGHIJK');
    expect(out).toContain('[REDACTED]');
  });

  it('passes through messages with no secrets', () => {
    expect(redactSecrets('plain error message')).toBe('plain error message');
  });
});

describe('classifyHarnessFailure — redaction in output', () => {
  it('redactedMessage strips secrets but reason still classifies correctly', () => {
    const c = classifyHarnessFailure({
      message: 'API Error: 429 Too Many Requests (key=sk-ant-api03-SECRETKEY1234567890)',
      source: 'harness_error_message',
    });
    expect(c.kind).toBe('provider_rate_limited');
    expect(c.redactedMessage).not.toContain('sk-ant-api03-SECRETKEY1234567890');
  });
});
