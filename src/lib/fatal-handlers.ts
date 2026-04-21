// SPDX-License-Identifier: MIT
/**
 * Top-level fatal-error handlers for the manager process.
 *
 * Silent-stop incidents had the scheduler die behind a swallowed rejection —
 * the process stayed up (green in supervisor output) but the tick loop was
 * dead. Fail loud and exit so the supervisor restarts instead of limping.
 * See task /scheduler-reject-handler for the incident class this addresses.
 */

/** Minimal process-like surface we depend on, so tests can inject a fake. */
export interface FatalProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): unknown;
  on(event: 'uncaughtException', listener: (err: unknown) => void): unknown;
  exit(code?: number): never;
}

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || `${reason.name}: ${reason.message}`;
  }
  try {
    return typeof reason === 'string' ? reason : JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Install unhandledRejection + uncaughtException handlers that log with a
 * [FATAL] prefix and exit(1). Idempotent per-process: safe to call once at
 * boot. Default target is `process`; tests pass a fake.
 */
export function installFatalHandlers(proc: FatalProcessLike = process as unknown as FatalProcessLike): void {
  proc.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled promise rejection in manager process');
    console.error(`[FATAL] reason: ${formatReason(reason)}`);
    console.error('[FATAL] promise:', promise);
    proc.exit(1);
  });

  proc.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception in manager process');
    console.error(`[FATAL] reason: ${formatReason(err)}`);
    proc.exit(1);
  });
}
