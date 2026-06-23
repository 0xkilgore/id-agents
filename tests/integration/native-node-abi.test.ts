// Acceptance (T-INFRA): the node agents are spawned under (resolveManagerNode)
// loads better-sqlite3 cleanly — no memory-only fallback — and a node with a
// MISMATCHED ABI fails with an error our detector flags as loud-fail.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveManagerNode, isAbiMismatchError } from "../../src/lib/native-node.js";

// Open better-sqlite3 in a FRESH process — the exact thing an agent does at boot.
const LOAD_SCRIPT =
  "const D=require('better-sqlite3'); const db=new D(':memory:'); db.prepare('select 1 as x').get(); process.stdout.write('OK');";

function nmvOf(node: string): string | null {
  try {
    return execFileSync(node, ["-e", "process.stdout.write(process.versions.modules)"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

describe("native ABI — agents spawn under a node that loads better-sqlite3", () => {
  it("better-sqlite3 loads cleanly under resolveManagerNode() (no memory-only)", () => {
    const node = resolveManagerNode();
    const out = execFileSync(node, ["-e", LOAD_SCRIPT], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(out).toBe("OK");
  });

  it("a node with a MISMATCHED ABI fails, and our detector flags it loud", () => {
    const managerNode = resolveManagerNode();
    const managerNmv = nmvOf(managerNode);
    // Candidate "other" nodes that commonly create the two-node split.
    const candidates = [
      "/Users/kilgore/.local/bin/node",
      "/opt/homebrew/opt/node@22/bin/node",
      "/usr/local/bin/node",
    ];
    const mismatched = candidates.find(
      (n) => existsSync(n) && nmvOf(n) !== null && nmvOf(n) !== managerNmv,
    );
    if (!mismatched) {
      // Only one node ABI on this box — the trap can't be reproduced here.
      console.warn("[native-node-abi] no second-ABI node found; skipping forced-mismatch check");
      expect(true).toBe(true);
      return;
    }
    let threw = false;
    let stderr = "";
    try {
      execFileSync(mismatched, ["-e", LOAD_SCRIPT], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
    } catch (err: any) {
      threw = true;
      stderr = String(err?.stderr ?? err?.message ?? err);
    }
    expect(threw).toBe(true);
    // The detector must classify this as a loud-fail ABI mismatch.
    expect(isAbiMismatchError(new Error(stderr))).toBe(true);
  });
});
