// T-DEPLOY.7 — scripted deploy automation (Phase 3+).
//
// Composes the existing deploy-guard primitives into ONE gated pipeline:
//   mandatory pre-flight (ABI + protected-root clean + freshness) → redeploy
//   (build + kickstart, optionally coupled targets) → post-deploy verify (smoke)
//   → rollback-on-fail.
//
// Split, like the rest of deploy-guard, into a PURE planner (`planDeploy`, the
// go/no-go brain) + an injectable executor (`runDeploy`) so it is unit-testable
// and pluggable into the orchestration daemon's nightly deploy window (T-ORCH
// coupling) without shelling out in tests. The real I/O gate-gathering lives in
// `gatherDeployGates` (the CLI's `deploy` subcommand wires it).

import { spawnSync } from "node:child_process";
import { runAbiCheck, type AbiPolicy } from "./abi-check.js";
import { runSmokeProbe, type RunSmokeOptions, type SmokeResult } from "./smoke.js";
import { lastGoodStorePath, readLastGood } from "./rollback.js";

/** One ordered shell step (shape-compatible with rollback's RollbackStep). */
export interface DeployStep {
  label: string;
  cmd: string;
  args: string[];
}

export type GateName = "abi" | "protected_root" | "freshness";

/** A pre-flight check result. A failing REQUIRED gate halts before any redeploy. */
export interface PreflightGate {
  name: GateName;
  required: boolean;
  passed: boolean;
  detail: string;
}

export interface DeployPlanOptions {
  repoDir?: string;
  buildCmd?: string;
  /** launchd label kickstart — operator-specific; supply via env in the CLI. */
  kickstartCmd?: string;
  /** Extra coupled redeploy targets (T-DEPLOY.3 hook), sequenced AFTER the
   *  manager build+kickstart. Empty by default — manager-only redeploy. */
  coupledTargets?: DeployStep[];
}

export interface DeployPlan {
  /** Go/no-go after pre-flight. */
  proceed: boolean;
  /** Why the deploy was halted (null when proceed === true). */
  halt_reason: string | null;
  gates: PreflightGate[];
  /** Ordered redeploy steps to run when proceed; empty when halted. */
  steps: DeployStep[];
}

/** The ordered redeploy steps: build → kickstart manager → coupled targets. */
export function planDeploySteps(opts: DeployPlanOptions = {}): DeployStep[] {
  const repoDir = opts.repoDir ?? process.cwd();
  const buildCmd = opts.buildCmd ?? "npm run build";
  const kickstartCmd =
    opts.kickstartCmd ??
    process.env.DEPLOY_GUARD_KICKSTART_CMD ??
    "launchctl kickstart -k gui/$(id -u)/com.kilgore.id-agents-manager";
  return [
    { label: "build", cmd: "bash", args: ["-lc", `cd ${repoDir} && ${buildCmd}`] },
    { label: "kickstart manager", cmd: "bash", args: ["-lc", kickstartCmd] },
    ...(opts.coupledTargets ?? []),
  ];
}

/**
 * Pure go/no-go: a deploy proceeds iff EVERY required gate passed. Non-required
 * gates are reported (so the operator sees freshness etc.) but never block.
 * When halted, `steps` is empty and `halt_reason` names the failed gates.
 */
export function planDeploy(gates: PreflightGate[], opts: DeployPlanOptions = {}): DeployPlan {
  const failedRequired = gates.filter((g) => g.required && !g.passed);
  if (failedRequired.length > 0) {
    return {
      proceed: false,
      halt_reason: `pre-flight gate(s) failed: ${failedRequired
        .map((g) => `${g.name} (${g.detail})`)
        .join("; ")}`,
      gates,
      steps: [],
    };
  }
  return { proceed: true, halt_reason: null, gates, steps: planDeploySteps(opts) };
}

export type DeployOutcome =
  | "halted_preflight"
  | "planned" // dry-run: proceed but not executed
  | "deployed" // executed + verified clean
  | "deploy_step_failed"
  | "rolled_back" // verify failed → rolled back to last-good
  | "rollback_failed";

export interface DeployRunResult {
  outcome: DeployOutcome;
  plan: DeployPlan;
  ran: string[];
  smoke: SmokeResult | null;
  rollback: { target_sha: string | null; steps: DeployStep[]; ok: boolean } | null;
}

/** Injectable dependencies so `runDeploy` is unit-testable without real I/O. */
export interface DeployRunnerDeps {
  gatherGates: () => PreflightGate[] | Promise<PreflightGate[]>;
  runStep: (step: DeployStep) => { ok: boolean };
  verify: () => Promise<SmokeResult>;
  /** Ordered shell steps that roll the deploy back to `sha`. */
  planRollback: (sha: string) => DeployStep[];
  /** The last known-good build SHA to roll back to (null disables rollback). */
  lastGoodSha: () => string | null;
}

