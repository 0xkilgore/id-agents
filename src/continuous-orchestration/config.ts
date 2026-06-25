// Continuous Orchestration — configuration.
//
// CONSERVATIVE defaults, all overridable via env. The daemon ships DISABLED and
// in DRY-RUN: it logs what it WOULD fire and fires nothing until deliberately
// enabled after a clean dry-run. Caps are easy to raise once the daily
// token-usage report shows real burn.

export interface ContinuousOrchestrationConfig {
  /** Master switch. False = daemon never ticks. Default false. */
  enabled: boolean;
  /** Dry-run: compute + log decisions but fire NO dispatches. Default true. */
  dry_run: boolean;
  /** Hard daily weighted-token ceiling. At/above this the loop auto-pauses. */
  daily_token_ceiling: number;
  /** Warn (Telegram heads-up) at this fraction of the ceiling. Default 0.75. */
  warn_fraction: number;
  /** Max concurrent in-flight dispatches the loop will allow. Default 2. */
  max_in_flight: number;
  /** Max NEW dispatches admitted per tick. Default 1. */
  max_new_per_tick: number;
  /** Consecutive zero-dispatch ticks (while work is admissible) before a loud
   *  stall alert. The overnight-drain failure mode. Default 3. */
  stall_threshold_ticks: number;
  /** Tick cadence in ms (the lane-fill heartbeat between batch load-points). */
  tick_interval_ms: number;
  /** Reaper safety net: an item stuck `in_flight` longer than this whose
   *  dispatch is NON-TERMINAL (stuck/zombie OR unresolvable) is auto-released so
   *  its write-scope lock cannot strangle the lane forever. Default 30min — long
   *  enough that a genuinely-live SHARED-scope (single-writer) build is never
   *  reaped mid-run. Terminal dispatches are reconciled immediately regardless. */
  stale_in_flight_ms: number;
  /** Shorter reaper window for POOL builds — items whose write_scope is a
   *  DISTINCT worktree (Stage C). Reaping one of these can never collide with
   *  another build's scope, so a dead pool worker is safe to reap fast ("within
   *  minutes"). Default 10min. */
  pool_stale_in_flight_ms: number;
  /** Batch load-points (local HH:mm) where new backlog admission opens wide. */
  cadence_load_points: string[];
  /** IANA tz the load-points + ceiling-day are evaluated in. */
  timezone: string;
  /** Emergency kill-switch file. If it exists, the loop halts before any tick. */
  kill_switch_path: string;
  // ── Daemon SELF-REFUEL (auto-flesh) ──
  /** Master switch for auto-flesh. False = daemon never fleshes. Default false. */
  auto_flesh_enabled: boolean;
  /** Refuel when total READY fuel drops below this. Default 8. */
  min_ready_fuel: number;
  /**
   * Parallel-fuel floor: refuel when READY items span FEWER than this many
   * distinct lanes (write_scopes), independent of the total. Keeps the parallel
   * pool fed across lanes, not just in aggregate. Default 1 (lane floor off —
   * total-only refuel; raise to demand lane-diverse fuel).
   */
  min_ready_lanes: number;
  /** Max skeletons fleshed per refuel pass. Default 5. */
  max_flesh_per_tick: number;
  // ── ADMISSION-V2 follow-up: floor-triggered AUTO-PROMOTE ──
  /**
   * When the daemon is autonomous (auto_flesh_enabled), also auto-promote
   * already-fleshed `needs_review` build items to READY when build-ready fuel is
   * below the floor — draining the manual-/promote backlog so the pool
   * self-maintains. Subordinate to auto_flesh_enabled. Default true (active
   * whenever autonomous refuel is on). Reuses the flesh-policy safety gate;
   * approval-gated/destructive items are never auto-promoted.
   */
  auto_promote_enabled: boolean;
  /** Build-ready fuel floor the auto-promote pass tops up to. Default 12. */
  auto_promote_floor: number;
  /** Distinct write-scopes the build-ready pool must span. Default 2. */
  auto_promote_min_lanes: number;
  /** Max auto-promotions per tick. Default 5. */
  auto_promote_max_per_tick: number;
  /** Weekly daemon-attributed ceiling (the emergency-brake companion to daily). */
  weekly_token_ceiling: number;
  /** Pause the daemon when usage attribution is degraded (live enforce only). */
  fail_closed_on_attribution: boolean;
  /** Deterministic flesher settings. */
  flesh: FleshConfig;
}

/** A target lane the flesher can assign generated work to. */
export interface FleshLane {
  agent: string;
  /** Repos/dirs this lane is the single writer for. */
  write_scopes: string[];
  /** Track prefixes that route to this lane (e.g. "T-ORCH"). Empty = default. */
  tracks: string[];
}

/** Deterministic flesher configuration (project defaults + lane map + caps). */
export interface FleshConfig {
  project: string;
  default_provider: string;
  default_runtime: string;
  default_risk_class: "routine" | "build";
  /** Default weighted-token estimate stamped on a fleshed dispatch. */
  default_token_estimate: number;
  /** Per-item max token estimate an auto-ready candidate may carry. */
  max_token_estimate: number;
  /** Lane map: the first lane whose `tracks` prefix-matches wins; else default. */
  lanes: FleshLane[];
  /** Lane used when no track prefix matches. */
  default_lane: FleshLane;
}

function envBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(raw: string | undefined, dflt: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? n : dflt;
}

function envFloat(raw: string | undefined, dflt: number): number {
  const n = raw === undefined ? NaN : parseFloat(raw);
  return Number.isFinite(n) ? n : dflt;
}

export const DEFAULT_KILL_SWITCH_PATH = `${process.env.HOME ?? ""}/.id-agents/orchestration-paused`;

