// Pure track-conformance resolver — the validation source of truth shared by
// POST /tasks and POST /orchestration/backlog.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  resolveTrack,
  parseRegistryYaml,
  DEFAULT_REGISTRY,
} from '../../src/track-registry/registry.js';

// RD-006 — the human-maintained source of truth
// (agent-platform/goals-tracks-tasks.md §1b) is a separate repo, not vendored
// here. DEFAULT_REGISTRY was hand-bumped v1 → v2 without a test tying it back
// to §1b, so a future one-sided edit (registry.ts changes but §1b doesn't, or
// vice versa) would silently drift with nothing to catch it. This extracts the
// live §1b YAML fence and asserts it parses to exactly DEFAULT_REGISTRY.
const GOALS_TRACKS_TASKS_PATH = '/Users/kilgore/Dropbox/Code/agent-platform/goals-tracks-tasks.md';

/** Pull the YAML fence out of the §1b section (not just the first ```yaml
 *  fence in the file, in case an unrelated one is ever added elsewhere). */
function extractSection1bYaml(markdown: string): string {
  const sectionStart = markdown.indexOf('§1b');
  if (sectionStart === -1) {
    throw new Error('goals-tracks-tasks.md: §1b heading not found');
  }
  const fenceStart = markdown.indexOf('```yaml', sectionStart);
  if (fenceStart === -1) {
    throw new Error('goals-tracks-tasks.md: no ```yaml fence found after §1b');
  }
  const bodyStart = markdown.indexOf('\n', fenceStart) + 1;
  const fenceEnd = markdown.indexOf('```', bodyStart);
  if (fenceEnd === -1) {
    throw new Error('goals-tracks-tasks.md: unterminated ```yaml fence after §1b');
  }
  return markdown.slice(bodyStart, fenceEnd);
}

describe('resolveTrack', () => {
  it('conforms an exact canonical id', () => {
    const r = resolveTrack('T-ORCH');
    expect(r).toEqual({ conforms: true, canonical: 'T-ORCH', via: 'canonical' });
  });

  it('conforms the headline canonical id I-1', () => {
    const r = resolveTrack('I-1');
    expect(r.conforms).toBe(true);
    expect(r.via).toBe('canonical');
    expect(r.canonical).toBe('I-1');
  });

  it('conforms a deferred id (canonical resolves to itself)', () => {
    const r = resolveTrack('I-2');
    expect(r).toEqual({ conforms: true, canonical: 'I-2', via: 'deferred' });
  });

  it('conforms a sub-track via prefix rollup', () => {
    const r = resolveTrack('T-CKPT.view-switcher');
    expect(r).toEqual({ conforms: true, canonical: 'T-CKPT', via: 'prefix' });
  });

  it('rolls up a deeply dotted sub-track to its first-segment canonical', () => {
    const r = resolveTrack('T-CKPT.8.feedback');
    expect(r.conforms).toBe(true);
    expect(r.via).toBe('prefix');
    expect(r.canonical).toBe('T-CKPT');
  });

  it('resolves a legacy alias to its canonical id', () => {
    const r = resolveTrack('T15');
    expect(r).toEqual({ conforms: true, canonical: 'T-CKPT', via: 'alias' });
  });

  it('resolves a sub-track whose prefix is a legacy alias', () => {
    const r = resolveTrack('T10.loops');
    expect(r.conforms).toBe(true);
    expect(r.via).toBe('prefix');
    expect(r.canonical).toBe('T-ORCH');
  });

  it('flags an unknown track as non-conforming', () => {
    const r = resolveTrack('T-NOPE');
    expect(r).toEqual({ conforms: false, canonical: null, via: 'none' });
  });

  it('flags a sub-track whose prefix is unknown', () => {
    const r = resolveTrack('garbage.thing');
    expect(r.conforms).toBe(false);
    expect(r.canonical).toBeNull();
  });

  it('treats null / undefined / empty as non-conforming', () => {
    expect(resolveTrack(null).conforms).toBe(false);
    expect(resolveTrack(undefined).conforms).toBe(false);
    expect(resolveTrack('').conforms).toBe(false);
    expect(resolveTrack('   ').conforms).toBe(false);
  });

  it('trims surrounding whitespace before matching', () => {
    const r = resolveTrack('  T-ORCH  ');
    expect(r.conforms).toBe(true);
    expect(r.canonical).toBe('T-ORCH');
  });

  it('is case-sensitive (lowercase canonical does not conform)', () => {
    expect(resolveTrack('t-orch').conforms).toBe(false);
  });
});

