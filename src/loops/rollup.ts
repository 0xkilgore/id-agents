// LoopRun rollups (last / next / health) — the runs-derived read-model the
// registry's `placeholderHealth` promises ("the runtime read-model will replace
// this with a runs-derived rollup", registry.ts §291). Given a loop's recorded
// LoopRunRecord[] (storage.listLoopRuns) this derives the real LoopHealth the
// `/loops` read-model serves, WITHOUT changing the LoopHealth DTO contract — so
// the manager routes can swap placeholderHealth → rollupLoopHealth in place.
//
// Pure + `now`-injected so it is deterministic and unit-testable, matching the
// rest of the loops read-model layer.

import type {
  DashboardLoopsSummary,
  LoopHealth,
  LoopHealthState,
  LoopListFilters,
  LoopRunStatus as CoarseRunStatus,
  LoopSummary,
  LoopsListResponse,
} from "./registry.js";
import { SEED_LOOPS, listLoopsFrom, loopsSummaryFrom } from "./registry.js";
import type { LoopRunRecord, LoopRunStatus as SubstrateRunStatus } from "./types.js";
import type { DbAdapter } from "../db/db-adapter.js";
import { listLoopRuns } from "./storage.js";

const MS_PER_MINUTE = 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * MS_PER_MINUTE;

/** Statuses that represent a finished run (the health signal lives in these). */
const TERMINAL_STATUSES: ReadonlySet<SubstrateRunStatus> = new Set<SubstrateRunStatus>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

/** Collapse the substrate's fine-grained run status onto the coarse status the
 *  LoopHealth DTO carries (registry.LoopRunStatus). `partial` has no coarse peer
 *  — it maps to `succeeded` (output WAS produced); the `degraded` health state
 *  below carries the "not clean" caveat. */
