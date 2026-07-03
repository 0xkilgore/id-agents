// SPDX-License-Identifier: MIT
//
// T-REMOTE P1d — remote console route status. The console must show BOTH the
// MagicDNS route and the Tailscale-IP (100.x) fallback, and render a MagicDNS
// failure with a working fallback as "degraded — operating via fallback", NOT
// "ops down". Pure over the transport probe; reuses computeTransportVerdict so the
// console and the doctor agree on the verdict.

import { computeTransportVerdict } from './report.js';
import type { TransportProbe, TransportVerdict } from './types.js';

export interface ConsoleRouteStatus {
  /** Overall transport verdict (ok | degraded | down). */
  verdict: TransportVerdict;
  /** True unless the verdict is `down` — the console can still reach the engine room. */
  operable: boolean;
  /** Per-route status for the console to render both rows. */
  routes: {
    /** Primary route: MagicDNS name resolution. */
    magicdns: { status: 'ok' | 'degraded' | 'fail'; primary: true };
    /** Fallback route: the direct Tailscale 100.x IP. */
    tailscale_ip: { status: 'ok' | 'fail'; primary: false };
  };
  /** One-line console banner — degraded-not-down when the fallback carries it. */
  label: string;
}

/** Compute the console's two-route status + banner from a transport probe. */
export function computeConsoleRouteStatus(t: TransportProbe): ConsoleRouteStatus {
  const verdict = computeTransportVerdict(t);
  const operable = verdict !== 'down';

  let label: string;
  if (t.tunnel === 'down') {
    label = 'Ops route down: tunnel unreachable.';
  } else if (verdict === 'ok') {
    label = 'Ops route OK (MagicDNS).';
  } else if (verdict === 'down') {
    label = 'Ops route down: MagicDNS and fallback IP (100.x) both unreachable.';
  } else if (t.tailscale_ip === 'ok') {
    // MagicDNS failing/degraded but the direct IP works — the P1d case.
    label = 'MagicDNS degraded; fallback route (100.x) OK — operating via fallback.';
  } else {
    // MagicDNS OK but the direct-IP fallback is unreachable (still operable).
    label = 'MagicDNS OK; direct-IP fallback (100.x) unreachable.';
  }

  return {
    verdict,
    operable,
    routes: {
      magicdns: { status: t.magicdns, primary: true },
      tailscale_ip: { status: t.tailscale_ip, primary: false },
    },
    label,
  };
}
