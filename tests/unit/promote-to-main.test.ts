// Spec 054 v2 Part 2 Step 9 - promote-to-main CLI helper tests.
//
// Covers:
//   - parsePromoteArgs (defaults, required fields, validation)
//   - pickAutoStrategy (FF when clean ahead, squash on autocommit noise,
//     merge_commit when behind != 0)
//   - hasAutocommitNoise / isAutocommitMessage / countAutocommitNoise
//   - buildSquashCommitBody (includes source branch + tip + verification + dispatch)
//   - runPromoteToMain via injected GitDeps:
//     - preflight is read-only (no execute git mutations)
//     - dirty working tree refuses execute
//     - fast-forward case produces correct SHA + JSON output
//     - squash case calls git merge --squash + commit with templated body
//     - push-verify failure (remote SHA mismatch) returns non-zero exit
//     - divergent ancestry pauses with /agent-needs-input payload

import { describe, it, expect } from "vitest";
import {
  parsePromoteArgs,
  pickAutoStrategy,
  hasAutocommitNoise,
  isAutocommitMessage,
  countAutocommitNoise,
  buildSquashCommitBody,
  runPromoteToMain,
  maybeRunPromoteToMainCli,
  PROMOTE_USAGE,
  PromoteArgError,
  type GitDeps,
  type PromoteArgs,
} from "../../src/cli/promote-to-main.js";

// ────────────────────────────────────────────────────────────────────
// FakeGit — records every command + replays from a scripted table.
// ────────────────────────────────────────────────────────────────────

interface FakeCommand {
  match: (args: string[]) => boolean;
  out?: string;
  err?: string;
  code?: number;
}

