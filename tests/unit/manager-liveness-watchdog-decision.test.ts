import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM module (no d.ts); imported for runtime behavior.
import {
  decideManagerLivenessWatchdog,
  RECOVERY_BUDGET_MS,
} from '../../scripts/lib/manager-liveness-watchdog-decision.mjs';

const nowMs = Date.parse('2026-07-13T12:00:00.000Z');

function decide(overrides = {}) {
  return decideManagerLivenessWatchdog({
    healthOk: true,
    healthTimedOut: false,
    healthLatencyMs: 42,
    dispatchHealthOk: true,
    dispatchHealthTimedOut: false,
    dispatchHealthLatencyMs: 55,
    listenerPid: 123,
    launchdPid: 123,
    priorConsecutiveFailures: 0,
    priorRestartAt: null,
    pauseFileExists: false,
    nowMs,
    ...overrides,
  });
}

describe('manager liveness watchdog decision', () => {
  it('resets the HTTP failure streak when /health is fast and valid', () => {
    expect(decide({ priorConsecutiveFailures: 4 })).toMatchObject({
      action: 'noop',
      class: 'healthy',
      nextConsecutiveFailures: 0,
    });
  });

  it('treats DB-route-only timeout as degraded without restart', () => {
    expect(decide({
      dispatchHealthOk: false,
      dispatchHealthTimedOut: true,
      dispatchHealthLatencyMs: null,
      priorConsecutiveFailures: 2,
    })).toMatchObject({
      action: 'wait',
      class: 'degraded_db_route',
      nextConsecutiveFailures: 0,
    });
  });

  it('waits on first listener-alive HTTP timeout and restarts on the second', () => {
    expect(decide({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorConsecutiveFailures: 0,
      listenerPid: 456,
    })).toMatchObject({
      action: 'wait',
      class: 'http_unresponsive_listener_alive',
      nextConsecutiveFailures: 1,
    });

    expect(decide({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorConsecutiveFailures: 1,
      listenerPid: 456,
    })).toMatchObject({
      action: 'diagnose_restart',
      class: 'http_unresponsive_listener_alive',
      nextConsecutiveFailures: 2,
    });
  });

  it('classifies no-listener HTTP failure as manager_down', () => {
    expect(decide({
      healthOk: false,
      healthTimedOut: true,
      healthLatencyMs: null,
      priorConsecutiveFailures: 1,
      listenerPid: null,
      launchdPid: null,
    })).toMatchObject({
      action: 'diagnose_restart',
      class: 'manager_down',
    });
  });

  it('pause file wins and preserves the prior streak', () => {
    expect(decide({
      pauseFileExists: true,
      healthOk: false,
      healthTimedOut: true,
      priorConsecutiveFailures: 3,
    })).toMatchObject({
      action: 'noop',
      class: 'paused',
      nextConsecutiveFailures: 3,
    });
  });

  it('holds restart cooldown before looping', () => {
    const priorRestartAt = new Date(nowMs - 30_000).toISOString();
    expect(decide({
      healthOk: false,
      healthTimedOut: true,
      priorConsecutiveFailures: 5,
      priorRestartAt,
    })).toMatchObject({
      action: 'wait',
      class: 'restart_cooldown',
    });
  });

  it('escalates when recovery budget is exceeded after a restart', () => {
    const priorRestartAt = new Date(nowMs - RECOVERY_BUDGET_MS - 1).toISOString();
    expect(decide({
      healthOk: false,
      healthTimedOut: true,
      priorConsecutiveFailures: 5,
      priorRestartAt,
    })).toMatchObject({
      action: 'escalate',
      class: 'http_unresponsive_listener_alive',
    });
  });

  it('escalates after two restart attempts inside ten minutes', () => {
    expect(decide({
      healthOk: false,
      healthTimedOut: true,
      priorConsecutiveFailures: 5,
      priorRestartAttempts: [
        new Date(nowMs - 9 * 60 * 1000).toISOString(),
        new Date(nowMs - 2 * 60 * 1000).toISOString(),
      ],
    })).toMatchObject({
      action: 'escalate',
    });
  });
});
