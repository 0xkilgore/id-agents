// SPDX-License-Identifier: MIT
//
// T-DEPLOY.5 deploy-freshness watchdog — decision-logic unit tests (Chris's
// required cases: fresh→noop, one stale→wait, two stale→act, pause→noop).

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import {
  decideWatchdogAction,
  STALE_STATE,
  CONSECUTIVE_THRESHOLD,
  TARGET_STABLE_THRESHOLD,
} from '../../scripts/lib/deploy-watchdog-decision.mjs';

const SETTLED_TARGET = {
  targetSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  priorTargetSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  priorTargetStableCount: TARGET_STABLE_THRESHOLD - 1,
};

describe('decideWatchdogAction', () => {
  it('fresh → noop, streak reset to 0', () => {
    const d = decideWatchdogAction({ freshnessState: 'fresh', priorConsecutiveStale: 0, pauseFileExists: false, healthOk: true });
    expect(d.action).toBe('noop');
    expect(d.nextConsecutiveStale).toBe(0);
  });

  it('one stale_alerted (from 0) → wait, streak 1', () => {
    const d = decideWatchdogAction({ freshnessState: STALE_STATE, priorConsecutiveStale: 0, pauseFileExists: false, healthOk: true });
    expect(d.action).toBe('wait');
    expect(d.nextConsecutiveStale).toBe(1);
  });

  it('two consecutive stale_alerted (prior 1) → act, streak 2', () => {
    const d = decideWatchdogAction({
      freshnessState: STALE_STATE,
      priorConsecutiveStale: 1,
      pauseFileExists: false,
      healthOk: true,
      ...SETTLED_TARGET,
    });
    expect(d.action).toBe('act');
    expect(d.nextConsecutiveStale).toBe(CONSECUTIVE_THRESHOLD);
  });

  it('pause-file present → noop even when two-stale would otherwise act; streak preserved', () => {
    const d = decideWatchdogAction({ freshnessState: STALE_STATE, priorConsecutiveStale: 1, pauseFileExists: true, healthOk: true });
    expect(d.action).toBe('noop');
    expect(d.nextConsecutiveStale).toBe(1); // preserved, not reset
    expect(d.reason).toMatch(/paused/i);
  });

  it('health unreadable → noop, streak reset (no acting on a single blip)', () => {
    const d = decideWatchdogAction({ freshnessState: null, priorConsecutiveStale: 1, pauseFileExists: false, healthOk: false });
    expect(d.action).toBe('noop');
    expect(d.nextConsecutiveStale).toBe(0);
  });

  it('health unreadable after a prior action → act so failed closeout escalates visibly', () => {
    const d = decideWatchdogAction({
      freshnessState: null,
      priorConsecutiveStale: 2,
      pauseFileExists: false,
      healthOk: false,
      priorLastAction: 'act',
    });
    expect(d.action).toBe('act');
    expect(d.nextConsecutiveStale).toBe(2);
    expect(d.reason).toMatch(/health unreadable after prior watchdog action/);
  });

  it('missing deploy checkout → act immediately even before stale_alerted', () => {
    const d = decideWatchdogAction({
      freshnessState: 'stale',
      priorConsecutiveStale: 0,
      pauseFileExists: false,
      healthOk: true,
      deployCheckoutOk: false,
      managerPlistOk: true,
    });
    expect(d.action).toBe('act');
    expect(d.reason).toMatch(/deploy checkout missing/);
  });

  it('manager plist pointed away from deploy checkout → act immediately', () => {
    const d = decideWatchdogAction({
      freshnessState: 'fresh',
      priorConsecutiveStale: 0,
      pauseFileExists: false,
      healthOk: true,
      deployCheckoutOk: true,
      managerPlistOk: false,
    });
    expect(d.action).toBe('act');
    expect(d.reason).toMatch(/launchd plist/);
  });

  it('recovery: stale then fresh resets the streak so a later single stale only waits', () => {
    const stale1 = decideWatchdogAction({
      freshnessState: STALE_STATE,
      priorConsecutiveStale: 0,
      pauseFileExists: false,
      healthOk: true,
      ...SETTLED_TARGET,
    });
    expect(stale1.action).toBe('wait');
    const recovered = decideWatchdogAction({ freshnessState: 'fresh', priorConsecutiveStale: stale1.nextConsecutiveStale, pauseFileExists: false, healthOk: true });
    expect(recovered.nextConsecutiveStale).toBe(0);
    const staleAgain = decideWatchdogAction({
      freshnessState: STALE_STATE,
      priorConsecutiveStale: recovered.nextConsecutiveStale,
      pauseFileExists: false,
      healthOk: true,
      ...SETTLED_TARGET,
    });
    expect(staleAgain.action).toBe('wait'); // NOT act — streak was reset by the fresh reading
  });

  it("plain 'stale' persists across checks and acts even before stale_alerted", () => {
    const d = decideWatchdogAction({
      freshnessState: 'stale',
      priorConsecutiveStale: 1,
      pauseFileExists: false,
      healthOk: true,
      ...SETTLED_TARGET,
    });
    expect(d.action).toBe('act');
    expect(d.nextConsecutiveStale).toBe(CONSECUTIVE_THRESHOLD);
    expect(d.reason).toMatch(/stale for 2 consecutive checks/);
  });

  it("one plain 'stale' reading waits and preserves the streak", () => {
    const d = decideWatchdogAction({ freshnessState: 'stale', priorConsecutiveStale: 0, pauseFileExists: false, healthOk: true });
    expect(d.action).toBe('wait');
    expect(d.nextConsecutiveStale).toBe(1);
  });

  it('moving target SHA never redeploys even with persistent stale evidence', () => {
    let priorConsecutiveStale = 0;
    let priorTargetSha: string | null = null;
    let priorTargetStableCount = 0;

    for (let i = 0; i < 6; i += 1) {
      const targetSha = `${i}`.repeat(40);
      const d = decideWatchdogAction({
        freshnessState: STALE_STATE,
        priorConsecutiveStale,
        pauseFileExists: false,
        healthOk: true,
        targetSha,
        priorTargetSha,
        priorTargetStableCount,
      });
      expect(d.action).toBe('wait');
      expect(d.reason).toMatch(/not settled/);
      priorConsecutiveStale = d.nextConsecutiveStale;
      priorTargetSha = d.nextTargetSha;
      priorTargetStableCount = d.nextTargetStableCount;
    }
  });

  it('stable target SHA across two polls allows stale redeploy', () => {
    const first = decideWatchdogAction({
      freshnessState: STALE_STATE,
      priorConsecutiveStale: 0,
      pauseFileExists: false,
      healthOk: true,
      targetSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      priorTargetSha: null,
      priorTargetStableCount: 0,
    });
    expect(first.action).toBe('wait');
    expect(first.nextTargetStableCount).toBe(1);

    const second = decideWatchdogAction({
      freshnessState: STALE_STATE,
      priorConsecutiveStale: first.nextConsecutiveStale,
      pauseFileExists: false,
      healthOk: true,
      targetSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      priorTargetSha: first.nextTargetSha,
      priorTargetStableCount: first.nextTargetStableCount,
    });
    expect(second.action).toBe('act');
    expect(second.nextTargetStableCount).toBe(TARGET_STABLE_THRESHOLD);
  });
});
