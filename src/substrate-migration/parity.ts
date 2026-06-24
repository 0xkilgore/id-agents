// DV7 — generic parity-verify engine.
//
// Generalized from src/outputs/parity.ts `computeArtifactParity`: drift is
// ASYMMETRIC — every legacy row must be present in the substrate (matched by
// `key`) and faithful on the gated `fidelity` fields, and the newest-N ordering
// of the rows shared by both sides must agree. A substrate SUPERSET (rows the
// legacy walk never saw) is NOT drift. The flag flip is blocked unless
// status === "ok".
//
// Pure + deterministic (the only impurity is the caller-supplied `now`), so it
// is unit-tested directly and the equivalence test can pin it against the live
// artifacts parity.

import type { ParityComparable, ParityMetric, ParityOptions, ParityReport } from "./types.js";

const DEFAULT_NEWEST_N = 20;
const DRIFT_CAP = 30;

function countBy(rows: ParityComparable[], dim: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = r.groups?.[dim] ?? "(none)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function newestKeys(rows: ParityComparable[], n: number): string[] {
  return [...rows]
    .sort((a, b) => (a.ordering_ts < b.ordering_ts ? 1 : a.ordering_ts > b.ordering_ts ? -1 : 0))
    .slice(0, n)
    .map((r) => r.key);
}

/** Which fidelity fields gate: explicit `fidelityFields`, else the union of keys
 *  present across the legacy rows (so adding a fidelity field auto-gates it). */
function resolveFidelityFields(legacy: ParityComparable[], opts: ParityOptions): string[] {
  if (opts.fidelityFields) return opts.fidelityFields;
  const fields = new Set<string>();
  for (const row of legacy) for (const key of Object.keys(row.fidelity)) fields.add(key);
  return [...fields];
}

/**
 * Pure parity computation over two already-normalized populations. `substrate`
 * and `legacy` are `ParityComparable[]`; the domain's `*ToComparable` adapters
 * produced them, so this function is fully domain-agnostic.
 */
export function computeParity(
  substrate: ParityComparable[],
  legacy: ParityComparable[],
  now: string,
  opts: ParityOptions = {},
): ParityReport {
  const newestN = opts.newestN ?? DEFAULT_NEWEST_N;
  const fidelityFields = resolveFidelityFields(legacy, opts);
  const drift: string[] = [];
  const subByKey = new Map(substrate.map((r) => [r.key, r]));

  // (1) presence + (2) fidelity — every legacy row present & faithful.
  let missing = 0;
  let fidelityMismatch = 0;
  for (const d of legacy) {
    const s = subByKey.get(d.key);
    if (!s) {
      missing += 1;
      if (drift.length < DRIFT_CAP) drift.push(`missing in substrate: ${d.key}`);
      continue;
    }
    for (const field of fidelityFields) {
      if ((s.fidelity[field] ?? "") !== (d.fidelity[field] ?? "")) {
        fidelityMismatch += 1;
        if (drift.length < DRIFT_CAP) {
          drift.push(
            `${field} drift for ${d.key}: substrate="${s.fidelity[field] ?? ""}" vs legacy="${d.fidelity[field] ?? ""}"`,
          );
        }
      }
    }
  }

  // (3) newest-N ordering over rows shared by both sides.
  const sharedSub = substrate.filter((r) => subByKey.has(r.key) && legacy.some((d) => d.key === r.key));
  const sharedLog = legacy.filter((d) => subByKey.has(d.key));
  const subOrder = newestKeys(sharedSub, newestN);
  const logOrder = newestKeys(sharedLog, newestN);
  const orderingOk = subOrder.length === logOrder.length && subOrder.every((k, i) => k === logOrder[i]);
  if (!orderingOk) drift.push(`newest-${newestN} ordering differs for shared rows`);

  const metrics: ParityMetric[] = [
    { name: "legacy_rows_present", substrate: legacy.length - missing, legacy: legacy.length, ok: missing === 0 },
    { name: "fidelity", substrate: Math.max(0, legacy.length - fidelityMismatch), legacy: legacy.length, ok: fidelityMismatch === 0 },
    { name: `newest_${newestN}_ordering`, substrate: subOrder.length, legacy: logOrder.length, ok: orderingOk },
  ];

  // (4) reported-only distinct-group counts (never gate the flip).
  for (const dim of opts.groupDims ?? []) {
    metrics.push({
      name: `distinct_${dim}`,
      substrate: countBy(substrate, dim).size,
      legacy: countBy(legacy, dim).size,
      ok: true,
    });
  }

  return {
    status: drift.length === 0 ? "ok" : "drift",
    generated_at: now,
    substrate_count: substrate.length,
    legacy_count: legacy.length,
    metrics,
    drift,
  };
}
