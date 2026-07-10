// `id-agents promote-to-main` — Spec 054 v2 Part 2 Step 9.
//
// Canonical final-step helper: merge a verified feature branch into main,
// push main to the remote, and verify the remote tip matches the
// promoted SHA. Outputs JSON in the shape /agent-done.promotion.repos[]
// expects so an agent can pipe it straight into the completion payload.
//
// Default mode is READ-ONLY preflight: prints what it would do, returns
// 0. `--execute` opts in to mutation (merge + push).
//
// Safety rules:
//   - Dirty working tree refuses execute unless --allow-own-dirty <files>
//     is explicitly passed for every dirty path.
//   - Never force-pushes.
//   - Source branch is never deleted.
//   - When ancestry is unclear or main has divergent commits, prints a
//     ready-to-send /agent-needs-input payload + exits non-zero.

import { spawn } from "node:child_process";
import { appendAgentTrailer, sanitizeAgentName } from "../lib/agent-attribution.js";
import { classifySmokeFailures } from "./smoke-exempt.js";

export type Strategy =
  | "auto"
  | "fast_forward"
  | "merge_commit"
  | "squash"
  | "follow_up_dispatch";

export interface PromoteArgs {
  repo: string;
  branch: string;
  base: string;          // default "main"
  remote: string;        // default "origin"
  strategy: Strategy;
  dispatchId: string | null;
  /** Agent the dispatch was routed to; stamped as an `Agent:` commit trailer. */
  agent: string | null;
  smoke: string | null;
  /** T-QA.7: globs of test files whose failure must NOT abort the promotion.
   *  Empty = today's behavior (any smoke failure aborts). */
  smokeExempt: string[];
  execute: boolean;
  allowOwnDirty: string[];
  json: boolean;
}

export class PromoteArgError extends Error {}

export interface PromoteResult {
  path: string;
  base: string;
  source_branch: string;
  strategy: "fast_forward" | "merge_commit" | "squash" | "follow_up_dispatch";
  promoted_sha: string;
  remote_main_sha: string;
  pushed: boolean;
  verified: boolean;
  /** Only present in preflight mode. */
  preflight?: true;
  /** T-QA.7: present when a smoke command ran. Surfaces the gate decision so the
   *  operator sees WHY a promotion proceeded despite a red suite. */
  smoke?: {
    exit_code: number;
    gate: "passed" | "passed_with_exempt_failures";
    /** Failing test files that were exempted (only when gate downgraded). */
    exempt_failures?: string[];
  };
  /** Human-readable summary line for stdout. */
  summary: string;
}

export interface NeedsClarificationPayload {
  dispatch_id: string;
  agent_id: string;
  question: string;
  context: Record<string, unknown>;
  urgency: "normal";
}

export interface GitDeps {
  /** Run a git command in cwd. Return { stdout, stderr, code }. */
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  /** Run an arbitrary shell command (for --smoke). */
  exec(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

// ────────────────────────────────────────────────────────────────────
// Argument parser
// ────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = new Set([
  "--repo", "--branch", "--base", "--remote", "--strategy",
  "--dispatch-id", "--agent", "--smoke", "--smoke-exempt", "--execute",
  "--allow-own-dirty", "--json",
]);

