// DV7 — generic dual-write helper for the cutover window.
//
// During a per-domain cutover the legacy store stays the SOURCE OF TRUTH while
// the substrate is populated in parallel, so a flip (or rollback) is reversible
// and the parity gate has live data to compare. `dualWrite` codifies the safe
// ordering every domain needs: write legacy first (its failure propagates), then
// best-effort mirror to the substrate (its failure NEVER breaks the legacy
// write — it is captured in the result for telemetry).

import type { DualWriteResult } from "./types.js";

export interface DualWriteOptions<L, S> {
  /** The authoritative write. If this throws, dualWrite rejects — the operation
   *  genuinely failed. */
  writeLegacy: () => Promise<L> | L;
  /** Mirror the legacy result into the substrate. Best-effort. */
  writeSubstrate: (legacy: L) => Promise<S> | S;
  /** Optional hook for substrate-write failures (logging/metrics). Never
   *  rethrow from here — it is invoked inside the swallowed catch. */
  onSubstrateError?: (error: unknown, legacy: L) => void;
}

/**
 * Write to legacy then mirror to the substrate. Returns both outcomes; the
 * substrate side is a tagged union so callers can surface mirror lag without a
 * try/catch at every call site.
 */
export async function dualWrite<L, S>(opts: DualWriteOptions<L, S>): Promise<DualWriteResult<L, S>> {
  const legacy = await opts.writeLegacy();
  try {
    const value = await opts.writeSubstrate(legacy);
    return { legacy, substrate: { ok: true, value } };
  } catch (error) {
    opts.onSubstrateError?.(error, legacy);
    return {
      legacy,
      substrate: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
