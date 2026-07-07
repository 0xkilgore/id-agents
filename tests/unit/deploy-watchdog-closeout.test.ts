// SPDX-License-Identifier: MIT
//
// Closeout verifier tests: after watchdog remediation, success must mean the
// running manager is fresh at the remote tip, not merely that launchctl ran.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for runtime behavior.
import {
  classifyCloseout,
  formatCloseoutMarkdown,
} from '../../scripts/lib/deploy-watchdog-closeout.mjs';

function evidence(over: Record<string, unknown> = {}) {
  return {
    healthOk: true,
    freshnessState: 'fresh',
    buildSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    originMainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    remoteMainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    remoteMainSource: 'test',
    redeployCommand: 'redeploy-now',
    ...over,
  };
}

describe('deploy-watchdog closeout classification', () => {
  it('classifies exact-SHA fresh manager at remote tip as fresh', () => {
    const c = classifyCloseout(evidence());
    expect(c.ok).toBe(true);
    expect(c.classification).toBe('fresh');
    expect(c.failures).toEqual([]);
    expect(c.escalation).toBeNull();
  });

  it('classifies stale /health freshness after remediation as stale with a crisp command', () => {
    const c = classifyCloseout(evidence({ freshnessState: 'stale_alerted' }));
    expect(c.ok).toBe(false);
    expect(c.classification).toBe('stale');
    expect(c.failures.join('; ')).toMatch(/freshness=stale_alerted/);
    expect(c.escalation).toBe('Manager still stale after watchdog remediation. Run exactly: redeploy-now');
  });

  it('classifies remote-tip mismatch as stale even when build_sha equals origin_main_sha', () => {
    const c = classifyCloseout(evidence({ remoteMainSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));
    expect(c.ok).toBe(false);
    expect(c.originMatchesRemoteTip).toBe(false);
    expect(c.failures.join('; ')).toMatch(/remote main tip/);
  });

  it('formats the closeout verifier fields operators need', () => {
    const md = formatCloseoutMarkdown(evidence({ freshnessState: 'stale' }));
    expect(md).toContain('build_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(md).toContain('origin_main_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(md).toContain('remote_main_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(md).toContain('health_freshness: stale');
    expect(md).toContain('**Escalation:** Manager still stale after watchdog remediation. Run exactly: redeploy-now');
  });
});
