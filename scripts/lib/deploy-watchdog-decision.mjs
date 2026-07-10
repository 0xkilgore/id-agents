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
// on persistent stale evidence, whether the manager has advanced to
// `stale_alerted` yet or is stuck reporting plain `stale`, and only after TWO
// consecutive checks (>15 min at a 15-min cadence) so a single transient reading
// never triggers a redeploy.

export const STALE_STATE = 'stale_alerted';
export const STALE_STATES = new Set(['stale', STALE_STATE]);
/** Consecutive stale readings required before acting (2 × 15 min ≈ >15 min). */
export const CONSECUTIVE_THRESHOLD = 2;
/** Consecutive identical target-SHA observations required before redeploying. */
export const TARGET_SETTLE_THRESHOLD = 2;

/**
 * @typedef {Object} WatchdogInput
 * @property {string|null} freshnessState  - /health .freshness.state (null if unreadable)
 * @property {number} priorConsecutiveStale - streak carried from the last run's state file
 * @property {boolean} pauseFileExists       - kill-switch file present
 * @property {boolean} healthOk              - true when /health was read successfully
 * @property {boolean} deployCheckoutOk      - true when the dedicated deploy checkout exists
 * @property {boolean} managerPlistOk        - true when launchd points at the dedicated deploy checkout
 * @property {string|null} priorLastAction   - last persisted watchdog action, if any
 * @property {string|null} originMainSha      - currently observed target SHA from origin/main
 * @property {string|null} priorTargetSha     - previous observed target SHA
 * @property {number} priorConsecutiveTarget  - consecutive polls with the same target SHA
 *
 * @typedef {Object} WatchdogDecision
 * @property {'noop'|'wait'|'act'} action
 * @property {number} nextConsecutiveStale   - streak to persist for the next run
 * @property {string|null} nextTargetSha      - target SHA to persist for the next run
 * @property {number} nextConsecutiveTarget  - target settle streak to persist for the next run
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
    deployCheckoutOk = true,
    managerPlistOk = true,
    priorLastAction = null,
    originMainSha = null,
    priorTargetSha = null,
    priorConsecutiveTarget = 0,
  } = input || {};
  const targetSha = originMainSha || null;
  const nextConsecutiveTarget = targetSha
    ? (targetSha === priorTargetSha ? priorConsecutiveTarget + 1 : 1)
    : 0;

  // Kill switch wins over everything — never act while paused. Streak preserved
  // so an operator can pause mid-alert without losing the count.
  if (pauseFileExists) {
    return {
      action: 'noop',
      nextConsecutiveStale: priorConsecutiveStale,
      nextTargetSha: targetSha || priorTargetSha,
      nextConsecutiveTarget,
      reason: 'paused (kill-switch file present)',
    };
  }

  // Structural launchd/deploy-root breakage is independent of freshness. If the
  // manager currently runs from a temporary source checkout, /health can still be
  // readable while the next restart would fail or keep serving stale live code.
  if (!deployCheckoutOk || !managerPlistOk) {
    return {
      action: 'act',
      nextConsecutiveStale: priorConsecutiveStale,
      nextTargetSha: targetSha,
      nextConsecutiveTarget,
      reason: [
        !deployCheckoutOk ? 'deploy checkout missing' : null,
        !managerPlistOk ? 'manager launchd plist not pointed at deploy checkout' : null,
      ].filter(Boolean).join('; '),
    };
  }

  // Couldn't read /health — usually a transient blip or a down manager. Do NOT
  // act on a single unreadable check from a quiet state, but if the previous
  // watchdog run already acted then unreadable health is the documented failed
  // closeout class and must re-run/escalate visibly instead of going quiet.
  if (!healthOk) {
    if (priorLastAction === 'act') {
      return {
        action: 'act',
        nextConsecutiveStale: Math.max(priorConsecutiveStale, CONSECUTIVE_THRESHOLD),
        nextTargetSha: targetSha,
        nextConsecutiveTarget,
        reason: 'health unreadable after prior watchdog action; rerun remediation and escalate with manual command on failure',
      };
    }
    return {
      action: 'noop',
      nextConsecutiveStale: 0,
      nextTargetSha: targetSha,
      nextConsecutiveTarget,
      reason: 'health unreadable; not acting, streak reset',
    };
  }

  // Anything but stale evidence (fresh / unknown) → healthy enough; reset.
  if (!STALE_STATES.has(freshnessState)) {
    return {
      action: 'noop',
      nextConsecutiveStale: 0,
      nextTargetSha: targetSha,
      nextConsecutiveTarget,
      reason: `freshness=${freshnessState ?? 'unknown'} (not stale/stale_alerted); streak reset`,
    };
  }

  // Persistent stale evidence: count it.
  const next = priorConsecutiveStale + 1;
  if (next >= CONSECUTIVE_THRESHOLD) {
    if (!targetSha) {
      return {
        action: 'wait',
        nextConsecutiveStale: next,
        nextTargetSha: null,
        nextConsecutiveTarget: 0,
        reason: `${freshnessState} for ${next} consecutive checks, but origin/main target SHA is unknown; wait`,
      };
    }
    if (nextConsecutiveTarget < TARGET_SETTLE_THRESHOLD) {
      return {
        action: 'wait',
        nextConsecutiveStale: next,
        nextTargetSha: targetSha,
        nextConsecutiveTarget,
        reason: `${freshnessState} for ${next} consecutive checks, but target ${targetSha.slice(0, 12)} observed ${nextConsecutiveTarget}/${TARGET_SETTLE_THRESHOLD} consecutive polls; wait for settle`,
      };
    }
    return {
      action: 'act',
      nextConsecutiveStale: next,
      nextTargetSha: targetSha,
      nextConsecutiveTarget,
      reason: `${freshnessState} for ${next} consecutive checks (>= ${CONSECUTIVE_THRESHOLD}) and target ${targetSha.slice(0, 12)} settled for ${nextConsecutiveTarget} polls; redeploy`,
    };
  }
  return {
    action: 'wait',
    nextConsecutiveStale: next,
    nextTargetSha: targetSha,
    nextConsecutiveTarget,
    reason: `${freshnessState} (${next}/${CONSECUTIVE_THRESHOLD} consecutive); wait one more check`,
  };
}