export function parsePromoteArgs(argv: string[]): PromoteArgs {
  let repo = "";
  let branch = "";
  let base = "main";
  let remote = "origin";
  let strategy: Strategy = "auto";
  let dispatchId: string | null = null;
  let agent: string | null = null;
  let smoke: string | null = null;
  let smokeExempt: string[] = [];
  let execute = false;
  let allowOwnDirty: string[] = [];
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) {
      throw new PromoteArgError(`unexpected positional arg: ${flag}`);
    }
    if (!KNOWN_FLAGS.has(flag)) {
      throw new PromoteArgError(`unknown flag: ${flag}`);
    }
    if (flag === "--execute") { execute = true; continue; }
    if (flag === "--json") { json = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new PromoteArgError(`${flag} requires a value`);
    switch (flag) {
      case "--repo": repo = val; break;
      case "--branch": branch = val; break;
      case "--base": base = val; break;
      case "--remote": remote = val; break;
      case "--strategy": {
        if (!["auto", "fast_forward", "merge_commit", "squash", "follow_up_dispatch"].includes(val)) {
          throw new PromoteArgError(`--strategy must be one of auto|fast_forward|merge_commit|squash|follow_up_dispatch (got ${val})`);
        }
        strategy = val as Strategy;
        break;
      }
      case "--dispatch-id": dispatchId = val; break;
      case "--agent": agent = val; break;
      case "--smoke": smoke = val; break;
      case "--smoke-exempt":
        // Repeatable + comma-separated; accumulates across occurrences.
        smokeExempt = smokeExempt.concat(val.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--allow-own-dirty":
        allowOwnDirty = val.split(",").map((s) => s.trim()).filter(Boolean);
        break;
    }
  }
  if (!repo) throw new PromoteArgError("--repo is required");
  if (!branch) throw new PromoteArgError("--branch is required");
  return { repo, branch, base, remote, strategy, dispatchId, agent, smoke, smokeExempt, execute, allowOwnDirty, json };
}

// ────────────────────────────────────────────────────────────────────
// Core helper — strategy selection
// ────────────────────────────────────────────────────────────────────

export interface BranchStatus {
  ahead: number;     // commits in branch not in base
  behind: number;    // commits in base not in branch
  branchTip: string;
  baseTip: string;
  hasAutocommitNoise: boolean; // many small commits with autocommit-shaped messages
  hasMissingAgentTrailers?: boolean; // commits that would land unattributed on fast-forward
  sourceAgent?: string | null; // first Agent trailer found on the source branch
}

/** Decide a concrete strategy from `auto`. Pure; tested directly. */
export function pickAutoStrategy(
  status: BranchStatus,
): "fast_forward" | "merge_commit" | "squash" {
  // Ancestry-clean fast-forward: base is direct ancestor of branch
  // (behind == 0) and there's at least one commit ahead.
  if (status.behind === 0 && status.ahead >= 1) {
    if (status.hasAutocommitNoise) return "squash";
    if (status.hasMissingAgentTrailers && status.sourceAgent) return "squash";
    return "fast_forward";
  }
  // Otherwise prefer merge_commit; if caller wanted no merge commit,
  // they should pass --strategy=fast_forward explicitly (which will fail
  // cleanly when not possible).
  return "merge_commit";
}

/** Detect autocommit-shaped histories (data refresh, etc). Pure. */
export function isAutocommitMessage(message: string): boolean {
  return /\b(data\.json refresh|workspace artifacts refresh|autocommit|auto-?save)\b/i.test(message);
}

export function countAutocommitNoise(messages: readonly string[]): number {
  return messages.filter(isAutocommitMessage).length;
}

/** Pure: decide if the branch is too noisy for fast-forward (>=50% autocommit). */
export function hasAutocommitNoise(messages: readonly string[]): boolean {
  if (messages.length === 0) return false;
  const noisy = countAutocommitNoise(messages);
  return noisy / messages.length >= 0.5;
}

export interface SourceBranchAttribution {
  sourceAgent: string | null;
  hasMissingAgentTrailers: boolean;
}

/** Inspect commit trailer values in newest-to-oldest branch order. */
export function sourceBranchAttribution(trailerValues: readonly string[]): SourceBranchAttribution {
  let sourceAgent: string | null = null;
  let hasMissingAgentTrailers = false;
  for (const raw of trailerValues) {
    const agent = sanitizeAgentName(raw.split(",")[0]);
    if (agent && !sourceAgent) sourceAgent = agent;
    if (!agent) hasMissingAgentTrailers = true;
  }
  return { sourceAgent, hasMissingAgentTrailers };
}

const SOURCE_ATTRIBUTION_RECORD_SEP = "\x1e";
const SOURCE_ATTRIBUTION_FIELD_SEP = "\x1f";

function parseSourceBranchAttributionLog(stdout: string): string[] {
  return stdout
    .split(SOURCE_ATTRIBUTION_RECORD_SEP)
    .map((rec) => rec.replace(new RegExp(`^${SOURCE_ATTRIBUTION_FIELD_SEP}`), "").trim())
    .filter((_, idx, all) => idx < all.length - 1 || all[idx] !== "");
}

