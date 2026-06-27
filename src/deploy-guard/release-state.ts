// Kapelle release-state guard.
//
// /health already reports manager build freshness. This module adds the local
// ops checkout dimension: is the served kapelle-site checkout clean main at
// origin/main, and are rebuild/supervisor lock files owned by the live server?
// Decisions are pure/injectable so health can surface actionable RED/YELLOW
// state without mutating the checkout.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { runWithTimeout } from "../lib/subprocess.js";
import {
  gitAheadBehind,
  gitCurrentBranch,
  protectedRootStatus,
  stripWorktreeNoise,
  gitStatusShort,
} from "../workspaces/allocator.js";

export type ReleaseSeverity = "green" | "yellow" | "red";
export type CheckoutStateCode =
  | "clean_main"
  | "missing_checkout"
  | "not_git_checkout"
  | "off_main"
  | "dirty"
  | "ahead_or_behind"
  | "unknown";
export type LockStateCode = "clear" | "active" | "stale_pid" | "owner_mismatch" | "unknown";

export interface CheckoutProbe {
  exists: boolean;
  is_git: boolean;
  branch: string | null;
  intended_branch: string;
  upstream: string;
  ahead: number | null;
  behind: number | null;
  dirty_count: number;
  status_short: string;
}

export interface CheckoutAssessment extends CheckoutProbe {
  severity: ReleaseSeverity;
  code: CheckoutStateCode;
  message: string;
  remediation: string;
}

export interface OpsLockProbe {
  path: string;
  name: ".ops-build.lock" | ".ops-supervisor.lock";
  exists: boolean;
  owner_pid: number | null;
  owner_alive: boolean | null;
  live_server_pid: number | null;
  mtime_ms: number | null;
  raw: string | null;
}

export interface OpsLockAssessment extends OpsLockProbe {
  severity: ReleaseSeverity;
  code: LockStateCode;
  remediation: string;
  safely_removable: boolean;
}

export interface ReleaseState {
  repo_dir: string;
  observed_at: string;
  status: ReleaseSeverity;
  checkout: CheckoutAssessment;
  locks: OpsLockAssessment[];
  actions: string[];
}

export interface ReleaseStateOptions {
  intendedBranch?: string;
  remote?: string;
  now?: () => Date;
  liveServerPid?: number | null;
  pidAlive?: (pid: number) => boolean;
}

const LOCK_NAMES: OpsLockProbe["name"][] = [".ops-build.lock", ".ops-supervisor.lock"];

export function assessCheckout(probe: CheckoutProbe): CheckoutAssessment {
  if (!probe.exists) {
    return {
      ...probe,
      severity: "yellow",
      code: "missing_checkout",
      message: `kapelle-site checkout is missing at the configured path`,
      remediation: `Clone kapelle-site at this path or set DEPLOY_FLEET_NODES to the serving checkout.`,
    };
  }
  if (!probe.is_git) {
    return {
      ...probe,
      severity: "yellow",
      code: "not_git_checkout",
      message: `kapelle-site path is not a git checkout`,
      remediation: `Point DEPLOY_FLEET_NODES at the git checkout that serves /ops.`,
    };
  }
  if (probe.branch !== probe.intended_branch) {
    return {
      ...probe,
      severity: "red",
      code: "off_main",
      message: `kapelle-site is serving branch ${probe.branch ?? "DETACHED"}, expected ${probe.intended_branch}`,
      remediation: `Stop/restart the ops server from a clean ${probe.intended_branch} checkout: commit or stash local work, checkout ${probe.intended_branch}, pull --ff-only ${probe.upstream}, rebuild, restart.`,
    };
  }
  if (probe.dirty_count > 0) {
    return {
      ...probe,
      severity: "red",
      code: "dirty",
      message: `kapelle-site has ${probe.dirty_count} uncommitted change(s)`,
      remediation: `Commit or stash the listed changes, then rebuild and restart /ops from clean ${probe.upstream}.`,
    };
  }
  if ((probe.ahead ?? 0) > 0 || (probe.behind ?? 0) > 0) {
    return {
      ...probe,
      severity: "yellow",
      code: "ahead_or_behind",
      message: `kapelle-site ${probe.intended_branch} differs from ${probe.upstream} (ahead=${probe.ahead ?? "?"}, behind=${probe.behind ?? "?"})`,
      remediation: `Fast-forward ${probe.intended_branch} to ${probe.upstream}, rebuild, and restart /ops; do not serve a divergent local main.`,
    };
  }
  if (probe.ahead === null || probe.behind === null) {
    return {
      ...probe,
      severity: "yellow",
      code: "unknown",
      message: `kapelle-site origin comparison is unknown`,
      remediation: `Fetch the remote and verify ${probe.intended_branch} equals ${probe.upstream}, then rebuild and restart if needed.`,
    };
  }
  return {
    ...probe,
    severity: "green",
    code: "clean_main",
    message: `kapelle-site is clean on ${probe.upstream}`,
    remediation: "No action needed.",
  };
}

