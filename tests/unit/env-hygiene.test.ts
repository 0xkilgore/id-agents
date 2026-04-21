// SPDX-License-Identifier: MIT
/**
 * Parent Claude-Code session env-var leak into child agents.
 *
 * The manager forwards CLAUDE_* vars to spawned child agents. If the manager
 * itself is running under a parent Claude Code session, those include
 * CLAUDE_CODE_OAUTH_TOKEN / _ENTRYPOINT / _PROVIDER_MANAGED_BY_HOST /
 * CLAUDE_AGENT_SDK_VERSION — the child `claude` CLI honors them ahead of its
 * own keychain login and returns 401. These tests pin the deny-list.
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_HANDOFF_VARS,
  detectSessionHandoffVars,
  filterClaudeEnvVars,
} from '../../src/lib/env-hygiene.js';

describe('SESSION_HANDOFF_VARS', () => {
  it('covers exactly the four known parent-session handoff vars', () => {
    expect(new Set(SESSION_HANDOFF_VARS)).toEqual(new Set([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_AGENT_SDK_VERSION',
    ]));
  });
});

describe('filterClaudeEnvVars', () => {
  it('strips session-handoff vars but keeps legitimate CLAUDE_* config vars', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: 'leaked-token',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_AGENT_SDK_VERSION: '0.42.0',
      CLAUDE_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_API_KEY: 'sk-user-key',
      PATH: '/usr/bin',
    };

    const filtered = filterClaudeEnvVars(env);

    // Handoff vars are gone
    for (const v of SESSION_HANDOFF_VARS) {
      expect(filtered).not.toHaveProperty(v);
    }
    // Legitimate CLAUDE_* config is preserved
    expect(filtered.CLAUDE_MODEL).toBe('claude-haiku-4-5-20251001');
    // Non-CLAUDE keys aren't in this filter's output
    expect(filtered).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(filtered).not.toHaveProperty('PATH');
  });

  it('returns empty when env has no CLAUDE_* vars', () => {
    expect(filterClaudeEnvVars({ PATH: '/usr/bin', HOME: '/root' })).toEqual({});
  });

  it('coerces undefined values to empty strings', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_MODEL: undefined as any };
    expect(filterClaudeEnvVars(env)).toEqual({ CLAUDE_MODEL: '' });
  });
});

describe('detectSessionHandoffVars', () => {
  it('returns all handoff vars present in env', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      CLAUDE_AGENT_SDK_VERSION: 'y',
      CLAUDE_MODEL: 'haiku',
    };
    expect(new Set(detectSessionHandoffVars(env))).toEqual(new Set([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_AGENT_SDK_VERSION',
    ]));
  });

  it('returns empty when no handoff vars are present', () => {
    expect(detectSessionHandoffVars({ CLAUDE_MODEL: 'sonnet' })).toEqual([]);
  });
});

describe('full child-spawn env scenario', () => {
  it('child env contains ANTHROPIC_API_KEY and CLAUDE_MODEL but no handoff vars', () => {
    const parentEnv: NodeJS.ProcessEnv = {
      // Handoff vars the parent Claude Code session injected
      CLAUDE_CODE_OAUTH_TOKEN: 'leaked-token',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_AGENT_SDK_VERSION: '0.42.0',
      // Legitimate config
      CLAUDE_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_API_KEY: 'sk-user-key',
      // Unrelated vars
      PATH: '/usr/bin',
    };

    // Mirror the localEnv shape spawnLocalAgentProcess builds.
    const childEnv: Record<string, string> = {
      PATH: parentEnv.PATH || '',
      ...filterClaudeEnvVars(parentEnv),
      ...(parentEnv.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: parentEnv.ANTHROPIC_API_KEY }),
    };

    expect(childEnv.ANTHROPIC_API_KEY).toBe('sk-user-key');
    expect(childEnv.CLAUDE_MODEL).toBe('claude-haiku-4-5-20251001');
    for (const v of SESSION_HANDOFF_VARS) {
      expect(childEnv).not.toHaveProperty(v);
    }
  });
});
