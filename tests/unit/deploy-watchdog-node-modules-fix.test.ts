// Regression coverage for the 2026-07-08 hygiene rule: deploy watchdog must
// not mutate the primary feature checkout to rebuild the manager. Dirty or
// off-main primary work is preserved and reported as hygiene-blocked; rebuilds
// happen from a dedicated clean main deploy checkout.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_SRC = readFileSync(
  join(__dirname, '../../scripts/deploy-freshness-watchdog.mjs'),
  'utf8',
);
const WATCHDOG_PLIST_SRC = readFileSync(
  join(__dirname, '../../scripts/launchd/com.kilgore.deploy-freshness-watchdog.plist'),
  'utf8',
);

describe('deploy-freshness-watchdog source — clean deploy checkout hygiene', () => {
  it('does not snapshot or switch the primary checkout', () => {
    expect(WATCHDOG_SRC).not.toContain('git stash push');
    expect(WATCHDOG_SRC).not.toContain('wip/pre-redeploy-snapshot');
    expect(WATCHDOG_SRC).not.toContain('git switch -c wip/pre-redeploy-snapshot');
  });

  it('defaults to a dedicated deploy checkout and reports primary hygiene blocks', () => {
    expect(WATCHDOG_SRC).toContain('DEPLOY_WATCHDOG_PRIMARY_REPO');
    expect(WATCHDOG_SRC).toContain('id-agents-deploy-main');
    expect(WATCHDOG_SRC).toContain('deployCheckoutExists');
    expect(WATCHDOG_SRC).toContain('managerPlistPointsAtDeployCheckout');
    expect(WATCHDOG_SRC).toContain('HYGIENE-BLOCKED repo=');
    expect(WATCHDOG_SRC).toContain('dirty_count=');
    expect(WATCHDOG_SRC).toContain('next_action=preserve primary work; rebuild from clean deploy checkout');
  });

  it('routes launchd manager restart to the deploy checkout', () => {
    expect(WATCHDOG_SRC).toContain('ensureManagerPlistUsesDeployCheckout');
    expect(WATCHDOG_SRC).toContain('Set :WorkingDirectory ${CANE}');
    expect(WATCHDOG_SRC).toContain('Set :ProgramArguments:1 ${CANE}/scripts/start-id-agents-manager.sh');
    expect(WATCHDOG_SRC).toContain('launchctl bootstrap gui/$(id -u) ${PLIST}');
  });

  it('runs the launchd watchdog itself from the clean deploy checkout', () => {
    expect(WATCHDOG_PLIST_SRC).toContain('/Users/kilgore/Dropbox/Code/cane/id-agents-deploy-main/scripts/deploy-freshness-watchdog.mjs');
    expect(WATCHDOG_PLIST_SRC).not.toContain('/Users/kilgore/Dropbox/Code/cane/id-agents/scripts/deploy-freshness-watchdog.mjs');
  });
});

describe('manager-promote-rebuild-restart source — clean deploy checkout hygiene', () => {
  const WRAPPER_SRC = readFileSync('/Users/kilgore/Dropbox/Code/cane/scripts/manager-promote-rebuild-restart.sh', 'utf8');

  it('uses a deploy checkout and reports primary hygiene blocks', () => {
    expect(WRAPPER_SRC).toContain('PRIMARY_ID_AGENTS=');
    expect(WRAPPER_SRC).toContain('ID_AGENTS_DEPLOY');
    expect(WRAPPER_SRC).toContain('id-agents-deploy-main');
    expect(WRAPPER_SRC).toContain('HYGIENE-BLOCKED repo=$PRIMARY_ID_AGENTS branch=$branch dirty_count=$dirty_count');
  });

  it('reloads launchd from the deploy checkout plist configuration', () => {
    expect(WRAPPER_SRC).toContain('ensure_manager_plist_uses_deploy_checkout');
    expect(WRAPPER_SRC).toContain('Set :WorkingDirectory $ID_AGENTS');
    expect(WRAPPER_SRC).toContain('Set :ProgramArguments:1 $ID_AGENTS/scripts/start-id-agents-manager.sh');
    expect(WRAPPER_SRC).toContain('launchctl bootstrap "gui/$(id -u)" "$PLIST"');
  });
});