/** The default Kapelle flesher lane map. Roger owns repo-code lanes. */
export function defaultFleshConfig(): FleshConfig {
  const rogerScopes = ["/Users/kilgore/Dropbox/Code/cane/id-agents", "id-agents"];
  return {
    project: "kapelle",
    default_provider: "anthropic",
    default_runtime: "claude-code-cli",
    default_risk_class: "build",
    default_token_estimate: 300_000,
    max_token_estimate: 2_000_000,
    lanes: [
      { agent: "roger", write_scopes: rogerScopes, tracks: ["T-ORCH", "T-CKPT", "T-DEPLOY", "T-MODEL"] },
    ],
    default_lane: { agent: "roger", write_scopes: rogerScopes, tracks: [] },
  };
}

/** Conservative defaults. Deliberately small so an unattended run can't drain. */
export function defaultConfig(): ContinuousOrchestrationConfig {
  return {
    enabled: false,
    dry_run: true,
    daily_token_ceiling: 5_000_000,
    warn_fraction: 0.75,
    max_in_flight: 2,
    max_new_per_tick: 1,
    stall_threshold_ticks: 3,
    tick_interval_ms: 60_000,
    stale_in_flight_ms: 1_800_000,
    pool_stale_in_flight_ms: 600_000,
    cadence_load_points: ["07:15", "12:30", "15:30"],
    timezone: "America/Chicago",
    kill_switch_path: DEFAULT_KILL_SWITCH_PATH,
    auto_flesh_enabled: false,
    min_ready_fuel: 8,
    min_ready_lanes: 1,
    max_flesh_per_tick: 5,
    auto_promote_enabled: true,
    auto_promote_floor: 12,
    auto_promote_min_lanes: 2,
    auto_promote_max_per_tick: 5,
    weekly_token_ceiling: 25_000_000,
    fail_closed_on_attribution: false,
    flesh: defaultFleshConfig(),
  };
}

/** Load config from env over the conservative defaults. */
export function loadContinuousOrchestrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContinuousOrchestrationConfig {
  const d = defaultConfig();
  const loadPoints = env.CONTINUOUS_ORCHESTRATION_LOAD_POINTS;
  return {
    enabled: envBool(env.CONTINUOUS_ORCHESTRATION_ENABLED, d.enabled),
    dry_run: envBool(env.CONTINUOUS_ORCHESTRATION_DRY_RUN, d.dry_run),
    daily_token_ceiling: envInt(env.CONTINUOUS_ORCHESTRATION_DAILY_CEILING, d.daily_token_ceiling),
    warn_fraction: envFloat(env.CONTINUOUS_ORCHESTRATION_WARN_FRACTION, d.warn_fraction),
    max_in_flight: envInt(env.CONTINUOUS_ORCHESTRATION_MAX_IN_FLIGHT, d.max_in_flight),
    max_new_per_tick: envInt(env.CONTINUOUS_ORCHESTRATION_MAX_NEW_PER_TICK, d.max_new_per_tick),
    stall_threshold_ticks: envInt(env.CONTINUOUS_ORCHESTRATION_STALL_THRESHOLD_TICKS, d.stall_threshold_ticks),
    tick_interval_ms: envInt(env.CONTINUOUS_ORCHESTRATION_TICK_INTERVAL_MS, d.tick_interval_ms),
    stale_in_flight_ms: envInt(env.CONTINUOUS_ORCHESTRATION_STALE_IN_FLIGHT_MS, d.stale_in_flight_ms),
    pool_stale_in_flight_ms: envInt(env.CONTINUOUS_ORCHESTRATION_POOL_STALE_IN_FLIGHT_MS, d.pool_stale_in_flight_ms),
    cadence_load_points: loadPoints
      ? loadPoints.split(",").map((s) => s.trim()).filter(Boolean)
      : d.cadence_load_points,
    timezone: env.CONTINUOUS_ORCHESTRATION_TZ || d.timezone,
    kill_switch_path: env.CONTINUOUS_ORCHESTRATION_KILL_SWITCH || d.kill_switch_path,
    auto_flesh_enabled: envBool(env.CONTINUOUS_ORCHESTRATION_AUTO_FLESH_ENABLED, d.auto_flesh_enabled),
    min_ready_fuel: envInt(env.CONTINUOUS_ORCHESTRATION_MIN_READY_FUEL, d.min_ready_fuel),
    min_ready_lanes: envInt(env.CONTINUOUS_ORCHESTRATION_MIN_READY_LANES, d.min_ready_lanes),
    max_flesh_per_tick: envInt(env.CONTINUOUS_ORCHESTRATION_MAX_FLESH_PER_TICK, d.max_flesh_per_tick),
    auto_promote_enabled: envBool(env.CONTINUOUS_ORCHESTRATION_AUTO_PROMOTE, d.auto_promote_enabled),
    auto_promote_floor: envInt(env.CONTINUOUS_ORCHESTRATION_AUTO_PROMOTE_FLOOR, d.auto_promote_floor),
    auto_promote_min_lanes: envInt(env.CONTINUOUS_ORCHESTRATION_AUTO_PROMOTE_MIN_LANES, d.auto_promote_min_lanes),
    auto_promote_max_per_tick: envInt(
      env.CONTINUOUS_ORCHESTRATION_AUTO_PROMOTE_MAX_PER_TICK,
      d.auto_promote_max_per_tick,
    ),
    weekly_token_ceiling: envInt(env.CONTINUOUS_ORCHESTRATION_WEEKLY_CEILING, d.weekly_token_ceiling),
    fail_closed_on_attribution: envBool(
      env.CONTINUOUS_ORCHESTRATION_FAIL_CLOSED_ON_ATTRIBUTION,
      d.fail_closed_on_attribution,
    ),
    flesh: d.flesh,
  };
}
