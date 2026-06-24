// Pure track-conformance resolver — the validation source of truth shared by
// POST /tasks and POST /orchestration/backlog.

import { describe, it, expect } from 'vitest';
import {
  resolveTrack,
  parseRegistryYaml,
  DEFAULT_REGISTRY,
} from '../../src/track-registry/registry.js';

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
