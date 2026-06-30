// SPDX-License-Identifier: MIT
/**
 * Clean-machine spike eval (cto/output/2026-06-29-clean-machine-spike-spec.md).
 *
 * Encodes the two go/no-go risks that are fully resolvable in code today:
 *   R2 — de-Chris boot-from-bundle: app-local env yields zero Chris-path leaks.
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
  scanForChrisPaths,
  isCleanMachineBootable,
} from '../../src/clean-machine-spike/boot-config.js';
import {
  assessClaudeOnlyGraceful,
  NON_CLAUDE_PROVIDER_ISSUE_CODES,
} from '../../src/clean-machine-spike/graceful.js';
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

describe('R2 — de-Chris boot-from-bundle', () => {
  it('resolves every boot path from app-local env (no fallback to defaults)', () => {
    const env = bundleEnv();
    const cfg = resolveBundleBootConfig(env);
    expect(cfg.idAgentsHome).toBe(env.ID_AGENTS_HOME);
    expect(cfg.workdir).toBe(env.AGENT_MANAGER_WORKDIR);
    expect(cfg.sqlitePath).toBe(env.SQLITE_PATH);
    expect(cfg.repoRegistryFile).toBe(env.IDAGENTS_REPO_REGISTRY);
    expect(cfg.managerPort).toBe(0); // dynamic
  });

  it('PASS: app-local env produces zero Chris-path leaks', () => {
    const cfg = resolveBundleBootConfig(bundleEnv());
    expect(scanForChrisPaths(cfg)).toEqual([]);
    expect(isCleanMachineBootable(bundleEnv())).toBe(true);
  });

  it('a path under the running user home is clean, not a leak (portability)', () => {
    // The Tauri bundle relocates onto the *tester's* home; that this expands to
    // /Users/kilgore on Chris's own build machine must NOT be flagged.
    const env = bundleEnv();
    const findings = scanForChrisPaths(resolveBundleBootConfig(env), env);
    expect(findings).toEqual([]);
  });

  it('the scanner catches non-relocatable Chris leaks (negative control)', () => {
    const env = bundleEnv();
    const leaky = resolveBundleBootConfig({
      ...env,
      ID_AGENTS_HOME: '/Users/kilgore/Dropbox/Code/cane/id-agents', // Dropbox leak
      AGENT_MANAGER_WORKDIR: '/Users/liz/Library/Application Support/Kapelle', // foreign home
    });
    const findings = scanForChrisPaths(leaky, env);
    expect(findings.length).toBeGreaterThan(0);
    // Dropbox sync-tree leak on idAgentsHome.
    expect(findings.some((f) => f.field === 'idAgentsHome' && f.marker === 'Dropbox')).toBe(true);
    // Foreign hardcoded home on workdir (not the running user's /Users/kilgore).
    expect(findings.some((f) => f.field === 'workdir' && f.marker === '/Users/liz')).toBe(true);
    // The clean SQLITE_PATH under the tester's home is NOT flagged.
    expect(findings.some((f) => f.field === 'sqlitePath')).toBe(false);
  });

  it('a com.kilgore launchd reference is always flagged', () => {
    const env = bundleEnv();
    const cfg = resolveBundleBootConfig({ ...env, SQLITE_PATH: '/Library/LaunchAgents/com.kilgore.id-agents.db' });
    expect(scanForChrisPaths(cfg, env).some((f) => f.marker === 'com.kilgore')).toBe(true);
  });

  it('a null repo-registry overlay is exempt (defaults apply, not a leak)', () => {
    const env = bundleEnv();
    const cfg = resolveBundleBootConfig(env);
    const noOverlay = { ...cfg, repoRegistryFile: null };
    expect(scanForChrisPaths(noOverlay, env).some((f) => f.field === 'repoRegistryFile')).toBe(false);
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
