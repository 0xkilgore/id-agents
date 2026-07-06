// SPDX-License-Identifier: MIT
//
// Fleet file-drop receiver — pure decision logic. Every case here maps
// directly to a plan (Slice B) acceptance criterion.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { decideBatchOutcome, INCOMPLETE_GRACE_MS } from '../../scripts/lib/agentdrop-watcher-decision.mjs';

const validManifestResult = {
  ok: true,
  manifest: { schema: 'agentdrop.v1', batch_id: 'b1', agent: 'finances', sender: 'chris', files: ['a.csv', 'b.csv'], sent_at: '2026-07-04T00:00:00Z' },
};
const complete = { complete: true, missing: [] };
const foundAgent = { found: true, agent: { workingDirectory: '/Users/kilgore/Dropbox/Code/finances' } };

describe('decideBatchOutcome', () => {
  it('delivers when the manifest is valid, the batch is complete, and the agent resolves', () => {
    const d = decideBatchOutcome({ manifestResult: validManifestResult, batchComplete: complete, manifestAgeMs: 1000, agentResolution: foundAgent });
    expect(d.action).toBe('deliver');
    expect(d.targetDirSuffix).toBe('inbox/b1');
  });

  it('quarantines an invalid/malformed manifest, regardless of anything else', () => {
    const d = decideBatchOutcome({
      manifestResult: { ok: false, errors: ['schema must be "agentdrop.v1", got "bogus"'] },
      batchComplete: complete,
      agentResolution: foundAgent,
    });
    expect(d.action).toBe('quarantine');
    expect(d.reason).toMatch(/invalid or missing manifest/);
  });

  it('quarantines a manifest missing entirely (synthetic {ok:false} with a "missing" error)', () => {
    const d = decideBatchOutcome({
      manifestResult: { ok: false, errors: ['manifest is not valid JSON: Unexpected end of input'] },
    });
    expect(d.action).toBe('quarantine');
  });

  it('quarantines when the named agent is unknown to the live registry — never guesses a destination', () => {
    const d = decideBatchOutcome({
      manifestResult: validManifestResult,
      batchComplete: complete,
      manifestAgeMs: 1000,
      agentResolution: { found: false, agent: null },
    });
    expect(d.action).toBe('quarantine');
    expect(d.reason).toMatch(/unknown agent "finances"/);
  });

  it('quarantines when the resolved agent has no workingDirectory', () => {
    const d = decideBatchOutcome({
      manifestResult: validManifestResult,
      batchComplete: complete,
      manifestAgeMs: 1000,
      agentResolution: { found: true, agent: { workingDirectory: null } },
    });
    expect(d.action).toBe('quarantine');
    expect(d.reason).toMatch(/no workingDirectory/);
  });

  // --- "watcher restart mid-batch" (plan Slice B acceptance) ---
  //
  // This decision function is the ENTIRE state a restart could lose — and it
  // takes no in-memory input at all, only fresh filesystem-derived facts
  // (manifest content, which files are present, how old the manifest is).
  // So "restart mid-batch" IS exactly: call this function once while
  // incomplete, then again later once complete, with nothing carried over
  // between the two calls except what's really on disk — which is the same
  // shape a real process restart produces.
  describe('restart mid-batch (incomplete -> wait -> complete -> deliver)', () => {
    it('an incomplete batch within the grace period waits — does not quarantine a transfer still in progress', () => {
      const stillDraining = { complete: false, missing: ['b.csv'] };
      const d = decideBatchOutcome({ manifestResult: validManifestResult, batchComplete: stillDraining, manifestAgeMs: 5000, agentResolution: foundAgent });
      expect(d.action).toBe('wait');
    });

    it('the SAME batch, re-decided after the remaining file has arrived, delivers — no memory of the prior "wait" needed', () => {
      // Simulates: watcher (or its process) re-scans from scratch (e.g. after
      // a restart) and now sees the full file list present.
      const d = decideBatchOutcome({ manifestResult: validManifestResult, batchComplete: complete, manifestAgeMs: 6000, agentResolution: foundAgent });
      expect(d.action).toBe('deliver');
    });

    it('an incomplete batch PAST the grace period is quarantined — a genuinely stuck/partial transfer, not silently left forever', () => {
      const stillMissing = { complete: false, missing: ['b.csv'] };
      const d = decideBatchOutcome({
        manifestResult: validManifestResult,
        batchComplete: stillMissing,
        manifestAgeMs: INCOMPLETE_GRACE_MS + 1,
        agentResolution: foundAgent,
      });
      expect(d.action).toBe('quarantine');
      expect(d.reason).toMatch(/incomplete after grace period/);
    });

    it('a custom grace window is honored', () => {
      const stillMissing = { complete: false, missing: ['b.csv'] };
      const d = decideBatchOutcome({ manifestResult: validManifestResult, batchComplete: stillMissing, manifestAgeMs: 100, agentResolution: foundAgent, graceMs: 50 });
      expect(d.action).toBe('quarantine');
    });
  });
});
