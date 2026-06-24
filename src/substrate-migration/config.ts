// DV7 — the schema-map: define a domain cutover once, reuse every generic engine.
//
// `defineDomainCutover` validates and freezes a `DomainCutoverConfig` and binds
// the generic parity engine to that domain's comparable adapters. The result is
// the whole per-domain surface a cutover needs (flag check + parity) with zero
// domain-specific control flow — the backfill/dual-write engines take the
// domain's own upsert/write callbacks directly.

import { computeParity } from "./parity.js";
import type { DomainCutoverConfig, ParityReport } from "./types.js";

/** Mirror of feature-flags.ts `isOn` so the toolkit reads cutover flags with the
 *  exact same truthiness as the live `useDocumentModel`. */
function isFlagOn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export interface BoundDomainCutover<TLegacyRow, TSubstrateRow>
  extends DomainCutoverConfig<TLegacyRow, TSubstrateRow> {
  /** True when this surface should read from the substrate (its flag is on). */
  useDocumentModel: (env?: NodeJS.ProcessEnv) => boolean;
  /** Run the parity gate for this domain over its two raw row populations,
   *  reducing each side through the configured comparable adapters. */
  checkParity: (
    substrateRows: TSubstrateRow[],
    legacyRows: TLegacyRow[],
    now?: string,
  ) => ParityReport;
}

/**
 * Validate + freeze a domain cutover config and bind the generic engine to it.
 * Throws on an obviously-invalid config (so a new domain fails fast at wiring
 * time rather than producing a silently-empty parity report).
 */
export function defineDomainCutover<TLegacyRow, TSubstrateRow>(
  config: DomainCutoverConfig<TLegacyRow, TSubstrateRow>,
): BoundDomainCutover<TLegacyRow, TSubstrateRow> {
  if (!config.domain?.trim()) throw new Error("domain cutover requires a non-empty `domain`");
  if (!config.flagKey?.trim()) throw new Error(`domain "${config.domain}" requires a flagKey`);
  if (typeof config.substrateToComparable !== "function") {
    throw new Error(`domain "${config.domain}" requires a substrateToComparable adapter`);
  }
  if (typeof config.legacyToComparable !== "function") {
    throw new Error(`domain "${config.domain}" requires a legacyToComparable adapter`);
  }

  const frozen = Object.freeze({ ...config });

  return Object.freeze({
    ...frozen,
    useDocumentModel(env: NodeJS.ProcessEnv = process.env): boolean {
      return isFlagOn(env[frozen.flagKey]);
    },
    checkParity(
      substrateRows: TSubstrateRow[],
      legacyRows: TLegacyRow[],
      now: string = new Date().toISOString(),
    ): ParityReport {
      return computeParity(
        substrateRows.map(frozen.substrateToComparable),
        legacyRows.map(frozen.legacyToComparable),
        now,
        frozen.parity,
      );
    },
  });
}
