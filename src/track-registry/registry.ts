// Canonical track registry — the validation source of truth for track strings
// on tasks and orchestration backlog items.
//
// SOURCE OF TRUTH (human-maintained, machine-readable):
//   /Users/kilgore/Dropbox/Code/agent-platform/goals-tracks-tasks.md §1b
//   "canonical-track-registry v1 (2026-06-23) — owner: maestra"
//
// That md file lives in a SEPARATE repo (agent-platform) that is not guaranteed
// to be deployed alongside id-agents, so we vendor a parsed copy of the registry
// here. `parseRegistryYaml()` can re-derive the same shape from the raw YAML
// block if a caller wants to load it live; `DEFAULT_REGISTRY` is the vendored
// snapshot used by `resolveTrack()` when no override is supplied. Keep this
// snapshot in sync with §1b (the conformance_threshold + the three lists below).

/** A parsed canonical-track-registry. */
export interface TrackRegistry {
  /** The ≤5 primary + medium-horizon canonical track ids. */
  canonical: string[];
  /** Real-but-parked track ids (conform, but flagged deferred). */
  deferred: string[];
  /** Legacy track code → canonical id. */
  legacyAliases: Record<string, string>;
  /** Sentinel alert threshold for conforming-share. */
  conformanceThreshold: number;
}

/**
 * Vendored snapshot of canonical-track-registry v2 (2026-07-02).
 * Source: agent-platform/goals-tracks-tasks.md §1b.
 *
 * RD-006: v1 predated the 2026-06-29 8-week roadmap reset track families and the
 * `T-REFACTOR.<repo>` refactor-wave family, so live items on those tracks resolved
 * to `(unassigned)` — a lying surface for the tracks/projects status tracker.
 * v2 adds the reset NOW tracks (T-PACK/T-COS/T-FIN/T-CTOBOX/T-DECHRIS/T-DAILY/
 * T-RELY), the refactor wave (T-REFACTOR — `T-REFACTOR.<repo>` conforms via prefix),
 * plus T-POWERHOUSE and T-REMOTE. Older families are retained (not alias-merged)
 * so existing items keep conforming.
 */
export const DEFAULT_REGISTRY: TrackRegistry = {
  canonical: [
    'T-DIST',
    'T-LOOP-CLOSE',
    'T-RELIABILITY',
    'T-ORCH',
    'T-CKPT',
    'T-MODEL',
    'T-OSS',
    'T-DEPLOY',
    'T-QA',
    'T14',
    'I-1',
    // v2 (2026-07-02, RD-006) — 6/29 reset NOW tracks + refactor wave + live tracks.
    'T-PACK',
    'T-COS',
    'T-FIN',
    'T-CTOBOX',
    'T-DECHRIS',
    'T-DAILY',
    'T-RELY',
    'T-REFACTOR', // refactor wave; `T-REFACTOR.<repo>` rolls up via prefix
    'T-POWERHOUSE',
    'T-REMOTE',
  ],
  deferred: ['I-2', 'I-15'],
  legacyAliases: {
    T1: 'T-RELIABILITY',
    T10: 'T-ORCH',
    T11: 'T-LOOP-CLOSE',
    T13: 'T-CKPT',
    T15: 'T-CKPT',
    T16: 'T-RELIABILITY',
  },
  conformanceThreshold: 0.95,
};

/** How a track string was resolved against the registry. */
export type ResolveVia = 'canonical' | 'deferred' | 'prefix' | 'alias' | 'none';

export interface ResolveResult {
  /** Whether the track conforms to the registry. */
  conforms: boolean;
  /** The canonical id the track maps to, or null if non-conforming. */
  canonical: string | null;
  /** Which rule matched (or "none"). */
  via: ResolveVia;
}

/**
 * Resolve a track string against the canonical-track-registry.
 *
 * Conformance rule (a track conforms iff ANY of):
 *   1. It equals a canonical id OR a deferred id, OR
 *   2. Its prefix before the first `.` rolls up to a canonical id
 *      (e.g. "T-CKPT.view-switcher" → "T-CKPT"), OR
 *   3. It resolves via legacy_aliases (alias → canonical id).
 *
 * Resolution is deterministic and pure. Matching is exact (case-sensitive) to
 * mirror how the md registry stores ids; whitespace is trimmed first.
 *
 * @param track     The track string to check (may be null/undefined/empty).
 * @param registry  Registry to validate against (defaults to the vendored snapshot).
 */
