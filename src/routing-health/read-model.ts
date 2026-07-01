// SPDX-License-Identifier: MIT
//
// Routing-health read-model compute (T-RELY). Pure + now-injected; the route
// adapter supplies already-fetched inputs. See ./types.ts for the contract and
// the fleet-doctrine §"How Desk / Approvals surface routing health".

import type { BuildPool, BuilderSlot } from '../build-pools/types.js';
import type {
  MisRouteFlag,
  ProviderBudgetHealth,
  ProviderBudgetInput,
  RoutingDispatch,
  RoutingHealthInput,
  RoutingHealthReadModel,
  RoutingHealthSeverity,
  RoutingLaneHealth,
  RuntimeLiveness,
} from './types.js';

/** A fallback-health probe result shape (cursor/codex fallback health share this
 *  status vocabulary). Kept structural so the read-model doesn't import the
 *  harness. */
interface FallbackHealthLike {
  status: 'live' | 'degraded' | 'unavailable';
  reason?: string | null;
  detail?: string;
}

/** Map a fallback-health probe to a RuntimeLiveness row. A runtime is "live" when
 *  present/usable (`live` or `degraded`); only `unavailable` counts as down. */
export function runtimeLivenessFromFallbackHealth(
  name: string,
  health: FallbackHealthLike,
): RuntimeLiveness {
  const live = health.status !== 'unavailable';
  const reason = health.reason ? `runtime_unavailable:${health.reason}` : health.detail;
  return { name, role: 'fallback', live, detail: reason };
}

/** Default heartbeat freshness window: a slot last seen longer ago is treated
 *  offline. Overridable per call via input.online_window_ms. */
export const DEFAULT_ONLINE_WINDOW_MS = 5 * 60_000; // 5 min
const DEFAULT_BUDGET_TOLERANCE = 0.1;

function onlineWindow(input: RoutingHealthInput): number {
  return input.online_window_ms ?? DEFAULT_ONLINE_WINDOW_MS;
}

/** A slot is online when it is not offline and its heartbeat is within window. */
function isOnline(slot: BuilderSlot, nowMs: number, windowMs: number): boolean {
  if (slot.state === 'offline') return false;
  if (!slot.last_seen_at) return false;
  const seen = Date.parse(slot.last_seen_at);
  if (Number.isNaN(seen)) return false;
  return nowMs - seen <= windowMs;
}

/** The pool whose track prefixes claim `track` (longest matching prefix wins),
 *  or null when no pool owns it. */
