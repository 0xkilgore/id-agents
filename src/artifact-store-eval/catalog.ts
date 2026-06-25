// OSS-lift eval — artifact-store option catalog (the evaluated data).
//
// HONESTY NOTE: capabilities are from public docs as of `as_of` with a
// confidence; effort/infra are estimates flagged verify_before_use. The
// recommender MATH is the durable artifact; numbers are operator-replaceable.
//
// The eval names paperless-ngx; the comparison is against our OWN doc-model
// substrate (the status-quo / extend baseline that already exists in id-agents:
// artifacts catalog + DV entry taxonomy + DV3 FTS + DV2 provenance + DV7
// migration toolkit).

import type { ArtifactStoreOption } from "./types.js";

const EVAL_DATE = "2026-06-24";

/** paperless-ngx — GPL-3.0 Django document-management system. Built for
 *  scanned HUMAN documents (OCR, correspondents, physical mail), backed by
 *  Postgres + Redis + a task queue. Liftable per directive #77 (GPL-3.0 =
 *  direct lift permitted), so license is NOT the blocker — fit + integration
 *  cost is. */
export const PAPERLESS_NGX: ArtifactStoreOption = {
  id: "paperless_ngx",
  name: "paperless-ngx",
  url: "https://docs.paperless-ngx.com",
  kind: "adopt",
  open_source: true,
  license: "GPL-3.0",
  capabilities: {
    full_text_search: true, // Postgres FTS / Whoosh
    structured_metadata: true, // tags / correspondents / document types — human-doc oriented
    ingestion_pipeline: true, // consume folder / email / scanner
    versioning_audit: false, // limited document history; not append-only event log
    rest_api: true,
    in_process: false, // separate Django service + its own data model to reconcile
    agent_artifact_fit: false, // designed for scanned human docs, not agent-generated markdown/JSON
    ocr: true, // signature feature — irrelevant for text artifacts
    self_host: true,
    sdk_languages: ["python"],
  },
  hosted_cost: {
    billing_unit: "free",
    hosted_available: false,
    usd_per_month_hosted: 0, // self-host only; no official SaaS
    free_tier: true,
    provenance: { as_of: EVAL_DATE, source_url: "https://docs.paperless-ngx.com", confidence: "high", note: "OSS, self-host only." },
  },
  self_host: {
    available: true,
    license: "GPL-3.0",
    setup_effort_person_days: 12, // stand up Django + Postgres + Redis + integrate + reconcile two data models
    ops_burden_person_days_per_month: 3,
    infra_usd_per_month: 150,
    backing_services: ["postgres", "redis", "task-queue"],
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://github.com/paperless-ngx/paperless-ngx",
      confidence: "medium",
      verify_before_use: true,
      note: "Heavyweight Django stack; adopting it means running a second service + reconciling its document model with our artifact doc-model. Estimates.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://docs.paperless-ngx.com",
    confidence: "high",
    note: "Excellent HUMAN document manager (OCR, mail, correspondents). Poor fit for AGENT-generated structured artifacts, which our substrate already handles in-process.",
  },
};

/** Our own doc-model substrate — the status-quo / extend baseline. Already
 *  covers FTS (DV3), typed metadata + provenance (DV1/DV2), ingestion (catalog/
 *  delivery-log), append-only versioning (artifact_operations), REST, all
 *  in-process and purpose-built for agent artifacts. */
export const OWN_DOC_MODEL: ArtifactStoreOption = {
  id: "own_doc_model",
  name: "Own doc-model substrate (status quo)",
  url: "",
  kind: "own",
  open_source: true,
  capabilities: {
    full_text_search: true, // DV3 FTS5
    structured_metadata: true, // DV1/DV2 entry taxonomy + provenance
    ingestion_pipeline: true, // catalog backfill + delivery-log reconcile
    versioning_audit: true, // append-only artifact_operations log
    rest_api: true, // GET /artifacts/entries etc.
    in_process: true,
    agent_artifact_fit: true, // purpose-built for agent-generated markdown/JSON
    ocr: false, // not needed for text artifacts
    self_host: true,
    sdk_languages: ["typescript"],
  },
  hosted_cost: {
    billing_unit: "free",
    hosted_available: false,
    usd_per_month_hosted: 0,
    free_tier: true,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "In-process; no marginal cost." },
  },
  self_host: {
    available: true,
    setup_effort_person_days: 0,
    ops_burden_person_days_per_month: 0,
    infra_usd_per_month: 0,
    backing_services: ["sqlite"],
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "Already built + integrated with the manager/console this session (DV2/DV3/DV7)." },
  },
  provenance: {
    as_of: EVAL_DATE,
    confidence: "high",
    note: "Covers the lane's requirements today, in-process, purpose-built for agent artifacts. Missing only OCR — which agent artifacts do not need.",
  },
};

export const DEFAULT_CATALOG: ArtifactStoreOption[] = [PAPERLESS_NGX, OWN_DOC_MODEL];
