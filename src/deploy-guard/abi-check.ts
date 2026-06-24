// T-DEPLOY.2 (2026-06-24) — native-module ABI safety baked into deploy.
//
// The pre-deploy sibling of the post-deploy smoke gate (smoke.ts). BEFORE the
// manager is kickstarted, prove every native module (better-sqlite3) loads under
// the MANAGER node the manager will boot under. A mismatch here is the "M4
// two-node trap": the module was compiled for a different Node ABI, so the
// manager crash-loops on restart with ERR_DLOPEN_FAILED (incident I-3). This is
// the gate that would have caught it BEFORE the restart.
//
// Policy (Q-DEPLOY-1): the default BLOCKS the deploy on mismatch (fail fast — an
// ABI mismatch is a guaranteed crash-loop). `--alert-only` (or
// DEPLOY_GUARD_ABI_POLICY=alert) downgrades to a non-blocking warning for
// operators who want to deploy-then-fix manually.
//
// Shape mirrors smoke.ts: a PURE evaluator (evaluateAbiCheck) + a thin I/O probe
// (runAbiCheck) whose module loader/rebuilder is injectable for tests.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { resolveManagerNode, isAbiMismatchError } from "../lib/native-node.js";

/** Native modules whose ABI must match the manager node before a deploy. */
export const DEFAULT_NATIVE_MODULES = ["better-sqlite3"];

export type AbiPolicy = "block" | "alert";

export interface NativeModuleProbe {
  name: string;
  loaded: boolean;
  /** True when the load failure is a Node ABI mismatch (vs a different error). */
  abi_mismatch: boolean;
  error: string | null;
}

export interface AbiProbe {
  managerNode: string;
  managerNodeVersion: string | null;
  modules: NativeModuleProbe[];
  /** Set when runAbiCheck attempted an auto-rebuild before re-probing. */
  rebuild?: { attempted: boolean; succeeded: boolean } | null;
}

export interface AbiCheckResult {
  /** Every native module loads under the manager node. */
  pass: boolean;
  /** pass === false AND policy === "block" — the deploy MUST NOT proceed. */
  blocked: boolean;
  policy: AbiPolicy;
  action: "pass" | "block" | "alert";
  failures: string[];
  modules: NativeModuleProbe[];
  manager_node: string;
  manager_node_version: string | null;
  rebuild?: { attempted: boolean; succeeded: boolean } | null;
}

/** Pure: evaluate a probe against the pre-deploy ABI acceptance criteria. */
export function evaluateAbiCheck(probe: AbiProbe, policy: AbiPolicy = "block"): AbiCheckResult {
  const failures = probe.modules
    .filter((m) => !m.loaded)
    .map((m) => {
      const why = m.abi_mismatch ? "ABI mismatch" : "load failure";
      const detail = m.error ? `: ${m.error.split("\n")[0]}` : "";
      return `${m.name} (${why}${detail})`;
    });

  const pass = failures.length === 0;
  const blocked = !pass && policy === "block";
  const action: AbiCheckResult["action"] = pass ? "pass" : blocked ? "block" : "alert";

  return {
    pass,
    blocked,
    policy,
    action,
    failures,
    modules: probe.modules,
    manager_node: probe.managerNode,
    manager_node_version: probe.managerNodeVersion,
    rebuild: probe.rebuild ?? null,
  };
}

/**
 * Pure: select the gate policy. Default is "block" (Q-DEPLOY-1). An explicit
 * --block flag wins; otherwise --alert-only or DEPLOY_GUARD_ABI_POLICY=alert
 * selects "alert". Any unknown env value is ignored (stays "block").
 */
export function resolveAbiPolicy(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
): AbiPolicy {
  if (flags.block === true) return "block";
  if (flags["alert-only"] === true) return "alert";
  if ((env.DEPLOY_GUARD_ABI_POLICY ?? "").toLowerCase() === "alert") return "alert";
  return "block";
}

