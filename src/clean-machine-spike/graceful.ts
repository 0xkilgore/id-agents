// SPDX-License-Identifier: MIT
//
// Clean-machine spike — R5 "Claude-only graceful".
//
// PASS signal (spec §"Pass / fail signals"): one dispatch completes with Codex +
// Cursor absent; the manager/agent do NOT crash or stall on a missing
// `cursor-agent`. The fleet degrades to Claude-only.
//
// The relevant invariant in the *shipping* code is that runtime preflight is
// per-runtime: validating a Claude runtime (`claude-code-cli` / `claude-code-local`)
// must never probe the `cursor-agent` or `codex` binaries, so their absence
// cannot block a Claude-only dispatch. This module expresses that invariant as a
// checkable predicate the spike (and CI) can assert.

import { validateRuntimePreflight } from '../runtime/registry.js';

/** Issue codes that ONLY a non-Claude provider runtime can raise. If a Claude
 *  runtime's preflight ever surfaces one of these, a Cursor/Codex/OpenRouter
 *  probe has leaked into the Claude path and R5 has regressed.
 *
 *  `runtime_binary_missing` is intentionally excluded: the `claude-code-cli`
 *  path raises it for the `claude` binary itself, so it is ambiguous and not a
 *  reliable cross-provider-leak signal. The provider-specific auth codes are. */
export const NON_CLAUDE_PROVIDER_ISSUE_CODES = [
  'cursor_auth_missing',
  'codex_auth_missing',
  'openrouter_api_key_missing',
] as const;

export interface ClaudeOnlyGracefulResult {
  graceful: boolean;
  /** Issue codes the Claude runtime's preflight surfaced (should be Claude-only). */
  surfacedCodes: string[];
  /** Any non-Claude-provider issue codes that leaked into a Claude preflight. */
  offendingCodes: string[];
}

/**
 * Assess whether a Claude runtime's preflight stays graceful when Cursor/Codex
 * are absent. Pure over the real `validateRuntimePreflight`, so it exercises the
 * shipping per-runtime gating rather than a parallel re-implementation.
 *
 * Note: the `claude-code-cli` path probes the `claude` binary; on a host without
 * `claude` it may surface `runtime_binary_missing` for *claude itself*. That is a
 * legitimate Claude-runtime issue, not a Cursor/Codex leak, so we evaluate the
 * SDK runtime (`claude-agent-sdk`) — whose preflight touches no external binary —
 * to isolate the cross-provider-leak question this risk is actually about.
 */
export function assessClaudeOnlyGraceful(
  runtime: string = 'claude-agent-sdk',
  model?: string,
): ClaudeOnlyGracefulResult {
  const issues = validateRuntimePreflight(runtime, model);
  const surfacedCodes = issues.map((i) => i.code);
  const nonClaude = new Set<string>(NON_CLAUDE_PROVIDER_ISSUE_CODES);
  const offendingCodes = surfacedCodes.filter((c) => nonClaude.has(c));
  return {
    graceful: offendingCodes.length === 0,
    surfacedCodes,
    offendingCodes,
  };
}
