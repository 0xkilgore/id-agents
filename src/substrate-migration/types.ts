// DV7 — reusable per-domain substrate-cutover tooling (schema-map + dual-write +
// idempotent backfill + parity-verify).
//
// The artifacts proof-cut (src/outputs/{entry,entry-projection,parity}.ts) and
// the tasks read-model (src/tasks-readmodel/*) each hand-rolled the same cutover
// skeleton: project legacy rows into a typed entry, backfill the substrate
// idempotently, dual-write during the window, and gate the flag flip on a
// parity check. DV7 extracts that skeleton so a NEW domain is a config, not a
// rewrite: define a `DomainCutoverConfig`, reuse the generic engines here.
//
// This module is additive — the live artifacts/tasks read paths are untouched.
// `substrate-migration.test.ts` proves the generic parity engine reproduces the
// live `computeArtifactParity` on the same inputs, so future domains can trust
// the generic path.
//
// OSS lineage: doc-model substrate is Powerhouse-derived (AGPL); this toolkit
// generalizes the in-repo DV1/DV2 cutover primitives.

/**
 * The normalized row both sides of a parity check are reduced to. A domain
 * supplies a `toComparable` adapter (the "schema-map") that turns its legacy
 * source row AND its substrate projection into this shape; parity then compares
 * the two populations without knowing anything domain-specific.
 */
export interface ParityComparable {
  /** Stable cross-side identity (artifacts: abs_path; tasks: phid). Two rows —
   *  one from the substrate, one from the legacy source — are "the same row"
   *  iff their `key` matches. */
  key: string;
  /** Fields that must match faithfully between the two sides for the row to be
   *  drift-free (artifacts gate on `title`). Compared with null-coalescing so
   *  `null` and absent read the same. */
  fidelity: Record<string, string | null>;
  /** Timestamp driving the newest-N ordering metric (ISO-8601, descending). */
  ordering_ts: string;
  /** Reported-only grouping dimensions (artifacts: agent, tag). Counted for the
   *  report but never gate the flip — a richer substrate may legitimately have
   *  more distinct groups than the legacy walk saw. */
  groups?: Record<string, string | null>;
}

export interface ParityOptions {
  /** How many of the newest shared rows must agree on ordering. Default 20. */
  newestN?: number;
  /** Which `fidelity` keys gate drift. Default: every key present on the legacy
   *  row (so a domain that adds a fidelity field starts gating it for free). */
  fidelityFields?: string[];
  /** Which `groups` keys to count in the (non-gating) distinct-group metrics. */
  groupDims?: string[];
}

export interface ParityMetric {
  name: string;
  substrate: number | string;
  legacy: number | string;
  ok: boolean;
}

export interface ParityReport {
  status: "ok" | "drift";
  generated_at: string;
  substrate_count: number;
  legacy_count: number;
  metrics: ParityMetric[];
  /** Human-readable drift reasons (capped). Empty iff status === "ok". */
  drift: string[];
}

/** Tally returned by the generic idempotent backfill harness. */
export interface BackfillSummary {
  rows_seen: number;
  rows_parsed: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/** Outcome of a single dual-write: legacy is the source of truth and always
 *  resolves (or throws); the substrate mirror is best-effort. */
export type DualWriteResult<L, S> = {
  legacy: L;
  substrate: { ok: true; value: S } | { ok: false; error: string };
};

/**
 * The per-domain cutover config — the "schema-map". One object describes a
 * domain end-to-end so the generic engines (parity/backfill/dual-write) and the
 * flag helper need no domain-specific code.
 */
export interface DomainCutoverConfig<TLegacyRow = unknown, TSubstrateRow = unknown> {
  /** Domain slug, e.g. "artifacts" | "tasks" | "cleveland-park". */
  domain: string;
  /** The env flag that flips this surface onto the substrate read path,
   *  e.g. "ARTIFACTS_USE_DOCUMENT_MODEL". */
  flagKey: string;
  /** Reduce a substrate projection row to the comparable shape. */
  substrateToComparable: (row: TSubstrateRow) => ParityComparable;
  /** Reduce a legacy source row to the comparable shape. */
  legacyToComparable: (row: TLegacyRow) => ParityComparable;
  /** Parity gate tuning. */
  parity?: ParityOptions;
}
