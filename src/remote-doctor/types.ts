// SPDX-License-Identifier: MIT
//
// kapelle-remote-doctor v1 — output contract (cto/output/2026-06-29-laptop-remote-
// operations-product-architecture.md §2.1). The JSON is the stable, versioned
// contract a CLI (`connect-m4.sh doctor --json`) or console panel consumes.
//
// The report is computed by a PURE engine (report.ts) from already-probed inputs,
// mirroring the repo's decision/IO split (boot-config, build-info freshness,
// routing-health). Diagnosis is side-effect-free by construction (criterion 8).

export const DOCTOR_VERSION = '1';

export type TransportVerdict = 'ok' | 'degraded' | 'down';
export type ReleaseCohort = 'coherent' | 'mixed' | 'n/a';

/** How a failed dispatch should be handled (never a raw unclassified dump). */
export type DispatchActionClass =
  | 'refire'
  | 'verify-first'
  | 'landed-recoverable'
  | 'moot'
  | 'needs-human';

export interface DispatchAction {
  id: string;
  title: string;
  class: DispatchActionClass;
}

// ── Probe inputs (what the transport/control-plane layer gathers) ──────────────

export interface TransportProbe {
  /** cloudflared/Tailscale tunnel reachability. */
  tunnel: 'ok' | 'down';
  /** MagicDNS resolution: degraded = MagicDNS fails but the IP works. */
  magicdns: 'ok' | 'degraded' | 'fail';
  /** Direct Tailscale-IP reachability (the fallback route). */
  tailscale_ip: 'ok' | 'fail';
}

export interface ManagerProbe {
  health: 'ok' | 'fail';
  /** The RUNNING build stamp (never git alone — criterion 3). */
  build_sha: string | null;
  origin_main_sha: string | null;
  /** Empty == clean boot; non-empty == migration/boot-failure class (criterion 4). */
  startup_errors: string[];
}

export interface KapelleOpsProbe {
  auth: '200' | '401' | 'fail';
  via: 'magicdns' | 'ip';
  build_sha: string | null;
  origin_main_sha: string | null;
  /** The ops runtime stamp (.next/ops-server-runtime.json), when read. */
  runtime_stamp: string | null;
}

export interface OrchestrationProbe {
  mode: 'running' | 'paused';
  kill_switch: boolean;
  auto_paused: boolean;
}

export interface AgentsProbe {
  registered: number;
  offline: string[];
}

/** Everything the doctor gathers before computing the verdict. Assembling this is
 *  the I/O layer's job; the verdict engine is pure over it. */
export interface DoctorProbeInput {
  generated_at: string;
  transport: TransportProbe;
  manager: ManagerProbe;
  reactor: { health: 'ok' | 'fail' };
  kapelle_ops: KapelleOpsProbe;
  orchestration: OrchestrationProbe;
  agents: AgentsProbe;
  /** §3 cross-repo release coherence; defaults to 'n/a' (no manifest couples nodes). */
  release_cohort?: ReleaseCohort;
  /** Already-classified failed dispatches (criterion 6). Pass-through. */
  dispatches_needing_action?: DispatchAction[];
  recent_landings?: { artifact: string; at: string }[];
}

// ── Report (the §2.1 contract) ─────────────────────────────────────────────────

export interface DoctorReport {
  doctor_version: typeof DOCTOR_VERSION;
  generated_at: string;
  transport: TransportProbe & { verdict: TransportVerdict };
  manager: {
    health: 'ok' | 'fail';
    build_sha: string | null;
    origin_main_sha: string | null;
    fresh: boolean;
    startup_errors: string[];
  };
  reactor: { health: 'ok' | 'fail' };
  kapelle_ops: KapelleOpsProbe & { fresh: boolean };
  orchestration: OrchestrationProbe;
  agents: AgentsProbe;
  freshness: {
    all_nodes_fresh: boolean;
    stale_nodes: string[];
    release_cohort: ReleaseCohort;
  };
  dispatches_needing_action: DispatchAction[];
  recent_landings: { artifact: string; at: string }[];
  safe_to_fire: boolean;
  safe_to_fire_reasons: string[];
  next_action: string;
}