// ────────────────────────────────────────────────────────────────────
// Squash commit body template (pure)
// ────────────────────────────────────────────────────────────────────

export function buildSquashCommitBody(args: {
  featureName: string;
  branch: string;
  sourceTip: string;
  verification: string | null;
  dispatchId: string | null;
  agent?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`Promote ${args.featureName}`);
  lines.push("");
  lines.push(`Source branch: ${args.branch}`);
  lines.push(`Source tip: ${args.sourceTip}`);
  if (args.verification) lines.push(`Verification: ${args.verification}`);
  if (args.dispatchId) lines.push(`Dispatch: ${args.dispatchId}`);
  return appendAgentTrailer(lines.join("\n"), args.agent ?? null);
}

// ────────────────────────────────────────────────────────────────────
// Main runner
// ────────────────────────────────────────────────────────────────────

export async function runPromoteToMain(
  args: PromoteArgs,
  deps: GitDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<{ exit: number; result: PromoteResult | null; needsClarification?: NeedsClarificationPayload }> {
  const { repo, branch, base, remote, strategy, dispatchId, agent, smoke, smokeExempt, execute, allowOwnDirty, json } = args;

  // Step 1: Working-tree check.
  const statusOut = await deps.git(["status", "--porcelain"], repo);
  if (statusOut.code !== 0) {
    io.stderr(`git status failed: ${statusOut.stderr}\n`);
    return { exit: 2, result: null };
  }
  const dirtyLines = statusOut.stdout.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
  const unapprovedDirty = dirtyLines.filter((p) => !allowOwnDirty.includes(p));
  if (unapprovedDirty.length > 0 && execute) {
    io.stderr(
      `working tree has unapproved dirty paths (use --allow-own-dirty <files> to whitelist):\n` +
      unapprovedDirty.map((p) => `  ${p}`).join("\n") + "\n",
    );
    return { exit: 3, result: null };
  }

  // Step 2: Fetch remote refs (non-fatal in preflight if offline; fatal at execute).
  const fetchOut = await deps.git(["fetch", remote, base], repo);
  if (fetchOut.code !== 0 && execute) {
    io.stderr(`git fetch ${remote} ${base} failed: ${fetchOut.stderr}\n`);
    return { exit: 4, result: null };
  }

  // Step 3: Branch ahead/behind + tips.
  // RD-013: resolve strategy + divergence against the FRESHLY-FETCHED REMOTE base
  // (`origin/main`), NOT the stale LOCAL base ref. The local base can lag origin
  // (it is only fast-forwarded at execute), so measuring against it makes a branch
  // that is behind origin look up-to-date — bypassing the divergence → needs-input
  // gate and letting a fast-forward run on a stale base.
  const remoteBaseRef = `${remote}/${base}`;
  const branchTip = (await deps.git(["rev-parse", branch], repo)).stdout.trim();
  const baseTip = (await deps.git(["rev-parse", remoteBaseRef], repo)).stdout.trim();
  if (!branchTip || !baseTip) {
    io.stderr(`cannot resolve branch/base SHAs (branch=${branch} base=${remoteBaseRef})\n`);
    return { exit: 5, result: null };
  }
  const aheadOut = await deps.git(
    ["rev-list", "--count", `${remoteBaseRef}..${branch}`], repo,
  );
  const behindOut = await deps.git(
    ["rev-list", "--count", `${branch}..${remoteBaseRef}`], repo,
  );
  const ahead = Number(aheadOut.stdout.trim()) || 0;
  const behind = Number(behindOut.stdout.trim()) || 0;

  // Step 4: Detect autocommit noise.
  const logOut = await deps.git(
    ["log", "--format=%s", `${remoteBaseRef}..${branch}`], repo,
  );
  const messages = logOut.stdout.split("\n").filter((l) => l.trim());
  const trailerOut = await deps.git(
    [
      "log",
      `--format=%x1f%(trailers:key=Agent,valueonly,separator=%x2c)%x1e`,
      `${remoteBaseRef}..${branch}`,
    ],
    repo,
  );
  const sourceAttribution = sourceBranchAttribution(parseSourceBranchAttributionLog(trailerOut.stdout));
  const effectiveAgent = sanitizeAgentName(agent) || sourceAttribution.sourceAgent;
  const branchStatus: BranchStatus = {
    ahead, behind, branchTip, baseTip,
    hasAutocommitNoise: hasAutocommitNoise(messages),
    hasMissingAgentTrailers: sourceAttribution.hasMissingAgentTrailers,
    sourceAgent: effectiveAgent,
  };

  // Step 5: Strategy resolution.
  let resolvedStrategy: "fast_forward" | "merge_commit" | "squash" | "follow_up_dispatch";
  if (strategy === "follow_up_dispatch") {
    // Caller is explicitly punting to a follow-up dispatch; record and exit.
    const result: PromoteResult = {
      path: repo, base, source_branch: branch,
      strategy: "follow_up_dispatch",
      promoted_sha: branchTip, remote_main_sha: baseTip,
      pushed: false, verified: false,
      preflight: !execute || undefined,
      summary: `would punt promotion of ${branch} to a follow-up dispatch (no promote attempted)`,
    };
    io.stdout(json ? JSON.stringify(result, null, 2) + "\n" : result.summary + "\n");
    return { exit: 0, result };
  }
  if (strategy === "auto") {
    if (ahead === 0 && behind === 0) {
      io.stdout(`nothing to promote: ${branch} == ${base}\n`);
      const result: PromoteResult = {
        path: repo, base, source_branch: branch,
        strategy: "fast_forward",
        promoted_sha: branchTip, remote_main_sha: baseTip,
        pushed: false, verified: branchTip === baseTip,
        preflight: !execute || undefined,
        summary: "no-op: branch and base are identical",
      };
      return { exit: 0, result };
    }
    if (behind > 0 && ahead > 0) {
      // Divergent — ambiguous, pause via /agent-needs-input.
      const payload = buildNeedsClarification({ args, ahead, behind, branchTip, baseTip });
      io.stderr(`branch ${branch} has diverged from ${base} (ahead=${ahead}, behind=${behind}); pausing for clarification\n`);
      io.stdout(JSON.stringify(payload, null, 2) + "\n");
      return { exit: 10, result: null, needsClarification: payload };
    }
    resolvedStrategy = pickAutoStrategy(branchStatus);
  } else if (strategy === "fast_forward") {
    if (behind > 0) {
      io.stderr(
        `--strategy=fast_forward requested but ${base} has ${behind} commits not in ${branch}; refusing\n`,
      );
      return { exit: 6, result: null };
    }
    resolvedStrategy = "fast_forward";
  } else {
    resolvedStrategy = strategy === "merge_commit" ? "merge_commit" : "squash";
  }

  // Preflight summary.
  const previewSummary = `would ${resolvedStrategy.replace("_", "-")} ${branch} (${branchTip.slice(0, 7)}, ahead ${ahead}, behind ${behind}) into ${base} on ${remote}`;
  if (!execute) {
    const result: PromoteResult = {
      path: repo, base, source_branch: branch, strategy: resolvedStrategy,
      promoted_sha: branchTip, remote_main_sha: baseTip,
      pushed: false, verified: false,
      preflight: true,
      summary: previewSummary,
    };
    io.stdout(json ? JSON.stringify(result, null, 2) + "\n" : `[preflight] ${previewSummary}\n`);
    return { exit: 0, result };
  }

  // ─── Execute path ────────────────────────────────────────────────
  // Switch to base + update from remote.
  const checkoutOut = await deps.git(["checkout", base], repo);
  if (checkoutOut.code !== 0) {
    io.stderr(`git checkout ${base} failed: ${checkoutOut.stderr}\n`);
    return { exit: 7, result: null };
  }
  const pullOut = await deps.git(["merge", "--ff-only", `${remote}/${base}`], repo);
  if (pullOut.code !== 0) {
    io.stderr(`git merge --ff-only ${remote}/${base} failed: ${pullOut.stderr}\n`);
    return { exit: 7, result: null };
  }

  // Apply chosen strategy.
  let mergeOut;
  if (resolvedStrategy === "fast_forward") {
    mergeOut = await deps.git(["merge", "--ff-only", branch], repo);
  } else if (resolvedStrategy === "squash") {
    const squashOut = await deps.git(["merge", "--squash", branch], repo);
    if (squashOut.code !== 0) {
      io.stderr(`git merge --squash ${branch} failed: ${squashOut.stderr}\n`);
      return { exit: 7, result: null };
    }
    const body = buildSquashCommitBody({
      featureName: branch,
      branch,
      sourceTip: branchTip,
      verification: smoke,
      dispatchId,
      agent: effectiveAgent,
    });
    mergeOut = await deps.git(["commit", "-m", body], repo);
  } else {
    // merge_commit
    const mergeMsg = appendAgentTrailer(`Merge ${branch} into ${base}`, effectiveAgent);
    mergeOut = await deps.git(
      ["merge", "--no-ff", "-m", mergeMsg, branch],
      repo,
    );
  }
  if (mergeOut.code !== 0) {
    io.stderr(`merge step failed: ${mergeOut.stderr}\n`);
    return { exit: 8, result: null };
  }

  const promotedSha = (await deps.git(["rev-parse", base], repo)).stdout.trim();

  // Step 6: Smoke command (between merge and push).
  let smokeAnnotation: PromoteResult["smoke"];
  if (smoke) {
    const smokeOut = await deps.exec(smoke, repo);
    if (smokeOut.code !== 0) {
      // T-QA.7 trap fix: a non-zero smoke aborts as before UNLESS the operator
      // declared --smoke-exempt globs AND every failing test file matches one of
      // them (a flaky/unrelated red test must not block an otherwise-clean
      // promotion). With no globs, classification.all_exempt is always false, so
      // this path is byte-identical to the prior behavior.
      const classification = classifySmokeFailures(`${smokeOut.stdout}\n${smokeOut.stderr}`, smokeExempt);
      if (smokeExempt.length > 0 && classification.all_exempt) {
        smokeAnnotation = {
          exit_code: smokeOut.code,
          gate: "passed_with_exempt_failures",
          exempt_failures: classification.exempt,
        };
        io.stderr(
          `smoke exited ${smokeOut.code} but all ${classification.exempt.length} failing test file(s) are --smoke-exempt; proceeding: ${classification.exempt.join(", ")}\n`,
        );
      } else {
        io.stderr(`smoke command failed (${smoke}):\nSTDOUT: ${smokeOut.stdout}\nSTDERR: ${smokeOut.stderr}\n`);
        if (smokeExempt.length > 0) {
          const uncovered = classification.non_exempt.length
            ? classification.non_exempt.join(", ")
            : "(no failing test files parsed from smoke output)";
          io.stderr(`--smoke-exempt did not cover: ${uncovered}\n`);
        }
        return { exit: 9, result: null };
      }
    } else {
      smokeAnnotation = { exit_code: 0, gate: "passed" };
    }
  }

  // Step 7: Push (never force).
  const pushOut = await deps.git(["push", remote, base], repo);
  if (pushOut.code !== 0) {
    io.stderr(`git push ${remote} ${base} failed: ${pushOut.stderr}\n`);
    return { exit: 11, result: null };
  }

  // Step 8: Verify remote matches.
  const remoteOut = await deps.git(["rev-parse", `${remote}/${base}`], repo);
  const remoteSha = remoteOut.stdout.trim();
  const verified = remoteSha === promotedSha;

  const exemptNote =
    smokeAnnotation?.gate === "passed_with_exempt_failures"
      ? ` (smoke passed with ${smokeAnnotation.exempt_failures?.length ?? 0} exempt failure(s))`
      : "";
  const result: PromoteResult = {
    path: repo, base, source_branch: branch, strategy: resolvedStrategy,
    promoted_sha: promotedSha, remote_main_sha: remoteSha,
    pushed: true, verified,
    ...(smokeAnnotation ? { smoke: smokeAnnotation } : {}),
    summary: `promoted ${branch} -> ${base} on ${remote} (${promotedSha.slice(0, 7)})${exemptNote}${verified ? "" : " WARNING: remote SHA mismatch"}`,
  };
  io.stdout(json ? JSON.stringify(result, null, 2) + "\n" : result.summary + "\n");
  return { exit: verified ? 0 : 12, result };
}

function buildNeedsClarification(opts: {
  args: PromoteArgs;
  ahead: number; behind: number;
  branchTip: string; baseTip: string;
}): NeedsClarificationPayload {
  const { args, ahead, behind, branchTip, baseTip } = opts;
  return {
    dispatch_id: args.dispatchId ?? "<unset>",
    agent_id: "promote-to-main",
    question: `Branch ${args.branch} has diverged from ${args.base} (ahead=${ahead}, behind=${behind}). Which strategy?`,
    context: {
      repo: args.repo,
      branch: args.branch,
      base: args.base,
      remote: args.remote,
      ahead,
      behind,
      branch_tip: branchTip,
      base_tip: baseTip,
      options: [
        "fast_forward (refuse — branch is not pure ahead)",
        "merge_commit (preserve branch topology with a merge commit)",
        "squash (squash branch into one commit on base)",
        "follow_up_dispatch (defer promotion to a named follow-up dispatch)",
      ],
      recommended_option: "follow_up_dispatch (defer promotion to a named follow-up dispatch)",
      incident_code: "ahead_behind_divergence",
      action: "route_to_worktree_hygiene",
    },
    urgency: "normal",
  };
}

// ────────────────────────────────────────────────────────────────────
// Default git deps (real spawn)
// ────────────────────────────────────────────────────────────────────

export function defaultGitDeps(): GitDeps {
  return {
    git: (a, cwd) => spawnCapture("git", a, cwd),
    exec: (cmd, cwd) => spawnCapture("sh", ["-c", cmd], cwd),
  };
}

function spawnCapture(
  cmd: string, args: string[], cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d.toString(); });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", (err) => resolve({ stdout, stderr: stderr + String(err), code: 127 }));
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

