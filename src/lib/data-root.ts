// SPDX-License-Identifier: MIT
import os from 'node:os';
import path from 'node:path';

/**
 * Per-user data root for zero-config local boots.
 *
 * Precedence:
 *   1. ID_AGENTS_HOME for explicit operator control.
 *   2. XDG_DATA_HOME/id-agents on XDG hosts.
 *   3. ~/.id-agents for backwards-compatible local installs.
 */
export function resolveIdAgentsHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ID_AGENTS_HOME?.trim();
  if (explicit) return path.resolve(expandHome(explicit));

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return path.resolve(expandHome(xdgDataHome), 'id-agents');

  return path.join(os.homedir(), '.id-agents');
}

export function resolveDefaultWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveIdAgentsHome(env), 'workspace');
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}