// Queue-style fake: matchers are consumed in order. The first matcher
// that fits gets used and is removed from the queue, so repeated calls
// for the same args can return different scripted responses. Unmatched
// calls return a non-zero result so failures surface clearly.
function fakeGitDeps(commands: FakeCommand[]): GitDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...commands];
  return {
    calls,
    git: async (args: string[]) => {
      calls.push(["git", ...args]);
      const idx = queue.findIndex((c) => c.match(args));
      if (idx < 0) {
        return { stdout: "", stderr: `unmatched: git ${args.join(" ")}`, code: 1 };
      }
      const match = queue.splice(idx, 1)[0];
      return { stdout: match.out ?? "", stderr: match.err ?? "", code: match.code ?? 0 };
    },
    exec: async (cmd: string) => {
      calls.push(["exec", cmd]);
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

function captureIo() {
  const out: string[] = [], err: string[] = [];
  return {
    stdout: (s: string) => { out.push(s); },
    stderr: (s: string) => { err.push(s); },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

const baseArgs: PromoteArgs = {
  repo: "/abs/repo",
  branch: "feat-x",
  base: "main",
  remote: "origin",
  strategy: "auto",
  dispatchId: "phid:disp-abc",
  agent: null,
  smoke: null,
  smokeExempt: [],
  execute: false,
  allowOwnDirty: [],
  json: true,
};

// FF execute git sequence (reused by the smoke-exempt cases). Smoke runs
// between the promoted-sha rev-parse and the push.
function ffExecuteCommands() {
  return [
    { match: (a: string[]) => a[0] === "status", out: "" },
    { match: (a: string[]) => a[0] === "fetch", out: "" },
    { match: (a: string[]) => a[0] === "rev-parse" && a[1] === "feat-x", out: "abc1234\n" },
    { match: (a: string[]) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" }, // RD-013: baseTip = REMOTE base (Step-3, consumed first)
    { match: (a: string[]) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" },
    { match: (a: string[]) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
    { match: (a: string[]) => a[0] === "log", out: "fix\n" },
    { match: (a: string[]) => a[0] === "checkout" && a[1] === "main", out: "" },
    { match: (a: string[]) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
    { match: (a: string[]) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "feat-x", out: "" },
    { match: (a: string[]) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "abc1234\n" },
    { match: (a: string[]) => a[0] === "push" && a[1] === "origin" && a[2] === "main", out: "" },
    { match: (a: string[]) => a[0] === "rev-parse" && a[1] === "origin/main", out: "abc1234\n" },
  ];
}

// fakeGitDeps with a scripted --smoke exec result.
function depsWithSmoke(
  commands: FakeCommand[],
  smoke: { code: number; stdout?: string; stderr?: string },
): GitDeps & { calls: string[][] } {
  const d = fakeGitDeps(commands);
  d.exec = async (cmd: string) => {
    d.calls.push(["exec", cmd]);
    return { stdout: smoke.stdout ?? "", stderr: smoke.stderr ?? "", code: smoke.code };
  };
  return d;
}

const SMOKE_RED_CHECKIN = `
 ❯ tests/unit/checkin-service-integration.test.ts (5 tests | 1 failed)
 FAIL  tests/unit/checkin-service-integration.test.ts > flushes
 Test Files  1 failed | 40 passed (41)
`;

describe("runPromoteToMain — T-QA.7 --smoke-exempt trap fix", () => {
  it("proceeds when a red smoke's ONLY failing file is exempt (gate downgraded, operator-visible)", async () => {
    const deps = depsWithSmoke(ffExecuteCommands(), { code: 1, stdout: SMOKE_RED_CHECKIN });
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, smoke: "npm test", smokeExempt: ["**/checkin-service-integration.test.ts"] },
      deps, io,
    );
    expect(r.exit).toBe(0);
    expect(r.result?.pushed).toBe(true);
    expect(r.result?.smoke).toMatchObject({
      exit_code: 1,
      gate: "passed_with_exempt_failures",
      exempt_failures: ["tests/unit/checkin-service-integration.test.ts"],
    });
    // it DID push despite the red smoke
    expect(deps.calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(true);
  });

  it("aborts (exit 9, no push) when a NON-exempt test also failed", async () => {
    const out = SMOKE_RED_CHECKIN + "\n FAIL  tests/unit/gateway-eval-recommend.test.ts > x\n";
    const deps = depsWithSmoke(ffExecuteCommands(), { code: 1, stdout: out });
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, smoke: "npm test", smokeExempt: ["**/checkin-service-integration.test.ts"] },
      deps, io,
    );
    expect(r.exit).toBe(9);
    expect(r.result).toBeNull();
    expect(deps.calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false);
    expect(io.errText()).toMatch(/did not cover.*gateway-eval-recommend/);
  });

  it("with NO --smoke-exempt, a red smoke aborts exactly as before (exit 9) — reversibility", async () => {
    const deps = depsWithSmoke(ffExecuteCommands(), { code: 1, stdout: SMOKE_RED_CHECKIN });
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, smoke: "npm test", smokeExempt: [] },
      deps, io,
    );
    expect(r.exit).toBe(9);
    expect(r.result).toBeNull();
    expect(deps.calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false);
  });

  it("a green smoke records gate=passed", async () => {
    const deps = depsWithSmoke(ffExecuteCommands(), { code: 0 });
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: true, smoke: "npm test" }, deps, io);
    expect(r.exit).toBe(0);
    expect(r.result?.smoke).toMatchObject({ exit_code: 0, gate: "passed" });
  });
});

// ────────────────────────────────────────────────────────────────────
// maybeRunPromoteToMainCli — dispatch routing + --help
// ────────────────────────────────────────────────────────────────────

describe("maybeRunPromoteToMainCli", () => {
  it("returns null for a non-promote subcommand (lets the CLI route elsewhere)", async () => {
    expect(await maybeRunPromoteToMainCli(["comments", "roger"])).toBeNull();
  });

  it("--help prints usage and exits 0 (acceptance probe must run, not error)", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(String(s));
      return true;
    };
    let exit: number | null;
    try {
      exit = await maybeRunPromoteToMainCli(["promote-to-main", "--help"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(exit).toBe(0);
    expect(writes.join("")).toContain("id-agents promote-to-main");
    expect(writes.join("")).toContain("--execute");
    expect(PROMOTE_USAGE).toContain("Read-only by default");
  });

  it("-h is an alias for --help", async () => {
    const orig = process.stdout.write;
    (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
    let exit: number | null;
    try {
      exit = await maybeRunPromoteToMainCli(["promote-to-main", "-h"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(exit).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// parsePromoteArgs
// ────────────────────────────────────────────────────────────────────

describe("parsePromoteArgs", () => {
  it("parses the minimal valid argv", () => {
    const r = parsePromoteArgs(["--repo", "/r", "--branch", "feat"]);
    expect(r).toMatchObject({
      repo: "/r", branch: "feat", base: "main", remote: "origin",
      strategy: "auto", dispatchId: null, smoke: null, execute: false, json: false,
    });
  });
  it("--execute and --json are boolean flags", () => {
    const r = parsePromoteArgs(["--repo", "/r", "--branch", "f", "--execute", "--json"]);
    expect(r.execute).toBe(true);
    expect(r.json).toBe(true);
  });
  it("--smoke takes a string", () => {
    const r = parsePromoteArgs(["--repo", "/r", "--branch", "f", "--smoke", "npm test"]);
    expect(r.smoke).toBe("npm test");
  });
  it("--smoke-exempt is repeatable + comma-separated (default [])", () => {
    expect(parsePromoteArgs(["--repo", "/r", "--branch", "f"]).smokeExempt).toEqual([]);
    const r = parsePromoteArgs([
      "--repo", "/r", "--branch", "f",
      "--smoke-exempt", "a.test.ts,b.test.ts",
      "--smoke-exempt", "**/c.test.ts",
    ]);
    expect(r.smokeExempt).toEqual(["a.test.ts", "b.test.ts", "**/c.test.ts"]);
  });
  it("--agent takes the attributed agent name (default null)", () => {
    expect(parsePromoteArgs(["--repo", "/r", "--branch", "f"]).agent).toBeNull();
    const r = parsePromoteArgs(["--repo", "/r", "--branch", "f", "--agent", "hopper"]);
    expect(r.agent).toBe("hopper");
  });
  it("--allow-own-dirty splits on comma", () => {
    const r = parsePromoteArgs(["--repo", "/r", "--branch", "f", "--allow-own-dirty", "a.ts,b.ts"]);
    expect(r.allowOwnDirty).toEqual(["a.ts", "b.ts"]);
  });
  it("--strategy validates against the union", () => {
    expect(() => parsePromoteArgs(["--repo", "/r", "--branch", "f", "--strategy", "rebase"]))
      .toThrow(PromoteArgError);
  });
  it("rejects unknown flags", () => {
    expect(() => parsePromoteArgs(["--repo", "/r", "--branch", "f", "--bogus"]))
      .toThrow(/unknown flag/);
  });
  it("requires --repo and --branch", () => {
    expect(() => parsePromoteArgs(["--branch", "f"])).toThrow(/--repo is required/);
    expect(() => parsePromoteArgs(["--repo", "/r"])).toThrow(/--branch is required/);
  });
});

// ────────────────────────────────────────────────────────────────────
// pure helpers
// ────────────────────────────────────────────────────────────────────

describe("isAutocommitMessage", () => {
  it("matches data.json refresh and friends", () => {
    expect(isAutocommitMessage("data.json refresh 2026-05-22 16:14")).toBe(true);
    expect(isAutocommitMessage("workspace artifacts refresh 2026-05-23")).toBe(true);
    expect(isAutocommitMessage("autocommit: idle")).toBe(true);
    expect(isAutocommitMessage("auto-save")).toBe(true);
  });
  it("does NOT match normal commit messages", () => {
    expect(isAutocommitMessage("Spec 054 v2 Part 2 Step 8")).toBe(false);
    expect(isAutocommitMessage("Refresh the README")).toBe(false); // no auto/data prefix
  });
});

describe("hasAutocommitNoise", () => {
  it("returns true when >=50% of messages are autocommits", () => {
    expect(hasAutocommitNoise(["data.json refresh", "data.json refresh", "real fix"])).toBe(true);
  });
  it("returns false when <50%", () => {
    expect(hasAutocommitNoise(["real fix", "another fix", "data.json refresh"])).toBe(false);
  });
  it("returns false on empty input", () => {
    expect(hasAutocommitNoise([])).toBe(false);
  });
});

describe("countAutocommitNoise", () => {
  it("counts only autocommit-shaped messages", () => {
    expect(countAutocommitNoise(["a", "data.json refresh", "b", "autocommit"])).toBe(2);
  });
});

describe("pickAutoStrategy", () => {
  it("FF when behind==0 and clean", () => {
    expect(pickAutoStrategy({ ahead: 4, behind: 0, branchTip: "a", baseTip: "b", hasAutocommitNoise: false }))
      .toBe("fast_forward");
  });
  it("squash when behind==0 but autocommit-noisy", () => {
    expect(pickAutoStrategy({ ahead: 200, behind: 0, branchTip: "a", baseTip: "b", hasAutocommitNoise: true }))
      .toBe("squash");
  });
  it("merge_commit when behind != 0", () => {
    expect(pickAutoStrategy({ ahead: 4, behind: 2, branchTip: "a", baseTip: "b", hasAutocommitNoise: false }))
      .toBe("merge_commit");
  });
});

describe("buildSquashCommitBody", () => {
  it("includes all required spec fields when supplied", () => {
    const body = buildSquashCommitBody({
      featureName: "feat-x",
      branch: "feat-x",
      sourceTip: "abc1234",
      verification: "npm test",
      dispatchId: "phid:disp-zzz",
    });
    expect(body).toContain("Promote feat-x");
    expect(body).toContain("Source branch: feat-x");
    expect(body).toContain("Source tip: abc1234");
    expect(body).toContain("Verification: npm test");
    expect(body).toContain("Dispatch: phid:disp-zzz");
  });
  it("omits optional fields cleanly", () => {
    const body = buildSquashCommitBody({
      featureName: "f", branch: "f", sourceTip: "x", verification: null, dispatchId: null,
    });
    expect(body).not.toMatch(/Verification:/);
    expect(body).not.toMatch(/Dispatch:/);
  });
  it("appends an Agent trailer when an agent is supplied", () => {
    const body = buildSquashCommitBody({
      featureName: "feat-x", branch: "feat-x", sourceTip: "abc1234",
      verification: null, dispatchId: null, agent: "hopper",
    });
    expect(body).toMatch(/^Agent: hopper$/m);
  });
  it("omits the Agent trailer when no agent is supplied", () => {
    const body = buildSquashCommitBody({
      featureName: "f", branch: "f", sourceTip: "x", verification: null, dispatchId: null,
    });
    expect(body).not.toMatch(/Agent:/);
  });
});

// ────────────────────────────────────────────────────────────────────
// runPromoteToMain
// ────────────────────────────────────────────────────────────────────

describe("runPromoteToMain — preflight (default)", () => {
  it("is read-only: never calls execute-mutating git commands", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },                            // clean
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "branchtip\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "3\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "real fix\nanother fix\nmore fix\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: false }, deps, io);
    expect(r.exit).toBe(0);
    expect(r.result?.preflight).toBe(true);

    // Mutation-class commands MUST NOT be called in preflight mode.
    for (const call of deps.calls) {
      expect(call[0] === "git" && (call[1] === "checkout" || call[1] === "merge" || call[1] === "commit" || call[1] === "push"))
        .toBe(false);
    }
  });

  it("emits JSON output with --json", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "branchtip\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "3\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "fix\nfix\nfix\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: false, json: true }, deps, io);
    expect(r.exit).toBe(0);
    const out = io.outText();
    expect(out).toMatch(/"strategy": "fast_forward"/);
    expect(out).toMatch(/"preflight": true/);
  });
});

describe("runPromoteToMain — dirty working tree", () => {
  it("with --execute and unapproved dirty paths returns non-zero", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: " M src/foo.ts\n?? scratch.md\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, allowOwnDirty: ["src/foo.ts"] }, // scratch.md NOT whitelisted
      deps, io,
    );
    expect(r.exit).toBe(3);
    expect(io.errText()).toMatch(/unapproved dirty paths/);
    // Did NOT proceed to checkout/merge/etc.
    for (const call of deps.calls) {
      expect(call[0] === "git" && call[1] === "checkout").toBe(false);
    }
  });

  it("preflight tolerates dirty working tree (no error)", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: " M unrelated.ts\n" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "branchtip\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "fix\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: false }, deps, io);
    expect(r.exit).toBe(0);
  });
});

describe("runPromoteToMain — divergent ancestry", () => {
  it("ahead>0 AND behind>0 prints /agent-needs-input payload + exits non-zero", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "branchtip\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "3\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "2\n" }, // diverged!
      { match: (a) => a[0] === "log", out: "fix\nfix\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: false }, deps, io);
    expect(r.exit).toBe(10);
    expect(r.needsClarification).toBeDefined();
    expect(r.needsClarification?.agent_id).toBe("promote-to-main");
    expect(r.needsClarification?.question).toMatch(/diverged/);
    expect(io.errText()).toMatch(/diverged from main/);
  });
});

describe("runPromoteToMain — explicit fast_forward refuses when behind != 0", () => {
  it("returns non-zero with a clear error", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "branchtip\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "1\n" },
      { match: (a) => a[0] === "log", out: "fix\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, strategy: "fast_forward", execute: true },
      deps, io,
    );
    expect(r.exit).toBe(6);
    expect(io.errText()).toMatch(/fast_forward.*refusing/);
  });
});

