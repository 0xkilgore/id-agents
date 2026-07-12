// SPDX-License-Identifier: MIT
//
// Worktree hygiene guard for the deploy watchdog. The watchdog may rebuild and
// restart the live manager, so it must not silently build from local edits.

import { execFileSync } from 'node:child_process';

export const DEFAULT_HYGIENE_REMEDIATION =
  'Commit or move these changes to a separate branch/worktree, or set DEPLOY_WATCHDOG_ALLOW_DIRTY_CHECKOUT=1 for an intentional dirty deploy.';

export function gitOutput(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function repoBranch(repo) {
  try {
    return gitOutput(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function parsePorcelainFiles(statusText) {
  if (!statusText.trim()) return [];
  return statusText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export function getWorktreeHygiene(repo) {
  const branch = repoBranch(repo);
  const status = gitOutput(repo, ['status', '--porcelain', '--untracked-files=all']);
  const changedFiles = parsePorcelainFiles(status);
  return {
    repo,
    branch,
    dirty: changedFiles.length > 0,
    dirtyCount: changedFiles.length,
    changedFiles,
  };
}

export function formatChangedFiles(changedFiles, limit = 20) {
  if (changedFiles.length === 0) return 'none';
  const visible = changedFiles.slice(0, limit).join(', ');
  const remaining = changedFiles.length - limit;
  return remaining > 0 ? `${visible}, ... (${remaining} more)` : visible;
}

export function formatWorktreeHygieneFailure({
  repo,
  branch,
  expectedBranch = 'main',
  changedFiles = [],
  purpose = 'deploy watchdog rebuild/restart/promotion',
  remediation = DEFAULT_HYGIENE_REMEDIATION,
}) {
  const problems = [];
  if (branch !== expectedBranch) problems.push(`branch=${branch} (expected ${expectedBranch})`);
  if (changedFiles.length > 0) {
    problems.push(`dirty_files=${changedFiles.length} [${formatChangedFiles(changedFiles)}]`);
  }
  return [
    `worktree hygiene blocked ${purpose}`,
    `repo=${repo}`,
    problems.join('; '),
    `remediation=${remediation}`,
  ].filter(Boolean).join(' ');
}

export function assertCleanDeployCheckout({
  repo,
  expectedBranch = 'main',
  allowDirty = false,
  purpose,
  remediation,
}) {
  const hygiene = getWorktreeHygiene(repo);
  const wrongBranch = hygiene.branch !== expectedBranch;
  const dirty = hygiene.changedFiles.length > 0;
  if (wrongBranch || (dirty && !allowDirty)) {
    throw new Error(formatWorktreeHygieneFailure({
      repo,
      branch: hygiene.branch,
      expectedBranch,
      changedFiles: hygiene.changedFiles,
      purpose,
      remediation,
    }));
  }
  return hygiene;
}