export function assessOpsLock(probe: OpsLockProbe): OpsLockAssessment {
  if (!probe.exists) {
    return { ...probe, severity: "green", code: "clear", remediation: "No action needed.", safely_removable: false };
  }
  if (probe.owner_pid == null) {
    return {
      ...probe,
      severity: "yellow",
      code: "unknown",
      remediation: `Inspect ${probe.name}; if no rebuild/supervisor process is active, remove it before rebuilding.`,
      safely_removable: false,
    };
  }
  if (probe.owner_alive === false) {
    return {
      ...probe,
      severity: "yellow",
      code: "stale_pid",
      remediation: `Remove ${probe.name}; recorded owner PID ${probe.owner_pid} is not running, then rerun rebuild/restart.`,
      safely_removable: true,
    };
  }
  if (probe.live_server_pid != null && probe.owner_pid !== probe.live_server_pid) {
    return {
      ...probe,
      severity: "red",
      code: "owner_mismatch",
      remediation: `Do not trust the current /ops render. Stop the stale rebuild/supervisor owner PID ${probe.owner_pid} if appropriate, remove ${probe.name}, then rebuild/restart so lock ownership matches live next-server PID ${probe.live_server_pid}.`,
      safely_removable: false,
    };
  }
  return {
    ...probe,
    severity: "green",
    code: "active",
    remediation: "No action needed.",
    safely_removable: false,
  };
}

export function readReleaseState(repoDir: string, opts: ReleaseStateOptions = {}): ReleaseState {
  const intendedBranch = opts.intendedBranch ?? "main";
  const remote = opts.remote ?? "origin";
  const upstream = `${remote}/${intendedBranch}`;
  const now = opts.now ?? (() => new Date());
  const liveServerPid = opts.liveServerPid === undefined ? detectLiveNextServerPid(repoDir) : opts.liveServerPid;
  const pidAlive = opts.pidAlive ?? isPidAlive;

  const checkout = assessCheckout(readCheckoutProbe(repoDir, intendedBranch, upstream));
  const locks = LOCK_NAMES.map((name) => assessOpsLock(readOpsLockProbe(repoDir, name, liveServerPid, pidAlive)));
  const status = worstSeverity([checkout.severity, ...locks.map((lock) => lock.severity)]);
  const actions = [
    checkout.severity === "green" ? null : checkout.remediation,
    ...locks.filter((lock) => lock.severity !== "green").map((lock) => lock.remediation),
  ].filter((action): action is string => !!action);

  return {
    repo_dir: repoDir,
    observed_at: now().toISOString(),
    status,
    checkout,
    locks,
    actions,
  };
}

export function cleanSafelyRemovableOpsLocks(repoDir: string, state = readReleaseState(repoDir)): string[] {
  const removed: string[] = [];
  for (const lock of state.locks) {
    if (!lock.safely_removable || !lock.exists) continue;
    rmSync(lock.path, { force: true });
    removed.push(lock.path);
  }
  return removed;
}

function readCheckoutProbe(repoDir: string, intendedBranch: string, upstream: string): CheckoutProbe {
  const exists = existsSync(repoDir);
  const isGit = exists && existsSync(path.join(repoDir, ".git"));
  if (!exists || !isGit) {
    return {
      exists,
      is_git: isGit,
      branch: null,
      intended_branch: intendedBranch,
      upstream,
      ahead: null,
      behind: null,
      dirty_count: 0,
      status_short: "",
    };
  }
  const status = protectedRootStatus(repoDir);
  const statusShort = stripWorktreeNoise(gitStatusShort(repoDir));
  const dirtyCount = status.trim().length === 0 ? 0 : status.trim().split("\n").length;
  const ab = gitAheadBehind(repoDir, upstream);
  return {
    exists,
    is_git: true,
    branch: gitCurrentBranch(repoDir),
    intended_branch: intendedBranch,
    upstream,
    ahead: ab?.ahead ?? null,
    behind: ab?.behind ?? null,
    dirty_count: dirtyCount,
    status_short: statusShort,
  };
}

function readOpsLockProbe(
  repoDir: string,
  name: OpsLockProbe["name"],
  liveServerPid: number | null,
  pidAlive: (pid: number) => boolean,
): OpsLockProbe {
  const lockPath = path.join(repoDir, name);
  if (!existsSync(lockPath)) {
    return {
      path: lockPath,
      name,
      exists: false,
      owner_pid: null,
      owner_alive: null,
      live_server_pid: liveServerPid,
      mtime_ms: null,
      raw: null,
    };
  }
  const raw = safeRead(lockPath);
  const ownerPid = parseLockPid(raw);
  return {
    path: lockPath,
    name,
    exists: true,
    owner_pid: ownerPid,
    owner_alive: ownerPid == null ? null : pidAlive(ownerPid),
    live_server_pid: liveServerPid,
    mtime_ms: safeMtimeMs(lockPath),
    raw,
  };
}

export function parseLockPid(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["pid", "owner_pid", "processPid"]) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
      if (typeof value === "string") {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
  } catch {
    // Fall through to plain-text PID parsing.
  }
  const m = raw.match(/\bpid\b\D*(\d+)|^\s*(\d+)\s*$/i);
  const n = Number.parseInt(m?.[1] ?? m?.[2] ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function detectLiveNextServerPid(repoDir: string): number | null {
  const pgrep = runWithTimeout("pgrep", ["-f", "next-server|next start|next dev"], { timeoutMs: 1500 });
  if (!pgrep.ok) return null;
  const candidates = pgrep.stdout
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const pid of candidates) {
    const cwd = runWithTimeout("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 1500 });
    if (cwd.ok && cwd.stdout.includes(`n${path.resolve(repoDir)}`)) return pid;
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function safeMtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function worstSeverity(values: ReleaseSeverity[]): ReleaseSeverity {
  if (values.includes("red")) return "red";
  if (values.includes("yellow")) return "yellow";
  return "green";
}
