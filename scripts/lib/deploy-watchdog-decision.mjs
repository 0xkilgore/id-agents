// SPDX-License-Identifier: MIT
//
// T-DEPLOY.5 deploy-freshness watchdog — the PURE decision logic.
//
// Standalone ESM (no TypeScript, no manager `dist` dependency) on purpose: the
// watchdog exists to fix a stale/broken manager, so it must run even when the
// manager's build is broken. The imperative watchdog + the unit test both import
// this single source of truth.
//
// The manager exposes freshness at GET /health .freshness.state, one of
// 'fresh' | 'stale' | 'stale_alerted' (see src/deploy-guard/freshness.ts). We act
// ONLY on persistent `stale_alerted` — a node that has been behind origin/main
// past the alert threshold — and only after TWO consecutive checks (>15 min at a
// 15-min cadence) so a single transient reading never triggers a redeploy.

export const STALE_STATE = 'stale_alerted';
/** Consecutive stale readings required before acting (2 × 15 min ≈ >15 min). */
export const CONSECUTIVE_THRESHOLD = 2;

/**
 * @typedef {Object} WatchdogInput
 * @property {string|null} freshnessState  - /health .freshness.state (null if unreadable)
 * @property {number} priorConsecutiveStale - streak carried from the last run's state file
 * @property {boolean} pauseFileExists       - kill-switch file present
 * @property {boolean} healthOk              - true when /health was read successfully
 *
 * @typedef {Object} WatchdogDecision
 * @property {'noop'|'wait'|'act'} action
 * @property {number} nextConsecutiveStale   - streak to persist for the next run
 * @property {string} reason
 */

/**
 * Decide the watchdog's action. Pure + deterministic.
 * @param {WatchdogInput} input
 * @returns {WatchdogDecision}
 */
export function decideWatchdogAction(input) {
  const {
    freshnessState = null,
    priorConsecutiveStale = 0,
    pauseFileExists = false,
    healthOk = true,
  } = input || {};

  // Kill switch wins over everything — never act while paused. Streak preserved
  // so an operator can pause mid-alert without losing the count.
  if (pauseFileExists) {
    return {
      action: 'noop',
      nextConsecutiveStale: priorConsecutiveStale,
      reason: 'paused (kill-switch file present)',
    };
  }

  // Couldn't read /health — a transient blip or a down manager. Do NOT act on a
  // single unreadable check (avoid redeploy-storming a flapping endpoint); reset
  // the streak so acting requires two *confirmed* stale readings.
  if (!healthOk) {
    return { action: 'noop', nextConsecutiveStale: 0, reason: 'health unreadable; not acting, streak reset' };
  }

  // Anything but stale_alerted (fresh / stale / unknown) → healthy enough; reset.
  if (freshnessState !== STALE_STATE) {
    return {
      action: 'noop',
      nextConsecutiveStale: 0,
      reason: `freshness=${freshnessState ?? 'unknown'} (not ${STALE_STATE}); streak reset`,
    };
  }

  // Persistent stale_alerted: count it.
  const next = priorConsecutiveStale + 1;
  if (next >= CONSECUTIVE_THRESHOLD) {
    return {
      action: 'act',
      nextConsecutiveStale: next,
      reason: `${STALE_STATE} for ${next} consecutive checks (>= ${CONSECUTIVE_THRESHOLD}); redeploy`,
    };
  }
  return {
    action: 'wait',
    nextConsecutiveStale: next,
    reason: `${STALE_STATE} (${next}/${CONSECUTIVE_THRESHOLD} consecutive); wait one more check`,
  };
}
