// Two-node-trap guard (T-INFRA) — ABI-mismatch detector + manager-node resolver.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  isAbiMismatchError,
  abiMismatchDiagnostic,
  resolveManagerNode,
  CANONICAL_MANAGER_NODE,
} from "../../src/lib/native-node.js";

// The verbatim error better-sqlite3 throws under the wrong node ABI — exactly
// what was silently swallowed into "memory-only mode" for 3 recurrences.
const REAL_ABI_ERROR = new Error(
  "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
    "was compiled against a different Node.js version using\n" +
    "NODE_MODULE_VERSION 131. This version of Node.js requires\n" +
    "NODE_MODULE_VERSION 127. Please try re-compiling or re-installing\n" +
    "the module (for instance, using `npm rebuild` or `npm install`).",
);

describe("isAbiMismatchError", () => {
  it("detects the real better-sqlite3 NODE_MODULE_VERSION error", () => {
    expect(isAbiMismatchError(REAL_ABI_ERROR)).toBe(true);
  });

  it("detects an ERR_DLOPEN_FAILED coded error", () => {
    const e = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });
    expect(isAbiMismatchError(e)).toBe(true);
  });

  it("detects 'compiled against a different Node.js version'", () => {
    expect(isAbiMismatchError(new Error("was compiled against a different Node.js version"))).toBe(true);
  });

  it("does NOT flag unrelated DB errors (those keep the memory-only fallback)", () => {
    expect(isAbiMismatchError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isAbiMismatchError(new Error("ENOENT: no such file or directory"))).toBe(false);
    expect(isAbiMismatchError(null)).toBe(false);
    expect(isAbiMismatchError(undefined)).toBe(false);
  });
});

describe("abiMismatchDiagnostic", () => {
  it("names the two-node trap, the expected node, and the rebuild fix", () => {
    const d = abiMismatchDiagnostic(REAL_ABI_ERROR);
    expect(d).toMatch(/two-node trap/i);
    expect(d).toMatch(/rebuild better-sqlite3/i);
    expect(d).toContain(resolveManagerNode());
    expect(d).toMatch(/NODE_MODULE_VERSION 131/);
  });
});

describe("resolveManagerNode", () => {
  const saved = process.env.IDAGENTS_BUILD_NODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.IDAGENTS_BUILD_NODE;
    else process.env.IDAGENTS_BUILD_NODE = saved;
  });

  it("honors IDAGENTS_BUILD_NODE when it points at an existing binary", () => {
    process.env.IDAGENTS_BUILD_NODE = process.execPath; // guaranteed to exist
    expect(resolveManagerNode()).toBe(process.execPath);
  });

  it("ignores IDAGENTS_BUILD_NODE when the path does not exist", () => {
    process.env.IDAGENTS_BUILD_NODE = "/nonexistent/node/binary";
    const got = resolveManagerNode();
    expect(got).not.toBe("/nonexistent/node/binary");
    // Falls through to the canonical manager node or this process's node.
    expect([CANONICAL_MANAGER_NODE, process.execPath]).toContain(got);
  });

  it("always resolves to an existing executable", () => {
    delete process.env.IDAGENTS_BUILD_NODE;
    expect(existsSync(resolveManagerNode())).toBe(true);
  });
});
