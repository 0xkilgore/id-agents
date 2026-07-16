import { describe, expect, it } from "vitest";
import type { DiskHeadroom } from "../../src/disk-health.js";
import type { SupervisorHealthStatus } from "../../src/supervisor/index.js";
import {
  evaluateManagerRedeployReadiness,
  type DeployCheckoutStatus,
} from "../../src/deploy-guard/manager-redeploy-readiness.js";

function disk(overrides: Partial<DiskHeadroom> = {}): DiskHeadroom {
  return {
    schema_version: "disk-headroom.v1",
    state: "ok",
    path: "/repo/id-agents-deploy-main",
    free_bytes: 40_000_000_000,
    available_bytes: 40_000_000_000,
    total_bytes: 100_000_000_000,
    free_gib: 37.3,
    available_gib: 37.3,
    total_gib: 93.1,
    used_percent: 60,
    min_free_bytes: 5_000_000_000,
    warn_free_bytes: 10_000_000_000,
    reason: null,
    ...overrides,
  };
}

function supervisor(overrides: Partial<SupervisorHealthStatus> = {}): SupervisorHealthStatus {
  return {
    schema_version: "supervisor-freshness.v1",
    enabled: true,
    running: true,
    state: "fresh",
    poll_interval_seconds: 30,
    stale_after_seconds: 90,
    last_tick_started_at: "2026-07-16T00:00:00.000Z",
    last_success_at: "2026-07-16T00:00:00.000Z",
    last_error_at: null,
    last_error: null,
    open_alert_count: 0,
    ...overrides,
  };
}

function checkout(overrides: Partial<DeployCheckoutStatus> = {}): DeployCheckoutStatus {
  return {
    schema_version: "manager.deploy_checkout.v1",
    repo: "/repo/id-agents-deploy-main",
    branch: "main",
    head_sha: "target",
    target_sha: "target",
    dirty: false,
    dirty_count: 0,
    changed_files: [],
    ahead: 0,
    behind: 0,
    state: "ready",
    reason: null,
    ...overrides,
  };
}

describe("manager redeploy readiness gate", () => {
  it("reports fresh when the running manager already matches origin/main", () => {
    const readiness = evaluateManagerRedeployReadiness({
      build: { build_sha: "target", origin_main_sha: "target", behind_origin: false },
      disk: disk(),
      supervisor: supervisor(),
      deployCheckout: checkout(),
    });

    expect(readiness).toMatchObject({
      state: "fresh",
      can_deploy_origin_main: false,
      running_sha: "target",
      target_sha: "target",
      blockers: [],
    });
    expect(readiness.note).toContain("no redeploy needed");
  });

  it("reports stale_ready when origin/main can be safely deployed from the protected checkout", () => {
    const readiness = evaluateManagerRedeployReadiness({
      build: { build_sha: "running", origin_main_sha: "target", behind_origin: true },
      disk: disk(),
      supervisor: supervisor(),
      deployCheckout: checkout({ head_sha: "target", target_sha: "target" }),
    });

    expect(readiness).toMatchObject({
      state: "stale_ready",
      can_deploy_origin_main: true,
      running_sha: "running",
      target_sha: "target",
      blockers: [],
      deploy_checkout: {
        state: "ready",
        dirty: false,
        ahead: 0,
      },
    });
    expect(readiness.safe_command).toContain("deploy-freshness-watchdog");
    expect(readiness.runbook).toContain("manager-redeploy-readiness");
  });

  it("blocks stale redeploy readiness when disk headroom is critical", () => {
    const readiness = evaluateManagerRedeployReadiness({
      build: { build_sha: "running", origin_main_sha: "target", behind_origin: true },
      disk: disk({ state: "critical", available_bytes: 1_000_000, available_gib: 0, reason: "low disk" }),
      supervisor: supervisor(),
      deployCheckout: checkout(),
    });

    expect(readiness).toMatchObject({
      state: "stale_blocked",
      can_deploy_origin_main: false,
      blockers: ["disk_critical"],
    });
    expect(readiness.disk_headroom).toMatchObject({ state: "critical", reason: "low disk" });
  });

  it("blocks stale redeploy readiness when the protected checkout is dirty", () => {
    const readiness = evaluateManagerRedeployReadiness({
      build: { build_sha: "running", origin_main_sha: "target", behind_origin: true },
      disk: disk(),
      supervisor: supervisor(),
      deployCheckout: checkout({
        dirty: true,
        dirty_count: 1,
        changed_files: ["src/agent-manager-db.ts"],
        state: "dirty",
        reason: "deploy checkout has 1 changed file(s)",
      }),
    });

    expect(readiness).toMatchObject({
      state: "stale_blocked",
      can_deploy_origin_main: false,
      blockers: ["checkout_dirty"],
      deploy_checkout: {
        dirty: true,
        dirty_count: 1,
        changed_files: ["src/agent-manager-db.ts"],
      },
    });
  });
});

