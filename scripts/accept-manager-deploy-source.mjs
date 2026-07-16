#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import {
  getShaFreshness,
  resolveDeployConfigPath,
  runDeploySourceAcceptance,
} from './lib/deploy-source-acceptance.mjs';

const HOME = process.env.HOME || '/Users/kilgore';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const deployRepo = String(args['deploy-repo'] ?? process.env.DEPLOY_WATCHDOG_REPO ?? `${HOME}/Dropbox/Code/cane/id-agents-deploy-main`);
const primaryRepo = String(args['primary-repo'] ?? process.env.DEPLOY_WATCHDOG_PRIMARY_REPO ?? `${HOME}/Dropbox/Code/cane/id-agents`);
const configRef = args.config ? String(args.config) : 'configs/default.yaml';
const expectedBranch = String(args.branch ?? 'main');
const remoteRef = String(args['remote-ref'] ?? 'origin/main');

try {
  const result = runDeploySourceAcceptance({
    deployRepo,
    primaryRepo,
    configRef,
    expectedBranch,
    remoteRef,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let config = null;
  let sha = null;
  try {
    config = resolveDeployConfigPath({ deployRepo, primaryRepo, configRef });
  } catch (configError) {
    config = { error: configError instanceof Error ? configError.message : String(configError) };
  }
  try {
    sha = getShaFreshness(deployRepo, remoteRef);
  } catch (shaError) {
    sha = { error: shaError instanceof Error ? shaError.message : String(shaError) };
  }
  console.error(JSON.stringify({
    ok: false,
    error: message,
    deploy_checkout: deployRepo,
    config_path: config?.config_path ?? null,
    config_ref: configRef,
    current_sha_freshness: sha,
    refused_rebuild_reset_paths: /refusing rebuild-reset/.test(message),
  }, null, 2));
  process.exitCode = 1;
}