export interface RunDeployOptions extends DeployPlanOptions {
  /** When false, plan + gate but do NOT execute (the safe default). */
  execute?: boolean;
}

/**
 * Drive the full pipeline: gather gates → plan → (if proceed + execute) run the
 * redeploy steps → verify → rollback on verify-fail. Returns a structured
 * outcome the CLI prints and the orchestration daemon can act on.
 */
export async function runDeploy(
  deps: DeployRunnerDeps,
  opts: RunDeployOptions = {},
): Promise<DeployRunResult> {
  const gates = await deps.gatherGates();
  const plan = planDeploy(gates, opts);
  const ran: string[] = [];

  if (!plan.proceed) {
    return { outcome: "halted_preflight", plan, ran, smoke: null, rollback: null };
  }
  if (opts.execute !== true) {
    return { outcome: "planned", plan, ran, smoke: null, rollback: null };
  }

  for (const step of plan.steps) {
    ran.push(`${step.cmd} ${step.args.join(" ")}`);
    if (!deps.runStep(step).ok) {
      return { outcome: "deploy_step_failed", plan, ran, smoke: null, rollback: null };
    }
  }

  const smoke = await deps.verify();
  if (smoke.pass) {
    return { outcome: "deployed", plan, ran, smoke, rollback: null };
  }

  // Verify failed → roll back to last-good (when known).
  const targetSha = deps.lastGoodSha();
  if (!targetSha) {
    return {
      outcome: "rollback_failed",
      plan,
      ran,
      smoke,
      rollback: { target_sha: null, steps: [], ok: false },
    };
  }
  const steps = deps.planRollback(targetSha);
  let ok = true;
  for (const step of steps) {
    ran.push(`${step.cmd} ${step.args.join(" ")}`);
    if (!deps.runStep(step).ok) {
      ok = false;
      break;
    }
  }
  return {
    outcome: ok ? "rolled_back" : "rollback_failed",
    plan,
    ran,
    smoke,
    rollback: { target_sha: targetSha, steps, ok },
  };
}

// ─── Real (I/O) gate gathering — the CLI wires this; not exercised in unit tests.

export interface GatherGatesOptions {
  repoDir?: string;
  node?: string;
  modules?: string[];
  abiPolicy?: AbiPolicy;
  /** Treat freshness (behind-origin) as a required gate (only deploy when there
   *  is something new to ship). Default false: freshness is informational. */
  requireFreshness?: boolean;
  remote?: string;
  branch?: string;
}

/** Gather the three pre-flight gates from the real environment (git + ABI). */
export function gatherDeployGates(opts: GatherGatesOptions = {}): PreflightGate[] {
  const repoDir = opts.repoDir ?? process.cwd();

  // ABI: every native module must load under the manager node.
  const abi = runAbiCheck({
    cwd: repoDir,
    node: opts.node,
    modules: opts.modules,
    policy: opts.abiPolicy ?? "block",
  });

  // Protected-root: the deploy checkout must be clean (no uncommitted work).
  const porcelain = gitOut(repoDir, ["status", "--porcelain=v1"]);
  const clean = porcelain.ok && porcelain.out.trim() === "";

  // Freshness: is the local branch behind its remote (something to deploy)?
  const remote = opts.remote ?? "origin";
  const branch = opts.branch ?? "main";
  const behind = countBehind(repoDir, remote, branch);

  return [
    {
      name: "abi",
      required: true,
      passed: abi.pass,
      detail: abi.pass ? "native modules load" : abi.failures.join("; ") || "abi mismatch",
    },
    {
      name: "protected_root",
      required: true,
      passed: clean,
      detail: clean ? "working tree clean" : `dirty: ${porcelain.out.trim().split("\n").length} change(s)`,
    },
    {
      name: "freshness",
      required: opts.requireFreshness === true,
      passed: opts.requireFreshness === true ? behind > 0 : true,
      detail: behind > 0 ? `${behind} commit(s) behind ${remote}/${branch}` : `up to date with ${remote}/${branch}`,
    },
  ];
}

function gitOut(repoDir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** Commits the local branch is behind <remote>/<branch>; 0 when unknown. */
function countBehind(repoDir: string, remote: string, branch: string): number {
  const r = gitOut(repoDir, ["rev-list", "--count", `HEAD..${remote}/${branch}`]);
  if (!r.ok) return 0;
  const n = Number.parseInt(r.out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Convenience: the smoke verifier bound to a base URL (for the CLI/daemon). */
export function smokeVerifier(opts: RunSmokeOptions): () => Promise<SmokeResult> {
  return () => runSmokeProbe(opts);
}

/** The last-good SHA reader for a repo (rollback target source). */
export function lastGoodShaReader(repoDir: string): () => string | null {
  return () => readLastGood(lastGoodStorePath(repoDir))?.build_sha ?? null;
}
