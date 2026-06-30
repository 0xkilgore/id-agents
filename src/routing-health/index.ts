// SPDX-License-Identifier: MIT
//
// Routing-health read-model (T-RELY) — per-lane load/stall, mis-route flags,
// and provider-budget vs 60/20/20. See ./types.ts + ./read-model.ts and
// agent-platform/output/2026-06-29-kapelle-fleet-doctrine.md.

export {
  computeRoutingHealth,
  resolvePoolForTrack,
  DEFAULT_ONLINE_WINDOW_MS,
} from './read-model.js';

export type {
  RoutingDispatch,
  ProviderBudgetInput,
  RoutingHealthInput,
  LaneStallReason,
  RoutingLaneHealth,
  MisRouteReason,
  MisRouteFlag,
  ProviderBudgetDeviation,
  ProviderBudgetHealth,
  RoutingHealthSummary,
  RoutingHealthReadModel,
} from './types.js';
