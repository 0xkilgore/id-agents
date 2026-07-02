// SPDX-License-Identifier: MIT
//
// T-DEPLOY.5 deploy-freshness watchdog — decision-logic unit tests (Chris's
// required cases: fresh→noop, one stale→wait, two stale→act, pause→noop).

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { decideWatchdogAction, STALE_STATE, CONSECUTIVE_THRESHOLD } from '../../scripts/lib/deploy-watchdog-decision.mjs';

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
    const d = decideWatchdogAction({ freshnessState: STALE_STATE, priorConsecutiveStale: 1, pauseFileExists: false, healthOk: true });
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

  it('recovery: stale then fresh resets the streak so a later single stale only waits', () => {
    const stale1 = decideWatchdogAction({ freshnessState: STALE_STATE, priorConsecutiveStale: 0, pauseFileExists: false, healthOk: true });
    expect(stale1.action).toBe('wait');
    const recovered = decideWatchdogAction({ freshnessState: 'fresh', priorConsecutiveStale: stale1.nextConsecutiveStale, pauseFileExists: false, healthOk: true });
    expect(recovered.nextConsecutiveStale).toBe(0);
    const staleAgain = decideWatchdogAction({ freshnessState: STALE_STATE, priorConsecutiveStale: recovered.nextConsecutiveStale, pauseFileExists: false, healthOk: true });
    expect(staleAgain.action).toBe('wait'); // NOT act — streak was reset by the fresh reading
  });

  it("plain 'stale' (not yet alerted) → noop, streak reset (only stale_alerted counts)", () => {
    const d = decideWatchdogAction({ freshnessState: 'stale', priorConsecutiveStale: 1, pauseFileExists: false, healthOk: true });
    expect(d.action).toBe('noop');
    expect(d.nextConsecutiveStale).toBe(0);
  });
});
