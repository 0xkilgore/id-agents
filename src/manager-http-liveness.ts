import { existsSync, readFileSync } from "node:fs";
import { runWithTimeout } from "./lib/subprocess.js";

export type ManagerHttpLivenessState =
  | "healthy"
  | "watchdog_waiting"
  | "watchdog_restart_cooldown"
  | "launchd_running_but_unreachable"
  | "manager_down"
  | "watchdog_paused"
  | "unknown";

export interface ManagerHttpLivenessStatus {
  schema_version: "manager-http-liveness.v1";
  state: ManagerHttpLivenessState;
  service: string;
  manager_url: string;
  launchd_loaded: boolean | null;
  launchd_pid: number | null;
  listener_pid: number | null;
  watchdog_last_at: string | null;
  watchdog_last_class: string | null;
  watchdog_last_action: string | null;
  watchdog_consecutive_failures: number | null;
  state_file: string;
  reason: string;
  recommended_action: string | null;
  last_unhealthy_at: string | null;
  last_unhealthy_class: string | null;
  last_unhealthy_reason: string | null;
  recent_restart_attempts: number;
}

interface WatchdogState {
  consecutiveFailures?: unknown;
  lastAction?: unknown;
  lastClass?: unknown;
  lastReason?: unknown;
  lastAt?: unknown;
  lastUnhealthyAt?: unknown;
  lastUnhealthyClass?: unknown;
  lastUnhealthyReason?: unknown;
  restartAttempts?: unknown;
}

interface LaunchdProbe {
  loaded: boolean | null;
  pid: number | null;
}

interface LivenessInput {
  service: string;
  managerUrl: string;
  launchd: LaunchdProbe;
  listenerPid: number | null;
  watchdogState: WatchdogState | null;
  pauseFileExists: boolean;
}

export function classifyManagerHttpLiveness(input: LivenessInput): ManagerHttpLivenessStatus {
  const watchdog = input.watchdogState ?? {};
  const lastClass = asString(watchdog.lastClass);
  const lastAction = asString(watchdog.lastAction);
  const lastAt = asString(watchdog.lastAt);
  const consecutiveFailures = asNumber(watchdog.consecutiveFailures);
  const lastReason = asString(watchdog.lastReason);
  const lastUnhealthyAt = asString(watchdog.lastUnhealthyAt);
  const lastUnhealthyClass = asString(watchdog.lastUnhealthyClass);
  const lastUnhealthyReason = asString(watchdog.lastUnhealthyReason);
  const recentRestartAttempts = countRecentRestartAttempts(watchdog.restartAttempts);

  let state: ManagerHttpLivenessState = "unknown";
  let reason = "manager HTTP liveness is unavailable";
  let recommendedAction: string | null = "Inspect the external manager HTTP liveness watchdog and launchd state.";

  if (input.pauseFileExists) {
    state = "watchdog_paused";
    reason = "manager HTTP liveness watchdog is paused by kill-switch file";
    recommendedAction = "Remove /tmp/manager-http-liveness-watchdog.pause after verifying the manager is healthy.";
  } else if (lastClass === "healthy") {
    state = "healthy";
    reason = lastReason ?? "manager HTTP liveness watchdog last observed a healthy manager";
    recommendedAction = null;
  } else if (lastClass === "restart_cooldown") {
    state = "watchdog_restart_cooldown";
    reason = lastReason ?? "manager recently restarted and is inside the HTTP liveness watchdog cooldown window";
    recommendedAction = "Wait for recovery to complete or inspect watchdog artifacts if the cooldown does not clear.";
  } else if (lastClass === "manager_down" || (input.launchd.loaded === true && input.listenerPid === null)) {
    state = "manager_down";
    reason = lastReason ?? "launchd has no reachable HTTP listener for the manager";
    recommendedAction = "Kickstart the manager launchd service and verify /health responds.";
  } else if (lastAction === "wait") {
    state = "watchdog_waiting";
    reason = lastReason ?? "manager HTTP liveness watchdog is waiting for another confirmation sample";
    recommendedAction = "Check /tmp/manager-http-liveness-watchdog.log and the next watchdog sample before restarting again.";
  } else if (lastClass === "http_unresponsive_listener_alive" || (input.launchd.loaded === true && input.listenerPid !== null)) {
    state = "launchd_running_but_unreachable";
    reason = lastReason ?? "launchd reports the manager loaded, and a listener pid exists, but HTTP liveness is failing";
    recommendedAction = "Inspect the manager HTTP liveness watchdog artifacts, then kickstart the launchd service if the manager remains unreachable.";
  } else if (input.launchd.loaded === false) {
    state = "manager_down";
    reason = "launchd does not report the manager service loaded";
    recommendedAction = "Bootstrap the manager launchd service and verify the plist points at the deploy checkout.";
  }

  return {
    schema_version: "manager-http-liveness.v1",
    state,
    service: input.service,
    manager_url: input.managerUrl,
    launchd_loaded: input.launchd.loaded,
    launchd_pid: input.launchd.pid,
    listener_pid: input.listenerPid,
    watchdog_last_at: lastAt,
    watchdog_last_class: lastClass,
    watchdog_last_action: lastAction,
    watchdog_consecutive_failures: consecutiveFailures,
    state_file: defaultStateFile(),
    reason,
    recommended_action: recommendedAction,
    last_unhealthy_at: lastUnhealthyAt,
    last_unhealthy_class: lastUnhealthyClass,
    last_unhealthy_reason: lastUnhealthyReason,
    recent_restart_attempts: recentRestartAttempts,
  };
}

export function readManagerHttpLivenessStatus(): ManagerHttpLivenessStatus {
  const service = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_SERVICE || "com.kilgore.id-agents-manager";
  const managerUrl = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_URL || "http://127.0.0.1:4100";
  const pauseFile = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_PAUSE_FILE || "/tmp/manager-http-liveness-watchdog.pause";
  return classifyManagerHttpLiveness({
    service,
    managerUrl,
    launchd: probeLaunchd(service),
    listenerPid: probeListenerPid(),
    watchdogState: readWatchdogState(),
    pauseFileExists: existsSync(pauseFile),
  });
}

function defaultStateFile(): string {
  return process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_STATE_FILE || "/tmp/manager-http-liveness-watchdog.state";
}

function readWatchdogState(): WatchdogState | null {
  const file = defaultStateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WatchdogState;
  } catch {
    return null;
  }
}

function probeListenerPid(): number | null {
  const port = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_PORT || "4100";
  const out = runWithTimeout("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { timeoutMs: 1500 });
  if (!out.ok) return null;
  const parts = out.stdout.trim().split(/\s+/).filter((part) => part.length > 0);
  const first = parts[0];
  return first ? Number(first) : null;
}

function probeLaunchd(service: string): LaunchdProbe {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const out = runWithTimeout("launchctl", ["print", `gui/${uid}/${service}`], { timeoutMs: 1500 });
  if (!out.ok) return { loaded: false, pid: null };
  const pidMatch = out.stdout.match(/\bpid\s*=\s*(\d+)/);
  return {
    loaded: true,
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countRecentRestartAttempts(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => typeof entry === "string" && entry.length > 0).length;
}