describe("runPromoteToMain — execute fast-forward path", () => {
  it("runs the full pipeline + verifies remote SHA matches", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "abc1234\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "fix\n" },
      // execute path:
      { match: (a) => a[0] === "checkout" && a[1] === "main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "feat-x", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "abc1234\n" }, // promoted_sha
      { match: (a) => a[0] === "push" && a[1] === "origin" && a[2] === "main", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "abc1234\n" }, // remote matches
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: true }, deps, io);
    expect(r.exit).toBe(0);
    expect(r.result).toMatchObject({
      strategy: "fast_forward",
      promoted_sha: "abc1234",
      remote_main_sha: "abc1234",
      pushed: true,
      verified: true,
    });
  });

  it("post-push remote SHA mismatch returns non-zero exit", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "abc1234\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "fix\n" },
      { match: (a) => a[0] === "checkout", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "feat-x", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "abc1234\n" },
      { match: (a) => a[0] === "push", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "DIFFERENT\n" }, // mismatch!
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, execute: true }, deps, io);
    expect(r.exit).toBe(12);
    expect(r.result?.verified).toBe(false);
  });
});

describe("runPromoteToMain — execute squash path", () => {
  it("calls git merge --squash + commit with templated body", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "src1234\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "100\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "data.json refresh\ndata.json refresh\ndata.json refresh\nreal fix\n" },
      { match: (a) => a[0] === "checkout", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--squash", out: "" },
      { match: (a) => a[0] === "commit" && a[1] === "-m", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "post-squash-sha\n" },
      { match: (a) => a[0] === "push", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "post-squash-sha\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, strategy: "auto", smoke: "npm test" },
      deps, io,
    );
    expect(r.exit).toBe(0);
    expect(r.result?.strategy).toBe("squash");

    // Find the commit call + verify the message body has the spec fields.
    const commitCall = deps.calls.find((c) => c[0] === "git" && c[1] === "commit" && c[2] === "-m");
    expect(commitCall).toBeDefined();
    const body = commitCall![3];
    expect(body).toContain("Source branch: feat-x");
    expect(body).toContain("Source tip: src1234");
    expect(body).toContain("Verification: npm test");
    expect(body).toContain("Dispatch: phid:disp-abc");
  });
});

