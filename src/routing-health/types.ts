// SPDX-License-Identifier: MIT
//
// Routing-health read-model types (T-RELY, per
// agent-platform/output/2026-06-29-kapelle-fleet-doctrine.md §"How Desk /
// Approvals surface routing health").
//
// Backs the Desk routing-health panel: per-lane load (in-flight + queued),
// stale-lane alarm (a lane idle while fuel waits), mis-route flags (a backend
// item on a UI lane), and provider-budget vs the 60/20/20 target. Pure +
// now-injected, after loops/rollup.ts and tasks-readmodel/entry.ts — the route
// adapter fetches the inputs; this module computes the contract.
//
// De-Chris: no hardcoded paths/accounts; team_id is threaded through the input.
// No fixture fallback: absent inputs yield honest empty/null, never fabricated.

import type { BuildPool, BuilderSlot } from '../build-pools/types.js';

/** A dispatch occupying or waiting on a lane. `pool_id` is where it is actually
 *  assigned (may differ from where its track *should* route — that gap is a
 *  mis-route). */
export interface RoutingDispatch {
  dispatch_id: string;
  /** Track prefix the item carries (e.g. "T-ORCH.2"); null when untracked. */
  track: string | null;
  /** The agent the item is bound to (FleshLane to_agent). */
  to_agent: string;
  status: 'queued' | 'in_flight';
  /** The pool the item is currently assigned to, when known. */
  pool_id: string | null;
}

export interface ProviderBudgetInput {
  /** Target share per provider, e.g. { anthropic: 0.6, openai: 0.2, cursor: 0.2 }. */
  target: Record<string, number>;
  /** Observed share per provider over the window (same keys as target). */
  actual: Record<string, number>;
  /** Absolute share tolerance before a provider is flagged off-budget (default 0.1). */
  tolerance?: number;
}

export interface RoutingHealthInput {
  team_id: string;
  /** ISO now — injected for deterministic tests. */
  now: string;
  /** The lanes (build pools) routing fans work across. */
  pools: BuildPool[];
  /** Per-member runtime state (status + heartbeat); drives live/free detection. */
  builders: BuilderSlot[];
  /** In-flight + queued items to attribute to lanes and check for mis-routes. */
  dispatches: RoutingDispatch[];
  /** Heartbeat freshness window in ms; a slot older than this is treated offline. */
  online_window_ms?: number;
  /** Provider budget actuals vs the 60/20/20 target; null/absent = no data. */
  provider_budget?: ProviderBudgetInput | null;
}

export type LaneStallReason =
  | 'no_live_members' // queued work but zero members online → routing can't drain
  | 'all_members_busy_with_backlog'; // online but every member occupied while work waits

export interface RoutingLaneHealth {
  pool_id: string;
  repo_alias: string;
  members: string[];
  /** Members online now (slot present, not offline, heartbeat fresh). */
  live_members: string[];
  /** Online members currently idle (free to take work). */
  free_members: string[];
  in_flight: number;
  queued: number;
  max_parallel: number;
  tracks: string[];
  /** True when queued work cannot drain (no free live capacity). */
  stall_flag: boolean;
  stall_reason: LaneStallReason | null;
}

export type MisRouteReason =
  | 'track_pool_mismatch' // the item's track routes to a different pool than it's on
  | 'agent_not_in_pool'; // the bound agent isn't a member of its assigned pool

export interface MisRouteFlag {
  dispatch_id: string;
  to_agent: string;
  track: string | null;
  /** Pool the item is currently on. */
  assigned_pool: string | null;
  /** Pool the item's track should route to (null when no pool claims the track). */
  expected_pool: string | null;
  reason: MisRouteReason;
}

export interface ProviderBudgetDeviation {
  provider: string;
  target: number;
  actual: number;
  /** actual - target; positive = over the target share. */
  delta: number;
  over_budget: boolean;
}

export interface ProviderBudgetHealth {
  target: Record<string, number>;
  actual: Record<string, number>;
  tolerance: number;
  deviations: ProviderBudgetDeviation[];
  /** True when every provider is within tolerance of its target share. */
  within_tolerance: boolean;
}

export interface RoutingHealthSummary {
  lanes: number;
  stalled_lanes: number;
  mis_routes: number;
  total_in_flight: number;
  total_queued: number;
  /** True when no lane is stalled and no mis-route is flagged. */
  healthy: boolean;
}

export interface RoutingHealthReadModel {
  schema_version: 'routing-health-v1';
  generated_at: string;
  team_id: string;
  lanes: RoutingLaneHealth[];
  mis_routes: MisRouteFlag[];
  /** null = no provider-budget data available (honest empty, not fabricated). */
  provider_budget: ProviderBudgetHealth | null;
  summary: RoutingHealthSummary;
}
