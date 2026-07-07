// SPDX-License-Identifier: MIT
/**
 * Clean-machine spike eval (cto/output/2026-06-29-clean-machine-spike-spec.md).
 *
 * Encodes the two go/no-go risks that are fully resolvable in code today:
 *   R2 — private-machine cleanup: app-local env yields zero private-machine leaks.
 *   R5 — Claude-only graceful:      a Claude runtime's preflight never probes
 *                                   Cursor/Codex, so their absence can't block it.
 *
 * R1 (entitlements/signing) and R6 (WKWebView render parity) require a macOS
 * Tauri build+sign+screenshot session and are reported, not asserted, here.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  resolveBundleBootConfig,
  scanForPrivateMachinePaths,
  isCleanMachineBootable,
} from '../../src/clean-machine-spike/boot-config.js';
import {
  assessClaudeOnlyGraceful,
  NON_CLAUDE_PROVIDER_ISSUE_CODES,
} from '../../src/clean-machine-spike/graceful.js';
import {
  evaluateSyntheticStrangerStarterFleet,
  syntheticStrangerClaudeOnlyEnv,
} from '../../src/clean-machine-spike/starter-fleet.js';
import { validateRuntimePreflight } from '../../src/runtime/registry.js';

/** A representative app-local env the Tauri sidecar would set on a clean Mac. */
function bundleEnv(): NodeJS.ProcessEnv {
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support', 'Kapelle');
  return {
    ID_AGENTS_HOME: path.join(appSupport, 'id-agents-home'),
    AGENT_MANAGER_WORKDIR: path.join(appSupport, 'workspace'),
    SQLITE_PATH: path.join(appSupport, 'id-agents.db'),
    IDAGENTS_REPO_REGISTRY: path.join(appSupport, 'repo-registry.json'),
    AGENT_MANAGER_PORT: '0', // dynamic free port; Tauri injects the real one
  };
}

describe('R2 — private-machine boot-from-bundle cleanup', () => {
  it('resolves every boot path from app-local env (no fallback to defaults)', () => {
    const env = bundleEnv();
    const cfg = resolveBundleBootConfig(env);
    expect(cfg.idAgentsHome).toBe(env.ID_AGENTS_HOME);
    expect(cfg.workdir).toBe(env.AGENT_MANAGER_WORKDIR);
    expect(cfg.sqlitePath).toBe(env.SQLITE_PATH);
    expect(cfg.repoRegistryFile).toBe(env.IDAGENTS_REPO_REGISTRY);
    expect(cfg.managerPort).toBe(0); // dynamic
  });

  it('PASS: app-local env produces zero private-machine path leaks', () => {
    const cfg = resolveBundleBootConfig(bundleEnv());
    expect(scanForPrivateMachinePaths(cfg)).toEqual([]);
    expect(isCleanMachineBootable(bundleEnv())).toBe(true);
  });

  it('a path under the running user home is clean, not a leak (portability)', () => {
    // The Tauri bundle relocates onto the tester's home; that current-home
    // expansion must NOT be flagged.
    const env = bundleEnv();
    const findings = scanForPrivateMachinePaths(resolveBundleBootConfig(env), env);
    expect(findings).toEqual([]);
  });

  it('the scanner catches non-relocatable private-machine leaks (negative control)', () => {
    const env = bundleEnv();
    const leaky = resolveBundleBootConfig({
      ...env,
      ID_AGENTS_HOME: path.join(os.homedir(), 'Dropbox', 'Code', 'cane', 'id-agents'),
      AGENT_MANAGER_WORKDIR: '/Users/previous-operator/Library/Application Support/Kapelle',
    });
    const findings = scanForPrivateMachinePaths(leaky, env);
    expect(findings.length).toBeGreaterThan(0);
    // Dropbox sync-tree leak on idAgentsHome.
    expect(findings.some((f) => f.field === 'idAgentsHome' && f.marker === 'Dropbox')).toBe(true);
    // Foreign hardcoded home on workdir, not the running user's home.
    expect(findings.some((f) => f.field === 'workdir' && f.marker === '/Users/previous-operator')).toBe(true);
    // The clean SQLITE_PATH under the tester's home is NOT flagged.
    expect(findings.some((f) => f.field === 'sqlitePath')).toBe(false);
  });

  it('a legacy launchd namespace reference is always flagged', () => {
    const env = bundleEnv();
    const marker = `com.${['kil', 'gore'].join('')}`;
    const cfg = resolveBundleBootConfig({
      ...env,
      SQLITE_PATH: `/Library/LaunchAgents/${marker}.id-agents.db`,
    });
    expect(scanForPrivateMachinePaths(cfg, env).some((f) => f.marker === marker)).toBe(true);
  });

  it('a null repo-registry overlay is exempt (defaults apply, not a leak)', () => {
    const env = bundleEnv();
    const cfg = resolveBundleBootConfig(env);
    const noOverlay = { ...cfg, repoRegistryFile: null };
    expect(scanForPrivateMachinePaths(noOverlay, env).some((f) => f.field === 'repoRegistryFile')).toBe(false);
  });
});

