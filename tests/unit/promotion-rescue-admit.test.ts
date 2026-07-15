import { describe, expect, it } from "vitest";

import {
  maybeRunPromotionRescueAdmitCli,
  parsePromotionRescueArgs,
  runPromotionRescueAdmit,
  type PromotionRescueArgs,
} from "../../src/cli/promotion-rescue-admit.js";
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
      calls.push(["git", ...args]);
      const idx = queue.findIndex((c) => c.match(args, cwd));
      if (idx < 0) return { stdout: "", stderr: `unmatched: git ${args.join(" ")}`, code: 1 };
      const match = queue.splice(idx, 1)[0];
      return { stdout: match.out ?? "", stderr: match.err ?? "", code: match.code ?? 0 };
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  };
}

function gitCase(repo: string, branch: string, opts: { dirty?: string; ahead: number; behind: number }): FakeCommand[] {
  return [
    { match: (a, cwd) => cwd === repo && a[0] === "worktree", out: `worktree ${repo}\nHEAD ${branch}-tip\nbranch refs/heads/${branch}\n` },
    { match: (a, cwd) => cwd === repo && a[0] === "status", out: opts.dirty ?? "" },
    { match: (a, cwd) => cwd === repo && a[0] === "fetch" && a.includes(branch), out: "" },
    { match: (a, cwd) => cwd === repo && a[0] === "rev-parse" && a[2] === `${branch}^{commit}`, out: `${branch}-tip\n` },
    { match: (a, cwd) => cwd === repo && a[0] === "rev-parse" && a[2] === "origin/main^{commit}", out: "base-tip\n" },
    { match: (a, cwd) => cwd === repo && a[0] === "rev-list" && a[2] === `origin/main..${branch}`, out: `${opts.ahead}\n` },
    { match: (a, cwd) => cwd === repo && a[0] === "rev-list" && a[2] === `${branch}..origin/main`, out: `${opts.behind}\n` },
  ];
}

function noOriginCase(repo: string, branch: string): FakeCommand[] {
  return [
    { match: (a, cwd) => cwd === repo && a[0] === "worktree", out: `worktree ${repo}\nHEAD ${branch}-tip\nbranch refs/heads/${branch}\n` },
    { match: (a, cwd) => cwd === repo && a[0] === "status", out: "" },
    { match: (a, cwd) => cwd === repo && a[0] === "fetch" && a.includes(branch), err: "fatal: 'origin' does not appear to be a git repository\n", code: 128 },
  ];
}

const args: PromotionRescueArgs = {
  base: "main",
  remote: "origin",
  json: true,
  cases: [
    { repo: "/repo/id-agents", branch: "kg04-task-comment-routing-created-at", base: "main", remote: "origin" },
    { repo: "/repo/kapelle-site", branch: "kapelle-artifact-markdown-export", base: "main", remote: "origin" },
    { repo: "/repo/kapelle-site", branch: "kg03-visible-project-files-saved-filters", base: "main", remote: "origin" },
  ],
};

