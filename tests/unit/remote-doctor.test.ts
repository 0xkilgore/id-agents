// SPDX-License-Identifier: MIT
//
// kapelle-remote-doctor v1 verdict engine — acceptance criteria (§2.2). Pure over
// injected probe inputs; no I/O.

import { describe, it, expect } from 'vitest';
import {
  computeDoctorReport,
  computeTransportVerdict,
  doctorExitCode,
  formatDoctorMarkdown,
  type DoctorProbeInput,
} from '../../src/remote-doctor/index.js';

const NOW = '2026-07-01T18:00:00.000Z';
const SHA = 'abc1234';

/** A fully-healthy, safe-to-fire probe input; override per test. */
function healthy(over: Partial<DoctorProbeInput> = {}): DoctorProbeInput {
  return {
    generated_at: NOW,
    transport: { tunnel: 'ok', magicdns: 'ok', tailscale_ip: 'ok' },
    manager: { health: 'ok', build_sha: SHA, origin_main_sha: SHA, startup_errors: [] },
    reactor: { health: 'ok' },
    kapelle_ops: { auth: '200', via: 'magicdns', build_sha: SHA, origin_main_sha: SHA, runtime_stamp: 'kapelle-ops-1' },
    orchestration: { mode: 'running', kill_switch: false, auto_paused: false },
    agents: { registered: 32, offline: [] },
    ...over,
  };
}

describe('computeTransportVerdict (criterion 2 — degraded, not false-negative)', () => {
  it('all ok → ok', () => {
    expect(computeTransportVerdict({ tunnel: 'ok', magicdns: 'ok', tailscale_ip: 'ok' })).toBe('ok');
  });
  it('MagicDNS fails but Tailscale IP works → degraded', () => {
    expect(computeTransportVerdict({ tunnel: 'ok', magicdns: 'fail', tailscale_ip: 'ok' })).toBe('degraded');
  });
  it('both MagicDNS and IP fail → down', () => {
    expect(computeTransportVerdict({ tunnel: 'ok', magicdns: 'fail', tailscale_ip: 'fail' })).toBe('down');
  });
  it('tunnel down → down regardless of DNS/IP', () => {
    expect(computeTransportVerdict({ tunnel: 'down', magicdns: 'ok', tailscale_ip: 'ok' })).toBe('down');
  });
});

describe('the default happy path', () => {
  it('all healthy → safe_to_fire true, no reasons, exit 0', () => {
    const r = computeDoctorReport(healthy());
    expect(r.doctor_version).toBe('1');
    expect(r.safe_to_fire).toBe(true);
    expect(r.safe_to_fire_reasons).toEqual([]);
    expect(r.transport.verdict).toBe('ok');
    expect(r.freshness.all_nodes_fresh).toBe(true);
    expect(r.freshness.release_cohort).toBe('n/a'); // §3: no manifest couples nodes
    expect(doctorExitCode(r)).toBe(0);
    expect(r.next_action).toMatch(/Safe to fire/);
  });
});

describe('criterion 2 — degraded transport does NOT block safe_to_fire', () => {
  it('MagicDNS fail + IP ok → verdict degraded, safe_to_fire still true', () => {
    const r = computeDoctorReport(healthy({ transport: { tunnel: 'ok', magicdns: 'fail', tailscale_ip: 'ok' } }));
    expect(r.transport.verdict).toBe('degraded');
    expect(r.safe_to_fire).toBe(true);
  });
  it('real outage (both fail) → verdict down, safe_to_fire false with transport reason', () => {
    const r = computeDoctorReport(healthy({ transport: { tunnel: 'ok', magicdns: 'fail', tailscale_ip: 'fail' } }));
    expect(r.transport.verdict).toBe('down');
    expect(r.safe_to_fire).toBe(false);
    expect(r.safe_to_fire_reasons[0]).toMatch(/transport is down/);
  });
});

