import { describe, expect, it } from "vitest";
import {
  maybeRunPromoteScopedCommitCli,
  parsePromoteScopedCommitArgs,
  PROMOTE_SCOPED_COMMIT_USAGE,
  PromoteScopedCommitArgError,
  runPromoteScopedCommit,
  type PromoteScopedCommitArgs,
} from "../../src/cli/promote-scoped-commit.js";
import type { GitDeps } from "../../src/cli/promote-to-main.js";

interface FakeCommand {
  match: (args: string[], cwd: string) => boolean;
  out?: string;
  err?: string;
  code?: number;
}

function fakeGitDeps(commands: FakeCommand[]): GitDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...commands];
  return {
    calls,
    git: async (args: string[], cwd: string) => {
      calls.push(["git", cwd, ...args]);
      const idx = queue.findIndex((c) => c.match(args, cwd));
      if (idx < 0) {
        return { stdout: "", stderr: `unmatched: git -C ${cwd} ${args.join(" ")}`, code: 1 };
      }
      const match = queue.splice(idx, 1)[0];
      return { stdout: match.out ?? "", stderr: match.err ?? "", code: match.code ?? 0 };
    },
    exec: async (cmd: string, cwd: string) => {
      calls.push(["exec", cwd, cmd]);
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

const args: PromoteScopedCommitArgs = {
  repo: "/src/repo",
  commit: "abc123",
  cleanBranch: "scoped-promotion/abc123",
  workdir: "/tmp/clean-promo",
  base: "main",
  remote: "origin",
  dispatchId: "phid:disp-abc",
  agent: "roger",
  smoke: "npm test -- tests/unit/foo.test.ts",
  execute: true,
  json: true,
};

function happyPathCommands() {
  const resolved = "abc1234567890abcdef";
  return [
    { match: (a: string[], cwd: string) => cwd === "/src/repo" && a[0] === "rev-parse", out: `${resolved}\n` },
    { match: (a: string[], cwd: string) => cwd === "/src/repo" && a[0] === "rev-list" && a[1] === "--parents", out: `${resolved} parent123\n` },
    { match: (a: string[], cwd: string) => cwd === "/src/repo" && a[0] === "config" && a[2] === "remote.origin.url", out: "git@github.com:example/id-agents.git\n" },
    { match: (a: string[], cwd: string) => cwd === "/src/repo" && a[0] === "clone", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "remote" && a[1] === "set-url", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "fetch" && a[1] === "origin", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "checkout" && a[1] === "-B", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "fetch" && a[1] === "/src/repo", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "cherry-pick", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-list" && a[1] === "--count", out: "1\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "log" && a[1] === "-1", out: `fix\n\n(cherry picked from commit ${resolved})\n` },
    // promote-to-main starts here, operating only in the clean clone.
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "status", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "fetch" && a[1] === "origin", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-parse" && a[1] === "scoped-promotion/abc123", out: "cleanbranchsha\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-parse" && a[1] === "origin/main", out: "basetip\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-list" && a.includes("origin/main..scoped-promotion/abc123"), out: "1\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-list" && a.includes("scoped-promotion/abc123..origin/main"), out: "0\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "log" && a[1] === "--format=%s", out: "fix\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "checkout" && a[1] === "main", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "merge" && a[1] === "--ff-only" && a[2] === "origin/main", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "merge" && a[1] === "--ff-only" && a[2] === "scoped-promotion/abc123", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-parse" && a[1] === "main", out: "cleanbranchsha\n" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "push" && a[1] === "origin" && a[2] === "main", out: "" },
    { match: (a: string[], cwd: string) => cwd === "/tmp/clean-promo" && a[0] === "rev-parse" && a[1] === "origin/main", out: "cleanbranchsha\n" },
  ];
}

describe("parsePromoteScopedCommitArgs", () => {
  it("parses required args and defaults", () => {
    const r = parsePromoteScopedCommitArgs(["--repo", "/r", "--commit", "abc", "--smoke", "npm test"]);
    expect(r).toMatchObject({
      repo: "/r",
      commit: "abc",
      base: "main",
      remote: "origin",
      smoke: "npm test",
      execute: false,
      json: false,
    });
  });

  it("requires repo, commit, and smoke", () => {
    expect(() => parsePromoteScopedCommitArgs(["--commit", "abc", "--smoke", "npm test"])).toThrow(/--repo/);
    expect(() => parsePromoteScopedCommitArgs(["--repo", "/r", "--smoke", "npm test"])).toThrow(/--commit/);
    expect(() => parsePromoteScopedCommitArgs(["--repo", "/r", "--commit", "abc"])).toThrow(/--smoke/);
  });

  it("rejects a clean branch equal to base", () => {
    expect(() => parsePromoteScopedCommitArgs([
      "--repo", "/r", "--commit", "abc", "--smoke", "npm test", "--clean-branch", "main",
    ])).toThrow(PromoteScopedCommitArgError);
  });
});

describe("maybeRunPromoteScopedCommitCli", () => {
  it("returns null for other subcommands", async () => {
    expect(await maybeRunPromoteScopedCommitCli(["promote-to-main", "--help"])).toBeNull();
  });

  it("prints help", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(String(s));
      return true;
    };
    try {
      expect(await maybeRunPromoteScopedCommitCli(["promote-scoped-commit", "--help"])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    expect(writes.join("")).toContain("promote-scoped-commit");
    expect(PROMOTE_SCOPED_COMMIT_USAGE).toContain("never force-pushes");
  });
});

describe("runPromoteScopedCommit", () => {
  it("preflight resolves the commit but does not clone, cherry-pick, smoke, or push", async () => {
    const deps = fakeGitDeps([
      { match: (a, cwd) => cwd === "/src/repo" && a[0] === "rev-parse", out: "abc1234567890abcdef\n" },
      { match: (a, cwd) => cwd === "/src/repo" && a[0] === "rev-list" && a[1] === "--parents", out: "abc1234567890abcdef parent123\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteScopedCommit({ ...args, execute: false }, deps, io);
    expect(r.exit).toBe(0);
    expect(io.outText()).toMatch(/"preflight": true/);
    expect(deps.calls.some((c) => c[0] === "git" && c[3] === "clone")).toBe(false);
    expect(deps.calls.some((c) => c[0] === "exec")).toBe(false);
  });

  it("builds a clean clone, smokes it, then delegates promotion to promote-to-main JSON path", async () => {
    const deps = fakeGitDeps(happyPathCommands());
    const io = captureIo();
    const r = await runPromoteScopedCommit(args, deps, io);
    expect(r.exit).toBe(0);
    expect(r.result).toMatchObject({
      source_repo: "/src/repo",
      workdir: "/tmp/clean-promo",
      clean_branch: "scoped-promotion/abc123",
      smoke: { exit_code: 0, gate: "passed" },
      promotion: { pushed: true, verified: true, strategy: "fast_forward" },
    });
    expect(deps.calls).toContainEqual(["git", "/src/repo", "clone", "--no-local", "/src/repo", "/tmp/clean-promo"]);
    expect(deps.calls).toContainEqual(["git", "/tmp/clean-promo", "remote", "set-url", "origin", "git@github.com:example/id-agents.git"]);
    expect(deps.calls).toContainEqual(["git", "/tmp/clean-promo", "cherry-pick", "-x", "FETCH_HEAD"]);
    expect(deps.calls).toContainEqual(["exec", "/tmp/clean-promo", "npm test -- tests/unit/foo.test.ts"]);
    expect(deps.calls).toContainEqual(["git", "/tmp/clean-promo", "push", "origin", "main"]);
  });

  it("refuses unrelated commit promotion when the clean branch has more than one ahead commit", async () => {
    const commands = happyPathCommands();
    const ahead = commands.find((c) => c.match(["rev-list", "--count", "origin/main..scoped-promotion/abc123"], "/tmp/clean-promo"));
    if (ahead) ahead.out = "2\n";
    const deps = fakeGitDeps(commands);
    const io = captureIo();
    const r = await runPromoteScopedCommit(args, deps, io);
    expect(r.exit).toBe(9);
    expect(io.errText()).toMatch(/refusing unrelated commit promotion/);
    expect(deps.calls.some((c) => c[0] === "git" && c[3] === "push")).toBe(false);
  });

  it("rejects merge commits as non-scoped fixes", async () => {
    const deps = fakeGitDeps([
      { match: (a, cwd) => cwd === "/src/repo" && a[0] === "rev-parse", out: "abc1234567890abcdef\n" },
      { match: (a, cwd) => cwd === "/src/repo" && a[0] === "rev-list" && a[1] === "--parents", out: "abc1234567890abcdef p1 p2\n" },
    ]);
    const io = captureIo();
    const r = await runPromoteScopedCommit(args, deps, io);
    expect(r.exit).toBe(3);
    expect(io.errText()).toMatch(/single-parent scoped fix commit/);
  });
});