/** How runAbiCheck loads and (optionally) rebuilds a module — injectable for tests. */
export interface ModuleRunner {
  load(node: string, moduleName: string, cwd: string): { ok: boolean; error: string | null };
  rebuild(node: string, moduleName: string, cwd: string, execute: boolean): { ok: boolean; error: string | null };
}

// Per-module load snippet. better-sqlite3 only dlopens its binding when a DB is
// actually opened, so instantiate one (mirrors scripts/ensure-native-abi.mjs).
function loadSnippet(moduleName: string): string {
  if (moduleName === "better-sqlite3") {
    return "const D=require('better-sqlite3'); new D(':memory:').close();";
  }
  return `require(${JSON.stringify(moduleName)});`;
}

/** Default runner: probe/rebuild a module in a FRESH process under the given node. */
export const execModuleRunner: ModuleRunner = {
  load(node, moduleName, cwd) {
    try {
      execFileSync(node, ["-e", loadSnippet(moduleName)], { cwd, stdio: "pipe" });
      return { ok: true, error: null };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string })?.stderr;
      const msg = stderr ? String(stderr) : err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg.trim() };
    }
  },
  rebuild(node, moduleName, cwd, execute) {
    if (!execute) return { ok: true, error: null }; // dry-run: report the plan only
    try {
      // Prepend the manager node's dir so npm + node-gyp target ITS ABI even when
      // this process runs under the shell node (same trick as ensure-native-abi).
      execFileSync("npm", ["rebuild", moduleName], {
        cwd,
        stdio: "inherit",
        env: { ...process.env, PATH: `${dirname(node)}:${process.env.PATH}` },
      });
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

function nodeVersion(node: string): string | null {
  try {
    return execFileSync(node, ["-v"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export interface RunAbiCheckOptions {
  /** Manager node to probe under. Defaults to resolveManagerNode(). */
  node?: string;
  modules?: string[];
  cwd?: string;
  policy?: AbiPolicy;
  /** Attempt an auto-rebuild of any mismatched module, then re-probe. */
  rebuild?: boolean;
  /** Actually run the rebuild (vs dry-run). Mirrors deploy-guard --execute. */
  execute?: boolean;
  runner?: ModuleRunner;
  nodeVersion?: string | null;
}

/** Probe native modules under the manager node + evaluate. Thin I/O around evaluateAbiCheck. */
export function runAbiCheck(opts: RunAbiCheckOptions = {}): AbiCheckResult {
  const node = opts.node ?? resolveManagerNode();
  const cwd = opts.cwd ?? process.cwd();
  const modules = opts.modules ?? DEFAULT_NATIVE_MODULES;
  const policy = opts.policy ?? "block";
  const runner = opts.runner ?? execModuleRunner;
  const version = opts.nodeVersion !== undefined ? opts.nodeVersion : nodeVersion(node);

  const probeOne = (name: string): NativeModuleProbe => {
    const res = runner.load(node, name, cwd);
    return {
      name,
      loaded: res.ok,
      abi_mismatch: !res.ok && isAbiMismatchError(new Error(res.error ?? "")),
      error: res.ok ? null : res.error,
    };
  };

  let probes = modules.map(probeOne);
  let rebuild: { attempted: boolean; succeeded: boolean } | null = null;

  if (opts.rebuild && probes.some((p) => !p.loaded)) {
    let allOk = true;
    for (const p of probes) {
      if (p.loaded) continue;
      const r = runner.rebuild(node, p.name, cwd, opts.execute === true);
      if (!r.ok) allOk = false;
    }
    // Re-probe after the rebuild attempt so the gate reflects the healed state.
    probes = modules.map(probeOne);
    rebuild = { attempted: true, succeeded: allOk && probes.every((p) => p.loaded) };
  }

  return evaluateAbiCheck(
    { managerNode: node, managerNodeVersion: version, modules: probes, rebuild },
    policy,
  );
}
