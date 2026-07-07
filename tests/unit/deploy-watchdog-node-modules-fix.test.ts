// Regression coverage for the 2026-07-03/04 incident: deploy-freshness-watchdog's
// redeploy sequence failed every ~15 min for ~24h with:
//
//   error: Your local changes to the following files would be overwritten by checkout:
//     node_modules
//   Please commit your changes or stash them before you switch branches.
//
// Root cause: node_modules is (or was) git-tracked as a symlink blob (mode
// 120000) — a worktree-sharing artifact, never source. `npm ci` materializes a
// REAL directory over that tracked path, so any branch switch involving it
// (in particular the WIP-snapshot switch's same-day fallback, which reuses an
// already-created `wip/pre-redeploy-snapshot-<date>` branch across the day's
// repeated 15-min checks) trips git's "local changes would be overwritten"
// safety check and aborts the whole redeploy.
//
// Two complementary checks:
//
// 1. Structural: the actual script source must run the defensive
//    untrack-and-clear step before any git switch, and the WIP-snapshot
//    stash pathspec must exclude node_modules. Catches a regression even if
//    nobody re-runs the git-mechanics test below.
// 2. Git-mechanics smoke test: replays the exact failure shape (tracked
//    symlink → `npm ci` materializes a real directory → dirty-checkout
//    snapshot switch) against a disposable temp repo, twice back-to-back
//    (mirroring two watchdog checks landing on the same day's already-created
//    WIP branch — the specific path that broke in production), and asserts
//    `git status --porcelain` never mentions node_modules afterward.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_SRC = readFileSync(
  join(__dirname, '../../scripts/deploy-freshness-watchdog.mjs'),
  'utf8',
);

