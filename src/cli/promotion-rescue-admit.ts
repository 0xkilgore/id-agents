// `id-agents promotion-rescue-admit` - read-only admission report for
// verified-but-unpromoted branches that cannot be promoted directly from the
// current checkout.

import { defaultGitDeps, type GitDeps } from "./promote-to-main.js";

export type PromotionRescueDecision =
  | "promote"
  | "clean_clone_cherry_pick_owned_commits_rerun_smoke_promote"
  | "route_to_worktree_hygiene_follow_up_promotion";

export interface PromotionRescueCase {
  repo: string;
  branch: string;
  base: string;
  remote: string;
}

export interface PromotionRescueArgs {
  cases: PromotionRescueCase[];
  base: string;
  remote: string;
  json: boolean;
}

export interface PromotionRescueAdmission {
  repo: string;
  worktree: string;
  branch: string;
  base: string;
  remote: string;
  decision: PromotionRescueDecision;
  ahead: number | null;
  behind: number | null;
  branch_tip: string | null;
  base_tip: string | null;
  dirty: boolean;
  dirty_paths: string[];
  recovery_group: string;
  recommended_owner: string;
  smoke_command: string | null;
  warning: string | null;
  proposed_follow_up: string;
  force_push: false;
  needs_input: boolean;
  reason: string;
}

export class PromotionRescueArgError extends Error {}

const KNOWN_FLAGS = new Set(["--case", "--repo", "--branch", "--base", "--remote", "--json"]);

export function parsePromotionRescueArgs(argv: string[]): PromotionRescueArgs {
  const cases: PromotionRescueCase[] = [];
  let repo = "";
  let branch = "";
  let base = "main";
  let remote = "origin";
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) {
      throw new PromotionRescueArgError(`unexpected positional arg: ${flag}`);
    }
    if (!KNOWN_FLAGS.has(flag)) {
      throw new PromotionRescueArgError(`unknown flag: ${flag}`);
    }
    if (flag === "--json") {
      json = true;
      continue;
    }
    const val = argv[++i];
    if (val === undefined) throw new PromotionRescueArgError(`${flag} requires a value`);
    switch (flag) {
      case "--case": {
        const parsed = parseCase(val, base, remote);
        cases.push(parsed);
        break;
      }
      case "--repo":
        repo = val;
        break;
      case "--branch":
        branch = val;
        break;
      case "--base":
        base = val;
        for (const c of cases) c.base = val;
        break;
      case "--remote":
        remote = val;
        for (const c of cases) c.remote = val;
        break;
    }
  }

  if (repo || branch) {
    if (!repo || !branch) throw new PromotionRescueArgError("--repo and --branch must be supplied together");
    cases.push({ repo, branch, base, remote });
  }
  if (cases.length === 0) {
    throw new PromotionRescueArgError("at least one --case <repo>:<branch> or --repo/--branch pair is required");
  }
  return { cases, base, remote, json };
}

