// OSS-lift eval — artifact-store / doc-model lane: evaluate paperless-ngx
// (GPL-3.0) for the artifact-store substrate; adopt-vs-extend-own; cost.
// Canonical owner is CTO (doc-model OSS-lift); re-routed to roger as a build.
// Like the §F RFn items this is encoded AS CODE — a typed capability/cost
// catalog plus a pure recommender — so the adopt-vs-extend decision rests on a
// versioned, testable artifact instead of prose. Sibling of src/exec-sandbox/
// (RF1), src/observability-eval/ (RF3), src/gateway-eval/ (RF2).
//
// IMPORTANT — decision-support ONLY. Nothing in the codebase imports this at
// run time. The ArtifactStore interface below documents what a real adoption
// would implement over the existing doc-model substrate (artifacts catalog +
// DV entry taxonomy + DV3 FTS + DV2 provenance + DV7 migration toolkit); this
// module ships none. Deleting the directory changes zero behavior — the safest
// reversible option.

export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  as_of: string;
  source_url?: string;
  confidence: Confidence;
  verify_before_use?: boolean;
  note?: string;
}

// ── Capabilities the doc-model / artifact-store lane cares about ─────

export interface ArtifactStoreCapabilities {
  /** Full-text search over artifact bodies. */
  full_text_search: boolean;
  /** Typed structured metadata / entry taxonomy + provenance. */
  structured_metadata: boolean;
  /** Ingestion pipeline (watch/consume new artifacts). */
  ingestion_pipeline: boolean;
  /** Append-only versioning / audit history. */
  versioning_audit: boolean;
  rest_api: boolean;
  /** Runs in-process with the manager (no separate service + data-model
   *  reconciliation). */
  in_process: boolean;
  /** Designed for AGENT-generated structured artifacts (markdown/JSON), not
   *  scanned human documents. The crux of the paperless-ngx fit question. */
  agent_artifact_fit: boolean;
  /** OCR of scanned documents — paperless's signature feature; irrelevant for
   *  agent-generated text artifacts. */
  ocr: boolean;
  self_host: boolean;
  sdk_languages: string[];
}

export interface CostModel {
  billing_unit: "per_month" | "free";
  /** Whether a managed/hosted SaaS option exists at all. paperless-ngx is
   *  self-host only → false, so "adopt" cost is the self-host cost, not the
   *  (non-existent) $0 hosted price. */
  hosted_available: boolean;
  usd_per_month_hosted: number;
  free_tier: boolean;
  provenance: Provenance;
}

export interface SelfHostProfile {
  available: boolean;
  license?: string;
  setup_effort_person_days: number;
  ops_burden_person_days_per_month: number;
  infra_usd_per_month: number;
  /** Heavy backing services it drags in (Postgres, Redis, a task queue, …). */
  backing_services: string[];
  provenance: Provenance;
}

export interface ArtifactStoreOption {
  id: string;
  name: string;
  url: string;
  /** "adopt" = a third-party store to adopt; "own" = extend our existing
   *  doc-model substrate. */
  kind: "adopt" | "own";
  open_source: boolean;
  license?: string;
  capabilities: ArtifactStoreCapabilities;
  hosted_cost: CostModel;
  self_host: SelfHostProfile;
  provenance: Provenance;
}

// ── Requirements ────────────────────────────────────────────────────

export interface ArtifactStoreRequirements {
  need_full_text_search: boolean;
  need_structured_metadata: boolean;
  need_ingestion_pipeline: boolean;
  need_versioning_audit: boolean;
  need_rest_api: boolean;
  need_ocr: boolean;
  /** In-process integration is a hard requirement (no separate service / second
   *  data model). */
  require_in_process: boolean;
  /** The store must be purpose-fit for agent artifacts (hard gate). */
  require_agent_artifact_fit: boolean;
  require_self_host: boolean;
  needed_languages: string[];
  weights?: Partial<RequirementWeights>;
}

export interface RequirementWeights {
  capability_fit: number;
  purpose_fit: number;
  integration_fit: number;
  cost: number;
}

// ── Recommender output ──────────────────────────────────────────────

export interface StoreScore {
  store_id: string;
  score: number; // 0..1
  breakdown: {
    capability_fit: number;
    purpose_fit: number;
    integration_fit: number;
    cost: number;
  };
  disqualifiers: string[];
  capability_gaps: string[];
  estimated_monthly_usd: number;
  rationale: string[];
}

export interface ArtifactStoreRecommendation {
  ranking: StoreScore[];
  /** Top eligible option (own baseline included — for this lane "extend own"
   *  is a legitimate winner, unlike the gateway eval). */
  recommended_store_id: string | null;
  adopt_vs_extend: AdoptVsExtend | null;
  generated_at: string;
}

// ── Adopt paperless-ngx vs extend our own doc-model substrate ───────

export type AdoptVsExtendVerdict = "adopt" | "extend_own" | "too_close_to_call";

export interface AdoptVsExtend {
  adopt_candidate_id: string;
  verdict: AdoptVsExtendVerdict;
  adopt_usd_per_month: number;
  extend_own_usd_per_month: number;
  amortization_months: number;
  adopt_is_oss: boolean;
  rationale: string[];
}

// ── The seam a real adoption would implement (NOT implemented here) ──

export interface ArtifactRecord {
  artifact_id: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactStore {
  readonly id: string;
  put(rec: ArtifactRecord): Promise<void>;
  search(query: string): Promise<ArtifactRecord[]>;
}
