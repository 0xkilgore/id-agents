// Build-pools — shared types (CTO build-pool/merge-queue spec, 2026-06-23).
//
// A BuildPool turns the single hardcoded builder per repo into a pool of
// interchangeable builders. Routing binds a dispatch to a POOL at flesh time
// and late-binds the concrete builder (to_agent) at FIRE time, so a busy
// primary (roger/regina) spills to the next available member instead of
// serializing the whole backlog onto one name.
//
// This module is a PURE library (Stage A): no runtime wiring, no behavior
// change. The admission/daemon rewrite (Stage C) consumes it.

export type PoolId = "backend" | "frontend";
export type RepoAlias = "id-agents" | "kapelle-console" | "kapelle-site";

/** A pool of interchangeable builders for one repo. */
export interface BuildPool {
  pool_id: PoolId;
  repo_alias: RepoAlias;
  /** Absolute repo root — the canonical checkout worktrees are cut from. */
  repo_root: string;
  /** Ordered preference; members[0] is the primary owner / lane captain. */
  members: string[];
  /** Track prefixes that route here (lifts FleshLane.tracks). */
  tracks: string[];
  /** Concurrent in-flight builds cap (<= members.length); env-tunable. */
  max_parallel: number;
  /** Default promote-to-main strategy for this repo. */
  merge_strategy: "auto";
}

/** Per-member runtime state (persisted in the agents table, Stage B). */
export type BuilderState = "idle" | "building" | "promoting" | "offline";

export interface BuilderSlot {
  agent: string;
  pool_id: PoolId;
  state: BuilderState;
  /** Last spawn used resolveManagerNode without an ABI mismatch. */
  abi_healthy: boolean;
  current_dispatch_id: string | null;
  /** workspaces WorkspaceLease.lease_id of the in-flight build. */
  current_lease_id: string | null;
  /** ISO; least-recently-used tie-break in selectBuilder. */
  last_assigned_at: string | null;
  /** ISO heartbeat; stale (outside the online window) => treated offline. */
  last_seen_at: string | null;
}
