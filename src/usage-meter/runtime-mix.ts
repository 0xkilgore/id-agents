// Runtime Work-Share Slice 1 (§4) — actual runtime/provider mix readout.
//
// Exposes the ROLLING ACTUAL mix of committed dispatches by provider/runtime,
// from dispatch_scheduler_queue (provider/runtime are stamped + indexed), vs the
// configured 45/45/10 target. This is the measurement the governor (Slice 2,
// ships disabled) is validated against before it is ever enabled. Pure read-path
// — it changes nothing about enqueue or runtime selection.

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";

export const RUNTIME_MIX_SCHEMA_VERSION = "usage.runtime-mix.v1" as const;

/** The middle-ground policy target (45% Claude / 45% Codex / 10% cursor-cli),
 *  keyed by provider. Used when configs/model-policy.json has no work_share
 *  override (the governor config is Slice 2). */
export const RUNTIME_MIX_DEFAULT_TARGETS: Record<string, number> = {
  anthropic: 0.45,
  openai: 0.45,
  cursor: 0.1,
};

export const DEFAULT_RUNTIME_MIX_WINDOW = 100;

export interface ProviderMixRow {
  provider: string;
  count: number;
  share: number; // 0..1
  target: number; // 0..1 (0 when the provider isn't in the target)
  /** share - target; negative = under target (a deficit the governor would fill). */
  delta: number;
}

export interface RuntimeMixRow {
  runtime: string;
  count: number;
  share: number;
}

export interface RuntimeMixResponse {
  schema_version: typeof RUNTIME_MIX_SCHEMA_VERSION;
  window: { kind: "rolling_count"; n: number };
  total_committed: number;
  targets: Record<string, number>;
  by_provider: ProviderMixRow[];
  by_runtime: RuntimeMixRow[];
  generated_at: string;
}

/** Pure: turn the (provider, runtime) rows of the window into the mix readout.
 *  Newest-first or oldest-first doesn't matter — it's a count. */
export function summarizeRuntimeMix(
  rows: { provider: string; runtime: string }[],
  targets: Record<string, number>,
  windowN: number,
  now: Date = new Date(),
): RuntimeMixResponse {
  const total = rows.length;
  const provCounts = new Map<string, number>();
  const rtCounts = new Map<string, number>();
  for (const r of rows) {
    provCounts.set(r.provider, (provCounts.get(r.provider) ?? 0) + 1);
    rtCounts.set(r.runtime, (rtCounts.get(r.runtime) ?? 0) + 1);
  }
  // Every targeted provider appears even at count 0 (so an empty lane is visibly
  // under target, not just missing).
  for (const p of Object.keys(targets)) if (!provCounts.has(p)) provCounts.set(p, 0);

  const by_provider: ProviderMixRow[] = [...provCounts.entries()]
    .map(([provider, count]) => {
      const share = total > 0 ? count / total : 0;
      const target = targets[provider] ?? 0;
      return { provider, count, share, target, delta: share - target };
    })
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));

  const by_runtime: RuntimeMixRow[] = [...rtCounts.entries()]
    .map(([runtime, count]) => ({ runtime, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.runtime.localeCompare(b.runtime));

  return {
    schema_version: RUNTIME_MIX_SCHEMA_VERSION,
    window: { kind: "rolling_count", n: windowN },
    total_committed: total,
    targets,
    by_provider,
    by_runtime,
    generated_at: now.toISOString(),
  };
}

/** Read the rolling window of COMMITTED dispatches (status != 'queued') from
 *  dispatch_scheduler_queue, newest-first, capped at windowN. */
export async function computeRuntimeMix(
  adapter: DbAdapter,
  opts: { windowN?: number; teamId?: string; targets?: Record<string, number>; now?: Date } = {},
): Promise<RuntimeMixResponse> {
  const windowN = opts.windowN && opts.windowN > 0 ? Math.min(opts.windowN, 10000) : DEFAULT_RUNTIME_MIX_WINDOW;
  const targets = opts.targets ?? RUNTIME_MIX_DEFAULT_TARGETS;
  const params: unknown[] = [];
  let where = "status != $1";
  params.push("queued");
  if (opts.teamId) {
    where += " AND team_id = $2";
    params.push(opts.teamId);
  }
  params.push(windowN);
  const limitPlaceholder = `$${params.length}`;
  const { rows } = await adapter.query<{ provider: string; runtime: string }>(
    `SELECT provider, runtime FROM dispatch_scheduler_queue
      WHERE ${where}
      ORDER BY updated_at DESC, dispatch_phid DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return summarizeRuntimeMix(rows, targets, windowN, opts.now);
}

/** Read work_share.targets from configs/model-policy.json if present (forward-
 *  compat with the Slice-2 governor config), else null → caller uses the
 *  default. Reading the file is read-only and never throws. */
export async function readWorkShareTargets(
  configPath = join(homedir(), "Dropbox/Code/cane/id-agents/configs/model-policy.json"),
): Promise<Record<string, number> | null> {
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    const cfg = JSON.parse(raw) as { work_share?: { targets?: Record<string, number> } };
    const t = cfg.work_share?.targets;
    if (t && typeof t === "object" && Object.keys(t).length > 0) return t;
    return null;
  } catch {
    return null;
  }
}