function toCoarseStatus(s: SubstrateRunStatus): CoarseRunStatus {
  switch (s) {
    case "queued":
    case "admitted":
      return "queued";
    case "collecting":
    case "reasoning":
    case "postprocessing":
      return "running";
    case "succeeded":
    case "partial":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export interface LoopRollupInput {
  /** Loop enabled flag — a disabled loop is always `disabled`, regardless of runs. */
  enabled: boolean;
  /** Minutes after a success before health degrades to stale; null = never stale. */
  stale_after_minutes: number | null;
  /** Precomputed next fire (e.g. from the recurrence materializer). When
   *  omitted, `next_run_at` is derived from the earliest pending scheduled run,
   *  else null. Pass an explicit `null` to force "no next run". */
  next_run_at?: string | null;
  /** Consecutive terminal failures that flip `degraded` → `failed`. Default 2. */
  fail_threshold?: number;
}

function isStale(lastSuccessAt: string | null, staleAfterMinutes: number | null, nowMs: number): boolean {
  if (staleAfterMinutes == null || lastSuccessAt == null) return false;
  const t = Date.parse(lastSuccessAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > staleAfterMinutes * MS_PER_MINUTE;
}

/** Earliest future `scheduled_for` among pending (non-terminal) scheduled runs.
 *  ISO-8601 UTC strings compare lexicographically, so no Date parse needed. */
function deriveNextRun(runsNewestFirst: readonly LoopRunRecord[], nowIso: string): string | null {
  let next: string | null = null;
  for (const r of runsNewestFirst) {
    if (r.trigger.kind !== "scheduled") continue;
    if (TERMINAL_STATUSES.has(r.status)) continue;
    const sf = r.trigger.scheduled_for;
    if (!sf || sf <= nowIso) continue;
    if (next === null || sf < next) next = sf;
  }
  return next;
}

/**
 * Derive the runs-based LoopHealth rollup for one loop.
 *
 * `runs` may be in any order (selection is by `fired_at`, newest wins):
 *  - `state`               — disabled (loop off) · unknown (no terminal runs or
 *                            only cancelled) · healthy (last terminal succeeded
 *                            and not stale) · degraded (stale success, partial,
 *                            or a sub-threshold failure streak) · failed
 *                            (consecutive failures ≥ `fail_threshold`).
 *  - `last_run_at`         — `fired_at` of the newest run (any status).
 *  - `last_run_status`     — coarse status of that newest run.
 *  - `last_run_phid`       — its `loop_run_phid`.
 *  - `last_success_at`     — `finished_at` of the newest `succeeded` run.
 *  - `consecutive_failures`— leading `failed` streak among terminal runs.
 *  - `next_run_at`         — `input.next_run_at` if provided, else derived.
 *  - `runs_last_7d`        — runs fired within 7d of `now`.
 */
export function rollupLoopHealth(
  input: LoopRollupInput,
  runs: readonly LoopRunRecord[],
  nowIso: string,
): LoopHealth {
  const failThreshold = Math.max(1, input.fail_threshold ?? 2);
  const nowMs = Date.parse(nowIso);

  const ordered = [...runs].sort((a, b) =>
    a.fired_at < b.fired_at ? 1 : a.fired_at > b.fired_at ? -1 : 0,
  );

  const lastRun = ordered.length > 0 ? ordered[0]! : null;
  const terminal = ordered.filter((r) => TERMINAL_STATUSES.has(r.status));
  const lastTerminal = terminal.length > 0 ? terminal[0]! : null;
  const lastSucceeded = terminal.find((r) => r.status === "succeeded") ?? null;
  const lastSuccessAt = lastSucceeded?.finished_at ?? null;

  let consecutiveFailures = 0;
  for (const r of terminal) {
    if (r.status === "failed") consecutiveFailures += 1;
    else break;
  }

  const runsLast7d = ordered.filter((r) => {
    const t = Date.parse(r.fired_at);
    return Number.isFinite(t) && t <= nowMs && nowMs - t <= SEVEN_DAYS_MS;
  }).length;

  let state: LoopHealthState;
  if (!input.enabled) {
    state = "disabled";
  } else if (lastTerminal === null) {
    state = "unknown";
  } else if (lastTerminal.status === "failed") {
    state = consecutiveFailures >= failThreshold ? "failed" : "degraded";
  } else if (lastTerminal.status === "partial") {
    state = "degraded";
  } else if (lastTerminal.status === "cancelled") {
    state = "unknown";
  } else {
    // succeeded
    state = isStale(lastSuccessAt, input.stale_after_minutes, nowMs) ? "degraded" : "healthy";
  }

  const nextRunAt =
    input.next_run_at !== undefined ? input.next_run_at : deriveNextRun(ordered, nowIso);

  return {
    state,
    last_run_at: lastRun?.fired_at ?? null,
    last_run_status: lastRun ? toCoarseStatus(lastRun.status) : null,
    last_run_phid: lastRun?.loop_run_phid ?? null,
    last_success_at: lastSuccessAt,
    consecutive_failures: consecutiveFailures,
    next_run_at: nextRunAt,
    runs_last_7d: runsLast7d,
    stale_after_minutes: input.stale_after_minutes,
  };
}

/**
 * Substrate bridge: fetch a loop's recent runs and roll them up. Pulls the most
 * recent runs (default 200, the storage cap) so the 7-day and consecutive-failure
 * windows see enough history.
 */
export async function loadLoopHealth(
  adapter: DbAdapter,
  loopPhid: string,
  input: LoopRollupInput,
  nowIso: string,
  teamId: string | null = null,
): Promise<LoopHealth> {
  const runs = await listLoopRuns(adapter, loopPhid, { limit: 200, team_id: teamId });
  return rollupLoopHealth(input, runs, nowIso);
}

// ---------------------------------------------------------------------------
// Read-model overlay — swap each seed loop's placeholderHealth for the real
// runs-derived rollup, then reuse the registry's pure list/summary projections.
// This is what the `/loops`, `/loops/summary`, `/loops/:ref` routes serve so the
// page shows real LoopRun data, never placeholders or fixtures.
// ---------------------------------------------------------------------------

export interface LoopsReadModelOptions {
  /**
   * Team scope. Threaded end-to-end (→ loadLoopHealth → listLoopRuns) for parity
   * with the other team-scoped read-models. loop_runs has no team_id column yet,
   * so it is currently a documented no-op (see ListRunsFilter.team_id).
   */
  team_id?: string | null;
  /** Consecutive terminal failures that flip degraded → failed. Default 2. */
  fail_threshold?: number;
}

/**
 * Overlay runs-derived health onto each loop, replacing `placeholderHealth`.
 * Honest emptiness: a loop with no runs rolls up to `unknown` (or `disabled`
 * when the loop is off) — never a fixture or fabricated success. The summary's
 * top-level `next_run_at` is kept in sync with the derived health.
 */
export async function overlayLoopHealth(
  adapter: DbAdapter,
  loops: readonly LoopSummary[],
  nowIso: string,
  opts: LoopsReadModelOptions = {},
): Promise<LoopSummary[]> {
  return Promise.all(
    loops.map(async (loop): Promise<LoopSummary> => {
      const health = await loadLoopHealth(
        adapter,
        loop.loop_phid,
        {
          enabled: loop.enabled,
          stale_after_minutes: loop.health.stale_after_minutes,
          fail_threshold: opts.fail_threshold,
        },
        nowIso,
        opts.team_id ?? null,
      );
      return { ...loop, health, next_run_at: health.next_run_at };
    }),
  );
}

/** `/loops` read-model with real (runs-derived) health. Definitions come from
 *  the seed catalog and health from the loop_runs substrate, so `source` is
 *  `"mixed"`. Status/other filters run against the real health state. */
export async function buildLoopsList(
  adapter: DbAdapter,
  nowIso: string,
  filters: LoopListFilters = {},
  opts: LoopsReadModelOptions = {},
): Promise<LoopsListResponse> {
  const overlaid = await overlayLoopHealth(adapter, SEED_LOOPS, nowIso, opts);
  return listLoopsFrom(overlaid, nowIso, filters, "mixed");
}

/** `/loops/summary` dashboard rollup with real (runs-derived) health. */
export async function buildLoopsSummary(
  adapter: DbAdapter,
  nowIso: string,
  opts: LoopsReadModelOptions = {},
): Promise<DashboardLoopsSummary> {
  const overlaid = await overlayLoopHealth(adapter, SEED_LOOPS, nowIso, opts);
  return loopsSummaryFrom(overlaid, nowIso, "mixed");
}

/** Real-health overlay for a single loop summary (the `/loops/:ref` detail). */
export async function buildLoopSummaryWithHealth(
  adapter: DbAdapter,
  loop: LoopSummary,
  nowIso: string,
  opts: LoopsReadModelOptions = {},
): Promise<LoopSummary> {
  const [overlaid] = await overlayLoopHealth(adapter, [loop], nowIso, opts);
  return overlaid!;
}