export async function runPromotionRescueAdmit(
  args: PromotionRescueArgs,
  deps: GitDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<{ exit: number; results: PromotionRescueAdmission[] }> {
  const results: PromotionRescueAdmission[] = [];
  for (const c of args.cases) {
    results.push(await inspectCase(c, deps));
  }
  if (args.json) {
    io.stdout(JSON.stringify({ results }, null, 2) + "\n");
  } else {
    io.stdout(formatAdmissions(results));
  }
  return { exit: 0, results };
}

async function inspectCase(c: PromotionRescueCase, deps: GitDeps): Promise<PromotionRescueAdmission> {
  const worktree = await resolveBranchWorktree(c, deps);
  const statusCwd = worktree ?? c.repo;
  const dirtyPaths = worktree ? await dirtyPathsFor(statusCwd, deps) : [];

  const fetchOut = await deps.git(["fetch", c.remote, c.base, c.branch], c.repo);
  if (fetchOut.code !== 0 && /no such remote|does not appear to be a git repository|could not read from remote/i.test(`${fetchOut.stderr}\n${fetchOut.stdout}`)) {
    return {
      ...routeToHygiene(c, `remote ${c.remote} is not available; cannot verify promotion ancestry`, worktree),
      dirty: dirtyPaths.length > 0,
      dirty_paths: dirtyPaths,
    };
  }
  const remoteBase = `${c.remote}/${c.base}`;
  const branchTipOut = await deps.git(["rev-parse", "--verify", `${c.branch}^{commit}`], c.repo);
  const baseTipOut = await deps.git(["rev-parse", "--verify", `${remoteBase}^{commit}`], c.repo);
  if (branchTipOut.code !== 0 || baseTipOut.code !== 0) {
    return {
      ...routeToHygiene(c, "cannot resolve branch or remote base", worktree),
      dirty: dirtyPaths.length > 0,
      dirty_paths: dirtyPaths,
    };
  }

  const branchTip = branchTipOut.stdout.trim();
  const baseTip = baseTipOut.stdout.trim();
  const aheadOut = await deps.git(["rev-list", "--count", `${remoteBase}..${c.branch}`], c.repo);
  const behindOut = await deps.git(["rev-list", "--count", `${c.branch}..${remoteBase}`], c.repo);
  const ahead = Number(aheadOut.stdout.trim()) || 0;
  const behind = Number(behindOut.stdout.trim()) || 0;
  const dirty = dirtyPaths.length > 0;

  const common = {
    repo: c.repo,
    worktree: worktree ?? c.repo,
    branch: c.branch,
    base: c.base,
    remote: c.remote,
    ahead,
    behind,
    branch_tip: branchTip,
    base_tip: baseTip,
    dirty,
    dirty_paths: dirtyPaths,
    recovery_group: recoveryGroup(c.repo, c.branch),
    recommended_owner: "worktree-hygiene",
    smoke_command: null,
    warning: null,
    force_push: false as const,
  };

  if (ahead > 0 && behind > 0) {
    return {
      ...common,
      decision: "route_to_worktree_hygiene_follow_up_promotion",
      proposed_follow_up: "group by repo/branch in Worktree Hygiene; create a clean branch from remote base, cherry-pick only owned commits, fill smoke_command, then promote the clean branch",
      warning: "do not merge as-is: ahead+behind Spec 054 failure requires fresh-branch recovery before promotion",
      needs_input: false,
      reason: `branch diverged from ${remoteBase} (ahead=${ahead}, behind=${behind})`,
    };
  }
  if (dirty) {
    return {
      ...common,
      decision: "clean_clone_cherry_pick_owned_commits_rerun_smoke_promote",
      proposed_follow_up: "create clean clone from remote base, cherry-pick only owned commits, rerun smoke, then promote from the clean non-diverged branch",
      recommended_owner: "follow-up-promotion",
      needs_input: false,
      reason: `worktree has ${dirtyPaths.length} dirty path(s); direct promotion from this checkout is not admitted`,
    };
  }
  if (ahead > 0 && behind === 0) {
    return {
      ...common,
      decision: "promote",
      proposed_follow_up: "rerun smoke, then id-agents promote-to-main from this clean non-diverged branch",
      recommended_owner: "follow-up-promotion",
      needs_input: false,
      reason: `branch is clean and ${ahead} commit(s) ahead of ${remoteBase}`,
    };
  }
  return {
    ...common,
    decision: "promote",
    proposed_follow_up: "no-op or remote-tip verification; branch is not ahead of base",
    recommended_owner: "follow-up-promotion",
    needs_input: false,
    reason: `branch has no commits ahead of ${remoteBase}`,
  };
}

function parseCase(value: string, base: string, remote: string): PromotionRescueCase {
  const idx = value.lastIndexOf(":");
  if (idx <= 0 || idx === value.length - 1) {
    throw new PromotionRescueArgError(`--case must be <repo>:<branch> (got ${value})`);
  }
  return {
    repo: value.slice(0, idx),
    branch: value.slice(idx + 1),
    base,
    remote,
  };
}

async function resolveBranchWorktree(c: PromotionRescueCase, deps: GitDeps): Promise<string | null> {
  const out = await deps.git(["worktree", "list", "--porcelain"], c.repo);
  if (out.code !== 0) return null;
  let currentPath: string | null = null;
  for (const line of out.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line === `branch refs/heads/${c.branch}`) return currentPath;
  }
  return null;
}

