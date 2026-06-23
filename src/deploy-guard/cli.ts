#!/usr/bin/env node
// T-DEPLOY.5 (2026-06-22) — deploy-guard CLI. The post-deploy hook the runbook
// calls after a kickstart:
//
//   node dist/deploy-guard/cli.js smoke --base-url http://127.0.0.1:4100 \
//     --pid-before <pid> --pid-after <pid> [--auto-rollback --execute]
//
// On a passing smoke it records the current build as last-good. On a failing
// smoke it decides a rollback to the last-good SHA and (with --auto-rollback
// --execute) performs it: git checkout last-good → rebuild → kickstart. Without
// --execute it prints the plan (dry-run) — the safe default.

import { spawnSync } from "node:child_process";
import { runSmokeProbe, type SmokeResult } from "./smoke.js";
import {
  decideRollback,
  lastGoodStorePath,
  readLastGood,
  writeLastGood,
  type RollbackDecision,
} from "./rollback.js";

export interface RollbackStep {
  label: string;
  cmd: string;
  args: string[];
}

/** Pure: the ordered shell steps that perform a rollback to `targetSha`. */
export function planRollbackSteps(
  targetSha: string,
  opts: { repoDir?: string; rebuildCmd?: string; kickstartCmd?: string } = {},
): RollbackStep[] {
  const repoDir = opts.repoDir ?? process.cwd();
  const rebuildCmd = opts.rebuildCmd ?? "npm run build";
  // The launchd label is operator-specific — supply via DEPLOY_GUARD_KICKSTART_CMD.
  const kickstartCmd =
    opts.kickstartCmd ??
    process.env.DEPLOY_GUARD_KICKSTART_CMD ??
    "launchctl kickstart -k gui/$(id -u)/com.kilgore.id-agents-manager";
  return [
    { label: "checkout last-good build", cmd: "git", args: ["-C", repoDir, "checkout", "--detach", targetSha] },
    { label: "rebuild", cmd: "bash", args: ["-lc", rebuildCmd] },
    { label: "kickstart manager", cmd: "bash", args: ["-lc", kickstartCmd] },
  ];
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function executeRollback(steps: RollbackStep[], execute: boolean): { ok: boolean; ran: string[] } {
  const ran: string[] = [];
  for (const step of steps) {
    const line = `${step.cmd} ${step.args.join(" ")}`;
    if (!execute) {
      console.log(`[dry-run] ${step.label}: ${line}`);
      ran.push(line);
      continue;
    }
    console.log(`[execute] ${step.label}: ${line}`);
    const r = spawnSync(step.cmd, step.args, { stdio: "inherit" });
    ran.push(line);
    if (r.status !== 0) {
      console.error(`[deploy-guard] step failed (${step.label}); aborting rollback`);
      return { ok: false, ran };
    }
  }
  return { ok: true, ran };
}

async function cmdSmoke(args: Record<string, string | boolean>): Promise<number> {
  const baseUrl = String(args["base-url"] ?? "http://127.0.0.1:4100");
  const pidBefore = args["pid-before"] != null ? Number(args["pid-before"]) : null;
  const pidAfter = args["pid-after"] != null ? Number(args["pid-after"]) : null;
  const routes = typeof args.routes === "string" ? args.routes.split(",") : undefined;
  const repoDir = typeof args["repo-dir"] === "string" ? args["repo-dir"] : process.cwd();

  const smoke: SmokeResult = await runSmokeProbe({ baseUrl, pidBefore, pidAfter, routes });
  const storePath = lastGoodStorePath(repoDir);
  const lastGood = readLastGood(storePath);

  if (smoke.pass) {
    if (smoke.build_sha) {
      writeLastGood(storePath, { build_sha: smoke.build_sha, recorded_at: new Date().toISOString() });
    }
    console.log(JSON.stringify({ ok: true, smoke, recorded_last_good: smoke.build_sha }, null, 2));
    return 0;
  }

  const decision: RollbackDecision = decideRollback(false, smoke.build_sha, lastGood);
  const autoRollback = args["auto-rollback"] === true;
  const execute = args.execute === true;

  let rollback: { planned: RollbackStep[]; executed: boolean; ok: boolean } | null = null;
  if (autoRollback && decision.should_rollback && decision.target_sha) {
    const steps = planRollbackSteps(decision.target_sha, { repoDir });
    const res = executeRollback(steps, execute);
    rollback = { planned: steps, executed: execute, ok: res.ok };
  }

  console.log(JSON.stringify({ ok: false, smoke, decision, rollback }, null, 2));
  return 1;
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);
  let code = 0;
  switch (sub) {
    case "smoke":
      code = await cmdSmoke(args);
      break;
    case "rollback": {
      const to = typeof args.to === "string" ? args.to : null;
      if (!to) {
        console.error("usage: deploy-guard rollback --to <sha> [--execute]");
        code = 2;
        break;
      }
      const steps = planRollbackSteps(to, { repoDir: typeof args["repo-dir"] === "string" ? args["repo-dir"] : undefined });
      const res = executeRollback(steps, args.execute === true);
      code = res.ok ? 0 : 1;
      break;
    }
    default:
      console.error("usage: deploy-guard <smoke|rollback> [...flags]");
      code = 2;
  }
  process.exit(code);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  void main();
}
