// OSS-lift eval — artifact-store recommender tests. Pin the decision math so
// the paperless-ngx-vs-own-doc-model call is a versioned, testable artifact.

import { describe, it, expect } from "vitest";
import {
  recommendArtifactStore,
  computeAdoptVsExtend,
  requiredCapabilities,
  adoptMonthlyUsd,
  extendOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
} from "../../src/artifact-store-eval/recommend.js";
import { PAPERLESS_NGX, OWN_DOC_MODEL, DEFAULT_CATALOG } from "../../src/artifact-store-eval/catalog.js";
import type { ArtifactStoreOption, ArtifactStoreRequirements } from "../../src/artifact-store-eval/types.js";

// The doc-model / artifact-store lane: text artifacts, in-process, agent-fit,
// no OCR.
const LANE: ArtifactStoreRequirements = {
  need_full_text_search: true,
  need_structured_metadata: true,
  need_ingestion_pipeline: true,
  need_versioning_audit: true,
  need_rest_api: true,
  need_ocr: false,
  require_in_process: true,
  require_agent_artifact_fit: true,
  require_self_host: false,
  needed_languages: ["typescript"],
};

function adoptCandidate(overrides: Partial<ArtifactStoreOption> = {}): ArtifactStoreOption {
  return {
    id: "synthetic",
    name: "Synthetic store",
    url: "",
    kind: "adopt",
    open_source: true,
    license: "MIT",
    capabilities: {
      full_text_search: true,
      structured_metadata: true,
      ingestion_pipeline: true,
      versioning_audit: true,
      rest_api: true,
      in_process: true,
      agent_artifact_fit: true,
      ocr: true,
      self_host: true,
      sdk_languages: ["typescript"],
    },
    hosted_cost: { billing_unit: "free", hosted_available: false, usd_per_month_hosted: 0, free_tier: true, provenance: { as_of: "x", confidence: "low" } },
    self_host: { available: true, setup_effort_person_days: 0, ops_burden_person_days_per_month: 0, infra_usd_per_month: 50, backing_services: [], provenance: { as_of: "x", confidence: "low" } },
    provenance: { as_of: "x", confidence: "low" },
    ...overrides,
  };
}

describe("required capabilities + cost helpers", () => {
  it("derives the checklist (OCR excluded for the lane)", () => {
    expect(requiredCapabilities(LANE)).not.toContain("ocr");
    expect(requiredCapabilities(LANE)).toHaveLength(5);
  });

  it("adoptMonthlyUsd uses self-host cost for a self-host-only OSS tool (no phantom $0 hosted)", () => {
    // paperless: 150 infra + 3*800 ops + 12*800/12 setup = 150 + 2400 + 800 = 3350
    expect(adoptMonthlyUsd(PAPERLESS_NGX, LANE, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(3350, 1);
    // own substrate already exists → $0
    expect(adoptMonthlyUsd(OWN_DOC_MODEL, LANE, DEFAULT_COST_ASSUMPTIONS)).toBe(0);
  });

  it("extendOwnMonthlyUsd is 0 when own already covers the lane, >0 when a cap is missing", () => {
    expect(extendOwnMonthlyUsd(LANE, DEFAULT_COST_ASSUMPTIONS)).toBe(0); // own covers all 5
    // demand OCR (own lacks it): 1 gap * 10 days * 800 / 12 = 666.67
    expect(extendOwnMonthlyUsd({ ...LANE, need_ocr: true }, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(666.67, 1);
  });
});

describe("gates", () => {
  it("paperless-ngx is gated out of the agent-artifact lane (purpose + in-process + language)", () => {
    const rec = recommendArtifactStore(LANE);
    const p = rec.ranking.find((r) => r.store_id === "paperless_ngx")!;
    expect(p.disqualifiers).toEqual(expect.arrayContaining(["not_in_process", "wrong_purpose", "missing_language:typescript"]));
  });
});

describe("recommendArtifactStore", () => {
  it("recommends extending our own substrate; verdict extend_own due to hard fit failure", () => {
    const rec = recommendArtifactStore(LANE, { now: () => new Date("2026-06-24T00:00:00.000Z") });
    expect(rec.generated_at).toBe("2026-06-24T00:00:00.000Z");
    expect(rec.recommended_store_id).toBe("own_doc_model");
    expect(rec.adopt_vs_extend?.adopt_candidate_id).toBe("paperless_ngx");
    expect(rec.adopt_vs_extend?.verdict).toBe("extend_own");
    expect(rec.adopt_vs_extend?.adopt_usd_per_month).toBeCloseTo(3350, 1);
    expect(rec.adopt_vs_extend?.extend_own_usd_per_month).toBe(0);
    // license is not the blocker (GPL-3.0 is liftable) — the rationale says so
    expect(rec.adopt_vs_extend?.rationale.join(" ")).toMatch(/directive #77|fit/i);
  });
});

describe("adopt vs extend (verdict branches via a fit-passing candidate)", () => {
  it("a cheap, fit-passing candidate beats a costly extend-own → adopt", () => {
    // permissive req so the synthetic candidate passes fit gates; demand OCR so
    // own has a real gap (extend-own = $666/mo) vs synthetic adopt ($50/mo).
    const permissive: ArtifactStoreRequirements = {
      ...LANE, need_full_text_search: false, need_structured_metadata: false, need_ingestion_pipeline: false,
      need_versioning_audit: false, need_rest_api: false, need_ocr: true,
      require_in_process: false, require_agent_artifact_fit: false, needed_languages: [],
    };
    const av = computeAdoptVsExtend(adoptCandidate(), permissive, DEFAULT_COST_ASSUMPTIONS);
    expect(av.verdict).toBe("adopt");
  });

  it("near the crossover → too_close_to_call", () => {
    const permissive: ArtifactStoreRequirements = {
      ...LANE, need_full_text_search: false, need_structured_metadata: false, need_ingestion_pipeline: false,
      need_versioning_audit: false, need_rest_api: false, need_ocr: true,
      require_in_process: false, require_agent_artifact_fit: false, needed_languages: [],
    };
    // synthetic adopt = $100 (infra); tune extend-own to ~$100 (1 gap * 1.5d * 800 / 12 = 100).
    const av = computeAdoptVsExtend(
      adoptCandidate({ self_host: { available: true, setup_effort_person_days: 0, ops_burden_person_days_per_month: 0, infra_usd_per_month: 100, backing_services: [], provenance: { as_of: "x", confidence: "low" } } }),
      permissive,
      { ...DEFAULT_COST_ASSUMPTIONS, per_capability_build_days: 1.5 },
    );
    expect(av.verdict).toBe("too_close_to_call");
  });
});

describe("catalog honesty", () => {
  it("paperless-ngx is GPL-3.0 OSS but not agent-artifact-fit / not in-process; own substrate is", () => {
    expect(DEFAULT_CATALOG.map((o) => o.id)).toEqual(["paperless_ngx", "own_doc_model"]);
    expect(PAPERLESS_NGX.open_source).toBe(true);
    expect(PAPERLESS_NGX.license).toBe("GPL-3.0");
    expect(PAPERLESS_NGX.capabilities.agent_artifact_fit).toBe(false);
    expect(PAPERLESS_NGX.capabilities.ocr).toBe(true);
    expect(PAPERLESS_NGX.self_host.provenance.verify_before_use).toBe(true);
    expect(OWN_DOC_MODEL.capabilities.agent_artifact_fit).toBe(true);
    expect(OWN_DOC_MODEL.capabilities.in_process).toBe(true);
  });
});
