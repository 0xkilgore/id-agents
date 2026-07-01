// SPDX-License-Identifier: MIT
//
// Clean-machine spike — R1 BYO-Claude credential-in-bundle probe. Runs entirely
// on fake env bags: no real secrets, no filesystem, no `claude` binary.

import { describe, it, expect } from 'vitest';
import {
  BYO_CLAUDE_REQUIRED_HANDOFF,
  probeByoClaudeCredential,
  isByoClaudeCredentialReady,
  resolveClaudeCredentialSources,
  resolveClaudeConfigDir,
} from '../../src/clean-machine-spike/byo-claude.js';

const HOME = '/Users/stranger';
const base = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME, ...over });

describe('resolveClaudeCredentialSources', () => {
  it('finds nothing in a bare env (no Claude handoff)', () => {
    expect(resolveClaudeCredentialSources(base())).toEqual([]);
  });

  it('detects the BYO-subscription token handoff', () => {
    const s = resolveClaudeCredentialSources(base({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xxxx' }));
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('subscription_cli');
    expect(s[0].seam).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(s[0].location).toBe('/Users/stranger/.claude');
  });

  it('detects the API-key handoff (pure env, no location)', () => {
    const s = resolveClaudeCredentialSources(base({ ANTHROPIC_API_KEY: 'sk-test' }));
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('api_key');
    expect(s[0].location).toBeNull();
  });

  it('lists the subscription path first when both are present', () => {
    const s = resolveClaudeCredentialSources(
      base({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'sk' }),
    );
    expect(s.map((x) => x.kind)).toEqual(['subscription_cli', 'api_key']);
  });

  it('ignores empty/whitespace-only seam values', () => {
    expect(resolveClaudeCredentialSources(base({ ANTHROPIC_API_KEY: '   ' }))).toEqual([]);
  });

  it('does NOT count non-Claude providers as a Claude credential', () => {
    const s = resolveClaudeCredentialSources(
      base({ OPENROUTER_API_KEY: 'or-x', CURSOR_API_KEY: 'c', CODEX_AUTH: 'z' }),
    );
    expect(s).toEqual([]);
  });
});

describe('resolveClaudeConfigDir', () => {
  it('defaults to <HOME>/.claude', () => {
    expect(resolveClaudeConfigDir(base())).toBe('/Users/stranger/.claude');
  });
  it('honors the CLAUDE_CONFIG_DIR override seam', () => {
    expect(resolveClaudeConfigDir(base({ CLAUDE_CONFIG_DIR: '/tmp/app/.claude' }))).toBe(
      '/tmp/app/.claude',
    );
  });
});

describe('probeByoClaudeCredential', () => {
  it('FAILS clearly on a clean-machine bare env, documenting the required handoff', () => {
    const r = probeByoClaudeCredential(base());
    expect(r.ok).toBe(false);
    expect(r.sources).toEqual([]);
    expect(r.reason).toBe(BYO_CLAUDE_REQUIRED_HANDOFF);
    expect(r.reason).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('PASSES with a stranger BYO subscription token under their own home', () => {
    const r = probeByoClaudeCredential(base({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xxxx' }));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.chrisPathFindings).toEqual([]);
  });

  it('PASSES with an app-local API key', () => {
    expect(isByoClaudeCredentialReady(base({ ANTHROPIC_API_KEY: 'sk-test' }))).toBe(true);
  });

  it('FAILS when the subscription login store leaks a Chris path (Dropbox)', () => {
    const r = probeByoClaudeCredential(
      base({ CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/Users/stranger/Dropbox/.claude' }),
    );
    expect(r.ok).toBe(false);
    expect(r.chrisPathFindings.map((f) => f.marker)).toContain('Dropbox');
    expect(r.reason).toMatch(/leaks a Chris-machine path/);
  });

  it('FAILS when the login store is a hardcoded foreign home', () => {
    const r = probeByoClaudeCredential(
      base({ CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/Users/kilgore/.claude' }),
    );
    expect(r.ok).toBe(false);
    expect(r.chrisPathFindings.map((f) => f.marker)).toContain('/Users/kilgore');
  });

  it('a foreign key does not rescue an otherwise-clean stranger env (Claude-only)', () => {
    const r = probeByoClaudeCredential(base({ OPENROUTER_API_KEY: 'or-only' }));
    expect(r.ok).toBe(false);
  });
});