async function dirtyPathsFor(worktree: string, deps: GitDeps): Promise<string[]> {
  const status = await deps.git(["status", "--porcelain"], worktree);
  if (status.code !== 0) return [];
  return status.stdout.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
}

function routeToHygiene(c: PromotionRescueCase, reason: string, worktree?: string | null): PromotionRescueAdmission {
  return {
    repo: c.repo,
    worktree: worktree ?? c.repo,
    branch: c.branch,
    base: c.base,
    remote: c.remote,
    decision: "route_to_worktree_hygiene_follow_up_promotion",
    ahead: null,
    behind: null,
    branch_tip: null,
    base_tip: null,
    dirty: false,
    dirty_paths: [],
    recovery_group: recoveryGroup(c.repo, c.branch),
    recommended_owner: "worktree-hygiene",
    smoke_command: null,
    warning: "do not merge as-is: promotion ancestry is unverified and needs hygiene/follow-up promotion recovery",
    proposed_follow_up: "group by repo/branch in Worktree Hygiene; restore remote ancestry evidence, fill smoke_command, then promote from a verified clean branch",
    force_push: false,
    needs_input: false,
    reason,
  };
}

function recoveryGroup(repo: string, branch: string): string {
  return `${repo.replace(/\/+$/g, "")}:${branch}`;
}

function formatAdmissions(results: PromotionRescueAdmission[]): string {
  return results.map((r) => [
    `${r.branch}`,
    `  repo: ${r.repo}`,
    `  worktree: ${r.worktree}`,
    `  decision: ${r.decision}`,
    `  ahead/behind: ${r.ahead ?? "unknown"}/${r.behind ?? "unknown"}`,
    `  dirty: ${r.dirty ? `yes (${r.dirty_paths.length})` : "no"}`,
    `  recovery_group: ${r.recovery_group}`,
    `  recommended_owner: ${r.recommended_owner}`,
    `  smoke_command: ${r.smoke_command ?? "<fill before follow-up promotion>"}`,
    ...(r.warning ? [`  warning: ${r.warning}`] : []),
    `  proposed_follow_up: ${r.proposed_follow_up}`,
    `  force_push: false`,
    `  reason: ${r.reason}`,
  ].join("\n")).join("\n\n") + "\n";
}

function firstLine(value: string | null | undefined): string | null {
  return value?.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
}

export const PROMOTION_RESCUE_ADMIT_USAGE = `id-agents promotion-rescue-admit - read-only promotion rescue admission report

Usage:
  id-agents promotion-rescue-admit --case <repo>:<branch> [--case <repo>:<branch> ...] [options]
  id-agents promotion-rescue-admit --repo <path> --branch <branch> [options]

Options:
  --case <repo>:<branch>  Repo/branch pair to inspect; repeatable
  --repo <path>           Repo path for a single case
  --branch <branch>       Branch for a single case
  --base <branch>         Base branch (default: main)
  --remote <name>         Remote to inspect (default: origin)
  --json                  Emit machine-readable JSON
  -h, --help              Show this help

Read-only. Emits ahead/behind, dirty state, recommended owner, smoke command slot, a deterministic follow-up, and force_push=false.`;

export async function maybeRunPromotionRescueAdmitCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "promotion-rescue-admit") return null;
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(PROMOTION_RESCUE_ADMIT_USAGE + "\n");
    return 0;
  }
  let parsed: PromotionRescueArgs;
  try {
    parsed = parsePromotionRescueArgs(rest);
  } catch (e) {
    if (e instanceof PromotionRescueArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 64;
    }
    throw e;
  }
  const r = await runPromotionRescueAdmit(parsed, defaultGitDeps(), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  return r.exit;
}
