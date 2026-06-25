// RF2 — model-gateway recommender tests. Pin the decision math so the
// adopt-vs-extend-own call (Portkey/LiteLLM/OpenRouter vs extending our own
// model-policy routing) is a versioned, testable artifact (not prose).

import { describe, it, expect } from "vitest";
import {
  recommendGateway,
  computeAdoptVsExtend,
  requiredCapabilities,
  adoptMonthlyUsd,
  extendOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
} from "../../src/gateway-eval/recommend.js";
import {
  PORTKEY,
  LITELLM,
  OPENROUTER,
  OWN_MODEL_POLICY,
  DEFAULT_CATALOG,
} from "../../src/gateway-eval/catalog.js";
import type { GatewayRequirements } from "../../src/gateway-eval/types.js";

// Full gateway feature set required.
const FULL: GatewayRequirements = {
  need_provider_neutral_routing: true,
  need_fallbacks_retries: true,
  need_load_balancing: true,
  need_guardrails: true,
  need_semantic_caching: true,
  need_observability: true,
  need_virtual_keys_budgets: true,
  require_self_host: false,
  prefer_otel: true,
  max_added_latency_ms: 0,
  needed_languages: ["typescript"],
  expected_requests_per_month: 1_000_000,
};

describe("required capabilities + cost helpers", () => {
  it("derives the capability checklist from need_* flags", () => {
    expect(requiredCapabilities(FULL)).toHaveLength(7);
    expect(requiredCapabilities({ ...FULL, need_guardrails: false })).not.toContain("guardrails");
  });

  it("adoptMonthlyUsd takes the cheaper of hosted vs self-host; Infinity when no self-host & self-host required", () => {
    expect(adoptMonthlyUsd(PORTKEY, FULL, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(100, 5); // hosted 100 < self-host 1080
    expect(adoptMonthlyUsd(LITELLM, FULL, DEFAULT_COST_ASSUMPTIONS)).toBe(0); // free OSS
    expect(adoptMonthlyUsd(OPENROUTER, { ...FULL, require_self_host: true }, DEFAULT_COST_ASSUMPTIONS)).toBe(Number.POSITIVE_INFINITY);
  });

  it("extendOwnMonthlyUsd scales with the capabilities our own routing still lacks", () => {
    // OWN lacks 5 of the 7 (has routing + fallbacks): 0 infra + 1*800 ops + (5*8*800)/12 = 800 + 2666.67
    expect(extendOwnMonthlyUsd(FULL, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(3466.67, 1);
    // Needing only routing+fallbacks (which OWN already has) → no build, ops only.
    const minimal = { ...FULL, need_load_balancing: false, need_guardrails: false, need_semantic_caching: false, need_observability: false, need_virtual_keys_budgets: false };
    expect(extendOwnMonthlyUsd(minimal, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(800, 5);
  });
});

describe("gates", () => {
  it("disqualifies the hosted aggregator when self-host is required", () => {
    const rec = recommendGateway({ ...FULL, require_self_host: true });
    expect(rec.ranking.find((r) => r.gateway_id === "openrouter")!.disqualifiers).toContain("not_self_hostable");
  });

  it("disqualifies options over the latency ceiling", () => {
    const rec = recommendGateway({ ...FULL, max_added_latency_ms: 35 });
    // Portkey 40ms, OpenRouter 60ms exceed; LiteLLM 30ms ok.
    expect(rec.ranking.find((r) => r.gateway_id === "portkey")!.disqualifiers).toContain("latency_exceeded");
    expect(rec.ranking.find((r) => r.gateway_id === "openrouter")!.disqualifiers).toContain("latency_exceeded");
    expect(rec.ranking.find((r) => r.gateway_id === "litellm")!.disqualifiers).toHaveLength(0);
  });
});

describe("recommendGateway", () => {
  it("recommends an OSS gateway (not our own baseline), deterministically, with the adopt/extend call attached", () => {
    const rec = recommendGateway(FULL, { now: () => new Date("2026-06-24T00:00:00.000Z") });
    expect(rec.generated_at).toBe("2026-06-24T00:00:00.000Z");
    // The "own" option is the extend baseline, never the recommended gateway.
    expect(rec.recommended_gateway_id).not.toBe("own_model_policy");
    expect(["portkey", "litellm", "openrouter"]).toContain(rec.recommended_gateway_id);
    // On default weights, the free full-capability OSS gateway (LiteLLM) leads.
    expect(rec.recommended_gateway_id).toBe("litellm");
    expect(rec.adopt_vs_extend?.gateway_id).toBe("litellm");
  });

  it("flags OpenRouter's capability gaps (no guardrails / no semantic caching)", () => {
    const rec = recommendGateway(FULL);
    const orouter = rec.ranking.find((r) => r.gateway_id === "openrouter")!;
    expect(orouter.capability_gaps).toEqual(expect.arrayContaining(["guardrails", "semantic_caching"]));
  });
});

describe("adopt vs extend-own", () => {
  it("free/cheap OSS gateway beats building 5 capabilities ourselves → adopt_gateway", () => {
    const av = computeAdoptVsExtend(LITELLM, FULL, DEFAULT_COST_ASSUMPTIONS);
    expect(av.verdict).toBe("adopt_gateway");
    expect(av.adopt_usd_per_month).toBe(0);
    expect(av.extend_own_usd_per_month).toBeCloseTo(3466.67, 1);
    expect(av.gateway_is_oss).toBe(true);
  });

  it("when extending own is made free, the verdict flips to extend_own", () => {
    const av = computeAdoptVsExtend(PORTKEY, { ...FULL, require_self_host: true }, {
      ...DEFAULT_COST_ASSUMPTIONS,
      per_capability_build_days: 0,
      extend_own_ops_person_days_per_month: 0,
      extend_own_infra_usd_per_month: 0,
    });
    expect(av.verdict).toBe("extend_own"); // adopt = Portkey self-host (~$1080), extend-own = $0
  });

  it("near the crossover → too_close_to_call", () => {
    // Portkey hosted adopt = $100; tune extend-own to ~$100.
    const av = computeAdoptVsExtend(PORTKEY, FULL, {
      ...DEFAULT_COST_ASSUMPTIONS,
      per_capability_build_days: 0,
      extend_own_ops_person_days_per_month: 0,
      extend_own_infra_usd_per_month: 100,
    });
    expect(av.verdict).toBe("too_close_to_call");
  });
});

describe("catalog honesty", () => {
  it("ships Portkey + the alternatives, OSS flags + pricing flagged for re-verification", () => {
    expect(DEFAULT_CATALOG.map((o) => o.id)).toEqual(expect.arrayContaining(["portkey", "litellm", "openrouter", "own_model_policy"]));
    expect(PORTKEY.open_source).toBe(true);
    expect(OPENROUTER.open_source).toBe(false); // hosted SaaS
    expect(OPENROUTER.self_host.available).toBe(false);
    expect(PORTKEY.hosted_cost.provenance.verify_before_use).toBe(true);
    // our own routing already has provider-neutral routing + fallbacks
    expect(OWN_MODEL_POLICY.capabilities.provider_neutral_routing).toBe(true);
    expect(OWN_MODEL_POLICY.capabilities.guardrails).toBe(false);
  });
});
