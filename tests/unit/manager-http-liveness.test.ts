import { describe, expect, it } from "vitest";
import { classifyManagerHttpLiveness } from "../../src/manager-http-liveness.js";

function status(overrides: Partial<Parameters<typeof classifyManagerHttpLiveness>[0]> = {}) {
  return classifyManagerHttpLiveness({
    service: "com.kilgore.id-agents-manager",
    managerUrl: "http://127.0.0.1:4100",
    launchd: { loaded: true, pid: 111 },
    listenerPid: 111,
    watchdogState: {
      lastClass: "healthy",
      lastAction: "noop",
      lastReason: "/health ok in 20ms",
      lastAt: "2026-07-17T12:00:00.000Z",
      consecutiveFailures: 0,
    },
    pauseFileExists: false,
    ...overrides,
  });
}

describe("classifyManagerHttpLiveness", () => {
  it("reports healthy when the watchdog last class is healthy", () => {
    expect(status()).toMatchObject({
      state: "healthy",
      recommended_action: null,
      recent_restart_attempts: 0,
    });
  });

  it("reports a false-running launchd state when listener alive but watchdog sees HTTP failure", () => {
    expect(status({
      listenerPid: 222,
      watchdogState: {
        lastClass: "http_unresponsive_listener_alive",
        lastAction: "diagnose_restart",
        lastReason: "manager HTTP liveness failed while listener pid 222 is alive",
        consecutiveFailures: 2,
        lastUnhealthyAt: "2026-07-17T11:59:00.000Z",
        lastUnhealthyClass: "http_unresponsive_listener_alive",
        lastUnhealthyReason: "manager HTTP liveness failed while listener pid 222 is alive",
        restartAttempts: ["2026-07-17T11:58:00.000Z", "2026-07-17T11:59:00.000Z"],
      },
    })).toMatchObject({
      state: "launchd_running_but_unreachable",
      launchd_loaded: true,
      listener_pid: 222,
      last_unhealthy_class: "http_unresponsive_listener_alive",
      recent_restart_attempts: 2,
    });
  });

  it("reports manager_down when launchd is loaded but no listener is present", () => {
    expect(status({
      listenerPid: null,
      watchdogState: {
        lastClass: "manager_down",
        lastAction: "wait",
        lastReason: "manager HTTP liveness failed and no listener pid was found",
      },
    })).toMatchObject({
      state: "manager_down",
      launchd_loaded: true,
      listener_pid: null,
    });
  });

  it("reports watchdog_paused when the pause file is active", () => {
    expect(status({ pauseFileExists: true })).toMatchObject({
      state: "watchdog_paused",
    });
  });
});
