// R.1 subprocess-timeout reliability (W-004 root cause): a one-shot subprocess
// invocation must NEVER hang forever — it gets an enforced OS-level timeout and
// returns a TYPED result instead of blocking the agent-server thread.

import { describe, expect, it } from "vitest";
import { runWithTimeout } from "../../src/lib/subprocess.js";

describe("runWithTimeout", () => {
  it("returns a typed success for a fast command", () => {
    const r = runWithTimeout("node", ["-e", "process.stdout.write('hi')"], { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout).toBe("hi");
  });

  it("HEADLINE: a child that exceeds the timeout returns a typed timeout failure (not a hang)", () => {
    const start = Date.now();
    const r = runWithTimeout("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 250 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("timeout");
    // It actually returned promptly — proof the OS-level kill fired.
    expect(elapsed).toBeLessThan(5000);
  });

  it("returns a typed nonzero_exit with the code", () => {
    const r = runWithTimeout("node", ["-e", "process.exit(3)"], { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("nonzero_exit");
      if (r.kind === "nonzero_exit") expect(r.code).toBe(3);
    }
  });

  it("returns a typed spawn_error for a missing binary", () => {
    const r = runWithTimeout("this-binary-does-not-exist-xyz", [], { timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("spawn_error");
  });

  it("captures stderr + stdout on a nonzero exit", () => {
    const r = runWithTimeout(
      "node",
      ["-e", "process.stderr.write('boom'); process.exit(1)"],
      { timeoutMs: 5000 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "nonzero_exit") expect(r.stderr).toContain("boom");
  });
});
