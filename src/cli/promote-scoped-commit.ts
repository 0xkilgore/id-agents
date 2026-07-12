// `id-agents promote-scoped-commit` — narrow Spec 054 helper for dirty/divergent branches.
//
// Use when the desired fix is one named commit on a branch that also contains
// unrelated ahead commits or dirty worktree state. This helper builds a clean
// temporary clone from origin/main, cherry-picks only the named commit, runs the
// required smoke, then delegates the final merge/push verification to
// promote-to-main.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultGitDeps,
  parsePromoteArgs,
  PromoteArgError,
  runPromoteToMain,
  type GitDeps,
  type PromoteResult,
} from "./promote-to-main.js";

export interface PromoteScopedCommitArgs {
  repo: string;
  commit: string;
  cleanBranch: string | null;
  workdir: string | null;
  base: string;
  remote: string;
  dispatchId: string | null;
  agent: string | null;
  smoke: string;
  execute: boolean;
  json: boolean;
}

export interface PromoteScopedCommitResult {
  source_repo: string;
  workdir: string;
  base: string;
  remote: string;
  requested_commit: string;
  resolved_commit: string;
  clean_branch: string;
  smoke: { command: string; exit_code: number; gate: "passed" };
  promotion: PromoteResult;
  summary: string;
}

const KNOWN_SCOPED_FLAGS = new Set([
  "--repo", "--commit", "--clean-branch", "--workdir", "--base", "--remote",
  "--dispatch-id", "--agent", "--smoke", "--execute", "--json",
]);

export class PromoteScopedCommitArgError extends Error {}

export function parsePromoteScopedCommitArgs(argv: string[]): PromoteScopedCommitArgs {
  let repo = "";
  let commit = "";
  let cleanBranch: string | null = null;
  let workdir: string | null = null;
  let base = "main";
  let remote = "origin";
  let dispatchId: string | null = null;
  let agent: string | null = null;
  let smoke = "";
  let execute = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) {
      throw new PromoteScopedCommitArgError(`unexpected positional arg: ${flag}`);
    }
    if (!KNOWN_SCOPED_FLAGS.has(flag)) {
      throw new PromoteScopedCommitArgError(`unknown flag: ${flag}`);
    }
    if (flag === "--execute") { execute = true; continue; }
    if (flag === "--json") { json = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new PromoteScopedCommitArgError(`${flag} requires a value`);
    switch (flag) {
      case "--repo": repo = val; break;
      case "--commit": commit = val; break;
      case "--clean-branch": cleanBranch = val; break;
      case "--workdir": workdir = val; break;
      case "--base": base = val; break;
      case "--remote": remote = val; break;
      case "--dispatch-id": dispatchId = val; break;
      case "--agent": agent = val; break;
      case "--smoke": smoke = val; break;
    }
  }

  if (!repo) throw new PromoteScopedCommitArgError("--repo is required");
  if (!commit) throw new PromoteScopedCommitArgError("--commit is required");
  if (!smoke) throw new PromoteScopedCommitArgError("--smoke is required");
  if (cleanBranch && cleanBranch === base) {
    throw new PromoteScopedCommitArgError("--clean-branch must not equal --base");
  }
  return { repo, commit, cleanBranch, workdir, base, remote, dispatchId, agent, smoke, execute, json };
}