describe('deploy-freshness-watchdog source — Gotcha-2b defensive steps present', () => {
  it('untracks + clears node_modules before the deploy branch switch', () => {
    const untrackIdx = WATCHDOG_SRC.indexOf("git rm -r --cached --ignore-unmatch node_modules");
    const clearIdx = WATCHDOG_SRC.indexOf("rm -rf node_modules");
    const deploySwitchIdx = WATCHDOG_SRC.indexOf('git switch -c deploy/manager-${date}');

    expect(untrackIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(deploySwitchIdx).toBeGreaterThan(-1);
    expect(untrackIdx).toBeLessThan(deploySwitchIdx);
    expect(clearIdx).toBeLessThan(deploySwitchIdx);
  });

  it('does not switch to a WIP branch before preserving dirty work', () => {
    expect(WATCHDOG_SRC).not.toContain('git switch -c wip/pre-redeploy-snapshot');
    expect(WATCHDOG_SRC).toContain('git stash push -u');
    expect(WATCHDOG_SRC).toContain('git branch -f wip/pre-redeploy-snapshot-${date}');
  });

  it('the WIP-snapshot stash excludes node_modules', () => {
    const stashLineMatch = WATCHDOG_SRC.match(/git stash push -u [^`]*/);
    expect(stashLineMatch).not.toBeNull();
    expect(stashLineMatch![0]).toContain("':!node_modules'");
  });
});

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/**
 * Mirrors runRedeploy()'s Gotcha-2/2b block exactly (kept in lockstep with
 * scripts/deploy-freshness-watchdog.mjs — if that block changes, update this
 * copy too). Deliberately excludes the npm ci / tsc / launchctl kickstart
 * steps: those are unrelated to this bug and launchctl kickstart must never
 * run against the real service from a test.
 */
function runSnapshotSequence(cwd: string, date: string): void {
  sh('git rm -r --cached --ignore-unmatch node_modules', cwd);
  sh('rm -rf node_modules', cwd);
  const dirty = sh(`git status --porcelain -- . ':!manager.db' ':!*.db' ':!pnpm-lock.yaml' ':!node_modules'`, cwd).trim();
  if (dirty) {
    sh(
      `git stash push -u -m 'WIP snapshot before manager redeploy' -- . ':!manager.db' ':!*.db' ':!pnpm-lock.yaml' ':!node_modules'`,
      cwd,
    );
    const stashSha = sh('git rev-parse stash@{0}', cwd).trim();
    sh(`git branch -f wip/pre-redeploy-snapshot-${date} ${stashSha}`, cwd);
  }
  sh('git restore --staged --worktree node_modules 2>/dev/null || true', cwd);
}

describe('deploy-freshness-watchdog — node_modules symlink switch-failure regression (2026-07-03/04)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'watchdog-nm-repo-'));
    sh('git init -q -b main', repo);
    sh('git config user.email test@example.com', repo);
    sh('git config user.name test', repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    // Reproduce the actual tracked shape: node_modules committed as a
    // symlink blob, exactly what `git ls-tree` shows on origin/main today.
    // Point it at a real existing target (mirroring production, where it
    // points at the canonical checkout's real node_modules) rather than a
    // dangling one — see materializeNpmCi()'s comment for why that matters.
    symlinkSync(repo, join(repo, 'node_modules'));
    sh('git add README.md node_modules', repo);
    sh('git commit -q -m init', repo);

    // Simulate "an earlier watchdog check already ran today, before this
    // fix": the WIP snapshot branch for today already exists, and — because
    // the OLD `git add -A` had no node_modules exclusion pathspec — its
    // snapshot commit captured the fully materialized real node_modules
    // directory as tracked content. Every later same-day check that finds
    // the checkout dirty falls back to `git switch <existing-branch>`
    // instead of `-c`, and that fallback conflicting with node_modules is
    // the exact path that broke in production.
    sh('git switch -c wip/pre-redeploy-snapshot-20260704', repo);
    sh('rm -rf node_modules', repo);
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'pkg.js'), 'content-v1');
    sh('git add -A', repo); // the OLD, unfixed add — no node_modules exclusion
    sh('git commit -q -m "WIP snapshot (pre-fix, unfixed)"', repo);
    sh('git switch main', repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * Simulates `npm ci`: replaces whatever is at node_modules (symlink or
   * nothing) with a real directory.
   *
   * Uses a real shell `rm -rf` (matching how the fix itself clears
   * node_modules — and how `npm ci` behaves) rather than `fs.rmSync`: under
   * Node 23 (the manager/test-runner ABI here), `fs.rmSync(path, {force,
   * recursive})` silently no-ops on a symlink whose target doesn't exist,
   * because it stats through the link to decide directory-vs-file handling
   * and gives up when that stat fails — it doesn't fall back to unlinking
   * the symlink itself. Shelling out sidesteps that Node-version quirk
   * entirely and is what actually runs in production anyway.
   */
  function materializeNpmCi(): void {
    sh('rm -rf node_modules', repo);
    mkdirSync(join(repo, 'node_modules'));
    // Different content than the poisoned WIP branch's snapshot (a fresh
    // `npm ci` naturally differs run-to-run — new lockfile resolution,
    // timestamps, etc.) so the switch has something concrete to conflict on.
    writeFileSync(join(repo, 'node_modules', 'pkg.js'), 'content-v2-different');
  }

  it('fails without the fix — reproduces the production error class', () => {
    materializeNpmCi();
    // Pre-fix behavior: attempt the same-day fallback switch directly, with
    // no untrack/clear step first. `-c` fails silently (branch exists,
    // redirected to /dev/null exactly as production does), so this is the
    // `git switch <existing-branch>` fallback tripping on node_modules. Git
    // phrases this one of two ways depending on the exact tracked-vs-real
    // mismatch shape; both are the same underlying failure class production
    // hit repeatedly on 2026-07-03/04.
    expect(() =>
      sh(
        'git switch -c wip/pre-redeploy-snapshot-20260704 2>/dev/null || git switch wip/pre-redeploy-snapshot-20260704',
        repo,
      ),
    ).toThrow(/node_modules/);
  });

  it('the fixed sequence succeeds twice back-to-back, node_modules always clean (2026-07-04 fallback-branch-reuse path)', () => {
    const date = '20260704';
    for (let i = 0; i < 2; i++) {
      materializeNpmCi();

      expect(() => runSnapshotSequence(repo, date)).not.toThrow();

      const status = sh('git status --porcelain', repo);
      expect(status).not.toMatch(/node_modules/);

      // Land back on `main`, where node_modules is still tracked (this test
      // never purges it from `main` — only the watchdog's own working
      // state), so the next iteration re-triggers the identical
      // same-day-fallback shape from a clean start.
      sh('git switch main', repo);
    }
  });
});

describe('deploy-freshness-watchdog — dirty checkout snapshot does not switch to stale WIP branch', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'watchdog-dirty-repo-'));
    sh('git init -q -b main', repo);
    sh('git config user.email test@example.com', repo);
    sh('git config user.name test', repo);
    mkdirSync(join(repo, 'src', 'dispatch-scheduler'), { recursive: true });
    writeFileSync(join(repo, 'src', 'dispatch-scheduler', 'types.ts'), 'base\n');
    sh('git add src/dispatch-scheduler/types.ts', repo);
    sh('git commit -q -m init', repo);

    sh('git switch -c wip/pre-redeploy-snapshot-20260707', repo);
    writeFileSync(join(repo, 'src', 'dispatch-scheduler', 'types.ts'), 'old snapshot\n');
    sh('git add src/dispatch-scheduler/types.ts', repo);
    sh('git commit -q -m "old snapshot branch"', repo);
    sh('git switch main', repo);

    writeFileSync(join(repo, 'src', 'dispatch-scheduler', 'types.ts'), 'dirty production work\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reproduces the pre-fix conflict when switching to the existing WIP branch', () => {
    expect(() =>
      sh(
        'git switch -c wip/pre-redeploy-snapshot-20260707 2>/dev/null || git switch wip/pre-redeploy-snapshot-20260707',
        repo,
      ),
    ).toThrow(/src\/dispatch-scheduler\/types\.ts/);
  });

  it('preserves dirty work without switching, leaving the checkout clean for deploy branch reset', () => {
    expect(() => runSnapshotSequence(repo, '20260707')).not.toThrow();

    expect(sh('git status --porcelain', repo)).toBe('');
    const wipTip = sh('git rev-parse wip/pre-redeploy-snapshot-20260707', repo).trim();
    const stashTip = sh('git rev-parse stash@{0}', repo).trim();
    expect(wipTip).toBe(stashTip);
  });
});
