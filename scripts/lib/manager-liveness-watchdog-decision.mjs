// SPDX-License-Identifier: MIT
//
// External manager HTTP-liveness watchdog decision logic.
//
// Pure ESM on purpose: the watchdog must still be runnable when the manager's
// TypeScript build or DB-backed routes are wedged. The runner owns probing,
// diagnostics, restart, and state persistence; this module owns only the
// deterministic action/class decision.

export const HTTP_FAILURE_THRESHOLD = 2;
export const RESTART_COOLDOWN_MS = 5 * 60 * 1000;
export const ESCALATION_WINDOW_MS = 10 * 60 * 1000;
export const RECOVERY_BUDGET_MS = 75 * 1000;

/**
 * @typedef {Object} LivenessDecisionInput
 * @property {boolean} healthOk
 * @property {boolean} healthTimedOut
 * @property {number|null} healthLatencyMs
 * @property {boolean} dispatchHealthOk
 * @property {boolean} dispatchHealthTimedOut
 * @property {number|null} dispatchHealthLatencyMs
 * @property {number|null} listenerPid
 * @property {number|null} launchdPid
 * @property {number} priorConsecutiveFailures
 * @property {string|null} priorRestartAt
 * @property {boolean} pauseFileExists
 * @property {number} nowMs
 * @property {string[]} [priorRestartAttempts]
 *
 * @typedef {Object} LivenessDecision
 * @property {'noop'|'wait'|'diagnose_restart'|'escalate'} action
 * @property {'healthy'|'degraded_db_route'|'http_unresponsive_listener_alive'|'manager_down'|'restart_cooldown'|'paused'} class
 * @property {number} nextConsecutiveFailures
 * @property {string} reason
 */

/**
 * @param {LivenessDecisionInput} input
 * @returns {LivenessDecision}
 */
export function decideManagerLivenessWatchdog(input) {
  const {
    healthOk = false,
    healthTimedOut = false,
    healthLatencyMs = null,
    dispatchHealthOk = false,
    dispatchHealthTimedOut = false,
    dispatchHealthLatencyMs = null,
    listenerPid = null,
    launchdPid = null,
    priorConsecutiveFailures = 0,
    priorRestartAt = null,
    pauseFileExists = false,
    nowMs = Date.now(),
    priorRestartAttempts = [],
  } = input || {};

  if (pauseFileExists) {
    return {
      action: 'noop',
      class: 'paused',
      nextConsecutiveFailures: priorConsecutiveFailures,
      reason: 'paused (kill-switch file present)',
    };
  }

  if (healthOk && healthLatencyMs !== null && healthLatencyMs <= 2000) {
    if (!dispatchHealthOk && dispatchHealthTimedOut) {
      return {
        action: 'wait',
        class: 'degraded_db_route',
        nextConsecutiveFailures: 0,
        reason: `/health ok in ${healthLatencyMs}ms but /dispatches/health timed out${formatLatency(dispatchHealthLatencyMs)}`,
      };
    }
    return {
      action: 'noop',
      class: 'healthy',
      nextConsecutiveFailures: 0,
      reason: `/health ok in ${healthLatencyMs}ms`,
    };
  }

  const httpFailure = healthTimedOut || !healthOk;
  if (!httpFailure) {
    return {
      action: 'wait',
      class: 'degraded_db_route',
      nextConsecutiveFailures: 0,
      reason: `/health responded outside liveness budget${formatLatency(healthLatencyMs)}; waiting`,
    };
  }

  const nextConsecutiveFailures = priorConsecutiveFailures + 1;
  const failureClass = listenerPid == null ? 'manager_down' : 'http_unresponsive_listener_alive';
  const failureReason = listenerPid == null
    ? `manager HTTP liveness failed and no listener pid was found (launchd_pid=${launchdPid ?? 'unknown'})`
    : `manager HTTP liveness failed while listener pid ${listenerPid} is alive`;

  const restartAttemptsInWindow = recentRestartAttempts(priorRestartAttempts, nowMs, ESCALATION_WINDOW_MS);
  const restartAgeMs = priorRestartAt ? nowMs - Date.parse(priorRestartAt) : null;

  if (restartAttemptsInWindow.length >= 2) {
    return {
      action: 'escalate',
      class: failureClass,
      nextConsecutiveFailures,
      reason: `${failureReason}; ${restartAttemptsInWindow.length} restart attempts inside ${Math.round(ESCALATION_WINDOW_MS / 60000)} minutes`,
    };
  }

  if (restartAgeMs !== null && Number.isFinite(restartAgeMs)) {
    if (restartAgeMs >= RECOVERY_BUDGET_MS) {
      return {
        action: 'escalate',
        class: failureClass,
        nextConsecutiveFailures,
        reason: `${failureReason}; still unresponsive ${Math.round(restartAgeMs / 1000)}s after restart (recovery budget ${Math.round(RECOVERY_BUDGET_MS / 1000)}s)`,
      };
    }
    if (restartAgeMs < RESTART_COOLDOWN_MS) {
      return {
        action: 'wait',
        class: 'restart_cooldown',
        nextConsecutiveFailures,
        reason: `${failureReason}; restart cooldown active (${Math.round((RESTART_COOLDOWN_MS - restartAgeMs) / 1000)}s remaining)`,
      };
    }
  }

  if (nextConsecutiveFailures >= HTTP_FAILURE_THRESHOLD) {
    return {
      action: 'diagnose_restart',
      class: failureClass,
      nextConsecutiveFailures,
      reason: `${failureReason}; ${nextConsecutiveFailures} consecutive HTTP liveness failures`,
    };
  }

  return {
    action: 'wait',
    class: failureClass,
    nextConsecutiveFailures,
    reason: `${failureReason}; ${nextConsecutiveFailures}/${HTTP_FAILURE_THRESHOLD} consecutive failures`,
  };
}

function recentRestartAttempts(attempts, nowMs, windowMs) {
  if (!Array.isArray(attempts)) return [];
  return attempts.filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= windowMs;
  });
}

function formatLatency(latencyMs) {
  return latencyMs === null || latencyMs === undefined ? '' : ` (${latencyMs}ms)`;
}
