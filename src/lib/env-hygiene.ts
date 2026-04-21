// SPDX-License-Identifier: MIT
/**
 * Parent Claude-Code session env-var hygiene.
 *
 * When the manager is launched from a shell that is itself running inside a
 * Claude Code session (`!<cmd>` inside claude, IDE integrated terminal, a tmux
 * pane spawned from inside claude, etc.), the shell inherits env vars that
 * hand off the parent's auth/session to any child process. If we forward those
 * to a spawned child agent, the child `claude` CLI honors the parent's
 * host-managed OAuth token ahead of its own keychain login and returns 401 on
 * every dispatch.
 *
 * Keychain-login users are the ones affected; `ANTHROPIC_API_KEY` users are
 * immune because the CLI prefers the API key.
 */

/**
 * Vars the parent Claude Code session uses to hand off auth/session state.
 * These MUST be stripped before spawning child agents.
 */
export const SESSION_HANDOFF_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_AGENT_SDK_VERSION',
] as const;

export type SessionHandoffVar = typeof SESSION_HANDOFF_VARS[number];

const HANDOFF_SET: Set<string> = new Set(SESSION_HANDOFF_VARS);

/**
 * Return CLAUDE_* entries from `env`, minus the known session-handoff vars.
 * Legitimate config vars like CLAUDE_MODEL pass through.
 */
export function filterClaudeEnvVars(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('CLAUDE')) continue;
    if (HANDOFF_SET.has(k)) continue;
    out[k] = v || '';
  }
  return out;
}

/** Return the subset of `env` keys that are session-handoff vars. */
export function detectSessionHandoffVars(
  env: NodeJS.ProcessEnv,
): SessionHandoffVar[] {
  return SESSION_HANDOFF_VARS.filter((k) => env[k] !== undefined);
}
