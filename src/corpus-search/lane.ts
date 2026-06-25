// T-CKPT.corpus-search — the corpus-search LANE model.
//
// Outcome of the Exa review (output/2026-06-24-exa-review-kapelle-corpus-search):
// there are TWO distinct search lanes and the one real risk is conflating them.
//   - internal — search Kapelle's OWN private artifact corpus. Local, free,
//     offline, private. Backed by the existing SQLite FTS5 index
//     (outputs/storage.ts: searchArtifacts / artifacts_fts). This is the default.
//   - external — search the public WEB (research). A hosted provider (Exa /
//     Tavily) plugs in here behind the same contract. NOT enabled by default:
//     internal corpus queries must never silently hit a paid web API, and web
//     query syntax must never silently run through FTS5.
//
// This module is the small typed seam that keeps the lanes separate. Pure,
// dependency-free, fully unit-tested. The /artifacts/search route uses
// planCorpusSearch() as a guard before running the local FTS query.

export type CorpusSearchLane = "internal" | "external";

export type ProviderKind = "local" | "web";

/** Registry metadata for a corpus-search provider (no client here — just the
 *  contract + provenance, so the lane decision is data, not hardcoded ifs). */
export interface CorpusSearchProvider {
  id: string;
  lane: CorpusSearchLane;
  kind: ProviderKind;
  /** True when the provider calls out over the network (web providers do). */
  requires_network: boolean;
  /** Whether the provider is wired/available today. */
  enabled: boolean;
  note: string;
}

/**
 * The provider registry. Internal = the shipped local FTS5 search (enabled).
 * External web providers are registered (so the lane is real + documented) but
 * disabled until explicitly wired — per the review, Exa/Tavily are a separate,
 * later lane behind this same seam.
 */
export const CORPUS_SEARCH_PROVIDERS: readonly CorpusSearchProvider[] = [
  {
    id: "artifacts-fts",
    lane: "internal",
    kind: "local",
    requires_network: false,
    enabled: true,
    note: "SQLite FTS5 over the artifacts substrate (outputs/storage.searchArtifacts); local, private, bm25-ranked",
  },
  {
    id: "exa",
    lane: "external",
    kind: "web",
    requires_network: true,
    enabled: false,
    note: "Exa neural web search — review-recommended for the external lane; not wired (needs API key + bake-off vs tavily)",
  },
  {
    id: "tavily",
    lane: "external",
    kind: "web",
    requires_network: true,
    enabled: false,
    note: "Tavily web search — the bake-off alternative to exa for the external lane",
  },
];

/** Scope prefixes that route a query to the external (web) lane. */
const EXTERNAL_PREFIX_RE = /^\s*(web|external|exa|tavily)\s*:/i;
const INTERNAL_PREFIX_RE = /^\s*(internal|corpus|local)\s*:/i;
/** A bare URL or a `site:` operator also signals web intent. */
const WEB_INTENT_RE = /(^|\s)(https?:\/\/\S+|site:\S+)/i;

/**
 * Decide which lane a raw query targets. Pure. Internal is the default (the
 * review's "internal-first"); only an explicit `web:`/`external:` (or `exa:` /
 * `tavily:`) prefix, a bare URL, or a `site:` operator selects the external lane.
 * An explicit `internal:`/`corpus:` prefix forces internal.
 */
export function resolveCorpusLane(rawQuery: string): CorpusSearchLane {
  const q = rawQuery ?? "";
  if (INTERNAL_PREFIX_RE.test(q)) return "internal";
  if (EXTERNAL_PREFIX_RE.test(q) || WEB_INTENT_RE.test(q)) return "external";
  return "internal";
}

/** Strip a leading lane scope prefix (`web:`, `internal:`, …) so the provider
 *  receives a clean query. A URL/`site:` body is left intact. Pure. */
export function stripLanePrefix(rawQuery: string): string {
  return (rawQuery ?? "").replace(EXTERNAL_PREFIX_RE, "").replace(INTERNAL_PREFIX_RE, "").trim();
}

/** Pick the default enabled provider for a lane, or null if none is enabled. */
export function selectProvider(lane: CorpusSearchLane): CorpusSearchProvider | null {
  return CORPUS_SEARCH_PROVIDERS.find((p) => p.lane === lane && p.enabled) ?? null;
}

export type CorpusSearchPlan =
  | { ok: true; lane: CorpusSearchLane; provider: CorpusSearchProvider; query: string }
  | { ok: false; lane: CorpusSearchLane; reason: "external_lane_disabled" | "empty_query"; error: string };

/**
 * Plan a corpus search from a raw query: resolve the lane, strip the scope
 * prefix, and select the provider. Pure. The route calls this BEFORE touching
 * FTS so that:
 *   - an external/web-scoped query can't silently run through the local FTS
 *     index (it returns external_lane_disabled until a web provider is wired),
 *   - an empty query is rejected up front.
 * This is the guard that operationalizes the review's "don't conflate the lanes".
 */
export function planCorpusSearch(rawQuery: string): CorpusSearchPlan {
  const lane = resolveCorpusLane(rawQuery);
  const query = stripLanePrefix(rawQuery);
  if (!query) {
    return { ok: false, lane, reason: "empty_query", error: "search query is empty" };
  }
  const provider = selectProvider(lane);
  if (!provider) {
    return {
      ok: false,
      lane,
      reason: "external_lane_disabled",
      error:
        "external web-search lane is not enabled — no web provider (exa/tavily) is wired yet; " +
        "use an internal corpus query (no web:/site:/URL scope)",
    };
  }
  return { ok: true, lane, provider, query };
}
