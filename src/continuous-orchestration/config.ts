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
  /** Batch load-points (local HH:mm) where new backlog admission opens wide. */
  cadence_load_points: string[];
  /** IANA tz the load-points + ceiling-day are evaluated in. */
  timezone: string;
  /** Emergency kill-switch file. If it exists, the loop halts before any tick. */
  kill_switch_path: string;
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
    cadence_load_points: ["07:15", "12:30", "15:30"],
    timezone: "America/Chicago",
    kill_switch_path: DEFAULT_KILL_SWITCH_PATH,
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
    cadence_load_points: loadPoints
      ? loadPoints.split(",").map((s) => s.trim()).filter(Boolean)
      : d.cadence_load_points,
    timezone: env.CONTINUOUS_ORCHESTRATION_TZ || d.timezone,
    kill_switch_path: env.CONTINUOUS_ORCHESTRATION_KILL_SWITCH || d.kill_switch_path,
  };
}