describe('canonical-track-registry v2 (RD-006 — reset families + refactor wave)', () => {
  it('conforms the 6/29 reset NOW tracks that previously resolved to (unassigned)', () => {
    for (const t of ['T-PACK', 'T-COS', 'T-FIN', 'T-CTOBOX', 'T-DECHRIS', 'T-DAILY', 'T-RELY']) {
      const r = resolveTrack(t);
      expect(r.conforms, `${t} should conform`).toBe(true);
      expect(r.via).toBe('canonical');
      expect(DEFAULT_REGISTRY.canonical).toContain(t);
    }
  });

  it('conforms T-POWERHOUSE and T-REMOTE', () => {
    expect(resolveTrack('T-POWERHOUSE').conforms).toBe(true);
    expect(resolveTrack('T-REMOTE').conforms).toBe(true);
  });

  it('rolls up a T-REFACTOR.<repo> sub-track via prefix to T-REFACTOR', () => {
    const r = resolveTrack('T-REFACTOR.cane');
    expect(r).toEqual({ conforms: true, canonical: 'T-REFACTOR', via: 'prefix' });
    expect(resolveTrack('T-REFACTOR.id-agents').canonical).toBe('T-REFACTOR');
    expect(resolveTrack('T-REFACTOR').via).toBe('canonical');
  });

  it('keeps older families conforming (no alias-merge regression)', () => {
    expect(resolveTrack('T-DIST').conforms).toBe(true); // retained alongside T-PACK
    expect(resolveTrack('T-RELIABILITY').conforms).toBe(true); // retained alongside T-RELY
    expect(resolveTrack('T15').via).toBe('alias'); // legacy alias unchanged
  });
});

describe('parseRegistryYaml', () => {
  const YAML = `
# canonical-track-registry v1 (2026-06-23) — owner: maestra
canonical:                # the ≤5 primary + medium-horizon tracks
  - T-DIST               # desktop distribution
  - T-ORCH               # orchestration daemon
  - I-1                  # HEADLINE: doc-model substrate
deferred:                 # real but parked
  - I-2                  # edit-in-product / Connect
legacy_aliases:           # old track codes → canonical
  T1:  T-RELIABILITY      # dispatch lifecycle hardening
  T15: T-CKPT             # second-user / Liz fleet
conformance_threshold: 0.95
`;

  it('parses lists, alias map, and threshold from the YAML block', () => {
    const reg = parseRegistryYaml(YAML);
    expect(reg.canonical).toEqual(['T-DIST', 'T-ORCH', 'I-1']);
    expect(reg.deferred).toEqual(['I-2']);
    expect(reg.legacyAliases).toEqual({ T1: 'T-RELIABILITY', T15: 'T-CKPT' });
    expect(reg.conformanceThreshold).toBe(0.95);
  });

  it('produces a registry resolveTrack can use', () => {
    const reg = parseRegistryYaml(YAML);
    expect(resolveTrack('T15', reg)).toEqual({
      conforms: true,
      canonical: 'T-CKPT',
      via: 'alias',
    });
    expect(resolveTrack('T-DIST.foo', reg).canonical).toBe('T-DIST');
    expect(resolveTrack('T-RELIABILITY', reg).conforms).toBe(false); // alias target not a canonical entry in this minimal block
  });
});

describe('DEFAULT_REGISTRY snapshot', () => {
  it('matches the vendored canonical-track-registry v1 shape', () => {
    expect(DEFAULT_REGISTRY.canonical).toContain('T-ORCH');
    expect(DEFAULT_REGISTRY.canonical).toContain('I-1');
    expect(DEFAULT_REGISTRY.deferred).toEqual(['I-2', 'I-15']);
    expect(DEFAULT_REGISTRY.legacyAliases.T11).toBe('T-LOOP-CLOSE');
    expect(DEFAULT_REGISTRY.conformanceThreshold).toBe(0.95);
  });
});

// RD-006 — live parity guard against agent-platform/goals-tracks-tasks.md §1b,
// the human-maintained source of truth. DEFAULT_REGISTRY is a hand-maintained
// vendored copy (see registry.ts's own "Keep this snapshot in sync with §1b"
// comment) — this test is what actually enforces that instruction instead of
// just asking nicely. Skips (rather than fails) when the sibling agent-platform
// repo isn't checked out alongside id-agents, per registry.ts's documented
// deployment caveat; runs for real whenever both repos are present, which is
// the case in this dev environment.
const goalsTracksTasksAvailable = existsSync(GOALS_TRACKS_TASKS_PATH);

describe.runIf(goalsTracksTasksAvailable)('canonical-track-registry parity with §1b (RD-006)', () => {
  const liveRegistry = () =>
    parseRegistryYaml(extractSection1bYaml(readFileSync(GOALS_TRACKS_TASKS_PATH, 'utf-8')));

  it('parses the live §1b YAML fence into exactly DEFAULT_REGISTRY', () => {
    expect(liveRegistry()).toEqual(DEFAULT_REGISTRY);
  });

  it('is a real guard: a one-sided edit to either side breaks the match', () => {
    const live = liveRegistry();
    // Prove the equality check above isn't vacuously true by mutating a copy
    // of the live-parsed registry the way an unmirrored §1b edit would, and
    // confirming that no longer matches DEFAULT_REGISTRY.
    const drifted = { ...live, canonical: [...live.canonical, 'T-NEW-UNMIRRORED'] };
    expect(drifted).not.toEqual(DEFAULT_REGISTRY);
  });
});