describe("runPromoteToMain — Agent trailer in promotion commits", () => {
  it("squash body carries the Agent trailer when --agent is set", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "src1234\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "100\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "data.json refresh\ndata.json refresh\ndata.json refresh\nreal fix\n" },
      { match: (a) => a[0] === "checkout", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--squash", out: "" },
      { match: (a) => a[0] === "commit" && a[1] === "-m", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "post-squash-sha\n" },
      { match: (a) => a[0] === "push", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "post-squash-sha\n" },
    ]);
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, strategy: "auto", agent: "hopper" }, deps, captureIo(),
    );
    expect(r.exit).toBe(0);
    const commitCall = deps.calls.find((c) => c[1] === "commit" && c[2] === "-m");
    expect(commitCall![3]).toMatch(/^Agent: hopper$/m);
  });

  it("merge_commit message carries the Agent trailer when --agent is set", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "src1234\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "3\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "real fix\n" },
      { match: (a) => a[0] === "checkout", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--no-ff", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "merge-sha\n" },
      { match: (a) => a[0] === "push", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "merge-sha\n" },
    ]);
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, strategy: "merge_commit", agent: "hopper" }, deps, captureIo(),
    );
    expect(r.exit).toBe(0);
    const mergeCall = deps.calls.find((c) => c[1] === "merge" && c[2] === "--no-ff");
    // -m value is the arg right after "-m"
    const mIdx = mergeCall!.indexOf("-m");
    expect(mergeCall![mIdx + 1]).toMatch(/^Agent: hopper$/m);
  });
});

