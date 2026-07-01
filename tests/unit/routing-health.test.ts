// SPDX-License-Identifier: MIT
/**
 * Routing-health read-model contract test (T-RELY, fleet-doctrine §"How Desk /
 * Approvals surface routing health"). Acceptance: the read-model returns
 * per-lane in-flight/queued, stall flags, mis-route flags, and provider-budget
 * vs the 60/20/20 target. Pure + now-injected; honest empty (no fixture
 * fallback) when inputs are empty.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRoutingHealth,
  resolvePoolForTrack,
  runtimeLivenessFromFallbackHealth,
  DEFAULT_ONLINE_WINDOW_MS,
  type RoutingHealthInput,
} from '../../src/routing-health/index.js';
import type { BuildPool, BuilderSlot } from '../../src/build-pools/types.js';

const NOW = '2026-06-30T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

const BACKEND: BuildPool = {
  pool_id: 'backend',
  repo_alias: 'id-agents',
  repo_root: '/repo/id-agents',
  members: ['roger', 'substrate-orch-codex', 'substrate-api-codex'],
  tracks: ['T-ORCH', 'T-CKPT', 'T-RELY'],
  max_parallel: 3,
  merge_strategy: 'auto',
};
const FRONTEND: BuildPool = {
  pool_id: 'frontend',
  repo_alias: 'kapelle-site',
  repo_root: '/repo/kapelle-site',
  members: ['regina', 'eames', 'hopper'],
  tracks: ['T-UI', 'T-SITE'],
  max_parallel: 3,
  merge_strategy: 'auto',
};

function slot(agent: string, state: BuilderSlot['state'], seenAgoMs = 0): BuilderSlot {
  return {
    agent,
    pool_id: 'backend',
    state,
    abi_healthy: true,
    current_dispatch_id: state === 'building' ? `disp-${agent}` : null,
    current_lease_id: null,
    last_assigned_at: null,
    last_seen_at: new Date(NOW_MS - seenAgoMs).toISOString(),
  };
}

function baseInput(over: Partial<RoutingHealthInput> = {}): RoutingHealthInput {
  return {
    team_id: 'team-default',
    now: NOW,
    pools: [BACKEND, FRONTEND],
    builders: [],
    dispatches: [],
    ...over,
  };
}

describe('honest empty state (no fixture fallback)', () => {
  it('empty inputs → zeroed, healthy, provider_budget null, team_id threaded', () => {
    const rm = computeRoutingHealth(baseInput({ pools: [], builders: [], dispatches: [] }));
    expect(rm.schema_version).toBe('routing-health-v1');
    expect(rm.generated_at).toBe(NOW);
    expect(rm.team_id).toBe('team-default');
    expect(rm.lanes).toEqual([]);
    expect(rm.mis_routes).toEqual([]);
    expect(rm.provider_budget).toBeNull();
    expect(rm.summary).toMatchObject({ lanes: 0, stalled_lanes: 0, mis_routes: 0, healthy: true });
  });
});

describe('per-lane load + live/free members', () => {
  it('counts in-flight/queued per lane and resolves live + free members', () => {
    const rm = computeRoutingHealth(
      baseInput({
        builders: [slot('roger', 'idle'), slot('regina', 'idle')],
        dispatches: [
          { dispatch_id: 'd1', track: 'T-ORCH.2', to_agent: 'roger', status: 'in_flight', pool_id: 'backend' },
          { dispatch_id: 'd2', track: 'T-CKPT.1', to_agent: 'roger', status: 'queued', pool_id: 'backend' },
          { dispatch_id: 'd3', track: 'T-UI.4', to_agent: 'regina', status: 'in_flight', pool_id: 'frontend' },
        ],
      }),
    );
    const backend = rm.lanes.find((l) => l.pool_id === 'backend')!;
    expect(backend.in_flight).toBe(1);
    expect(backend.queued).toBe(1);
    expect(backend.live_members).toEqual(['roger']);
    expect(backend.free_members).toEqual(['roger']);
    expect(backend.stall_flag).toBe(false); // a free member can drain the queue
    expect(rm.summary.total_in_flight).toBe(2);
    expect(rm.summary.total_queued).toBe(1);
  });
});

describe('stall flags (stale-lane alarm)', () => {
  it('flags no_live_members when queued work has zero online members', () => {
    const rm = computeRoutingHealth(
      baseInput({
        builders: [slot('substrate-orch-codex', 'offline')],
        dispatches: [{ dispatch_id: 'd', track: 'T-ORCH', to_agent: 'roger', status: 'queued', pool_id: 'backend' }],
      }),
    );
    const backend = rm.lanes.find((l) => l.pool_id === 'backend')!;
    expect(backend.stall_flag).toBe(true);
    expect(backend.stall_reason).toBe('no_live_members');
    expect(rm.summary.stalled_lanes).toBe(1);
    expect(rm.summary.healthy).toBe(false);
  });

  it('flags all_members_busy_with_backlog — the real degraded backend case', () => {
    // roger online but building; substrate-* offline; backend work queued.
    const rm = computeRoutingHealth(
      baseInput({
        builders: [
          slot('roger', 'building'),
          slot('substrate-orch-codex', 'offline'),
          slot('substrate-api-codex', 'offline'),
        ],
        dispatches: [
          { dispatch_id: 'd1', track: 'T-ORCH', to_agent: 'roger', status: 'in_flight', pool_id: 'backend' },
          { dispatch_id: 'd2', track: 'T-CKPT', to_agent: 'roger', status: 'queued', pool_id: 'backend' },
        ],
      }),
    );
    const backend = rm.lanes.find((l) => l.pool_id === 'backend')!;
    expect(backend.live_members).toEqual(['roger']);
    expect(backend.free_members).toEqual([]);
    expect(backend.stall_flag).toBe(true);
    expect(backend.stall_reason).toBe('all_members_busy_with_backlog');
  });

  it('a stale heartbeat past the window is treated offline', () => {
    const rm = computeRoutingHealth(
      baseInput({
        builders: [slot('roger', 'idle', DEFAULT_ONLINE_WINDOW_MS + 1)],
        dispatches: [{ dispatch_id: 'd', track: 'T-ORCH', to_agent: 'roger', status: 'queued', pool_id: 'backend' }],
      }),
    );
    const backend = rm.lanes.find((l) => l.pool_id === 'backend')!;
    expect(backend.live_members).toEqual([]);
    expect(backend.stall_flag).toBe(true);
    expect(backend.stall_reason).toBe('no_live_members');
  });
});

describe('mis-route flags', () => {
  it('flags a backend-track item parked on the frontend (UI) lane', () => {
    const rm = computeRoutingHealth(
      baseInput({
        dispatches: [
          { dispatch_id: 'mr1', track: 'T-ORCH.5', to_agent: 'regina', status: 'queued', pool_id: 'frontend' },
        ],
      }),
    );
    expect(rm.mis_routes).toHaveLength(1);
    expect(rm.mis_routes[0]).toMatchObject({
      dispatch_id: 'mr1',
      assigned_pool: 'frontend',
      expected_pool: 'backend',
      reason: 'track_pool_mismatch',
    });
    expect(rm.summary.healthy).toBe(false);
  });

  it('flags an agent that is not a member of its assigned pool', () => {
    const rm = computeRoutingHealth(
      baseInput({
        // T-CKPT correctly routes to backend, but the bound agent isn't a member.
        dispatches: [
          { dispatch_id: 'mr2', track: 'T-CKPT', to_agent: 'eames', status: 'queued', pool_id: 'backend' },
        ],
      }),
    );
    expect(rm.mis_routes).toHaveLength(1);
    expect(rm.mis_routes[0]).toMatchObject({ reason: 'agent_not_in_pool', to_agent: 'eames' });
  });

  it('a correctly-routed item raises no mis-route flag', () => {
    const rm = computeRoutingHealth(
      baseInput({
        dispatches: [
          { dispatch_id: 'ok', track: 'T-ORCH.1', to_agent: 'roger', status: 'in_flight', pool_id: 'backend' },
        ],
      }),
    );
    expect(rm.mis_routes).toEqual([]);
  });
});

describe('runtime liveness folded into summary.healthy (C3 — no false-green)', () => {
  it('all runtimes live → healthy true, severity ok, counts populated', () => {
    const rm = computeRoutingHealth(
      baseInput({
        pools: [], // isolate the runtime axis from lane stalls
        runtimes: [
          { name: 'claude', role: 'primary', live: true },
          { name: 'codex', role: 'fallback', live: true },
          { name: 'cursor', role: 'fallback', live: true },
        ],
      }),
    );
    expect(rm.summary.healthy).toBe(true);
    expect(rm.summary.severity).toBe('ok');
    expect(rm.summary.runtimes).toBe(3);
    expect(rm.summary.runtimes_live).toBe(3);
    expect(rm.summary.runtimes_down).toEqual([]);
  });

  it('a dead FALLBACK (revoked Codex) → NOT healthy, severity degraded (yellow, not green)', () => {
    const rm = computeRoutingHealth(
      baseInput({
        pools: [],
        runtimes: [
          { name: 'claude', role: 'primary', live: true },
          { name: 'codex', role: 'fallback', live: false, detail: 'runtime_unavailable:cert_revoked' },
        ],
      }),
    );
    expect(rm.summary.healthy).toBe(false); // the anti-false-green guarantee
    expect(rm.summary.severity).toBe('degraded');
    expect(rm.summary.runtimes_down).toEqual(['codex']);
  });

  it('a dead PRIMARY → severity unhealthy (red)', () => {
    const rm = computeRoutingHealth(
      baseInput({
        pools: [],
        runtimes: [{ name: 'claude', role: 'primary', live: false }],
      }),
    );
    expect(rm.summary.healthy).toBe(false);
    expect(rm.summary.severity).toBe('unhealthy');
  });

  it('a stall/mis-route stays unhealthy (red) even when all runtimes live', () => {
    const rm = computeRoutingHealth(
      baseInput({
        builders: [slot('substrate-orch-codex', 'offline')],
        dispatches: [{ dispatch_id: 'd', track: 'T-ORCH', to_agent: 'roger', status: 'queued', pool_id: 'backend' }],
        runtimes: [{ name: 'claude', role: 'primary', live: true }],
      }),
    );
    expect(rm.summary.stalled_lanes).toBe(1);
    expect(rm.summary.healthy).toBe(false);
    expect(rm.summary.severity).toBe('unhealthy');
  });

  it('no runtimes supplied → backward compatible (healthy unchanged, severity ok when lanes clean)', () => {
    const rm = computeRoutingHealth(baseInput({ pools: [] }));
    expect(rm.summary.healthy).toBe(true);
    expect(rm.summary.severity).toBe('ok');
    expect(rm.summary.runtimes).toBe(0);
    expect(rm.summary.runtimes_down).toEqual([]);
  });
});

describe('runtimeLivenessFromFallbackHealth', () => {
  it('maps unavailable → not live, with the reason surfaced', () => {
    const r = runtimeLivenessFromFallbackHealth('codex', { status: 'unavailable', reason: 'cert_revoked' });
    expect(r).toEqual({ name: 'codex', role: 'fallback', live: false, detail: 'runtime_unavailable:cert_revoked' });
  });

  it('maps live and degraded (present/usable) → live', () => {
    expect(runtimeLivenessFromFallbackHealth('codex', { status: 'live' }).live).toBe(true);
    expect(runtimeLivenessFromFallbackHealth('cursor', { status: 'degraded' }).live).toBe(true);
  });
});

describe('resolvePoolForTrack', () => {
  it('resolves by longest matching track prefix; null when unclaimed', () => {
    expect(resolvePoolForTrack([BACKEND, FRONTEND], 'T-ORCH.2.1')?.pool_id).toBe('backend');
    expect(resolvePoolForTrack([BACKEND, FRONTEND], 'T-UI')?.pool_id).toBe('frontend');
    expect(resolvePoolForTrack([BACKEND, FRONTEND], 'T-UNKNOWN')).toBeNull();
    expect(resolvePoolForTrack([BACKEND, FRONTEND], null)).toBeNull();
  });
});

describe('provider budget vs 60/20/20', () => {
  it('computes per-provider deviations and the over-budget / tolerance verdict', () => {
    const rm = computeRoutingHealth(
      baseInput({
        provider_budget: {
          target: { anthropic: 0.6, openai: 0.2, cursor: 0.2 },
          actual: { anthropic: 0.85, openai: 0.1, cursor: 0.05 },
          tolerance: 0.1,
        },
      }),
    );
    const pb = rm.provider_budget!;
    expect(pb.within_tolerance).toBe(false);
    const anthropic = pb.deviations.find((d) => d.provider === 'anthropic')!;
    expect(anthropic.delta).toBeCloseTo(0.25, 6);
    expect(anthropic.over_budget).toBe(true);
    const cursor = pb.deviations.find((d) => d.provider === 'cursor')!;
    expect(cursor.over_budget).toBe(false); // under target, not over
  });

  it('within tolerance → within_tolerance true', () => {
    const rm = computeRoutingHealth(
      baseInput({
        provider_budget: {
          target: { anthropic: 0.6, openai: 0.2, cursor: 0.2 },
          actual: { anthropic: 0.62, openai: 0.18, cursor: 0.2 },
        },
      }),
    );
    expect(rm.provider_budget!.within_tolerance).toBe(true);
  });
});
