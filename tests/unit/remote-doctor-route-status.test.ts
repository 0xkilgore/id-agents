// SPDX-License-Identifier: MIT
// T-REMOTE P1d — console route status: MagicDNS + fallback IP, degraded-not-down.

import { describe, it, expect } from 'vitest';
import { computeConsoleRouteStatus } from '../../src/remote-doctor/route-status.js';
import type { TransportProbe } from '../../src/remote-doctor/index.js';

const t = (over: Partial<TransportProbe> = {}): TransportProbe => ({
  tunnel: 'ok',
  magicdns: 'ok',
  tailscale_ip: 'ok',
  ...over,
});

describe('computeConsoleRouteStatus', () => {
  it('ACCEPTANCE: MagicDNS down + IP up → degraded-not-down, operable, fallback banner', () => {
    const r = computeConsoleRouteStatus(t({ magicdns: 'fail', tailscale_ip: 'ok' }));
    expect(r.verdict).toBe('degraded');
    expect(r.operable).toBe(true); // NOT "ops down"
    expect(r.routes.magicdns.status).toBe('fail');
    expect(r.routes.tailscale_ip.status).toBe('ok');
    expect(r.label).toMatch(/fallback route \(100\.x\) OK/i);
  });

  it('both routes healthy → ok, MagicDNS banner', () => {
    const r = computeConsoleRouteStatus(t());
    expect(r.verdict).toBe('ok');
    expect(r.operable).toBe(true);
    expect(r.label).toMatch(/OK \(MagicDNS\)/);
  });

  it('MagicDNS ok but fallback IP unreachable → degraded, still operable', () => {
    const r = computeConsoleRouteStatus(t({ magicdns: 'ok', tailscale_ip: 'fail' }));
    expect(r.verdict).toBe('degraded');
    expect(r.operable).toBe(true);
    expect(r.label).toMatch(/direct-IP fallback \(100\.x\) unreachable/i);
  });

  it('both MagicDNS and fallback IP down → down, not operable', () => {
    const r = computeConsoleRouteStatus(t({ magicdns: 'fail', tailscale_ip: 'fail' }));
    expect(r.verdict).toBe('down');
    expect(r.operable).toBe(false);
    expect(r.label).toMatch(/both unreachable/i);
  });

  it('tunnel down → down regardless of route rows', () => {
    const r = computeConsoleRouteStatus(t({ tunnel: 'down', magicdns: 'ok', tailscale_ip: 'ok' }));
    expect(r.verdict).toBe('down');
    expect(r.operable).toBe(false);
    expect(r.label).toMatch(/tunnel unreachable/i);
  });

  it('exposes both routes with primary/fallback flags for the console to render', () => {
    const r = computeConsoleRouteStatus(t({ magicdns: 'degraded' }));
    expect(r.routes.magicdns.primary).toBe(true);
    expect(r.routes.tailscale_ip.primary).toBe(false);
    expect(r.routes.magicdns.status).toBe('degraded');
  });
});