export async function runPromoteScopedCommit(
  args: PromoteScopedCommitArgs,
  deps: GitDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<{ exit: number; result: PromoteScopedCommitResult | null }> {
  const commitOut = await deps.git(["rev-parse", "--verify", `${args.commit}^{commit}`], args.repo);
  if (commitOut.code !== 0 || !commitOut.stdout.trim()) {
    io.stderr(`cannot resolve commit ${args.commit}: ${commitOut.stderr}\n`);
    return { exit: 2, result: null };
  }
  const resolvedCommit = commitOut.stdout.trim();

  const parentsOut = await deps.git(["rev-list", "--parents", "-n", "1", resolvedCommit], args.repo);
  if (parentsOut.code !== 0) {
    io.stderr(`cannot inspect commit parents for ${resolvedCommit}: ${parentsOut.stderr}\n`);
    return { exit: 2, result: null };
  }
  const parentFields = parentsOut.stdout.trim().split(/\s+/).filter(Boolean);
  if (parentFields.length !== 2) {
    io.stderr(`commit ${resolvedCommit} is not a single-parent scoped fix commit; refusing\n`);
    return { exit: 3, result: null };
  }

  const short = resolvedCommit.slice(0, 12);
  const cleanBranch = args.cleanBranch ?? `scoped-promotion/${short}`;
  const workdir = args.workdir ?? join(tmpdir(), `id-agents-promote-scoped-${short}-${Date.now()}`);
  const cleanupWorkdir = args.workdir === null;
  if (cleanBranch === args.base) {
    io.stderr(`clean branch ${cleanBranch} must not equal base ${args.base}\n`);
    return { exit: 64, result: null };
  }

  if (!args.execute) {
    const summary = `would clone ${args.repo} to ${workdir}, create ${cleanBranch} from ${args.remote}/${args.base}, cherry-pick ${resolvedCommit}, smoke, then promote`;
    io.stdout(args.json ? JSON.stringify({
      source_repo: args.repo,
      workdir,
      base: args.base,
      remote: args.remote,
      requested_commit: args.commit,
      resolved_commit: resolvedCommit,
      clean_branch: cleanBranch,
      preflight: true,
      summary,
    }, null, 2) + "\n" : `[preflight] ${summary}\n`);
    return { exit: 0, result: null };
  }

  try {
    const remoteUrlOut = await deps.git(["config", "--get", `remote.${args.remote}.url`], args.repo);
    const remoteUrl = remoteUrlOut.stdout.trim();
    if (remoteUrlOut.code !== 0 || !remoteUrl) {
      io.stderr(`cannot resolve source remote URL for ${args.remote}: ${remoteUrlOut.stderr}\n`);
      return { exit: 4, result: null };
    }

    const cloneOut = await deps.git(["clone", "--no-local", args.repo, workdir], args.repo);
    if (cloneOut.code !== 0) {
      io.stderr(`git clone failed: ${cloneOut.stderr}\n`);
      return { exit: 4, result: null };
    }
    let remoteSetOut = await deps.git(["remote", "set-url", args.remote, remoteUrl], workdir);
    if (remoteSetOut.code !== 0) {
      remoteSetOut = await deps.git(["remote", "add", args.remote, remoteUrl], workdir);
    }
    if (remoteSetOut.code !== 0) {
      io.stderr(`git remote ${args.remote} setup failed: ${remoteSetOut.stderr}\n`);
      return { exit: 4, result: null };
    }
    const fetchBaseOut = await deps.git(["fetch", args.remote, args.base], workdir);
    if (fetchBaseOut.code !== 0) {
      io.stderr(`git fetch ${args.remote} ${args.base} failed: ${fetchBaseOut.stderr}\n`);
      return { exit: 5, result: null };
    }
    const checkoutOut = await deps.git(["checkout", "-B", cleanBranch, `${args.remote}/${args.base}`], workdir);
    if (checkoutOut.code !== 0) {
      io.stderr(`git checkout clean branch failed: ${checkoutOut.stderr}\n`);
      return { exit: 6, result: null };
    }
    const fetchCommitOut = await deps.git(["fetch", args.repo, resolvedCommit], workdir);
    if (fetchCommitOut.code !== 0) {
      io.stderr(`git fetch scoped commit failed: ${fetchCommitOut.stderr}\n`);
      return { exit: 7, result: null };
    }
    const cherryPickOut = await deps.git(["cherry-pick", "-x", "FETCH_HEAD"], workdir);
    if (cherryPickOut.code !== 0) {
      io.stderr(`git cherry-pick ${resolvedCommit} failed: ${cherryPickOut.stderr}\n`);
      return { exit: 8, result: null };
    }

    const aheadOut = await deps.git(["rev-list", "--count", `${args.remote}/${args.base}..${cleanBranch}`], workdir);
    const ahead = Number(aheadOut.stdout.trim()) || 0;
    if (ahead !== 1) {
      io.stderr(`clean branch ${cleanBranch} is ${ahead} commits ahead of ${args.remote}/${args.base}; refusing unrelated commit promotion\n`);
      return { exit: 9, result: null };
    }
    const bodyOut = await deps.git(["log", "-1", "--format=%B", cleanBranch], workdir);
    if (!bodyOut.stdout.includes(resolvedCommit)) {
      io.stderr(`clean branch tip does not carry cherry-pick provenance for ${resolvedCommit}; refusing\n`);
      return { exit: 9, result: null };
    }

    const smokeOut = await deps.exec(args.smoke, workdir);
    if (smokeOut.code !== 0) {
      io.stderr(`smoke command failed (${args.smoke}):\nSTDOUT: ${smokeOut.stdout}\nSTDERR: ${smokeOut.stderr}\n`);
      return { exit: 10, result: null };
    }

    const promote = await runPromoteToMain(
      parsePromoteArgs([
        "--repo", workdir,
        "--branch", cleanBranch,
        "--base", args.base,
        "--remote", args.remote,
        "--strategy", "auto",
        ...(args.dispatchId ? ["--dispatch-id", args.dispatchId] : []),
        ...(args.agent ? ["--agent", args.agent] : []),
        "--json",
        "--execute",
      ]),
      deps,
      { stdout: () => undefined, stderr: io.stderr },
    );
    if (promote.exit !== 0 || !promote.result) {
      return { exit: promote.exit, result: null };
    }

    const result: PromoteScopedCommitResult = {
      source_repo: args.repo,
      workdir,
      base: args.base,
      remote: args.remote,
      requested_commit: args.commit,
      resolved_commit: resolvedCommit,
      clean_branch: cleanBranch,
      smoke: { command: args.smoke, exit_code: 0, gate: "passed" },
      promotion: promote.result,
      summary: `promoted scoped commit ${resolvedCommit.slice(0, 12)} via ${cleanBranch}`,
    };
    io.stdout(args.json ? JSON.stringify(result, null, 2) + "\n" : result.summary + "\n");
    return { exit: 0, result };
  } finally {
    if (cleanupWorkdir) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        io.stderr(`warning: failed to clean temporary promotion clone ${workdir}\n`);
      }
    }
  }
}