export function resolvePoolForTrack(pools: BuildPool[], track: string | null): BuildPool | null {
  if (!track) return null;
  let best: BuildPool | null = null;
  let bestLen = -1;
  for (const pool of pools) {
    for (const prefix of pool.tracks) {
      if ((track === prefix || track.startsWith(prefix)) && prefix.length > bestLen) {
        best = pool;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function computeLane(
  pool: BuildPool,
  slotByAgent: Map<string, BuilderSlot>,
  dispatches: RoutingDispatch[],
  nowMs: number,
  windowMs: number,
): RoutingLaneHealth {
  const liveMembers: string[] = [];
  const freeMembers: string[] = [];
  for (const m of pool.members) {
    const slot = slotByAgent.get(m);
    if (slot && isOnline(slot, nowMs, windowMs)) {
      liveMembers.push(m);
      if (slot.state === 'idle') freeMembers.push(m);
    }
  }

  const onPool = dispatches.filter((d) => d.pool_id === pool.pool_id);
  const inFlight = onPool.filter((d) => d.status === 'in_flight').length;
  const queued = onPool.filter((d) => d.status === 'queued').length;

  let stall = false;
  let stallReason: RoutingLaneHealth['stall_reason'] = null;
  if (queued > 0 && freeMembers.length === 0) {
    stall = true;
    stallReason = liveMembers.length === 0 ? 'no_live_members' : 'all_members_busy_with_backlog';
  }

  return {
    pool_id: pool.pool_id,
    repo_alias: pool.repo_alias,
    members: [...pool.members],
    live_members: liveMembers,
    free_members: freeMembers,
    in_flight: inFlight,
    queued,
    max_parallel: pool.max_parallel,
    tracks: [...pool.tracks],
    stall_flag: stall,
    stall_reason: stallReason,
  };
}

function computeMisRoutes(pools: BuildPool[], dispatches: RoutingDispatch[]): MisRouteFlag[] {
  const poolById = new Map(pools.map((p) => [p.pool_id as string, p]));
  const flags: MisRouteFlag[] = [];
  for (const d of dispatches) {
    const expected = resolvePoolForTrack(pools, d.track);
    const assigned = d.pool_id ? poolById.get(d.pool_id) ?? null : null;

    // track→pool mismatch: the track is owned by a different pool than assigned.
    if (expected && d.pool_id && expected.pool_id !== d.pool_id) {
      flags.push({
        dispatch_id: d.dispatch_id,
        to_agent: d.to_agent,
        track: d.track,
        assigned_pool: d.pool_id,
        expected_pool: expected.pool_id,
        reason: 'track_pool_mismatch',
      });
      continue; // one flag per dispatch — the mismatch is the primary signal
    }

    // bound agent isn't a member of the pool it's assigned to.
    if (assigned && !assigned.members.includes(d.to_agent)) {
      flags.push({
        dispatch_id: d.dispatch_id,
        to_agent: d.to_agent,
        track: d.track,
        assigned_pool: d.pool_id,
        expected_pool: expected?.pool_id ?? null,
        reason: 'agent_not_in_pool',
      });
    }
  }
  return flags;
}

function computeProviderBudget(input: ProviderBudgetInput | null | undefined): ProviderBudgetHealth | null {
  if (!input) return null;
  const tolerance = input.tolerance ?? DEFAULT_BUDGET_TOLERANCE;
  const providers = new Set<string>([...Object.keys(input.target), ...Object.keys(input.actual)]);
  const deviations = [...providers].sort().map((provider) => {
    const target = input.target[provider] ?? 0;
    const actual = input.actual[provider] ?? 0;
    const delta = Number((actual - target).toFixed(6));
    return { provider, target, actual, delta, over_budget: delta > tolerance };
  });
  return {
    target: { ...input.target },
    actual: { ...input.actual },
    tolerance,
    deviations,
    within_tolerance: deviations.every((d) => Math.abs(d.delta) <= tolerance),
  };
}

/**
 * Compute the routing-health read-model from already-fetched inputs. Pure: no
 * I/O, no clock read (uses input.now). Honest empty when inputs are empty.
 */
export function computeRoutingHealth(input: RoutingHealthInput): RoutingHealthReadModel {
  const nowMs = Date.parse(input.now);
  const windowMs = onlineWindow(input);
  const slotByAgent = new Map(input.builders.map((b) => [b.agent, b]));

  const lanes = input.pools.map((pool) =>
    computeLane(pool, slotByAgent, input.dispatches, nowMs, windowMs),
  );
  const misRoutes = computeMisRoutes(input.pools, input.dispatches);
  const providerBudget = computeProviderBudget(input.provider_budget);

  const stalledLanes = lanes.filter((l) => l.stall_flag).length;
  const totalInFlight = lanes.reduce((n, l) => n + l.in_flight, 0);
  const totalQueued = lanes.reduce((n, l) => n + l.queued, 0);

  // Fold runtime liveness into the fleet verdict (C3) so a dead runtime — e.g. a
  // cert-revoked Codex fallback — can never read as green. A dead PRIMARY (or any
  // stall/mis-route) is red; only a fallback being down is yellow/degraded.
  const runtimes = input.runtimes ?? [];
  const downRuntimes = runtimes.filter((r) => !r.live);
  const primaryDown = downRuntimes.some((r) => r.role === 'primary');
  const allRuntimesLive = downRuntimes.length === 0;

  const laneHealthy = stalledLanes === 0 && misRoutes.length === 0;
  const healthy = laneHealthy && allRuntimesLive;
  const severity: RoutingHealthSeverity =
    !laneHealthy || primaryDown ? 'unhealthy' : !allRuntimesLive ? 'degraded' : 'ok';

  return {
    schema_version: 'routing-health-v1',
    generated_at: input.now,
    team_id: input.team_id,
    lanes,
    mis_routes: misRoutes,
    provider_budget: providerBudget,
    summary: {
      lanes: lanes.length,
      stalled_lanes: stalledLanes,
      mis_routes: misRoutes.length,
      total_in_flight: totalInFlight,
      total_queued: totalQueued,
      runtimes: runtimes.length,
      runtimes_live: runtimes.length - downRuntimes.length,
      runtimes_down: downRuntimes.map((r) => r.name),
      healthy,
      severity,
    },
  };
}
