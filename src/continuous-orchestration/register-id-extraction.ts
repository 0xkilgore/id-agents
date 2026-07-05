// Continuous Orchestration — register-native-ID extraction.
//
// kapelle-feedback-register.md items carry their OWN canonical ID scheme in
// prose (e.g. `arf:v4:reader-3col-rebalance`, `t-ckpt:ui-needs-attention-
// inbox-filter`, `kfb:v3:artifact-split-layout-right-rail`) — colon-delimited
// tokens distinct from this repo's own `roadmap:<track>:<title>` scheme
// (roadmap-import.ts). Whoever authors a new orchestration_backlog_item from
// a register entry (today: maestra's Python scripts POSTing directly to
// /orchestration/backlog; potentially other agents or a future importer)
// mints a FRESH logical_key each time rather than reusing the register's own
// ID, so exact-logical_key dedup can never catch a re-authored duplicate.
// This module extracts the register-native ID substrings from free text so
// a duplicate-detection guard can compare them across backlog rows,
// independent of whatever logical_key each row happens to carry.
//
// Pure, no I/O.

const REGISTER_ID_RE = /\b[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9.-]*){1,}\b/g;

// `roadmap:` is this repo's OWN internally-generated scheme (roadmap-
// import.ts), already deduplicated by exact logical_key — treating it as a
// "register-native ID" here would make this guard fight with that already-
// correct path. `http(s):` excludes URLs, which incidentally match the same
// colon-delimited shape.
const EXCLUDED_PREFIXES = new Set(["roadmap", "http", "https"]);

/**
 * Extract register-native ID substrings (e.g. "arf:v4:reader-3col-
 * rebalance") from free text. Case-insensitive; returns lowercase, deduped,
 * in first-seen order. Returns [] for empty/absent text.
 */
export function extractRegisterIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(REGISTER_ID_RE) ?? [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const prefix = m.split(":")[0];
    if (EXCLUDED_PREFIXES.has(prefix)) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    ids.push(m);
  }
  return ids;
}
