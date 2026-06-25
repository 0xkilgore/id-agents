// T-QA.8 — QA-and-testing runbook, encoded AS CODE.
//
// The single canonical QA reference (roadmap-reset §4.7.2): taxonomy + per-agent
// pre-promotion requirements + Vercel preview workflow + regression rule +
// Sentinel cadence + escape hatches — the "equivalent of T-DEPLOY.4 for QA" that
// closes the T-QA track. T-QA.8 is a Maestra "(doc)" item; encoding it as a typed
// module that ASSEMBLES the runbook from the already-shipped T-QA substrate
// (T-QA.1 test-taxonomy, T-QA.5 regression-coverage, T-QA.7 smoke-exempt) — and
// renders the canonical markdown — makes the runbook a LIVING artifact that
// cannot drift from the code it documents. The drift tests fail if a taxonomy
// category or a typed failure mode is added without the runbook reflecting it.
//
// IMPORTANT — reference/decision-support ONLY. Nothing imports this at run time.
// Deleting the directory changes zero behavior — the safest reversible option.

/** Lifecycle of the practice a section documents. */
export type SectionStatus = "live" | "held" | "phase2";

/** One section of the runbook (markdown-ready). */
export interface RunbookSection {
  /** Stable anchor / id (kebab-case). */
  id: string;
  title: string;
  /** Which roadmap sub-track this section closes (e.g. "T-QA.1"). */
  track: string;
  status: SectionStatus;
  /** Paragraph / bullet lines, already markdown-shaped. */
  body: string[];
}

/** The assembled runbook. */
export interface QaRunbook {
  title: string;
  /** One-line provenance note (this is generated from code). */
  generated_note: string;
  sections: RunbookSection[];
}
