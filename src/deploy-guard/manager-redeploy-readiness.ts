import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { BuildStatus } from "../build-info.js";
import type { DiskHeadroom } from "../disk-health.js";
import type { SupervisorHealthStatus } from "../supervisor/index.js";

export type ManagerRedeployReadinessState =
  | "fresh"
  | "stale_ready"
  | "stale_blocked"
  | "unknown";

export type DeployCheckoutState =
  | "ready"
  | "missing"
  | "wrong_branch"
  | "dirty"
  | "divergent"
  | "unknown";

export interface DeployCheckoutStatus {
  schema_version: "manager.deploy_checkout.v1";
  repo: string;
  branch: string | null;
  head_sha: string | null;
  target_sha: string | null;
  dirty: boolean | null;
  dirty_count: number | null;
  changed_files: string[];
  ahead: number | null;
  behind: number | null;
  state: DeployCheckoutState;
  reason: string | null;
}

export interface ManagerRedeployReadiness {
  schema_version: "manager.redeploy_readiness.v1";
  state: ManagerRedeployReadinessState;
  can_deploy_origin_main: boolean;
  running_sha: string | null;
  target_sha: string | null;
  disk_headroom: Pick<DiskHeadroom, "state" | "path" | "available_bytes" | "available_gib" | "min_free_bytes" | "warn_free_bytes" | "reason">;
  supervisor_freshness: Pick<SupervisorHealthStatus, "enabled" | "running" | "state" | "last_success_at" | "stale_after_seconds" | "last_error">;
  deploy_checkout: DeployCheckoutStatus;
  blockers: string[];
  safe_command: string;
  runbook: string;
  note: string;
}

export interface ManagerRedeployReadinessInput {
  build: Pick<BuildStatus, "build_sha" | "origin_main_sha" | "behind_origin">;
  disk: DiskHeadroom;
  supervisor: SupervisorHealthStatus;
  deployCheckout: DeployCheckoutStatus;
  safeCommand?: string;
  runbook?: string;
}

export const DEFAULT_MANAGER_REDEPLOY_COMMAND =
  "DEPLOY_WATCHDOG_DRY_RUN=1 node scripts/deploy-freshness-watchdog.mjs --dry-run";

export const DEFAULT_MANAGER_REDEPLOY_RUNBOOK =
  "docs/deploy/manager-redeploy-readiness.md";

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

export function evaluateManagerRedeployReadiness(input: ManagerRedeployReadinessInput): ManagerRedeployReadiness {
  const blockers: string[] = [];
  const runningSha = input.build.build_sha ?? null;
  const targetSha = input.deployCheckout.target_sha ?? input.build.origin_main_sha ?? null;
  const safeCommand = input.safeCommand ?? DEFAULT_MANAGER_REDEPLOY_COMMAND;
  const runbook = input.runbook ?? DEFAULT_MANAGER_REDEPLOY_RUNBOOK;

  if (!runningSha || !targetSha || input.build.behind_origin == null) {
    blockers.push("build_freshness_unknown");
  }
  if (input.disk.state === "critical" || input.disk.state === "unknown") {
    blockers.push(`disk_${input.disk.state}`);
  }
  if (input.supervisor.state !== "fresh") {
    blockers.push(`supervisor_${input.supervisor.state}`);
  }
  if (input.deployCheckout.state !== "ready") {
    blockers.push(`checkout_${input.deployCheckout.state}`);
  }
  if (input.deployCheckout.target_sha && input.build.origin_main_sha && input.deployCheckout.target_sha !== input.build.origin_main_sha) {
    blockers.push("target_sha_mismatch");
  }

  const stale = input.build.behind_origin === true && runningSha !== targetSha;
  let state: ManagerRedeployReadinessState;
  if (input.build.behind_origin === false && blockers.length === 0) {
    state = "fresh";
  } else if (stale && blockers.length === 0) {
    state = "stale_ready";
  } else if (stale) {
    state = "stale_blocked";
  } else {
    state = "unknown";
  }

  return {
    schema_version: "manager.redeploy_readiness.v1",
    state,
    can_deploy_origin_main: state === "stale_ready",
    running_sha: runningSha,
    target_sha: targetSha,
    disk_headroom: {
      state: input.disk.state,
      path: input.disk.path,
      available_bytes: input.disk.available_bytes,
      available_gib: input.disk.available_gib,
      min_free_bytes: input.disk.min_free_bytes,
      warn_free_bytes: input.disk.warn_free_bytes,
      reason: input.disk.reason,
    },
    supervisor_freshness: {
      enabled: input.supervisor.enabled,
      running: input.supervisor.running,
      state: input.supervisor.state,
      last_success_at: input.supervisor.last_success_at,
      stale_after_seconds: input.supervisor.stale_after_seconds,
      last_error: input.supervisor.last_error,
    },
    deploy_checkout: input.deployCheckout,
    blockers,
    safe_command: safeCommand,
    runbook,
    note:
      state === "fresh"
        ? `manager already runs origin/main ${short(targetSha)}; no redeploy needed`
        : state === "stale_ready"
          ? `origin/main ${short(targetSha)} can be deployed from the protected checkout; runbook command is a reference only`
          : `origin/main ${short(targetSha)} is not safe to deploy yet: ${blockers.join(", ") || "unknown blocker"}`,
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parsePorcelain(status: string): string[] {
  if (!status.trim()) return [];
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseAheadBehind(value: string): { ahead: number | null; behind: number | null } {
  const [aheadRaw, behindRaw] = value.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

export function readDeployCheckoutStatus(repo: string, targetRef = "origin/main"): DeployCheckoutStatus {
  if (!existsSync(repo)) {
    return {
      schema_version: "manager.deploy_checkout.v1",
      repo,
      branch: null,
      head_sha: null,
      target_sha: null,
      dirty: null,
      dirty_count: null,
      changed_files: [],
      ahead: null,
      behind: null,
      state: "missing",
      reason: "deploy checkout does not exist",
    };
  }

  try {
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || null;
    const headSha = git(repo, ["rev-parse", "HEAD"]) || null;
    const targetSha = git(repo, ["rev-parse", targetRef]) || null;
    const changedFiles = parsePorcelain(git(repo, ["status", "--porcelain", "--untracked-files=all"]));
    const { ahead, behind } = parseAheadBehind(git(repo, ["rev-list", "--left-right", "--count", `HEAD...${targetRef}`]));

    let state: DeployCheckoutState = "ready";
    let reason: string | null = null;
    if (branch !== "main") {
      state = "wrong_branch";
      reason = `deploy checkout is on ${branch ?? "unknown"} instead of main`;
    } else if (changedFiles.length > 0) {
      state = "dirty";
      reason = `deploy checkout has ${changedFiles.length} changed file(s)`;
    } else if ((ahead ?? 0) > 0) {
      state = "divergent";
      reason = `deploy checkout has ${ahead} commit(s) not in ${targetRef}`;
    }

    return {
      schema_version: "manager.deploy_checkout.v1",
      repo,
      branch,
      head_sha: headSha,
      target_sha: targetSha,
      dirty: changedFiles.length > 0,
      dirty_count: changedFiles.length,
      changed_files: changedFiles,
      ahead,
      behind,
      state,
      reason,
    };
  } catch (err) {
    return {
      schema_version: "manager.deploy_checkout.v1",
      repo,
      branch: null,
      head_sha: null,
      target_sha: null,
      dirty: null,
      dirty_count: null,
      changed_files: [],
      ahead: null,
      behind: null,
      state: "unknown",
      reason: err instanceof Error ? err.message : "deploy checkout probe failed",
    };
  }
}
