// SPDX-License-Identifier: MIT
//
// Spec 053 — runVerifySignal conformance tests. Tests inject fakes via
// VerifyContext so checks run hermetically (no real HTTP / FS / Vercel).

import { describe, it, expect } from 'vitest';
import { runVerifySignal } from '../../src/verify/runner.js';
import type { VerifyContext } from '../../src/verify/types.js';

const assert = {
  equal<T>(actual: T, expected: T) { expect(actual).toBe(expected); },
};

describe('runVerifySignal', () => {
  it('passes desk_tag when artifact path is in Desk.md', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      readFile: async () => '# Desk\n\n- [foo](/path/to/artifact.md)\n',
    };
    const result = await runVerifySignal(
      { type: 'desk_tag', artifact_path: '/path/to/artifact.md', within_hours: 24 },
      ctx,
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.failures.length, 0);
  });

  it('fails desk_tag when artifact path is missing from Desk.md', async () => {
    const ctx: VerifyContext = {
      dispatched_at: Date.now(),
      readFile: async () => '# Desk\n\nnothing relevant\n',
    };
    const result = await runVerifySignal(
      { type: 'desk_tag', artifact_path: '/path/to/artifact.md', within_hours: 24 },
      ctx,
    );
    assert.equal(result.status, 'fail');
    assert.equal(result.failures.length, 1);
  });
});
