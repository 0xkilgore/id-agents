// T-CKPT.corpus-search — the lane model that keeps the internal (local FTS5) and
// external (web/Exa) search lanes separate (per the Exa review's #1 risk).

import { describe, it, expect } from "vitest";
import {
  resolveCorpusLane,
  stripLanePrefix,
  selectProvider,
  planCorpusSearch,
  CORPUS_SEARCH_PROVIDERS,
} from "../../src/corpus-search/lane.js";

describe("resolveCorpusLane", () => {
  it("defaults to internal (review: internal-first)", () => {
    expect(resolveCorpusLane("blowout finances")).toBe("internal");
    expect(resolveCorpusLane("")).toBe("internal");
    expect(resolveCorpusLane("how to do a thing")).toBe("internal");
  });

  it("routes explicit web/external/exa/tavily prefixes to external", () => {
    expect(resolveCorpusLane("web: latest exa pricing")).toBe("external");
    expect(resolveCorpusLane("external: foo")).toBe("external");
    expect(resolveCorpusLane("exa: neural search")).toBe("external");
    expect(resolveCorpusLane("TAVILY: x")).toBe("external");
  });

  it("treats a bare URL or site: operator as web intent", () => {
    expect(resolveCorpusLane("https://exa.ai/pricing")).toBe("external");
    expect(resolveCorpusLane("site:exa.ai pricing")).toBe("external");
    expect(resolveCorpusLane("see https://x.com/foo for context")).toBe("external");
  });

  it("an explicit internal:/corpus: prefix forces internal even with a URL-like body", () => {
    expect(resolveCorpusLane("internal: blowout")).toBe("internal");
    expect(resolveCorpusLane("corpus: q2 close")).toBe("internal");
  });
});

describe("stripLanePrefix", () => {
  it("removes the lane scope prefix and trims", () => {
    expect(stripLanePrefix("web: exa pricing")).toBe("exa pricing");
    expect(stripLanePrefix("internal:  blowout ")).toBe("blowout");
    expect(stripLanePrefix("plain query")).toBe("plain query");
  });
  it("leaves a URL/site: body intact (only a leading scope prefix is stripped)", () => {
    expect(stripLanePrefix("https://exa.ai")).toBe("https://exa.ai");
    expect(stripLanePrefix("site:exa.ai pricing")).toBe("site:exa.ai pricing");
  });
});

describe("selectProvider", () => {
  it("returns the enabled local provider for internal", () => {
    const p = selectProvider("internal");
    expect(p?.id).toBe("artifacts-fts");
    expect(p?.kind).toBe("local");
    expect(p?.requires_network).toBe(false);
  });
  it("returns null for external (no web provider wired yet)", () => {
    expect(selectProvider("external")).toBeNull();
  });
});

describe("planCorpusSearch", () => {
  it("plans an internal query onto the local FTS provider with a clean query", () => {
    const plan = planCorpusSearch("internal: blowout finances");
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.lane).toBe("internal");
      expect(plan.provider.id).toBe("artifacts-fts");
      expect(plan.query).toBe("blowout finances");
    }
  });

  it("plans a bare internal query unchanged", () => {
    const plan = planCorpusSearch("q2 close");
    expect(plan.ok && plan.query).toBe("q2 close");
  });

  it("rejects an external/web-scoped query (lane not enabled) — the conflation guard", () => {
    const plan = planCorpusSearch("web: exa pricing");
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.lane).toBe("external");
      expect(plan.reason).toBe("external_lane_disabled");
      expect(plan.error).toMatch(/external web-search lane/i);
    }
  });

  it("rejects a URL query (web intent) rather than running it through FTS", () => {
    const plan = planCorpusSearch("https://exa.ai/pricing");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("external_lane_disabled");
  });

  it("reports empty_query for a blank internal query (route falls through to empty results)", () => {
    const plan = planCorpusSearch("   ");
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.lane).toBe("internal");
      expect(plan.reason).toBe("empty_query");
    }
  });
});

describe("provider registry integrity", () => {
  it("has exactly one enabled provider and it is the internal local one", () => {
    const enabled = CORPUS_SEARCH_PROVIDERS.filter((p) => p.enabled);
    expect(enabled.map((p) => p.id)).toEqual(["artifacts-fts"]);
    expect(enabled[0].lane).toBe("internal");
  });
  it("registers exa + tavily as disabled external web providers (review: future lane)", () => {
    const external = CORPUS_SEARCH_PROVIDERS.filter((p) => p.lane === "external");
    expect(external.map((p) => p.id).sort()).toEqual(["exa", "tavily"]);
    expect(external.every((p) => !p.enabled && p.requires_network && p.kind === "web")).toBe(true);
  });
});