export const PROMOTE_SCOPED_COMMIT_USAGE = `id-agents promote-scoped-commit — clean promotion path for one scoped fix commit

Usage:
  id-agents promote-scoped-commit --repo <path> --commit <sha> --smoke <cmd> [options]

Options:
  --repo <path>          Source repo that contains the scoped fix commit (required)
  --commit <sha>         Single-parent fix commit to cherry-pick (required)
  --smoke <cmd>          Smoke command to run in the clean clone before promotion (required)
  --clean-branch <name>  Clean branch to create (default: scoped-promotion/<short-sha>)
  --workdir <path>       Temporary clone destination (default: OS temp dir)
  --base <branch>        Base branch (default: main)
  --remote <name>        Remote to push (default: origin)
  --dispatch-id <id>     Dispatch id forwarded to promote-to-main
  --agent <name>         Agent forwarded to promote-to-main commit attribution
  --json                 Emit machine-readable JSON
  --execute              Actually clone, cherry-pick, smoke, and promote
  -h, --help             Show this help

Read-only by default. The helper never force-pushes and refuses to promote if
the clean branch contains anything other than the single cherry-picked commit.`;

export async function maybeRunPromoteScopedCommitCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "promote-scoped-commit") return null;
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(PROMOTE_SCOPED_COMMIT_USAGE + "\n");
    return 0;
  }
  let parsed: PromoteScopedCommitArgs;
  try {
    parsed = parsePromoteScopedCommitArgs(rest);
  } catch (e) {
    if (e instanceof PromoteScopedCommitArgError || e instanceof PromoteArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 64;
    }
    throw e;
  }
  const r = await runPromoteScopedCommit(parsed, defaultGitDeps(), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  return r.exit;
}