describe("runPromoteToMain — smoke command failure aborts push", () => {
  it("returns non-zero with smoke command output", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "abc\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "def\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "fix\n" },
      { match: (a) => a[0] === "checkout", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
      { match: (a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === "feat-x", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "abc\n" },
    ]);
    // Replace exec to simulate smoke failure:
    const origExec = deps.exec;
    deps.exec = async (cmd) => {
      deps.calls.push(["exec", cmd]);
      return { stdout: "FAILED", stderr: "1 test failed", code: 1 };
    };
    const io = captureIo();
    const r = await runPromoteToMain(
      { ...baseArgs, execute: true, smoke: "npm test" },
      deps, io,
    );
    expect(r.exit).toBe(9);
    expect(io.errText()).toMatch(/smoke command failed/);
    // Did NOT push.
    expect(deps.calls.find((c) => c[0] === "git" && c[1] === "push")).toBeUndefined();
    void origExec;
  });
});

describe("runPromoteToMain — RD-013: strategy/divergence measured against origin base, not stale local base", () => {
  it("a branch behind origin/main (origin advanced) is detected DIVERGENT — not falsely fast-forwardable off a stale local base", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "branchtip\n" },
      // MUST resolve the base tip from the freshly-fetched origin/main, not local main.
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "remote-tip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "1\n" }, // ahead of remote
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "2\n" }, // BEHIND remote (origin advanced)
      { match: (a) => a[0] === "log", out: "feat\n" },
      // decoy: a STALE local main would report behind=0; if the tool used it, it'd FF.
      { match: (a) => a[0] === "rev-parse" && a[1] === "main" && a.length === 2, out: "stale-local\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs, dispatchId: "phid:disp-x" }, deps, io);

    expect(r.exit).toBe(10); // divergent → /agent-needs-input, NOT a silent FF on a stale base
    expect(r.needsClarification).toBeTruthy();
    // proves the decision used origin/main, and never touched the stale local main
    expect(deps.calls.some((c) => c[1] === "rev-parse" && c[2] === "origin/main")).toBe(true);
    expect(deps.calls.some((c) => c[1] === "rev-parse" && c[2] === "main")).toBe(false);
  });

  it("a branch cleanly ahead of origin/main (local base stale-behind) still fast-forwards", async () => {
    const deps = fakeGitDeps([
      { match: (a) => a[0] === "status", out: "" },
      { match: (a) => a[0] === "fetch", out: "" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "feat-x", out: "aaa\n" },
      { match: (a) => a[0] === "rev-parse" && a[1] === "origin/main", out: "remote-tip\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("origin/main..feat-x"), out: "2\n" },
      { match: (a) => a[0] === "rev-list" && a.includes("feat-x..origin/main"), out: "0\n" },
      { match: (a) => a[0] === "log", out: "feat\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteToMain({ ...baseArgs }, deps, io); // preflight
    expect(r.exit).toBe(0);
    expect(r.result?.strategy).toBe("fast_forward");
    expect(r.result?.remote_main_sha).toBe("remote-tip");
  });
});
