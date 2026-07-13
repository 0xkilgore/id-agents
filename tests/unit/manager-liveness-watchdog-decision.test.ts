// SPDX-License-Identifier: MIT
//
// Manager HTTP liveness watchdog decision tests. Keep these pure and small so
// the external watchdog can be changed without needing a live launchd manager.

import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM module (no d.ts); imported for runtime behavior.
import {
  decideManagerLivenessWatchdog,
  ESCALATION_WINDOW_MS,
  HTTP_FAILURE_THRESHOLD,
  RECOVERY_BUDGET_MS,
  RESTART_COOLDOWN_MS,
} from '../../scripts/lib/manager-liveness-watchdog-decision.mjs';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');

function decision(overrides = {}) {
  return decideManagerLivenessWatchdog({
    healthOk: true,
    healthTimedOut: false,
    healthLatencyMs: 35,
    dispatchHealthOk: true,
    dispatchHealthTimedOut: false,
    dispatchHealthLatencyMs: 40,
    listenerPid: 1234,
    launchdPid: 1234,
    priorConsecutiveFailures: 1,
    priorRestartAt: null,
    pauseFileExists: false,
    nowMs: NOW,
    ...overrides,
  });
}

describe('decideManagerLivenessWatchdog', () => {
  it('resets the HTTP failure streak when /health is healthy within budget', () => {
    const d = decision();

    expect(d.action).toBe('noop');
    expect(d.class).toBe('healthy');
    expect(d.nextConsecutiveFailures).toBe(0);
  });

  it('classifies a /dispatches/health timeout as degraded, not restart-worthy', () => {
    const d = decision({
      dispatchHealthOk: false,
      dispatchHealthTimedOut: true,
      dispatchHealthLatencyMs: null,
    });

    expect(d.action).toBe('wait');
    expect(d.class).toBe('degraded_db_route');
    expect(d.nextConsecutiveFailures).toBe(0);
  });

  it('waits on the first /health timeout while a listener is alive', () => {
    const d = decision({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorConsecutiveFailures: 0,
      listenerPid: 4321,
    });

    expect(d.action).toBe('wait');
    expect(d.class).toBe('http_unresponsive_listener_alive');
    expect(d.nextConsecutiveFailures).toBe(1);
  });

  it('chooses diagnostics plus restart after two listener-alive HTTP failures', () => {
    const d = decision({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorConsecutiveFailures: HTTP_FAILURE_THRESHOLD - 1,
      listenerPid: 4321,
    });

    expect(d.action).toBe('diagnose_restart');
    expect(d.class).toBe('http_unresponsive_listener_alive');
    expect(d.nextConsecutiveFailures).toBe(HTTP_FAILURE_THRESHOLD);
  });

  it('classifies a missing listener as manager_down', () => {
    const d = decision({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorConsecutiveFailures: 0,
      listenerPid: null,
      launchdPid: null,
    });

    expect(d.action).toBe('wait');
    expect(d.class).toBe('manager_down');
  });

  it('pauses without resetting the existing failure streak', () => {
    const d = decision({
      pauseFileExists: true,
      priorConsecutiveFailures: 3,
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
    });

    expect(d.action).toBe('noop');
    expect(d.class).toBe('paused');
    expect(d.nextConsecutiveFailures).toBe(3);
  });

  it('enforces restart cooldown after a recent restart', () => {
    const d = decision({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorRestartAt: new Date(NOW - 30_000).toISOString(),
      priorConsecutiveFailures: 5,
    });

    expect(d.action).toBe('wait');
    expect(d.class).toBe('restart_cooldown');
    expect(d.reason).toMatch(String(Math.round((RESTART_COOLDOWN_MS - 30_000) / 1000)));
  });

  it('escalates when the recovery budget is exceeded after restart', () => {
    const d = decision({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorRestartAt: new Date(NOW - RECOVERY_BUDGET_MS).toISOString(),
      priorConsecutiveFailures: 5,
    });

    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/recovery budget/);
  });

  it('escalates after two restart attempts inside ten minutes', () => {
    const d = decision({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorRestartAttempts: [
        new Date(NOW - ESCALATION_WINDOW_MS + 1000).toISOString(),
        new Date(NOW - 1000).toISOString(),
      ],
    });

    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/2 restart attempts/);
  });

  it('treats a successful but slow /health response as an HTTP liveness failure', () => {
    const d = decision({
      healthOk: true,
      healthTimedOut: false,
      healthLatencyMs: 2500,
      priorConsecutiveFailures: HTTP_FAILURE_THRESHOLD - 1,
    });

    expect(d.action).toBe('diagnose_restart');
    expect(d.class).toBe('http_unresponsive_listener_alive');
  });
});
