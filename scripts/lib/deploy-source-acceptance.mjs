// SPDX-License-Identifier: MIT
//
// Acceptance helper for the manager deploy source invariant: deploy config and
// rebuild source must come from the single clean deploy checkout, not from the
// dirty primary developer checkout.

import { existsSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertCleanDeployCheckout,
  formatChangedFiles,
  getWorktreeHygiene,
  gitOutput,
} from './deploy-watchdog-worktree-hygiene.mjs';

const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const REBUILD_RESET_PATTERN = /(?:^|[/\\])(?:manager-promote-rebuild-restart|.*(?:rebuild|reset|restart).*)$/i;

function realpathIfExists(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isInside(parent, child) {
  const rel = relative(realpathIfExists(parent), realpathIfExists(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function candidateConfigPaths(deployRepo, configRef) {
  if (isAbsolute(configRef)) return [configRef];
  const direct = resolve(deployRepo, configRef);
  const ext = extname(configRef);
  if (ext) return [direct];
  return [
    resolve(deployRepo, configRef),
    resolve(deployRepo, 'configs', `${configRef}.yaml`),
    resolve(deployRepo, 'configs', `${configRef}.yml`),
    resolve(deployRepo, 'configs', `${configRef}.json`),
  ];
}

export function resolveDeployConfigPath({ deployRepo, primaryRepo, configRef }) {
  if (!configRef || typeof configRef !== 'string') {
    throw new Error('deploy source acceptance requires --config <path-or-config-name>');
  }

  const deployRoot = realpathIfExists(deployRepo);
  const primaryRoot = primaryRepo ? realpathIfExists(primaryRepo) : null;
  const candidates = candidateConfigPaths(deployRoot, configRef);
  const configPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  const normalized = realpathIfExists(configPath);
  const rel = relative(deployRoot, normalized).split(sep).join('/');
  const ext = extname(normalized).toLowerCase();

  if (!CONFIG_EXTENSIONS.has(ext)) {
    throw new Error(
      `refusing rebuild-reset deploy source path: config must be .yaml, .yml, or .json; got ${configRef}`,
    );
  }
  if (REBUILD_RESET_PATTERN.test(configRef) || REBUILD_RESET_PATTERN.test(rel)) {
    throw new Error(`refusing rebuild-reset deploy source path: ${configRef}`);
  }
  if (!isInside(deployRoot, normalized)) {
    throw new Error(`deploy config must resolve inside deploy checkout; config_path=${normalized} deploy_checkout=${deployRoot}`);
  }
  if (primaryRoot && isInside(primaryRoot, normalized) && primaryRoot !== deployRoot) {
    throw new Error(`deploy config resolved inside dirty primary checkout; config_path=${normalized} primary_checkout=${primaryRoot}`);
  }

  return {
    config_path: normalized,
    config_ref: configRef,
    deploy_relative_path: rel,
  };
}

export function getShaFreshness(repo, remoteRef = 'origin/main') {
  const head = gitOutput(repo, ['rev-parse', 'HEAD']);
  let target = null;
  try {
    target = gitOutput(repo, ['rev-parse', remoteRef]);
  } catch {
    target = null;
  }
  return {
    head_sha: head,
    target_ref: remoteRef,
    target_sha: target,
    fresh: Boolean(target && head === target),
  };
}

export function runDeploySourceAcceptance({
  deployRepo,
  primaryRepo,
  configRef,
  expectedBranch = 'main',
  remoteRef = 'origin/main',
  allowDirtyDeploy = false,
}) {
  const deploy_checkout = realpathIfExists(deployRepo);
  const primary_checkout = primaryRepo ? realpathIfExists(primaryRepo) : null;
  const config = resolveDeployConfigPath({ deployRepo: deploy_checkout, primaryRepo: primary_checkout, configRef });
  const deployHygiene = assertCleanDeployCheckout({
    repo: deploy_checkout,
    expectedBranch,
    allowDirty: allowDirtyDeploy,
    purpose: 'manager deploy source acceptance',
  });
  const sha = getShaFreshness(deploy_checkout, remoteRef);
  if (!sha.fresh) {
    throw new Error(
      `deploy checkout SHA is stale; deploy_checkout=${deploy_checkout} head_sha=${sha.head_sha} ${remoteRef}=${sha.target_sha ?? 'unavailable'}`,
    );
  }

  const primaryHygiene = primary_checkout && existsSync(join(primary_checkout, '.git'))
    ? getWorktreeHygiene(primary_checkout)
    : null;

  return {
    ok: true,
    deploy_checkout,
    config_path: config.config_path,
    config_ref: config.config_ref,
    current_sha_freshness: sha,
    deploy_hygiene: {
      branch: deployHygiene.branch,
      dirty: deployHygiene.dirty,
      dirty_count: deployHygiene.dirtyCount,
      changed_files: deployHygiene.changedFiles,
    },
    primary_checkout: primary_checkout
      ? {
          path: primary_checkout,
          branch: primaryHygiene?.branch ?? 'missing',
          dirty: primaryHygiene?.dirty ?? null,
          dirty_count: primaryHygiene?.dirtyCount ?? null,
          changed_files: primaryHygiene ? formatChangedFiles(primaryHygiene.changedFiles) : 'missing',
          used_for_deploy: false,
        }
      : null,
    refused_rebuild_reset_paths: true,
  };
}
