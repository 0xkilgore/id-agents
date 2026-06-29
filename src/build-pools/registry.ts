// Build-pools — seed registry + lookup (CTO spec §3.1).
//
// Two pools: backend (id-agents) and frontend (kapelle-site). members[0] is the
// primary owner; `coders` is the elastic generic-coder tail. max_parallel is
// intentionally below member count for usage headroom and is env-tunable via
// BUILD_POOL_<ID>_MAX_PARALLEL.
//
// Snag #12 (2026-06-26): the old local Claude builder names (brunel/eames/
// hopper/gaudi/regina/rams) can be stopped while Codex/Cursor builders are
// live. Seeding pools with stopped legacy names lets continuous orchestration
// create queued rows that the scheduler correctly refuses to deliver, clogging
// pool capacity. Seed only the currently maintained live lanes here; re-add
// legacy names only when they have a heartbeat-backed availability source.
//
// Snag #13 (2026-06-29): the frontend pool was only 2 lanes (frontend-ui-codex +
// parked frontend-qa-cursor), both throttle-prone; with both in_flight the
// daemon stalled (zero_ticks rising) on "no free builder in pool: frontend"
// while 4-5 idle Claude builders (regina/brunel/eames/gaudi/hopper) sat in NO
// pool. Widened the frontend pool with those Claude builders (verified live +
// LISTENING on their ports at seed time; availableBuilders treats a non-building
// member as available, so port-live Claude lanes fan work out immediately).
// Claude builders are listed FIRST so they are selected ahead of the
// throttle-prone codex/cursor lanes.

import type { BuildPool, PoolId, RepoAlias } from "./types.js";

const SEED: readonly BuildPool[] = [
  {
    pool_id: "backend",
    repo_alias: "id-agents",
    repo_root: "/Users/kilgore/Dropbox/Code/cane/id-agents",
    members: ["roger", "substrate-orch-codex", "substrate-api-codex"],
    tracks: ["T-ORCH", "T-CKPT", "T-DEPLOY", "T-MODEL"],
    max_parallel: 4,
    merge_strategy: "auto",
  },
  {
    pool_id: "frontend",
    repo_alias: "kapelle-site",
    repo_root: "/Users/kilgore/Dropbox/Code/kapelle-site",
    members: ["regina", "brunel", "eames", "gaudi", "hopper", "frontend-ui-codex", "frontend-qa-cursor"],
    tracks: ["T-UI", "T-SITE", "T-WEB"],
    max_parallel: 6,
    merge_strategy: "auto",
  },
] as const;

function applyEnvOverrides(pool: BuildPool, env: NodeJS.ProcessEnv): BuildPool {
  const raw = env[`BUILD_POOL_${pool.pool_id.toUpperCase()}_MAX_PARALLEL`];
  if (raw === undefined) return pool;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return pool; // ignore garbage; keep seed
  return { ...pool, max_parallel: n };
}

export class BuildPoolRegistry {
  private readonly pools: BuildPool[];

  private constructor(pools: BuildPool[]) {
    this.pools = pools;
  }

  /** Load the seed registry with env overrides applied. */
  static load(env: NodeJS.ProcessEnv = process.env): BuildPoolRegistry {
    return new BuildPoolRegistry(SEED.map((p) => applyEnvOverrides({ ...p }, env)));
  }

  list(): BuildPool[] {
    return this.pools.map((p) => ({ ...p }));
  }

  byId(poolId: PoolId): BuildPool | undefined {
    const p = this.pools.find((x) => x.pool_id === poolId);
    return p ? { ...p } : undefined;
  }

  byRepoAlias(alias: RepoAlias): BuildPool | undefined {
    const p = this.pools.find((x) => x.repo_alias === alias);
    return p ? { ...p } : undefined;
  }

  /**
   * Resolve a backlog track to its pool by prefix match (e.g. "T-CKPT.7" →
   * the pool whose `tracks` contains the "T-CKPT" prefix). Longest matching
   * prefix wins so more-specific track families can override. Returns undefined
   * when no pool claims the track (caller falls back to the default lane).
   */
  resolvePool(track: string): BuildPool | undefined {
    let best: { pool: BuildPool; len: number } | undefined;
    for (const pool of this.pools) {
      for (const prefix of pool.tracks) {
        if ((track === prefix || track.startsWith(prefix)) && (!best || prefix.length > best.len)) {
          best = { pool, len: prefix.length };
        }
      }
    }
    return best ? { ...best.pool } : undefined;
  }
}
