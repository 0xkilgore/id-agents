// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import {
  assertCleanDeployCheckout,
  getWorktreeHygiene,
} from '../../scripts/lib/deploy-watchdog-worktree-hygiene.mjs';

const repos: string[] = [];

function git(repo: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'deploy-watchdog-hygiene-'));
  repos.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'watchdog@example.invalid']);
  git(repo, ['config', 'user.name', 'Deploy Watchdog Test']);
  writeFileSync(join(repo, 'README.md'), 'clean\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('deploy watchdog worktree hygiene guard', () => {
  it('passes a clean main checkout', () => {
    const repo = makeRepo();

    const hygiene = assertCleanDeployCheckout({ repo });

    expect(hygiene).toMatchObject({
      branch: 'main',
      dirty: false,
      dirtyCount: 0,
      changedFiles: [],
    });
  });

  it('blocks dirty checkouts with changed files and remediation', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), 'modified\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'new-file.ts'), 'export {};\n');

    expect(() => assertCleanDeployCheckout({ repo })).toThrowError(
      /worktree hygiene blocked deploy watchdog/,
    );
    expect(() => assertCleanDeployCheckout({ repo })).toThrowError(/README\.md/);
    expect(() => assertCleanDeployCheckout({ repo })).toThrowError(/src\/new-file\.ts/);
    expect(() => assertCleanDeployCheckout({ repo })).toThrowError(/Commit or move these changes/);
  });

  it('ignores ignored files such as node_modules caches', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore node_modules']);
    mkdirSync(join(repo, 'node_modules', 'leftpad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');

    expect(getWorktreeHygiene(repo)).toMatchObject({
      dirty: false,
      dirtyCount: 0,
      changedFiles: [],
    });
    expect(() => assertCleanDeployCheckout({ repo })).not.toThrow();
  });
});
