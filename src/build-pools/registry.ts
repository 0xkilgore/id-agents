// Build-pools — seed registry + lookup (CTO spec §3.1).
//
// Two pools: backend (id-agents) and frontend (kapelle-site). members[0] is the
// primary owner; `coders` is the elastic generic-coder tail. max_parallel is
// intentionally below member count for usage headroom and is env-tunable via
// BUILD_POOL_<ID>_MAX_PARALLEL.

import type { BuildPool, PoolId, RepoAlias } from "./types.js";

const SEED: readonly BuildPool[] = [
  {
    pool_id: "backend",
    repo_alias: "id-agents",
    repo_root: "/Users/kilgore/Dropbox/Code/cane/id-agents",
    members: ["roger", "brunel", "hopper", "coder-max", "coders"],
    tracks: ["T-ORCH", "T-CKPT", "T-DEPLOY", "T-MODEL"],
    max_parallel: 3,
    merge_strategy: "auto",
  },
  {
    pool_id: "frontend",
    repo_alias: "kapelle-site",
    repo_root: "/Users/kilgore/Dropbox/Code/kapelle-site",
    // Q2 (spec §10): T-UI/T-SITE/T-WEB seeded per spec; flag Regina to confirm.
    members: ["regina", "eames", "gaudi", "coders"],
    tracks: ["T-UI", "T-SITE", "T-WEB"],
    max_parallel: 3,
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