export function resolveTrack(
  track: string | null | undefined,
  registry: TrackRegistry = DEFAULT_REGISTRY,
): ResolveResult {
  if (track == null) return { conforms: false, canonical: null, via: 'none' };
  const t = track.trim();
  if (t === '') return { conforms: false, canonical: null, via: 'none' };

  // 1a. exact canonical id
  if (registry.canonical.includes(t)) {
    return { conforms: true, canonical: t, via: 'canonical' };
  }
  // 1b. exact deferred id (conforms; canonical is the deferred id itself)
  if (registry.deferred.includes(t)) {
    return { conforms: true, canonical: t, via: 'deferred' };
  }
  // 3. legacy alias (checked before prefix so an exact alias resolves to its
  //    mapped canonical rather than being treated as a prefix).
  if (Object.prototype.hasOwnProperty.call(registry.legacyAliases, t)) {
    return { conforms: true, canonical: registry.legacyAliases[t], via: 'alias' };
  }
  // 2. prefix-before-first-dot rolls up to a canonical id (or a deferred id, or
  //    an alias — sub-tracks of any conforming root conform).
  const dot = t.indexOf('.');
  if (dot > 0) {
    const prefix = t.slice(0, dot);
    if (registry.canonical.includes(prefix)) {
      return { conforms: true, canonical: prefix, via: 'prefix' };
    }
    if (registry.deferred.includes(prefix)) {
      return { conforms: true, canonical: prefix, via: 'prefix' };
    }
    if (Object.prototype.hasOwnProperty.call(registry.legacyAliases, prefix)) {
      return { conforms: true, canonical: registry.legacyAliases[prefix], via: 'prefix' };
    }
  }

  return { conforms: false, canonical: null, via: 'none' };
}

/**
 * Parse the raw YAML body of the canonical-track-registry block (the content
 * between the ```yaml fences in §1b) into a TrackRegistry. Intentionally a tiny
 * line parser — the block is flat (top-level `canonical:`/`deferred:` lists,
 * a `legacy_aliases:` map, and `conformance_threshold:`); no general YAML.
 * Comments (`# ...`) and blank lines are ignored.
 */
export function parseRegistryYaml(yaml: string): TrackRegistry {
  const reg: TrackRegistry = {
    canonical: [],
    deferred: [],
    legacyAliases: {},
    conformanceThreshold: DEFAULT_REGISTRY.conformanceThreshold,
  };
  let section: 'canonical' | 'deferred' | 'legacy_aliases' | null = null;

  for (const rawLine of yaml.split('\n')) {
    // strip trailing inline comments and surrounding whitespace
    const noComment = rawLine.replace(/#.*$/, '');
    const line = noComment.replace(/\s+$/, '');
    if (line.trim() === '') continue;

    const indented = /^\s/.test(line);
    const trimmed = line.trim();

    if (!indented) {
      // a top-level key: `canonical:`, `deferred:`, `legacy_aliases:`,
      // or `conformance_threshold: 0.95`
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(trimmed);
      if (m) {
        const key = m[1];
        const inlineVal = m[2];
        if (key === 'canonical' || key === 'deferred' || key === 'legacy_aliases') {
          section = key;
        } else {
          section = null;
          if (key === 'conformance_threshold' && inlineVal) {
            const n = Number.parseFloat(inlineVal);
            if (!Number.isNaN(n)) reg.conformanceThreshold = n;
          }
        }
      }
      continue;
    }

    // indented line — belongs to the current section
    if (section === 'canonical' || section === 'deferred') {
      const li = /^-\s*(\S+)/.exec(trimmed);
      if (li) reg[section].push(li[1]);
    } else if (section === 'legacy_aliases') {
      const kv = /^([^:]+):\s*(\S+)/.exec(trimmed);
      if (kv) reg.legacyAliases[kv[1].trim()] = kv[2].trim();
    }
  }

  return reg;
}
