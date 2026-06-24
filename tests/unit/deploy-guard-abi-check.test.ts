// T-DEPLOY.2 (2026-06-24) — native-module ABI safety baked into deploy.
//
// The pre-deploy sibling of the post-deploy smoke gate (T-DEPLOY.5): BEFORE the
// manager is kickstarted, prove every native module (better-sqlite3) loads under
// the MANAGER node it will boot under. A mismatch here is the "two-node trap" —
// it crash-loops the manager on restart (ERR_DLOPEN_FAILED). Per Q-DEPLOY-1
// (Maestra-recommended) the default policy BLOCKS the deploy on mismatch; an
// explicit alert-only escape hatch downgrades it to a non-blocking warning.

import { describe, it, expect } from "vitest";
import {
  evaluateAbiCheck,
  resolveAbiPolicy,
  runAbiCheck,
  DEFAULT_NATIVE_MODULES,
  type AbiProbe,
  type ModuleRunner,
  type NativeModuleProbe,
} from "../../src/deploy-guard/abi-check.js";

const ABI_ERROR =
  "Error: The module 'better_sqlite3.node' was compiled against a different " +
  "Node.js version using NODE_MODULE_VERSION 131. This version of Node.js " +
  "requires NODE_MODULE_VERSION 127.";

function probeOf(
  modules: NativeModuleProbe[],
  managerNode = "/opt/homebrew/bin/node",
): AbiProbe {
  return { managerNode, managerNodeVersion: "v23.7.0", modules };
}

const ok = (name: string): NativeModuleProbe => ({ name, loaded: true, abi_mismatch: false, error: null });
const abiBad = (name: string): NativeModuleProbe => ({ name, loaded: false, abi_mismatch: true, error: ABI_ERROR });
const otherBad = (name: string): NativeModuleProbe => ({ name, loaded: false, abi_mismatch: false, error: "ENOENT: not built" });

describe("evaluateAbiCheck (T-DEPLOY.2 pure gate)", () => {
  it("passes when every native module loads under the manager node", () => {
    const r = evaluateAbiCheck(probeOf([ok("better-sqlite3")]), "block");
    expect(r.pass).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.action).toBe("pass");
    expect(r.failures).toEqual([]);
  });

  it("ACCEPTANCE: an ABI mismatch BLOCKS the deploy under the default block policy", () => {
    const r = evaluateAbiCheck(probeOf([abiBad("better-sqlite3")]), "block");
    expect(r.pass).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.action).toBe("block");
    expect(r.failures.join()).toMatch(/better-sqlite3/);
    expect(r.failures.join()).toMatch(/NODE_MODULE_VERSION/);
  });

  it("alert-only policy reports the mismatch but does NOT block", () => {
    const r = evaluateAbiCheck(probeOf([abiBad("better-sqlite3")]), "alert");
    expect(r.pass).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.action).toBe("alert");
  });

  it("a non-ABI load failure still fails the gate (the manager would still crash)", () => {
    const r = evaluateAbiCheck(probeOf([otherBad("better-sqlite3")]), "block");
    expect(r.pass).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("fails when ANY of several modules does not load", () => {
    const r = evaluateAbiCheck(probeOf([ok("better-sqlite3"), abiBad("other-native")]), "block");
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/other-native/);
    expect(r.failures.join()).not.toMatch(/better-sqlite3/);
  });

  it("carries the manager node + rebuild outcome through to the result for reporting", () => {
    const probe = { ...probeOf([ok("better-sqlite3")]), rebuild: { attempted: true, succeeded: true } };
    const r = evaluateAbiCheck(probe, "block");
    expect(r.manager_node).toBe("/opt/homebrew/bin/node");
    expect(r.rebuild).toEqual({ attempted: true, succeeded: true });
  });
});

describe("resolveAbiPolicy (T-DEPLOY.2 policy selection)", () => {
  it("defaults to block (Q-DEPLOY-1: fail fast on ABI mismatch)", () => {
    expect(resolveAbiPolicy({}, {})).toBe("block");
  });

  it("--alert-only downgrades to alert", () => {
    expect(resolveAbiPolicy({ "alert-only": true }, {})).toBe("alert");
  });

  it("DEPLOY_GUARD_ABI_POLICY=alert env var selects alert", () => {
    expect(resolveAbiPolicy({}, { DEPLOY_GUARD_ABI_POLICY: "alert" })).toBe("alert");
  });

  it("an explicit --block flag overrides an alert env var", () => {
    expect(resolveAbiPolicy({ block: true }, { DEPLOY_GUARD_ABI_POLICY: "alert" })).toBe("block");
  });

  it("ignores an unknown env value and stays at block", () => {
    expect(resolveAbiPolicy({}, { DEPLOY_GUARD_ABI_POLICY: "nonsense" })).toBe("block");
  });
});

describe("DEFAULT_NATIVE_MODULES", () => {
  it("includes better-sqlite3 (the module behind the M4 two-node trap)", () => {
    expect(DEFAULT_NATIVE_MODULES).toContain("better-sqlite3");
  });
});

describe("runAbiCheck (T-DEPLOY.2 probe + policy, injected runner)", () => {
  // A fake runner: modules in `broken` fail to load until rebuilt (if allowed).
  function fakeRunner(broken: Set<string>, opts: { rebuildFixes?: boolean } = {}): ModuleRunner & { loads: number; rebuilds: number } {
    const r = {
      loads: 0,
      rebuilds: 0,
      load(_node: string, moduleName: string) {
        r.loads++;
        if (broken.has(moduleName)) return { ok: false, error: ABI_ERROR };
        return { ok: true, error: null };
      },
      rebuild(_node: string, moduleName: string, _cwd: string, execute: boolean) {
        r.rebuilds++;
        if (execute && opts.rebuildFixes) broken.delete(moduleName);
        return { ok: execute ? Boolean(opts.rebuildFixes) : true, error: null };
      },
    };
    return r;
  }

  it("passes with no rebuild when the module already loads", () => {
    const runner = fakeRunner(new Set());
    const r = runAbiCheck({ node: "/opt/homebrew/bin/node", modules: ["better-sqlite3"], runner });
    expect(r.pass).toBe(true);
    expect(runner.rebuilds).toBe(0);
  });

  it("classifies a mismatch and blocks (default policy) without rebuilding when --rebuild is off", () => {
    const runner = fakeRunner(new Set(["better-sqlite3"]));
    const r = runAbiCheck({ node: "/opt/homebrew/bin/node", modules: ["better-sqlite3"], runner });
    expect(r.pass).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.modules[0].abi_mismatch).toBe(true);
    expect(runner.rebuilds).toBe(0);
  });

  it("ACCEPTANCE: --rebuild --execute self-heals an ABI mismatch then re-probes green", () => {
    const runner = fakeRunner(new Set(["better-sqlite3"]), { rebuildFixes: true });
    const r = runAbiCheck({
      node: "/opt/homebrew/bin/node",
      modules: ["better-sqlite3"],
      rebuild: true,
      execute: true,
      runner,
    });
    expect(runner.rebuilds).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.rebuild?.attempted).toBe(true);
    expect(r.rebuild?.succeeded).toBe(true);
  });

  it("alert policy surfaces the mismatch without blocking", () => {
    const runner = fakeRunner(new Set(["better-sqlite3"]));
    const r = runAbiCheck({ node: "/opt/homebrew/bin/node", modules: ["better-sqlite3"], policy: "alert", runner });
    expect(r.pass).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.action).toBe("alert");
  });
});