describe('criterion 3 — freshness from runtime stamp vs origin, never git alone', () => {
  it('manager fast-forwarded but not rebuilt (running sha != origin) → fresh false, blocks', () => {
    const r = computeDoctorReport(
      healthy({ manager: { health: 'ok', build_sha: 'old0000', origin_main_sha: 'new1111', startup_errors: [] } }),
    );
    expect(r.manager.fresh).toBe(false);
    expect(r.freshness.stale_nodes).toContain('manager');
    expect(r.safe_to_fire).toBe(false);
    expect(r.safe_to_fire_reasons.some((x) => /manager build is not fresh/.test(x))).toBe(true);
  });
});

describe('criterion 4 — boot/migration error class blocks with its reason', () => {
  it('a missing additive column startup error surfaces and blocks', () => {
    const r = computeDoctorReport(
      healthy({ manager: { health: 'ok', build_sha: SHA, origin_main_sha: SHA, startup_errors: ['no such column: provider'] } }),
    );
    expect(r.manager.startup_errors).toContain('no such column: provider');
    expect(r.safe_to_fire).toBe(false);
    expect(r.safe_to_fire_reasons.some((x) => /startup\/migration error/.test(x) && /provider/.test(x))).toBe(true);
  });
});

describe('criterion 7 — each blocking condition individually flips safe_to_fire false', () => {
  it('orchestration paused', () => {
    const r = computeDoctorReport(healthy({ orchestration: { mode: 'paused', kill_switch: false, auto_paused: false } }));
    expect(r.safe_to_fire).toBe(false);
    expect(r.safe_to_fire_reasons.some((x) => /orchestration is paused/.test(x))).toBe(true);
  });
  it('kill switch / auto-paused', () => {
    expect(computeDoctorReport(healthy({ orchestration: { mode: 'running', kill_switch: true, auto_paused: false } })).safe_to_fire).toBe(false);
    expect(computeDoctorReport(healthy({ orchestration: { mode: 'running', kill_switch: false, auto_paused: true } })).safe_to_fire).toBe(false);
  });
  it('kapelle ops auth not 200', () => {
    const r = computeDoctorReport(healthy({ kapelle_ops: { auth: '401', via: 'ip', build_sha: SHA, origin_main_sha: SHA, runtime_stamp: null } }));
    expect(r.safe_to_fire).toBe(false);
    expect(r.safe_to_fire_reasons.some((x) => /ops auth is not 200/.test(x))).toBe(true);
  });
  it('kapelle build not fresh', () => {
    const r = computeDoctorReport(healthy({ kapelle_ops: { auth: '200', via: 'magicdns', build_sha: 'x', origin_main_sha: 'y', runtime_stamp: null } }));
    expect(r.kapelle_ops.fresh).toBe(false);
    expect(r.safe_to_fire).toBe(false);
  });
});

describe('criterion 6 — dispatch classification is passed through (not a raw dump)', () => {
  it('carries the per-item class', () => {
    const r = computeDoctorReport(
      healthy({
        dispatches_needing_action: [
          { id: 'd1', title: 'expired linked query with landed work', class: 'landed-recoverable' },
        ],
      }),
    );
    expect(r.dispatches_needing_action[0].class).toBe('landed-recoverable');
  });
});

describe('criterion 8 — idempotent + side-effect-free', () => {
  it('running twice on the same frozen input yields identical reports', () => {
    const input = healthy({ transport: { tunnel: 'ok', magicdns: 'fail', tailscale_ip: 'ok' } });
    expect(computeDoctorReport(input)).toEqual(computeDoctorReport(input));
  });
});

describe('markdown rendering', () => {
  it('shows the gate and blocking reasons', () => {
    const md = formatDoctorMarkdown(computeDoctorReport(healthy({ orchestration: { mode: 'paused', kill_switch: false, auto_paused: false } })));
    expect(md).toMatch(/SAFE TO FIRE: no/);
    expect(md).toMatch(/Blocking reasons/);
    expect(md).toMatch(/orchestration is paused/);
  });
  it('happy path shows safe', () => {
    expect(formatDoctorMarkdown(computeDoctorReport(healthy()))).toMatch(/SAFE TO FIRE: yes/);
  });
});
