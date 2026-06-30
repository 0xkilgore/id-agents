// Build-pools — free-builder selection (CTO spec §4.4).
//
// Pure selection: given a pool and the current BuilderSlot states, return the
// next builder to fire to, or null when none are available. A member is
// AVAILABLE iff state==="idle" && abi_healthy && online (heartbeat within the
// window). Preference = pool.members order (primary owner first) so roger/regina
// absorb load until busy, then the daemon spills to brunel/hopper/eames/gaudi/
// coders; ties break least-recently-used.

import type { BuildPool, BuilderSlot } from "./types.js";

/** Default heartbeat freshness window; env-tunable. */
export const DEFAULT_ONLINE_WINDOW_MS = 10 * 60 * 1000;
export const CODEX_ONLY_LOAD_LOOP_ALLOWED_AGENTS = [
  "frontend-ui-codex",
  "substrate-api-codex",
  "substrate-orch-codex",
] as const;

export interface SelectOptions {
  now?: Date;
  onlineWindowMs?: number;
  /**
   * Optional runtime exclusion guard. When omitted, selection is unchanged.
   * Supplying this lets a scheduler load-loop explicitly constrain dispatches
   * during Codex-only usage-exhaustion windows without mutating pool seeds.
   */
  allowedAgents?: readonly string[];
}

function onlineWindow(opts?: SelectOptions): number {
  if (opts?.onlineWindowMs && opts.onlineWindowMs > 0) return opts.onlineWindowMs;
  const raw = process.env.BUILD_POOL_ONLINE_WINDOW_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ONLINE_WINDOW_MS;
}

/** True when the slot heartbeated within the online window. */
export function isOnline(slot: BuilderSlot, opts?: SelectOptions): boolean {
  if (!slot.last_seen_at) return false;
  const seen = Date.parse(slot.last_seen_at);
  if (Number.isNaN(seen)) return false;
  const now = (opts?.now ?? new Date()).getTime();
  return now - seen <= onlineWindow(opts);
}

/** A member is available to take new work. */
export function isAvailable(slot: BuilderSlot, opts?: SelectOptions): boolean {
  return slot.state === "idle" && slot.abi_healthy && isOnline(slot, opts);
}

/**
 * Pick the next builder for a pool, or null if none available.
 * Preference: pool.members order; tie-break least-recently-assigned.
 */
export function selectBuilder(
  pool: BuildPool,
  slots: BuilderSlot[],
  opts?: SelectOptions,
): string | null {
  const allowedAgents = opts?.allowedAgents ? new Set(opts.allowedAgents) : null;
  const avail = pool.members
    .filter((m) => !allowedAgents || allowedAgents.has(m))
    .map((m) => slots.find((s) => s.agent === m && s.pool_id === pool.pool_id))
    .filter((s): s is BuilderSlot => !!s && isAvailable(s, opts));
  if (avail.length === 0) return null;
  avail.sort(
    (a, b) =>
      pool.members.indexOf(a.agent) - pool.members.indexOf(b.agent) ||
      (a.last_assigned_at ?? "").localeCompare(b.last_assigned_at ?? ""),
  );
  return avail[0].agent;
}
