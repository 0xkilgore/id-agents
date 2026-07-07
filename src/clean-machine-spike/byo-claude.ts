// SPDX-License-Identifier: MIT
//
// Clean-machine spike — R1 "BYO-Claude credential-in-bundle".
//
// The make-or-break packaging risk (spec §"Pass / fail signals"): can a new
// user supply their OWN Claude credentials/subscription from inside the bundled
// app, with no previous-operator paths and no non-Claude providers? This module
// encodes WHERE the packaged local manager resolves a Claude credential from,
// mirroring the two shipping auth seams so the probe proves the *shipping*
// handoff rather than a parallel re-implementation:
//
//   - subscription (claude-code-cli / claude-code-local): the Claude Code CLI's
//     own login, injected by the Tauri sidecar from the user's keychain as
//     CLAUDE_CODE_OAUTH_TOKEN, with the login store located by CLAUDE_CONFIG_DIR
//     (else <HOME>/.claude) and the `claude` binary by CLAUDE_PATH (else PATH).
//     This is the BYO-subscription path Kapelle sells: the user runs `claude
//     login` once; the bundle inherits it (harness/claude-code-cli.ts:176 —
//     "inherit user's env for auth").
//   - api key (claude-agent-sdk): ANTHROPIC_API_KEY in the app-local env
//     (runtime/registry.ts, start-agent-manager.ts).
//
// The probe runs WITHOUT real secrets: it detects the *presence* of a credential
// handoff (a non-empty env seam), never the secret's validity, scans any resolved
// credential location for private-machine path leaks (shared with the R2 scan),
// and fails clearly — documenting the required handoff — when none is configured.
// Non-Claude providers (OpenRouter/Cursor/Codex) never satisfy the Claude requirement.
//
// Following the §F "research-as-build → eval-as-code" precedent, the R1 signal is
// a reproducible, CI-gated predicate rather than a one-off manual check.

import path from 'node:path';
import {
  privateMachinePathMarkersFor,
  currentHome,
  type PrivateMachinePathFinding,
} from './boot-config.js';

export type ClaudeCredentialKind = 'subscription_cli' | 'api_key';

export interface ClaudeCredentialSource {
  kind: ClaudeCredentialKind;
  /** The env seam that carries the handoff (presence is checked; value never is). */
  seam: string;
  /** Filesystem location backing the credential (the CLI login store), scanned
   *  for private-machine leaks; null for the pure-env API-key path. */
  location: string | null;
  /** One-line description of the required handoff, surfaced when absent. */
  handoff: string;
}

export interface ByoClaudeProbeResult {
  /** R1 PASS: ≥1 clean Claude credential handoff is present. */
  ok: boolean;
  /** Every Claude credential handoff detected in the env. */
  sources: ClaudeCredentialSource[];
  /** Private-machine path leaks in a resolved credential location (must be empty for PASS). */
  privateMachinePathFindings: PrivateMachinePathFinding[];
  /** Why the probe failed + the handoff to provide; null when ok. */
  reason: string | null;
}

/** True when an env var is present and non-empty (a usable handoff signal). */
function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  return (env[key]?.trim().length ?? 0) > 0;
}

/** The Claude Code CLI login-store directory the sidecar would hand off. */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(currentHome(env), '.claude');
}

/**
 * Detect every Claude credential handoff declared in the env, in priority order
 * (subscription first — the path Kapelle sells). Pure and secret-free: only the
 * presence of each seam is read.
 */
export function resolveClaudeCredentialSources(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCredentialSource[] {
  const sources: ClaudeCredentialSource[] = [];

  // Subscription: the user's Claude Code login, injected as an OAuth token from
  // their keychain by the bundle. The login store is CLAUDE_CONFIG_DIR/<HOME>/.claude.
  if (isSet(env, 'CLAUDE_CODE_OAUTH_TOKEN')) {
    sources.push({
      kind: 'subscription_cli',
      seam: 'CLAUDE_CODE_OAUTH_TOKEN',
      location: resolveClaudeConfigDir(env),
      handoff:
        'Bundle injects the user\'s Claude Code subscription token as ' +
        'CLAUDE_CODE_OAUTH_TOKEN (from their keychain after `claude login`); ' +
        'login store at CLAUDE_CONFIG_DIR (else ~/.claude).',
    });
  }

  // API key: app-local ANTHROPIC_API_KEY (the SDK runtime path).
  if (isSet(env, 'ANTHROPIC_API_KEY')) {
    sources.push({
      kind: 'api_key',
      seam: 'ANTHROPIC_API_KEY',
      location: null,
      handoff: 'User provides ANTHROPIC_API_KEY in the app-local env (claude-agent-sdk).',
    });
  }

  return sources;
}

/** The required-handoff documentation surfaced when no credential is present. */
export const BYO_CLAUDE_REQUIRED_HANDOFF =
  'No Claude credential handoff found. Connect Claude in Kapelle first-run setup, ' +
  'which stores the user\'s Claude subscription token in their keychain and injects ' +
  'CLAUDE_CODE_OAUTH_TOKEN for the bundled manager. Advanced/local fallback: provide ' +
  'ANTHROPIC_API_KEY in the app-local env. ' +
  'Non-Claude providers (OpenRouter/Cursor/Codex) do not satisfy the Claude-only requirement.';

/**
 * R1 probe: does the packaged manager have a clean, Claude-only credential handoff
 * a new user can supply? PASS when >=1 handoff is present with no private-machine
 * leak in its resolved location. Runs without real secrets; the empty-env case
 * is a clear, documented FAIL.
 */
export function probeByoClaudeCredential(
  env: NodeJS.ProcessEnv = process.env,
): ByoClaudeProbeResult {
  const sources = resolveClaudeCredentialSources(env);

  const privateMachinePathFindings: PrivateMachinePathFinding[] = [];
  for (const source of sources) {
    if (source.location == null) continue;
    for (const marker of privateMachinePathMarkersFor(source.location, env)) {
      // Reuse the R2 finding shape; the "field" is the credential seam.
      privateMachinePathFindings.push({
        field: 'idAgentsHome',
        value: source.location,
        marker,
      });
    }
  }

  if (sources.length === 0) {
    return { ok: false, sources, privateMachinePathFindings, reason: BYO_CLAUDE_REQUIRED_HANDOFF };
  }
  if (privateMachinePathFindings.length > 0) {
    const leaked = privateMachinePathFindings.map((f) => `${f.value} (${f.marker})`).join(', ');
    return {
      ok: false,
      sources,
      privateMachinePathFindings,
      reason: `Claude credential location leaks a private-machine path: ${leaked}.`,
    };
  }
  return { ok: true, sources, privateMachinePathFindings, reason: null };
}

/** True when a new user can supply Claude credentials from the bundle (R1 PASS). */
export function isByoClaudeCredentialReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return probeByoClaudeCredential(env).ok;
}