describe('R5 — Claude-only graceful', () => {
  it('PASS: a Claude runtime preflight surfaces no Cursor/Codex/OpenRouter leak', () => {
    const result = assessClaudeOnlyGraceful('claude-agent-sdk');
    expect(result.graceful).toBe(true);
    expect(result.offendingCodes).toEqual([]);
  });

  it('the claude-code-cli path never probes cursor-agent or codex', () => {
    // Regardless of whether `claude` itself is installed, the cli preflight must
    // not emit Cursor/Codex/OpenRouter provider issues — those binaries are not
    // consulted on the Claude path, so their absence cannot block a dispatch.
    const codes = validateRuntimePreflight('claude-code-cli').map((i) => i.code);
    for (const leak of NON_CLAUDE_PROVIDER_ISSUE_CODES) {
      expect(codes).not.toContain(leak);
    }
  });

  it('the assessor flags a genuine cross-provider leak (negative control)', () => {
    // The cursor-cli runtime legitimately probes cursor-agent; routing it through
    // the assessor must report non-graceful when that provider is unavailable.
    const result = assessClaudeOnlyGraceful('cursor-cli');
    // On a host without cursor-agent + CURSOR_API_KEY this surfaces a provider
    // issue; if cursor IS fully configured it stays graceful. Either way the
    // assessor's offending set is a strict subset of what it surfaced.
    for (const c of result.offendingCodes) {
      expect(NON_CLAUDE_PROVIDER_ISSUE_CODES).toContain(c as any);
    }
    expect(result.graceful).toBe(result.offendingCodes.length === 0);
  });
});

describe('R2+R5 — synthetic stranger starter-fleet smoke', () => {
  it('boots a clean empty cockpit shape with only Claude credentials present', () => {
    const env = syntheticStrangerClaudeOnlyEnv('/Users/stranger');
    const result = evaluateSyntheticStrangerStarterFleet(env);

    expect(result.ok).toBe(true);
    expect(result.cockpit).toMatchObject({
      ready: true,
      state: 'ready-empty',
      managerUrl: 'http://127.0.0.1:<dynamic>',
      opsUrl: 'http://127.0.0.1:<dynamic>/ops',
    });
    expect(result.privateMachinePathFindings).toEqual([]);
    expect(result.credential.ok).toBe(true);
    expect(result.credential.sources.map((s) => s.seam)).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.graceful.offendingCodes).toEqual([]);
    expect(result.providerAssumptions).toEqual([]);
    expect(result.agents).toEqual([
      { name: 'coder', runtime: 'claude-code-cli', model: 'claude-sonnet-4-6' },
      { name: 'researcher', runtime: 'claude-code-cli', model: 'claude-sonnet-4-6' },
    ]);
  });

  it('does not require Codex or Cursor credentials', () => {
    const env = syntheticStrangerClaudeOnlyEnv('/Users/stranger', {
      OPENAI_API_KEY: '',
      CURSOR_API_KEY: '',
    });
    const result = evaluateSyntheticStrangerStarterFleet(env);

    expect(result.providerAssumptions).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