describe("promotion-rescue-admit", () => {
  it("classifies divergent, dirty, and clean promotion cases without force-push", async () => {
    const deps = fakeGitDeps([
      ...gitCase("/repo/id-agents", "kg04-task-comment-routing-created-at", { ahead: 2, behind: 6 }),
      ...gitCase("/repo/kapelle-site", "kapelle-artifact-markdown-export", { dirty: " M app/page.tsx\n", ahead: 5, behind: 0 }),
      ...gitCase("/repo/kapelle-site", "kg03-visible-project-files-saved-filters", { ahead: 1, behind: 0 }),
    ]);
    const writes: string[] = [];
    const r = await runPromotionRescueAdmit(args, deps, {
      stdout: (s) => writes.push(s),
      stderr: () => undefined,
    });

    expect(r.exit).toBe(0);
    expect(r.results.map((x) => x.branch)).toEqual([
      "kg04-task-comment-routing-created-at",
      "kapelle-artifact-markdown-export",
      "kg03-visible-project-files-saved-filters",
    ]);
    expect(r.results[0]).toMatchObject({
      decision: "route_to_worktree_hygiene_follow_up_promotion",
      ahead: 2,
      behind: 6,
      needs_input: false,
      force_push: false,
      recovery_group: "/repo/id-agents:kg04-task-comment-routing-created-at",
      recommended_owner: "worktree-hygiene",
      smoke_command: null,
      warning: expect.stringContaining("do not merge as-is"),
    });
    expect(r.results[1]).toMatchObject({
      decision: "clean_clone_cherry_pick_owned_commits_rerun_smoke_promote",
      dirty: true,
      force_push: false,
    });
    expect(r.results[2]).toMatchObject({
      decision: "promote",
      proposed_follow_up: expect.stringContaining("rerun smoke"),
      force_push: false,
    });
    expect(JSON.parse(writes.join("")).results).toHaveLength(3);
    expect(deps.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("groups repeated Spec 054 divergence by repo/branch and routes to hygiene instead of Chris", async () => {
    const groupedArgs: PromotionRescueArgs = {
      base: "main",
      remote: "origin",
      json: true,
      cases: [
        { repo: "/repo/app", branch: "feature/diverged-a", base: "main", remote: "origin" },
        { repo: "/repo/app", branch: "feature/diverged-b", base: "main", remote: "origin" },
        { repo: "/repo/no-origin", branch: "feature/no-origin", base: "main", remote: "origin" },
      ],
    };
    const deps = fakeGitDeps([
      ...gitCase("/repo/app", "feature/diverged-a", { ahead: 1, behind: 2 }),
      ...gitCase("/repo/app", "feature/diverged-b", { ahead: 3, behind: 4 }),
      ...noOriginCase("/repo/no-origin", "feature/no-origin"),
    ]);
    const writes: string[] = [];

    const r = await runPromotionRescueAdmit(groupedArgs, deps, {
      stdout: (s) => writes.push(s),
      stderr: () => undefined,
    });

    expect(r.exit).toBe(0);
    expect(r.results).toEqual([
      expect.objectContaining({
        repo: "/repo/app",
        branch: "feature/diverged-a",
        decision: "route_to_worktree_hygiene_follow_up_promotion",
        recovery_group: "/repo/app:feature/diverged-a",
        recommended_owner: "worktree-hygiene",
        smoke_command: null,
        warning: expect.stringContaining("do not merge as-is"),
        needs_input: false,
      }),
      expect.objectContaining({
        repo: "/repo/app",
        branch: "feature/diverged-b",
        decision: "route_to_worktree_hygiene_follow_up_promotion",
        recovery_group: "/repo/app:feature/diverged-b",
        recommended_owner: "worktree-hygiene",
        smoke_command: null,
        warning: expect.stringContaining("do not merge as-is"),
        needs_input: false,
      }),
      expect.objectContaining({
        repo: "/repo/no-origin",
        branch: "feature/no-origin",
        decision: "route_to_worktree_hygiene_follow_up_promotion",
        recovery_group: "/repo/no-origin:feature/no-origin",
        recommended_owner: "worktree-hygiene",
        smoke_command: null,
        warning: expect.stringContaining("do not merge as-is"),
        needs_input: false,
      }),
    ]);

    const output = JSON.parse(writes.join(""));
    expect(output.results.map((x: { recovery_group: string }) => x.recovery_group)).toEqual([
      "/repo/app:feature/diverged-a",
      "/repo/app:feature/diverged-b",
      "/repo/no-origin:feature/no-origin",
    ]);
    expect(output.results.map((x: { recommended_owner: string }) => x.recommended_owner)).toEqual([
      "worktree-hygiene",
      "worktree-hygiene",
      "worktree-hygiene",
    ]);
  });

  it("prints owner, smoke command slot, and do-not-merge-as-is warning in text output", async () => {
    const deps = fakeGitDeps([
      ...gitCase("/repo/app", "feature/diverged", { ahead: 1, behind: 2 }),
    ]);
    const writes: string[] = [];
    await runPromotionRescueAdmit({
      base: "main",
      remote: "origin",
      json: false,
      cases: [{ repo: "/repo/app", branch: "feature/diverged", base: "main", remote: "origin" }],
    }, deps, {
      stdout: (s) => writes.push(s),
      stderr: () => undefined,
    });

    expect(writes.join("")).toContain("recommended_owner: worktree-hygiene");
    expect(writes.join("")).toContain("smoke_command: <fill before follow-up promotion>");
    expect(writes.join("")).toContain("warning: do not merge as-is");
  });

  it("parses repeated --case inputs", () => {
    const parsed = parsePromotionRescueArgs([
      "--case", "/repo/a:branch-a",
      "--case", "/repo/b:branch-b",
      "--base", "trunk",
      "--remote", "upstream",
      "--json",
    ]);
    expect(parsed.json).toBe(true);
    expect(parsed.cases).toEqual([
      { repo: "/repo/a", branch: "branch-a", base: "trunk", remote: "upstream" },
      { repo: "/repo/b", branch: "branch-b", base: "trunk", remote: "upstream" },
    ]);
  });

  it("--help is routed as a one-shot CLI command", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      expect(await maybeRunPromotionRescueAdmitCli(["promotion-rescue-admit", "--help"])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    expect(writes.join("")).toContain("promotion-rescue-admit");
    expect(writes.join("")).toContain("force_push=false");
    expect(writes.join("")).toContain("recommended owner");
  });
});
