// Binds a SqliteDispatchReactor to the DispatchRecoveryReactor seam the
// DispatchRecoveryService consumes. The only thing the adapter adds over the
// reactor's own recovery methods is binding the configured lookback window into
// the no-arg listFailedForRecovery() the service expects.

import {
  type SqliteDispatchReactor,
  DEFAULT_RECOVERY_LOOKBACK_MS,
} from "../dispatch-scheduler/sqlite-dispatch-reactor.js";
import type { DispatchRecoveryReactor } from "./service.js";

export function makeRecoveryReactor(
  reactor: SqliteDispatchReactor,
  opts: { lookbackMs?: number; now?: () => string } = {},
): DispatchRecoveryReactor {
  const lookbackMs = opts.lookbackMs ?? DEFAULT_RECOVERY_LOOKBACK_MS;
  return {
    listFailedForRecovery: () =>
      reactor.listFailedForRecovery({
        lookbackMs,
        now: opts.now ? opts.now() : undefined,
      }),
    listStuckForBackfill: (scanOpts) => reactor.listStuckForBackfill(scanOpts),
    requeueForRecovery: (phid, args) => reactor.requeueForRecovery(phid, args),
    markRecoveryLanded: (phid, opts) => reactor.markRecoveryLanded(phid, opts),
    recordRecoveryOutcome: (phid, args) =>
      reactor.recordRecoveryOutcome(phid, args),
  };
}
