// SPDX-License-Identifier: MIT
//
// kapelle-remote-doctor v1 — the PURE verdict engine (spec §2.2). Turns probed
// inputs into the §2.1 report + the one boolean that authorizes work:
// `safe_to_fire`. No I/O, no clock read (generated_at is injected), no mutation —
// diagnosis is side-effect-free and idempotent by construction (criterion 8).

import {
  DOCTOR_VERSION,
  type DoctorProbeInput,
  type DoctorReport,
  type TransportProbe,
  type TransportVerdict,
} from './types.js';

/**
 * Transport verdict (criterion 2): a MagicDNS failure with a working Tailscale IP
 * is `degraded` (operate via fallback), NOT `down`. Only a dead tunnel, or BOTH
 * MagicDNS and the IP failing, is a real outage.
 */
export function computeTransportVerdict(t: TransportProbe): TransportVerdict {
  if (t.tunnel === 'down') return 'down';
  if (t.tailscale_ip === 'ok') {
    // A reachable IP means we can operate even if MagicDNS is fail/degraded.
    return t.magicdns === 'ok' ? 'ok' : 'degraded';
  }
  // IP is unreachable — MagicDNS is the only hope.
  return t.magicdns === 'ok' ? 'degraded' : 'down';
}

/** Freshness from the RUNNING build stamp vs origin (criterion 3), never git
 *  alone: fresh only when both SHAs are known and equal. */
function isFresh(buildSha: string | null, originSha: string | null): boolean {
  return buildSha != null && originSha != null && buildSha === originSha;
}

/**
 * Compute the full doctor report + `safe_to_fire`. `safe_to_fire` is true iff
 * (criterion 7): transport ok|degraded AND manager fresh AND kapelle fresh AND
 * orchestration not paused AND zero startup errors AND ops auth 200. Every miss
 * adds a specific reason; `next_action` is the single most-important fix.
 */
export function computeDoctorReport(input: DoctorProbeInput): DoctorReport {
  const transportVerdict = computeTransportVerdict(input.transport);
  const managerFresh = isFresh(input.manager.build_sha, input.manager.origin_main_sha);
  const kapelleFresh = isFresh(input.kapelle_ops.build_sha, input.kapelle_ops.origin_main_sha);

  const staleNodes: string[] = [];
  if (!managerFresh) staleNodes.push('manager');
  if (!kapelleFresh) staleNodes.push('kapelle');
  const allNodesFresh = staleNodes.length === 0;

  // safe_to_fire reasons, in priority order (the first is the next_action driver).
  const reasons: string[] = [];
  if (transportVerdict === 'down') {
    reasons.push('transport is down (tunnel unreachable and no working route)');
  }
  if (input.manager.health !== 'ok') {
    reasons.push('manager /health is failing');
  }
  if (input.manager.startup_errors.length > 0) {
    reasons.push(`manager has ${input.manager.startup_errors.length} startup/migration error(s): ${input.manager.startup_errors[0]}`);
  }
  if (!managerFresh) {
    reasons.push('manager build is not fresh (running sha != origin/main — redeploy not proven)');
  }
  if (!kapelleFresh) {
    reasons.push('kapelle ops build is not fresh (running sha != origin/main)');
  }
  if (input.orchestration.mode === 'paused' || input.orchestration.auto_paused || input.orchestration.kill_switch) {
    reasons.push('orchestration is paused (kill switch / auto-paused)');
  }
  if (input.kapelle_ops.auth !== '200') {
    reasons.push(`kapelle ops auth is not 200 (got ${input.kapelle_ops.auth})`);
  }

  const safeToFire = reasons.length === 0;

  return {
    doctor_version: DOCTOR_VERSION,
    generated_at: input.generated_at,
    transport: { ...input.transport, verdict: transportVerdict },
    manager: {
      health: input.manager.health,
      build_sha: input.manager.build_sha,
      origin_main_sha: input.manager.origin_main_sha,
      fresh: managerFresh,
      startup_errors: input.manager.startup_errors,
    },
    reactor: { health: input.reactor.health },
    kapelle_ops: { ...input.kapelle_ops, fresh: kapelleFresh },
    orchestration: input.orchestration,
    agents: input.agents,
    freshness: {
      all_nodes_fresh: allNodesFresh,
      stale_nodes: staleNodes,
      release_cohort: input.release_cohort ?? 'n/a',
    },
    dispatches_needing_action: input.dispatches_needing_action ?? [],
    recent_landings: input.recent_landings ?? [],
    safe_to_fire: safeToFire,
    safe_to_fire_reasons: reasons,
    next_action: nextAction(safeToFire, reasons),
  };
}

/** The one-sentence next step: the top blocking reason's remedy, or "operate". */
function nextAction(safeToFire: boolean, reasons: string[]): string {
  if (safeToFire) return 'Safe to fire — proceed with dispatches.';
  const top = reasons[0];
  if (top.startsWith('transport')) return 'Restore the tunnel / Tailscale route before operating.';
  if (top.startsWith('manager /health')) return 'Bring the manager back to healthy before firing work.';
  if (top.startsWith('manager has')) return 'Resolve the manager startup/migration error, then redeploy.';
  if (top.startsWith('manager build')) return 'Rebuild + restart the manager so the running build matches origin/main.';
  if (top.startsWith('kapelle ops build')) return 'Rebuild + restart kapelle ops so the running build matches origin/main.';
  if (top.startsWith('orchestration')) return 'Resume orchestration (clear the kill switch / auto-pause).';
  if (top.startsWith('kapelle ops auth')) return 'Fix the kapelle ops auth/token before operating.';
  return 'Resolve the blocking condition, then re-run the doctor.';
}

/** Exit code mirrors the gate (criterion 1): 0 iff safe_to_fire, else 1. */
export function doctorExitCode(report: DoctorReport): number {
  return report.safe_to_fire ? 0 : 1;
}
