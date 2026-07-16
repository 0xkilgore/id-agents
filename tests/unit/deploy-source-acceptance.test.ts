// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM module (no d.ts); imported for runtime behavior.
import {
  resolveDeployConfigPath,
  runDeploySourceAcceptance,
} from '../../scripts/lib/deploy-source-acceptance.mjs';

const roots: string[] = [];

function git(repo: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(prefix: string) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  roots.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'deploy-source@example.invalid']);
  git(repo, ['config', 'user.name', 'Deploy Source Acceptance Test']);
  mkdirSync(join(repo, 'configs'));
  writeFileSync(join(repo, 'configs', 'default.yaml'), 'version: 1\nagents: []\n');
  git(repo, ['add', 'configs/default.yaml']);
  git(repo, ['commit', '-m', 'initial deploy config']);
  return repo;
}

function addOriginMain(repo: string) {
  const bare = mkdtempSync(join(tmpdir(), 'deploy-source-remote-'));
  roots.push(bare);
  git(bare, ['init', '--bare', '-b', 'main']);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['fetch', 'origin', 'main']);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('manager deploy source acceptance', () => {
  it('prints executable evidence for deploy checkout, config path, SHA freshness, and dirty primary non-use', () => {
    const deploy = makeRepo('deploy-source-clean-');
    addOriginMain(deploy);
    const primary = makeRepo('deploy-source-primary-');
    writeFileSync(join(primary, 'README.md'), 'dirty primary work\n');

    const result = runDeploySourceAcceptance({
      deployRepo: deploy,
      primaryRepo: primary,
      configRef: 'default',
    });

    expect(result.ok).toBe(true);
    expect(result.deploy_checkout).toBe(realpathSync(deploy));
    expect(result.config_path).toBe(realpathSync(join(deploy, 'configs', 'default.yaml')));
    expect(result.current_sha_freshness).toMatchObject({
      target_ref: 'origin/main',
      fresh: true,
    });
    expect(result.current_sha_freshness.head_sha).toBe(result.current_sha_freshness.target_sha);
    expect(result.deploy_hygiene).toMatchObject({ branch: 'main', dirty: false, dirty_count: 0 });
    expect(result.primary_checkout).toMatchObject({
      path: realpathSync(primary),
      dirty: true,
      used_for_deploy: false,
    });
    expect(result.refused_rebuild_reset_paths).toBe(true);
  });

  it('refuses config paths that resolve inside the primary checkout', () => {
    const deploy = makeRepo('deploy-source-clean-');
    addOriginMain(deploy);
    const primary = makeRepo('deploy-source-primary-');

    expect(() =>
      resolveDeployConfigPath({
        deployRepo: deploy,
        primaryRepo: primary,
        configRef: join(primary, 'configs', 'default.yaml'),
      }),
    ).toThrow(/inside deploy checkout/);
  });

  it('refuses rebuild-reset script paths instead of treating them as deploy config', () => {
    const deploy = makeRepo('deploy-source-clean-');
    writeFileSync(join(deploy, 'manager-promote-rebuild-restart.sh'), '#!/usr/bin/env bash\n');

    expect(() =>
      resolveDeployConfigPath({
        deployRepo: deploy,
        primaryRepo: null,
        configRef: 'manager-promote-rebuild-restart.sh',
      }),
    ).toThrow(/refusing rebuild-reset deploy source path/);
  });

  it('fails when the deploy checkout is behind origin/main', () => {
    const deploy = makeRepo('deploy-source-clean-');
    addOriginMain(deploy);
    writeFileSync(join(deploy, 'configs', 'other.yaml'), 'version: 1\nagents: []\n');
    git(deploy, ['add', 'configs/other.yaml']);
    git(deploy, ['commit', '-m', 'advance local only']);
    git(deploy, ['reset', '--hard', 'HEAD~1']);

    const clone = mkdtempSync(join(tmpdir(), 'deploy-source-updater-'));
    roots.push(clone);
    git(clone, ['clone', git(deploy, ['remote', 'get-url', 'origin']), '.']);
    git(clone, ['config', 'user.email', 'deploy-source@example.invalid']);
    git(clone, ['config', 'user.name', 'Deploy Source Acceptance Test']);
    writeFileSync(join(clone, 'configs', 'default.yaml'), 'version: 1\nagents:\n  - name: newer\n');
    git(clone, ['add', 'configs/default.yaml']);
    git(clone, ['commit', '-m', 'advance origin']);
    git(clone, ['push', 'origin', 'main']);
    git(deploy, ['fetch', 'origin', 'main']);

    expect(() =>
      runDeploySourceAcceptance({
        deployRepo: deploy,
        primaryRepo: null,
        configRef: 'default',
      }),
    ).toThrow(/deploy checkout SHA is stale/);
  });
});