// ────────────────────────────────────────────────────────────────────
// Subcommand entrypoint mirroring maybeRunOutputsCli.
// ────────────────────────────────────────────────────────────────────

export const PROMOTE_USAGE = `id-agents promote-to-main — Spec 054 v2 canonical promotion (verify → merge → push → remote-tip check)

Usage:
  id-agents promote-to-main --repo <path> --branch <branch> [options]

Options:
  --repo <path>          Absolute repo path (required)
  --branch <branch>      Feature branch to promote (required)
  --base <branch>        Base branch (default: main)
  --remote <name>        Remote to push (default: origin)
  --strategy <s>         auto|fast_forward|merge_commit|squash|follow_up_dispatch (default: auto)
  --dispatch-id <id>     Dispatch id for the /agent-needs-input payload on divergence
  --agent <name>         Attributed agent; stamped as an "Agent: <name>" commit trailer (squash/merge)
  --smoke <cmd>          Smoke command gating promotion (e.g. "npm run build && npm test")
  --smoke-exempt <globs> T-QA.7: test-file globs whose failure does NOT abort the
                         promotion. On smoke failure, if EVERY failing test file
                         matches an exempt glob, the gate proceeds and records
                         passed_with_exempt_failures (operator-visible). Any
                         non-exempt failure aborts as normal. Repeatable/comma-sep.
  --allow-own-dirty <p>  Permit a known-own dirty path (repeatable)
  --json                 Emit machine-readable JSON (drops into /agent-done.promotion.repos[])
  --execute              Actually perform the merge+push (omit for read-only preflight)
  -h, --help             Show this help

Read-only by default; pass --execute to mutate. Never force-pushes the base branch.`;

export async function maybeRunPromoteToMainCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "promote-to-main") return null;
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(PROMOTE_USAGE + "\n");
    return 0;
  }
  let parsed: PromoteArgs;
  try {
    parsed = parsePromoteArgs(argv.slice(1));
  } catch (e) {
    if (e instanceof PromoteArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 64; // EX_USAGE
    }
    throw e;
  }
  const r = await runPromoteToMain(parsed, defaultGitDeps(), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  return r.exit;
}
