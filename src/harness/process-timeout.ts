// SPDX-License-Identifier: MIT
/**
 * Shared subprocess hang-timeout watchdog (W-004, extended 2026-07-03 to
 * cover all three CLI harnesses — see W-004 closeout follow-up note).
 *
 * A spawned CLI child (`claude`, `codex exec`, `cursor-agent`) can hang
 * indefinitely — blocked on stdin, a stalled network call, or (the
 * 2026-07-03 incident) a wedged `codex exec` process that a serial
 * per-agent query queue then blocks behind forever. This watchdog kills
 * the process (SIGTERM, then SIGKILL after a grace period) and calls
 * `onTimeout()` so the caller can reject/yield a typed failure instead of
 * hanging silently.
 */

export const DEFAULT_HARNESS_TIMEOUT_MS = 30 * 60_000; // 30 minutes
export const KILL_GRACE_MS = 2000;

/** Marker substring every harness's timeout error message must contain —
 * `src/harness/transient-errors.ts` matches on this to classify the
 * failure as `harness_hang_timeout` rather than a generic provider timeout. */
export const HANG_TIMEOUT_MARKER = 'hang timeout exceeded';

/**
 * Resolve the effective harness timeout (ms). Precedence: explicit option →
 * ID_AGENT_HARNESS_TIMEOUT_MS env → DEFAULT_HARNESS_TIMEOUT_MS. A value of 0
 * disables the watchdog; a garbage/negative env value is ignored. Pure.
 */
export function resolveHarnessTimeoutMs(
  opts: { timeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0) {
    return opts.timeoutMs;
  }
  const raw = env.ID_AGENT_HARNESS_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_HARNESS_TIMEOUT_MS;
}

/** A child process we can signal — the subset of ChildProcess the watchdog needs. */
export interface KillableProcess {
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Arm a SIGTERM→SIGKILL watchdog on a child process. After `timeoutMs` it
 * calls `onTimeout()` and sends SIGTERM; if the process is still alive after
 * `graceMs` it sends SIGKILL. `timeoutMs <= 0` disables the watchdog. Returns
 * a `clear()` that cancels both timers (call it when the process exits in
 * time). Pure aside from the timers it owns; testable with fake clocks.
 */
export function armProcessTimeout(
  proc: KillableProcess,
  timeoutMs: number,
  options: { graceMs: number; onTimeout: () => void },
): () => void {
  if (!(timeoutMs > 0)) {
    return () => {};
  }
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    options.onTimeout();
    try {
      proc.kill('SIGTERM');
    } catch {
      // process already gone
    }
    killTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, options.graceMs);
    if (typeof (killTimer as { unref?: () => void }).unref === 'function') {
      (killTimer as { unref?: () => void }).unref!();
    }
  }, timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref?: () => void }).unref!();
  }
  return () => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  };
}
